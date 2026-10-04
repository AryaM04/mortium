// Access rules for DM and group DM channels. A DM has no guild, no roles and
// no overwrites, so the message and voice code branch here instead of
// building a guild member context. See docs/concepts/dms-and-friends.md.
import { and, eq } from "drizzle-orm";
import { DM_PERMISSIONS } from "@mortium/shared";
import type { DbClient } from "../../db/client.js";
import { channelRecipients, channels } from "../../db/schema.js";
import { AppError } from "../../errors.js";
import { isBlockedEitherWay } from "../friends/service.js";

export type ChannelRow = typeof channels.$inferSelect;

export function isPrivateChannelType(type: string): boolean {
  return type === "dm" || type === "group_dm";
}

/** True when the user is one of the recipients of the DM or group DM. */
export async function isRecipient(db: DbClient, channelId: bigint, userId: bigint): Promise<boolean> {
  const rows = await db
    .select({ userId: channelRecipients.userId })
    .from(channelRecipients)
    .where(and(eq(channelRecipients.channelId, channelId), eq(channelRecipients.userId, userId)))
    .limit(1);
  return rows.length > 0;
}

/** The other user of a 1:1 DM. It reads the pair key, so it needs no query. Returns null for a group DM. */
export function otherUserOfDm(channel: ChannelRow, userId: bigint): bigint | null {
  if (channel.type !== "dm" || channel.dmKey === null) {
    return null;
  }
  const ids = channel.dmKey.split(":").map((part) => BigInt(part));
  return ids.find((id) => id !== userId) ?? null;
}

/** True when the user cannot send events or start a call in this channel because of a block. */
export async function isMessagingBlocked(db: DbClient, channel: ChannelRow, userId: bigint): Promise<boolean> {
  const otherId = otherUserOfDm(channel, userId);
  return otherId !== null && (await isBlockedEitherWay(db, userId, otherId));
}

/** Throw 403 when a block stops the user from sending events in this DM. */
export async function requireCanMessage(db: DbClient, channel: ChannelRow, userId: bigint): Promise<void> {
  if (await isMessagingBlocked(db, channel, userId)) {
    throw new AppError(403, "CANNOT_MESSAGE_USER", "You cannot send messages to this user.");
  }
}

/**
 * Load a DM or group DM for one of its recipients. A user who is not a
 * recipient gets 404, the same answer as for a channel that does not exist.
 */
export async function loadPrivateChannelForRecipient(
  db: DbClient,
  channelId: bigint,
  userId: bigint,
): Promise<ChannelRow> {
  const rows = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
  const channel = rows[0];
  if (!channel || !isPrivateChannelType(channel.type) || !(await isRecipient(db, channelId, userId))) {
    throw new AppError(404, "NOT_FOUND", "This channel does not exist.");
  }
  return channel;
}

/** What every recipient can do in a DM. There is no per-user difference. */
export function dmPermissions(): bigint {
  return DM_PERMISSIONS;
}
