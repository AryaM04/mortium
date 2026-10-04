// The "+" dialog on the server rail: create a server, or join one with
// an invite code or a full invite URL.
import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { guildNameSchema } from "@mortium/shared";
import { createGuild, acceptInvite } from "@mortium/client-core";
import { session } from "../lib/session.js";
import { describeError } from "../lib/errors.js";
import { realtimeStore } from "../lib/realtime.js";
import { rememberLastLocation } from "../lib/lastLocation.js";

/** Accept either a bare invite code or a full `.../invite/<code>` URL. */
function extractInviteCode(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const match = trimmed.match(/\/invite\/([^/?#]+)/);
  if (match) return match[1] ?? null;
  if (/^[A-Za-z0-9_-]+$/.test(trimmed)) return trimmed;
  return null;
}

export function CreateOrJoinGuildDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<"create" | "join">("create");
  const [name, setName] = useState("");
  const [inviteInput, setInviteInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [, navigate] = useLocation();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      setTab("create");
      setName("");
      setInviteInput("");
      setError(null);
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    const parsed = guildNameSchema.safeParse(name);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "This name is not valid.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const guild = await createGuild(session.apiClient, { name: parsed.data });
      realtimeStore.getState().applyDispatch({ t: "GUILD_CREATE", d: guild });
      const firstChannel = guild.channels.find((c) => c.type !== "category");
      onClose();
      if (firstChannel) {
        rememberLastLocation(guild.id, firstChannel.id);
        navigate(`/app/${guild.id}/${firstChannel.id}`);
      } else {
        navigate(`/app/${guild.id}`);
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  async function handleJoin(event: React.FormEvent) {
    event.preventDefault();
    const code = extractInviteCode(inviteInput);
    if (!code) {
      setError("Enter an invite code or an invite link.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await acceptInvite(session.apiClient, code);
      realtimeStore.getState().applyDispatch({ t: "GUILD_CREATE", d: result.guild });
      const firstChannel = result.guild.channels.find((c) => c.type !== "category");
      onClose();
      if (firstChannel) {
        rememberLastLocation(result.guild.id, firstChannel.id);
        navigate(`/app/${result.guild.id}/${firstChannel.id}`);
      } else {
        navigate(`/app/${result.guild.id}`);
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      className="w-full max-w-sm rounded-lg border p-6"
      style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-sidebar)", color: "var(--color-text-primary)" }}
      aria-label="Add a server"
    >
      <div className="mb-4 flex gap-4" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "create"}
          onClick={() => setTab("create")}
          className="text-sm font-medium"
          style={{ color: tab === "create" ? "var(--color-text-primary)" : "var(--color-text-muted)" }}
        >
          Create a server
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "join"}
          onClick={() => setTab("join")}
          className="text-sm font-medium"
          style={{ color: tab === "join" ? "var(--color-text-primary)" : "var(--color-text-muted)" }}
        >
          Join a server
        </button>
      </div>

      {tab === "create" ? (
        <form onSubmit={handleCreate}>
          <label htmlFor="guild-name" className="mb-1 block text-sm font-medium">
            Server name
          </label>
          <input
            id="guild-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            className="mb-4 w-full rounded border px-3 py-2 text-sm"
            style={{ backgroundColor: "var(--color-bg-main)", borderColor: "var(--color-border)", color: "var(--color-text-primary)" }}
          />
          {error && (
            <p role="alert" className="mb-4 text-sm" style={{ color: "var(--color-danger-text)" }}>
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded px-3 py-2 text-sm">
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending}
              className="rounded px-3 py-2 text-sm font-medium"
              style={{ backgroundColor: "var(--color-accent)", color: "white" }}
            >
              {pending ? "Creating..." : "Create"}
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={handleJoin}>
          <label htmlFor="invite-input" className="mb-1 block text-sm font-medium">
            Invite code or link
          </label>
          <input
            id="invite-input"
            value={inviteInput}
            onChange={(e) => setInviteInput(e.target.value)}
            autoFocus
            placeholder="https://example.com/invite/aBcD1234"
            className="mb-4 w-full rounded border px-3 py-2 text-sm"
            style={{ backgroundColor: "var(--color-bg-main)", borderColor: "var(--color-border)", color: "var(--color-text-primary)" }}
          />
          {error && (
            <p role="alert" className="mb-4 text-sm" style={{ color: "var(--color-danger-text)" }}>
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded px-3 py-2 text-sm">
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending}
              className="rounded px-3 py-2 text-sm font-medium"
              style={{ backgroundColor: "var(--color-accent)", color: "white" }}
            >
              {pending ? "Joining..." : "Join"}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
