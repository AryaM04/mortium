// The Friends page of Home: tabs for online friends, all friends, pending
// requests and blocked users, and a form to add a friend by username.
// The app loads this file only when the page opens.
import { useState } from "react";
import {
  acceptFriendRequest,
  ApiError,
  blockUser,
  removeRelationship,
  sendFriendRequest,
} from "@mortium/client-core";
import { usernameSchema, type RelationshipJson, type User } from "@mortium/shared";
import { Avatar } from "./Avatar.js";
import { session } from "../lib/session.js";
import { realtimeStore } from "../lib/realtime.js";
import { useRealtime } from "../lib/useRealtime.js";
import { describeError } from "../lib/errors.js";
import { openDmWith } from "../lib/dms.js";
import { joinVoiceChannel } from "../lib/voice.js";
import { UsersIcon } from "./icons.js";

type Tab = "online" | "all" | "pending" | "blocked" | "add";

const TABS: Array<{ value: Tab; label: string }> = [
  { value: "online", label: "Online" },
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "blocked", label: "Blocked" },
  { value: "add", label: "Add friend" },
];

const PRESENCE_LABEL: Record<string, string> = {
  online: "Online",
  idle: "Idle",
  dnd: "Do not disturb",
  offline: "Offline",
};

/** Clear text for each error code of a friend request. */
const ADD_FRIEND_ERRORS: Record<string, string> = {
  USER_NOT_FOUND: "No user has this username. Check the username and try again.",
  CANNOT_FRIEND_SELF: "You cannot send a friend request to yourself.",
  USER_BLOCKED: "You blocked this user. Unblock the user first.",
  ALREADY_FRIENDS: "You are already friends with this user.",
  REQUEST_ALREADY_SENT: "You already sent a friend request to this user.",
  RATE_LIMITED: "You sent too many friend requests. Wait one minute and try again.",
};

/** Put a relationship from a REST answer into the store at once. The gateway event comes later. */
function applyRelationship(relationship: RelationshipJson): void {
  realtimeStore.getState().applyDispatch({ t: "RELATIONSHIP_ADD", d: relationship });
}

function forgetRelationship(userId: string): void {
  realtimeStore.getState().applyDispatch({ t: "RELATIONSHIP_REMOVE", d: { userId } });
}

function ActionButton({
  label,
  onClick,
  danger,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`btn px-2.5 py-1 text-xs ${danger ? "btn-danger-ghost" : "btn-secondary"}`}
    >
      {label}
    </button>
  );
}

function FriendRow({
  user,
  subtitle,
  children,
}: {
  user: User;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <li
      className="flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-hover"
      data-friend-row={user.username}
    >
      <Avatar user={user} size={32} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{user.displayName}</div>
        <div className="truncate text-xs text-muted">
          @{user.username} · {subtitle}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1">{children}</div>
    </li>
  );
}

/** The actions of an accepted friend. Remove and Block ask for a confirmation first. */
function FriendActions({
  user,
  onError,
}: {
  user: User;
  onError: (message: string | null) => void;
}) {
  const [confirming, setConfirming] = useState<"remove" | "block" | null>(null);

  async function run(action: () => Promise<void>): Promise<void> {
    onError(null);
    try {
      await action();
    } catch (error) {
      onError(describeError(error));
    }
  }

  if (confirming) {
    return (
      <>
        <span className="text-xs">
          {confirming === "remove"
            ? `Remove ${user.displayName} as a friend?`
            : `Block ${user.displayName}?`}
        </span>
        <ActionButton label="Cancel" onClick={() => setConfirming(null)} />
        <ActionButton
          danger
          label={confirming === "remove" ? "Remove" : "Block"}
          onClick={() =>
            void run(async () => {
              if (confirming === "remove") {
                await removeRelationship(session.apiClient, user.id);
                forgetRelationship(user.id);
              } else {
                applyRelationship(await blockUser(session.apiClient, user.id));
              }
              setConfirming(null);
            })
          }
        />
      </>
    );
  }

  return (
    <>
      <ActionButton
        label="Message"
        onClick={() => void run(async () => void (await openDmWith(user.id)))}
      />
      <ActionButton
        label="Start call"
        onClick={() =>
          void run(async () => {
            const channel = await openDmWith(user.id);
            await joinVoiceChannel(null, channel.id);
          })
        }
      />
      <ActionButton danger label="Remove friend" onClick={() => setConfirming("remove")} />
      <ActionButton danger label="Block" onClick={() => setConfirming("block")} />
    </>
  );
}

function AddFriendForm() {
  const [username, setUsername] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = usernameSchema.safeParse(username);
    if (!parsed.success) {
      setResult({
        ok: false,
        text: parsed.error.issues[0]?.message ?? "This username is not valid.",
      });
      return;
    }
    setPending(true);
    setResult(null);
    try {
      const relationship = await sendFriendRequest(session.apiClient, parsed.data);
      applyRelationship(relationship);
      setUsername("");
      setResult({
        ok: true,
        text:
          relationship.status === "accepted"
            ? `You and ${relationship.user.displayName} are now friends.`
            : `You sent a friend request to ${relationship.user.displayName}.`,
      });
    } catch (error) {
      const text = error instanceof ApiError ? ADD_FRIEND_ERRORS[error.code] : undefined;
      setResult({ ok: false, text: text ?? describeError(error) });
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex max-w-2xl flex-col gap-2 p-6">
      <h2 className="text-base font-semibold">Add friend</h2>
      <p className="text-sm text-muted">
        Type the username of the person. The username is not the display name.
      </p>
      <div className="flex gap-2">
        <input
          aria-label="Username"
          placeholder="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="field flex-1"
        />
        <button
          type="submit"
          disabled={pending || username.trim() === ""}
          className="btn btn-primary"
        >
          Send friend request
        </button>
      </div>
      {result && (
        <p
          role={result.ok ? "status" : "alert"}
          className={`text-sm ${result.ok ? "text-success-text" : "text-danger-text"}`}
        >
          {result.text}
        </p>
      )}
    </form>
  );
}

export default function FriendsView() {
  const relationships = useRealtime((s) => s.relationships);
  const presences = useRealtime((s) => s.presences);
  const [tab, setTab] = useState<Tab>("online");
  const [error, setError] = useState<string | null>(null);

  const all = Object.values(relationships).sort((a, b) =>
    a.user.displayName.localeCompare(b.user.displayName),
  );
  const friends = all.filter((r) => r.status === "accepted");
  const online = friends.filter((r) => (presences[r.userId] ?? "offline") !== "offline");
  const pending = all.filter(
    (r) => r.status === "pending_incoming" || r.status === "pending_outgoing",
  );
  const blocked = all.filter((r) => r.status === "blocked");
  const incomingCount = pending.filter((r) => r.status === "pending_incoming").length;

  async function run(action: () => Promise<void>): Promise<void> {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(describeError(err));
    }
  }

  function renderList(list: RelationshipJson[], empty: string) {
    if (list.length === 0) {
      return <p className="p-4 text-sm text-muted">{empty}</p>;
    }
    return (
      <ul className="flex flex-col gap-0.5 p-2">
        {list.map((relationship) => {
          const { user } = relationship;
          if (relationship.status === "accepted") {
            return (
              <FriendRow
                key={user.id}
                user={user}
                subtitle={PRESENCE_LABEL[presences[user.id] ?? "offline"] ?? "Offline"}
              >
                <FriendActions user={user} onError={setError} />
              </FriendRow>
            );
          }
          if (relationship.status === "pending_incoming") {
            return (
              <FriendRow key={user.id} user={user} subtitle="Incoming friend request">
                <ActionButton
                  label="Accept"
                  onClick={() =>
                    void run(async () =>
                      applyRelationship(await acceptFriendRequest(session.apiClient, user.id)),
                    )
                  }
                />
                <ActionButton
                  danger
                  label="Decline"
                  onClick={() =>
                    void run(async () => {
                      await removeRelationship(session.apiClient, user.id);
                      forgetRelationship(user.id);
                    })
                  }
                />
              </FriendRow>
            );
          }
          if (relationship.status === "pending_outgoing") {
            return (
              <FriendRow key={user.id} user={user} subtitle="Outgoing friend request">
                <ActionButton
                  danger
                  label="Cancel"
                  onClick={() =>
                    void run(async () => {
                      await removeRelationship(session.apiClient, user.id);
                      forgetRelationship(user.id);
                    })
                  }
                />
              </FriendRow>
            );
          }
          return (
            <FriendRow key={user.id} user={user} subtitle="Blocked">
              <ActionButton
                label="Unblock"
                onClick={() =>
                  void run(async () => {
                    await removeRelationship(session.apiClient, user.id);
                    forgetRelationship(user.id);
                  })
                }
              />
            </FriendRow>
          );
        })}
      </ul>
    );
  }

  return (
    <main className="panel flex min-w-0 flex-1 flex-col overflow-hidden bg-main">
      <h1 className="sr-only">Friends</h1>
      <div
        role="tablist"
        aria-label="Friends"
        className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-4"
      >
        <span className="mr-3 flex items-center gap-2 font-semibold" aria-hidden="true">
          <UsersIcon className="text-muted" />
          Friends
        </span>
        {TABS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={tab === option.value}
            onClick={() => {
              setTab(option.value);
              setError(null);
            }}
            className={`flex items-center rounded-lg px-2.5 py-1 text-sm font-medium ${
              option.value === "add"
                ? tab === "add"
                  ? "ml-2 bg-accent-soft text-accent-text"
                  : "ml-2 bg-accent text-on-accent hover:bg-accent-hover"
                : tab === option.value
                  ? "bg-active text-primary"
                  : "text-muted hover:bg-hover hover:text-secondary"
            }`}
          >
            {option.label}
            {option.value === "pending" && incomingCount > 0 && (
              <span className="badge ml-1.5">{incomingCount}</span>
            )}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="px-4 pt-2 text-sm text-danger-text">
          {error}
        </p>
      )}
      <div role="tabpanel" className="flex-1 overflow-y-auto">
        {tab === "online" && renderList(online, "No friends are online now.")}
        {tab === "all" &&
          renderList(friends, 'You have no friends yet. Use "Add friend" to send a request.')}
        {tab === "pending" && renderList(pending, "You have no pending friend requests.")}
        {tab === "blocked" && renderList(blocked, "You did not block a user.")}
        {tab === "add" && <AddFriendForm />}
      </div>
    </main>
  );
}
