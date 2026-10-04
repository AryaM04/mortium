// Role-hierarchy helpers shared by role, member-role and moderation logic.
// See docs/concepts/permissions.md for the rules these functions enforce.
import { hasPermission, Permission } from "@mortium/shared";
import type { DbClient } from "../../db/client.js";
import { AppError } from "../../errors.js";
import { guildPermissions, loadMemberContext, type MemberContext } from "./member-context.js";

/** The position of the highest role the member holds. @everyone (position 0) always counts. */
export function highestRolePosition(context: MemberContext): number {
  const heldIds = new Set<bigint>([context.everyoneRole.id, ...context.memberRoles.map((role) => role.id)]);
  let max = 0;
  for (const role of context.allRoles) {
    if (heldIds.has(role.id) && role.position > max) {
      max = role.position;
    }
  }
  return max;
}

/**
 * Throw 403 unless the actor may act on a role or a member at `position`:
 * the actor's highest role must be strictly above it. The owner always
 * passes, with no further check.
 */
export function requireAbovePosition(context: MemberContext, position: number, message: string): void {
  if (context.isOwner) {
    return;
  }
  if (highestRolePosition(context) <= position) {
    throw new AppError(403, "MISSING_PERMISSION", message);
  }
}

/**
 * Load the target member's context and throw 403 unless the actor may act
 * on them: the target is not the guild owner, and the target's highest
 * role is strictly below the actor's highest role (the actor's owner
 * status always passes). Returns the target's context for reuse.
 */
export async function requireHierarchyOverMember(
  db: DbClient,
  context: MemberContext,
  targetUserId: bigint,
): Promise<MemberContext> {
  const targetContext = await loadMemberContext(db, context.guild.id, targetUserId);
  if (!targetContext) {
    throw new AppError(404, "NOT_FOUND", "This member does not exist.");
  }
  if (targetContext.isOwner) {
    throw new AppError(403, "MISSING_PERMISSION", "Nobody can act on the guild owner.");
  }
  requireAbovePosition(
    context,
    highestRolePosition(targetContext),
    "Your highest role must be above the target's highest role.",
  );
  return targetContext;
}

/**
 * Throw 403 if `requested` sets a permission bit the actor does not hold
 * in `actorPermissions`. The owner and ADMINISTRATOR always pass, so they
 * can grant any permission.
 */
export function requireGrantableMask(context: MemberContext, actorPermissions: bigint, requested: bigint): void {
  if (context.isOwner) {
    return;
  }
  if (hasPermission(actorPermissions, Permission.ADMINISTRATOR)) {
    return;
  }
  if ((requested & ~actorPermissions) !== 0n) {
    throw new AppError(403, "MISSING_PERMISSION", "You cannot grant a permission you do not have.");
  }
}

/** `requireGrantableMask` at guild scope (no channel overwrites), for role permission edits. */
export function requireGrantableGuildMask(context: MemberContext, requested: bigint): void {
  requireGrantableMask(context, guildPermissions(context), requested);
}
