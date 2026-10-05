// Lands here after an OAuth provider redirect. Reads the one-time code
// (or an error) from the URL hash, exchanges it for real tokens, then
// clears the hash from history before moving on (see docs/concepts/auth.md:
// the code must never linger in a bookmark or browser history entry).
import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { AuthLayout } from "../components/AuthLayout.js";
import { describeError } from "../lib/errors.js";
import { session } from "../lib/session.js";

export function AuthCallbackPage() {
  const [, navigate] = useLocation();
  const [error, setError] = useState<string | null>(null);
  // The exchange code is single-use (see docs/concepts/auth.md), so this
  // must run exactly once. See the same guard in VerifyEmailPage.tsx.
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const hash = window.location.hash;
    const codeMatch = /code=([^&]+)/.exec(hash);
    const errorMatch = /error=([^&]+)/.exec(hash);

    // Clear the hash right away, so the code cannot be replayed from
    // history (back button) or copied out of the address bar.
    history.replaceState(null, "", window.location.pathname);

    if (errorMatch) {
      setError(`Sign-in did not finish: ${decodeURIComponent(errorMatch[1]!)}`);
      return;
    }
    if (!codeMatch) {
      setError("This sign-in link is missing its code.");
      return;
    }

    session.store
      .getState()
      .completeOAuth(decodeURIComponent(codeMatch[1]!))
      .then(() => navigate("/app"))
      .catch((err: unknown) => setError(describeError(err)));
  }, [navigate]);

  return (
    <AuthLayout title="Signing you in">
      {error ? (
        <p role="alert" className="text-sm text-danger-text">
          {error}
        </p>
      ) : (
        <p className="text-sm">One moment...</p>
      )}
    </AuthLayout>
  );
}
