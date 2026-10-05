// Asks for an email, and tells the person to check their inbox for a
// reset link. The server always answers 202 here, whether the account
// exists or not, so this page cannot be used to find out who has an
// account.
import { useState, type FormEvent } from "react";
import { Link } from "wouter";
import { forgotPasswordRequestSchema } from "@mortium/shared";
import { AuthLayout } from "../components/AuthLayout.js";
import { FormField } from "../components/FormField.js";
import { describeError } from "../lib/errors.js";
import { session } from "../lib/session.js";

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);

    const parsed = forgotPasswordRequestSchema.safeParse({ email });
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message);
      return;
    }
    setFieldError(undefined);

    setPending(true);
    try {
      await session.store.getState().forgotPassword(parsed.data.email);
      setSent(true);
    } catch (error) {
      setFormError(describeError(error));
    } finally {
      setPending(false);
    }
  }

  if (sent) {
    return (
      <AuthLayout title="Check your email">
        <p className="text-sm">
          If an account uses this email address, a message with a password reset link is on its way.
        </p>
        <div className="mt-4 text-sm">
          <Link href="/login">Back to sign in</Link>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Reset your password">
      <form onSubmit={handleSubmit} noValidate>
        <FormField
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={fieldError}
        />
        {formError && (
          <p role="alert" className="mb-4 text-sm text-danger-text">
            {formError}
          </p>
        )}
        <button
          type="submit"
          disabled={pending}
          className="btn btn-primary w-full"
        >
          {pending ? "Sending..." : "Send reset link"}
        </button>
      </form>
      <div className="mt-4 text-sm text-muted">
        <Link href="/login">Back to sign in</Link>
      </div>
    </AuthLayout>
  );
}
