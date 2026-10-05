// The member list of a group DM. The owner can add friends and remove
// people. Every member can leave the group.
import { useState } from "react";
import { addDmRecipient, removeDmRecipient } from "@mortium/client-core";
import { MAX_GROUP_DM_MEMBERS, type DmChannelJson } from "@mortium/shared";
import { useStore } from "zustand";
import { Avatar } from "./Avatar.js";
import { PickFriendsDialog } from "./PickFriendsDialog.js";
import { session } from "../lib/session.js";
import { describeError } from "../lib/errors.js";
import { leftDmIds } from "../lib/dms.js";
import { useRealtime } from "../lib/useRealtime.js";
import { presenceUiStore } from "../lib/presence.js";
import { PlusIcon } from "./icons.js";

const PRESENCE_COLOR: Record<string, string> = {
  online: "var(--color-online)",
  idle: "var(--color-idle)",
  dnd: "var(--color-dnd)",
  offline: "var(--color-offline)",
};

export default function GroupDmMembers({ channel }: { channel: DmChannelJson }) {
  const selfUserId = useRealtime((s) => s.selfUserId);
  const presences = useRealtime((s) => s.presences);
  const chosenStatus = useStore(presenceUiStore, (s) => s.chosenStatus);
  const [adding, setAdding] = useState(false);
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isOwner = channel.ownerId === selfUserId;
  const full = channel.recipients.length >= MAX_GROUP_DM_MEMBERS;

  function statusOf(userId: string): string {
    if (userId === selfUserId) {
      return chosenStatus === "invisible" ? "offline" : chosenStatus;
    }
    return presences[userId] ?? "offline";
  }

  async function run(action: () => Promise<void>): Promise<void> {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function leaveGroup(): Promise<void> {
    leftDmIds.add(channel.id);
    try {
      await removeDmRecipient(session.apiClient, channel.id, selfUserId ?? "");
    } catch (err) {
      leftDmIds.delete(channel.id);
      throw err;
    }
  }

  return (
    <aside
      aria-label="Group members"
      className="panel flex w-60 shrink-0 flex-col gap-1 overflow-y-auto p-2"
    >
      <div className="eyebrow mb-1 mt-2 px-2">
        Members ({channel.recipients.length})
      </div>
      <ul className="flex flex-col gap-0.5">
        {channel.recipients.map((user) => (
          <li key={user.id} className="group flex h-10 items-center gap-2.5 rounded-lg px-2 hover:bg-hover" data-group-member={user.displayName}>
            <div className="relative">
              <Avatar user={user} size={28} />
              <span
                aria-hidden="true"
                className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-sidebar"
                style={{ backgroundColor: PRESENCE_COLOR[statusOf(user.id)] }}
              />
            </div>
            <span className="min-w-0 flex-1 truncate text-sm">{user.displayName}</span>
            {user.id === channel.ownerId && (
              <span className="rounded bg-warning-soft px-1.5 py-0.5 text-[11px] font-medium text-warning-text" title="Group owner">
                Owner
              </span>
            )}
            {isOwner && user.id !== selfUserId && (
              <button
                type="button"
                aria-label={`Remove ${user.displayName} from the group`}
                onClick={() => void run(() => removeDmRecipient(session.apiClient, channel.id, user.id))}
                className="btn btn-danger-ghost hidden px-1.5 py-0.5 text-xs group-hover:inline-flex group-focus-within:inline-flex"
              >
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="px-2 text-xs text-danger-text">
          {error}
        </p>
      )}
      <div className="mt-2 flex flex-col gap-1 px-2">
        {isOwner && (
          <button
            type="button"
            disabled={full}
            title={full ? `A group DM can have at most ${MAX_GROUP_DM_MEMBERS} people.` : undefined}
            onClick={() => setAdding(true)}
            className="btn btn-secondary justify-start px-2.5 py-1.5"
          >
            <PlusIcon size={14} />
            Add friends
          </button>
        )}
        {confirmingLeave ? (
          <div className="card flex flex-col gap-2 rounded-lg p-2.5 text-sm">
            <span>Leave this group? You cannot come back unless the owner adds you again.</span>
            <div className="flex justify-end gap-1">
              <button type="button" onClick={() => setConfirmingLeave(false)} className="btn btn-ghost px-2 py-1 text-xs">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void run(leaveGroup)}
                className="btn btn-danger px-2 py-1 text-xs"
              >
                Leave group
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmingLeave(true)}
            className="btn btn-danger-ghost justify-start px-2.5 py-1.5"
          >
            Leave group
          </button>
        )}
      </div>
      {adding && (
        <PickFriendsDialog
          title="Add friends to the group"
          confirmLabel="Add"
          max={MAX_GROUP_DM_MEMBERS - channel.recipients.length}
          excludeIds={channel.recipients.map((user) => user.id)}
          onClose={() => setAdding(false)}
          onConfirm={async (userIds) => {
            for (const userId of userIds) {
              await addDmRecipient(session.apiClient, channel.id, userId);
            }
          }}
        />
      )}
    </aside>
  );
}
