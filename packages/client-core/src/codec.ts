// The payload codec: turns a decrypted payload into wire bytes, and back.
// The client sends only the encrypted codec `megolm-v1` (see
// crypto/megolm.ts). The message store is given a codec, and it does not
// know or care which one. Old development data can have events with the
// plaintext codec `plain-v1`. The client can still read them, but it never
// makes one.
import { decodeBase64Url, decodePlainPayload, type DecryptedPayload, type EventJson } from "@mortium/shared";

/**
 * The result of decoding one event's ciphertext back to a payload. When
 * `waiting` is true, the key is not here yet: the codec asks for it, and
 * calls the `onKeys` listeners when it arrives.
 */
export type DecodeResult = { ok: true; payload: DecryptedPayload } | { ok: false; reason: string; waiting?: boolean };

/**
 * Turns a decrypted payload into wire bytes for one channel, and turns an
 * event's wire bytes back into a decrypted payload. A payload that fails
 * to decode must return `{ ok: false }`, never throw: the store shows
 * "This message cannot be read." instead of crashing.
 */
export interface PayloadCodec {
  encode(
    channelId: string,
    payload: DecryptedPayload,
  ): Promise<{ codec: "plain-v1" | "megolm-v1"; ciphertext: Uint8Array; megolmSessionId: string | null }>;
  decode(event: EventJson): Promise<DecodeResult>;
  /** Watch the arrival of keys, so that waiting events can decode again. Returns a function that stops the watch. */
  onKeys?(listener: (channelId: string, sessionId: string) => void): () => void;
}

/** Read an old event with the plaintext codec (`plain-v1`). It never throws. */
export function decodePlainEvent(event: EventJson): DecodeResult {
  if (event.redactedAt) {
    return { ok: false, reason: "This message was deleted." };
  }
  if (event.codec !== "plain-v1") {
    return { ok: false, reason: "This message cannot be read." };
  }
  try {
    return { ok: true, payload: decodePlainPayload(decodeBase64Url(event.ciphertext)) };
  } catch {
    return { ok: false, reason: "This message cannot be read." };
  }
}
