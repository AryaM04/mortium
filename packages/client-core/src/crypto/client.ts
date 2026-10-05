// The tab side of the crypto RPC: a `CryptoClient` that sends each call to
// the crypto SharedWorker, and makes the network calls that the worker asks
// for. This file is small and has no WASM, so a tab loads only this part.
// See docs/concepts/olm-megolm.md section 13.
import type { DecodeResult } from "../codec.js";
import type { ToDeviceHandler } from "./olm-machine.js";
import {
  fromRpcError,
  randomId,
  toRpcError,
  type CallMethod,
  type CallSignatures,
  type CryptoClient,
  type CryptoEvent,
  type LockManagerLike,
  type WorkerMessage,
  type WorkerState,
} from "./rpc.js";
import type { CryptoTransport } from "./transport.js";
import type { VerificationView } from "./verification.js";

export { createHttpCryptoTransport, type CryptoTransport } from "./transport.js";
export type { CryptoClient, LockManagerLike, WorkerState } from "./rpc.js";
export { deleteDeviceData } from "./store.js";

export interface CryptoWorkerOptions {
  userId: string;
  deviceId: string;
  /** Start or find the worker, and give a port to it. The client calls it again after the worker stops. */
  connect(): MessagePort;
  /** The network calls that the worker asks this tab to make. */
  transport: CryptoTransport;
  locks: LockManagerLike;
  /** The state of the crypto layer in the worker. `error` is set for the state "failed". */
  onState(state: WorkerState["state"], error?: Error): void;
}

export interface CryptoWorkerClient extends CryptoClient {
  /** Tell the worker which users the gateway of this tab shows as offline. */
  setOfflineUsers(userIds: string[]): void;
}

/** The error of a call that was in progress when the worker stopped. */
export class CryptoWorkerLostError extends Error {
  constructor() {
    super("The encryption worker stopped. Try again.");
    this.name = "CryptoWorkerLostError";
  }
}

type Result<M extends CallMethod> = Awaited<ReturnType<CallSignatures[M]>>;

export function connectCryptoWorker(options: CryptoWorkerOptions): CryptoWorkerClient {
  const { userId, deviceId, locks } = options;
  let port: MessagePort | null = null;
  let watch: AbortController | null = null;
  let stopped = false;
  let releaseTab: (() => void) | null = null;
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; onProgress?: (value: never) => void }
  >();
  let identityKeys = { curve25519: "", ed25519: "" };
  let verifications: VerificationView[] = [];
  let offline: string[] | null = null;

  const keyListeners = new Set<(channelId: string, sessionId: string) => void>();
  const toDeviceHandlers = new Set<ToDeviceHandler>();
  const settingsKeyListeners = new Set<(keyId: string) => void>();
  const securityListeners = new Set<() => void>();
  const verificationListeners = new Set<() => void>();

  function listen<T>(set: Set<T>, listener: T): () => void {
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  // The tab holds this lock while it lives. The worker waits for it to see that the tab closed.
  const tabLock = `crypto-tab:${randomId()}`;
  const tabHeld = new Promise<void>((resolve) => {
    void locks.request(tabLock, () => {
      resolve();
      if (stopped) {
        return undefined;
      }
      return new Promise<void>((release) => {
        releaseTab = release;
      });
    });
  });
  void tabHeld.then(open);

  function open(): void {
    if (stopped) {
      return;
    }
    const next = options.connect();
    port = next;
    next.onmessage = (event: MessageEvent<WorkerMessage>) => receive(next, event.data);
    next.postMessage({ kind: "hello", userId, deviceId, tabLock });
    if (offline) {
      next.postMessage({ kind: "presence", offline });
    }
  }

  /** The worker stopped. Fail the calls in progress, and start a new worker. */
  function lost(from: MessagePort): void {
    if (port !== from) {
      return;
    }
    port = null;
    from.close();
    const calls = [...pending.values()];
    pending.clear();
    calls.forEach((entry) => entry.reject(new CryptoWorkerLostError()));
    open();
  }

  function deliver(event: CryptoEvent): void {
    switch (event.type) {
      case "keys":
        keyListeners.forEach((listener) => listener(event.channelId, event.sessionId));
        break;
      case "toDevice":
        toDeviceHandlers.forEach((handler) => void (async () => handler(event.event))().catch(() => undefined));
        break;
      case "settingsKey":
        settingsKeyListeners.forEach((listener) => listener(event.keyId));
        break;
      case "security":
        securityListeners.forEach((listener) => listener());
        break;
      case "verification":
        verifications = event.verifications;
        verificationListeners.forEach((listener) => listener());
        break;
    }
  }

  async function serve(from: MessagePort, id: number, method: keyof CryptoTransport, args: unknown[]): Promise<void> {
    try {
      const value = await (options.transport[method] as (...values: unknown[]) => unknown)(...args);
      from.postMessage({ kind: "transportResult", id, value });
    } catch (error) {
      from.postMessage({ kind: "transportResult", id, error: toRpcError(error) });
    }
  }

  function receive(from: MessagePort, message: WorkerMessage): void {
    if (from !== port) {
      return;
    }
    switch (message.kind) {
      case "welcome":
        // The grant of the worker lock means that the worker stopped.
        watch?.abort();
        watch = new AbortController();
        void locks.request(message.workerLock, { signal: watch.signal }, () => lost(from)).catch(() => undefined);
        break;
      case "state":
        if (message.state === "ready") {
          identityKeys = message.identityKeys;
          verifications = message.verifications;
          // A new worker can have a different state. The UI reads it again.
          deliver({ type: "security" });
          deliver({ type: "verification", verifications });
        }
        options.onState(message.state, message.state === "failed" ? fromRpcError(message.error) : undefined);
        break;
      case "result": {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) {
          entry?.reject(fromRpcError(message.error));
        } else {
          entry?.resolve(message.value);
        }
        break;
      }
      case "progress":
        pending.get(message.id)?.onProgress?.(message.progress as never);
        break;
      case "event":
        deliver(message.event);
        break;
      case "transport":
        void serve(from, message.id, message.method, message.args);
        break;
    }
  }

  async function call<M extends CallMethod>(
    method: M,
    args: Parameters<CallSignatures[M]>,
    onProgress?: (value: never) => void,
  ): Promise<Result<M>> {
    await tabHeld;
    const target = port;
    if (stopped || !target) {
      throw new CryptoWorkerLostError();
    }
    const id = nextId++;
    return new Promise<Result<M>>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, onProgress });
      target.postMessage({ kind: "call", id, method, args });
    });
  }

  return {
    userId,
    deviceId,
    get identityKeys() {
      return identityKeys;
    },
    codec: {
      encode: (channelId, payload) => call("codec.encode", [channelId, payload]),
      decode: (event): Promise<DecodeResult> => call("codec.decode", [event]),
      onKeys: (listener) => listen(keyListeners, listener),
    },
    hasMegolmSession: (sessionId) => call("hasMegolmSession", [sessionId]),
    handleDispatch(dispatch) {
      port?.postMessage({ kind: "dispatch", dispatch });
    },
    encryptToDevices: (targets, type, content, extra) => call("encryptToDevices", [targets, type, content, extra]),
    encryptToUsers: (userIds, type, content) => call("encryptToUsers", [userIds, type, content]),
    onToDevice: (handler) => listen(toDeviceHandlers, handler),
    settings: {
      open: (blob) => call("settings.open", [blob]),
      seal: (plaintext, keyId) => call("settings.seal", [plaintext, keyId]),
      onKey: (listener) => listen(settingsKeyListeners, listener),
    },
    sessionCount: () => call("sessionCount", []),
    changedMasterKeys: () => call("changedMasterKeys", []),
    security: {
      state: () => call("security.state", []),
      onChange: (listener) => listen(securityListeners, listener),
      ownDevices: () => call("security.ownDevices", []),
      userTrust: (target) => call("security.userTrust", [target]),
      acceptIdentityChange: (target) => call("security.acceptIdentityChange", [target]),
      async setUpBackup(passphrase) {
        const { recoveryKey, token } = await call("security.setUpBackup", [passphrase]);
        return { recoveryKey, create: () => call("security.createBackup", [token]) };
      },
      restoreBackup: (input, onProgress) => call("security.restoreBackup", [input], onProgress),
      deleteBackup: () => call("security.deleteBackup", []),
      resetIdentity: (authKey) => call("security.resetIdentity", [authKey]),
    },
    verification: {
      list: () => verifications,
      onChange: (listener) => listen(verificationListeners, listener),
      requestOwnDevices: (target) => call("verification.requestOwnDevices", [target]),
      requestUser: (target) => call("verification.requestUser", [target]),
      accept: (txnId) => call("verification.accept", [txnId]),
      confirm: (txnId, match) => call("verification.confirm", [txnId, match]),
      cancel: (txnId) => call("verification.cancel", [txnId]),
      dismiss: (txnId) => void call("verification.dismiss", [txnId]).catch(() => undefined),
    },
    search: {
      apply: (changes) => call("search.apply", [changes]),
      query: (query) => call("search.query", [query]),
    },
    setOfflineUsers(userIds) {
      offline = userIds;
      port?.postMessage({ kind: "presence", offline });
    },
    stop() {
      stopped = true;
      watch?.abort();
      port?.close();
      port = null;
      releaseTab?.();
      const calls = [...pending.values()];
      pending.clear();
      calls.forEach((entry) => entry.reject(new CryptoWorkerLostError()));
    },
  };
}
