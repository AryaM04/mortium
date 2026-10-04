// The settings key: one AES-256-GCM key for each user. It encrypts the
// synced settings blob. The first device that saves settings makes the key
// and shares it with the other devices of the same user through Olm
// (`settings.key`). A device without the key asks for it
// (`settings.request`). See docs/concepts/olm-megolm.md section 11.
import { decodeBase64Url, encodeBase64Url } from "@mortium/shared";
import type { DeviceList } from "./device-list.js";
import type { DecryptedToDevice, EncryptResult } from "./olm-machine.js";
import type { CryptoStore } from "./store.js";

export const SETTINGS_KEY_TYPE = "settings.key";
export const SETTINGS_REQUEST_TYPE = "settings.request";

/** The first byte of an encrypted blob. An old plaintext blob starts with "{". */
const BLOB_VERSION = 1;
const KEY_ID_BYTES = 8;
const IV_BYTES = 12;
const HEADER_BYTES = 1 + KEY_ID_BYTES;
const KEYS_VALUE = "settingsKeys";
/** Ask again for a missing key at most this often. */
const REQUEST_INTERVAL_MS = 60_000;
/** Answer one device for one key at most this often. */
const ANSWER_INTERVAL_MS = 30_000;
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The blob uses a key that this device does not have. The device asked its other devices for it. */
export class SettingsKeyMissingError extends Error {
  constructor(readonly keyId: string) {
    super("The settings key is not on this device yet.");
    this.name = "SettingsKeyMissingError";
  }
}

function bytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  return value as Uint8Array<ArrayBuffer>;
}

async function aesKey(raw: Uint8Array, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", bytes(raw), "AES-GCM", false, usage);
}

/** The key id of an encrypted blob, or null for an old plaintext blob. */
export function settingsKeyIdOf(blob: Uint8Array): string | null {
  if (blob[0] !== BLOB_VERSION || blob.length < HEADER_BYTES + IV_BYTES) {
    return null;
  }
  return encodeBase64Url(blob.subarray(1, HEADER_BYTES));
}

/** Encrypt settings: version byte, key id, IV, then AES-GCM. The header is the additional data. */
export async function sealSettings(key: Uint8Array, keyId: string, plaintext: Uint8Array): Promise<Uint8Array> {
  const header = new Uint8Array(HEADER_BYTES);
  header[0] = BLOB_VERSION;
  header.set(decodeBase64Url(keyId), 1);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: header }, await aesKey(key, ["encrypt"]), bytes(plaintext)),
  );
  const blob = new Uint8Array(HEADER_BYTES + IV_BYTES + ciphertext.length);
  blob.set(header);
  blob.set(iv, HEADER_BYTES);
  blob.set(ciphertext, HEADER_BYTES + IV_BYTES);
  return blob;
}

export async function openSettings(key: Uint8Array, blob: Uint8Array): Promise<Uint8Array> {
  const header = bytes(blob.slice(0, HEADER_BYTES));
  const iv = bytes(blob.slice(HEADER_BYTES, HEADER_BYTES + IV_BYTES));
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: header },
      await aesKey(key, ["decrypt"]),
      bytes(blob.subarray(HEADER_BYTES + IV_BYTES)),
    ),
  );
}

export interface SettingsKeysDeps {
  store: CryptoStore;
  /** Encrypts the stored keys, so a copy of the IndexedDB files does not give them. */
  pickleKey: Uint8Array;
  deviceList: DeviceList;
  encryptToDevices(targets: Array<{ userId: string; deviceId: string }>, type: string, content: Record<string, unknown>): Promise<EncryptResult>;
  userId: string;
  deviceId: string;
  now?: () => number;
  log?: (message: string) => void;
}

export class SettingsKeys {
  /** Key id to raw key, as base64url. */
  private keys: Record<string, string> | null = null;
  private readonly listeners = new Set<(keyId: string) => void>();
  private readonly lastRequest = new Map<string, number>();
  private readonly lastAnswer = new Map<string, number>();

  constructor(private readonly deps: SettingsKeysDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private async load(): Promise<Record<string, string>> {
    if (this.keys) {
      return this.keys;
    }
    const stored = await this.deps.store.getValue<{ iv: string; data: string }>(KEYS_VALUE);
    let keys: Record<string, string> = {};
    if (stored) {
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes(decodeBase64Url(stored.iv)) },
        await aesKey(this.deps.pickleKey, ["decrypt"]),
        bytes(decodeBase64Url(stored.data)),
      );
      keys = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, string>;
    }
    this.keys ??= keys;
    return this.keys;
  }

  private async save(keyId: string, key: string): Promise<void> {
    const keys = { ...(await this.load()), [keyId]: key };
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const data = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await aesKey(this.deps.pickleKey, ["encrypt"]),
      new TextEncoder().encode(JSON.stringify(keys)),
    );
    await this.deps.store.commit({ values: { [KEYS_VALUE]: { iv: encodeBase64Url(iv), data: encodeBase64Url(new Uint8Array(data)) } } });
    this.keys = keys;
  }

  /** Watch the arrival of keys. Returns a function that stops the watch. */
  onKey(listener: (keyId: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * The other devices of this user that the master key signed. None when the
   * master key of the user changed.
   */
  private async ownDevices(): Promise<Array<{ userId: string; deviceId: string }>> {
    const { userId, deviceId } = this.deps;
    const devices = (await this.deps.deviceList.trustedDevicesOfUsers([userId])).get(userId) ?? [];
    return devices
      .filter((device) => device.deviceId !== deviceId)
      .map((device) => ({ userId: device.userId, deviceId: device.deviceId }));
  }

  /** Every settings key of this device: key id to raw key, as base64url. For the key backup. */
  async allKeys(): Promise<Record<string, string>> {
    return { ...(await this.load()) };
  }

  /**
   * Add a key from the key backup. A known key id never gets a different
   * value. Returns true when the key is new.
   */
  async importKey(keyId: string, key: string): Promise<boolean> {
    if (!KEY_ID_PATTERN.test(keyId) || !KEY_PATTERN.test(key)) {
      return false;
    }
    const known = (await this.load())[keyId];
    if (known) {
      return false;
    }
    await this.save(keyId, key);
    for (const listener of this.listeners) {
      listener(keyId);
    }
    return true;
  }

  /**
   * Decrypt a settings blob. A null blob gives null. An old plaintext blob
   * gives its bytes and a null key id. A missing key throws
   * `SettingsKeyMissingError` after the device asks for it.
   */
  async open(blob: Uint8Array | null): Promise<{ plaintext: Uint8Array | null; keyId: string | null }> {
    if (!blob) {
      return { plaintext: null, keyId: null };
    }
    const keyId = settingsKeyIdOf(blob);
    if (keyId === null) {
      return { plaintext: blob, keyId: null };
    }
    const key = (await this.load())[keyId];
    if (!key) {
      void this.request(keyId);
      throw new SettingsKeyMissingError(keyId);
    }
    return { plaintext: await openSettings(decodeBase64Url(key), blob), keyId };
  }

  /** Encrypt settings with the key `keyId`. With a null key id, make a new key and share it with the other devices first. */
  async seal(plaintext: Uint8Array, keyId: string | null): Promise<{ blob: Uint8Array; keyId: string }> {
    let id = keyId;
    let key = id ? (await this.load())[id] : undefined;
    if (!id || !key) {
      id = encodeBase64Url(crypto.getRandomValues(new Uint8Array(KEY_ID_BYTES)));
      key = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
      await this.save(id, key);
      await this.deps.encryptToDevices(await this.ownDevices(), SETTINGS_KEY_TYPE, { keyId: id, key });
    }
    return { blob: await sealSettings(decodeBase64Url(key), id, plaintext), keyId: id };
  }

  /** Ask the other devices of this user for a key. At most one time a minute for each key. */
  async request(keyId: string): Promise<void> {
    const last = this.lastRequest.get(keyId);
    if (last !== undefined && this.now() - last < REQUEST_INTERVAL_MS) {
      return;
    }
    this.lastRequest.set(keyId, this.now());
    try {
      await this.deps.encryptToDevices(await this.ownDevices(), SETTINGS_REQUEST_TYPE, { keyId });
    } catch (error) {
      this.deps.log?.(`The settings key could not be requested: ${String(error)}`);
    }
  }

  /** Ask again for each key that this device asked for and did not get. Call it when this device becomes verified. */
  async retryRequests(): Promise<void> {
    const known = await this.load();
    const missing = [...this.lastRequest.keys()].filter((keyId) => !known[keyId]);
    for (const keyId of missing) {
      this.lastRequest.delete(keyId);
      await this.request(keyId);
    }
  }

  /** Handle `settings.key` and `settings.request` envelopes. Only devices of this user count. */
  async handleToDevice(event: DecryptedToDevice): Promise<void> {
    if (event.type !== SETTINGS_KEY_TYPE && event.type !== SETTINGS_REQUEST_TYPE) {
      return;
    }
    if (event.sender.userId !== this.deps.userId) {
      this.deps.log?.(`A different user sent ${event.type}. It was dropped.`);
      return;
    }
    // A device that the master key did not sign can be a device that the server added.
    if (!(await this.deps.deviceList.isTrusted(event.sender))) {
      this.deps.log?.(`Device ${event.sender.deviceId} sent ${event.type}, but it is not verified. It was dropped.`);
      return;
    }
    const { keyId, key } = event.content;
    if (typeof keyId !== "string" || !KEY_ID_PATTERN.test(keyId)) {
      return;
    }
    if (event.type === SETTINGS_KEY_TYPE) {
      if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
        return;
      }
      const known = (await this.load())[keyId];
      if (known === key) {
        return;
      }
      if (known) {
        this.deps.log?.("A settings key arrived with a known id and a different value. It was dropped.");
        return;
      }
      await this.save(keyId, key);
      for (const listener of this.listeners) {
        listener(keyId);
      }
      return;
    }
    const known = (await this.load())[keyId];
    const answerKey = `${event.sender.deviceId}:${keyId}`;
    const last = this.lastAnswer.get(answerKey);
    if (!known || (last !== undefined && this.now() - last < ANSWER_INTERVAL_MS)) {
      return;
    }
    this.lastAnswer.set(answerKey, this.now());
    await this.deps.encryptToDevices([{ userId: event.sender.userId, deviceId: event.sender.deviceId }], SETTINGS_KEY_TYPE, {
      keyId,
      key: known,
    });
  }
}
