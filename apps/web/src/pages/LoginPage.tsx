// The sign-in page.
import { useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { loginFormSchema } from "@mortium/shared";
import { AuthLayout } from "../components/AuthLayout.js";
import { FormField } from "../components/FormField.js";
import { DownloadLink } from "../components/DownloadLink.js";
import { OAuthButtons } from "../components/OAuthButtons.js";
import { describeError } from "../lib/errors.js";
import { session } from "../lib/session.js";

export function LoginPage() {
  const [, navigate] = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);

    const parsed = loginFormSchema.safeParse({ email, password });
    if (!parsed.success) {
      const errors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (typeof key === "string") errors[key] = issue.message;
      }
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});

    setPending(true);
    try {
      await session.store.getState().login(parsed.data);
      const redirect = new URLSearchParams(window.location.search).get("redirect");
      navigate(redirect && redirect.startsWith("/") ? redirect : "/app");
    } catch (error) {
      setFormError(describeError(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthLayout title="Sign in">
      <OAuthButtons />
      <form onSubmit={handleSubmit} noValidate>
        <FormField
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={fieldErrors.email}
        />
        <FormField
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fieldErrors.password}
        />
        {formError && (
          <p role="alert" className="mb-4 text-sm text-danger-text">
            {formError}
          </p>
        )}
        <button type="submit" disabled={pending} className="btn btn-primary w-full">
          {pending ? "Signing in..." : "Sign in"}
        </button>
      </form>
      <div className="mt-4 flex flex-col gap-1 text-sm text-muted">
        <Link href="/forgot-password" className="link">
          Forgot your password?
        </Link>
        <span>
          No account yet?{" "}
          <Link href="/register" className="link">
            Register
          </Link>
        </span>
        <DownloadLink />
      </div>
    </AuthLayout>
  );
}
