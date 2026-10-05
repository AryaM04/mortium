// Channel permission-overwrite logic: put (create or replace) and delete.
// Editing an overwrite needs MANAGE_ROLES in that channel, and the actor
// may only set allow/deny bits it holds itself in that channel (unless
// admin or owner). See docs/concepts/permissions.md.
import { and, eq } from "drizzle-orm";
import { DispatchEvent, Permission, type PutOverwriteRequest } from "@mortium/shared";
import type { DbClient } from "../../db/client.js";
import { channels, guildMembers, permissionOverwrites, roles } from "../../db/schema.js";
import { AppError } from "../../errors.js";
import type { GatewayService } from "../gateway/service.js";
import type { VoiceService } from "../voice/service.js";
import { requireGrantableMask } from "./hierarchy.js";
import { channelPermissions, loadMemberContext, loadOverwrites, requireChannelPermission } from "./member-context.js";
import { toChannelJson } from "./serialize.js";
import { loadGuildMemberIds, notifyVisibilityChanges, snapshotViewableChannels } from "./visibility.js";

export interface OverwritesDeps {
  db: DbClient;
  gateway?: GatewayService;
  voice?: VoiceService;
}

async function loadChannelOrThrow(db: DbClient, channelId: bigint) {
  const rows = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
  const channel = rows[0];
  if (!channel || channel.guildId === null) {
    throw new AppError(404, "NOT_FOUND", "This channel does not exist.");
  }
  return channel as typeof channel & { guildId: bigint };
}

/** Throw 400 when the target is not a role or a member of this guild. */
async function requireOverwriteTarget(db: DbClient, guildId: bigint, targetId: bigint, type: "role" | "member"): Promise<void> {
  const rows =
    type === "role"
      ? await db
          .select({ id: roles.id })
          .from(roles)
          .where(and(eq(roles.id, targetId), eq(roles.guildId, guildId)))
          .limit(1)
      : await db
          .select({ id: guildMembers.userId })
          .from(guildMembers)
          .where(and(eq(guildMembers.userId, targetId), eq(guildMembers.guildId, guildId)))
          .limit(1);
  if (!rows[0]) {
    throw new AppError(400, "INVALID_TARGET", "The target must be a role or a member of this guild.");
  }
}

export async function putOverwrite(
  deps: OverwritesDeps,
  channelId: bigint,
  userId: bigint,
  targetId: bigint,
  input: PutOverwriteRequest,
) {
  const { db, gateway, voice } = deps;
  const channel = await loadChannelOrThrow(db, channelId);
  const context = await loadMemberContext(db, channel.guildId, userId);
  if (!context) {
    throw new AppError(404, "NOT_FOUND", "This channel does not exist.");
  }
  const actorPermissions = await channelPermissions(db, channelId, context);
  requireChannelPermission(actorPermissions, Permission.MANAGE_ROLES);

  const allow = BigInt(input.allow);
  const deny = BigInt(input.deny);
  requireGrantableMask(context, actorPermissions, allow | deny);

  await requireOverwriteTarget(db, channel.guildId, targetId, input.type);

  const before = await snapshotViewableChannels(db, channel.guildId, await loadGuildMemberIds(db, channel.guildId));

  await db
    .insert(permissionOverwrites)
    .values({ channelId, targetId, targetType: input.type, allow, deny })
    .onConflictDoUpdate({
      target: [permissionOverwrites.channelId, permissionOverwrites.targetId, permissionOverwrites.targetType],
      set: { allow, deny },
    });

  await afterOverwriteChange(db, gateway, voice, channel.guildId, channelId, before);
}

export async function deleteOverwrite(
  deps: OverwritesDeps,
  channelId: bigint,
  userId: bigint,
  targetId: bigint,
  targetType: "role" | "member",
): Promise<void> {
  const { db, gateway, voice } = deps;
  const channel = await loadChannelOrThrow(db, channelId);
  const context = await loadMemberContext(db, channel.guildId, userId);
  if (!context) {
    throw new AppError(404, "NOT_FOUND", "This channel does not exist.");
  }
  const actorPermissions = await channelPermissions(db, channelId, context);
  requireChannelPermission(actorPermissions, Permission.MANAGE_ROLES);

  const before = await snapshotViewableChannels(db, channel.guildId, await loadGuildMemberIds(db, channel.guildId));

  await db
    .delete(permissionOverwrites)
    .where(
      and(
        eq(permissionOverwrites.channelId, channelId),
        eq(permissionOverwrites.targetId, targetId),
        eq(permissionOverwrites.targetType, targetType),
      ),
    );

  await afterOverwriteChange(db, gateway, voice, channel.guildId, channelId, before);
}

async function afterOverwriteChange(
  db: DbClient,
  gateway: GatewayService | undefined,
  voice: VoiceService | undefined,
  guildId: bigint,
  channelId: bigint,
  before: Map<string, Set<string>>,
): Promise<void> {
  // Every viewer of the channel (both before and after) gets a plain
  // CHANNEL_UPDATE; notifyVisibilityChanges below sends CHANNEL_CREATE /
  // CHANNEL_DELETE instead to anyone whose view of this channel flipped.
  if (gateway) {
    const rows = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
    const channel = rows[0];
    if (channel) {
      const overwrites = await loadOverwrites(db, [channelId]);
      await gateway.toChannelViewers(
        db,
        channelId,
        DispatchEvent.CHANNEL_UPDATE,
        toChannelJson(channel, overwrites.get(channelId) ?? []),
      );
    }
  }
  await notifyVisibilityChanges({ db, gateway, voice }, guildId, before);
}
