// Encrypted attachments: the file crypto (AES-256-GCM with WebCrypto), the
// integrity check, a small LRU cache of decrypted files, and the pure rules
// for thumbnails and inline images. See docs/concepts/attachments.md.
import { decodeBase64Url, encodeBase64Url, MAX_THUMBNAIL_SIZE } from "@mortium/shared";
import type { ApiClient } from "./api.js";

/** The secrets of one encrypted file, as they go in the message payload. */
export interface FileSecrets {
  key: string;
  iv: string;
  sha256: string;
}

/** The ciphertext does not match the SHA-256 in the message. The file is not decrypted. */
export class AttachmentIntegrityError extends Error {
  constructor() {
    super("The file was changed. It does not match the hash in the message.");
    this.name = "AttachmentIntegrityError";
  }
}

/** WebCrypto takes only bytes on an `ArrayBuffer`. The base64 decoder and the callers give that. */
function view(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes as Uint8Array<ArrayBuffer>;
}

async function sha256(bytes: BufferSource): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

/** Encrypt one file with a new random key and IV. */
export async function encryptFile(plaintext: Uint8Array): Promise<{ ciphertext: Uint8Array; secrets: FileSecrets }> {
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, view(plaintext)));
  return {
    ciphertext,
    secrets: { key: encodeBase64Url(rawKey), iv: encodeBase64Url(iv), sha256: encodeBase64Url(await sha256(ciphertext)) },
  };
}

/** Check the SHA-256 of the ciphertext first, then decrypt. Throws `AttachmentIntegrityError` on a hash mismatch. */
export async function decryptFile(ciphertext: Uint8Array, secrets: FileSecrets): Promise<Uint8Array> {
  const expected = decodeBase64Url(secrets.sha256);
  const actual = await sha256(view(ciphertext));
  if (expected.length !== actual.length || !expected.every((byte, index) => byte === actual[index])) {
    throw new AttachmentIntegrityError();
  }
  const key = await crypto.subtle.importKey("raw", view(decodeBase64Url(secrets.key)), "AES-GCM", false, ["decrypt"]);
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: view(decodeBase64Url(secrets.iv)) }, key, view(ciphertext)),
  );
}

/** The image types that the app shows in the page. Every other type (SVG too) is a plain file. */
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function isInlineImage(mime: string): boolean {
  return INLINE_IMAGE_TYPES.has(mime);
}

/** The size of a thumbnail for an image of this size: at most 320 px on each side, and never larger than the image. */
export function thumbnailSize(width: number, height: number, max = MAX_THUMBNAIL_SIZE): { width: number; height: number } {
  const scale = Math.min(1, max / width, max / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Show a byte count in words for people, for example "1.5 MB". */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * A least recently used cache with a limit on the total size. It keeps
 * decrypted files, so a second view does not download and decrypt again.
 * `onEvict` releases a value (for example, it revokes an object URL).
 */
export class SizedLruCache<V> {
  private readonly entries = new Map<string, { value: V; size: number }>();
  private total = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly onEvict: (value: V) => void = () => {},
  ) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, size: number): void {
    this.delete(key);
    if (size > this.maxBytes) {
      this.onEvict(value);
      return;
    }
    this.entries.set(key, { value, size });
    this.total += size;
    for (const [oldKey, entry] of this.entries) {
      if (this.total <= this.maxBytes) {
        break;
      }
      this.entries.delete(oldKey);
      this.total -= entry.size;
      this.onEvict(entry.value);
    }
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.total -= entry.size;
      this.onEvict(entry.value);
    }
  }

  clear(): void {
    for (const entry of this.entries.values()) {
      this.onEvict(entry.value);
    }
    this.entries.clear();
    this.total = 0;
  }

  get size(): number {
    return this.total;
  }
}

/** Tell the server that a sent message holds this file, so the cleanup keeps it. A second claim does nothing. */
export function claimAttachment(api: ApiClient, id: string): Promise<void> {
  return api.request("POST", `/attachments/${id}/claim`);
}

/** Delete a file that this user uploaded, so that it does not count toward the quota. */
export function deleteAttachment(api: ApiClient, id: string): Promise<void> {
  return api.request("DELETE", `/attachments/${id}`);
}
