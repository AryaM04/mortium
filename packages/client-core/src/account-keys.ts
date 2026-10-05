// The account password on this device. The client derives an auth key from
// the password and sends it in place of the password. The wrap key, which
// also comes from the password, encrypts the recovery key of the key
// backup (the key wrap). Then a sign-in with the password unlocks the
// messages on a new device. The wrap key stays in the memory of this tab
// only. See docs/concepts/password-keys.md.
import {
  getBackupVersionResponseSchema,
  getKeyWrapResponseSchema,
  preloginResponseSchema,
  type KeyWrap,
  type PreloginResponse,
} from "@mortium/shared";
import type { ApiClient } from "./api.js";
import type { PasswordKeys } from "./crypto/password-keys.js";

export type { PasswordKeys } from "./crypto/password-keys.js";

/** The key derivation needs the crypto WASM. Load it only when the app uses a password. */
function passwordKeysModule() {
  return import("./crypto/password-keys.js");
}

/** The password does not open the key wrap. */
export class WrongPasswordError extends Error {
  constructor() {
    super("This password does not unlock your encryption keys.");
    this.name = "WrongPasswordError";
  }
}

export function prelogin(apiClient: ApiClient, email: string): Promise<PreloginResponse> {
  return apiClient.request("POST", "/auth/prelogin", { body: { email }, schema: preloginResponseSchema, skipAuth: true });
}

/** Derive the keys of a new password with a new salt. */
export async function newPasswordKeys(password: string): Promise<PasswordKeys> {
  const { derivePasswordKeys, newKdfSalt } = await passwordKeysModule();
  return derivePasswordKeys(password, newKdfSalt());
}

/** Derive the keys of a password with a known salt. */
export async function derivePasswordKeys(password: string, kdfSalt: string): Promise<PasswordKeys> {
  const module = await passwordKeysModule();
  return module.derivePasswordKeys(password, kdfSalt);
}

/** Give a legacy account (its hash is of the password) a password key. The session must be signed in. */
export async function upgradeLegacyPassword(apiClient: ApiClient, password: string): Promise<PasswordKeys> {
  const keys = await newPasswordKeys(password);
  await apiClient.request("POST", "/auth/password/upgrade", {
    body: { password, authKey: keys.authKey, kdfSalt: keys.kdfSalt, kdfVersion: 1 },
  });
  return keys;
}

export interface AccountKeys {
  /** True when this tab holds the wrap key of the password. */
  hasWrapKey(): boolean;
  /** Keep the keys of a sign-in in memory, or forget them (null). */
  hold(keys: PasswordKeys | null): void;
  /** The recovery key from the key wrap on the server, opened with the wrap key in memory. Null when that is not possible. */
  storedRecoveryKey(): Promise<string | null>;
  /** True when the server has a key wrap for the current key backup. */
  hasCurrentKeyWrap(): Promise<boolean>;
  /** Open the key wrap with the password. Throws `WrongPasswordError`. Keeps the wrap key. */
  unlockWithPassword(password: string): Promise<string>;
  /** Put the recovery key in a new key wrap, when the wrap on the server is missing or for an older backup. */
  saveRecoveryKey(recoveryKey: string): Promise<void>;
  /** Run an action that needs the auth key of the password. After a success, keep the wrap key. */
  withAuthKey<T>(password: string, action: (authKey: string) => Promise<T>): Promise<T>;
  /** Change the password. The key wrap gets the new wrap key. */
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
}

export function createAccountKeys(
  apiClient: ApiClient,
  currentUser: () => { id: string; email?: string } | null,
): AccountKeys {
  let held: PasswordKeys | null = null;

  function user(): { id: string; email: string } {
    const current = currentUser();
    if (!current?.email) {
      throw new Error("The account is not known. Sign in again.");
    }
    return { id: current.id, email: current.email };
  }

  /** The keys of the password of the signed-in account. A legacy account gets its password key first. */
  async function signedInKeys(password: string): Promise<PasswordKeys> {
    const answer = await prelogin(apiClient, user().email);
    if (answer.kdf === "legacy") {
      return upgradeLegacyPassword(apiClient, password);
    }
    return derivePasswordKeys(password, answer.salt);
  }

  async function getKeyWrap(): Promise<KeyWrap | null> {
    return (await apiClient.request("GET", "/auth/key-wrap", { schema: getKeyWrapResponseSchema })).keyWrap;
  }

  async function backupVersion(): Promise<number | null> {
    const response = await apiClient.request("GET", "/keys/backup/version", { schema: getBackupVersionResponseSchema });
    return response.backup?.version ?? null;
  }

  /** The recovery key of the current backup from the key wrap, or null. */
  async function openWrap(keys: PasswordKeys): Promise<string | null> {
    const [wrap, version] = await Promise.all([getKeyWrap(), backupVersion()]);
    if (!wrap || wrap.version !== version) {
      return null;
    }
    const { unwrapRecoveryKey } = await passwordKeysModule();
    return unwrapRecoveryKey(keys.wrapKey, wrap.data, user().id, wrap.version);
  }

  return {
    hasWrapKey: () => held !== null,
    hold(keys) {
      held = keys;
    },
    async storedRecoveryKey() {
      return held ? openWrap(held) : null;
    },
    async hasCurrentKeyWrap() {
      const [wrap, version] = await Promise.all([getKeyWrap(), backupVersion()]);
      return wrap !== null && wrap.version === version;
    },
    async unlockWithPassword(password) {
      const keys = await signedInKeys(password);
      const recoveryKey = await openWrap(keys);
      if (!recoveryKey) {
        throw new WrongPasswordError();
      }
      held = keys;
      return recoveryKey;
    },
    async saveRecoveryKey(recoveryKey) {
      const keys = held;
      if (!keys) {
        return;
      }
      const [wrap, version] = await Promise.all([getKeyWrap(), backupVersion()]);
      if (version === null || (wrap && wrap.version >= version)) {
        return;
      }
      const { wrapRecoveryKey } = await passwordKeysModule();
      const data = await wrapRecoveryKey(keys.wrapKey, recoveryKey, user().id, version);
      await apiClient.request("PUT", "/auth/key-wrap", { body: { version, data, kdfSalt: keys.kdfSalt } });
    },
    async withAuthKey(password, action) {
      const keys = await signedInKeys(password);
      const result = await action(keys.authKey);
      // The server accepted the auth key, so the password is correct.
      held = keys;
      return result;
    },
    async changePassword(currentPassword, newPassword) {
      const { id } = user();
      const current = await signedInKeys(currentPassword);
      const next = await newPasswordKeys(newPassword);
      // Open the key wrap with the current password, and encrypt the recovery key again with the new password.
      const wrap = await getKeyWrap();
      let keyWrap: KeyWrap | null = null;
      if (wrap) {
        const { unwrapRecoveryKey, wrapRecoveryKey } = await passwordKeysModule();
        const recoveryKey = await unwrapRecoveryKey(current.wrapKey, wrap.data, id, wrap.version);
        if (recoveryKey) {
          keyWrap = { version: wrap.version, data: await wrapRecoveryKey(next.wrapKey, recoveryKey, id, wrap.version) };
        }
      }
      await apiClient.request("POST", "/auth/password/change", {
        body: { currentAuthKey: current.authKey, authKey: next.authKey, kdfSalt: next.kdfSalt, kdfVersion: 1, keyWrap },
      });
      held = next;
    },
  };
}
