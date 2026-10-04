// The blocking security screens before the app (CRY-09). "save-key": a
// device that holds the master key makes the key backup and saves the
// recovery key. "verify": a new device verifies with a different device,
// or restores with the recovery key. An account without a backup can reset
// the identity, and then makes the backup. There is no way to skip. It
// loads only when it shows. See docs/concepts/olm-megolm.md sections 9 and 10.
import { Suspense, lazy, useState } from "react";
import { useStore } from "zustand";
import { currentCrypto, securityStore } from "../lib/crypto.js";
import { describeError } from "../lib/errors.js";
import { session } from "../lib/session.js";
import type { GateScreen } from "../lib/security-gate.js";
import { AuthLayout } from "./AuthLayout.js";
import { BackupSetup, ResetIdentity, Restore } from "./SecurityDialog.js";

const VerificationDialog = lazy(() => import("./VerificationDialog.js"));

const button = "rounded px-3 py-2 text-sm";
const primary = { backgroundColor: "var(--color-accent)", color: "white" };

function Part({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <h2 className="mb-2 text-sm font-semibold uppercase" style={{ color: "var(--color-text-muted)" }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function VerifyScreen({ hasBackup }: { hasBackup: boolean }) {
  const [error, setError] = useState<string | null>(null);

  async function verify() {
    setError(null);
    try {
      await currentCrypto()!.verification.requestOwnDevices();
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <AuthLayout title="Verify this device">
      <p className="mb-4 text-sm">
        Your messages are encrypted. Verify this device before you continue. Until then, it cannot read your messages.
      </p>
      <Part title="Verify with another device">
        <p className="mb-2 text-sm">Use a device where you are signed in. Compare the emojis on both devices.</p>
        <button type="button" className={button} style={primary} onClick={() => void verify()}>
          Verify with another device
        </button>
        {error && (
          <p role="alert" className="mt-2 text-sm" style={{ color: "var(--color-danger-text)" }}>
            {error}
          </p>
        )}
      </Part>
      {hasBackup ? (
        <>
          <Part title="Enter recovery key">
            <Restore />
          </Part>
          <details className="mb-5 text-sm">
            <summary className="cursor-pointer">I lost the recovery key and all my devices</summary>
            <div className="mt-2">
              <ResetIdentity />
            </div>
          </details>
        </>
      ) : (
        <Part title="Reset encryption">
          <p className="mb-2 text-sm">
            Your account has no recovery key. If you have no other signed-in device, reset the encryption. Then make a
            recovery key.
          </p>
          <ResetIdentity />
        </Part>
      )}
      <button type="button" className="text-sm underline" onClick={() => void session.store.getState().logout()}>
        Sign out
      </button>
    </AuthLayout>
  );
}

function SaveKeyScreen() {
  return (
    <AuthLayout title="Save your recovery key">
      <p className="mb-4 text-sm">
        Your messages are encrypted. The recovery key lets a new device read them. If you lose this device and the
        recovery key, you cannot read your old messages. Make the key before you continue.
      </p>
      <BackupSetup required />
    </AuthLayout>
  );
}

export default function SecurityGate({ screen, hasBackup }: { screen: GateScreen; hasBackup: boolean }) {
  const openFlow = useStore(securityStore, (s) => s.verifications.length > 0);
  return (
    <>
      {screen === "verify" ? <VerifyScreen hasBackup={hasBackup} /> : <SaveKeyScreen />}
      {openFlow && (
        <Suspense fallback={null}>
          <VerificationDialog />
        </Suspense>
      )}
    </>
  );
}
