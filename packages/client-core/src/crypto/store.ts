// The crypto store: one IndexedDB database for each user and device. It
// holds pickles (encrypted by vodozemac with the pickle key), the device
// list cache, the Megolm sessions and small state values. See
// docs/concepts/olm-megolm.md sections 7 and 8.
import type { SecureStore } from "../platform.js";

/** One Olm session with one peer device. `peerKey` is the Curve25519 key of the peer. */
export interface SessionRecord {
  peerKey: string;
  sessionId: string;
  pickle: string;
  createdAt: number;
  /** When a message from the peer last decrypted with this session, or 0. */
  lastReceivedAt: number;
}

/** One device of a user, after the client verified its signature. */
export interface DeviceRecord {
  userId: string;
  deviceId: string;
  curve25519: string;
  ed25519: string;
  /** True when the trusted master key of the user signed this device. */
  ownerVerified: boolean;
}

/** What the client knows about the device list of one user. */
export interface UserRecord {
  userId: string;
  /** Tracked users get DEVICE_LIST_UPDATE handling and are kept fresh. */
  tracked: boolean;
  /** True when the cached device list may be old. */
  outdated: boolean;
  /** The master key trusted on first use, or null. */
  masterKey: string | null;
  /** A different master key that the server now shows. The UI must warn. */
  changedMasterKey: string | null;
  /** The master key that a SAS verification confirmed. It is stronger than trust on first use. */
  verifiedMasterKey?: string | null;
}

/** The outbound Megolm session of this device for one channel. */
export interface OutboundRecord {
  channelId: string;
  sessionId: string;
  pickle: string;
  /** The device signature that binds the session to the channel and this device. */
  signature: string;
  createdAt: number;
  messageCount: number;
  /** The devices that got the session key, as "userId:deviceId". */
  sharedWith: string[];
  /**
   * Every reader device that this device saw while the session was in use.
   * A reader can forward the key to them, so the removal of one starts a new session.
   */
  seenDevices: string[];
  /** Not set for a DM. */
  guildId?: string;
  /** True when a membership event can have removed a reader. The next send starts a new session. */
  rotate?: boolean;
}

/** One inbound Megolm session. The session id is the public key of the session, so it is unique. */
export interface InboundRecord {
  sessionId: string;
  channelId: string;
  /** The sender device, as this device verified it when the key arrived. */
  senderUserId: string;
  senderDeviceId: string;
  senderEd25519: string;
  /** The sender device signature over the session binding. */
  signature: string;
  pickle: string;
  firstKnownIndex: number;
  /** The event id of each decrypted message index. A different event with a used index is a replay. */
  indexes: Record<string, string>;
  /** True when the key came from a different device than the sender (history share or key request). */
  forwarded: boolean;
  /** The key backup version that has this session at this first index. Not set when the backup does not have it. */
  backupVersion?: number;
}

/** The users who could read a channel when this device last checked. Used to find new members. */
export interface ChannelSnapshot {
  channelId: string;
  /** Not set for a DM. */
  guildId?: string;
  userIds: string[];
}

/** One write batch. The store applies it in one transaction. */
export interface StoreChanges {
  values?: Record<string, unknown>;
  sessions?: SessionRecord[];
  deleteSessions?: Array<[peerKey: string, sessionId: string]>;
}

export interface CryptoStore {
  getOutbound(channelId: string): Promise<OutboundRecord | undefined>;
  allOutbound(): Promise<OutboundRecord[]>;
  putOutbound(record: OutboundRecord): Promise<void>;
  deleteOutbound(channelId: string): Promise<void>;
  getInbound(sessionId: string): Promise<InboundRecord | undefined>;
  putInbound(record: InboundRecord): Promise<void>;
  inboundForChannel(channelId: string): Promise<InboundRecord[]>;
  /** At most `limit` inbound sessions with a session id after `after`, in session id order. */
  inboundPage(after: string | null, limit: number): Promise<InboundRecord[]>;
  /** Mark sessions as in the backup version, when their first index did not change since the upload. */
  markBackedUp(sessions: Array<{ sessionId: string; firstKnownIndex: number }>, version: number): Promise<void>;
  getSnapshot(channelId: string): Promise<ChannelSnapshot | undefined>;
  putSnapshot(snapshot: ChannelSnapshot): Promise<void>;
  snapshotsForGuild(guildId: string): Promise<ChannelSnapshot[]>;
  getValue<T>(key: string): Promise<T | undefined>;
  getSessions(peerKey: string): Promise<SessionRecord[]>;
  countSessions(): Promise<number>;
  getUser(userId: string): Promise<UserRecord | undefined>;
  getUsers(): Promise<UserRecord[]>;
  putUser(user: UserRecord): Promise<void>;
  getDevices(userId: string): Promise<DeviceRecord[]>;
  /** Replace the device list of one user and its user record, in one transaction. */
  replaceDevices(user: UserRecord, devices: DeviceRecord[]): Promise<void>;
  commit(changes: StoreChanges): Promise<void>;
  close(): void;
}

const VERSION = 2;
const VALUES = "values";
const SESSIONS = "sessions";
const USERS = "users";
const DEVICES = "devices";
const OUTBOUND = "outbound";
const INBOUND = "inbound";
const CHANNELS = "channels";

function done(request: IDBRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("An IndexedDB request failed."));
  });
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("An IndexedDB transaction failed."));
    tx.onabort = () => reject(tx.error ?? new Error("An IndexedDB transaction was stopped."));
  });
}

function open(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (event.oldVersion < 1) {
        db.createObjectStore(VALUES);
        db.createObjectStore(SESSIONS, { keyPath: ["peerKey", "sessionId"] }).createIndex("peerKey", "peerKey");
        db.createObjectStore(USERS, { keyPath: "userId" });
        db.createObjectStore(DEVICES, { keyPath: ["userId", "deviceId"] }).createIndex("userId", "userId");
      }
      if (event.oldVersion < 2) {
        db.createObjectStore(OUTBOUND, { keyPath: "channelId" });
        db.createObjectStore(INBOUND, { keyPath: "sessionId" }).createIndex("channelId", "channelId");
        db.createObjectStore(CHANNELS, { keyPath: "channelId" }).createIndex("guildId", "guildId");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("The crypto store could not open."));
  });
}

/**
 * The local crypto data of this device is lost or cannot be opened. A new
 * try does not help: the user must sign out, and the next sign-in makes a
 * new device.
 */
export class CryptoStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoStoreError";
  }
}

/** The database name of the crypto store of one user and device. */
export function cryptoStoreName(userId: string, deviceId: string): string {
  return `crypto:${userId}:${deviceId}`;
}

/** The database name of the local search index of one user and device. */
export function searchIndexName(userId: string, deviceId: string): string {
  return `search:${userId}:${deviceId}`;
}

/** The secure store entry of the pickle key of one user and device. */
export function pickleKeyName(userId: string, deviceId: string): string {
  return `crypto-pickle-key:${userId}:${deviceId}`;
}

function deleteDatabase(factory: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(`The database ${name} could not be deleted.`));
  });
}

/**
 * Delete the local crypto data of a device after a sign-out: the crypto
 * store, the search index and the pickle key. Call it only while no
 * context runs the crypto layer of the device (hold the device lock).
 */
export async function deleteDeviceData(
  secureStore: SecureStore,
  userId: string,
  deviceId: string,
  factory: IDBFactory = indexedDB,
): Promise<void> {
  await deleteDatabase(factory, cryptoStoreName(userId, deviceId));
  await deleteDatabase(factory, searchIndexName(userId, deviceId));
  await secureStore.delete(pickleKeyName(userId, deviceId));
}

/** Open the IndexedDB crypto store. Tests pass their own `factory`. */
export async function openCryptoStore(name: string, factory: IDBFactory = indexedDB): Promise<CryptoStore> {
  const db = await open(factory, name);

  async function read<T>(storeName: string, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
    const tx = db.transaction(storeName, "readonly");
    return (await done(run(tx.objectStore(storeName)))) as T;
  }

  async function write(storeName: string, run: (store: IDBObjectStore) => void): Promise<void> {
    const tx = db.transaction(storeName, "readwrite");
    run(tx.objectStore(storeName));
    await finished(tx);
  }

  return {
    getOutbound: (channelId) => read(OUTBOUND, (store) => store.get(channelId)),
    allOutbound: () => read(OUTBOUND, (store) => store.getAll()),
    putOutbound: (record) => write(OUTBOUND, (store) => store.put(record)),
    deleteOutbound: (channelId) => write(OUTBOUND, (store) => store.delete(channelId)),
    getInbound: (sessionId) => read(INBOUND, (store) => store.get(sessionId)),
    putInbound: (record) => write(INBOUND, (store) => store.put(record)),
    inboundForChannel: (channelId) => read(INBOUND, (store) => store.index("channelId").getAll(channelId)),
    inboundPage: (after, limit) =>
      read(INBOUND, (store) => store.getAll(after === null ? null : IDBKeyRange.lowerBound(after, true), limit)),
    async markBackedUp(sessions, version) {
      const tx = db.transaction(INBOUND, "readwrite");
      const store = tx.objectStore(INBOUND);
      for (const { sessionId, firstKnownIndex } of sessions) {
        const record = (await done(store.get(sessionId))) as InboundRecord | undefined;
        if (record && record.firstKnownIndex === firstKnownIndex) {
          store.put({ ...record, backupVersion: version });
        }
      }
      await finished(tx);
    },
    getSnapshot: (channelId) => read(CHANNELS, (store) => store.get(channelId)),
    putSnapshot: (snapshot) => write(CHANNELS, (store) => store.put(snapshot)),
    snapshotsForGuild: (guildId) => read(CHANNELS, (store) => store.index("guildId").getAll(guildId)),

    getValue: (key) => read(VALUES, (store) => store.get(key)),

    getSessions: (peerKey) => read(SESSIONS, (store) => store.index("peerKey").getAll(peerKey)),

    countSessions: () => read(SESSIONS, (store) => store.count()),

    getUser: (userId) => read(USERS, (store) => store.get(userId)),

    getUsers: () => read(USERS, (store) => store.getAll()),

    async putUser(user) {
      const tx = db.transaction(USERS, "readwrite");
      tx.objectStore(USERS).put(user);
      await finished(tx);
    },

    getDevices: (userId) => read(DEVICES, (store) => store.index("userId").getAll(userId)),

    async replaceDevices(user, devices) {
      const tx = db.transaction([USERS, DEVICES], "readwrite");
      const deviceStore = tx.objectStore(DEVICES);
      const oldKeys = (await done(deviceStore.index("userId").getAllKeys(user.userId))) as IDBValidKey[];
      for (const key of oldKeys) {
        deviceStore.delete(key);
      }
      for (const device of devices) {
        deviceStore.put(device);
      }
      tx.objectStore(USERS).put(user);
      await finished(tx);
    },

    async commit(changes) {
      const tx = db.transaction([VALUES, SESSIONS], "readwrite");
      for (const [key, value] of Object.entries(changes.values ?? {})) {
        tx.objectStore(VALUES).put(value, key);
      }
      for (const session of changes.sessions ?? []) {
        tx.objectStore(SESSIONS).put(session);
      }
      for (const key of changes.deleteSessions ?? []) {
        tx.objectStore(SESSIONS).delete(key);
      }
      await finished(tx);
    },

    close() {
      db.close();
    },
  };
}
