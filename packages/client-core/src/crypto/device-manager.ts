// The device manager: it sets up the keys of this device on the server
// and keeps the one-time keys and the fallback key topped up. It also
// makes the user master key when the user has none, and signs devices
// with it when this device holds it. See docs/concepts/olm-megolm.md
// sections 3 and 4.
import {
  deviceKeysSignedText,
  masterKeySignedText,
  oneTimeKeySignedText,
  type UploadKeysRequest,
  type UploadKeysResponse,
} from "@mortium/shared";
import type { AccountHolder } from "./account.js";
import type { DeviceList } from "./device-list.js";
import type { CryptoStore } from "./store.js";
import type { CryptoTransport } from "./transport.js";
import type { Wasm } from "./wasm.js";

const DEVICE_KEYS_UPLOADED_VALUE = "deviceKeysUploaded";
const MASTER_KEY_VALUE = "masterKey";

type SigningKey = InstanceType<Wasm["SigningKey"]>;

export interface DeviceManagerDeps {
  wasm: Wasm;
  store: CryptoStore;
  transport: CryptoTransport;
  account: AccountHolder;
  deviceList: DeviceList;
  pickleKey: Uint8Array;
  userId: string;
  deviceId: string;
}

export class DeviceManager {
  /** The server one-time key count as this device last knew it, less the keys used since. */
  private estimate: number | null = null;
  private checking: Promise<void> | null = null;

  constructor(private readonly deps: DeviceManagerDeps) {}

  /** The number of one-time keys that the server should keep. */
  get maxOneTimeKeys(): number {
    return this.deps.account.account.max_number_of_one_time_keys;
  }

  /** Upload the identity keys (first run only), make the master key if needed, and top up the keys. */
  async setup(): Promise<void> {
    const { store, transport, account, userId, deviceId } = this.deps;
    let counts: UploadKeysResponse | null = null;
    if (!(await store.getValue<boolean>(DEVICE_KEYS_UPLOADED_VALUE))) {
      const text = deviceKeysSignedText(userId, deviceId, account.curve25519, account.ed25519);
      counts = await transport.uploadKeys({
        deviceKeys: { curve25519: account.curve25519, ed25519: account.ed25519, signature: account.sign(text) },
      });
      await store.commit({ values: { [DEVICE_KEYS_UPLOADED_VALUE]: true } });
    }
    await this.ensureMasterKey();
    await this.topUp(counts ?? (await transport.uploadKeys({})));
    // Read the own device list again, so the trust state of this device is correct at once.
    await this.deps.deviceList.refresh([userId]);
  }

  /** Handle the counts from READY. */
  onKeyCounts(counts: UploadKeysResponse): Promise<void> {
    return this.topUp(counts);
  }

  /** Called after a pre-key message used a one-time key. Checks the server count when it may be low. */
  noteOneTimeKeyUsed(): void {
    if (this.estimate !== null) {
      this.estimate -= 1;
    }
    if (this.estimate === null || this.estimate <= this.maxOneTimeKeys / 2) {
      void this.check();
    }
  }

  /** Ask the server for the true count and top up. One check at a time. */
  check(): Promise<void> {
    this.checking ??= (async () => {
      try {
        await this.topUp(await this.deps.transport.uploadKeys({}));
      } finally {
        this.checking = null;
      }
    })();
    return this.checking;
  }

  /** Make and upload keys until the server has the maximum, and a fresh fallback key when it needs one. */
  private topUp(counts: UploadKeysResponse): Promise<void> {
    const { account, transport, userId, deviceId } = this.deps;
    return account.run(async (olmAccount) => {
      const max = olmAccount.max_number_of_one_time_keys;
      let pending = Object.keys(JSON.parse(olmAccount.one_time_keys()) as Record<string, string>).length;
      let changed = false;
      if (counts.oneTimeKeyCount < max / 2) {
        const missing = max - counts.oneTimeKeyCount - pending;
        if (missing > 0) {
          olmAccount.generate_one_time_keys(missing);
          pending += missing;
          changed = true;
        }
      }
      let fallback = JSON.parse(olmAccount.fallback_key()) as Record<string, string>;
      if (counts.needsFallbackKey && Object.keys(fallback).length === 0) {
        olmAccount.generate_fallback_key();
        fallback = JSON.parse(olmAccount.fallback_key()) as Record<string, string>;
        changed = true;
      }
      if (pending === 0 && Object.keys(fallback).length === 0) {
        this.estimate = counts.oneTimeKeyCount;
        return;
      }
      // Save the private keys before the upload, so a crash cannot lose keys that the server has.
      if (changed) {
        await account.save();
      }

      const body: UploadKeysRequest = {};
      const oneTimeKeys = JSON.parse(olmAccount.one_time_keys()) as Record<string, string>;
      if (Object.keys(oneTimeKeys).length > 0) {
        body.oneTimeKeys = {};
        for (const [keyId, key] of Object.entries(oneTimeKeys)) {
          const text = oneTimeKeySignedText("one_time_key", userId, deviceId, keyId, key);
          body.oneTimeKeys[keyId] = { key, signature: account.sign(text) };
        }
      }
      const [fallbackEntry] = Object.entries(fallback);
      if (fallbackEntry) {
        const [keyId, key] = fallbackEntry;
        const text = oneTimeKeySignedText("fallback_key", userId, deviceId, keyId, key);
        body.fallbackKey = { keyId, key, signature: account.sign(text) };
      }
      const result = await transport.uploadKeys(body);
      olmAccount.mark_keys_as_published();
      await account.save();
      this.estimate = result.oneTimeKeyCount;
    });
  }

  /** True when this device holds the master private key. */
  async hasMasterKey(): Promise<boolean> {
    return Boolean(await this.deps.store.getValue<string | null>(MASTER_KEY_VALUE));
  }

  /** Run `task` with the master key of this device, or return null when this device does not hold it. */
  private async withMasterKey<T>(task: (master: SigningKey) => Promise<T> | T): Promise<T | null> {
    const pickle = await this.deps.store.getValue<string | null>(MASTER_KEY_VALUE);
    if (!pickle) {
      return null;
    }
    const master = this.deps.wasm.SigningKey.from_pickle(pickle, this.deps.pickleKey);
    try {
      return await task(master);
    } finally {
      master.free();
    }
  }

  /** The 32 secret bytes of the master key, for the key backup, or null. */
  exportMasterSecret(): Promise<Uint8Array | null> {
    return this.withMasterKey((master) => master.export_secret());
  }

  /**
   * Sign a different device of this user with the master key. Call this
   * only after a verification of that device (SAS). Returns false when this
   * device does not hold the master key or does not know that device.
   */
  async signOwnDevice(deviceId: string): Promise<boolean> {
    const { deviceList, transport, userId } = this.deps;
    await deviceList.refresh([userId]);
    const device = (await deviceList.getDevices(userId)).find((entry) => entry.deviceId === deviceId);
    const user = await deviceList.getUser(userId);
    if (!device || !user?.masterKey || user.changedMasterKey !== null) {
      return false;
    }
    const signature = await this.withMasterKey((master) => {
      if (master.public_key !== user.masterKey) {
        return null;
      }
      return master.sign(deviceKeysSignedText(userId, deviceId, device.curve25519, device.ed25519));
    });
    if (!signature) {
      return false;
    }
    await transport.uploadSignature({ deviceId, signature });
    await deviceList.refresh([userId]);
    return true;
  }

  /**
   * Take the master key from the key backup. It must be the master key that
   * the server shows for this user and that this device trusts. Then this
   * device signs itself. Returns false when the key does not match.
   */
  async importMasterKey(secret: Uint8Array): Promise<boolean> {
    const { wasm, store, transport, account, deviceList, pickleKey, userId, deviceId } = this.deps;
    const master = wasm.SigningKey.from_secret(secret);
    try {
      const publicKey = master.public_key;
      await deviceList.refresh([userId]);
      const [own] = (await transport.queryKeys([userId])).users;
      const user = await deviceList.getUser(userId);
      if (own?.masterKey?.publicKey !== publicKey || (user?.masterKey && user.masterKey !== publicKey)) {
        return false;
      }
      await store.commit({ values: { [MASTER_KEY_VALUE]: master.pickle(pickleKey) } });
      // Sign this device, and vouch for the master key from this device. The device that vouched before can be gone.
      const text = deviceKeysSignedText(userId, deviceId, account.curve25519, account.ed25519);
      await transport.putMasterKey({
        publicKey,
        deviceSignature: account.sign(masterKeySignedText(userId, publicKey)),
        masterSignature: master.sign(text),
      });
      await deviceList.trustOwnMasterKey(userId, publicKey);
      await deviceList.refresh([userId]);
      return true;
    } finally {
      master.free();
    }
  }

  /**
   * Make a new master key for a user who lost the old one. The server
   * needs the account password. The other devices of the user lose their
   * signature, and other users see an identity change.
   */
  async resetMasterKey(password: string): Promise<void> {
    const { wasm, store, transport, account, deviceList, pickleKey, userId, deviceId } = this.deps;
    const master = new wasm.SigningKey();
    try {
      const publicKey = master.public_key;
      await transport.resetMasterKey({
        publicKey,
        deviceSignature: account.sign(masterKeySignedText(userId, publicKey)),
        masterSignature: master.sign(deviceKeysSignedText(userId, deviceId, account.curve25519, account.ed25519)),
        password,
      });
      await store.commit({ values: { [MASTER_KEY_VALUE]: master.pickle(pickleKey) } });
      await deviceList.trustOwnMasterKey(userId, publicKey);
      await deviceList.refresh([userId]);
    } finally {
      master.free();
    }
  }

  /** Sign a text with the master key, or return null when this device does not hold it. */
  signWithMasterKey(text: string): Promise<string | null> {
    return this.withMasterKey((master) => master.sign(text));
  }

  /**
   * Make the master key when the user has none: this device then holds the
   * private key and signs itself. When the user already has a master key
   * from a different device, this device stays unsigned in this pass.
   * When this device holds the master key and the device that vouches for
   * it on the server is gone, this device vouches for it again.
   */
  private async ensureMasterKey(): Promise<void> {
    const { wasm, store, transport, account, deviceList, pickleKey, userId, deviceId } = this.deps;
    const [own] = (await transport.queryKeys([userId])).users;
    const serverKey = own?.masterKey?.publicKey ?? null;
    const pickle = await store.getValue<string | null>(MASTER_KEY_VALUE);

    let master = pickle ? wasm.SigningKey.from_pickle(pickle, pickleKey) : null;
    try {
      if (!master && serverKey === null) {
        master = new wasm.SigningKey();
        // Save first: a key that the server accepts must never be lost.
        await store.commit({ values: { [MASTER_KEY_VALUE]: master.pickle(pickleKey) } });
      }
      if (!master) {
        return;
      }
      const publicKey = master.public_key;
      if (serverKey !== null && serverKey !== publicKey) {
        return;
      }
      const ownDevice = own?.devices.find((device) => device.deviceId === deviceId);
      const voucherListed = own?.devices.some((device) => device.deviceId === own.masterKey?.deviceId) ?? false;
      if (serverKey === publicKey && ownDevice?.masterSignature && voucherListed) {
        await deviceList.trustOwnMasterKey(userId, publicKey);
        return;
      }
      const deviceText = deviceKeysSignedText(userId, deviceId, account.curve25519, account.ed25519);
      try {
        await transport.putMasterKey({
          publicKey,
          deviceSignature: account.sign(masterKeySignedText(userId, publicKey)),
          masterSignature: master.sign(deviceText),
        });
      } catch (error) {
        if ((error as { code?: string }).code === "MASTER_KEY_EXISTS") {
          // A different device of this user was first. Forget our key.
          await store.commit({ values: { [MASTER_KEY_VALUE]: null } });
          return;
        }
        throw error;
      }
      await deviceList.trustOwnMasterKey(userId, publicKey);
    } finally {
      master?.free();
    }
  }
}
