// The one message store for this tab: channel windows, decoded payloads,
// pending sends, typing and read state. Every new event is encrypted with
// Megolm. The crypto layer loads lazily (see crypto.ts), so the codec here
// waits for it. It can still read old plaintext events without it.
import { createStore } from "zustand/vanilla";
import { WAITING_FOR_KEY_TEXT, createMessagesStore, decodePlainEvent, type PayloadCodec } from "@mortium/client-core";
import type { CryptoClient } from "@mortium/client-core/crypto-client";
import { session } from "./session.js";
import { gatewaySend } from "./realtime.js";
import { queueDecoded, queueRedacted } from "./search-queue.js";

/** Show the encryption setup notice when an encryption takes longer than this. */
const SETUP_NOTICE_MS = 500;

/** True while an encryption waits for the crypto layer or a first key share for more than 500 ms. */
export const encryptionSetupStore = createStore<{ settingUp: boolean }>(() => ({ settingUp: false }));

let handle: CryptoClient | null = null;
let waiters: Array<{ resolve: (handle: CryptoClient) => void; reject: (error: Error) => void }> = [];
let stopKeyWatch: (() => void) | null = null;
let slowEncryptions = 0;
const keyListeners = new Set<(channelId: string, sessionId: string) => void>();
/** The Megolm sessions of the events that could not decode because the crypto layer was missing. */
const missedSessions = new Map<string, [channelId: string, sessionId: string]>();

/** The crypto layer calls this when it starts (with its handle) and when it stops (with null). */
export function setCryptoHandle(next: CryptoClient | null): void {
  stopKeyWatch?.();
  stopKeyWatch = null;
  handle = next;
  const pending = waiters;
  waiters = [];
  if (next) {
    stopKeyWatch =
      next.codec.onKeys?.((channelId, sessionId) => {
        for (const listener of keyListeners) {
          listener(channelId, sessionId);
        }
      }) ?? null;
    pending.forEach((waiter) => waiter.resolve(next));
    // The events that waited for the crypto layer can decode now.
    const missed = [...missedSessions.values()];
    missedSessions.clear();
    for (const [channelId, sessionId] of missed) {
      keyListeners.forEach((listener) => listener(channelId, sessionId));
    }
  } else {
    missedSessions.clear();
    pending.forEach((waiter) => waiter.reject(new Error("The session ended.")));
  }
}

/** The crypto layer could not start. The calls that wait for it fail, so the UI does not wait for all time. */
export function failCryptoWaiters(error: Error): void {
  const pending = waiters;
  waiters = [];
  pending.forEach((waiter) => waiter.reject(error));
}

/** Wait for the crypto layer of this tab. */
export function cryptoReady(): Promise<CryptoClient> {
  return handle ? Promise.resolve(handle) : new Promise((resolve, reject) => waiters.push({ resolve, reject }));
}

/** The codec of this tab. Notifications use it too, to read the text of a new message. */
export const messageCodec: PayloadCodec = {
  async encode(channelId, payload) {
    let slow = false;
    const timer = setTimeout(() => {
      slow = true;
      slowEncryptions += 1;
      encryptionSetupStore.setState({ settingUp: true });
    }, SETUP_NOTICE_MS);
    try {
      return await (await cryptoReady()).codec.encode(channelId, payload);
    } finally {
      clearTimeout(timer);
      if (slow) {
        slowEncryptions -= 1;
        encryptionSetupStore.setState({ settingUp: slowEncryptions > 0 });
      }
    }
  },

  async decode(event) {
    if (event.codec === "plain-v1") {
      return decodePlainEvent(event);
    }
    try {
      return await (await cryptoReady()).codec.decode(event);
    } catch {
      // The crypto layer is missing. The event decodes again when the layer is ready.
      if (event.megolmSessionId) {
        missedSessions.set(`${event.channelId}:${event.megolmSessionId}`, [event.channelId, event.megolmSessionId]);
      }
      return { ok: false, reason: WAITING_FOR_KEY_TEXT, waiting: true };
    }
  },

  onKeys(listener) {
    keyListeners.add(listener);
    return () => {
      keyListeners.delete(listener);
    };
  },
};

export const messagesStore = createMessagesStore({
  api: session.apiClient,
  codec: messageCodec,
  send: gatewaySend,
  onDecoded: queueDecoded,
  onRedacted: queueRedacted,
});
