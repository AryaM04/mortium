// The keys that come from the account password. Argon2id makes the password
// key. HKDF makes two keys from it: the auth key, which the server checks
// in place of the password, and the wrap key, which encrypts the recovery
// key. The server never gets the password or the wrap key. This module
// needs the crypto WASM, so the app loads it only with a dynamic import.
// See docs/concepts/password-keys.md.
import { PASSWORD_KDF_V1, decodeBase64Url, encodeBase64Url } from "@mortium/shared";
import { decodeRecoveryKey, encodeRecoveryKey } from "./recovery-key.js";
import { loadWasm } from "./wasm.js";

const SALT_BYTES = 16;
const IV_BYTES = 12;
const AUTH_KEY_INFO = "mortium:auth-key:v1";
const WRAP_KEY_INFO = "mortium:password-wrap:v1";

export interface PasswordKeys {
  /** 32 bytes as base64url. The client sends it to the server in place of the password. */
  authKey: string;
  /** The AES-256-GCM key that encrypts the recovery key. Page code cannot export it. */
  wrapKey: CryptoKey;
  /** The salt (base64url) of these keys. */
  kdfSalt: string;
}

/** A new random salt for a new password, as base64url. */
export function newKdfSalt(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(SALT_BYTES)));
}

/** Derive the auth key and the wrap key from the password and the salt of the account. */
export async function derivePasswordKeys(password: string, kdfSalt: string): Promise<PasswordKeys> {
  const wasm = await loadWasm();
  const { memoryKib, iterations, parallelism } = PASSWORD_KDF_V1;
  const passwordKey = wasm.derive_recovery_key(password, decodeBase64Url(kdfSalt), memoryKib, iterations, parallelism);
  const base = await crypto.subtle.importKey("raw", passwordKey as Uint8Array<ArrayBuffer>, "HKDF", false, [
    "deriveBits",
    "deriveKey",
  ]);
  passwordKey.fill(0);
  const params = (info: string) => ({
    name: "HKDF",
    hash: "SHA-256",
    salt: new Uint8Array(32),
    info: new TextEncoder().encode(info),
  });
  const authKey = new Uint8Array(await crypto.subtle.deriveBits(params(AUTH_KEY_INFO), base, 256));
  const wrapKey = await crypto.subtle.deriveKey(params(WRAP_KEY_INFO), base, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  return { authKey: encodeBase64Url(authKey), wrapKey, kdfSalt };
}

/** The key wrap belongs to one user and one backup version. The server cannot move it to a different one. */
function wrapAad(userId: string, version: number): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`mortium:key-wrap:v1|${userId}|${version}`);
}

/** Encrypt the recovery key (text form) with the wrap key. Returns base64url of the IV and the ciphertext. */
export async function wrapRecoveryKey(wrapKey: CryptoKey, recoveryKey: string, userId: string, version: number): Promise<string> {
  const bytes = decodeRecoveryKey(recoveryKey);
  if (!bytes) {
    throw new Error("This is not a valid recovery key.");
  }
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: wrapAad(userId, version) },
    wrapKey,
    bytes as Uint8Array<ArrayBuffer>,
  );
  const data = new Uint8Array(IV_BYTES + sealed.byteLength);
  data.set(iv);
  data.set(new Uint8Array(sealed), IV_BYTES);
  return encodeBase64Url(data);
}

/** Decrypt a key wrap. Returns the recovery key text, or null when the wrap key or the data is wrong. */
export async function unwrapRecoveryKey(
  wrapKey: CryptoKey,
  data: string,
  userId: string,
  version: number,
): Promise<string | null> {
  try {
    const bytes = decodeBase64Url(data);
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, IV_BYTES), additionalData: wrapAad(userId, version) },
      wrapKey,
      bytes.slice(IV_BYTES),
    );
    return encodeRecoveryKey(new Uint8Array(opened));
  } catch {
    return null;
  }
}
