// Change the account password. The client derives the auth keys of the
// current and the new password, and encrypts the recovery key again with
// the new password. The other sessions stay signed in.
// See docs/concepts/password-keys.md.
import { useState, type FormEvent } from "react";
import { passwordSchema } from "@mortium/shared";
import { FormField } from "./FormField.js";
import { describeError } from "../lib/errors.js";
import { session } from "../lib/session.js";

export function ChangePassword() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    const parsed = passwordSchema.safeParse(next);
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message);
      return;
    }
    setFieldError(undefined);
    setPending(true);
    try {
      await session.keys.changePassword(current, parsed.data);
      setCurrent("");
      setNext("");
      setOpen(false);
      setDone(true);
    } catch (error) {
      setFormError(describeError(error));
    } finally {
      setPending(false);
    }
  }

  if (!open) {
    return (
      <div className="mb-4 text-sm">
        {done && <p role="status" className="mb-1">Your password is changed.</p>}
        <button type="button" className="underline" onClick={() => setOpen(true)}>
          Change password
        </button>
      </div>
    );
  }
  return (
    <form onSubmit={handleSubmit} noValidate className="mb-4">
      <FormField
        label="Current password"
        type="password"
        autoComplete="current-password"
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
      />
      <FormField
        label="New password"
        type="password"
        autoComplete="new-password"
        value={next}
        onChange={(e) => setNext(e.target.value)}
        error={fieldError}
      />
      {formError && (
        <p role="alert" className="mb-4 text-sm" style={{ color: "var(--color-danger-text)" }}>
          {formError}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className="rounded px-3 py-2 text-sm" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button
          type="submit"
          disabled={pending || current === ""}
          className="rounded px-3 py-2 text-sm font-medium"
          style={{ backgroundColor: "var(--color-accent)", color: "white" }}
        >
          {pending ? "Saving..." : "Change password"}
        </button>
      </div>
    </form>
  );
}
