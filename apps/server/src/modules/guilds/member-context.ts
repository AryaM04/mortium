// Load a member's permission context with a small, fixed number of
// queries, and compute guild-level or channel-level permissions from it.
// A caller with no member context is not a guild member: the route must
// answer 404, not 403, so a non-member cannot tell the guild exists.
import { and, eq, inArray } from "drizzle-orm";
import { computePermissions, hasPermission, Permission, type OverwriteInput, type RoleInput } from "@mortium/shared";
import type { DbClient } from "../../db/client.js";
import { channels, guildMembers, guilds, memberRoles, permissionOverwrites, roles } from "../../db/schema.js";
import { AppError } from "../../errors.js";

export type GuildRow = typeof guilds.$inferSelect;
export type ChannelRow = typeof channels.$inferSelect;
export type RoleRow = typeof roles.$inferSelect;

export interface MemberContext {
  guild: GuildRow;
  userId: bigint;
  isOwner: boolean;
  everyoneRole: RoleInput;
  memberRoles: RoleInput[];
  /** Every role in the guild, for building role JSON and checking parent/child rules. */
  allRoles: RoleRow[];
}

/**
 * Load the guild, the caller's roles and ownership flag. Returns null when
 * the guild does not exist, or the caller is not one of its members.
 */
export async function loadMemberContext(
  db: DbClient,
  guildId: bigint,
  userId: bigint,
): Promise<MemberContext | null> {
  const guildRows = await db.select().from(guilds).where(eq(guilds.id, guildId)).limit(1);
  const guild = guildRows[0];
  if (!guild) {
    return null;
  }

  const memberRows = await db
    .select({ userId: guildMembers.userId })
    .from(guildMembers)
    .where(and(eq(guildMembers.guildId, guildId), eq(guildMembers.userId, userId)))
    .limit(1);
  if (!memberRows[0]) {
    return null;
  }

  const allRoles = await db.select().from(roles).where(eq(roles.guildId, guildId));
  const everyoneRoleRow = allRoles.find((role) => role.id === guildId);
  if (!everyoneRoleRow) {
    // Every guild is created with an @everyone role whose id equals the
    // guild id. Its absence means the data is corrupt, not that access
    // should be denied silently.
    throw new Error(`Guild ${guildId} has no @everyone role.`);
  }

  const heldRoleRows = await db
    .select({ roleId: memberRoles.roleId })
    .from(memberRoles)
    .where(and(eq(memberRoles.guildId, guildId), eq(memberRoles.userId, userId)));
  const heldRoleIds = new Set(heldRoleRows.map((row) => row.roleId));

  const memberRolesList: RoleInput[] = allRoles
    .filter((role) => role.id !== everyoneRoleRow.id && heldRoleIds.has(role.id))
    .map((role) => ({ id: role.id, permissions: role.permissions }));

  return {
    guild,
    userId,
    isOwner: guild.ownerId === userId,
    everyoneRole: { id: everyoneRoleRow.id, permissions: everyoneRoleRow.permissions },
    memberRoles: memberRolesList,
    allRoles,
  };
}

/**
 * The permission data of all members of a guild. It lets the server compute
 * the permissions of many members in memory, with no queries for each member.
 */
export interface GuildPermissionData {
  ownerId: bigint;
  everyoneRole: RoleInput;
  memberIds: bigint[];
  /** The roles that each member holds, without @everyone. */
  rolesByMember: Map<bigint, RoleInput[]>;
}

/** Load the permission data of a guild with four queries. Returns null when the guild does not exist. */
export async function loadGuildPermissionData(db: DbClient, guildId: bigint): Promise<GuildPermissionData | null> {
  const [guildRows, roleRows, memberRows, heldRows] = await Promise.all([
    db.select({ ownerId: guilds.ownerId }).from(guilds).where(eq(guilds.id, guildId)).limit(1),
    db.select({ id: roles.id, permissions: roles.permissions }).from(roles).where(eq(roles.guildId, guildId)),
    db.select({ userId: guildMembers.userId }).from(guildMembers).where(eq(guildMembers.guildId, guildId)),
    db.select({ userId: memberRoles.userId, roleId: memberRoles.roleId }).from(memberRoles).where(eq(memberRoles.guildId, guildId)),
  ]);
  const guild = guildRows[0];
  if (!guild) {
    return null;
  }
  const everyoneRole = roleRows.find((role) => role.id === guildId);
  if (!everyoneRole) {
    throw new Error(`Guild ${guildId} has no @everyone role.`);
  }
  const permissionsById = new Map(roleRows.map((role) => [role.id, role.permissions]));
  const rolesByMember = new Map<bigint, RoleInput[]>();
  for (const row of heldRows) {
    const permissions = permissionsById.get(row.roleId);
    if (row.roleId === guildId || permissions === undefined) {
      continue;
    }
    const list = rolesByMember.get(row.userId) ?? [];
    list.push({ id: row.roleId, permissions });
    rolesByMember.set(row.userId, list);
  }
  return {
    ownerId: guild.ownerId,
    everyoneRole,
    memberIds: memberRows.map((row) => row.userId),
    rolesByMember,
  };
}

/** The permissions of one member in one channel, computed from `loadGuildPermissionData`. */
export function memberChannelPermissions(data: GuildPermissionData, memberId: bigint, overwrites: OverwriteInput[]): bigint {
  return computePermissions({
    isOwner: data.ownerId === memberId,
    everyoneRole: data.everyoneRole,
    memberRoles: data.rolesByMember.get(memberId) ?? [],
    overwrites,
    memberId,
  });
}

/** The caller's guild-level permissions: no channel overwrites apply. */
export function guildPermissions(context: MemberContext): bigint {
  return computePermissions({
    isOwner: context.isOwner,
    everyoneRole: context.everyoneRole,
    memberRoles: context.memberRoles,
    overwrites: [],
    memberId: context.userId,
  });
}

/** The caller's permissions in one channel, including its overwrites. */
export async function channelPermissions(
  db: DbClient,
  channelId: bigint,
  context: MemberContext,
): Promise<bigint> {
  const overwrites = await loadOverwrites(db, [channelId]);
  return computePermissions({
    isOwner: context.isOwner,
    everyoneRole: context.everyoneRole,
    memberRoles: context.memberRoles,
    overwrites: overwrites.get(channelId) ?? [],
    memberId: context.userId,
  });
}

export async function loadOverwrites(db: DbClient, channelIds: bigint[]): Promise<Map<bigint, OverwriteInput[]>> {
  if (channelIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .select()
    .from(permissionOverwrites)
    .where(inArray(permissionOverwrites.channelId, channelIds));

  const byChannel = new Map<bigint, OverwriteInput[]>();
  for (const row of rows) {
    const list = byChannel.get(row.channelId) ?? [];
    list.push({ targetId: row.targetId, targetType: row.targetType, allow: row.allow, deny: row.deny });
    byChannel.set(row.channelId, list);
  }
  return byChannel;
}

/** Throw 403 when `permissions` lacks `permission`. Shared by every channel-level check. */
export function requireChannelPermission(permissions: bigint, permission: bigint): void {
  if (!hasPermission(permissions, permission)) {
    throw new AppError(403, "MISSING_PERMISSION", "You do not have permission to do this.");
  }
}

/** Every channel of the guild that the caller can view, in one pass. */
export async function loadViewableChannels(db: DbClient, context: MemberContext): Promise<ChannelRow[]> {
  const allChannels = await db.select().from(channels).where(eq(channels.guildId, context.guild.id));
  const overwrites = await loadOverwrites(db, allChannels.map((channel) => channel.id));

  return allChannels.filter((channel) => {
    const permissions = computePermissions({
      isOwner: context.isOwner,
      everyoneRole: context.everyoneRole,
      memberRoles: context.memberRoles,
      overwrites: overwrites.get(channel.id) ?? [],
      memberId: context.userId,
    });
    return hasPermission(permissions, Permission.VIEW_CHANNEL);
  });
}
