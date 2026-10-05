// The "Invite people" dialog: pick an expiry and a use limit, create the
// invite, and copy its link.
import { useEffect, useRef, useState } from "react";
import { INVITE_MAX_AGE_SECONDS, type CreateInviteRequest } from "@mortium/shared";
import { webPageUrl } from "../lib/server-url.js";

type InviteMaxAgeSeconds = CreateInviteRequest["maxAgeSeconds"];
import { createInvite } from "@mortium/client-core";
import { session } from "../lib/session.js";
import { describeError } from "../lib/errors.js";

const AGE_LABELS: Record<number, string> = {
  0: "Never",
  1800: "30 minutes",
  3600: "1 hour",
  21600: "6 hours",
  43200: "12 hours",
  86400: "1 day",
  604800: "7 days",
};

const USE_LIMITS = [0, 1, 5, 10, 25, 50, 100];

export function InviteDialog({
  open,
  onClose,
  channelId,
}: {
  open: boolean;
  onClose: () => void;
  channelId: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [maxAgeSeconds, setMaxAgeSeconds] = useState<InviteMaxAgeSeconds>(604800);
  const [maxUses, setMaxUses] = useState(0);
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      setCode(null);
      setError(null);
      setCopied(false);
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  async function handleCreate() {
    setPending(true);
    setError(null);
    try {
      const invite = await createInvite(session.apiClient, channelId, { maxAgeSeconds, maxUses });
      setCode(invite.code);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  async function handleCopy() {
    if (!code) return;
    const url = webPageUrl(`/invite/${code}`);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setError("The link could not be copied. Copy it by hand instead.");
    }
  }

  const inviteUrl = code ? webPageUrl(`/invite/${code}`) : "";

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      className="w-full max-w-sm p-6"
      aria-label="Invite people"
    >
      <h2 className="mb-4 text-lg font-semibold">Invite people</h2>

      {!code ? (
        <>
          <label htmlFor="invite-age" className="mb-1 block text-sm font-medium">
            Expire after
          </label>
          <select
            id="invite-age"
            value={maxAgeSeconds}
            onChange={(e) => setMaxAgeSeconds(Number(e.target.value) as InviteMaxAgeSeconds)}
            className="field mb-4 w-full px-3 py-2 text-sm"
          >
            {INVITE_MAX_AGE_SECONDS.map((seconds) => (
              <option key={seconds} value={seconds}>
                {AGE_LABELS[seconds] ?? `${seconds}s`}
              </option>
            ))}
          </select>

          <label htmlFor="invite-uses" className="mb-1 block text-sm font-medium">
            Max number of uses
          </label>
          <select
            id="invite-uses"
            value={maxUses}
            onChange={(e) => setMaxUses(Number(e.target.value))}
            className="field mb-4 w-full px-3 py-2 text-sm"
          >
            {USE_LIMITS.map((limit) => (
              <option key={limit} value={limit}>
                {limit === 0 ? "No limit" : limit}
              </option>
            ))}
          </select>

          {error && (
            <p role="alert" className="mb-4 text-sm text-danger-text">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="btn btn-ghost">
              Cancel
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={handleCreate}
              className="btn btn-primary"
            >
              {pending ? "Creating..." : "Generate invite"}
            </button>
          </div>
        </>
      ) : (
        <>
          <label htmlFor="invite-link" className="mb-1 block text-sm font-medium">
            Invite link
          </label>
          <div className="mb-4 flex gap-2">
            <input
              id="invite-link"
              readOnly
              value={inviteUrl}
              className="field flex-1 px-3 py-2 text-sm"
            />
            <button type="button" onClick={handleCopy} className="btn btn-primary">
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          {error && (
            <p role="alert" className="mb-4 text-sm text-danger-text">
              {error}
            </p>
          )}
          <div className="flex justify-end">
            <button type="button" onClick={onClose} className="btn btn-ghost">
              Done
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}
