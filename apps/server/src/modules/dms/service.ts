// DM and group DM logic: open, list, add, remove, leave and rename.
// See docs/concepts/dms-and-friends.md for the rules.
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  DispatchEvent,
  MAX_GROUP_DM_MEMBERS,
  type DmChannelJson,
  type VoiceStateUpdatePayload,
} from "@mortium/shared";
import type { DbClient } from "../../db/client.js";
import { channelRecipients, channels, friendships, users } from "../../db/schema.js";
import { AppError } from "../../errors.js";
import { nextId } from "../../id.js";
import { isBlockedEitherWay } from "../friends/service.js";
import type { GatewayService } from "../gateway/service.js";
import type { CallRinger } from "../voice/calls.js";
import { toVoiceStateUpdate, type VoiceService } from "../voice/service.js";
import { toUserJson, type UserRow } from "../users/serialize.js";
import { loadPrivateChannelForRecipient, type ChannelRow } from "./access.js";

export interface DmsDeps {
  db: DbClient;
  gateway?: GatewayService;
  voice?: VoiceService;
  ringer?: CallRinger;
}

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

export function toDmChannelJson(channel: ChannelRow, recipients: UserRow[]): DmChannelJson {
  return {
    id: channel.id.toString(),
    type: channel.type as "dm" | "group_dm",
    name: channel.name,
    ownerId: channel.ownerId?.toString() ?? null,
    recipients: recipients.map((user) => toUserJson(user, { includePrivate: false })),
    lastEventId: channel.lastEventId?.toString() ?? null,
  };
}

/** Build the JSON of many DM channels with one query for all their recipients. */
async function buildDmChannelJsons(db: DbClient, rows: ChannelRow[]): Promise<DmChannelJson[]> {
  if (rows.length === 0) {
    return [];
  }
  const recipientRows = await db
    .select({ channelId: channelRecipients.channelId, user: users })
    .from(channelRecipients)
    .innerJoin(users, eq(users.id, channelRecipients.userId))
    .where(
      inArray(
        channelRecipients.channelId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(asc(channelRecipients.joinedAt), asc(channelRecipients.userId));
  const byChannel = new Map<bigint, UserRow[]>();
  for (const row of recipientRows) {
    const list = byChannel.get(row.channelId) ?? [];
    list.push(row.user);
    byChannel.set(row.channelId, list);
  }
  return rows.map((row) => toDmChannelJson(row, byChannel.get(row.id) ?? []));
}

/** Build the JSON of one DM channel row. */
export async function buildDmChannelJson(db: DbClient, row: ChannelRow): Promise<DmChannelJson> {
  return (await buildDmChannelJsons(db, [row]))[0]!;
}

/** Every DM and group DM of a user. The newest activity comes first. */
export async function listDmChannels(db: DbClient, userId: bigint): Promise<DmChannelJson[]> {
  const rows = await db
    .select({ channel: channels })
    .from(channelRecipients)
    .innerJoin(channels, eq(channels.id, channelRecipients.channelId))
    .where(eq(channelRecipients.userId, userId))
    .orderBy(sql`${channels.lastEventId} desc nulls last`, desc(channels.id));
  return buildDmChannelJsons(
    db,
    rows.map((row) => row.channel),
  );
}

/** True when the channel id is a DM or a group DM. Route code uses it to pick a branch. */
export async function isPrivateChannel(db: DbClient, channelId: bigint): Promise<boolean> {
  const rows = await db.select({ type: channels.type }).from(channels).where(eq(channels.id, channelId)).limit(1);
  return rows[0]?.type === "dm" || rows[0]?.type === "group_dm";
}

async function loadExistingUsers(db: DbClient, ids: bigint[]): Promise<UserRow[]> {
  const rows = await db.select().from(users).where(inArray(users.id, ids));
  if (rows.length !== ids.length) {
    throw new AppError(404, "USER_NOT_FOUND", "One of the users does not exist.");
  }
  return rows;
}

export interface CreateDmResult {
  channel: DmChannelJson;
  /** False when the call found a 1:1 DM that already existed. */
  created: boolean;
}

/**
 * Open a DM. One recipient finds or makes the 1:1 DM of the pair. Two to
 * nine recipients make a new group DM, and each recipient must be a friend
 * of the caller.
 */
export async function createDm(deps: DmsDeps, userId: bigint, recipientIds: bigint[]): Promise<CreateDmResult> {
  if (recipientIds.includes(userId)) {
    throw new AppError(400, "INVALID_RECIPIENTS", "You cannot add yourself as a recipient.");
  }
  if (recipientIds.length === 1) {
    return openOneToOneDm(deps, userId, recipientIds[0]!);
  }
  return createGroupDm(deps, userId, recipientIds);
}

async function openOneToOneDm(deps: DmsDeps, userId: bigint, otherId: bigint): Promise<CreateDmResult> {
  const { db, gateway } = deps;
  const [other] = await loadExistingUsers(db, [otherId]);
  if (!other || (await isBlockedEitherWay(db, userId, otherId))) {
    throw new AppError(403, "CANNOT_MESSAGE_USER", "You cannot send messages to this user.");
  }

  const dmKey = userId < otherId ? `${userId}:${otherId}` : `${otherId}:${userId}`;
  const channelId = nextId();
  const row = await db.transaction(async (tx) => {
    // The unique key on `dm_key` makes parallel requests safe: one insert
    // wins, and the others wait for it and then read its row.
    const inserted = await tx
      .insert(channels)
      .values({ id: channelId, type: "dm", dmKey })
      .onConflictDoNothing({ target: channels.dmKey })
      .returning();
    if (inserted[0]) {
      await tx.insert(channelRecipients).values([
        { channelId, userId },
        { channelId, userId: otherId },
      ]);
      return { channel: inserted[0], created: true };
    }
    const existing = await tx.select().from(channels).where(eq(channels.dmKey, dmKey)).limit(1);
    return { channel: existing[0]!, created: false };
  });

  const channel = await buildDmChannelJson(db, row.channel);
  if (row.created) {
    gateway?.toUsers([userId, otherId], DispatchEvent.CHANNEL_CREATE, channel);
  }
  return { channel, created: row.created };
}

async function createGroupDm(deps: DmsDeps, userId: bigint, recipientIds: bigint[]): Promise<CreateDmResult> {
  const { db, gateway } = deps;
  await loadExistingUsers(db, recipientIds);
  const friendRows = await db
    .select({ otherId: friendships.otherId })
    .from(friendships)
    .where(
      and(eq(friendships.userId, userId), eq(friendships.status, "accepted"), inArray(friendships.otherId, recipientIds)),
    );
  if (friendRows.length !== recipientIds.length) {
    throw new AppError(403, "NOT_FRIENDS", "You can add only your friends to a group DM.");
  }

  const channelId = nextId();
  const created = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(channels)
      .values({ id: channelId, type: "group_dm", ownerId: userId })
      .returning();
    await tx.insert(channelRecipients).values([userId, ...recipientIds].map((id) => ({ channelId, userId: id })));
    return inserted[0]!;
  });

  const channel = await buildDmChannelJson(db, created);
  gateway?.toUsers([userId, ...recipientIds], DispatchEvent.CHANNEL_CREATE, channel);
  return { channel, created: true };
}

/** Load a group DM for one of its recipients. A 1:1 DM has no group rules, so it gets 400. */
async function loadGroupDm(db: DbClient, channelId: bigint, userId: bigint): Promise<ChannelRow> {
  const channel = await loadPrivateChannelForRecipient(db, channelId, userId);
  if (channel.type !== "group_dm") {
    throw new AppError(400, "NOT_GROUP_DM", "This is not a group DM.");
  }
  return channel;
}

async function lockChannel(tx: Tx, channelId: bigint): Promise<void> {
  await tx.execute(sql`select 1 from channels where id = ${channelId} for update`);
}

/** The owner adds a friend to a group DM. */
export async function addRecipient(deps: DmsDeps, userId: bigint, channelId: bigint, targetId: bigint): Promise<void> {
  const { db, gateway } = deps;
  const channel = await loadGroupDm(db, channelId, userId);
  if (channel.ownerId !== userId) {
    throw new AppError(403, "OWNER_ONLY", "Only the group owner can add people.");
  }
  const [target] = await loadExistingUsers(db, [targetId]);
  const friendRows = await db
    .select({ otherId: friendships.otherId })
    .from(friendships)
    .where(and(eq(friendships.userId, userId), eq(friendships.otherId, targetId), eq(friendships.status, "accepted")));
  if (friendRows.length === 0) {
    throw new AppError(403, "NOT_FRIENDS", "You can add only your friends to a group DM.");
  }

  await db.transaction(async (tx) => {
    await lockChannel(tx, channelId);
    const count = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(channelRecipients)
      .where(eq(channelRecipients.channelId, channelId));
    if ((count[0]?.count ?? 0) >= MAX_GROUP_DM_MEMBERS) {
      throw new AppError(409, "GROUP_DM_FULL", `A group DM can have at most ${MAX_GROUP_DM_MEMBERS} people.`);
    }
    const inserted = await tx
      .insert(channelRecipients)
      .values({ channelId, userId: targetId })
      .onConflictDoNothing()
      .returning();
    if (inserted.length === 0) {
      throw new AppError(409, "ALREADY_RECIPIENT", "This user is already in the group DM.");
    }
  });

  if (gateway) {
    const json = await buildDmChannelJson(db, channel);
    gateway.toUser(targetId, DispatchEvent.CHANNEL_CREATE, json);
    const others = json.recipients.map((user) => BigInt(user.id)).filter((id) => id !== targetId);
    gateway.toUsers(others, DispatchEvent.CHANNEL_RECIPIENT_ADD, {
      channelId: channelId.toString(),
      user: toUserJson(target!, { includePrivate: false }),
    });
  }
}

/**
 * Remove a person from a group DM. The owner can remove anyone. Any
 * member can remove themselves, which is a leave. When the owner leaves,
 * the oldest member becomes the owner. When the last member leaves, the
 * group DM ends.
 */
export async function removeRecipient(deps: DmsDeps, userId: bigint, channelId: bigint, targetId: bigint): Promise<void> {
  const { db, gateway } = deps;
  const channel = await loadGroupDm(db, channelId, userId);
  if (targetId !== userId && channel.ownerId !== userId) {
    throw new AppError(403, "OWNER_ONLY", "Only the group owner can remove other people.");
  }

  const outcome = await db.transaction(async (tx) => {
    await lockChannel(tx, channelId);
    const removed = await tx
      .delete(channelRecipients)
      .where(and(eq(channelRecipients.channelId, channelId), eq(channelRecipients.userId, targetId)))
      .returning();
    if (removed.length === 0) {
      throw new AppError(404, "NOT_FOUND", "This user is not in the group DM.");
    }
    const remaining = await tx
      .select({ userId: channelRecipients.userId })
      .from(channelRecipients)
      .where(eq(channelRecipients.channelId, channelId))
      .orderBy(asc(channelRecipients.joinedAt), asc(channelRecipients.userId));
    if (remaining.length === 0) {
      await tx.delete(channels).where(eq(channels.id, channelId));
      return { remainingIds: [] as bigint[], newOwnerId: null };
    }
    let newOwnerId: bigint | null = null;
    if (channel.ownerId === targetId) {
      newOwnerId = remaining[0]!.userId;
      await tx.update(channels).set({ ownerId: newOwnerId }).where(eq(channels.id, channelId));
    }
    return { remainingIds: remaining.map((row) => row.userId), newOwnerId };
  });

  await endCallOfRemovedUser(deps, channelId, targetId, outcome.remainingIds);

  if (!gateway) {
    return;
  }
  gateway.toUser(targetId, DispatchEvent.CHANNEL_DELETE, { id: channelId.toString(), guildId: null });
  gateway.toUsers(outcome.remainingIds, DispatchEvent.CHANNEL_RECIPIENT_REMOVE, {
    channelId: channelId.toString(),
    userId: targetId.toString(),
  });
  if (outcome.newOwnerId !== null) {
    const updated = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
    if (updated[0]) {
      gateway.toUsers(outcome.remainingIds, DispatchEvent.CHANNEL_UPDATE, await buildDmChannelJson(db, updated[0]));
    }
  }
}

/** A person who leaves a group DM must also leave its call. */
async function endCallOfRemovedUser(
  deps: DmsDeps,
  channelId: bigint,
  userId: bigint,
  remainingIds: bigint[],
): Promise<void> {
  const { voice, gateway, ringer } = deps;
  const state = voice?.getUserState(userId);
  if (!voice || !gateway || !state || state.channelId !== channelId) {
    return;
  }
  const removed = voice.removeImmediate(userId, state.deviceId);
  if (!removed) {
    return;
  }
  const leave: VoiceStateUpdatePayload = toVoiceStateUpdate(removed, true);
  gateway.toUsers([userId, ...remainingIds], DispatchEvent.VOICE_STATE_UPDATE, leave);
  if (voice.channelStates(channelId).length === 0) {
    ringer?.stop(channelId);
  }
}

/** Any member of a group DM can rename it. A null name clears the name. */
export async function renameGroupDm(
  deps: DmsDeps,
  userId: bigint,
  channelId: bigint,
  name: string | null | undefined,
): Promise<DmChannelJson> {
  const { db, gateway } = deps;
  const channel = await loadGroupDm(db, channelId, userId);
  if (name !== undefined) {
    await db.update(channels).set({ name }).where(eq(channels.id, channelId));
  }
  const updated = await db.select().from(channels).where(eq(channels.id, channel.id)).limit(1);
  const json = await buildDmChannelJson(db, updated[0]!);
  if (name !== undefined) {
    gateway?.toUsers(
      json.recipients.map((user) => BigInt(user.id)),
      DispatchEvent.CHANNEL_UPDATE,
      json,
    );
  }
  return json;
}

/** The DM channel JSON of every DM of a user, and the calls in progress in them, for READY. */
export async function buildPrivateReadyData(
  db: DbClient,
  voice: VoiceService,
  userId: bigint,
): Promise<{ privateChannels: DmChannelJson[]; privateVoiceStates: VoiceStateUpdatePayload[] }> {
  const privateChannels = await listDmChannels(db, userId);
  const privateVoiceStates = privateChannels.flatMap((channel) =>
    voice.channelStates(BigInt(channel.id)).map((state) => toVoiceStateUpdate(state)),
  );
  return { privateChannels, privateVoiceStates };
}
