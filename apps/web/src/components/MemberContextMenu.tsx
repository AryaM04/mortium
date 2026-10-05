// The menu opened from a member row: a small profile card, message, add
// friend, change nickname, manage roles, kick, ban, and — for a member currently in
// voice — server mute, server deafen, move and disconnect. Every action
// is shown only when the caller is permitted, per docs/concepts/permissions.md.
import { useEffect, useRef, useState } from "react";
import { hasPermission, Permission, type GuildMemberJson, type RoleJson } from "@mortium/shared";
import {
  addMemberRole,
  applyVoiceModeration,
  banMember,
  buildSelfContext,
  canActOnMember,
  canManageRole,
  kickMember,
  removeMemberRole,
  sendFriendRequest,
  updateMember,
  type SelfContext,
} from "@mortium/client-core";
import { session } from "../lib/session.js";
import { describeError } from "../lib/errors.js";
import { realtimeStore } from "../lib/realtime.js";
import { useRealtime } from "../lib/useRealtime.js";
import { openDmWith } from "../lib/dms.js";
import { currentCrypto } from "../lib/crypto.js";
import { serverUrl } from "../lib/server-url.js";

// A stable fallback: a fresh `[]` on every render would break the store
// subscription (it always looks "changed"), causing a render loop.
const EMPTY_CHANNEL_IDS: string[] = [];

export interface VoiceContext {
  channelId: string;
  serverMute: boolean;
  serverDeaf: boolean;
}

/**
 * The identity state of a user (docs/concepts/olm-megolm.md section 10), and
 * a button that starts a SAS verification. A key trusted on first use is
 * not an error, so it shows a neutral text.
 */
function IdentityRow({ userId }: { userId: string }) {
  const [trust, setTrust] = useState<{ verified: boolean; changed: boolean } | null>(null);
  useEffect(() => {
    const crypto = currentCrypto();
    if (!crypto) {
      return;
    }
    const read = () => void crypto.security.userTrust(userId).then(setTrust).catch(() => undefined);
    read();
    // A verification or an identity change updates the row at once.
    return crypto.security.onChange(read);
  }, [userId]);
  if (!trust) {
    return null;
  }
  return (
    <div className="flex items-center justify-between px-2.5 py-1.5 text-sm">
      <span
        className={
          trust.verified ? "text-success-text" : trust.changed ? "text-danger-text" : "text-muted"
        }
      >
        {trust.changed
          ? "Identity changed"
          : trust.verified
            ? "Identity verified"
            : "Not verified with emojis"}
      </span>
      {!trust.verified && (
        <button
          type="button"
          className="link"
          onClick={() =>
            void currentCrypto()
              ?.verification.requestUser(userId)
              .catch(() => undefined)
          }
        >
          Verify
        </button>
      )}
    </div>
  );
}

function displayName(member: GuildMemberJson): string {
  return member.nickname ?? member.user?.displayName ?? member.userId;
}

export function MemberContextMenu({
  guildId,
  member,
  isTargetOwner,
  voice,
  onClose,
}: {
  guildId: string;
  member: GuildMemberJson;
  isTargetOwner: boolean;
  voice: VoiceContext | null;
  onClose: () => void;
}) {
  const guild = useRealtime((s) => s.guilds[guildId]);
  const selfMember = useRealtime((s) => s.selfMemberByGuild[guildId]);
  const selfUserId = useRealtime((s) => s.selfUserId);
  const roles = useRealtime((s) => s.rolesByGuild[guildId]);
  const voiceChannelIds = useRealtime((s) => s.channelIdsByGuild[guildId] ?? EMPTY_CHANNEL_IDS);
  const channels = useRealtime((s) => s.channels);
  const relationship = useRealtime((s) => s.relationships[member.userId]);
  const [notice, setNotice] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [editingNickname, setEditingNickname] = useState(false);
  const [nickname, setNickname] = useState(member.nickname ?? "");
  const [managingRoles, setManagingRoles] = useState(false);
  const [confirmingBan, setConfirmingBan] = useState(false);
  const [banReason, setBanReason] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [onClose]);

  if (!guild || !selfMember || !roles || !selfUserId) {
    return null;
  }

  const context: SelfContext | null = buildSelfContext(
    {
      guilds: { [guildId]: guild },
      selfMemberByGuild: { [guildId]: selfMember },
      rolesByGuild: { [guildId]: roles },
      selfUserId,
    } as Parameters<typeof buildSelfContext>[0],
    guildId,
  );

  const isSelf = member.userId === selfUserId;
  const canAct = canActOnMember(context, member, isTargetOwner);
  const canChangeNickname = isSelf
    ? hasPermission(context?.guildPermissions ?? 0n, Permission.CHANGE_NICKNAME)
    : canAct && hasPermission(context?.guildPermissions ?? 0n, Permission.MANAGE_NICKNAMES);
  const manageableRoles = roles.filter(
    (role) => role.id !== guildId && canManageRole(context, role),
  );
  const canMute = canAct && hasPermission(context?.guildPermissions ?? 0n, Permission.MUTE_MEMBERS);
  const canDeafen =
    canAct && hasPermission(context?.guildPermissions ?? 0n, Permission.DEAFEN_MEMBERS);
  const canMove = canAct && hasPermission(context?.guildPermissions ?? 0n, Permission.MOVE_MEMBERS);
  const voiceChannels = voiceChannelIds
    .map((id) => channels[id])
    .filter((c) => c?.type === "voice");

  async function run(action: () => Promise<void>) {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={`${displayName(member)} options`}
      className="menu absolute inset-x-0 z-30 p-1.5"
    >
      <div className="mb-1.5 flex items-center gap-2.5 rounded-lg bg-sidebar p-2.5">
        {member.user?.avatarKey ? (
          <img
            src={serverUrl(`/api/v1/avatars/${member.userId}/${member.user.avatarKey}`)}
            alt=""
            className="h-10 w-10 rounded-full object-cover"
          />
        ) : (
          <div
            className="flex h-10 w-10 items-center justify-center rounded-full bg-avatar text-sm font-semibold text-avatar-text"
            aria-hidden="true"
          >
            {displayName(member)[0]?.toUpperCase() ?? "?"}
          </div>
        )}
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{displayName(member)}</div>
          <div className="flex flex-wrap gap-1">
            {roles
              .filter((r) => r.id !== guildId && member.roles.includes(r.id))
              .map((r: RoleJson) => (
                <span
                  key={r.id}
                  className="text-[11px]"
                  style={{ color: `#${r.color.toString(16).padStart(6, "0")}` }}
                >
                  {r.name}
                </span>
              ))}
          </div>
        </div>
      </div>

      {error && (
        <p role="alert" className="mb-2 px-2.5 text-xs text-danger-text">
          {error}
        </p>
      )}

      {notice && (
        <p role="status" className="mb-2 px-2.5 text-xs text-success-text">
          {notice}
        </p>
      )}

      <div className="flex flex-col gap-0.5">
        {!isSelf && (
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              void run(async () => {
                await openDmWith(member.userId);
                onClose();
              })
            }
            className="menu-item"
          >
            Message
          </button>
        )}
        {!isSelf && !relationship && member.user && (
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              void run(async () => {
                const result = await sendFriendRequest(session.apiClient, member.user!.username);
                realtimeStore.getState().applyDispatch({ t: "RELATIONSHIP_ADD", d: result });
                setNotice(
                  result.status === "accepted"
                    ? "You are now friends."
                    : "You sent a friend request.",
                );
              })
            }
            className="menu-item"
          >
            Add friend
          </button>
        )}
        {!isSelf && relationship && relationship.status !== "blocked" && (
          <span className="px-2.5 py-1 text-xs text-muted">
            {relationship.status === "accepted" ? "Friend" : "Friend request pending"}
          </span>
        )}
        {!isSelf && <IdentityRow userId={member.userId} />}
        {canChangeNickname && !editingNickname && (
          <button type="button" onClick={() => setEditingNickname(true)} className="menu-item">
            Change nickname
          </button>
        )}
        {editingNickname && (
          <div className="flex gap-1 px-1">
            <input
              aria-label="Nickname"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              className="field min-w-0 flex-1 px-2 py-1"
            />
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                void run(async () => {
                  await updateMember(session.apiClient, guildId, member.userId, {
                    nickname: nickname.trim() === "" ? null : nickname,
                  });
                  realtimeStore.getState().applyDispatch({
                    t: "GUILD_MEMBER_UPDATE",
                    d: { ...member, nickname: nickname.trim() === "" ? null : nickname },
                  });
                  setEditingNickname(false);
                })
              }
              className="btn btn-primary px-2.5 py-1"
            >
              Save
            </button>
          </div>
        )}

        {manageableRoles.length > 0 && !managingRoles && (
          <button type="button" onClick={() => setManagingRoles(true)} className="menu-item">
            Manage roles
          </button>
        )}
        {managingRoles && (
          <div className="flex flex-col gap-1.5 rounded-lg border border-line p-2">
            {manageableRoles.map((role) => {
              const held = member.roles.includes(role.id);
              return (
                <label key={role.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={held}
                    disabled={pending}
                    onChange={() =>
                      void run(async () => {
                        if (held) {
                          await removeMemberRole(
                            session.apiClient,
                            guildId,
                            member.userId,
                            role.id,
                          );
                        } else {
                          await addMemberRole(session.apiClient, guildId, member.userId, role.id);
                        }
                      })
                    }
                  />
                  {role.name}
                </label>
              );
            })}
            <button
              type="button"
              onClick={() => setManagingRoles(false)}
              className="text-left text-xs link"
            >
              Done
            </button>
          </div>
        )}

        {voice && (
          <>
            {canMute && (
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  void run(() =>
                    applyVoiceModeration(session.apiClient, guildId, member.userId, {
                      mute: !voice.serverMute,
                    }),
                  )
                }
                className="menu-item"
              >
                {voice.serverMute ? "Server unmute" : "Server mute"}
              </button>
            )}
            {canDeafen && (
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  void run(() =>
                    applyVoiceModeration(session.apiClient, guildId, member.userId, {
                      deaf: !voice.serverDeaf,
                    }),
                  )
                }
                className="menu-item"
              >
                {voice.serverDeaf ? "Server undeafen" : "Server deafen"}
              </button>
            )}
            {canMove && voiceChannels.length > 0 && (
              <label className="flex flex-col gap-1 text-sm">
                Move to
                <select
                  defaultValue=""
                  disabled={pending}
                  onChange={(e) => {
                    if (e.target.value) {
                      void run(() =>
                        applyVoiceModeration(session.apiClient, guildId, member.userId, {
                          channelId: e.target.value,
                        }),
                      );
                    }
                  }}
                  className="field px-2 py-1"
                >
                  <option value="" disabled>
                    Choose a channel
                  </option>
                  {voiceChannels.map((c) => (
                    <option key={c!.id} value={c!.id}>
                      {c!.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {canMove && (
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  void run(() =>
                    applyVoiceModeration(session.apiClient, guildId, member.userId, {
                      channelId: null,
                    }),
                  )
                }
                className="menu-item text-danger-text hover:bg-danger-soft"
              >
                Disconnect from voice
              </button>
            )}
          </>
        )}

        {canAct && (
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              void run(async () => {
                await kickMember(session.apiClient, guildId, member.userId);
                realtimeStore.getState().applyDispatch({
                  t: "GUILD_MEMBER_REMOVE",
                  d: { guildId, userId: member.userId },
                });
                onClose();
              })
            }
            className="menu-item text-danger-text hover:bg-danger-soft"
          >
            Kick
          </button>
        )}

        {canAct && !confirmingBan && (
          <button
            type="button"
            onClick={() => setConfirmingBan(true)}
            className="menu-item text-danger-text hover:bg-danger-soft"
          >
            Ban
          </button>
        )}
        {confirmingBan && (
          <div className="flex flex-col gap-1.5 rounded-lg border border-line p-2">
            <input
              aria-label="Ban reason (optional)"
              placeholder="Reason (optional)"
              value={banReason}
              onChange={(e) => setBanReason(e.target.value)}
              className="field px-2 py-1"
            />
            <div className="flex justify-end gap-1">
              <button
                type="button"
                onClick={() => setConfirmingBan(false)}
                className="btn btn-ghost px-2 py-1 text-xs"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  void run(async () => {
                    await banMember(session.apiClient, guildId, member.userId, {
                      reason: banReason || undefined,
                      deleteMessageSeconds: 0,
                    });
                    realtimeStore.getState().applyDispatch({
                      t: "GUILD_MEMBER_REMOVE",
                      d: { guildId, userId: member.userId },
                    });
                    onClose();
                  })
                }
                className="btn btn-danger px-2 py-1 text-xs"
              >
                Ban
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
