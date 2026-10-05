// The crypto layer entry point. The web app loads this module with a
// dynamic import after sign-in, so the WASM file and this code stay out of
// the main bundle. See docs/concepts/olm-megolm.md.
import {
  decodeBase64Url,
  deviceListUpdatePayloadSchema,
  encodeBase64Url,
  readyPayloadSchema,
  toDeviceDispatchPayloadSchema,
  type DeviceRef,
  type ToDeviceDispatchPayload,
} from "@mortium/shared";
import { decodePlainEvent, type PayloadCodec } from "../codec.js";
import type { SecureStore } from "../platform.js";
import {
  applySearchChanges,
  openLocalSearchIndex,
  type IndexQuery,
  type IndexResult,
  type LocalSearchIndex,
  type SearchChange,
} from "../search/local-index.js";
import { AccountHolder } from "./account.js";
import { DeviceList } from "./device-list.js";
import { DeviceManager } from "./device-manager.js";
import { KeyBackup, type BackupStatus, type BackupTimings, type RestoreProgress, type RestoreResult } from "./key-backup.js";
import { MegolmMachine, type MegolmTimings } from "./megolm.js";
import { ChannelMembership, membershipScope } from "./membership.js";
import { OlmMachine, isTemporaryError, type EncryptResult, type ToDeviceHandler } from "./olm-machine.js";
import { KeyedQueue } from "./queue.js";
import { SettingsKeys } from "./settings-key.js";
import { cryptoStoreName, openCryptoStore, type CryptoStore } from "./store.js";
import type { CryptoTransport } from "./transport.js";
import { VerificationMachine, type VerificationView } from "./verification.js";
import { loadWasm } from "./wasm.js";

export { createHttpCryptoTransport, type CryptoTransport } from "./transport.js";
export type { DecryptedToDevice, EncryptResult, ToDeviceHandler } from "./olm-machine.js";
export type { DeviceRecord, UserRecord } from "./store.js";
export { WAITING_TEXT, type MegolmTimings } from "./megolm.js";
export { SettingsKeyMissingError } from "./settings-key.js";
export { WrongRecoveryKeyError, type BackupStatus, type RestoreProgress, type RestoreResult } from "./key-backup.js";
export { SAS_EMOJIS, type VerificationPhase, type VerificationView } from "./verification.js";
export { decodeRecoveryKey, encodeRecoveryKey } from "./recovery-key.js";
export { createCryptoHost, type CryptoHost, type CryptoHostOptions, type HostedCrypto } from "./host.js";
export type { CryptoClient } from "./rpc.js";

/** The gateway events that say that a user left a guild, a DM or a channel. */
const MEMBER_LEFT_EVENTS = new Set([
  "GUILD_MEMBER_REMOVE",
  "GUILD_BAN_ADD",
  "GUILD_DELETE",
  "CHANNEL_DELETE",
  "CHANNEL_RECIPIENT_REMOVE",
]);

/** Send at most one TO_DEVICE_ACK in this time, unless the local queue is empty for longer. */
const ACK_INTERVAL_MS = 2000;
/** Send a TO_DEVICE_ACK at once after this many messages. The server sends at most 100 before an ACK. */
const ACK_BATCH = 50;
/** The wait before the first new try of a to-device message that failed on a temporary error. It doubles up to the maximum. */
const RETRY_FIRST_MS = 1000;
const RETRY_MAX_MS = 30_000;
/** The queue ids that the inbox keeps to find copies from other tabs. */
const MAX_QUEUED_IDS = 1000;

export interface StartCryptoOptions {
  userId: string;
  deviceId: string;
  transport: CryptoTransport;
  secureStore: SecureStore;
  /** The IndexedDB factory. Tests pass a fake one. */
  indexedDb?: IDBFactory;
  log?: (message: string) => void;
  now?: () => number;
  /** True when a user is online. Only online devices send history to a new member. Default: every user is online. */
  isOnline?: (userId: string) => boolean;
  random?: () => number;
  /** Shorter Megolm delays for tests. */
  megolmTimings?: Partial<MegolmTimings>;
  /** Shorter key backup delays for tests. */
  backupTimings?: Partial<BackupTimings>;
  /** A shorter verification timeout for tests. */
  verificationTimeoutMs?: number;
}

/** The trust state of this device and the key backup, for the UI. */
export interface SecurityState {
  /** True when the master key of this user signed this device. Only then do other devices share keys with it. */
  deviceVerified: boolean;
  /** True when this device holds the master private key, so it can sign other devices of this user. */
  holdsMasterKey: boolean;
  backup: BackupStatus;
}

/** One device of this user, for the device list in the security settings. */
export interface OwnDevice {
  deviceId: string;
  verified: boolean;
  current: boolean;
}

/** What this device knows about the identity (the master key) of a user. */
export interface UserTrust {
  /** True when a SAS verification confirmed the current master key of the user. */
  verified: boolean;
  /** True when the master key changed since this device trusted it. No keys go to that user until the change is accepted. */
  changed: boolean;
}

export interface SecurityApi {
  state(): Promise<SecurityState>;
  /** Watch changes of the state, of the device list of this user and of the identity of other users. */
  onChange(listener: () => void): () => void;
  ownDevices(): Promise<OwnDevice[]>;
  userTrust(userId: string): Promise<UserTrust>;
  /** Accept the new master key of a user after an identity change. */
  acceptIdentityChange(userId: string): Promise<void>;
  /**
   * Prepare a new key backup. Returns the recovery key text, to show one
   * time, and `create`, which makes the backup on the server.
   */
  setUpBackup(passphrase?: string): Promise<{ recoveryKey: string; create: () => Promise<void> }>;
  restoreBackup(
    input: { recoveryKey: string } | { passphrase: string },
    onProgress?: (progress: RestoreProgress) => void,
  ): Promise<RestoreResult>;
  deleteBackup(): Promise<void>;
  /** Make a new master key after the old one is lost. The auth key of the account password is necessary. */
  resetIdentity(authKey: string): Promise<void>;
}

export interface VerificationApi {
  list(): VerificationView[];
  onChange(listener: () => void): () => void;
  /** Ask the other devices of this user (or one of them) to verify this device. */
  requestOwnDevices(deviceId?: string): Promise<string>;
  /** Ask a different user to verify identities with this user. */
  requestUser(userId: string): Promise<string>;
  accept(txnId: string): Promise<void>;
  /** The user compared the emojis: `match` false cancels. */
  confirm(txnId: string, match: boolean): Promise<void>;
  cancel(txnId: string): Promise<void>;
  dismiss(txnId: string): void;
}

export interface CryptoHandle {
  readonly userId: string;
  readonly deviceId: string;
  readonly identityKeys: { curve25519: string; ed25519: string };
  readonly devices: DeviceList;
  /** The message codec: Megolm for every new event. It can still read old plaintext events. */
  readonly codec: PayloadCodec;
  /** True when this device has the inbound Megolm key of a session. */
  hasMegolmSession(sessionId: string): Promise<boolean>;
  /** Feed every gateway dispatch here. It uses READY, RESUMED, TO_DEVICE, DEVICE_LIST_UPDATE and the membership events. */
  handleDispatch(dispatch: { t: string; d: unknown }): void;
  /** Encrypt and send one envelope to each device. With `live`, it goes over the gateway with no reply (voice signals). */
  encryptToDevices(
    targets: DeviceRef[],
    type: string,
    content: Record<string, unknown>,
    options?: { live?: boolean },
  ): Promise<EncryptResult>;
  /** Encrypt and send one envelope to every device of these users, except this device. */
  encryptToUsers(userIds: string[], type: string, content: Record<string, unknown>): Promise<EncryptResult>;
  onToDevice(handler: ToDeviceHandler): () => void;
  /** The encryption of the synced settings blob. See settings-key.ts. */
  readonly settings: Pick<SettingsKeys, "open" | "seal" | "onKey">;
  sessionCount(): Promise<number>;
  /** Users whose master key changed. The UI must warn about each one. */
  changedMasterKeys(): Promise<string[]>;
  onMasterKeyChanged(listener: (userId: string) => void): () => void;
  /** Device verification, the key backup and identity changes. */
  readonly security: SecurityApi;
  /** SAS verification with a different device. */
  readonly verification: VerificationApi;
  /**
   * The keys of the local search index of this device: AES-GCM for the
   * stored message text, and HMAC-SHA-256 for the stored words. Both come
   * from the pickle key (HKDF), and page code cannot export them.
   */
  localIndexKeys(): Promise<LocalIndexKeys>;
  /** The local search index of this device. Only the crypto layer writes it, so two tabs never race. */
  readonly search: {
    apply(changes: SearchChange[]): Promise<void>;
    query(query: IndexQuery): Promise<IndexResult[]>;
  };
  /** Ask the server to send again every queued to-device message. */
  resyncToDevice(): void;
  /** Wait until every received message is processed. For tests. */
  whenIdle(): Promise<void>;
  stop(): void;
}

export interface LocalIndexKeys {
  encryptionKey: CryptoKey;
  tokenKey: CryptoKey;
}

/** Derive the two keys of the local search index from the pickle key. */
async function deriveLocalIndexKeys(pickleKey: Uint8Array): Promise<LocalIndexKeys> {
  const base = await crypto.subtle.importKey("raw", pickleKey as Uint8Array<ArrayBuffer>, "HKDF", false, ["deriveKey"]);
  const params = (info: string) => ({
    name: "HKDF",
    hash: "SHA-256",
    salt: new Uint8Array(32),
    info: new TextEncoder().encode(info),
  });
  const [encryptionKey, tokenKey] = await Promise.all([
    crypto.subtle.deriveKey(params("mortium local search text"), base, { name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]),
    crypto.subtle.deriveKey(params("mortium local search words"), base, { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]),
  ]);
  return { encryptionKey, tokenKey };
}

/** Get the pickle key of this device, or make one. It is kept only in the platform secure store. */
async function loadPickleKey(secureStore: SecureStore, userId: string, deviceId: string): Promise<Uint8Array> {
  const name = `crypto-pickle-key:${userId}:${deviceId}`;
  const stored = await secureStore.get(name);
  if (stored) {
    return decodeBase64Url(stored);
  }
  const key = crypto.getRandomValues(new Uint8Array(32));
  await secureStore.set(name, encodeBase64Url(key));
  return key;
}

/**
 * Start the crypto layer of one device: load or make the account, set up
 * the keys on the server and start to handle to-device messages. The
 * caller must make sure that only one context of a device runs it (the Web
 * Lock `crypto:<userId>:<deviceId>`).
 */
export async function startCrypto(options: StartCryptoOptions): Promise<CryptoHandle> {
  const { userId, deviceId, transport } = options;
  const log = options.log ?? (() => {});
  const wasm = await loadWasm();
  const pickleKey = await loadPickleKey(options.secureStore, userId, deviceId);
  const store: CryptoStore = await openCryptoStore(cryptoStoreName(userId, deviceId), options.indexedDb);
  const queue = new KeyedQueue();
  const account = await AccountHolder.load(wasm, store, pickleKey, queue);

  const masterKeyListeners = new Set<(userId: string) => void>();
  const securityListeners = new Set<() => void>();
  const securityChanged = () => {
    for (const listener of securityListeners) {
      listener();
    }
  };
  let selfVerified: boolean | null = null;
  let stopped = false;
  const devices = new DeviceList({
    store,
    transport,
    wasm,
    queue,
    now: options.now,
    onMasterKeyChanged: (changedUserId) => {
      for (const listener of masterKeyListeners) {
        listener(changedUserId);
      }
    },
    onUserChanged: (changedUserId) => {
      if (changedUserId === userId && selfVerified !== null) {
        void checkSelfVerified().catch((error: unknown) => log(`The device list could not be fetched: ${String(error)}`));
      }
      securityChanged();
    },
  });
  await devices.trackUsers([userId]);

  const manager = new DeviceManager({ wasm, store, transport, account, deviceList: devices, pickleKey, userId, deviceId });
  const olm = new OlmMachine({
    wasm,
    store,
    transport,
    deviceList: devices,
    account,
    queue,
    pickleKey,
    userId,
    deviceId,
    now: options.now,
    log,
    onOneTimeKeyUsed: () => manager.noteOneTimeKeyUsed(),
  });
  await manager.setup();

  const megolm = new MegolmMachine({
    wasm,
    store,
    olm,
    deviceList: devices,
    membership: new ChannelMembership((channelId) => transport.channelMembers(channelId), options.now),
    account,
    queue,
    pickleKey,
    userId,
    deviceId,
    isOnline: options.isOnline,
    now: options.now,
    random: options.random,
    log,
    timings: options.megolmTimings,
  });
  olm.onToDevice((event) => megolm.handleToDevice(event));
  const settings = new SettingsKeys({
    store,
    pickleKey,
    deviceList: devices,
    encryptToDevices: (targets, type, content) => olm.encryptToDevices(targets, type, content),
    userId,
    deviceId,
    now: options.now,
    log,
  });
  olm.onToDevice((event) => settings.handleToDevice(event));

  const backup = new KeyBackup({
    wasm,
    store,
    transport,
    deviceList: devices,
    manager,
    megolm,
    settings,
    account,
    userId,
    deviceId,
    log,
    timings: options.backupTimings,
  });
  backup.onChange(securityChanged);
  megolm.onKeys(() => backup.noteNewKey());
  settings.onKey(() => backup.noteNewKey());

  const verification = new VerificationMachine({
    wasm,
    deviceList: devices,
    manager,
    encryptToDevices: (targets, type, content) => olm.encryptToDevices(targets, type, content),
    userId,
    deviceId,
    ed25519: account.ed25519,
    log,
    timeoutMs: options.verificationTimeoutMs,
  });
  olm.onToDevice((event) => verification.handleToDevice(event));

  /** True when the trusted master key of this user signed this device. It fetches the own devices when they are outdated. */
  async function isSelfVerified(): Promise<boolean> {
    const self = (await devices.getDevices(userId)).find((device) => device.deviceId === deviceId);
    return self !== undefined && (await devices.isTrusted(self));
  }

  /**
   * When this device becomes verified, other devices answer its key
   * requests, and it can use the key backup. So it asks again.
   */
  async function checkSelfVerified(): Promise<void> {
    const now = await isSelfVerified();
    const before = selfVerified;
    selfVerified = now;
    if (now && before === false && !stopped) {
      log("This device is verified now. It asks again for the keys that it does not have.");
      megolm.restartRequests();
      await settings.retryRequests();
      await backup.refresh().catch((error: unknown) => log(`The key backup could not be checked: ${String(error)}`));
    }
  }

  const codec: PayloadCodec = {
    async encode(channelId, payload) {
      const { sessionId, ciphertext } = await megolm.encrypt(channelId, payload);
      return { codec: "megolm-v1", ciphertext, megolmSessionId: sessionId };
    },
    async decode(event) {
      return event.codec === "plain-v1" ? decodePlainEvent(event) : megolm.decrypt(event);
    },
    onKeys: (listener) => megolm.onKeys(listener),
  };

  // ---- to-device inbox: one message at a time, in arrival order ----
  const inbox: ToDeviceDispatchPayload[] = [];
  let draining: Promise<void> | null = null;
  /**
   * The queue ids in the inbox or processed by this run. Every tab forwards
   * the TO_DEVICE dispatches of its own gateway session, so the same id can
   * arrive more than one time. Ids do not arrive in order: a row with a
   * lower id can commit on the server after a row with a higher id.
   */
  const queuedIds = new Set<string>();
  /** True when a message arrived after the last TO_DEVICE_ACK. */
  let ackPending = false;
  let lastAckAt = 0;
  let ackTimer: ReturnType<typeof setTimeout> | null = null;
  let sinceAck = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryDelay = RETRY_FIRST_MS;

  function sendAck(): void {
    if (ackTimer) {
      clearTimeout(ackTimer);
    }
    ackTimer = null;
    sinceAck = 0;
    if (!ackPending) {
      return;
    }
    ackPending = false;
    void olm.lastProcessed().then((processed) => {
      if (stopped) {
        return;
      }
      // The server deletes the acknowledged rows. A message that waits in the inbox must stay.
      let upToId = BigInt(processed);
      for (const entry of inbox) {
        upToId = BigInt(entry.id) <= upToId ? BigInt(entry.id) - 1n : upToId;
      }
      lastAckAt = Date.now();
      transport.ackToDevice(upToId.toString(), false);
    });
  }

  function scheduleAck(): void {
    if (ackTimer || stopped) {
      return;
    }
    const wait = Math.max(0, lastAckAt + ACK_INTERVAL_MS - Date.now());
    ackTimer = setTimeout(sendAck, wait);
  }

  /** Process the inbox. A temporary error keeps the message first in the inbox, and a later try starts it again. */
  function drain(): Promise<void> {
    draining ??= (async () => {
      try {
        while (inbox.length > 0 && !stopped && !retryTimer) {
          try {
            await olm.handleToDevice(inbox[0]!);
          } catch (error) {
            if (isTemporaryError(error)) {
              log(`A to-device message failed. The app tries again in ${retryDelay} ms: ${String(error)}`);
              retryTimer = setTimeout(() => {
                retryTimer = null;
                void drain();
              }, retryDelay);
              retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
              return;
            }
            log(`A to-device message could not be processed: ${String(error)}`);
          }
          inbox.shift();
          retryDelay = RETRY_FIRST_MS;
          ackPending = true;
          sinceAck += 1;
          if (sinceAck >= ACK_BATCH) {
            sendAck();
          }
        }
      } finally {
        draining = null;
        scheduleAck();
      }
    })();
    return draining;
  }

  /** Ask the server to send again every queued message. The copies of processed messages are dropped. */
  async function resync(): Promise<void> {
    const processed = await olm.lastProcessed();
    lastAckAt = Date.now();
    transport.ackToDevice(processed, true);
  }

  function handleDispatch(dispatch: { t: string; d: unknown }): void {
    if (stopped) {
      return;
    }
    const scope = membershipScope(dispatch);
    if (scope) {
      megolm.onMembershipChange(scope, MEMBER_LEFT_EVENTS.has(dispatch.t));
    }
    if (dispatch.t === "TO_DEVICE") {
      const parsed = toDeviceDispatchPayloadSchema.safeParse(dispatch.d);
      if (!parsed.success) {
        return;
      }
      // Each copy is acknowledged too, so the server can delete it.
      ackPending = true;
      if (queuedIds.has(parsed.data.id)) {
        scheduleAck();
        return;
      }
      queuedIds.add(parsed.data.id);
      if (queuedIds.size > MAX_QUEUED_IDS) {
        queuedIds.delete(queuedIds.values().next().value!);
      }
      inbox.push(parsed.data);
      void drain();
    } else if (dispatch.t === "DEVICE_LIST_UPDATE") {
      const parsed = deviceListUpdatePayloadSchema.safeParse(dispatch.d);
      if (parsed.success) {
        const changedUserId = parsed.data.userId;
        void devices
          .markOutdated(changedUserId)
          // The security UI shows the devices of this user, so they are fetched at once.
          .then(() => (changedUserId === userId && !stopped ? devices.refresh([userId]) : undefined))
          .catch((error: unknown) => log(`The device list could not be fetched: ${String(error)}`));
      }
    } else if (dispatch.t === "READY" || dispatch.t === "RESUMED") {
      void resync();
      megolm.retryRequests();
      if (retryTimer) {
        // The connection is back: try the waiting message again now.
        clearTimeout(retryTimer);
        retryTimer = null;
        retryDelay = RETRY_FIRST_MS;
        void drain();
      }
      if (dispatch.t === "READY") {
        // Device lists can have changed while this device was offline.
        void devices
          .markAllOutdated()
          .then(() => (stopped ? undefined : devices.refresh([userId])))
          .catch((error: unknown) => log(`The device list could not be fetched: ${String(error)}`));
        // A different device can have made or deleted the key backup while this one was away.
        void backup.refresh().catch((error: unknown) => log(`The key backup could not be checked: ${String(error)}`));
        const parsed = readyPayloadSchema.safeParse(dispatch.d);
        if (parsed.success) {
          void manager
            .onKeyCounts(parsed.data)
            .catch((error: unknown) => log(`The one-time keys could not be topped up: ${String(error)}`));
        }
      }
    }
  }

  await resync();
  selfVerified = await isSelfVerified();
  void backup.refresh().catch((error: unknown) => log(`The key backup could not be checked: ${String(error)}`));

  const security: SecurityApi = {
    async state() {
      return { deviceVerified: await isSelfVerified(), holdsMasterKey: await manager.hasMasterKey(), backup: backup.status() };
    },
    onChange(listener) {
      securityListeners.add(listener);
      return () => {
        securityListeners.delete(listener);
      };
    },
    async ownDevices() {
      const own = await devices.getDevices(userId);
      const user = await devices.getUser(userId);
      const trusted = user !== undefined && user.changedMasterKey === null;
      return own.map((device) => ({
        deviceId: device.deviceId,
        verified: trusted && device.ownerVerified,
        current: device.deviceId === deviceId,
      }));
    },
    async userTrust(target) {
      await devices.getDevices(target);
      const user = await devices.getUser(target);
      return {
        verified: Boolean(user?.masterKey && user.verifiedMasterKey === user.masterKey && user.changedMasterKey === null),
        changed: Boolean(user?.changedMasterKey),
      };
    },
    async acceptIdentityChange(target) {
      await devices.acceptMasterKeyChange(target);
      securityChanged();
    },
    setUpBackup: (passphrase) => backup.setUp(passphrase),
    async restoreBackup(input, onProgress) {
      const result = await backup.restore(input, onProgress);
      await checkSelfVerified();
      securityChanged();
      return result;
    },
    deleteBackup: () => backup.delete(),
    async resetIdentity(authKey) {
      await manager.resetMasterKey(authKey);
      selfVerified = await isSelfVerified();
      await backup.refresh().catch((error: unknown) => log(`The key backup could not be checked: ${String(error)}`));
      securityChanged();
    },
  };

  let indexKeys: Promise<LocalIndexKeys> | null = null;
  const localIndexKeys = () => (indexKeys ??= deriveLocalIndexKeys(pickleKey));
  let searchIndex: Promise<LocalSearchIndex> | null = null;
  const openSearch = () =>
    (searchIndex ??= localIndexKeys().then((keys) =>
      openLocalSearchIndex({ name: `search:${userId}:${deviceId}`, keys, indexedDb: options.indexedDb }),
    ));
  return {
    userId,
    deviceId,
    identityKeys: { curve25519: account.curve25519, ed25519: account.ed25519 },
    devices,
    codec,
    hasMegolmSession: (sessionId) => megolm.hasSession(sessionId),
    handleDispatch,
    encryptToDevices: (targets, type, content, options) => olm.encryptToDevices(targets, type, content, options?.live),
    async encryptToUsers(userIds, type, content) {
      const targets: DeviceRef[] = [];
      for (const target of userIds) {
        for (const device of await devices.getDevices(target)) {
          targets.push({ userId: device.userId, deviceId: device.deviceId });
        }
      }
      return olm.encryptToDevices(targets, type, content);
    },
    onToDevice: (handler) => olm.onToDevice(handler),
    settings: {
      open: (blob) => settings.open(blob),
      seal: (plaintext, keyId) => settings.seal(plaintext, keyId),
      onKey: (listener) => settings.onKey(listener),
    },
    sessionCount: () => olm.sessionCount(),
    changedMasterKeys: () => devices.changedMasterKeys(),
    onMasterKeyChanged(listener) {
      masterKeyListeners.add(listener);
      return () => {
        masterKeyListeners.delete(listener);
      };
    },
    security,
    verification: {
      list: () => verification.list(),
      onChange: (listener) => verification.onChange(listener),
      requestOwnDevices: (target) => verification.requestOwnDevices(target),
      requestUser: (target) => verification.requestUser(target),
      accept: (txnId) => verification.accept(txnId),
      confirm: (txnId, match) => verification.confirm(txnId, match),
      cancel: (txnId) => verification.cancel(txnId),
      dismiss: (txnId) => verification.dismiss(txnId),
    },
    localIndexKeys,
    search: {
      apply: async (changes) => applySearchChanges(await openSearch(), changes),
      query: async (query) => (await openSearch()).search(query),
    },
    resyncToDevice: () => void resync().catch((error: unknown) => log(`The to-device queue could not resync: ${String(error)}`)),
    async whenIdle() {
      for (let round = 0; round < 3; round += 1) {
        while (draining) {
          await draining;
        }
        await olm.whenIdle();
        await megolm.whenIdle();
        await backup.whenIdle();
      }
      while (draining) {
        await draining;
      }
    },
    stop() {
      stopped = true;
      megolm.stop();
      backup.stop();
      verification.stop();
      if (ackTimer) {
        clearTimeout(ackTimer);
      }
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      inbox.length = 0;
      store.close();
      void searchIndex?.then((index) => index.close()).catch(() => undefined);
    },
  };
}
