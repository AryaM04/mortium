// Role logic and database access: create, edit, delete, reorder, and
// assign or remove a role on a member. Every mutation enforces the
// hierarchy rules in docs/concepts/permissions.md.
import { and, asc, eq } from "drizzle-orm";
import {
  DispatchEvent,
  MAX_ROLES_PER_GUILD,
  Permission,
  type CreateRoleRequest,
  type RoleOrderRequest,
  type UpdateRoleRequest,
} from "@mortium/shared";
import type { DbClient } from "../../db/client.js";
import { guildMembers, memberRoles, roles } from "../../db/schema.js";
import { AppError } from "../../errors.js";
import { nextId } from "../../id.js";
import type { GatewayService } from "../gateway/service.js";
import type { VoiceService } from "../voice/service.js";
import { highestRolePosition, requireAbovePosition, requireGrantableGuildMask, requireHierarchyOverMember } from "./hierarchy.js";
import { loadMemberContext, type RoleRow } from "./member-context.js";
import { requirePermission } from "./service.js";
import { toRoleJson } from "./serialize.js";
import { loadGuildMemberIds, notifyVisibilityChanges, snapshotViewableChannels } from "./visibility.js";

export interface RolesDeps {
  db: DbClient;
  gateway?: GatewayService;
  voice?: VoiceService;
}

async function loadRoleOrThrow(db: DbClient, guildId: bigint, roleId: bigint): Promise<RoleRow> {
  const rows = await db.select().from(roles).where(and(eq(roles.id, roleId), eq(roles.guildId, guildId))).limit(1);
  const role = rows[0];
  if (!role) {
    throw new AppError(404, "NOT_FOUND", "This role does not exist.");
  }
  return role;
}

function isEveryoneRole(guildId: bigint, roleId: bigint): boolean {
  return roleId === guildId;
}

export async function listRoles(db: DbClient, guildId: bigint, userId: bigint): Promise<RoleRow[]> {
  const context = await loadMemberContext(db, guildId, userId);
  if (!context) {
    throw new AppError(404, "NOT_FOUND", "This guild does not exist.");
  }
  return db.select().from(roles).where(eq(roles.guildId, guildId)).orderBy(asc(roles.position));
}

export async function createRole(deps: RolesDeps, guildId: bigint, userId: bigint, input: CreateRoleRequest) {
  const { db, gateway } = deps;
  const context = await loadMemberContext(db, guildId, userId);
  if (!context) {
    throw new AppError(404, "NOT_FOUND", "This guild does not exist.");
  }
  requirePermission(context, Permission.MANAGE_ROLES);

  const requested = BigInt(input.permissions);
  requireGrantableGuildMask(context, requested);

  const existing = await db.select().from(roles).where(eq(roles.guildId, guildId));
  if (existing.length >= MAX_ROLES_PER_GUILD) {
    throw new AppError(403, "ROLE_LIMIT", `A guild cannot have more than ${MAX_ROLES_PER_GUILD} roles.`);
  }

  // The owner has no explicit "highest role" of their own (they are above
  // every role), so a new role for the owner goes at the very top: just
  // above the current highest role. A non-owner's new role goes just
  // below their own highest role, or at position 1 when that is @everyone.
  const maxExistingPosition = existing.reduce((max, role) => Math.max(max, role.position), 0);
  const actorHighest = context.isOwner ? maxExistingPosition + 1 : highestRolePosition(context);
  const insertPosition = actorHighest === 0 ? 1 : actorHighest;

  const roleId = nextId();
  await db.transaction(async (tx) => {
    for (const role of existing) {
      if (role.id !== guildId && role.position >= insertPosition) {
        await tx.update(roles).set({ position: role.position + 1 }).where(eq(roles.id, role.id));
      }
    }
    await tx.insert(roles).values({
      id: roleId,
      guildId,
      name: input.name,
      color: input.color,
      position: insertPosition,
      permissions: requested,
      mentionable: input.mentionable,
      hoist: input.hoist,
    });
  });

  const role = await loadRoleOrThrow(db, guildId, roleId);
  gateway?.toGuild(guildId, DispatchEvent.GUILD_ROLE_CREATE, { guildId: guildId.toString(), role: toRoleJson(role) });
  return role;
}

export async function updateRole(
  deps: RolesDeps,
  guildId: bigint,
  userId: bigint,
  roleId: bigint,
  input: UpdateRoleRequest,
) {
  const { db, gateway, voice } = deps;
  const context = await loadMemberContext(db, guildId, userId);
  if (!context) {
    throw new AppError(404, "NOT_FOUND", "This guild does not exist.");
  }
  requirePermission(context, Permission.MANAGE_ROLES);

  const role = await loadRoleOrThrow(db, guildId, roleId);
  requireAbovePosition(context, role.position, "Your highest role must be above the role you are editing.");

  const patch: Partial<typeof roles.$inferInsert> = {};
  if (input.name !== undefined) {
    patch.name = input.name;
  }
  if (input.color !== undefined) {
    patch.color = input.color;
  }
  if (input.mentionable !== undefined) {
    patch.mentionable = input.mentionable;
  }
  if (input.hoist !== undefined) {
    patch.hoist = input.hoist;
  }
  let permissionsChanged = false;
  if (input.permissions !== undefined) {
    const requested = BigInt(input.permissions);
    requireGrantableGuildMask(context, requested);
    patch.permissions = requested;
    permissionsChanged = true;
  }

  // A permission change can add or remove VIEW_CHANNEL for every holder of
  // this role (and, for @everyone, every member), so snapshot visibility
  // for the affected members before the change commits.
  const affectedIds = permissionsChanged
    ? isEveryoneRole(guildId, roleId)
      ? await loadGuildMemberIds(db, guildId)
      : (
          await db
            .select({ userId: memberRoles.userId })
            .from(memberRoles)
            .where(and(eq(memberRoles.guildId, guildId), eq(memberRoles.roleId, roleId)))
        ).map((row) => row.userId)
    : [];
  const before = permissionsChanged ? await snapshotViewableChannels(db, guildId, affectedIds) : new Map();

  if (Object.keys(patch).length > 0) {
    await db.update(roles).set(patch).where(eq(roles.id, roleId));
  }

  const updated = await loadRoleOrThrow(db, guildId, roleId);
  gateway?.toGuild(guildId, DispatchEvent.GUILD_ROLE_UPDATE, { guildId: guildId.toString(), role: toRoleJson(updated) });

  if (permissionsChanged) {
    await notifyVisibilityChanges({ db, gateway, voice }, guildId, before);
  }

  return updated;
}

export async function deleteRole(deps: RolesDeps, guildId: bigint, userId: bigint, roleId: bigint): Promise<void> {
  const { db, gateway, voice } = deps;
  const context = await loadMemberContext(db, guildId, userId);
  if (!context) {
    throw new AppError(404, "NOT_FOUND", "This guild does not exist.");
  }
  requirePermission(context, Permission.MANAGE_ROLES);

  const role = await loadRoleOrThrow(db, guildId, roleId);
  if (isEveryoneRole(guildId, roleId)) {
    throw new AppError(400, "EVERYONE_IMMUTABLE", "The @everyone role cannot be deleted.");
  }
  requireAbovePosition(context, role.position, "Your highest role must be above the role you are deleting.");

  const holderRows = await db
    .select({ userId: memberRoles.userId })
    .from(memberRoles)
    .where(and(eq(memberRoles.guildId, guildId), eq(memberRoles.roleId, roleId)));
  const holderIds = holderRows.map((row) => row.userId);
  const before = await snapshotViewableChannels(db, guildId, holderIds);

  await db.delete(roles).where(eq(roles.id, roleId));

  gateway?.toGuild(guildId, DispatchEvent.GUILD_ROLE_DELETE, { guildId: guildId.toString(), roleId: roleId.toString() });
  await notifyVisibilityChanges({ db, gateway, voice }, guildId, before);
}

export async function reorderRoles(
  deps: RolesDeps,
  guildId: bigint,
  userId: bigint,
  entries: RoleOrderRequest,
): Promise<void> {
  const { db, gateway } = deps;
  const context = await loadMemberContext(db, guildId, userId);
  if (!context) {
    throw new AppError(404, "NOT_FOUND", "This guild does not exist.");
  }
  requirePermission(context, Permission.MANAGE_ROLES);

  const entryIds = entries.map((entry) => BigInt(entry.id));
  if (new Set(entryIds.map((id) => id.toString())).size !== entryIds.length) {
    throw new AppError(400, "INVALID_ROLE_ORDER", "The order list has a duplicate role id.");
  }

  const existing = await db.select().from(roles).where(eq(roles.guildId, guildId));
  const byId = new Map(existing.map((role) => [role.id, role]));
  const actorHighest = highestRolePosition(context);

  for (const entry of entries) {
    const roleId = BigInt(entry.id);
    const role = byId.get(roleId);
    if (!role) {
      throw new AppError(400, "INVALID_ROLE_ORDER", "One of the role ids is not in this guild.");
    }
    if (isEveryoneRole(guildId, roleId)) {
      if (entry.position !== 0) {
        throw new AppError(400, "EVERYONE_IMMUTABLE", "The @everyone role cannot move.");
      }
      continue;
    }
    if (entry.position <= 0) {
      throw new AppError(400, "INVALID_ROLE_ORDER", "Only the @everyone role may be at position 0.");
    }
    if (!context.isOwner) {
      if (role.position >= actorHighest || entry.position >= actorHighest) {
        throw new AppError(
          403,
          "MISSING_PERMISSION",
          "You cannot move a role to or above your own highest role.",
        );
      }
    }
  }

  await db.transaction(async (tx) => {
    for (const entry of entries) {
      const roleId = BigInt(entry.id);
      if (isEveryoneRole(guildId, roleId)) {
        continue;
      }
      await tx.update(roles).set({ position: entry.position }).where(eq(roles.id, roleId));
    }
  });

  if (gateway) {
    const updatedRoles = await db.select().from(roles).where(eq(roles.guildId, guildId));
    for (const role of updatedRoles) {
      gateway.toGuild(guildId, DispatchEvent.GUILD_ROLE_UPDATE, { guildId: guildId.toString(), role: toRoleJson(role) });
    }
  }
}

async function loadMemberRoleIds(db: DbClient, guildId: bigint, targetUserId: bigint): Promise<string[]> {
  const rows = await db
    .select({ roleId: memberRoles.roleId })
    .from(memberRoles)
    .where(and(eq(memberRoles.guildId, guildId), eq(memberRoles.userId, targetUserId)));
  return rows.map((row) => row.roleId.toString());
}

async function dispatchMemberUpdate(db: DbClient, gateway: GatewayService | undefined, guildId: bigint, targetUserId: bigint) {
  if (!gateway) {
    return;
  }
  const memberRows = await db
    .select()
    .from(guildMembers)
    .where(and(eq(guildMembers.guildId, guildId), eq(guildMembers.userId, targetUserId)))
    .limit(1);
  const member = memberRows[0];
  if (!member) {
    return;
  }
  const roleIds = await loadMemberRoleIds(db, guildId, targetUserId);
  gateway.toGuild(guildId, DispatchEvent.GUILD_MEMBER_UPDATE, {
    guildId: guildId.toString(),
    userId: targetUserId.toString(),
    nickname: member.nickname,
    joinedAt: member.joinedAt.toISOString(),
    roles: roleIds,
  });
}

/** Grant a role to a member. The actor needs MANAGE_ROLES and hierarchy over both the role and the target. */
export async function addMemberRole(
  deps: RolesDeps,
  guildId: bigint,
  userId: bigint,
  targetUserId: bigint,
  roleId: bigint,
): Promise<void> {
  const { db, gateway, voice } = deps;
  const context = await loadMemberContext(db, guildId, userId);
  if (!context) {
    throw new AppError(404, "NOT_FOUND", "This guild does not exist.");
  }
  requirePermission(context, Permission.MANAGE_ROLES);

  const role = await loadRoleOrThrow(db, guildId, roleId);
  if (isEveryoneRole(guildId, roleId)) {
    throw new AppError(400, "EVERYONE_IMMUTABLE", "Everyone already holds the @everyone role.");
  }
  requireAbovePosition(context, role.position, "Your highest role must be above the role you are assigning.");
  await requireHierarchyOverMember(db, context, targetUserId);

  const before = await snapshotViewableChannels(db, guildId, [targetUserId]);

  await db
    .insert(memberRoles)
    .values({ guildId, userId: targetUserId, roleId })
    .onConflictDoNothing();

  await dispatchMemberUpdate(db, gateway, guildId, targetUserId);
  await notifyVisibilityChanges({ db, gateway, voice }, guildId, before);
}

/** Remove a role from a member. Same permission and hierarchy rules as granting it. */
export async function removeMemberRole(
  deps: RolesDeps,
  guildId: bigint,
  userId: bigint,
  targetUserId: bigint,
  roleId: bigint,
): Promise<void> {
  const { db, gateway, voice } = deps;
  const context = await loadMemberContext(db, guildId, userId);
  if (!context) {
    throw new AppError(404, "NOT_FOUND", "This guild does not exist.");
  }
  requirePermission(context, Permission.MANAGE_ROLES);

  const role = await loadRoleOrThrow(db, guildId, roleId);
  if (isEveryoneRole(guildId, roleId)) {
    throw new AppError(400, "EVERYONE_IMMUTABLE", "The @everyone role cannot be removed.");
  }
  requireAbovePosition(context, role.position, "Your highest role must be above the role you are removing.");
  await requireHierarchyOverMember(db, context, targetUserId);

  const before = await snapshotViewableChannels(db, guildId, [targetUserId]);

  await db
    .delete(memberRoles)
    .where(and(eq(memberRoles.guildId, guildId), eq(memberRoles.userId, targetUserId), eq(memberRoles.roleId, roleId)));

  await dispatchMemberUpdate(db, gateway, guildId, targetUserId);
  await notifyVisibilityChanges({ db, gateway, voice }, guildId, before);
}

/** Set a member's nickname: self needs CHANGE_NICKNAME, on someone else needs MANAGE_NICKNAMES + hierarchy. */
export async function updateMemberNickname(
  deps: RolesDeps,
  guildId: bigint,
  userId: bigint,
  targetUserId: bigint,
  nickname: string | null,
): Promise<void> {
  const { db, gateway } = deps;
  const context = await loadMemberContext(db, guildId, userId);
  if (!context) {
    throw new AppError(404, "NOT_FOUND", "This guild does not exist.");
  }

  if (targetUserId === userId) {
    requirePermission(context, Permission.CHANGE_NICKNAME);
  } else {
    requirePermission(context, Permission.MANAGE_NICKNAMES);
    await requireHierarchyOverMember(db, context, targetUserId);
  }

  const memberRows = await db
    .select({ userId: guildMembers.userId })
    .from(guildMembers)
    .where(and(eq(guildMembers.guildId, guildId), eq(guildMembers.userId, targetUserId)))
    .limit(1);
  if (!memberRows[0]) {
    throw new AppError(404, "NOT_FOUND", "This member does not exist.");
  }

  await db
    .update(guildMembers)
    .set({ nickname })
    .where(and(eq(guildMembers.guildId, guildId), eq(guildMembers.userId, targetUserId)));

  await dispatchMemberUpdate(db, gateway, guildId, targetUserId);
}
