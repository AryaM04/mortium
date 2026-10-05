// The SAS verification dialog: accept a request, compare 7 emojis with the
// other device, and see the result. It shows the first verification in
// the list. See docs/concepts/olm-megolm.md section 10.
import { useEffect, useRef } from "react";
import { useStore } from "zustand";
import type { VerificationView } from "@mortium/client-core/crypto";
import { currentCrypto, securityStore } from "../lib/crypto.js";
import { realtimeStore } from "../lib/realtime.js";
import { nameOfUser } from "./SecurityBanner.js";

function who(view: VerificationView): string {
  return view.ownUser ? "your other device" : nameOfUser(realtimeStore.getState(), view.otherUserId);
}

function resultText(view: VerificationView): string {
  if (!view.ownUser) {
    return `You verified ${who(view)}. Their identity shows as verified now.`;
  }
  if (view.signed === null) {
    return "The devices are verified. The app waits for the signature of the new device.";
  }
  return view.signed
    ? "The devices are verified. This account now trusts both devices, and they share keys."
    : "The devices are verified, but no device could sign the other. Enter the recovery key on the new device.";
}

export default function VerificationDialog() {
  const view = useStore(securityStore, (s) => s.verifications[0]);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && view && !dialog.open) {
      dialog.showModal();
    }
  }, [view]);

  if (!view) {
    return null;
  }
  const crypto = currentCrypto();
  const { txnId, phase } = view;
  const button = "btn btn-ghost";
  const primary = { backgroundColor: "var(--color-accent)", color: "var(--color-on-accent)" };

  return (
    <dialog
      ref={dialogRef}
      aria-label="Verification"
      onCancel={(event) => {
        event.preventDefault();
        void crypto?.verification.cancel(txnId);
      }}
      className="w-full max-w-md p-6"
    >
      <h2 className="mb-3 text-lg font-semibold">{view.ownUser ? "Verify a device" : `Verify ${who(view)}`}</h2>

      {phase === "incoming" && (
        <>
          <p className="mb-4 text-sm">
            {view.ownUser ? "A different device of your account" : who(view)} wants to verify with this device. Accept only when
            you started this verification.
          </p>
          <div className="flex justify-end gap-2">
            <button type="button" className={button} onClick={() => void crypto?.verification.cancel(txnId)}>
              Decline
            </button>
            <button type="button" className={button} style={primary} onClick={() => void crypto?.verification.accept(txnId)}>
              Accept
            </button>
          </div>
        </>
      )}

      {(phase === "waiting" || phase === "confirmed") && (
        <>
          <p className="mb-4 text-sm">
            {phase === "waiting" ? `Accept the verification on ${who(view)}.` : `Wait for ${who(view)} to confirm the emojis.`}
          </p>
          <div className="flex justify-end">
            <button type="button" className={button} onClick={() => void crypto?.verification.cancel(txnId)}>
              Cancel
            </button>
          </div>
        </>
      )}

      {phase === "emojis" && view.emojis && (
        <>
          <p className="mb-3 text-sm">Compare these emojis with the emojis on {who(view)}. They must be the same, in the same order.</p>
          <ol aria-label="Verification emojis" className="mb-4 grid grid-cols-4 gap-2 text-center">
            {view.emojis.map((entry, index) => (
              <li key={index} className="flex flex-col items-center" data-emoji-name={entry.name}>
                <span className="text-3xl" aria-hidden="true">
                  {entry.emoji}
                </span>
                <span className="text-xs">{entry.name}</span>
              </li>
            ))}
          </ol>
          <div className="flex justify-end gap-2">
            <button type="button" className={button} style={{ color: "var(--color-danger-text)" }} onClick={() => void crypto?.verification.confirm(txnId, false)}>
              They do not match
            </button>
            <button type="button" className={button} style={primary} onClick={() => void crypto?.verification.confirm(txnId, true)}>
              They match
            </button>
          </div>
        </>
      )}

      {(phase === "done" || phase === "cancelled") && (
        <>
          <p role="status" className="mb-4 text-sm">
            {phase === "done" ? resultText(view) : view.cancelReason}
          </p>
          <div className="flex justify-end">
            <button
              type="button"
              className={button}
              style={primary}
              onClick={() => {
                dialogRef.current?.close();
                crypto?.verification.dismiss(txnId);
              }}
            >
              Close
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}
