// The blocking security screens before the app (CRY-09). "save-key": a
// device that holds the master key makes the key backup. After a sign-in
// with a password, the app makes the backup itself and "show-key" shows the
// recovery key one time. Without a password (OAuth), the user makes the
// backup and confirms the key. "verify": a new device unlocks itself with
// the password (the key wrap), or verifies with a different device, or
// restores with the recovery key. An account without a backup can reset
// the identity, and then makes the backup. There is no way to skip. It
// loads only when it shows. See docs/concepts/olm-megolm.md sections 9 and
// 10, and docs/concepts/password-keys.md.
import { Suspense, lazy, useEffect, useState } from "react";
import { useStore } from "zustand";
import { currentCrypto, securityStore } from "../lib/crypto.js";
import { describeError } from "../lib/errors.js";
import {
  createBackupWithPassword,
  newRecoveryKeyStore,
  unlockWithWrapKey,
  whileRestoring,
} from "../lib/password-unlock.js";
import { session } from "../lib/session.js";
import type { GateScreen } from "../lib/security-gate.js";
import { AuthLayout } from "./AuthLayout.js";
import { BackupSetup, ResetIdentity, Restore, downloadKey } from "./SecurityDialog.js";

const VerificationDialog = lazy(() => import("./VerificationDialog.js"));

const button = "btn btn-ghost";
const primary = { backgroundColor: "var(--color-accent)", color: "var(--color-on-accent)" };
const field = "field w-full";

function Part({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <h2 className="eyebrow mb-2">{title}</h2>
      {children}
    </section>
  );
}

function Problem({ text }: { text: string | null }) {
  return text ? (
    <p role="alert" className="mt-2 text-sm text-danger-text">
      {text}
    </p>
  ) : null;
}

function SignOut() {
  return (
    <button
      type="button"
      className="text-sm link"
      onClick={() => void session.store.getState().logout()}
    >
      Sign out
    </button>
  );
}

/** Open the key wrap with the password, after a reload removed the wrap key from memory. */
function PasswordUnlock() {
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function unlock() {
    setPending(true);
    setError(null);
    try {
      const result = await whileRestoring(async () => {
        const recoveryKey = await session.keys.unlockWithPassword(password);
        return currentCrypto()!.security.restoreBackup({ recoveryKey });
      });
      setPassword("");
      if (!result.signed) {
        setError("The backup did not verify this device. Verify it with a different device.");
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <input
        type="password"
        aria-label="Your password"
        placeholder="Your password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className={field}
      />
      <div className="flex justify-end">
        <button
          type="button"
          className={button}
          style={primary}
          disabled={pending || password === ""}
          onClick={() => void unlock()}
        >
          {pending ? "Unlocking..." : "Unlock with your password"}
        </button>
      </div>
      <Problem text={error} />
    </div>
  );
}

function VerifyScreen({ hasBackup }: { hasBackup: boolean }) {
  // With the wrap key in memory, the app first tries to unlock this device without a question.
  const [automatic, setAutomatic] = useState(() => session.keys.hasWrapKey());
  const [passwordWorks, setPasswordWorks] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (automatic) {
      void unlockWithWrapKey().then((verified) => alive && !verified && setAutomatic(false));
    } else if (hasBackup) {
      void session.keys
        .hasCurrentKeyWrap()
        .then((exists) => alive && setPasswordWorks(exists))
        .catch(() => undefined);
    }
    return () => {
      alive = false;
    };
  }, [automatic, hasBackup]);

  async function verify() {
    setError(null);
    try {
      await currentCrypto()!.verification.requestOwnDevices();
    } catch (err) {
      setError(describeError(err));
    }
  }

  if (automatic) {
    return (
      <AuthLayout title="Unlocking your messages">
        <p role="status" className="mb-4 text-sm">
          The app unlocks your encryption keys with your password. This can take some seconds.
        </p>
        <SignOut />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Verify this device">
      <p className="mb-4 text-sm">
        Your messages are encrypted. Verify this device before you continue. Until then, it cannot
        read your messages.
      </p>
      {passwordWorks && (
        <Part title="Unlock with your password">
          <PasswordUnlock />
        </Part>
      )}
      <Part title="Verify with another device">
        <p className="mb-2 text-sm">
          Use a device where you are signed in. Compare the emojis on both devices.
        </p>
        <button type="button" className={button} style={primary} onClick={() => void verify()}>
          Verify with another device
        </button>
        <Problem text={error} />
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
            Your account has no recovery key. If you have no other signed-in device, reset the
            encryption. Then make a recovery key.
          </p>
          <ResetIdentity />
        </Part>
      )}
      <SignOut />
    </AuthLayout>
  );
}

function SaveKeyScreen() {
  const automatic = session.keys.hasWrapKey();
  const error = useStore(newRecoveryKeyStore, (s) => s.error);

  useEffect(() => {
    if (automatic) {
      void createBackupWithPassword();
    }
  }, [automatic]);

  if (automatic && !error) {
    return (
      <AuthLayout title="Save your recovery key">
        <p role="status" className="text-sm">
          The app makes your recovery key...
        </p>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title="Save your recovery key">
      <p className="mb-4 text-sm">
        Your messages are encrypted. The recovery key lets a new device read them. If you lose this
        device and the recovery key, you cannot read your old messages. Make the key before you
        continue.
      </p>
      <Problem text={error} />
      <BackupSetup required />
    </AuthLayout>
  );
}

/** The recovery key of the automatic backup, one time. The password unlocks a new device, so the user need not type the key back. */
function ShowKeyScreen() {
  const { recoveryKey, saving } = useStore(newRecoveryKeyStore);
  if (!recoveryKey) {
    return null;
  }
  return (
    <AuthLayout title="Save your recovery key">
      <p className="mb-4 text-sm">
        Your password unlocks your encrypted messages on a new device. You need this recovery key
        only if you forget your password or reset it by email. Keep it in a safe place.
      </p>
      <code
        data-testid="recovery-key"
        className="mb-2 block rounded-lg border border-line-strong bg-input p-3 text-center font-mono text-sm text-accent-text"
      >
        {recoveryKey}
      </code>
      <div className="mb-4 flex gap-3 text-sm">
        <button
          type="button"
          className="link"
          onClick={() => void navigator.clipboard?.writeText(recoveryKey)}
        >
          Copy
        </button>
        <button type="button" className="link" onClick={() => downloadKey(recoveryKey)}>
          Download
        </button>
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          className={button}
          style={primary}
          disabled={saving}
          onClick={() => newRecoveryKeyStore.setState({ recoveryKey: null })}
        >
          {saving ? "Saving..." : "Continue"}
        </button>
      </div>
    </AuthLayout>
  );
}

export default function SecurityGate({
  screen,
  hasBackup,
}: {
  screen: GateScreen;
  hasBackup: boolean;
}) {
  const openFlow = useStore(securityStore, (s) => s.verifications.length > 0);
  return (
    <>
      {screen === "verify" ? (
        <VerifyScreen hasBackup={hasBackup} />
      ) : screen === "show-key" ? (
        <ShowKeyScreen />
      ) : (
        <SaveKeyScreen />
      )}
      {openFlow && (
        <Suspense fallback={null}>
          <VerificationDialog />
        </Suspense>
      )}
    </>
  );
}
