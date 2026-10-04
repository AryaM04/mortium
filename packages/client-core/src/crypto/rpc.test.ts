// Tests of the crypto RPC between the tabs and the SharedWorker, with
// MessageChannel ports and fake Web Locks: calls and errors, events, a tab
// that closes, a worker that stops, and the to-device path with the real
// crypto layer (one copy is processed, and one tab sends the acks).
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ToDeviceDispatchPayload } from "@mortium/shared";
import { ApiError } from "../api.js";
import { connectCryptoWorker, CryptoWorkerLostError, type CryptoWorkerClient } from "./client.js";
import { createCryptoHost, type CryptoHost, type HostedCrypto } from "./host.js";
import { startCrypto, type CryptoTransport, type DecryptedToDevice } from "./index.js";
import { FakeLocks } from "./test/fake-locks.js";
import { FakeServer, initWasmForTests, memorySecureStore, newClient } from "./test/fake-server.js";

beforeAll(() => {
  initWasmForTests();
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
});

/** A fake crypto layer: enough behavior to see each kind of call cross the port. */
function fakeCrypto(transport: CryptoTransport) {
  const toDevice = new Set<(event: DecryptedToDevice) => void>();
  const verificationListeners = new Set<() => void>();
  const listen = <T>(set: Set<T>, listener: T) => {
    set.add(listener);
    return () => void set.delete(listener);
  };
  const state = { resyncs: 0, created: 0, hang: new Promise<never>(() => {}) };
  const handle: HostedCrypto = {
    userId: "1",
    deviceId: "D",
    identityKeys: { curve25519: "curve", ed25519: "ed" },
    codec: {
      encode: async () => ({ codec: "megolm-v1", ciphertext: new Uint8Array([1, 2, 3]), megolmSessionId: "s1" }),
      decode: async () => ({ ok: false, reason: "waiting", waiting: true }),
      onKeys: () => () => {},
    },
    hasMegolmSession: () => state.hang,
    handleDispatch: () => {},
    encryptToDevices: async () => ({ sent: [], failed: [] }),
    encryptToUsers: async () => ({ sent: [], failed: [] }),
    onToDevice: (handler) => listen(toDevice, handler as (event: DecryptedToDevice) => void),
    settings: {
      open: async () => {
        throw Object.assign(new Error("no key"), { name: "SettingsKeyMissingError" });
      },
      seal: async () => ({ blob: new Uint8Array([9]), keyId: "k" }),
      onKey: () => () => {},
    },
    sessionCount: async () => (await transport.queryKeys(["2"])).users.length,
    changedMasterKeys: async () => [],
    security: {
      state: async () => {
        throw new ApiError(429, "RATE_LIMITED", "Too many requests.");
      },
      onChange: () => () => {},
      ownDevices: async () => [],
      userTrust: async () => ({ verified: false, changed: false }),
      acceptIdentityChange: async () => {},
      setUpBackup: async () => ({
        recoveryKey: "EsTc 1234",
        create: async () => {
          state.created += 1;
        },
      }),
      restoreBackup: async (_input, onProgress) => {
        onProgress?.({ imported: 1, failed: 0 });
        onProgress?.({ imported: 2, failed: 0 });
        return { imported: 2, failed: 0, signed: false, settingsKeys: 0 };
      },
      deleteBackup: async () => {},
      resetIdentity: async () => {},
    },
    verification: {
      list: () => [],
      onChange: (listener) => listen(verificationListeners, listener),
      requestOwnDevices: async () => "t",
      requestUser: async () => "t",
      accept: async () => {},
      confirm: async () => {},
      cancel: async () => {},
      dismiss: () => {},
    },
    search: { apply: async () => {}, query: async () => [] },
    resyncToDevice: () => {
      state.resyncs += 1;
    },
    stop: () => {},
  };
  const emit = (type: string) =>
    toDevice.forEach((handler) =>
      handler({
        id: "e1",
        type,
        content: { text: type },
        sender: { userId: "2", deviceId: "B", curve25519: "c", ed25519: "e", ownerVerified: false, masterSignature: null } as never,
      }),
    );
  return { handle, state, emit };
}

/** A transport for one tab that records the calls. `queryKeys` can hang. */
function tabTransport(name: string, calls: string[], hang = false): CryptoTransport {
  return new Proxy({} as CryptoTransport, {
    get: (_target, method: string) => (...args: unknown[]) => {
      calls.push(`${name}:${method}:${JSON.stringify(args)}`);
      if (method === "queryKeys") {
        return hang ? new Promise(() => {}) : Promise.resolve({ users: [{ userId: "2" }] });
      }
      return method === "ackToDevice" || method === "sendToDeviceLive" ? undefined : Promise.resolve({});
    },
  });
}

function openTab(
  host: () => CryptoHost,
  locks: FakeLocks,
  transport: CryptoTransport,
  states: string[] = [],
): { client: CryptoWorkerClient; kill: () => void } {
  const context = locks.context();
  const client = connectCryptoWorker({
    userId: "1",
    deviceId: "D",
    connect: () => {
      const channel = new MessageChannel();
      host().connect(channel.port2);
      cleanups.push(() => {
        channel.port1.close();
        channel.port2.close();
      });
      return channel.port1;
    },
    transport,
    locks: context.locks,
    onState: (state) => states.push(state),
  });
  cleanups.push(() => client.stop());
  return { client, kill: context.kill };
}

describe("crypto RPC", () => {
  it("answers calls, keeps the error types and sends the events", async () => {
    const locks = new FakeLocks();
    let fake!: ReturnType<typeof fakeCrypto>;
    const host = createCryptoHost({
      locks: locks.context().locks,
      start: async ({ transport }) => (fake = fakeCrypto(transport)).handle,
    });
    const states: string[] = [];
    const { client } = openTab(() => host, locks, tabTransport("A", []), states);

    const encoded = await client.codec.encode("c1", { type: "message", body: "hi", mentions: [], attachments: [], embeds: [] });
    expect(encoded.megolmSessionId).toBe("s1");
    expect(Array.from(encoded.ciphertext)).toEqual([1, 2, 3]);
    expect(states).toEqual(["ready"]);
    expect(client.identityKeys.ed25519).toBe("ed");

    const apiError = await client.security.state().catch((error: unknown) => error);
    expect(apiError).toBeInstanceOf(ApiError);
    expect((apiError as ApiError).status).toBe(429);
    expect((apiError as ApiError).code).toBe("RATE_LIMITED");
    const named = await client.settings.open(null).catch((error: unknown) => error);
    expect((named as Error).name).toBe("SettingsKeyMissingError");

    // The worker asks the tab for the network call.
    expect(await client.sessionCount()).toBe(1);

    const received: string[] = [];
    client.onToDevice((event) => void received.push(event.type));
    fake.emit("voice.signal");
    fake.emit("megolm.session");
    await vi.waitFor(() => expect(received).toEqual(["voice.signal"]));
  });

  it("keeps the backup setup in the worker and sends the restore progress", async () => {
    const locks = new FakeLocks();
    let fake!: ReturnType<typeof fakeCrypto>;
    const host = createCryptoHost({
      locks: locks.context().locks,
      start: async ({ transport }) => (fake = fakeCrypto(transport)).handle,
    });
    const { client } = openTab(() => host, locks, tabTransport("A", []));
    const prepared = await client.security.setUpBackup();
    expect(prepared.recoveryKey).toBe("EsTc 1234");
    await prepared.create();
    expect(fake.state.created).toBe(1);
    await expect(prepared.create()).rejects.toThrow("The key backup setup is not known.");

    const progress: number[] = [];
    const result = await client.security.restoreBackup({ recoveryKey: "x" }, (entry) => progress.push(entry.imported));
    expect(result.imported).toBe(2);
    expect(progress).toEqual([1, 2]);
  });

  it("fails the network calls of a closed tab, and moves the acks to the next tab", async () => {
    const locks = new FakeLocks();
    let fake!: ReturnType<typeof fakeCrypto>;
    let transport!: CryptoTransport;
    const host = createCryptoHost({
      locks: locks.context().locks,
      start: async (options) => {
        transport = options.transport;
        return (fake = fakeCrypto(transport)).handle;
      },
    });
    const calls: string[] = [];
    const first = openTab(() => host, locks, tabTransport("A", calls, true));
    await first.client.changedMasterKeys();
    const second = openTab(() => host, locks, tabTransport("B", calls));
    await second.client.changedMasterKeys();

    // The first tab sends the network calls. It closes while one runs.
    const running = transport.queryKeys(["2"]);
    await vi.waitFor(() => expect(calls).toContain('A:queryKeys:[["2"]]'));
    first.kill();
    const error = await running.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("NETWORK_ERROR");
    expect(fake.state.resyncs).toBe(1);

    transport.ackToDevice("5", false);
    await vi.waitFor(() => expect(calls).toContain('B:ackToDevice:["5",false]'));
    expect(calls.filter((entry) => entry.startsWith("A:ackToDevice"))).toEqual([]);

    // A READY on a tab moves the acks to that tab.
    const third = openTab(() => host, locks, tabTransport("C", calls));
    await third.client.changedMasterKeys();
    third.client.handleDispatch({ t: "READY", d: {} });
    await third.client.changedMasterKeys();
    transport.ackToDevice("6", false);
    await vi.waitFor(() => expect(calls).toContain('C:ackToDevice:["6",false]'));
  });

  it("connects to a new worker after the worker stops, and keeps the listeners", async () => {
    const locks = new FakeLocks();
    const workers: Array<{ host: CryptoHost; kill: () => void; fake?: ReturnType<typeof fakeCrypto> }> = [];
    const makeWorker = () => {
      const context = locks.context();
      const worker: (typeof workers)[number] = {
        kill: context.kill,
        host: createCryptoHost({
          locks: context.locks,
          start: async ({ transport }) => (worker.fake = fakeCrypto(transport)).handle,
        }),
      };
      workers.push(worker);
      return worker.host;
    };
    // Each connect finds the live worker, as `new SharedWorker` does.
    let live: CryptoHost | null = null;
    const states: string[] = [];
    const { client } = openTab(() => (live ??= makeWorker()), locks, tabTransport("A", []), states);
    const received: string[] = [];
    client.onToDevice((event) => void received.push(String(event.content.text)));

    const hanging = client.hasMegolmSession("s1");
    await vi.waitFor(() => expect(states).toEqual(["ready"]));
    live = null;
    workers[0]!.kill();
    await expect(hanging).rejects.toBeInstanceOf(CryptoWorkerLostError);

    await vi.waitFor(() => expect(states).toEqual(["ready", "ready"]));
    expect(workers).toHaveLength(2);
    workers[1]!.fake!.emit("voice.signal");
    await vi.waitFor(() => expect(received).toEqual(["voice.signal"]));
  });

  it("waits while a different context holds the device lock", async () => {
    const locks = new FakeLocks();
    const other = locks.context();
    let releaseOther!: () => void;
    void other.locks.request("crypto:1:D", () => new Promise<void>((resolve) => (releaseOther = resolve)));
    const host = createCryptoHost({
      locks: locks.context().locks,
      start: async ({ transport }) => fakeCrypto(transport).handle,
    });
    const states: string[] = [];
    const { client } = openTab(() => host, locks, tabTransport("A", []), states);
    const answer = client.changedMasterKeys();
    await vi.waitFor(() => expect(states).toEqual(["waiting"]));
    releaseOther();
    await expect(answer).resolves.toEqual([]);
    expect(states).toEqual(["waiting", "ready"]);
  });

  it("processes one copy of a to-device message from two tabs, and sends one ack stream", async () => {
    const server = new FakeServer();
    const alice = newClient("1", "A1");
    await server.start(alice);
    const locks = new FakeLocks();
    const host = createCryptoHost({
      locks: locks.context().locks,
      start: (options) =>
        startCrypto({ ...options, secureStore: memorySecureStore(), indexedDb: new IDBFactory() }),
    });
    const acks: Array<{ tab: string; upToId: string; resync: boolean }> = [];
    const tabFor = (name: string) => {
      const real = server.transportFor("2", "B1");
      const transport: CryptoTransport = {
        ...real,
        ackToDevice: (upToId, resync) => {
          acks.push({ tab: name, upToId, resync });
          real.ackToDevice(upToId, resync);
        },
      };
      const context = locks.context();
      const client = connectCryptoWorker({
        userId: "2",
        deviceId: "B1",
        connect: () => {
          const channel = new MessageChannel();
          host.connect(channel.port2);
          cleanups.push(() => channel.port1.close());
          return channel.port1;
        },
        transport,
        locks: context.locks,
        onState: () => {},
      });
      cleanups.push(() => client.stop());
      return client;
    };
    const tab1 = tabFor("tab1");
    await tab1.changedMasterKeys();
    const tab2 = tabFor("tab2");
    await tab2.changedMasterKeys();
    const seen = { tab1: [] as string[], tab2: [] as string[] };
    tab1.onToDevice((event) => void seen.tab1.push(String(event.content.text)));
    tab2.onToDevice((event) => void seen.tab2.push(String(event.content.text)));

    await alice.handle!.encryptToUsers(["2"], "debug.ping", { text: "hello" });
    const queued = server.queue.filter((entry) => entry.recipient === "2:B1").map((entry) => entry.payload);
    expect(queued).toHaveLength(1);
    // Both gateway sessions get the message. The second tab forwards it first.
    const dispatch = { t: "TO_DEVICE", d: queued[0] as ToDeviceDispatchPayload };
    tab2.handleDispatch(dispatch);
    tab1.handleDispatch(dispatch);
    tab2.handleDispatch(dispatch);

    await vi.waitFor(() => expect(acks.filter((ack) => !ack.resync)).toHaveLength(1), { timeout: 5000 });
    expect(seen).toEqual({ tab1: ["hello"], tab2: ["hello"] });
    // Only the first tab (the ack tab) sends acks: the resync at start and the one ack.
    expect(acks.map((ack) => ack.tab)).toEqual(["tab1", "tab1"]);
    expect(acks.at(-1)!.upToId).toBe(queued[0]!.id);
    expect(server.queuedFor("2", "B1")).toBe(0);
  }, 15_000);
});
