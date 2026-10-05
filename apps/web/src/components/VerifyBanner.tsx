// Tells a signed-in person their email is not verified yet, with a
// button to send the verification email again.
import { useState } from "react";
import { describeError } from "../lib/errors.js";
import { useSession } from "../lib/useSession.js";
import { session } from "../lib/session.js";

export function VerifyBanner() {
  const user = useSession((s) => s.user);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (!user || user.emailVerified !== false) {
    return null;
  }

  async function handleResend() {
    setPending(true);
    setError(null);
    try {
      await session.store.getState().resendVerification();
      setSent(true);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      role="status"
      className="mx-1.5 mt-1.5 flex items-center justify-between gap-3 rounded-lg border border-warning/30 bg-[#2a2110] px-3 py-2 text-sm text-[#fcd34d]"
    >
      <span>
        {sent
          ? "A new verification email is on its way."
          : "Your email address is not verified yet."}
      </span>
      {!sent && (
        <button type="button" onClick={handleResend} disabled={pending} className="underline underline-offset-2">
          {pending ? "Sending..." : "Send the email again"}
        </button>
      )}
      {error && <span className="text-danger-text">{error}</span>}
    </div>
  );
}
