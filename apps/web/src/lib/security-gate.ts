// The blocking security screens before the app (CRY-09). A device that
// holds the master key must have a key backup with a recovery key. A device
// that the master key did not sign must verify, restore or reset first.
import type { SecuritySnapshot } from "./crypto.js";

/** The result of the check of the key backup on the server. It stays "pending" after an error. */
export type BackupCheck = "pending" | "yes" | "no";

/** "save-key": make the backup. "show-key": show the recovery key of a new backup one time. "verify": verify this device. */
export type GateScreen = "none" | "save-key" | "show-key" | "verify";

/** The screen that blocks the app, or "none". `keyToShow`: a new recovery key waits for the user. */
export function gateScreen(security: SecuritySnapshot, check: BackupCheck, keyToShow = false): GateScreen {
  if (keyToShow) {
    return "show-key";
  }
  if (!security.ready) {
    return "none";
  }
  if (!security.deviceVerified) {
    return "verify";
  }
  // Until the check is complete, show the app. Thus the app does not close and open again when a backup exists.
  return security.holdsMasterKey && security.backup?.version == null && check === "no" ? "save-key" : "none";
}

/** True when the account has a key backup, so the recovery key can verify this device. */
export function backupExists(security: SecuritySnapshot, check: BackupCheck): boolean {
  return security.backup?.version != null || check !== "no";
}
