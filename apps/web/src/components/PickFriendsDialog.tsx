// A dialog that picks friends from the friend list: for a new group DM,
// and for the owner to add people to a group DM.
import { useEffect, useRef, useState } from "react";
import type { User } from "@mortium/shared";
import { Avatar } from "./Avatar.js";
import { useRealtime } from "../lib/useRealtime.js";
import { describeError } from "../lib/errors.js";

export function PickFriendsDialog({
  title,
  confirmLabel,
  max,
  excludeIds = [],
  onConfirm,
  onClose,
}: {
  title: string;
  confirmLabel: string;
  /** The most friends to pick. */
  max: number;
  /** Friends that do not show, for example the people already in the group. */
  excludeIds?: string[];
  onConfirm: (userIds: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const relationships = useRealtime((s) => s.relationships);
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  const query = filter.trim().toLowerCase();
  const friends: User[] = Object.values(relationships)
    .filter((relationship) => relationship.status === "accepted" && !excludeIds.includes(relationship.userId))
    .map((relationship) => relationship.user)
    .filter(
      (user) => query === "" || user.username.includes(query) || user.displayName.toLowerCase().includes(query),
    )
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  function toggle(userId: string): void {
    setPicked((current) =>
      current.includes(userId) ? current.filter((id) => id !== userId) : current.length < max ? [...current, userId] : current,
    );
  }

  async function confirm(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await onConfirm(picked);
      onClose();
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
      aria-label={title}
      className="w-full max-w-sm rounded-lg border p-5"
      style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-sidebar)", color: "var(--color-text-primary)" }}
    >
      <h2 className="mb-1 text-lg font-semibold">{title}</h2>
      <p className="mb-3 text-xs" style={{ color: "var(--color-text-muted)" }}>
        You can pick {max - picked.length} more {max - picked.length === 1 ? "friend" : "friends"}.
      </p>
      <input
        aria-label="Find a friend"
        placeholder="Type the name of a friend"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className="mb-2 w-full rounded border px-2 py-1 text-sm"
        style={{ backgroundColor: "var(--color-bg-main)", borderColor: "var(--color-border)", color: "var(--color-text-primary)" }}
      />
      <ul className="mb-3 flex max-h-64 flex-col gap-1 overflow-y-auto">
        {friends.length === 0 && (
          <li className="px-2 py-2 text-sm" style={{ color: "var(--color-text-muted)" }}>
            No friends to show.
          </li>
        )}
        {friends.map((user) => {
          const checked = picked.includes(user.id);
          return (
            <li key={user.id}>
              <label className="flex items-center gap-2 rounded px-2 py-1 text-sm">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!checked && picked.length >= max}
                  onChange={() => toggle(user.id)}
                />
                <Avatar user={user} size={24} />
                <span className="truncate">{user.displayName}</span>
                <span className="truncate text-xs" style={{ color: "var(--color-text-muted)" }}>
                  @{user.username}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {error && (
        <p role="alert" className="mb-2 text-sm" style={{ color: "var(--color-danger-text)" }}>
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded px-3 py-2 text-sm">
          Cancel
        </button>
        <button
          type="button"
          disabled={pending || picked.length === 0}
          onClick={() => void confirm()}
          className="rounded px-3 py-2 text-sm font-medium disabled:opacity-50"
          style={{ backgroundColor: "var(--color-accent)", color: "white" }}
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
