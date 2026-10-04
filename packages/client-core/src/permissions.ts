// Compute the signed-in user's own permissions from realtime-store data,
// with the shared `computePermissions`. No REST call is needed: READY,
// GUILD_CREATE and CHANNEL_* dispatches all carry what this needs,
// including each channel's permission overwrites.
import {
  computePermissions,
  DM_PERMISSIONS,
  Permission,
  type GuildMemberJson,
  type OverwriteInput,
  type RoleInput,
  type RoleJson,
} from "@mortium/shared";
import type { RealtimeState } from "./realtime-store.js";

function memberContext(
  state: RealtimeState,
  guildId: string,
): {
  isOwner: boolean;
  everyoneRole: RoleInput;
  memberRoles: RoleInput[];
  memberId: bigint;
} | null {
  const guild = state.guilds[guildId];
  const member = state.selfMemberByGuild[guildId];
  const roles = state.rolesByGuild[guildId];
  if (!guild || !member || !roles || !state.selfUserId) {
    return null;
  }
  const everyoneRoleJson = roles.find((role) => role.id === guildId);
  if (!everyoneRoleJson) {
    return null;
  }
  const heldRoleIds = new Set(member.roles);
  const memberRoles: RoleInput[] = roles
    .filter((role) => role.id !== guildId && heldRoleIds.has(role.id))
    .map((role) => ({ id: BigInt(role.id), permissions: BigInt(role.permissions) }));

  return {
    isOwner: guild.ownerId === state.selfUserId,
    everyoneRole: {
      id: BigInt(everyoneRoleJson.id),
      permissions: BigInt(everyoneRoleJson.permissions),
    },
    memberRoles,
    memberId: BigInt(state.selfUserId),
  };
}

/** The caller's guild-level permissions: no channel overwrites apply. */
export function selfGuildPermissions(state: RealtimeState, guildId: string): bigint {
  const context = memberContext(state, guildId);
  if (!context) {
    return 0n;
  }
  return computePermissions({ ...context, overwrites: [] });
}

/** The caller's permissions in one channel, including its overwrites. */
export function selfChannelPermissions(state: RealtimeState, channelId: string): bigint {
  const channel = state.channels[channelId];
  if (!channel) {
    // A DM has no guild, no roles and no overwrites. Every recipient has the same permissions.
    return channelId in state.privateChannels ? DM_PERMISSIONS : 0n;
  }
  const context = memberContext(state, channel.guildId);
  if (!context) {
    return 0n;
  }
  const overwrites: OverwriteInput[] = channel.permissionOverwrites.map((overwrite) => ({
    targetId: BigInt(overwrite.targetId),
    targetType: overwrite.targetType,
    allow: BigInt(overwrite.allow),
    deny: BigInt(overwrite.deny),
  }));
  return computePermissions({ ...context, overwrites });
}

// ---- hierarchy helpers, mirroring apps/server/src/modules/guilds/hierarchy.ts ----

export interface SelfContext {
  guildId: string;
  isOwner: boolean;
  memberId: string;
  /** The highest position among the roles the caller holds (@everyone always counts). */
  highestPosition: number;
  /** The caller's own guild-level permissions: what they may grant elsewhere. */
  guildPermissions: bigint;
  rolesById: Map<string, RoleJson>;
}

/** The highest role position among `heldRoleIds` (plus @everyone, which every member holds). */
function highestPositionOf(
  rolesById: Map<string, RoleJson>,
  guildId: string,
  heldRoleIds: string[],
): number {
  const heldIds = new Set<string>([guildId, ...heldRoleIds]);
  let max = 0;
  for (const role of rolesById.values()) {
    if (heldIds.has(role.id) && role.position > max) {
      max = role.position;
    }
  }
  return max;
}

/** Build the caller's hierarchy context for one guild, or null when the guild is not loaded. */
export function buildSelfContext(state: RealtimeState, guildId: string): SelfContext | null {
  const guild = state.guilds[guildId];
  const member = state.selfMemberByGuild[guildId];
  const roles = state.rolesByGuild[guildId];
  if (!guild || !member || !roles || !state.selfUserId) {
    return null;
  }
  const rolesById = new Map(roles.map((role) => [role.id, role]));
  return {
    guildId,
    isOwner: guild.ownerId === state.selfUserId,
    memberId: state.selfUserId,
    highestPosition: highestPositionOf(rolesById, guildId, member.roles),
    guildPermissions: selfGuildPermissions(state, guildId),
    rolesById,
  };
}

/**
 * Can the caller create, edit, delete or assign/remove `role`? Mirrors the
 * server: needs MANAGE_ROLES, and the role's position must be strictly
 * below the caller's highest role. The owner always passes.
 */
export function canManageRole(context: SelfContext | null, role: RoleJson): boolean {
  if (!context) {
    return false;
  }
  if (context.isOwner) {
    return true;
  }
  if ((context.guildPermissions & Permission.MANAGE_ROLES) === 0n) {
    return false;
  }
  return role.position < context.highestPosition;
}

/**
 * Can the caller act on `member` (kick, ban, change their roles or
 * nickname)? Mirrors the server: nobody can act on the guild owner, and
 * otherwise the target's highest role must be strictly below the caller's.
 * The owner always passes.
 */
export function canActOnMember(
  context: SelfContext | null,
  member: GuildMemberJson,
  isTargetOwner: boolean,
): boolean {
  if (!context) {
    return false;
  }
  if (isTargetOwner) {
    return false;
  }
  if (context.isOwner) {
    return true;
  }
  const targetHighest = highestPositionOf(context.rolesById, context.guildId, member.roles);
  return targetHighest < context.highestPosition;
}

/**
 * Which permission bits the caller may grant right now, through a role's
 * permissions or a channel overwrite's allow/deny. Mirrors the server: the
 * grantable set is exactly the caller's own effective permissions at that
 * scope (owner and ADMINISTRATOR already compute to every permission).
 * Pass `channelId` for a channel overwrite's scope, or omit it for a role's
 * guild-wide scope.
 */
export function grantablePermissions(
  state: RealtimeState,
  guildId: string,
  channelId?: string,
): bigint {
  return channelId
    ? selfChannelPermissions(state, channelId)
    : selfGuildPermissions(state, guildId);
}
