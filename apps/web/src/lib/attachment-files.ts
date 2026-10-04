// Encrypt, upload, download and decrypt attachments. The composer and the
// message list load this module with a dynamic import when they first need
// it, so it is not in the main bundle. See docs/concepts/attachments.md.
import {
  SizedLruCache,
  decryptFile,
  encryptFile,
  isInlineImage,
  thumbnailSize,
  type FileSecrets,
} from "@mortium/client-core";
import type { Attachment, AttachmentThumbnail } from "@mortium/shared";
import { session } from "./session.js";
import { apiBaseUrl } from "./server-url.js";

/** Decrypted files stay in memory up to this total size. */
const CACHE_BYTES = 50 * 1024 * 1024;

/** Upload one ciphertext. `onProgress` gets the fraction sent, from 0 to 1. */
async function upload(
  channelId: string,
  ciphertext: Uint8Array,
  signal: AbortSignal,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  const token = await session.apiClient.getAccessToken();
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `${apiBaseUrl()}/channels/${channelId}/attachments`);
    request.setRequestHeader("Authorization", `Bearer ${token}`);
    request.setRequestHeader("Content-Type", "application/octet-stream");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress?.(event.loaded / event.total);
      }
    };
    request.onload = () => {
      let body: { id?: string; error?: { message?: string } } = {};
      try {
        body = JSON.parse(request.responseText) as typeof body;
      } catch {
        // The error below has a general text.
      }
      if (request.status === 201 && body.id) {
        resolve(body.id);
      } else {
        reject(new Error(body.error?.message ?? "The file could not be uploaded."));
      }
    };
    request.onerror = () => reject(new Error("The server could not be reached. Check your connection."));
    request.onabort = () => reject(new DOMException("The upload was cancelled.", "AbortError"));
    signal.addEventListener("abort", () => request.abort(), { once: true });
    request.send(new Blob([ciphertext as Uint8Array<ArrayBuffer>]));
  });
}

/** Make a thumbnail of at most 320 px as WebP (or JPEG when the browser cannot make WebP). */
async function makeThumbnail(image: ImageBitmap): Promise<{ bytes: Uint8Array; width: number; height: number } | null> {
  const size = thumbnailSize(image.width, image.height);
  let blob: Blob | null = null;
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(size.width, size.height);
    canvas.getContext("2d")?.drawImage(image, 0, 0, size.width, size.height);
    blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.8 });
  } else {
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    canvas.getContext("2d")?.drawImage(image, 0, 0, size.width, size.height);
    blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.8));
  }
  if (!blob) {
    return null;
  }
  return { bytes: new Uint8Array(await blob.arrayBuffer()), ...size };
}

/**
 * Encrypt one file and upload it. An image also gets an encrypted
 * thumbnail and its size. The result goes in the Megolm payload.
 */
export async function prepareAttachment(
  channelId: string,
  file: File,
  signal: AbortSignal,
  onProgress: (fraction: number) => void,
): Promise<Attachment> {
  const plaintext = new Uint8Array(await file.arrayBuffer());
  const mime = file.type || "application/octet-stream";
  let dimensions: { width: number; height: number } | undefined;
  let thumbnail: AttachmentThumbnail | undefined;
  if (isInlineImage(mime)) {
    try {
      const image = await createImageBitmap(file);
      dimensions = { width: image.width, height: image.height };
      const small = await makeThumbnail(image);
      image.close();
      if (small) {
        const encrypted = await encryptFile(small.bytes);
        const id = await upload(channelId, encrypted.ciphertext, signal);
        thumbnail = { id, ...encrypted.secrets, width: small.width, height: small.height };
      }
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      // The browser cannot read this image. It goes as a plain file.
    }
  }
  const encrypted = await encryptFile(plaintext);
  const id = await upload(channelId, encrypted.ciphertext, signal, onProgress);
  return { id, name: file.name.slice(0, 255) || "file", mime, size: file.size, ...encrypted.secrets, ...dimensions, thumbnail };
}

const cache = new SizedLruCache<string>(CACHE_BYTES, (url) => URL.revokeObjectURL(url));
const loading = new Map<string, Promise<string>>();

/**
 * Download one file, check its SHA-256, decrypt it and return an object
 * URL. Only a safe image type keeps its type. Every other file (SVG too)
 * is `application/octet-stream`, so the browser never runs it.
 */
export function loadDecrypted(id: string, secrets: FileSecrets, mime: string): Promise<string> {
  const cached = cache.get(id);
  if (cached) {
    return Promise.resolve(cached);
  }
  let pending = loading.get(id);
  if (!pending) {
    pending = (async () => {
      const token = await session.apiClient.getAccessToken();
      const response = await fetch(`${apiBaseUrl()}/attachments/${id}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) {
        throw new Error("The file could not be downloaded.");
      }
      const plaintext = await decryptFile(new Uint8Array(await response.arrayBuffer()), secrets);
      const type = isInlineImage(mime) ? mime : "application/octet-stream";
      const url = URL.createObjectURL(new Blob([plaintext as Uint8Array<ArrayBuffer>], { type }));
      cache.set(id, url, plaintext.length);
      return url;
    })().finally(() => loading.delete(id));
    loading.set(id, pending);
  }
  return pending;
}

/** Save a decrypted file with its name. The link has the `download` attribute, so the browser never opens it. */
export async function saveAttachment(attachment: Attachment): Promise<void> {
  const url = await loadDecrypted(attachment.id, attachment, attachment.mime);
  const link = document.createElement("a");
  link.href = url;
  link.download = attachment.name;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

/** Forget every decrypted file, for example after sign-out. */
export function clearAttachmentCache(): void {
  cache.clear();
}

session.store.subscribe((state) => {
  if (state.status === "signedOut") {
    clearAttachmentCache();
  }
});
