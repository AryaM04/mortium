// Channel settings > Permissions: list overwrites (roles and members),
// add one, edit its Allow/Neutral/Deny grid (limited to bits the caller
// holds in this channel), and remove it. Loaded only when this tab opens.
import { useMemo, useState } from "react";
import {
  Permission,
  type ChannelJson,
  type PermissionName,
  type PermissionOverwriteJson,
} from "@mortium/shared";
import {
  buildSelfContext,
  canManageRole,
  deleteChannelOverwrite,
  putChannelOverwrite,
  selfChannelPermissions,
} from "@mortium/client-core";
import type { RealtimeState } from "@mortium/client-core";
import { session } from "../lib/session.js";
import { describeError } from "../lib/errors.js";
import { realtimeStore } from "../lib/realtime.js";
import { useRealtime } from "../lib/useRealtime.js";
import {
  CHANNEL_PERMISSION_GROUPS,
  PERMISSION_DESCRIPTIONS,
  permissionLabel,
} from "../lib/permission-meta.js";

type TriState = "allow" | "deny" | "neutral";

function stateOf(allow: bigint, deny: bigint, bit: bigint): TriState {
  if ((allow & bit) !== 0n) return "allow";
  if ((deny & bit) !== 0n) return "deny";
  return "neutral";
}

function nameOf(
  id: string,
  guildId: string,
  roles: { id: string; name: string }[] | undefined,
  members: Record<string, { user?: { displayName: string } }> | undefined,
): string {
  if (id === guildId) return "@everyone";
  const role = roles?.find((r) => r.id === id);
  if (role) return role.name;
  const member = members?.[id];
  return member?.user?.displayName ?? `User ${id}`;
}

export function ChannelPermissionsTab({ channel }: { channel: ChannelJson }) {
  const guild = useRealtime((s) => s.guilds[channel.guildId]);
  const selfMember = useRealtime((s) => s.selfMemberByGuild[channel.guildId]);
  const selfUserId = useRealtime((s) => s.selfUserId);
  const roles = useRealtime((s) => s.rolesByGuild[channel.guildId]);
  const members = useRealtime((s) => s.membersByGuild[channel.guildId]);
  const liveChannel = useRealtime((s) => s.channels[channel.id]) ?? channel;

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [addingRoleId, setAddingRoleId] = useState("");
  const [addingMemberId, setAddingMemberId] = useState("");

  const context = useMemo(() => {
    if (!guild || !selfMember || !roles || !selfUserId) return null;
    const fakeState = {
      guilds: { [channel.guildId]: guild },
      selfMemberByGuild: { [channel.guildId]: selfMember },
      rolesByGuild: { [channel.guildId]: roles },
      channels: { [channel.id]: liveChannel },
      selfUserId,
    } as unknown as RealtimeState;
    return {
      selfContext: buildSelfContext(fakeState, channel.guildId),
      channelPermissions: selfChannelPermissions(fakeState, channel.id),
    };
  }, [guild, selfMember, roles, selfUserId, channel.guildId, channel.id, liveChannel]);

  const grantableMask = context?.channelPermissions ?? 0n;
  const isOwner = context?.selfContext?.isOwner ?? false;
  const canEditChannel = isOwner || (grantableMask & Permission.MANAGE_ROLES) !== 0n;

  const overwrites = liveChannel.permissionOverwrites;
  const key = (o: PermissionOverwriteJson) => `${o.targetType}:${o.targetId}`;
  const selected = overwrites.find((o) => key(o) === selectedKey) ?? null;

  const availableRoles = (roles ?? []).filter(
    (role) =>
      !overwrites.some((o) => o.targetType === "role" && o.targetId === role.id) &&
      canManageRole(context?.selfContext ?? null, role),
  );
  const availableMembers = Object.values(members ?? {}).filter(
    (member) => !overwrites.some((o) => o.targetType === "member" && o.targetId === member.userId),
  );

  // The channel as the store holds it now, not as this render saw it.
  // Gateway events can change it while a request runs.
  function latestChannel(): ChannelJson {
    return (realtimeStore.getState().channels[channel.id] as ChannelJson | undefined) ?? liveChannel;
  }

  async function saveOverwrite(
    targetId: string,
    targetType: "role" | "member",
    allow: bigint,
    deny: bigint,
  ) {
    setPending(true);
    setError(null);
    try {
      await putChannelOverwrite(session.apiClient, channel.id, targetId, {
        type: targetType,
        allow: allow.toString(),
        deny: deny.toString(),
      });
      const current = latestChannel();
      const nextOverwrites = [
        ...current.permissionOverwrites.filter((o) => !(o.targetId === targetId && o.targetType === targetType)),
        { targetId, targetType, allow: allow.toString(), deny: deny.toString() },
      ];
      realtimeStore
        .getState()
        .applyDispatch({
          t: "CHANNEL_UPDATE",
          d: { ...current, permissionOverwrites: nextOverwrites },
        });
      setSelectedKey(`${targetType}:${targetId}`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  async function removeOverwrite(targetId: string, targetType: "role" | "member") {
    setPending(true);
    setError(null);
    try {
      await deleteChannelOverwrite(session.apiClient, channel.id, targetId, targetType);
      const current = latestChannel();
      const nextOverwrites = current.permissionOverwrites.filter(
        (o) => !(o.targetId === targetId && o.targetType === targetType),
      );
      realtimeStore
        .getState()
        .applyDispatch({
          t: "CHANNEL_UPDATE",
          d: { ...current, permissionOverwrites: nextOverwrites },
        });
      setSelectedKey(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  function cycle(current: TriState): TriState {
    if (current === "neutral") return "allow";
    if (current === "allow") return "deny";
    return "neutral";
  }

  function togglePermission(name: PermissionName) {
    if (!selected || !canEditChannel) return;
    const bit = Permission[name];
    const grantable = isOwner || (grantableMask & bit) !== 0n;
    if (!grantable) return;
    let allow = BigInt(selected.allow);
    let deny = BigInt(selected.deny);
    const next = cycle(stateOf(allow, deny, bit));
    allow = next === "allow" ? allow | bit : allow & ~bit;
    deny = next === "deny" ? deny | bit : deny & ~bit;
    void saveOverwrite(selected.targetId, selected.targetType, allow, deny);
  }

  if (!guild || !roles) {
    return (
      <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>
        Loading permissions...
      </p>
    );
  }

  return (
    <div className="flex h-full min-h-0 gap-4">
      <div className="flex w-56 flex-shrink-0 flex-col gap-2 overflow-y-auto">
        {canEditChannel && (
          <div
            className="flex flex-col gap-1 rounded border p-2"
            style={{ borderColor: "var(--color-border)" }}
          >
            {availableRoles.length > 0 && (
              <div className="flex gap-1">
                <select
                  aria-label="Add a role overwrite"
                  value={addingRoleId}
                  onChange={(e) => setAddingRoleId(e.target.value)}
                  className="flex-1 rounded border px-1 py-1 text-xs"
                  style={{
                    backgroundColor: "var(--color-bg-main)",
                    borderColor: "var(--color-border)",
                    color: "var(--color-text-primary)",
                  }}
                >
                  <option value="">Add a role...</option>
                  {availableRoles.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.id === channel.guildId ? "@everyone" : role.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={!addingRoleId || pending}
                  onClick={() => {
                    if (addingRoleId) void saveOverwrite(addingRoleId, "role", 0n, 0n);
                    setAddingRoleId("");
                  }}
                  className="rounded px-2 text-xs"
                  style={{ backgroundColor: "var(--color-accent)", color: "white" }}
                >
                  Add
                </button>
              </div>
            )}
            {availableMembers.length > 0 && (
              <div className="flex gap-1">
                <select
                  aria-label="Add a member overwrite"
                  value={addingMemberId}
                  onChange={(e) => setAddingMemberId(e.target.value)}
                  className="flex-1 rounded border px-1 py-1 text-xs"
                  style={{
                    backgroundColor: "var(--color-bg-main)",
                    borderColor: "var(--color-border)",
                    color: "var(--color-text-primary)",
                  }}
                >
                  <option value="">Add a member...</option>
                  {availableMembers.map((member) => (
                    <option key={member.userId} value={member.userId}>
                      {member.nickname ?? member.user?.displayName ?? member.userId}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={!addingMemberId || pending}
                  onClick={() => {
                    if (addingMemberId) void saveOverwrite(addingMemberId, "member", 0n, 0n);
                    setAddingMemberId("");
                  }}
                  className="rounded px-2 text-xs"
                  style={{ backgroundColor: "var(--color-accent)", color: "white" }}
                >
                  Add
                </button>
              </div>
            )}
          </div>
        )}
        <ul className="flex flex-col gap-0.5">
          {overwrites.map((o) => (
            <li key={key(o)}>
              <button
                type="button"
                onClick={() => setSelectedKey(key(o))}
                className="w-full truncate rounded px-2 py-1.5 text-left text-sm"
                style={{
                  backgroundColor: key(o) === selectedKey ? "var(--color-bg-main)" : "transparent",
                }}
              >
                {o.targetType === "role" ? "@ " : "# "}
                {nameOf(o.targetId, channel.guildId, roles, members)}
              </button>
            </li>
          ))}
          {overwrites.length === 0 && (
            <li className="px-2 text-sm" style={{ color: "var(--color-text-muted)" }}>
              No overwrites yet.
            </li>
          )}
        </ul>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pr-1">
        {error && (
          <p role="alert" className="mb-2 text-sm" style={{ color: "var(--color-danger-text)" }}>
            {error}
          </p>
        )}
        {!selected ? (
          <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>
            Select an overwrite to edit it, or add a role or member.
          </p>
        ) : (
          <>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">
                {nameOf(selected.targetId, channel.guildId, roles, members)}
              </h3>
              {canEditChannel && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => void removeOverwrite(selected.targetId, selected.targetType)}
                  className="rounded px-2 py-1 text-xs"
                  style={{ backgroundColor: "var(--color-danger)", color: "white" }}
                >
                  Remove
                </button>
              )}
            </div>
            {!canEditChannel && (
              <p
                className="mb-3 rounded px-3 py-2 text-sm"
                style={{
                  backgroundColor: "var(--color-bg-main)",
                  color: "var(--color-text-muted)",
                }}
              >
                You need Manage Roles in this channel to edit overwrites.
              </p>
            )}
            <div className="flex flex-col gap-4">
              {CHANNEL_PERMISSION_GROUPS.map((group) => (
                <fieldset key={group.label}>
                  <legend
                    className="mb-1 text-xs font-semibold uppercase"
                    style={{ color: "var(--color-text-muted)" }}
                  >
                    {group.label}
                  </legend>
                  <div className="flex flex-col gap-1.5">
                    {group.permissions.map((name) => {
                      const bit = Permission[name];
                      const value = stateOf(BigInt(selected.allow), BigInt(selected.deny), bit);
                      const grantable = isOwner || (grantableMask & bit) !== 0n;
                      const disabled = !canEditChannel || !grantable || pending;
                      return (
                        <div key={name} className="flex items-center justify-between gap-2 text-sm">
                          <span title={PERMISSION_DESCRIPTIONS[name]}>{permissionLabel(name)}</span>
                          <button
                            type="button"
                            disabled={disabled}
                            onClick={() => togglePermission(name)}
                            title={
                              !grantable
                                ? "You cannot grant a permission you do not have."
                                : PERMISSION_DESCRIPTIONS[name]
                            }
                            aria-label={`${permissionLabel(name)}: ${value}`}
                            className="w-20 rounded px-2 py-1 text-xs font-medium"
                            style={{
                              backgroundColor:
                                value === "allow"
                                  ? "var(--color-success)"
                                  : value === "deny"
                                    ? "var(--color-danger)"
                                    : "var(--color-bg-main)",
                              color: value === "neutral" ? "var(--color-text-muted)" : "white",
                            }}
                          >
                            {value === "allow" ? "Allow" : value === "deny" ? "Deny" : "Neutral"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </fieldset>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
