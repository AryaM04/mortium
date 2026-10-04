// A fake payload codec for message store tests. It does not encrypt: the
// bytes are plain JSON. Tests only. The app uses the Megolm codec.
import { decodeBase64Url, decodePlainPayload, encodePlainPayload } from "@mortium/shared";
import type { DecodeResult, PayloadCodec } from "../codec.js";

export interface FakeCodec extends PayloadCodec {
  /** Session ids whose key is "not here yet". Their events decode as waiting. */
  missing: Set<string>;
  /** Tell the listeners that the key of a session arrived. */
  deliverKey(channelId: string, sessionId: string): void;
}

export function createFakeCodec(sessionId = "fake-session"): FakeCodec {
  const listeners = new Set<(channelId: string, sessionId: string) => void>();
  const missing = new Set<string>();
  return {
    missing,
    async encode(_channelId, payload) {
      return { codec: "megolm-v1", ciphertext: encodePlainPayload(payload), megolmSessionId: sessionId };
    },
    async decode(event): Promise<DecodeResult> {
      if (event.redactedAt) {
        return { ok: false, reason: "This message was deleted." };
      }
      if (event.megolmSessionId && missing.has(event.megolmSessionId)) {
        return { ok: false, reason: "This message cannot be read yet. The app asks for the key.", waiting: true };
      }
      try {
        return { ok: true, payload: decodePlainPayload(decodeBase64Url(event.ciphertext)) };
      } catch {
        return { ok: false, reason: "This message cannot be read." };
      }
    },
    onKeys(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    deliverKey(channelId, keySessionId) {
      missing.delete(keySessionId);
      for (const listener of listeners) {
        listener(channelId, keySessionId);
      }
    },
  };
}
