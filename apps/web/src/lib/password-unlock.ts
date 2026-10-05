// The automatic steps of the security gate with the account password. A
// sign-in with the password keeps the wrap key in memory. Then a new device
// unlocks itself with the key wrap from the server, and a new account makes
// its key backup without a question. See docs/concepts/password-keys.md.
import { createStore } from "zustand/vanilla";
import { currentCrypto } from "./crypto.js";
import { session } from "./session.js";

export interface NewRecoveryKeyState {
  /** The recovery key of the automatic backup. The gate shows it one time. */
  recoveryKey: string | null;
  /** True until the backup and the key wrap are on the server. */
  saving: boolean;
  /** The problem of the last automatic backup, or null. */
  error: string | null;
  /**
   * True when this tab made the key backup. The crypto layer can learn of
   * the new backup some seconds later. Until then the gate uses this value.
   */
  backupMade: boolean;
}

export const newRecoveryKeyStore = createStore<NewRecoveryKeyState>(() => ({ recoveryKey: null, saving: false, error: null, backupMade: false }));

/**
 * The number of restores that run now. A restore signs this device before it
 * ends, and the device is then verified. The gate stays on the screen until
 * the restore and the key wrap are complete, so that a reload does not stop them.
 */
export const restoreBusyStore = createStore<{ count: number }>(() => ({ count: 0 }));

/** Run a restore. The gate stays on the screen while it runs. */
export async function whileRestoring<T>(action: () => Promise<T>): Promise<T> {
  restoreBusyStore.setState((state) => ({ count: state.count + 1 }));
  try {
    return await action();
  } finally {
    restoreBusyStore.setState((state) => ({ count: state.count - 1 }));
  }
}

/** One automatic unlock for each device. */
let unlockTry: { deviceId: string; result: Promise<boolean> } | null = null;
/** True while the automatic backup runs. */
let backupRuns = false;

session.store.subscribe((state, previous) => {
  if (state.status === "signedOut" && previous.status !== "signedOut") {
    unlockTry = null;
    newRecoveryKeyStore.setState({ recoveryKey: null, saving: false, error: null, backupMade: false });
  }
});

/** Store the recovery key in a key wrap when the wrap on the server is missing or old. A fault here does not stop the caller. */
export async function saveKeyWrap(recoveryKey: string): Promise<void> {
  try {
    await session.keys.saveRecoveryKey(recoveryKey);
  } catch (error) {
    console.warn("[crypto] The key wrap was not saved.", error);
  }
}

/**
 * Restore the key backup with the recovery key from the key wrap, opened
 * with the wrap key in memory. True when this device is verified after it.
 */
export function unlockWithWrapKey(): Promise<boolean> {
  const crypto = currentCrypto();
  if (!crypto || !session.keys.hasWrapKey()) {
    return Promise.resolve(false);
  }
  if (unlockTry?.deviceId !== crypto.deviceId) {
    const result = whileRestoring(async () => {
      const recoveryKey = await session.keys.storedRecoveryKey();
      return recoveryKey !== null && (await crypto.security.restoreBackup({ recoveryKey })).signed;
    }).catch((error: unknown) => {
      console.warn("[crypto] The automatic unlock failed.", error);
      return false;
    });
    unlockTry = { deviceId: crypto.deviceId, result };
  }
  return unlockTry.result;
}

/**
 * Make the key backup with a random recovery key, and store the key wrap.
 * The gate shows the recovery key while this runs.
 */
export async function createBackupWithPassword(): Promise<void> {
  const crypto = currentCrypto();
  if (!crypto || !session.keys.hasWrapKey() || backupRuns) {
    return;
  }
  backupRuns = true;
  try {
    const { recoveryKey, create } = await crypto.security.setUpBackup();
    newRecoveryKeyStore.setState({ recoveryKey, saving: true, error: null });
    await create();
    newRecoveryKeyStore.setState({ backupMade: true });
    await saveKeyWrap(recoveryKey);
    newRecoveryKeyStore.setState({ saving: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The key backup could not be made.";
    newRecoveryKeyStore.setState({ recoveryKey: null, saving: false, error: message });
  } finally {
    backupRuns = false;
  }
}
