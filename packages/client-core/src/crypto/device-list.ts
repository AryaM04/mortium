// The device list cache. It fetches device keys with /keys/query, checks
// every signature, keeps the first master key of each user (trust on first
// use) and flags a later change. The client never trusts the server for
// keys: a device with a bad signature is dropped. See
// docs/concepts/olm-megolm.md section 4.
import { deviceKeysSignedText, masterKeySignedText, type QueriedUser } from "@mortium/shared";
import type { KeyedQueue } from "./queue.js";
import type { CryptoStore, DeviceRecord, UserRecord } from "./store.js";
import type { CryptoTransport } from "./transport.js";
import type { Wasm } from "./wasm.js";

const REFRESH_QUEUE = "device-list";
const MAX_QUERY_USERS = 500;
/** Do not query a user again for an unknown device more often than this. */
const MISSING_DEVICE_RETRY_MS = 10_000;

export interface DeviceListDeps {
  store: CryptoStore;
  transport: CryptoTransport;
  wasm: Wasm;
  queue: KeyedQueue;
  /** Called when the server shows a master key that differs from the trusted one. */
  onMasterKeyChanged?: (userId: string) => void;
  /** Called after the devices or the master key state of a user changed. */
  onUserChanged?: (userId: string) => void;
  now?: () => number;
}

function newUser(userId: string): UserRecord {
  return { userId, tracked: false, outdated: true, masterKey: null, changedMasterKey: null };
}

export class DeviceList {
  private readonly lastMissingFetch = new Map<string, number>();

  constructor(private readonly deps: DeviceListDeps) {}

  /** Start to track users. A new user is fetched before its next use. */
  async trackUsers(userIds: string[]): Promise<void> {
    for (const userId of new Set(userIds)) {
      const user = await this.deps.store.getUser(userId);
      if (!user?.tracked) {
        await this.deps.store.putUser({ ...(user ?? newUser(userId)), tracked: true, outdated: true });
      }
    }
  }

  /** Handle DEVICE_LIST_UPDATE: the next use of this user fetches again. */
  markOutdated(userId: string): Promise<void> {
    // In the refresh queue, so a fetch that started before the update cannot clear the flag.
    return this.deps.queue.run(REFRESH_QUEUE, async () => {
      const user = await this.deps.store.getUser(userId);
      if (user && !user.outdated) {
        await this.deps.store.putUser({ ...user, outdated: true });
      }
    });
  }

  /**
   * Handle a new READY: the device lists can have changed while this device
   * was offline, so the next use of each tracked user fetches again.
   */
  markAllOutdated(): Promise<void> {
    return this.deps.queue.run(REFRESH_QUEUE, async () => {
      for (const user of await this.deps.store.getUsers()) {
        if (user.tracked && !user.outdated) {
          await this.deps.store.putUser({ ...user, outdated: true });
        }
      }
    });
  }

  /** Fetch every tracked user that is outdated. */
  async refreshOutdated(): Promise<void> {
    const users = await this.deps.store.getUsers();
    const outdated = users.filter((user) => user.tracked && user.outdated).map((user) => user.userId);
    if (outdated.length > 0) {
      await this.refresh(outdated);
    }
  }

  /** Fetch these users now and replace their cached devices. */
  refresh(userIds: string[]): Promise<void> {
    return this.deps.queue.run(REFRESH_QUEUE, async () => {
      for (let start = 0; start < userIds.length; start += MAX_QUERY_USERS) {
        const batch = userIds.slice(start, start + MAX_QUERY_USERS);
        const response = await this.deps.transport.queryKeys(batch);
        for (const userId of batch) {
          const queried = response.users.find((user) => user.userId === userId);
          await this.apply(userId, queried);
        }
      }
    });
  }

  /** The verified devices of a user. It fetches first when the cache is outdated. */
  async getDevices(userId: string): Promise<DeviceRecord[]> {
    const user = await this.deps.store.getUser(userId);
    if (!user || user.outdated) {
      await this.trackUsers([userId]);
      await this.refresh([userId]);
    }
    return this.deps.store.getDevices(userId);
  }

  /** The verified devices of many users. It fetches the new and outdated users in one query. */
  async getDevicesOfUsers(userIds: string[]): Promise<Map<string, DeviceRecord[]>> {
    const unique = [...new Set(userIds)];
    const stale: string[] = [];
    for (const userId of unique) {
      const user = await this.deps.store.getUser(userId);
      if (!user || user.outdated) {
        stale.push(userId);
      }
    }
    if (stale.length > 0) {
      await this.trackUsers(stale);
      await this.refresh(stale);
    }
    const result = new Map<string, DeviceRecord[]>();
    for (const userId of unique) {
      result.set(userId, await this.deps.store.getDevices(userId));
    }
    return result;
  }

  /**
   * The devices that may get keys: the master key of the user signed them,
   * and the master key did not change since this device trusted it. It
   * fetches the new and outdated users first. See docs/concepts/olm-megolm.md section 4.
   */
  async trustedDevicesOfUsers(userIds: string[]): Promise<Map<string, DeviceRecord[]>> {
    const result = await this.getDevicesOfUsers(userIds);
    for (const [userId, devices] of result) {
      const user = await this.deps.store.getUser(userId);
      result.set(userId, user && user.changedMasterKey === null ? devices.filter((device) => device.ownerVerified) : []);
    }
    return result;
  }

  /** True when `device` may get keys (see `trustedDevicesOfUsers`). */
  async isTrusted(device: DeviceRecord): Promise<boolean> {
    const user = await this.deps.store.getUser(device.userId);
    return device.ownerVerified && user !== undefined && user.changedMasterKey === null;
  }

  /** One verified device. When it is not known, it fetches the user again (at most one time in 10 s). */
  async getDevice(userId: string, deviceId: string): Promise<DeviceRecord | undefined> {
    const devices = await this.getDevices(userId);
    const found = devices.find((device) => device.deviceId === deviceId);
    if (found) {
      return found;
    }
    const now = (this.deps.now ?? Date.now)();
    const key = `${userId}:${deviceId}`;
    if (now - (this.lastMissingFetch.get(key) ?? 0) < MISSING_DEVICE_RETRY_MS) {
      return undefined;
    }
    this.lastMissingFetch.set(key, now);
    await this.refresh([userId]);
    return (await this.deps.store.getDevices(userId)).find((device) => device.deviceId === deviceId);
  }

  getUser(userId: string): Promise<UserRecord | undefined> {
    return this.deps.store.getUser(userId);
  }

  /** Users whose master key changed and who still need a user decision. */
  async changedMasterKeys(): Promise<string[]> {
    return (await this.deps.store.getUsers()).filter((user) => user.changedMasterKey).map((user) => user.userId);
  }

  /** The user accepted the new master key of `userId`. Devices are checked again against it. */
  async acceptMasterKeyChange(userId: string): Promise<void> {
    const user = await this.deps.store.getUser(userId);
    if (!user?.changedMasterKey) {
      return;
    }
    await this.deps.store.putUser({
      ...user,
      masterKey: user.changedMasterKey,
      changedMasterKey: null,
      verifiedMasterKey: null,
      outdated: true,
    });
    await this.refresh([userId]);
  }

  /**
   * A SAS verification confirmed `publicKey` as the master key of `userId`.
   * When it is the new key of an identity change, the change is accepted.
   * Returns false when the key is neither the trusted key nor the new key.
   */
  async markMasterKeyVerified(userId: string, publicKey: string): Promise<boolean> {
    const user = await this.deps.store.getUser(userId);
    if (!user || (user.masterKey !== publicKey && user.changedMasterKey !== publicKey)) {
      return false;
    }
    await this.deps.store.putUser({ ...user, masterKey: publicKey, changedMasterKey: null, verifiedMasterKey: publicKey, outdated: true });
    await this.refresh([userId]);
    return true;
  }

  /**
   * Trust this master key for our own user. Only a device that holds the
   * private key calls this: the device that made the key, a device that got
   * it from the key backup, or a device after a master key reset.
   */
  trustOwnMasterKey(userId: string, publicKey: string): Promise<void> {
    // In the refresh queue, so a fetch at the same time cannot write the old key back.
    return this.deps.queue.run(REFRESH_QUEUE, async () => {
      const user = (await this.deps.store.getUser(userId)) ?? newUser(userId);
      await this.deps.store.putUser({
        ...user,
        tracked: true,
        outdated: true,
        masterKey: publicKey,
        changedMasterKey: null,
        verifiedMasterKey: publicKey,
      });
      this.deps.onUserChanged?.(userId);
    });
  }

  private verify(publicKey: string, text: string, signature: string): boolean {
    return this.deps.wasm.verify(publicKey, text, signature);
  }

  private async apply(userId: string, queried: QueriedUser | undefined): Promise<void> {
    const { store } = this.deps;
    const user = (await store.getUser(userId)) ?? newUser(userId);
    const known = await store.getDevices(userId);

    const checked = (queried?.devices ?? []).filter((device) => {
      const text = deviceKeysSignedText(userId, device.deviceId, device.curve25519, device.ed25519);
      if (!this.verify(device.ed25519, text, device.signature)) {
        return false;
      }
      // Identity keys never change. A known device id with new keys is not accepted.
      const old = known.find((entry) => entry.deviceId === device.deviceId);
      return !old || (old.curve25519 === device.curve25519 && old.ed25519 === device.ed25519);
    });

    // A master key counts only when a listed device of the user vouches for it: the
    // device signed the key, or the key signed the device. The second case keeps the
    // key when the device that made it was removed.
    let serverMaster: string | null = null;
    if (queried?.masterKey) {
      const { publicKey, deviceId, deviceSignature } = queried.masterKey;
      const voucher = checked.find((device) => device.deviceId === deviceId);
      const vouched =
        (voucher !== undefined && this.verify(voucher.ed25519, masterKeySignedText(userId, publicKey), deviceSignature)) ||
        checked.some(
          (device) =>
            device.masterSignature !== null &&
            this.verify(
              publicKey,
              deviceKeysSignedText(userId, device.deviceId, device.curve25519, device.ed25519),
              device.masterSignature,
            ),
        );
      if (vouched) {
        serverMaster = publicKey;
      }
    }

    let masterKey = user.masterKey;
    let changedMasterKey = user.changedMasterKey;
    if (serverMaster !== null) {
      if (masterKey === null) {
        masterKey = serverMaster;
        changedMasterKey = null;
      } else {
        changedMasterKey = serverMaster === masterKey ? null : serverMaster;
      }
    }

    const devices: DeviceRecord[] = checked.map((device) => ({
      userId,
      deviceId: device.deviceId,
      curve25519: device.curve25519,
      ed25519: device.ed25519,
      ownerVerified:
        masterKey !== null &&
        device.masterSignature !== null &&
        this.verify(
          masterKey,
          deviceKeysSignedText(userId, device.deviceId, device.curve25519, device.ed25519),
          device.masterSignature,
        ),
    }));

    const next: UserRecord = { ...user, outdated: false, masterKey, changedMasterKey };
    await store.replaceDevices(next, devices);
    if (changedMasterKey !== null && changedMasterKey !== user.changedMasterKey) {
      this.deps.onMasterKeyChanged?.(userId);
    }
    this.deps.onUserChanged?.(userId);
  }
}
