// The key backup: each inbound Megolm session, the master private key and
// the settings keys go to the server, encrypted to the backup public key.
// Only the recovery key (or its passphrase) decrypts them. A new device
// restores the history with it and signs itself with the master key.
// See docs/concepts/olm-megolm.md section 9.
import {
  backupSignedText,
  canonicalJson,
  decodeBase64Url,
  encodeBase64Url,
  type BackupPassphraseParams,
  type BackupVersion,
} from "@mortium/shared";
import type { AccountHolder } from "./account.js";
import type { DeviceList } from "./device-list.js";
import type { DeviceManager } from "./device-manager.js";
import type { MegolmMachine } from "./megolm.js";
import { decodeRecoveryKey, encodeRecoveryKey } from "./recovery-key.js";
import type { SettingsKeys } from "./settings-key.js";
import type { CryptoStore } from "./store.js";
import type { CryptoTransport } from "./transport.js";
import type { Wasm } from "./wasm.js";

/** The passphrase parameters of a new backup: Argon2id with 64 MiB, 3 passes, 1 lane. */
const PASSPHRASE_PARAMS = { memoryKiB: 64 * 1024, iterations: 3, parallelism: 1 };
const SALT_BYTES = 16;
/** Sessions in one upload request. The server accepts at most 100. */
const UPLOAD_BATCH = 50;
/** Read this many local sessions at a time to find the ones that the backup does not have. */
const SCAN_PAGE = 200;
const DOWNLOAD_PAGE = 200;
const TRUST_VALUE = "backupTrust";
const MASTER_SECRET = "master";
const SETTINGS_SECRET_PREFIX = "settings:";

export interface BackupTimings {
  /** The wait between two upload batches, so a large backup does not load the server. */
  batchDelayMs: number;
  /** The wait after a new key before the upload starts, so that keys that arrive together go in one batch. */
  debounceMs: number;
}

const DEFAULT_TIMINGS: BackupTimings = { batchDelayMs: 1000, debounceMs: 2000 };

/** The state of the key backup, for the UI. */
export interface BackupStatus {
  /** The current backup version on the server, or null when the user has none. */
  version: number | null;
  /** True when this device checked that a verified device of the user made the backup. Only then does it upload. */
  trusted: boolean;
  /** True when the backup has a passphrase. */
  hasPassphrase: boolean;
  /** True while this device uploads keys. */
  uploading: boolean;
  /** The last upload problem, or null. */
  error: string | null;
}

export interface RestoreProgress {
  /** Sessions decrypted and imported so far. */
  imported: number;
  /** Sessions that failed a check. */
  failed: number;
}

export interface RestoreResult extends RestoreProgress {
  /** True when this device got the master key from the backup and signed itself. */
  signed: boolean;
  /** The number of settings keys that the backup gave. */
  settingsKeys: number;
}

/** The recovery key or the passphrase does not open this backup. */
export class WrongRecoveryKeyError extends Error {
  constructor(message = "This recovery key or passphrase does not open the key backup.") {
    super(message);
    this.name = "WrongRecoveryKeyError";
  }
}

export interface KeyBackupDeps {
  wasm: Wasm;
  store: CryptoStore;
  transport: CryptoTransport;
  deviceList: DeviceList;
  manager: DeviceManager;
  megolm: MegolmMachine;
  settings: SettingsKeys;
  account: AccountHolder;
  userId: string;
  deviceId: string;
  log?: (message: string) => void;
  timings?: Partial<BackupTimings>;
}

type BackupKey = InstanceType<Wasm["BackupKey"]>;

function sessionAad(userId: string, version: number, sessionId: string): Uint8Array {
  return new TextEncoder().encode(canonicalJson({ type: "backup_session", userId, version, sessionId }));
}

function secretAad(userId: string, version: number, name: string): Uint8Array {
  return new TextEncoder().encode(canonicalJson({ type: "backup_secret", userId, version, name }));
}

/** The text that the uploader signs for one secret, so the server cannot put in a secret of its own. */
function secretSignedText(userId: string, name: string, value: string): string {
  return canonicalJson({ type: "backup_secret", userId, name, value });
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

export class KeyBackup {
  private readonly timings: BackupTimings;
  private current: BackupVersion | null = null;
  private trusted = false;
  private uploading = false;
  private lastError: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: KeyBackupDeps) {
    this.timings = { ...DEFAULT_TIMINGS, ...deps.timings };
  }

  status(): BackupStatus {
    return {
      version: this.current?.version ?? null,
      trusted: this.trusted,
      hasPassphrase: Boolean(this.current?.authData.passphrase),
      uploading: this.uploading,
      error: this.lastError,
    };
  }

  /** Watch changes of `status()`. Returns a function that stops the watch. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private changed(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private log(message: string): void {
    this.deps.log?.(message);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Wait for the upload that runs now. For tests. */
  async whenIdle(): Promise<void> {
    while (this.running || this.timer) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
        this.startUpload();
      }
      await this.running;
    }
  }

  // ---- version and trust -------------------------------------------------------

  /** Get the current version from the server and check who made it. Then upload what it does not have. */
  async refresh(): Promise<BackupStatus> {
    const backup = await this.deps.transport.getBackupVersion();
    this.current = backup;
    this.trusted = backup ? await this.checkTrust(backup) : false;
    this.lastError = null;
    this.changed();
    if (this.trusted) {
      this.scheduleUpload(0);
    }
    return this.status();
  }

  /**
   * A backup is trusted when this device made it or restored it (it saw the
   * recovery key), or when the master key or a device that the master key
   * signed signed its auth data. Else a malicious server could put in its
   * own public key and read every key that this device uploads.
   */
  private async checkTrust(backup: BackupVersion): Promise<boolean> {
    const { deviceList, userId, wasm } = this.deps;
    const known = await this.deps.store.getValue<{ version: number; publicKey: string }>(TRUST_VALUE);
    if (known && known.version === backup.version && known.publicKey === backup.publicKey) {
      return true;
    }
    const text = backupSignedText(userId, backup.publicKey, backup.authData.passphrase);
    const user = await deviceList.getUser(userId);
    if (user?.masterKey && user.changedMasterKey === null && backup.authData.masterSignature) {
      if (wasm.verify(user.masterKey, text, backup.authData.masterSignature)) {
        return true;
      }
    }
    const signer = await deviceList.getDevice(userId, backup.authData.deviceId);
    if (signer && (await deviceList.isTrusted(signer)) && wasm.verify(signer.ed25519, text, backup.authData.signature)) {
      return true;
    }
    this.log("The key backup is not signed by a verified device of this user. This device does not upload to it.");
    return false;
  }

  private async rememberTrust(backup: BackupVersion): Promise<void> {
    await this.deps.store.commit({ values: { [TRUST_VALUE]: { version: backup.version, publicKey: backup.publicKey } } });
  }

  // ---- set up and delete --------------------------------------------------------

  /**
   * Prepare a new backup. Without a passphrase the recovery key is random.
   * With a passphrase it is Argon2id of the passphrase. Returns the recovery
   * key text to show one time. `create` makes the backup on the server (after
   * the user wrote down the key). Then the upload starts in the background.
   * A new backup replaces the old one.
   */
  async setUp(passphrase?: string): Promise<{ recoveryKey: string; create: () => Promise<void> }> {
    const { wasm, transport, account, manager, userId, deviceId } = this.deps;
    let recovery: Uint8Array;
    let params: BackupPassphraseParams | null = null;
    if (passphrase) {
      const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
      params = { algorithm: "argon2id", salt: encodeBase64Url(salt), ...PASSPHRASE_PARAMS };
      recovery = wasm.derive_recovery_key(passphrase, salt, params.memoryKiB, params.iterations, params.parallelism);
    } else {
      recovery = crypto.getRandomValues(new Uint8Array(32));
    }
    const key = new wasm.BackupKey(recovery);
    let publicKey: string;
    try {
      publicKey = key.public_key;
    } finally {
      key.free();
    }
    const text = backupSignedText(userId, publicKey, params);
    const authData = {
      passphrase: params,
      deviceId,
      signature: account.sign(text),
      masterSignature: await manager.signWithMasterKey(text),
    };
    const create = async () => {
      const { version } = await transport.createBackupVersion({ publicKey, authData });
      this.current = { version, publicKey, authData, secrets: {} };
      this.trusted = true;
      await this.rememberTrust(this.current);
      this.changed();
      this.scheduleUpload(0);
    };
    return { recoveryKey: encodeRecoveryKey(recovery), create };
  }

  /** Delete the current backup on the server. */
  async delete(): Promise<void> {
    if (this.current) {
      try {
        await this.deps.transport.deleteBackupVersion(this.current.version);
      } catch (error) {
        if (errorCode(error) !== "BACKUP_NOT_FOUND") {
          throw error;
        }
      }
    }
    this.current = null;
    this.trusted = false;
    this.changed();
  }

  // ---- upload ------------------------------------------------------------------

  /** Upload new keys soon. The megolm machine calls this for each new or better key. */
  noteNewKey(): void {
    if (this.trusted) {
      this.scheduleUpload(this.timings.debounceMs);
    }
  }

  private scheduleUpload(delay: number): void {
    if (this.stopped || this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.startUpload();
    }, delay);
  }

  private startUpload(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.uploadAll();
      } while (this.again && !this.stopped);
      this.running = null;
    })();
  }

  private async uploadAll(): Promise<void> {
    const backup = this.current;
    if (!backup || !this.trusted || this.stopped) {
      return;
    }
    this.uploading = true;
    this.changed();
    try {
      await this.uploadSecrets(backup);
      await this.uploadSessions(backup);
      this.lastError = null;
    } catch (error) {
      if (errorCode(error) === "BACKUP_NOT_FOUND") {
        // A different device made a new version, or deleted the backup.
        this.log("The key backup version changed. This device gets the new version.");
        this.uploading = false;
        await this.refresh().catch((refreshError: unknown) => this.log(`The key backup could not be checked: ${String(refreshError)}`));
        return;
      }
      this.lastError = "The keys could not be saved in the backup. The app tries again later.";
      this.log(`The key backup upload failed: ${String(error)}`);
    } finally {
      this.uploading = false;
      this.changed();
    }
  }

  /** Put in the secrets that this device has and the backup does not have. */
  private async uploadSecrets(backup: BackupVersion): Promise<void> {
    const values: Record<string, Uint8Array> = {};
    if (!backup.secrets[MASTER_SECRET]) {
      const master = await this.deps.manager.exportMasterSecret();
      if (master) {
        values[MASTER_SECRET] = master;
      }
    }
    for (const [keyId, key] of Object.entries(await this.deps.settings.allKeys())) {
      const name = `${SETTINGS_SECRET_PREFIX}${keyId}`;
      if (!backup.secrets[name]) {
        values[name] = decodeBase64Url(key);
      }
    }
    const names = Object.keys(values);
    if (names.length === 0) {
      return;
    }
    const secrets: Record<string, string> = {};
    for (const name of names) {
      secrets[name] = encodeBase64Url(await this.sealSecret(backup, name, values[name]!));
    }
    await this.deps.transport.putBackupSecrets(backup.version, secrets);
    backup.secrets = { ...backup.secrets, ...secrets };
  }

  /** Encrypt one secret. The plaintext has a signature of the master key (when this device has it) or of this device. */
  private async sealSecret(backup: BackupVersion, name: string, value: Uint8Array): Promise<Uint8Array> {
    const { wasm, manager, account, userId, deviceId } = this.deps;
    const encoded = encodeBase64Url(value);
    const text = secretSignedText(userId, name, encoded);
    const masterSignature = await manager.signWithMasterKey(text);
    const plaintext = JSON.stringify({
      name,
      value: encoded,
      signer: masterSignature ? "master" : deviceId,
      signature: masterSignature ?? account.sign(text),
    });
    return wasm.backup_encrypt(backup.publicKey, new TextEncoder().encode(plaintext), secretAad(userId, backup.version, name));
  }

  /** Upload, in batches, each local session that the backup version does not have. It can stop and go on later. */
  private async uploadSessions(backup: BackupVersion): Promise<void> {
    const { store, megolm, wasm, transport, userId } = this.deps;
    let after: string | null = null;
    let batch: Array<{ channelId: string; sessionId: string; firstIndex: number; data: string }> = [];
    const flush = async () => {
      if (batch.length === 0) {
        return;
      }
      await transport.putBackupSessions({ version: backup.version, sessions: batch });
      await store.markBackedUp(
        batch.map((entry) => ({ sessionId: entry.sessionId, firstKnownIndex: entry.firstIndex })),
        backup.version,
      );
      batch = [];
      if (this.timings.batchDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.timings.batchDelayMs));
      }
    };
    for (;;) {
      const page = await store.inboundPage(after, SCAN_PAGE);
      for (const record of page) {
        if (this.stopped || this.current !== backup) {
          return;
        }
        if (record.backupVersion === backup.version) {
          continue;
        }
        const exported = await megolm.exportSession(record.sessionId);
        if (!exported) {
          continue;
        }
        const plaintext = new TextEncoder().encode(JSON.stringify(exported.content));
        const sealed = wasm.backup_encrypt(backup.publicKey, plaintext, sessionAad(userId, backup.version, record.sessionId));
        batch.push({
          channelId: exported.content.channelId,
          sessionId: exported.content.sessionId,
          firstIndex: exported.firstKnownIndex,
          data: encodeBase64Url(sealed),
        });
        if (batch.length >= UPLOAD_BATCH) {
          await flush();
        }
      }
      if (page.length < SCAN_PAGE) {
        break;
      }
      after = page.at(-1)!.sessionId;
    }
    await flush();
  }

  // ---- restore -----------------------------------------------------------------

  /**
   * Restore from the backup with the recovery key text or the passphrase:
   * get the master key (this device then signs itself), the settings keys
   * and every session. Throws `WrongRecoveryKeyError` for a wrong key.
   */
  async restore(
    input: { recoveryKey: string } | { passphrase: string },
    onProgress?: (progress: RestoreProgress) => void,
  ): Promise<RestoreResult> {
    const { wasm } = this.deps;
    const backup = await this.deps.transport.getBackupVersion();
    if (!backup) {
      throw new Error("There is no key backup for this account.");
    }
    let recovery: Uint8Array | null;
    if ("recoveryKey" in input) {
      recovery = decodeRecoveryKey(input.recoveryKey);
      if (!recovery) {
        throw new WrongRecoveryKeyError("This is not a valid recovery key. Check each character.");
      }
    } else {
      const params = backup.authData.passphrase;
      if (!params) {
        throw new WrongRecoveryKeyError("This backup has no passphrase. Use the recovery key.");
      }
      recovery = wasm.derive_recovery_key(
        input.passphrase,
        decodeBase64Url(params.salt),
        params.memoryKiB,
        params.iterations,
        params.parallelism,
      );
    }
    const key = new wasm.BackupKey(recovery);
    try {
      if (key.public_key !== backup.publicKey) {
        throw new WrongRecoveryKeyError();
      }
      // The recovery key opens this backup, so the user made it.
      this.current = backup;
      this.trusted = true;
      await this.rememberTrust(backup);
      this.changed();
      const { signed, settingsKeys } = await this.restoreSecrets(backup, key);
      const progress = await this.restoreSessions(backup, key, onProgress);
      this.scheduleUpload(0);
      return { ...progress, signed, settingsKeys };
    } finally {
      key.free();
    }
  }

  /** Check the signature of a secret: the trusted master key, or a device that the master key signed. */
  private async secretSignerOk(name: string, value: Uint8Array, signer: string, signature: string): Promise<boolean> {
    const { wasm, deviceList, userId } = this.deps;
    const text = secretSignedText(userId, name, encodeBase64Url(value));
    if (signer === "master") {
      const user = await deviceList.getUser(userId);
      return Boolean(user?.masterKey && user.changedMasterKey === null && wasm.verify(user.masterKey, text, signature));
    }
    const device = await deviceList.getDevice(userId, signer);
    return Boolean(device && (await deviceList.isTrusted(device)) && wasm.verify(device.ed25519, text, signature));
  }

  private async restoreSecrets(backup: BackupVersion, key: BackupKey): Promise<{ signed: boolean; settingsKeys: number }> {
    const { manager, settings, userId } = this.deps;
    await this.deps.deviceList.refresh([userId]);
    let signed = false;
    let settingsKeys = 0;
    // The master key first: it proves itself (its public key is the master key of the user), and it makes the other checks work.
    const names = Object.keys(backup.secrets).sort((a, b) => Number(b === MASTER_SECRET) - Number(a === MASTER_SECRET));
    for (const name of names) {
      const opened = this.readSecret(backup, key, name);
      if (!opened) {
        this.log(`The secret ${name} in the key backup could not be read.`);
        continue;
      }
      if (name === MASTER_SECRET) {
        signed = await manager.importMasterKey(opened.value);
        if (!signed) {
          this.log("The master key in the key backup is not the master key of this user.");
        }
        continue;
      }
      if (!name.startsWith(SETTINGS_SECRET_PREFIX) || !(await this.secretSignerOk(name, opened.value, opened.signer, opened.signature))) {
        this.log(`The secret ${name} in the key backup has no valid signature.`);
        continue;
      }
      if (await settings.importKey(name.slice(SETTINGS_SECRET_PREFIX.length), encodeBase64Url(opened.value))) {
        settingsKeys += 1;
      }
    }
    return { signed, settingsKeys };
  }

  private readSecret(
    backup: BackupVersion,
    key: BackupKey,
    name: string,
  ): { value: Uint8Array; signer: string; signature: string } | null {
    try {
      const plaintext = key.decrypt(decodeBase64Url(backup.secrets[name]!), secretAad(this.deps.userId, backup.version, name));
      const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
      const { value, signer, signature } = parsed;
      if (parsed.name !== name || typeof value !== "string" || typeof signer !== "string" || typeof signature !== "string") {
        return null;
      }
      return { value: decodeBase64Url(value), signer, signature };
    } catch {
      return null;
    }
  }

  private async restoreSessions(
    backup: BackupVersion,
    key: BackupKey,
    onProgress?: (progress: RestoreProgress) => void,
  ): Promise<RestoreProgress> {
    const { transport, megolm, userId } = this.deps;
    const progress: RestoreProgress = { imported: 0, failed: 0 };
    let after: string | undefined;
    for (;;) {
      const page = await transport.getBackupSessions({ version: backup.version, after, limit: DOWNLOAD_PAGE });
      for (const entry of page.sessions) {
        let content: Record<string, unknown> | null = null;
        try {
          const plaintext = key.decrypt(decodeBase64Url(entry.data), sessionAad(userId, backup.version, entry.sessionId));
          content = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
        } catch {
          content = null;
        }
        const ok =
          content !== null &&
          content.sessionId === entry.sessionId &&
          content.channelId === entry.channelId &&
          (await megolm.importBackedUpSession(content, backup.version));
        if (ok) {
          progress.imported += 1;
        } else {
          progress.failed += 1;
        }
      }
      onProgress?.({ ...progress });
      if (!page.next || this.stopped) {
        break;
      }
      after = page.next;
    }
    return progress;
  }
}
