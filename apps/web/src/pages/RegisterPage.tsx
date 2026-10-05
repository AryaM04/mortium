// The registration page.
import { useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { registerFormSchema } from "@mortium/shared";
import { AuthLayout } from "../components/AuthLayout.js";
import { DownloadLink } from "../components/DownloadLink.js";
import { FormField } from "../components/FormField.js";
import { OAuthButtons } from "../components/OAuthButtons.js";
import { describeError } from "../lib/errors.js";
import { session } from "../lib/session.js";

export function RegisterPage() {
  const [, navigate] = useLocation();
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);

    const parsed = registerFormSchema.safeParse({
      email,
      username,
      password,
      displayName: displayName || undefined,
    });
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
      await session.store.getState().register(parsed.data);
      navigate("/app");
    } catch (error) {
      setFormError(describeError(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthLayout title="Create an account">
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
          label="Username"
          type="text"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          error={fieldErrors.username}
        />
        <FormField
          label="Display name (optional)"
          type="text"
          autoComplete="nickname"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          error={fieldErrors.displayName}
        />
        <FormField
          label="Password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fieldErrors.password}
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
          {pending ? "Creating your account..." : "Create account"}
        </button>
      </form>
      <div className="mt-4 text-sm text-muted">
        Already have an account? <Link href="/login">Sign in</Link>
        <DownloadLink />
      </div>
    </AuthLayout>
  );
}
