// Moderation: kick, ban, unban, list bans, voice moderation, and owner
// transfer. Every action on a target member enforces the hierarchy rules
// in docs/concepts/permissions.md; nobody can act on the guild owner.
import { and, eq, gte, isNull } from "drizzle-orm";
import { DispatchEvent, hasPermission, Permission } from "@mortium/shared";
import type { DbClient } from "../../db/client.js";
import { bans, channels, events, guildMembers, guilds } from "../../db/schema.js";
import { AppError } from "../../errors.js";
import type { GatewayService } from "../gateway/service.js";
import { revalidateGuildVoice } from "../voice/gateway-ops.js";
import { toVoiceStateUpdate, type VoiceService } from "../voice/service.js";
import { requireHierarchyOverMember } from "./hierarchy.js";
import { channelPermissions, guildPermissions, loadMemberContext } from "./member-context.js";
import { requirePermission } from "./service.js";
import { toBanJson } from "./serialize.js";

export interface ModerationDeps {
  db: DbClient;
  gateway?: GatewayService;
  voice?: VoiceService;
}

async function removeMember(db: DbClient, guildId: bigint, targetUserId: bigint): Promise<void> {
  await db.delete(guildMembers).where(and(eq(guildMembers.guildId, guildId), eq(guildMembers.userId, targetUserId)));
}

function afterMemberRemoved(deps: ModerationDeps, guildId: bigint, targetUserId: bigint): void {
  const { gateway, db, voice } = deps;
  if (!gateway) {
    return;
  }
  gateway.toGuild(guildId, DispatchEvent.GUILD_MEMBER_REMOVE, {
    guildId: guildId.toString(),
    userId: targetUserId.toString(),
  });
  gateway.toUser(targetUserId, DispatchEvent.GUILD_DELETE, { id: guildId.toString() });
  gateway.removeUserFromGuild(guildId, targetUserId);
  if (voice) {
    void revalidateGuildVoice({ db, gateway, voice }, guildId);
  }
}

export async function kickMember(deps: ModerationDeps, guildId: bigint, userId: bigint, targetUserId: bigint): Promise<void> {
  const { db } = deps;
  const context = await loadMemberContext(db, guildId, userId);
  if (!context) {
    throw new AppError(404, "NOT_FOUND", "This guild does not exist.");
  }
  requirePermission(context, Permission.KICK_MEMBERS);
  await requireHierarchyOverMember(db, context, targetUserId);

  await removeMember(db, guildId, targetUserId);
  afterMemberRemoved(deps, guildId, targetUserId);
}

/**
 * Redact every event `targetUserId` sent in this guild's text channels in
 * the last `windowSeconds`, and dispatch EVENT_REDACT per channel. Used by
 * `banMember` when the caller asks for `deleteMessageSeconds`.
 */
async function redactRecentEvents(
  deps: ModerationDeps,
  guildId: bigint,
  targetUserId: bigint,
  windowSeconds: number,
): Promise<void> {
  if (windowSeconds <= 0) {
    return;
  }
  const { db, gateway } = deps;
  const since = new Date(Date.now() - windowSeconds * 1000);

  const guildChannels = await db.select().from(channels).where(eq(channels.guildId, guildId));
  const emptyCiphertext = new Uint8Array();

  for (const channel of guildChannels) {
    if (channel.type !== "text") {
      continue;
    }
    const rows = await db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.channelId, channel.id),
          eq(events.senderUserId, targetUserId),
          gte(events.createdAt, since),
          isNull(events.redactedAt),
        ),
      );
    if (rows.length === 0) {
      continue;
    }
    const ids = rows.map((row) => row.id);
    await db.transaction(async (tx) => {
      for (const id of ids) {
        await tx.update(events).set({ redactedAt: new Date(), ciphertext: emptyCiphertext }).where(eq(events.id, id));
      }
    });
    if (gateway) {
      await gateway.toChannelViewers(db, channel.id, DispatchEvent.EVENT_REDACT, {
        channelId: channel.id.toString(),
        ids: ids.map((id) => id.toString()),
      });
    }
  }
}

export async function banMember(
  deps: ModerationDeps,
  guildId: bigint,
  userId: bigint,
  targetUserId: bigint,
  input: { reason?: string; deleteMessageSeconds: number },
): Promise<void> {
  const { db, gateway } = deps;
  const context = await loadMemberContext(db, guildId, userId);
  if (!context) {
    throw new AppError(404, "NOT_FOUND", "This guild does not exist.");
  }
  requirePermission(context, Permission.BAN_MEMBERS);
  await requireHierarchyOverMember(db, context, targetUserId);

  await db
    .insert(bans)
    .values({ guildId, userId: targetUserId, reason: input.reason ?? null, by: userId })
    .onConflictDoUpdate({ target: [bans.guildId, bans.userId], set: { reason: input.reason ?? null, by: userId } });

  await removeMember(db, guildId, targetUserId);
  afterMemberRemoved(deps, guildId, targetUserId);

  if (gateway) {
    await notifyBanWatchers(db, gateway, guildId, DispatchEvent.GUILD_BAN_ADD, {
      guildId: guildId.toString(),
      userId: targetUserId.toString(),
      reason: input.reason ?? null,
      by: userId.toString(),
    });
  }

  await redactRecentEvents(deps, guildId, targetUserId, input.deleteMessageSeconds);
}

/** Send a ban dispatch only to members who currently hold BAN_MEMBERS. */
async function notifyBanWatchers(
  db: DbClient,
  gateway: GatewayService,
  guildId: bigint,
  event: typeof DispatchEvent.GUILD_BAN_ADD | typeof DispatchEvent.GUILD_BAN_REMOVE,
  payload: unknown,
): Promise<void> {
  const memberIds = await db.select({ userId: guildMembers.userId }).from(guildMembers).where(eq(guildMembers.guildId, guildId));
  for (const row of memberIds) {
    const memberContext = await loadMemberContext(db, guildId, row.userId);
    if (memberContext && hasPermission(guildPermissions(memberContext), Permission.BAN_MEMBERS)) {
      gateway.toUser(row.userId, event, payload);
    }
  }
}

export async function unbanMember(deps: ModerationDeps, guildId: bigint, userId: bigint, targetUserId: bigint): Promise<void> {
  const { db, gateway } = deps;
  const context = await loadMemberContext(db, guildId, userId);
  if (!context) {
    throw new AppError(404, "NOT_FOUND", "This guild does not exist.");
  }
  requirePermission(context, Permission.BAN_MEMBERS);

  const rows = await db.select().from(bans).where(and(eq(bans.guildId, guildId), eq(bans.userId, targetUserId))).limit(1);
  if (!rows[0]) {
    throw new AppError(404, "NOT_FOUND", "This user is not banned.");
  }
  await db.delete(bans).where(and(eq(bans.guildId, guildId), eq(bans.userId, targetUserId)));

  if (gateway) {
    await notifyBanWatchers(db, gateway, guildId, DispatchEvent.GUILD_BAN_REMOVE, {
      guildId: guildId.toString(),
      userId: targetUserId.toString(),
    });
  }
}

export async function listBans(db: DbClient, guildId: bigint, userId: bigint) {
  const context = await loadMemberContext(db, guildId, userId);
  if (!context) {
    throw new AppError(404, "NOT_FOUND", "This guild does not exist.");
  }
  requirePermission(context, Permission.BAN_MEMBERS);
  const rows = await db.select().from(bans).where(eq(bans.guildId, guildId));
  return rows.map(toBanJson);
}

export interface VoiceModerationInput {
  mute?: boolean;
  deaf?: boolean;
  /** Present (even when null) to move or disconnect the target from voice. Absent leaves voice untouched. */
  channelId?: bigint | null;
}

export async function applyVoiceModeration(
  deps: ModerationDeps,
  guildId: bigint,
  userId: bigint,
  targetUserId: bigint,
  input: VoiceModerationInput,
): Promise<void> {
  const { db, gateway, voice } = deps;
  if (!voice || !gateway) {
    throw new AppError(500, "INTERNAL_ERROR", "Voice moderation is not available.");
  }
  const context = await loadMemberContext(db, guildId, userId);
  if (!context) {
    throw new AppError(404, "NOT_FOUND", "This guild does not exist.");
  }

  const current = voice.getUserState(targetUserId);
  if (!current || current.guildId !== guildId) {
    throw new AppError(409, "NOT_IN_VOICE", "This member is not in a voice channel of this guild.");
  }

  if (input.mute !== undefined) {
    requirePermission(context, Permission.MUTE_MEMBERS);
  }
  if (input.deaf !== undefined) {
    requirePermission(context, Permission.DEAFEN_MEMBERS);
  }
  if (input.mute !== undefined || input.deaf !== undefined) {
    voice.applyServerModeration(targetUserId, { serverMute: input.mute, serverDeaf: input.deaf });
    const updated = voice.getUserState(targetUserId);
    if (updated) {
      const viewers = await gateway.computeChannelViewers(db, guildId, updated.channelId);
      gateway.toUsers(viewers, DispatchEvent.VOICE_STATE_UPDATE, toVoiceStateUpdate(updated));
    }
  }

  if (input.channelId !== undefined) {
    requirePermission(context, Permission.MOVE_MEMBERS);
    const before = current;
    const oldViewers = await gateway.computeChannelViewers(db, guildId, before.channelId);
    const destinationId: bigint | null = input.channelId;

    if (destinationId === null) {
      const moved = voice.moveUser(targetUserId, null);
      if (moved) {
        gateway.toUsers(oldViewers, DispatchEvent.VOICE_STATE_UPDATE, toVoiceStateUpdate(moved.previous, true));
      }
      return;
    }

    const rows = await db.select().from(channels).where(eq(channels.id, destinationId)).limit(1);
    const destination = rows[0];
    if (!destination || destination.guildId !== guildId || destination.type !== "voice") {
      throw new AppError(400, "INVALID_CHANNEL", "The destination must be a voice channel in this guild.");
    }
    const targetContext = await loadMemberContext(db, guildId, targetUserId);
    const targetPermissions = targetContext ? await channelPermissions(db, destinationId, targetContext) : 0n;
    if (!hasPermission(targetPermissions, Permission.CONNECT)) {
      throw new AppError(403, "MISSING_PERMISSION", "The target cannot connect to the destination channel.");
    }

    const moved = voice.moveUser(targetUserId, destinationId);
    if (moved) {
      gateway.toUsers(oldViewers, DispatchEvent.VOICE_STATE_UPDATE, toVoiceStateUpdate(moved.previous, true));
      if (moved.next) {
        const newViewers = await gateway.computeChannelViewers(db, guildId, destinationId);
        gateway.toUsers(newViewers, DispatchEvent.VOICE_STATE_UPDATE, toVoiceStateUpdate(moved.next));
      }
    }
  }
}

export async function transferOwnership(deps: ModerationDeps, guildId: bigint, userId: bigint, newOwnerId: bigint): Promise<void> {
  const { db, gateway } = deps;
  const rows = await db.select().from(guilds).where(eq(guilds.id, guildId)).limit(1);
  const guild = rows[0];
  if (!guild) {
    throw new AppError(404, "NOT_FOUND", "This guild does not exist.");
  }
  if (guild.ownerId !== userId) {
    throw new AppError(403, "OWNER_ONLY", "Only the guild owner can transfer ownership.");
  }
  const memberRows = await db
    .select({ userId: guildMembers.userId })
    .from(guildMembers)
    .where(and(eq(guildMembers.guildId, guildId), eq(guildMembers.userId, newOwnerId)))
    .limit(1);
  if (!memberRows[0]) {
    throw new AppError(400, "NOT_A_MEMBER", "The new owner must already be a member of this guild.");
  }

  await db.update(guilds).set({ ownerId: newOwnerId }).where(eq(guilds.id, guildId));

  gateway?.toGuild(guildId, DispatchEvent.GUILD_UPDATE, {
    id: guild.id.toString(),
    name: guild.name,
    iconKey: guild.iconKey,
    ownerId: newOwnerId.toString(),
    createdAt: guild.createdAt.toISOString(),
  });
}
