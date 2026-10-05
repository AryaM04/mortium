// The worker side of the crypto RPC. One SharedWorker for each device runs
// the crypto layer for all tabs of that device. It holds the Web Lock
// `crypto:<userId>:<deviceId>` while the layer runs, so it never runs at
// the same time as a worker of a different build or a tab without the
// worker. See docs/concepts/olm-megolm.md section 13.
import { ApiError } from "../api.js";
import {
  fromRpcError,
  randomId,
  toRpcError,
  type CallMethod,
  type CallSignatures,
  type CryptoClient,
  type CryptoEvent,
  type LockManagerLike,
  type TabMessage,
  type TransportMethod,
  type WorkerMessage,
  type WorkerState,
} from "./rpc.js";
import type { CryptoTransport } from "./transport.js";

/** The crypto layer as the host runs it. */
export type HostedCrypto = CryptoClient & { resyncToDevice(): void };

export interface CryptoHostOptions {
  /** Start the crypto layer of one device. The host calls it only while it holds the device lock. */
  start(options: {
    userId: string;
    deviceId: string;
    transport: CryptoTransport;
    isOnline: (userId: string) => boolean;
  }): Promise<HostedCrypto>;
  locks: LockManagerLike;
  log?: (message: string) => void;
}

export interface CryptoHost {
  /** Serve one tab. */
  connect(port: MessagePort): void;
}

/** A void transport call gets no answer that the crypto layer waits for. */
const TRANSPORT_METHODS: Record<TransportMethod, "reply" | "void"> = {
  uploadKeys: "reply",
  putMasterKey: "reply",
  uploadSignature: "reply",
  resetMasterKey: "reply",
  createBackupVersion: "reply",
  getBackupVersion: "reply",
  deleteBackupVersion: "reply",
  putBackupSessions: "reply",
  getBackupSessions: "reply",
  putBackupSecrets: "reply",
  queryKeys: "reply",
  claimKeys: "reply",
  sendToDevice: "reply",
  sendToDeviceLive: "void",
  channelMembers: "reply",
  ackToDevice: "void",
};

/** To-device types that the crypto layer uses itself. Their content (room keys, SAS data) stays in the worker. */
const INTERNAL_TO_DEVICE = /^(megolm|settings|verification)\./;

/** The worker keeps at most this many dispatches while the crypto layer starts. */
const MAX_BUFFERED_DISPATCHES = 1000;

interface Tab {
  port: MessagePort;
  alive: boolean;
  /** The `create` functions of backup setups that this tab started. */
  setups: Map<string, () => Promise<void>>;
}

interface Run {
  userId: string;
  deviceId: string;
  state: WorkerState | null;
  handle: HostedCrypto | null;
  ready: Promise<HostedCrypto>;
  stopped: boolean;
  /** Dispatches that arrived before the layer started. */
  buffered: Array<{ t: string; d: unknown }>;
  release: (() => void) | null;
}

type Handlers = {
  [M in CallMethod]: (
    handle: HostedCrypto,
    tab: Tab,
    id: number,
    ...args: Parameters<CallSignatures[M]>
  ) => ReturnType<CallSignatures[M]>;
};

function post(tab: Tab, message: WorkerMessage, transfer: Transferable[] = []): void {
  if (tab.alive) {
    tab.port.postMessage(message, transfer);
  }
}

/** The buffer of a byte array, when the array is the only view of it. Only such a buffer can move to the tab. */
function ownBuffer(bytes: Uint8Array): ArrayBuffer[] {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer
    ? [bytes.buffer]
    : [];
}

const handlers: Handlers = {
  "codec.encode": (handle, _tab, _id, channelId, payload) => handle.codec.encode(channelId, payload),
  "codec.decode": (handle, _tab, _id, event) => handle.codec.decode(event),
  hasMegolmSession: (handle, _tab, _id, sessionId) => handle.hasMegolmSession(sessionId),
  encryptToDevices: (handle, _tab, _id, targets, type, content, options) =>
    handle.encryptToDevices(targets, type, content, options),
  encryptToUsers: (handle, _tab, _id, userIds, type, content) => handle.encryptToUsers(userIds, type, content),
  "settings.open": (handle, _tab, _id, blob) => handle.settings.open(blob),
  "settings.seal": (handle, _tab, _id, plaintext, keyId) => handle.settings.seal(plaintext, keyId),
  sessionCount: (handle) => handle.sessionCount(),
  changedMasterKeys: (handle) => handle.changedMasterKeys(),
  "security.state": (handle) => handle.security.state(),
  "security.ownDevices": (handle) => handle.security.ownDevices(),
  "security.userTrust": (handle, _tab, _id, userId) => handle.security.userTrust(userId),
  "security.acceptIdentityChange": (handle, _tab, _id, userId) => handle.security.acceptIdentityChange(userId),
  "security.setUpBackup": async (handle, tab, _id, passphrase) => {
    const { recoveryKey, create } = await handle.security.setUpBackup(passphrase);
    const token = randomId();
    tab.setups.set(token, create);
    return { recoveryKey, token };
  },
  "security.createBackup": async (_handle, tab, _id, token) => {
    const create = tab.setups.get(token);
    if (!create) {
      throw new Error("The key backup setup is not known. Start the setup again.");
    }
    tab.setups.delete(token);
    await create();
  },
  "security.restoreBackup": (handle, tab, id, input) =>
    handle.security.restoreBackup(input, (progress) => post(tab, { kind: "progress", id, progress })),
  "security.deleteBackup": (handle) => handle.security.deleteBackup(),
  "security.resetIdentity": (handle, _tab, _id, authKey) => handle.security.resetIdentity(authKey),
  "verification.requestOwnDevices": (handle, _tab, _id, deviceId) => handle.verification.requestOwnDevices(deviceId),
  "verification.requestUser": (handle, _tab, _id, userId) => handle.verification.requestUser(userId),
  "verification.accept": (handle, _tab, _id, txnId) => handle.verification.accept(txnId),
  "verification.confirm": (handle, _tab, _id, txnId, match) => handle.verification.confirm(txnId, match),
  "verification.cancel": (handle, _tab, _id, txnId) => handle.verification.cancel(txnId),
  "verification.dismiss": (handle, _tab, _id, txnId) => handle.verification.dismiss(txnId),
  "search.apply": (handle, _tab, _id, changes) => handle.search.apply(changes),
  "search.query": (handle, _tab, _id, query) => handle.search.query(query),
};

export function createCryptoHost(options: CryptoHostOptions): CryptoHost {
  const { locks } = options;
  const log = options.log ?? (() => {});
  const tabs = new Set<Tab>();
  /** The tab whose gateway session sends the TO_DEVICE_ACK, the live signals and the network calls. */
  let ackTab: Tab | null = null;
  let run: Run | null = null;
  let offline = new Set<string>();
  let nextTransportId = 1;
  const transportCalls = new Map<number, { tab: Tab; resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  // The worker holds this lock while it lives. A tab waits for it to see that the worker stopped.
  const workerLock = `crypto-worker:${randomId()}`;
  const held = new Promise<void>((resolve) => {
    void locks.request(workerLock, () => {
      resolve();
      return new Promise<never>(() => {});
    });
  });

  function noTabError(): ApiError {
    return new ApiError(0, "NETWORK_ERROR", "No tab of this app is open to reach the server.");
  }

  function tabCall(method: TransportMethod, args: unknown[]): Promise<unknown> {
    const tab = ackTab;
    if (!tab) {
      return Promise.reject(noTabError());
    }
    const id = nextTransportId++;
    return new Promise((resolve, reject) => {
      transportCalls.set(id, { tab, resolve, reject });
      post(tab, { kind: "transport", id, method, args });
    });
  }

  const transport = Object.fromEntries(
    (Object.keys(TRANSPORT_METHODS) as TransportMethod[]).map((method) => [
      method,
      (...args: unknown[]) => {
        const call = tabCall(method, args);
        if (TRANSPORT_METHODS[method] === "void") {
          call.catch(() => undefined);
          return undefined;
        }
        return call;
      },
    ]),
  ) as unknown as CryptoTransport;

  function broadcast(message: WorkerMessage): void {
    for (const tab of tabs) {
      post(tab, message);
    }
  }

  function setState(current: Run, state: WorkerState): void {
    current.state = state;
    if (run === current) {
      broadcast({ kind: "state", ...state });
    }
  }

  function subscribe(handle: HostedCrypto): () => void {
    const send = (event: CryptoEvent) => broadcast({ kind: "event", event });
    const stops = [
      handle.codec.onKeys?.((channelId, sessionId) => send({ type: "keys", channelId, sessionId })),
      handle.onToDevice((event) => {
        if (!INTERNAL_TO_DEVICE.test(event.type)) {
          send({ type: "toDevice", event });
        }
      }),
      handle.settings.onKey((keyId) => send({ type: "settingsKey", keyId })),
      handle.security.onChange(() => send({ type: "security" })),
      handle.verification.onChange(() => send({ type: "verification", verifications: handle.verification.list() })),
    ];
    return () => stops.forEach((stop) => stop?.());
  }

  function startRun(userId: string, deviceId: string): void {
    let resolveReady!: (handle: HostedCrypto) => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<HostedCrypto>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    ready.catch(() => undefined);
    const current: Run = { userId, deviceId, state: null, handle: null, ready, stopped: false, buffered: [], release: null };

    const body = async () => {
      if (current.stopped) {
        rejectReady(new Error("The crypto layer stopped."));
        return;
      }
      let handle: HostedCrypto;
      try {
        handle = await options.start({ userId, deviceId, transport, isOnline: (id) => !offline.has(id) });
      } catch (error) {
        log(`The crypto layer could not start: ${String(error)}`);
        rejectReady(error instanceof Error ? error : new Error(String(error)));
        setState(current, { state: "failed", error: toRpcError(error) });
        if (run === current) {
          run = null;
        }
        return;
      }
      if (current.stopped) {
        handle.stop();
        rejectReady(new Error("The crypto layer stopped."));
        return;
      }
      current.handle = handle;
      const unsubscribe = subscribe(handle);
      for (const dispatch of current.buffered.splice(0)) {
        handle.handleDispatch(dispatch);
      }
      resolveReady(handle);
      setState(current, {
        state: "ready",
        identityKeys: handle.identityKeys,
        verifications: handle.verification.list(),
      });
      // Hold the device lock until the last tab goes.
      await new Promise<void>((resolve) => {
        current.release = resolve;
      });
      unsubscribe();
      handle.stop();
    };

    run = current;
    const lockName = `crypto:${userId}:${deviceId}`;
    void locks
      .request(lockName, { ifAvailable: true }, (lock) => {
        if (lock) {
          return body();
        }
        setState(current, { state: "waiting" });
        return locks.request(lockName, body);
      })
      .catch((error: unknown) => log(`The device lock failed: ${String(error)}`));
  }

  function stopRun(current: Run): void {
    current.stopped = true;
    current.release?.();
    if (run === current) {
      run = null;
    }
  }

  /** The tab closed, signed out or stopped: forget it, and move its jobs to a different tab. */
  function drop(tab: Tab): void {
    if (!tab.alive) {
      return;
    }
    tab.alive = false;
    tabs.delete(tab);
    tab.setups.clear();
    tab.port.close();
    for (const [id, call] of transportCalls) {
      if (call.tab === tab) {
        transportCalls.delete(id);
        call.reject(noTabError());
      }
    }
    if (ackTab === tab) {
      ackTab = tabs.values().next().value ?? null;
      // The gateway session of the new tab has its own window of unacknowledged
      // messages. A resync ack through it sends every queued message again,
      // so no message is lost.
      if (ackTab) {
        run?.handle?.resyncToDevice();
      }
    }
    if (tabs.size === 0 && run) {
      stopRun(run);
    }
  }

  async function call(tab: Tab, id: number, method: CallMethod, args: unknown[]): Promise<void> {
    try {
      const current = run;
      if (!current || !Object.hasOwn(handlers, method)) {
        throw new Error("The crypto layer is not running.");
      }
      const handle = await current.ready;
      const value = await (handlers[method] as (...values: unknown[]) => unknown)(handle, tab, id, ...args);
      const transfer = method === "codec.encode" ? ownBuffer((value as { ciphertext: Uint8Array }).ciphertext) : [];
      post(tab, { kind: "result", id, value }, transfer);
    } catch (error) {
      post(tab, { kind: "result", id, error: toRpcError(error) });
    }
  }

  function hello(tab: Tab, message: Extract<TabMessage, { kind: "hello" }>): void {
    if (run && (run.userId !== message.userId || run.deviceId !== message.deviceId)) {
      post(tab, { kind: "state", state: "failed", error: { name: "Error", message: "This worker runs for a different device." } });
      return;
    }
    tabs.add(tab);
    ackTab ??= tab;
    // The tab holds this lock while it lives. The grant means that the tab closed.
    void locks.request(message.tabLock, () => drop(tab)).catch(() => undefined);
    post(tab, { kind: "welcome", workerLock });
    if (!run) {
      startRun(message.userId, message.deviceId);
    } else if (run.state) {
      post(tab, { kind: "state", ...run.state });
    }
  }

  function receive(tab: Tab, message: TabMessage): void {
    if (message.kind === "hello") {
      hello(tab, message);
      return;
    }
    if (!tabs.has(tab)) {
      return;
    }
    switch (message.kind) {
      case "call":
        void call(tab, message.id, message.method, message.args);
        break;
      case "dispatch": {
        const current = run;
        if (!current) {
          break;
        }
        if (message.dispatch.t === "READY" || message.dispatch.t === "RESUMED") {
          // The newest gateway session sends the acks. The crypto layer resyncs through it now.
          ackTab = tab;
        }
        if (current.handle) {
          current.handle.handleDispatch(message.dispatch);
        } else if (current.buffered.length < MAX_BUFFERED_DISPATCHES) {
          current.buffered.push(message.dispatch);
        }
        break;
      }
      case "presence":
        offline = new Set(message.offline);
        break;
      case "transportResult": {
        const pending = transportCalls.get(message.id);
        if (pending?.tab === tab) {
          transportCalls.delete(message.id);
          if (message.error) {
            pending.reject(fromRpcError(message.error));
          } else {
            pending.resolve(message.value);
          }
        }
        break;
      }
    }
  }

  return {
    connect(port) {
      const tab: Tab = { port, alive: true, setups: new Map() };
      port.onmessage = (event: MessageEvent<TabMessage>) => {
        const message = event.data;
        // Answer only after the worker lock is held, so a tab never gets that lock by mistake.
        void held.then(() => receive(tab, message));
      };
    },
  };
}
