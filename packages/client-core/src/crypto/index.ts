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
import { OlmMachine, type EncryptResult, type ToDeviceHandler } from "./olm-machine.js";
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
  /** Make a new master key after the old one is lost. The account password is necessary. */
  resetIdentity(password: string): Promise<void>;
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
  /** Ask the server to send again every to-device message after the last processed one. */
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
        void checkSelfVerified();
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

  /** True when the trusted master key of this user signed this device. */
  async function isSelfVerified(): Promise<boolean> {
    const self = (await store.getDevices(userId)).find((device) => device.deviceId === deviceId);
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
  let lastAckedId = await olm.lastProcessed();
  /**
   * The highest queue id in the inbox or processed. Every tab forwards the
   * TO_DEVICE dispatches of its own gateway session, and each session gets
   * the queue in id order. Thus a lower or equal id is a copy.
   */
  let lastQueuedId = BigInt(lastAckedId);
  let lastAckAt = 0;
  let ackTimer: ReturnType<typeof setTimeout> | null = null;
  let sinceAck = 0;

  function sendAck(): void {
    if (ackTimer) {
      clearTimeout(ackTimer);
    }
    ackTimer = null;
    sinceAck = 0;
    void olm.lastProcessed().then((processed) => {
      if (stopped || BigInt(processed) <= BigInt(lastAckedId)) {
        return;
      }
      lastAckedId = processed;
      lastAckAt = Date.now();
      transport.ackToDevice(processed, false);
    });
  }

  function scheduleAck(): void {
    if (ackTimer || stopped) {
      return;
    }
    const wait = Math.max(0, lastAckAt + ACK_INTERVAL_MS - Date.now());
    ackTimer = setTimeout(sendAck, wait);
  }

  function drain(): Promise<void> {
    draining ??= (async () => {
      while (inbox.length > 0 && !stopped) {
        await olm.handleToDevice(inbox.shift()!);
        sinceAck += 1;
        if (sinceAck >= ACK_BATCH) {
          sendAck();
        }
      }
      draining = null;
      scheduleAck();
    })();
    return draining;
  }

  /** Ask the server to send again every message after the last processed one. */
  async function resync(): Promise<void> {
    const processed = await olm.lastProcessed();
    lastAckedId = processed;
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
      if (parsed.success && BigInt(parsed.data.id) > lastQueuedId) {
        lastQueuedId = BigInt(parsed.data.id);
        inbox.push(parsed.data);
        void drain();
      }
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
      if (dispatch.t === "READY") {
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
    async resetIdentity(password) {
      await manager.resetMasterKey(password);
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
      inbox.length = 0;
      store.close();
      void searchIndex?.then((index) => index.close()).catch(() => undefined);
    },
  };
}
