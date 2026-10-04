// The one message store for this tab: channel windows, decoded payloads,
// pending sends, typing and read state. Every new event is encrypted with
// Megolm. The crypto layer loads lazily (see crypto.ts), so the codec here
// waits for it. It can still read old plaintext events without it.
import { createStore } from "zustand/vanilla";
import { createMessagesStore, decodePlainEvent, type PayloadCodec } from "@mortium/client-core";
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
  } else {
    pending.forEach((waiter) => waiter.reject(new Error("The session ended.")));
  }
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
      return { ok: false, reason: "This message cannot be read." };
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
