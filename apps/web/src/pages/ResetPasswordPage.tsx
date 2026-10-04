// Reads the reset token from the URL hash (the email link puts it there,
// never in the path or query string, so it never reaches a server log).
import { useMemo, useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { resetPasswordRequestSchema } from "@mortium/shared";
import { AuthLayout } from "../components/AuthLayout.js";
import { FormField } from "../components/FormField.js";
import { describeError } from "../lib/errors.js";
import { session } from "../lib/session.js";

function readTokenFromHash(): string | null {
  const match = /token=([^&]+)/.exec(window.location.hash);
  return match ? decodeURIComponent(match[1]!) : null;
}

export function ResetPasswordPage() {
  const [, navigate] = useLocation();
  const token = useMemo(readTokenFromHash, []);
  const [password, setPassword] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);

    if (!token) {
      setFormError("This reset link is missing its token. Ask for a new one.");
      return;
    }

    const parsed = resetPasswordRequestSchema.safeParse({ token, password });
    if (!parsed.success) {
      setFieldError(parsed.error.issues.find((issue) => issue.path[0] === "password")?.message);
      return;
    }
    setFieldError(undefined);

    setPending(true);
    try {
      await session.store.getState().resetPassword(parsed.data.token, parsed.data.password);
      navigate("/login");
    } catch (error) {
      setFormError(describeError(error));
    } finally {
      setPending(false);
    }
  }

  if (!token) {
    return (
      <AuthLayout title="This link is not valid">
        <p className="text-sm">This password reset link is missing its token.</p>
        <div className="mt-4 text-sm">
          <Link href="/forgot-password">Ask for a new link</Link>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Choose a new password">
      <form onSubmit={handleSubmit} noValidate>
        <FormField
          label="New password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fieldError}
        />
        {formError && (
          <p role="alert" className="mb-4 text-sm" style={{ color: "var(--color-danger-text)" }}>
            {formError}
          </p>
        )}
        <button
          type="submit"
          disabled={pending}
          className="w-full rounded px-3 py-2 text-sm font-medium"
          style={{ backgroundColor: "var(--color-accent)", color: "white" }}
        >
          {pending ? "Saving..." : "Set new password"}
        </button>
      </form>
    </AuthLayout>
  );
}
