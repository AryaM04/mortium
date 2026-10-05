import { describe, expect, it } from "vitest";
import type { SecuritySnapshot } from "./crypto.js";
import { backupExists, gateScreen } from "./security-gate.js";

function snapshot(change: Partial<SecuritySnapshot> = {}, version: number | null = null): SecuritySnapshot {
  return {
    ready: true,
    deviceVerified: true,
    holdsMasterKey: true,
    backup: { version, trusted: version !== null, hasPassphrase: false, uploading: false, error: null },
    changedUsers: [],
    verifications: [],
    ...change,
  };
}

describe("gateScreen", () => {
  it("shows the app before the crypto layer is ready", () => {
    expect(gateScreen(snapshot({ ready: false, deviceVerified: false }), "no")).toBe("none");
  });

  it("asks a device with the master key and no backup to save a recovery key", () => {
    expect(gateScreen(snapshot(), "no")).toBe("save-key");
    // Until the server answers, the app stays. A backup on the server skips the screen.
    expect(gateScreen(snapshot(), "pending")).toBe("none");
    expect(gateScreen(snapshot(), "yes")).toBe("none");
    expect(gateScreen(snapshot({}, 3), "no")).toBe("none");
  });

  it("shows a new recovery key until the user continues, also after the backup exists", () => {
    expect(gateScreen(snapshot({}, 3), "yes", true)).toBe("show-key");
    expect(gateScreen(snapshot({}, 3), "yes", false)).toBe("none");
  });

  it("does not ask a verified device without the master key for a backup", () => {
    expect(gateScreen(snapshot({ holdsMasterKey: false }), "no")).toBe("none");
  });

  it("asks a device that is not verified to verify, with or without a backup", () => {
    const device = snapshot({ deviceVerified: false, holdsMasterKey: false });
    expect(gateScreen(device, "yes")).toBe("verify");
    expect(gateScreen(device, "no")).toBe("verify");
    expect(backupExists(device, "yes")).toBe(true);
    expect(backupExists(device, "pending")).toBe(true);
    expect(backupExists(device, "no")).toBe(false);
  });
});
