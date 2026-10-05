// Reads the verification token from the URL hash and submits it right
// away, then shows the result. There is no form to fill in.
import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { AuthLayout } from "../components/AuthLayout.js";
import { describeError } from "../lib/errors.js";
import { session } from "../lib/session.js";

type Status = "checking" | "done" | "failed";

function readTokenFromHash(): string | null {
  const match = /token=([^&]+)/.exec(window.location.hash);
  return match ? decodeURIComponent(match[1]!) : null;
}

export function VerifyEmailPage() {
  const [status, setStatus] = useState<Status>("checking");
  const [error, setError] = useState<string | null>(null);
  // The token is single-use, so the request below must run exactly once.
  // A plain effect would fire it twice under StrictMode's development-only
  // double-invoke, and the second call would fail because the token was
  // already used, sometimes overwriting the correct "done" state.
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const token = readTokenFromHash();
    if (!token) {
      setStatus("failed");
      setError("This verification link is missing its token.");
      return;
    }
    session.store
      .getState()
      .verifyEmail(token)
      .then(() => setStatus("done"))
      .catch((err: unknown) => {
        setStatus("failed");
        setError(describeError(err));
      });
  }, []);

  return (
    <AuthLayout title="Email verification">
      {status === "checking" && <p className="text-sm">Checking your link...</p>}
      {status === "done" && (
        <p className="text-sm">Your email address is verified. You can close this page.</p>
      )}
      {status === "failed" && (
        <p role="alert" className="text-sm text-danger-text">
          {error}
        </p>
      )}
      <div className="mt-4 text-sm">
        <Link href="/app" className="link">
          Go to the app
        </Link>
      </div>
    </AuthLayout>
  );
}
