// The security settings: the verification state of this device and of
// the other devices of the account, the key backup (set up, restore,
// delete) and the identity reset. It loads only when it opens. See
// docs/concepts/olm-megolm.md sections 4, 9 and 10. The security gate
// (SecurityGate.tsx) uses the same backup, restore and reset parts.
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type { OwnDevice } from "@mortium/client-core/crypto";
import { currentCrypto, securityStore } from "../lib/crypto.js";
import { describeError } from "../lib/errors.js";

const button = "rounded px-3 py-2 text-sm";
const primary = { backgroundColor: "var(--color-accent)", color: "white" };
const danger = { color: "var(--color-danger-text)" };
const field = "w-full rounded border px-2 py-1 text-sm";
const fieldStyle = { backgroundColor: "var(--color-bg-main)", borderColor: "var(--color-border)", color: "var(--color-text-primary)" };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <h3 className="mb-2 text-sm font-semibold uppercase" style={{ color: "var(--color-text-muted)" }}>
        {title}
      </h3>
      {children}
    </section>
  );
}

function Problem({ text }: { text: string | null }) {
  return text ? (
    <p role="alert" className="mt-2 text-sm" style={danger}>
      {text}
    </p>
  ) : null;
}

type SetupStep = { step: "idle" } | { step: "passphrase" } | { step: "show"; recoveryKey: string; create: () => Promise<void> } | { step: "done" };

/** Save the recovery key as a text file. */
function downloadKey(recoveryKey: string): void {
  const url = URL.createObjectURL(new Blob([`Mortium recovery key
${recoveryKey}
`], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "mortium-recovery-key.txt";
  link.click();
  URL.revokeObjectURL(url);
}

/** Make the key backup. With `required`, it starts at the passphrase step and has no "Cancel". */
export function BackupSetup({ required = false }: { required?: boolean }) {
  const [state, setState] = useState<SetupStep>({ step: required ? "passphrase" : "idle" });
  const [passphrase, setPassphrase] = useState("");
  const [again, setAgain] = useState("");
  const [lastGroup, setLastGroup] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function prepare() {
    if (passphrase !== again) {
      setError("The two passphrases are not the same.");
      return;
    }
    if (passphrase !== "" && passphrase.length < 10) {
      setError("Use a passphrase of 10 or more characters, or no passphrase.");
      return;
    }
    setError(null);
    setPending(true);
    try {
      const prepared = await currentCrypto()!.security.setUpBackup(passphrase || undefined);
      setState({ step: "show", ...prepared });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  async function confirm(recoveryKey: string, create: () => Promise<void>) {
    if (lastGroup.trim() !== recoveryKey.split(" ").at(-1)) {
      setError("This is not the last group of the recovery key. Look at the key again.");
      return;
    }
    setError(null);
    setPending(true);
    try {
      await create();
      setState({ step: "done" });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  if (state.step === "idle" || state.step === "done") {
    return (
      <>
        {state.step === "done" && <p className="mb-2 text-sm">The backup is on. The app saves your keys in the background.</p>}
        <button type="button" className={button} style={primary} onClick={() => setState({ step: "passphrase" })}>
          Set up secure backup
        </button>
      </>
    );
  }
  if (state.step === "passphrase") {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm">
          The app makes a recovery key. It encrypts your message keys before they go to the server. You can also set a
          passphrase: then the passphrase gives the same key.
        </p>
        <input type="password" aria-label="Passphrase (optional)" placeholder="Passphrase (optional)" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} className={field} style={fieldStyle} />
        <input type="password" aria-label="Type the passphrase again" placeholder="Type the passphrase again" value={again} onChange={(e) => setAgain(e.target.value)} className={field} style={fieldStyle} />
        <div className="flex justify-end gap-2">
          {!required && (
            <button type="button" className={button} onClick={() => setState({ step: "idle" })}>
              Cancel
            </button>
          )}
          <button type="button" className={button} style={primary} disabled={pending} onClick={() => void prepare()}>
            {pending ? "Making the key..." : "Make the recovery key"}
          </button>
        </div>
        <Problem text={error} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">
        Write down this recovery key and keep it in a safe place. You see it only one time. Without it (or the passphrase),
        a new device cannot read your old messages.
      </p>
      <code data-testid="recovery-key" className="rounded p-2 text-center font-mono text-sm" style={{ backgroundColor: "var(--color-bg-main)" }}>
        {state.recoveryKey}
      </code>
      <div className="flex gap-3 text-sm">
        <button type="button" className="underline" onClick={() => void navigator.clipboard?.writeText(state.recoveryKey)}>
          Copy
        </button>
        <button type="button" className="underline" onClick={() => downloadKey(state.recoveryKey)}>
          Download
        </button>
      </div>
      <label className="text-sm">
        Type the last group of the key to confirm that you wrote it down.
        <input aria-label="Last group of the recovery key" value={lastGroup} onChange={(e) => setLastGroup(e.target.value)} className={`${field} mt-1`} style={fieldStyle} />
      </label>
      <div className="flex justify-end gap-2">
        {!required && (
          <button type="button" className={button} onClick={() => setState({ step: "idle" })}>
            Cancel
          </button>
        )}
        <button type="button" className={button} style={primary} disabled={pending} onClick={() => void confirm(state.recoveryKey, state.create)}>
          Turn on the backup
        </button>
      </div>
      <Problem text={error} />
    </div>
  );
}

export function Restore() {
  const [usePassphrase, setUsePassphrase] = useState(false);
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function restore() {
    setPending(true);
    setError(null);
    setProgress("The app downloads the backup...");
    try {
      const input = usePassphrase ? { passphrase: value } : { recoveryKey: value };
      const result = await currentCrypto()!.security.restoreBackup(input, (entry) =>
        setProgress(`${entry.imported} message keys restored.`),
      );
      setValue("");
      setProgress(
        `The restore is complete: ${result.imported} message keys.` +
          (result.failed > 0 ? ` ${result.failed} keys were not valid and were not used.` : "") +
          (result.signed ? " This device is verified now." : " The backup did not verify this device. Verify it with a different device."),
      );
    } catch (err) {
      setProgress(null);
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <input
        aria-label={usePassphrase ? "Backup passphrase" : "Recovery key"}
        placeholder={usePassphrase ? "Backup passphrase" : "Recovery key"}
        type={usePassphrase ? "password" : "text"}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className={`${field} font-mono`}
        style={fieldStyle}
      />
      <div className="flex justify-between gap-2">
        <button type="button" className="text-sm underline" onClick={() => setUsePassphrase(!usePassphrase)}>
          {usePassphrase ? "Use the recovery key" : "Use the passphrase"}
        </button>
        <button type="button" className={button} style={primary} disabled={pending || value.trim() === ""} onClick={() => void restore()}>
          Restore from backup
        </button>
      </div>
      {progress && (
        <p role="status" className="text-sm">
          {progress}
        </p>
      )}
      <Problem text={error} />
    </div>
  );
}

export function ResetIdentity() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function reset() {
    setPending(true);
    setError(null);
    try {
      await currentCrypto()!.security.resetIdentity(password);
      setPassword("");
      setDone(true);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return <p className="text-sm">This device has a new identity key. Verify your other devices again.</p>;
  }
  if (!open) {
    return (
      <button type="button" className="text-sm underline" style={danger} onClick={() => setOpen(true)}>
        Reset the identity
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">
        Caution: do this only when you lost all your verified devices and your recovery key. After the reset, your other
        devices are not verified, the key backup is deleted, and other people see a warning that your identity changed.
      </p>
      <input type="password" aria-label="Account password" placeholder="Account password" value={password} onChange={(e) => setPassword(e.target.value)} className={field} style={fieldStyle} />
      <div className="flex justify-end gap-2">
        <button type="button" className={button} onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button type="button" className={button} style={{ backgroundColor: "#a12d2d", color: "white" }} disabled={pending || password === ""} onClick={() => void reset()}>
          Reset the identity
        </button>
      </div>
      <Problem text={error} />
    </div>
  );
}

export default function SecurityDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const security = useStore(securityStore);
  const [devices, setDevices] = useState<OwnDevice[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && dialog && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog?.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    let alive = true;
    void currentCrypto()
      ?.security.ownDevices()
      .then((list) => alive && setDevices(list));
    return () => {
      alive = false;
    };
  }, [security]);

  async function verify(deviceId?: string) {
    setError(null);
    try {
      await currentCrypto()!.verification.requestOwnDevices(deviceId);
    } catch (err) {
      setError(describeError(err));
    }
  }

  const backup = security.backup;
  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      aria-label="Security"
      className="w-full max-w-lg rounded-lg border p-6"
      style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-sidebar)", color: "var(--color-text-primary)" }}
    >
      <h2 className="mb-4 text-lg font-semibold">Security</h2>
      {!security.ready ? (
        <p className="text-sm">The encryption is not ready yet.</p>
      ) : (
        <>
          <Section title="This device">
            <p className="text-sm" data-testid="device-trust">
              {security.deviceVerified ? "Verified. Your other devices share keys with this device." : "Not verified. Other devices do not share keys with this device."}
            </p>
            {!security.deviceVerified && (
              <button type="button" className={`${button} mt-2`} style={primary} onClick={() => void verify()}>
                Verify with a different device
              </button>
            )}
          </Section>

          <Section title="Your devices">
            <ul className="flex flex-col gap-1">
              {devices.map((device) => (
                <li key={device.deviceId} className="flex items-center justify-between text-sm">
                  <span className="font-mono">
                    {device.deviceId}
                    {device.current ? " (this device)" : ""}
                  </span>
                  <span className="flex items-center gap-2">
                    <span style={{ color: device.verified ? "#3ba55d" : "#e0a352" }}>{device.verified ? "Verified" : "Not verified"}</span>
                    {!device.current && !device.verified && security.deviceVerified && (
                      <button type="button" className="underline" onClick={() => void verify(device.deviceId)}>
                        Verify
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <Problem text={error} />
          </Section>

          <Section title="Secure backup">
            {backup?.version ? (
              <p className="mb-2 text-sm" data-testid="backup-state">
                {backup.trusted
                  ? backup.uploading
                    ? "The backup is on. The app saves your keys now."
                    : "The backup is on. All keys on this device are saved."
                  : "A backup exists, but no verified device made it. This device does not save keys in it."}
              </p>
            ) : (
              <p className="mb-2 text-sm">There is no backup. Without a backup, a new device cannot read your old messages.</p>
            )}
            <Problem text={backup?.error ?? null} />
            {security.deviceVerified && <BackupSetup />}
            {backup?.version && (
              <div className="mt-3">
                <h4 className="mb-1 text-sm font-semibold">Restore from backup</h4>
                <Restore />
              </div>
            )}
            {backup?.version && (
              <button
                type="button"
                className="mt-3 text-sm underline"
                style={danger}
                onClick={() => void currentCrypto()?.security.deleteBackup().catch((err: unknown) => setError(describeError(err)))}
              >
                Delete the backup
              </button>
            )}
          </Section>

          <Section title="Identity">
            <ResetIdentity />
          </Section>
        </>
      )}
      <div className="flex justify-end">
        <button type="button" className={button} onClick={onClose}>
          Close
        </button>
      </div>
    </dialog>
  );
}
