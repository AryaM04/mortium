// Starts the crypto layer in the background once the session signs in,
// and stops it on sign-out. The crypto layer runs in one SharedWorker for
// each device, so every tab of the device can encrypt and decrypt. This
// tab loads only the small RPC client, with a dynamic import. A browser
// without SharedWorker, and the desktop apps, run the crypto layer in the
// page: then only one tab holds the Web Lock, and a different tab shows a
// banner and waits for the lock. See docs/concepts/olm-megolm.md section 13.
import type { BackupStatus, CryptoHandle, VerificationView } from "@mortium/client-core/crypto";
import type { CryptoClient, CryptoWorkerClient } from "@mortium/client-core/crypto-client";
import { ApiError, postEvent } from "@mortium/client-core";
import { currentPlatform } from "./platform.js";
import { encodeBase64Url } from "@mortium/shared";
import { createStore } from "zustand/vanilla";
import { failCryptoWaiters, messageCodec, setCryptoHandle } from "./messages.js";
import { gatewaySend, realtimeStore, subscribeDispatch } from "./realtime.js";
import { session } from "./session.js";

/** The debug hook for development and the end-to-end tests. Never in a production build. */
export interface CryptoDebug {
  ready(): boolean;
  identityKeys(): { curve25519: string; ed25519: string } | null;
  sessionCount(): Promise<number>;
  /** Send a `debug.ping` envelope to every device of a user. Returns the number of devices it reached. */
  sendPing(userId: string, text: string): Promise<number>;
  /** The `debug.ping` envelopes this device received. */
  received(): Array<{ fromUserId: string; fromDeviceId: string; text: string }>;
  /** True when this device has the inbound key of a Megolm session. */
  hasMegolmSession(sessionId: string): Promise<boolean>;
  /** Encrypt and post many messages fast, with the real codec. It waits and tries again after a 429. */
  seedMessages(channelId: string, bodies: string[]): Promise<void>;
  /** The security state that the UI shows. */
  security(): SecuritySnapshot;
}

/** The trust state of this device for the UI: verification, key backup and identity changes. */
export interface SecuritySnapshot {
  /** True after the crypto layer started. */
  ready: boolean;
  deviceVerified: boolean;
  holdsMasterKey: boolean;
  backup: BackupStatus | null;
  /** Users whose identity (master key) changed. The UI warns about each one. */
  changedUsers: string[];
  verifications: VerificationView[];
}

const EMPTY_SECURITY: SecuritySnapshot = {
  ready: false,
  deviceVerified: true,
  holdsMasterKey: false,
  backup: null,
  changedUsers: [],
  verifications: [],
};

export const securityStore = createStore<SecuritySnapshot>(() => EMPTY_SECURITY);

/** The crypto layer of this tab, or null before it starts. The security UI uses it. */
export function currentCrypto(): CryptoClient | null {
  return handle;
}

/** Read the security state again. Several changes in a short time give one read. */
function watchSecurity(started: CryptoClient): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const read = async () => {
    timer = null;
    const [state, changedUsers] = await Promise.all([started.security.state(), started.changedMasterKeys()]);
    if (handle === started) {
      securityStore.setState({ ready: true, ...state, changedUsers, verifications: started.verification.list() });
    }
  };
  const schedule = () => {
    timer ??= setTimeout(() => void read().catch(() => undefined), 50);
  };
  const stopSecurity = started.security.onChange(schedule);
  const stopVerification = started.verification.onChange(() => {
    securityStore.setState({ verifications: started.verification.list() });
  });
  schedule();
  return () => {
    stopSecurity();
    stopVerification();
    if (timer) {
      clearTimeout(timer);
    }
  };
}

/** Tell the worker which users are offline. Only online devices send history to a new member. */
function watchPresence(client: CryptoWorkerClient): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const send = () => {
    timer = null;
    const { presences } = realtimeStore.getState();
    client.setOfflineUsers(Object.keys(presences).filter((userId) => presences[userId] === "offline"));
  };
  send();
  const unsubscribe = realtimeStore.subscribe((state, previous) => {
    if (state.presences !== previous.presences) {
      timer ??= setTimeout(send, 1000);
    }
  });
  return () => {
    unsubscribe();
    if (timer) {
      clearTimeout(timer);
    }
  };
}

const MAX_RECEIVED = 100;
/** The page keeps at most this many dispatches while the crypto layer starts, as the worker does. */
const MAX_BUFFERED_DISPATCHES = 1000;
/** The wait before the first new start after a failed start. It doubles up to the maximum. */
const START_RETRY_FIRST_MS = 2000;
const START_RETRY_MAX_MS = 60_000;

/** True while a different context of this device runs the crypto layer, and this tab waits for it. */
export const cryptoTabStore = createStore<{ otherTab: boolean }>(() => ({ otherTab: false }));

let handle: CryptoClient | null = null;
let run = 0;
/** Stops the crypto layer of this tab, or the connection to the worker. */
let teardown: (() => void) | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let startFailures = 0;
const received: Array<{ fromUserId: string; fromDeviceId: string; text: string }> = [];

/** Give the started crypto layer to the rest of the app. Returns a function that takes it back. */
function attach(started: CryptoClient): () => void {
  handle = started;
  setCryptoHandle(started);
  const stopSecurity = watchSecurity(started);
  const stopPing = started.onToDevice((event) => {
    if (event.type === "debug.ping" && typeof event.content.text === "string") {
      received.push({ fromUserId: event.sender.userId, fromDeviceId: event.sender.deviceId, text: event.content.text });
      received.splice(0, received.length - MAX_RECEIVED);
    }
  });
  return () => {
    stopSecurity();
    stopPing();
  };
}

/**
 * The desktop apps keep the secure store behind their bridge, and only the
 * page can reach the bridge. They also open only one window. So they keep
 * the crypto layer in the page.
 */
function canUseWorker(): boolean {
  return typeof SharedWorker !== "undefined" && !("__TAURI_INTERNALS__" in window) && !("desktopBridge" in window);
}

async function startInWorker(current: number, userId: string, deviceId: string): Promise<void> {
  const { connectCryptoWorker, createHttpCryptoTransport } = await import("@mortium/client-core/crypto-client");
  if (current !== run) {
    return;
  }
  let detach: (() => void) | null = null;
  const client = connectCryptoWorker({
    userId,
    deviceId,
    connect: () =>
      new SharedWorker(new URL("./crypto-worker.ts", import.meta.url), {
        type: "module",
        name: `crypto:${userId}:${deviceId}`,
      }).port,
    transport: createHttpCryptoTransport(session.apiClient, gatewaySend),
    locks: navigator.locks,
    onState: (state) => {
      if (current !== run) {
        return;
      }
      // "waiting": an old build of this app, or a tab without the worker, holds the device lock.
      cryptoTabStore.setState({ otherTab: state === "waiting" });
      if (state === "ready") {
        startFailures = 0;
        if (detach) {
          // A new worker after a lost one: the events that waited for it decode now.
          setCryptoHandle(client);
        } else {
          detach = attach(client);
        }
      } else if (state === "failed") {
        startFailed(current, userId, deviceId, new Error("The crypto layer could not start."));
      }
    },
  });
  // The worker keeps the dispatches that arrive while the crypto layer starts.
  const unsubscribe = subscribeDispatch((event) => client.handleDispatch(event));
  const stopPresence = watchPresence(client);
  teardown = () => {
    unsubscribe();
    stopPresence();
    detach?.();
    client.stop();
  };
}

function startInPage(current: number, userId: string, deviceId: string): void {
  const lockName = `crypto:${userId}:${deviceId}`;
  // Keep the dispatches that arrive while the crypto layer starts, as the
  // worker does. Without them, TO_DEVICE, DEVICE_LIST_UPDATE and READY are lost.
  let started: CryptoHandle | null = null;
  const buffered: Array<{ t: string; d: unknown }> = [];
  const unsubscribe = subscribeDispatch((event) => {
    if (started) {
      started.handleDispatch(event);
    } else if (buffered.length < MAX_BUFFERED_DISPATCHES) {
      buffered.push(event);
    }
  });
  teardown = unsubscribe;
  const body = async () => {
    if (current !== run) {
      return;
    }
    const crypto = await import("@mortium/client-core/crypto");
    const layer = await crypto.startCrypto({
      userId,
      deviceId,
      secureStore: currentPlatform().secureStore,
      transport: crypto.createHttpCryptoTransport(session.apiClient, gatewaySend),
      log: (message) => console.warn(`[crypto] ${message}`),
      isOnline: (userId) => realtimeStore.getState().presences[userId] !== "offline",
    });
    if (current !== run) {
      layer.stop();
      return;
    }
    startFailures = 0;
    started = layer;
    for (const event of buffered.splice(0)) {
      layer.handleDispatch(event);
    }
    const detach = attach(layer);
    // Hold the lock until sign-out.
    await new Promise<void>((resolve) => {
      teardown = resolve;
    });
    unsubscribe();
    detach();
    layer.stop();
  };
  // Only one context of a device can run the crypto layer (it owns the Olm
  // and Megolm state). When another tab holds the lock, show a banner and
  // wait: this tab takes over when that tab closes.
  void navigator.locks
    .request(lockName, { ifAvailable: true }, async (lock) => {
      if (lock) {
        return body();
      }
      if (current === run) {
        cryptoTabStore.setState({ otherTab: true });
      }
      return navigator.locks.request(lockName, async () => {
        if (current === run) {
          cryptoTabStore.setState({ otherTab: false });
        }
        return body();
      });
    })
    .catch((error: unknown) => {
      startFailed(current, userId, deviceId, error instanceof Error ? error : new Error(String(error)));
    });
}

/** The start failed: fail the calls that wait, and start again later. Each failure doubles the wait. */
function startFailed(current: number, userId: string, deviceId: string, error: Error): void {
  if (current !== run || retryTimer) {
    return;
  }
  const delay = Math.min(START_RETRY_FIRST_MS * 2 ** startFailures, START_RETRY_MAX_MS);
  startFailures += 1;
  console.warn(`[crypto] The crypto layer could not start. The app tries again in ${delay} ms.`, error);
  failCryptoWaiters(error);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (current !== run) {
      return;
    }
    teardown?.();
    teardown = null;
    launch(current, userId, deviceId);
  }, delay);
}

function launch(current: number, userId: string, deviceId: string): void {
  if (canUseWorker()) {
    startInWorker(current, userId, deviceId).catch((error: unknown) => {
      startFailed(current, userId, deviceId, error instanceof Error ? error : new Error(String(error)));
    });
  } else {
    startInPage(current, userId, deviceId);
  }
}

function start(userId: string, deviceId: string): void {
  const current = ++run;
  if (typeof navigator === "undefined" || !navigator.locks) {
    return;
  }
  launch(current, userId, deviceId);
}

function stop(): void {
  run += 1;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  startFailures = 0;
  cryptoTabStore.setState({ otherTab: false });
  handle = null;
  setCryptoHandle(null);
  securityStore.setState(EMPTY_SECURITY);
  received.length = 0;
  teardown?.();
  teardown = null;
}

let previousStatus = session.store.getState().status;
session.store.subscribe((state) => {
  if (state.status === "signedIn" && state.user && state.deviceId && previousStatus !== "signedIn") {
    start(state.user.id, state.deviceId);
  } else if (state.status === "signedOut" && previousStatus !== "signedOut") {
    stop();
  }
  previousStatus = state.status;
});

const initial = session.store.getState();
if (initial.status === "signedIn" && initial.user && initial.deviceId) {
  start(initial.user.id, initial.deviceId);
}

export const cryptoDebug: CryptoDebug = {
  ready: () => handle !== null,
  identityKeys: () => handle?.identityKeys ?? null,
  sessionCount: () => handle?.sessionCount() ?? Promise.resolve(0),
  async sendPing(userId, text) {
    if (!handle) {
      throw new Error("The crypto layer is not ready.");
    }
    const result = await handle.encryptToUsers([userId], "debug.ping", { text });
    return result.sent.length;
  },
  received: () => [...received],
  security: () => securityStore.getState(),
  hasMegolmSession: (sessionId) => handle?.hasMegolmSession(sessionId) ?? Promise.resolve(false),
  async seedMessages(channelId, bodies) {
    for (const [index, body] of bodies.entries()) {
      const encoded = await messageCodec.encode(channelId, { type: "message", body, mentions: [], attachments: [], embeds: [] });
      for (;;) {
        try {
          await postEvent(session.apiClient, channelId, {
            codec: encoded.codec,
            megolmSessionId: encoded.megolmSessionId ?? undefined,
            ciphertext: encodeBase64Url(encoded.ciphertext),
            nonce: `seed-${Date.now()}-${index}`,
          });
          break;
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 429) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    }
  },
};
