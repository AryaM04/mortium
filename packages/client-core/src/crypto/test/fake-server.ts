// A fake key server and to-device queue for the crypto tests. It keeps
// the same rules as the real server (atomic claim, fallback key, queue
// with acknowledgements), but in memory, and every user sees every user.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import {
  deviceKeysSignedText,
  type BackupSession,
  type BackupVersion,
  type ChannelMembersResponse,
  type ClaimedKey,
  type QueriedUser,
  type ToDeviceDispatchPayload,
  type UploadKeysRequest,
  type UploadKeysResponse,
} from "@mortium/shared";
import { initSync, verify } from "@mortium/crypto-wasm";
import type { SecureStore } from "../../platform.js";
import { startCrypto, type CryptoHandle, type CryptoTransport, type StartCryptoOptions } from "../index.js";

// The crypto store uses the global IDBKeyRange, as in a browser.
globalThis.IDBKeyRange ??= IDBKeyRange;

/** The password that the fake server accepts for a master key reset. */
export const TEST_PASSWORD = "correct-password";

function codeError(code: string, status = 400): Error {
  return Object.assign(new Error(code), { code, status });
}

/** Load the WASM file from disk, as the browser loads it from a URL. */
export function initWasmForTests(): void {
  const require = createRequire(import.meta.url);
  initSync({ module: readFileSync(require.resolve("@mortium/crypto-wasm/pkg/crypto_wasm_bg.wasm")) });
}

interface FakeDevice {
  userId: string;
  deviceId: string;
  keys?: { curve25519: string; ed25519: string; signature: string };
  masterSignature: string | null;
  oneTimeKeys: Map<string, { key: string; signature: string }>;
  fallback?: { keyId: string; key: string; signature: string; used: boolean };
}

interface QueuedMessage {
  id: bigint;
  recipient: string;
  payload: ToDeviceDispatchPayload;
}

export function memorySecureStore(): SecureStore {
  const values = new Map<string, string>();
  return {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      values.set(key, value);
    },
    delete: async (key) => {
      values.delete(key);
    },
  };
}

/** One simulated client device: its own IndexedDB and secure store, which survive a restart. */
export interface TestClient {
  userId: string;
  deviceId: string;
  indexedDb: IDBFactory;
  secureStore: SecureStore;
  handle: CryptoHandle | null;
  received: Array<{ type: string; content: Record<string, unknown>; from: string }>;
}

const key = (userId: string, deviceId: string) => `${userId}:${deviceId}`;

export class FakeServer {
  readonly devices = new Map<string, FakeDevice>();
  readonly masters = new Map<string, { publicKey: string; deviceId: string; deviceSignature: string }>();
  readonly queue: QueuedMessage[] = [];
  private readonly online = new Map<string, CryptoHandle>();
  private nextId = 1n;
  /** The members of each channel, as the channel members route gives them. */
  readonly channels = new Map<string, ChannelMembersResponse>();
  /** Users that the clients see as offline. */
  readonly offline = new Set<string>();
  /** The key backup of each user: the current version and its sessions. */
  readonly backups = new Map<string, { version: BackupVersion; sessions: Map<string, BackupSession> }>();
  private nextBackupVersion = 1;
  /** Change a TO_DEVICE dispatch before it goes out. Tests use it to act as a malicious server. */
  tamper: ((payload: ToDeviceDispatchPayload) => ToDeviceDispatchPayload) | null = null;

  device(userId: string, deviceId: string): FakeDevice {
    let device = this.devices.get(key(userId, deviceId));
    if (!device) {
      device = { userId, deviceId, masterSignature: null, oneTimeKeys: new Map() };
      this.devices.set(key(userId, deviceId), device);
    }
    return device;
  }

  counts(device: FakeDevice): UploadKeysResponse {
    return {
      oneTimeKeyCount: device.oneTimeKeys.size,
      needsFallbackKey: !device.fallback || device.fallback.used,
    };
  }

  transportFor(userId: string, deviceId: string): CryptoTransport {
    return {
      uploadKeys: async (body: UploadKeysRequest) => {
        const device = this.device(userId, deviceId);
        if (body.deviceKeys && !device.keys) {
          device.keys = body.deviceKeys;
          this.broadcast("DEVICE_LIST_UPDATE", { userId });
        }
        for (const [keyId, value] of Object.entries(body.oneTimeKeys ?? {})) {
          device.oneTimeKeys.set(keyId, value);
        }
        if (body.fallbackKey && body.fallbackKey.keyId !== device.fallback?.keyId) {
          device.fallback = { ...body.fallbackKey, used: false };
        }
        if (body.masterSignature) {
          const master = this.masters.get(userId);
          const text = deviceKeysSignedText(userId, deviceId, device.keys!.curve25519, device.keys!.ed25519);
          if (!master || !verify(master.publicKey, text, body.masterSignature)) {
            throw codeError("INVALID_SIGNATURE");
          }
          device.masterSignature = body.masterSignature;
          this.broadcast("DEVICE_LIST_UPDATE", { userId });
        }
        return this.counts(device);
      },
      putMasterKey: async (body) => {
        const existing = this.masters.get(userId);
        if (existing && existing.publicKey !== body.publicKey) {
          throw Object.assign(new Error("exists"), { code: "MASTER_KEY_EXISTS" });
        }
        this.masters.set(userId, { publicKey: body.publicKey, deviceId, deviceSignature: body.deviceSignature });
        this.device(userId, deviceId).masterSignature = body.masterSignature;
        this.broadcast("DEVICE_LIST_UPDATE", { userId });
      },
      uploadSignature: async ({ deviceId: target, signature }) => {
        const device = this.devices.get(key(userId, target));
        const master = this.masters.get(userId);
        if (!device?.keys || !master) {
          throw codeError("DEVICE_KEYS_MISSING");
        }
        const text = deviceKeysSignedText(userId, target, device.keys.curve25519, device.keys.ed25519);
        if (!verify(master.publicKey, text, signature)) {
          throw codeError("INVALID_SIGNATURE");
        }
        device.masterSignature = signature;
        this.broadcast("DEVICE_LIST_UPDATE", { userId });
      },
      resetMasterKey: async ({ password, publicKey, deviceSignature, masterSignature }) => {
        if (password !== TEST_PASSWORD) {
          throw codeError("INVALID_PASSWORD", 401);
        }
        this.masters.set(userId, { publicKey, deviceId, deviceSignature });
        for (const device of this.devices.values()) {
          if (device.userId === userId) {
            device.masterSignature = device.deviceId === deviceId ? masterSignature : null;
          }
        }
        this.backups.delete(userId);
        this.broadcast("DEVICE_LIST_UPDATE", { userId });
      },
      createBackupVersion: async ({ publicKey, authData }) => {
        const version = this.nextBackupVersion++;
        this.backups.set(userId, { version: { version, publicKey, authData, secrets: {} }, sessions: new Map() });
        return { version };
      },
      getBackupVersion: async () => structuredClone(this.backups.get(userId)?.version ?? null),
      deleteBackupVersion: async (version) => {
        if (this.backups.get(userId)?.version.version !== version) {
          throw codeError("BACKUP_NOT_FOUND", 404);
        }
        this.backups.delete(userId);
      },
      putBackupSessions: async ({ version, sessions }) => {
        const backup = this.backups.get(userId);
        if (backup?.version.version !== version) {
          throw codeError("BACKUP_NOT_FOUND", 404);
        }
        let stored = 0;
        for (const session of sessions) {
          const known = backup.sessions.get(session.sessionId);
          if (!known || session.firstIndex < known.firstIndex) {
            backup.sessions.set(session.sessionId, session);
            stored += 1;
          }
        }
        return { stored };
      },
      getBackupSessions: async ({ version, channelId, after, limit = 200 }) => {
        const backup = this.backups.get(userId);
        if (backup?.version.version !== version) {
          throw codeError("BACKUP_NOT_FOUND", 404);
        }
        const all = [...backup.sessions.values()]
          .filter((entry) => (!channelId || entry.channelId === channelId) && (!after || entry.sessionId > after))
          .sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1));
        const page = all.slice(0, limit);
        return { sessions: structuredClone(page), next: all.length > limit ? page.at(-1)!.sessionId : null };
      },
      putBackupSecrets: async (version, secrets) => {
        const backup = this.backups.get(userId);
        if (backup?.version.version !== version) {
          throw codeError("BACKUP_NOT_FOUND", 404);
        }
        backup.version.secrets = { ...backup.version.secrets, ...secrets };
      },
      queryKeys: async (userIds) => ({ users: userIds.map((id) => this.queried(id)) }),
      claimKeys: async (targets) => {
        const keys: ClaimedKey[] = [];
        for (const target of targets) {
          const device = this.devices.get(key(target.userId, target.deviceId));
          if (!device?.keys) {
            continue;
          }
          const first = device.oneTimeKeys.entries().next();
          if (!first.done) {
            const [keyId, value] = first.value;
            device.oneTimeKeys.delete(keyId);
            keys.push({ ...target, keyId, key: value.key, signature: value.signature, fallback: false });
          } else if (device.fallback) {
            device.fallback.used = true;
            const { keyId, key: fallbackKey, signature } = device.fallback;
            keys.push({ ...target, keyId, key: fallbackKey, signature, fallback: true });
          }
        }
        return { keys };
      },
      sendToDeviceLive: (messages) => {
        void this.transportFor(userId, deviceId).sendToDevice(messages);
      },
      sendToDevice: async (messages) => {
        const skipped = [];
        for (const message of messages) {
          const recipient = key(message.userId, message.deviceId);
          if (!this.devices.get(recipient)?.keys) {
            skipped.push({ userId: message.userId, deviceId: message.deviceId });
            continue;
          }
          const id = this.nextId++;
          const payload: ToDeviceDispatchPayload = {
            id: id.toString(),
            senderUserId: userId,
            senderDeviceId: deviceId,
            type: message.type,
            ciphertext: message.ciphertext,
            createdAt: new Date().toISOString(),
          };
          this.queue.push({ id, recipient, payload });
          this.online.get(recipient)?.handleDispatch({ t: "TO_DEVICE", d: this.tamper ? this.tamper(payload) : payload });
        }
        return { skipped };
      },
      channelMembers: async (channelId) => {
        const channel = this.channels.get(channelId);
        if (!channel || !channel.members.some((member) => member.userId === userId)) {
          throw Object.assign(new Error("This channel does not exist."), { status: 404 });
        }
        return structuredClone(channel);
      },
      ackToDevice: (upToId, resync) => {
        const recipient = key(userId, deviceId);
        const limit = BigInt(upToId);
        for (let i = this.queue.length - 1; i >= 0; i -= 1) {
          if (this.queue[i]!.recipient === recipient && this.queue[i]!.id <= limit) {
            this.queue.splice(i, 1);
          }
        }
        if (resync) {
          this.deliverPending(recipient);
        }
      },
    };
  }

  /** Put a raw message in the queue, as if `sender` sent it. For forged-message tests. */
  inject(sender: { userId: string; deviceId: string }, recipient: { userId: string; deviceId: string }, ciphertext: string): void {
    const id = this.nextId++;
    const payload: ToDeviceDispatchPayload = {
      id: id.toString(),
      senderUserId: sender.userId,
      senderDeviceId: sender.deviceId,
      type: "olm.v1",
      ciphertext,
      createdAt: new Date().toISOString(),
    };
    const target = key(recipient.userId, recipient.deviceId);
    this.queue.push({ id, recipient: target, payload });
    this.online.get(target)?.handleDispatch({ t: "TO_DEVICE", d: payload });
  }

  /** Send a gateway dispatch to every online client, as the server sends a membership event. */
  broadcast(t: string, d: unknown): void {
    for (const handle of this.online.values()) {
      handle.handleDispatch({ t, d });
    }
  }

  /** Remove a device, as a sign-out does. Its keys and its queue go away. */
  removeDevice(userId: string, deviceId: string): void {
    this.devices.delete(key(userId, deviceId));
    this.broadcast("DEVICE_LIST_UPDATE", { userId });
  }

  queuedFor(userId: string, deviceId: string): number {
    return this.queue.filter((entry) => entry.recipient === key(userId, deviceId)).length;
  }

  /** Start (or restart) the crypto layer of a client and mark it online. */
  async start(client: TestClient, extra: Partial<StartCryptoOptions> = {}): Promise<CryptoHandle> {
    const recipient = key(client.userId, client.deviceId);
    const handle = await startCrypto({
      userId: client.userId,
      deviceId: client.deviceId,
      transport: this.transportFor(client.userId, client.deviceId),
      secureStore: client.secureStore,
      indexedDb: client.indexedDb,
      isOnline: (userId) => !this.offline.has(userId),
      megolmTimings: { requestDelaysMs: [0, 20, 40], backupForwardDelayMs: [30, 60], membershipDebounceMs: 5 },
      backupTimings: { batchDelayMs: 0, debounceMs: 5 },
      ...extra,
    });
    handle.onToDevice((event) => {
      client.received.push({ type: event.type, content: event.content, from: key(event.sender.userId, event.sender.deviceId) });
    });
    client.handle = handle;
    this.online.set(recipient, handle);
    this.deliverPending(recipient);
    return handle;
  }

  stop(client: TestClient): void {
    this.online.delete(key(client.userId, client.deviceId));
    client.handle?.stop();
    client.handle = null;
  }

  private deliverPending(recipient: string): void {
    const handle = this.online.get(recipient);
    for (const entry of this.queue.filter((item) => item.recipient === recipient)) {
      handle?.handleDispatch({ t: "TO_DEVICE", d: entry.payload });
    }
  }

  private queried(userId: string): QueriedUser {
    const master = this.masters.get(userId);
    return {
      userId,
      masterKey: master ?? null,
      devices: [...this.devices.values()]
        .filter((device) => device.userId === userId && device.keys)
        .map((device) => ({ deviceId: device.deviceId, ...device.keys!, masterSignature: device.masterSignature })),
    };
  }
}

export function newClient(userId: string, deviceId: string): TestClient {
  return { userId, deviceId, indexedDb: new IDBFactory(), secureStore: memorySecureStore(), handle: null, received: [] };
}

/** Wait until the clients processed every message, a few rounds, because an answer can start new work. */
export async function settleClients(clients: TestClient[]): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    for (const client of clients) {
      await client.handle?.whenIdle();
    }
  }
}

/**
 * Run a full SAS verification: `first` asks, `second` accepts, both see the
 * same emojis and both confirm. For two devices of one user, the device
 * with the master key signs the other one. Returns the emojis.
 */
export async function verifyWithSas(first: TestClient, second: TestClient, others: TestClient[] = []): Promise<string[]> {
  const clients = [first, second, ...others];
  const txnId =
    first.userId === second.userId
      ? await first.handle!.verification.requestOwnDevices(second.deviceId)
      : await first.handle!.verification.requestUser(second.userId);
  await settleClients(clients);
  await second.handle!.verification.accept(txnId);
  await settleClients(clients);
  const view = (client: TestClient) => client.handle!.verification.list().find((entry) => entry.txnId === txnId)!;
  const [a, b] = [view(first), view(second)];
  if (a.phase !== "emojis" || b.phase !== "emojis" || JSON.stringify(a.emojis) !== JSON.stringify(b.emojis)) {
    throw new Error(`The SAS did not reach equal emojis: ${a.phase} ${b.phase} ${a.cancelReason ?? b.cancelReason ?? ""}`);
  }
  await first.handle!.verification.confirm(txnId, true);
  await second.handle!.verification.confirm(txnId, true);
  await settleClients(clients);
  if (view(first).phase !== "done" || view(second).phase !== "done") {
    throw new Error(`The SAS did not finish: ${view(first).cancelReason ?? view(second).cancelReason ?? "no reason"}`);
  }
  return a.emojis!.map((entry) => entry.name);
}
