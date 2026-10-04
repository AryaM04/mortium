// Server settings > Members: search, per-member role chips (add/remove
// only roles the caller can manage), kick, ban, and (owner only) transfer
// ownership. Loaded only when the Members tab opens.
import { useEffect, useMemo, useState } from "react";
import type { GuildMemberJson } from "@mortium/shared";
import {
  addMemberRole,
  banMember,
  buildSelfContext,
  canActOnMember,
  canManageRole,
  kickMember,
  listGuildMembers,
  removeMemberRole,
  transferGuildOwnership,
} from "@mortium/client-core";
import type { RealtimeState } from "@mortium/client-core";
import { session } from "../lib/session.js";
import { describeError } from "../lib/errors.js";
import { realtimeStore } from "../lib/realtime.js";
import { useRealtime } from "../lib/useRealtime.js";

const DELETE_WINDOW_OPTIONS: Array<{ label: string; seconds: number }> = [
  { label: "None", seconds: 0 },
  { label: "Last hour", seconds: 3600 },
  { label: "Last 24 hours", seconds: 86400 },
  { label: "Last 7 days", seconds: 604800 },
];

const PAGE_SIZE = 100;
const LOAD_CAP = 1000;

function displayName(member: GuildMemberJson): string {
  return member.nickname ?? member.user?.displayName ?? member.userId;
}

function RoleMenu({
  guildId,
  member,
  manageableRoles,
  onClose,
}: {
  guildId: string;
  member: GuildMemberJson;
  manageableRoles: { id: string; name: string; color: number }[];
  onClose: () => void;
}) {
  const [pendingRoleId, setPendingRoleId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggleRole(roleId: string, held: boolean) {
    setPendingRoleId(roleId);
    setError(null);
    try {
      if (held) {
        await removeMemberRole(session.apiClient, guildId, member.userId, roleId);
      } else {
        await addMemberRole(session.apiClient, guildId, member.userId, roleId);
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPendingRoleId(null);
    }
  }

  return (
    <div
      role="menu"
      aria-label={`Manage roles for ${displayName(member)}`}
      className="absolute z-10 mt-1 w-56 rounded border p-2 shadow-lg"
      style={{ backgroundColor: "var(--color-bg-main)", borderColor: "var(--color-border)" }}
    >
      <div className="mb-1 flex items-center justify-between">
        <span
          className="text-xs font-semibold uppercase"
          style={{ color: "var(--color-text-muted)" }}
        >
          Roles
        </span>
        <button type="button" onClick={onClose} aria-label="Close" className="text-sm">
          &times;
        </button>
      </div>
      {error && (
        <p role="alert" className="mb-1 text-xs" style={{ color: "var(--color-danger-text)" }}>
          {error}
        </p>
      )}
      <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto">
        {manageableRoles.map((role) => {
          const held = member.roles.includes(role.id);
          return (
            <li key={role.id}>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={held}
                  disabled={pendingRoleId === role.id}
                  onChange={() => void toggleRole(role.id, held)}
                />
                <span
                  aria-hidden="true"
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: `#${role.color.toString(16).padStart(6, "0")}` }}
                />
                {role.name}
              </label>
            </li>
          );
        })}
        {manageableRoles.length === 0 && (
          <li className="text-xs" style={{ color: "var(--color-text-muted)" }}>
            No roles you can manage.
          </li>
        )}
      </ul>
    </div>
  );
}

export function MembersTab({ guildId }: { guildId: string }) {
  const guild = useRealtime((s) => s.guilds[guildId]);
  const selfMember = useRealtime((s) => s.selfMemberByGuild[guildId]);
  const selfUserId = useRealtime((s) => s.selfUserId);
  const roles = useRealtime((s) => s.rolesByGuild[guildId]);
  const members = useRealtime((s) => s.membersByGuild[guildId]);

  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [roleMenuFor, setRoleMenuFor] = useState<string | null>(null);
  const [banTarget, setBanTarget] = useState<GuildMemberJson | null>(null);
  const [banReason, setBanReason] = useState("");
  const [banWindowSeconds, setBanWindowSeconds] = useState(0);
  const [transferTarget, setTransferTarget] = useState<GuildMemberJson | null>(null);
  const [transferConfirmText, setTransferConfirmText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const sessionId = useRealtime((s) => s.sessionId);

  // READY clears the member pages. Load them after each READY, never before the first one.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    async function loadAll() {
      setLoading(true);
      let cursor: string | undefined;
      let loaded = 0;
      for (;;) {
        const page = await listGuildMembers(session.apiClient, guildId, {
          after: cursor,
          limit: PAGE_SIZE,
        });
        if (cancelled) return;
        realtimeStore.getState().addMemberPage(guildId, page.members);
        loaded += page.members.length;
        const last = page.members[page.members.length - 1];
        if (page.members.length < PAGE_SIZE || !last || loaded >= LOAD_CAP) break;
        cursor = last.userId;
      }
      if (!cancelled) setLoading(false);
    }
    void loadAll();
    return () => {
      cancelled = true;
    };
  }, [guildId, sessionId]);

  const context = useMemo(() => {
    if (!guild || !selfMember || !roles || !selfUserId) return null;
    const fakeState = {
      guilds: { [guildId]: guild },
      selfMemberByGuild: { [guildId]: selfMember },
      rolesByGuild: { [guildId]: roles },
      selfUserId,
    } as unknown as RealtimeState;
    return buildSelfContext(fakeState, guildId);
  }, [guild, selfMember, roles, selfUserId, guildId]);

  const manageableRoles = useMemo(
    () => (roles ?? []).filter((role) => role.id !== guildId && canManageRole(context, role)),
    [roles, context, guildId],
  );

  const list = useMemo(() => Object.values(members ?? {}), [members]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (m) => displayName(m).toLowerCase().includes(q) || m.user?.username.toLowerCase().includes(q),
    );
  }, [list, query]);

  if (!guild) {
    return null;
  }

  async function handleKick(member: GuildMemberJson) {
    setBusyUserId(member.userId);
    setError(null);
    try {
      await kickMember(session.apiClient, guildId, member.userId);
      realtimeStore
        .getState()
        .applyDispatch({ t: "GUILD_MEMBER_REMOVE", d: { guildId, userId: member.userId } });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusyUserId(null);
    }
  }

  async function handleBan() {
    if (!banTarget) return;
    setBusyUserId(banTarget.userId);
    setError(null);
    try {
      await banMember(session.apiClient, guildId, banTarget.userId, {
        reason: banReason || undefined,
        deleteMessageSeconds: banWindowSeconds,
      });
      realtimeStore
        .getState()
        .applyDispatch({ t: "GUILD_MEMBER_REMOVE", d: { guildId, userId: banTarget.userId } });
      setBanTarget(null);
      setBanReason("");
      setBanWindowSeconds(0);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusyUserId(null);
    }
  }

  async function handleTransfer() {
    if (!transferTarget || transferConfirmText !== transferTarget.user?.username) return;
    setBusyUserId(transferTarget.userId);
    setError(null);
    try {
      await transferGuildOwnership(session.apiClient, guildId, { userId: transferTarget.userId });
      realtimeStore
        .getState()
        .applyDispatch({ t: "GUILD_UPDATE", d: { ...guild, ownerId: transferTarget.userId } });
      setTransferTarget(null);
      setTransferConfirmText("");
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusyUserId(null);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <input
        aria-label="Search members"
        placeholder="Search members"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="mb-3 w-full rounded border px-3 py-2 text-sm"
        style={{
          backgroundColor: "var(--color-bg-main)",
          borderColor: "var(--color-border)",
          color: "var(--color-text-primary)",
        }}
      />
      {error && (
        <p role="alert" className="mb-2 text-sm" style={{ color: "var(--color-danger-text)" }}>
          {error}
        </p>
      )}
      {loading && (
        <p className="mb-2 text-xs" style={{ color: "var(--color-text-muted)" }}>
          Loading members...
        </p>
      )}
      <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
        {filtered.map((member) => {
          const isTargetOwner = member.userId === guild.ownerId;
          const canAct = canActOnMember(context, member, isTargetOwner);
          const memberRoles = (roles ?? []).filter((r) => member.roles.includes(r.id));
          return (
            <li
              key={member.userId}
              className="flex items-center gap-2 rounded px-2 py-1.5"
              style={{ backgroundColor: "var(--color-bg-main)" }}
            >
              <span className="flex-1 truncate text-sm">
                {displayName(member)}
                {isTargetOwner && (
                  <span className="ml-1 text-xs" style={{ color: "var(--color-text-muted)" }}>
                    (owner)
                  </span>
                )}
              </span>
              <span className="flex flex-wrap gap-1">
                {memberRoles.map((role) => (
                  <span
                    key={role.id}
                    className="rounded-full px-2 py-0.5 text-[11px]"
                    style={{
                      border: `1px solid #${role.color.toString(16).padStart(6, "0")}`,
                      color: "var(--color-text-primary)",
                    }}
                  >
                    {role.name}
                  </span>
                ))}
              </span>
              <div className="relative flex gap-1">
                {manageableRoles.length > 0 && (
                  <>
                    <button
                      type="button"
                      onClick={() =>
                        setRoleMenuFor(roleMenuFor === member.userId ? null : member.userId)
                      }
                      className="rounded px-2 py-1 text-xs"
                      style={{ backgroundColor: "var(--color-bg-sidebar)" }}
                    >
                      Roles
                    </button>
                    {roleMenuFor === member.userId && (
                      <RoleMenu
                        guildId={guildId}
                        member={member}
                        manageableRoles={manageableRoles}
                        onClose={() => setRoleMenuFor(null)}
                      />
                    )}
                  </>
                )}
                {canAct && (
                  <>
                    <button
                      type="button"
                      disabled={busyUserId === member.userId}
                      onClick={() => void handleKick(member)}
                      className="rounded px-2 py-1 text-xs"
                      style={{ backgroundColor: "var(--color-bg-sidebar)" }}
                    >
                      Kick
                    </button>
                    <button
                      type="button"
                      disabled={busyUserId === member.userId}
                      onClick={() => setBanTarget(member)}
                      className="rounded px-2 py-1 text-xs"
                      style={{ backgroundColor: "var(--color-danger)", color: "white" }}
                    >
                      Ban
                    </button>
                  </>
                )}
                {context?.isOwner && !isTargetOwner && (
                  <button
                    type="button"
                    onClick={() => setTransferTarget(member)}
                    className="rounded px-2 py-1 text-xs"
                    style={{ backgroundColor: "var(--color-bg-sidebar)" }}
                  >
                    Transfer ownership
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {banTarget && (
        <div
          className="fixed inset-0 z-20 flex items-center justify-center"
          style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
        >
          <div
            role="dialog"
            aria-label={`Ban ${displayName(banTarget)}`}
            className="w-full max-w-sm rounded-lg border p-4"
            style={{
              backgroundColor: "var(--color-bg-sidebar)",
              borderColor: "var(--color-border)",
            }}
          >
            <h3 className="mb-2 text-sm font-semibold">Ban {displayName(banTarget)}</h3>
            <label className="mb-2 flex flex-col gap-1 text-sm">
              Reason (optional)
              <input
                value={banReason}
                onChange={(e) => setBanReason(e.target.value)}
                className="rounded border px-2 py-1 text-sm"
                style={{
                  backgroundColor: "var(--color-bg-main)",
                  borderColor: "var(--color-border)",
                  color: "var(--color-text-primary)",
                }}
              />
            </label>
            <label className="mb-3 flex flex-col gap-1 text-sm">
              Delete messages from the last
              <select
                value={banWindowSeconds}
                onChange={(e) => setBanWindowSeconds(Number(e.target.value))}
                className="rounded border px-2 py-1 text-sm"
                style={{
                  backgroundColor: "var(--color-bg-main)",
                  borderColor: "var(--color-border)",
                  color: "var(--color-text-primary)",
                }}
              >
                {DELETE_WINDOW_OPTIONS.map((option) => (
                  <option key={option.seconds} value={option.seconds}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setBanTarget(null)}
                className="rounded px-3 py-1.5 text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleBan()}
                className="rounded px-3 py-1.5 text-sm font-medium"
                style={{ backgroundColor: "var(--color-danger)", color: "white" }}
              >
                Ban
              </button>
            </div>
          </div>
        </div>
      )}

      {transferTarget && (
        <div
          className="fixed inset-0 z-20 flex items-center justify-center"
          style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
        >
          <div
            role="dialog"
            aria-label={`Transfer ownership to ${displayName(transferTarget)}`}
            className="w-full max-w-sm rounded-lg border p-4"
            style={{
              backgroundColor: "var(--color-bg-sidebar)",
              borderColor: "var(--color-border)",
            }}
          >
            <h3 className="mb-2 text-sm font-semibold">
              Transfer ownership to {displayName(transferTarget)}
            </h3>
            <p className="mb-2 text-sm">
              This cannot be undone by you alone. Type{" "}
              <strong>{transferTarget.user?.username}</strong> to confirm.
            </p>
            <input
              aria-label={`Type ${transferTarget.user?.username ?? "the username"} to confirm`}
              value={transferConfirmText}
              onChange={(e) => setTransferConfirmText(e.target.value)}
              className="mb-3 w-full rounded border px-2 py-1 text-sm"
              style={{
                backgroundColor: "var(--color-bg-main)",
                borderColor: "var(--color-border)",
                color: "var(--color-text-primary)",
              }}
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setTransferTarget(null)}
                className="rounded px-3 py-1.5 text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={transferConfirmText !== transferTarget.user?.username}
                onClick={() => void handleTransfer()}
                className="rounded px-3 py-1.5 text-sm font-medium"
                style={{ backgroundColor: "var(--color-danger)", color: "white" }}
              >
                Transfer ownership
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
