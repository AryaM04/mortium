// After a role, overwrite, or member-role change, work out which channels
// each affected user gained or lost VIEW_CHANNEL on, and send exactly the
// right CHANNEL_CREATE / CHANNEL_DELETE dispatches. See
// docs/concepts/permissions.md "Where the server uses this".
import { eq } from "drizzle-orm";
import { DispatchEvent, hasPermission, Permission, type OverwriteInput } from "@mortium/shared";
import type { DbClient } from "../../db/client.js";
import { channels, guildMembers } from "../../db/schema.js";
import type { GatewayService } from "../gateway/service.js";
import { revalidateGuildVoice } from "../voice/gateway-ops.js";
import type { VoiceService } from "../voice/service.js";
import { loadGuildPermissionData, loadOverwrites, memberChannelPermissions, type ChannelRow } from "./member-context.js";
import { toChannelJson } from "./serialize.js";

/** Every user id currently a member of the guild. */
export async function loadGuildMemberIds(db: DbClient, guildId: bigint): Promise<bigint[]> {
  const rows = await db.select({ userId: guildMembers.userId }).from(guildMembers).where(eq(guildMembers.guildId, guildId));
  return rows.map((row) => row.userId);
}

/**
 * The channels of the guild that each given user can view now, keyed by
 * user id. A user who is not a member can view no channel. The server loads
 * the guild data once and computes the permissions in memory.
 */
async function loadViewableChannelsByUser(
  db: DbClient,
  guildId: bigint,
  userIds: bigint[],
): Promise<{ viewable: Map<string, ChannelRow[]>; overwrites: Map<bigint, OverwriteInput[]> }> {
  const [data, guildChannels] = await Promise.all([
    loadGuildPermissionData(db, guildId),
    db.select().from(channels).where(eq(channels.guildId, guildId)),
  ]);
  const overwrites = await loadOverwrites(db, guildChannels.map((channel) => channel.id));
  const members = new Set(data?.memberIds ?? []);
  const viewable = new Map<string, ChannelRow[]>();
  for (const userId of userIds) {
    const list =
      data && members.has(userId)
        ? guildChannels.filter((channel) =>
            hasPermission(memberChannelPermissions(data, userId, overwrites.get(channel.id) ?? []), Permission.VIEW_CHANNEL),
          )
        : [];
    viewable.set(userId.toString(), list);
  }
  return { viewable, overwrites };
}

/** Snapshot the set of channel ids each given user can currently view. Call this BEFORE the change commits. */
export async function snapshotViewableChannels(
  db: DbClient,
  guildId: bigint,
  userIds: bigint[],
): Promise<Map<string, Set<string>>> {
  const { viewable } = await loadViewableChannelsByUser(db, guildId, userIds);
  const snapshot = new Map<string, Set<string>>();
  for (const [userId, list] of viewable) {
    snapshot.set(userId, new Set(list.map((channel) => channel.id.toString())));
  }
  return snapshot;
}

export interface VisibilityDeps {
  db: DbClient;
  gateway?: GatewayService;
  voice?: VoiceService;
}

/**
 * Call this AFTER the change that could affect visibility has committed,
 * with the snapshot `snapshotViewableChannels` took before the change. For
 * every user whose viewable channel set changed, sends CHANNEL_CREATE for
 * a channel they gained and CHANNEL_DELETE for one they lost; a channel
 * they can still see gets nothing here (its own CHANNEL_UPDATE, if any, is
 * sent separately). Also revalidates voice, so a user who lost VIEW or
 * CONNECT on their current voice channel is disconnected from it.
 */
export async function notifyVisibilityChanges(
  deps: VisibilityDeps,
  guildId: bigint,
  before: Map<string, Set<string>>,
): Promise<void> {
  const { db, gateway } = deps;
  if (gateway) {
    const userIds = [...before.keys()].map((userId) => BigInt(userId));
    const { viewable, overwrites } = await loadViewableChannelsByUser(db, guildId, userIds);
    for (const [userIdText, beforeIds] of before) {
      const userId = BigInt(userIdText);
      const afterChannels = viewable.get(userIdText) ?? [];
      const afterIds = new Set(afterChannels.map((channel) => channel.id.toString()));

      for (const channel of afterChannels) {
        if (!beforeIds.has(channel.id.toString())) {
          gateway.toUser(
            userId,
            DispatchEvent.CHANNEL_CREATE,
            toChannelJson(channel, overwrites.get(channel.id) ?? []),
          );
        }
      }
      for (const channelIdText of beforeIds) {
        if (!afterIds.has(channelIdText)) {
          gateway.toUser(userId, DispatchEvent.CHANNEL_DELETE, { id: channelIdText, guildId: guildId.toString() });
        }
      }
    }
  }

  if (gateway && deps.voice) {
    await revalidateGuildVoice({ db, gateway, voice: deps.voice }, guildId);
  }
}
