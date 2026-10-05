// Channel event logic and database access: post, list, redact and read
// state. Routes stay thin and call these functions.
//
// The server never parses `ciphertext`. It only moves the bytes and keeps
// the plaintext routing metadata (channel, sender, relation, codec, times)
// described in docs/concepts/messages.md.
import { and, asc, desc, eq, gt, inArray, isNull, lt, or } from "drizzle-orm";
import {
  computePermissions,
  decodeBase64Url,
  DispatchEvent,
  hasPermission,
  Permission,
  type ChannelMembersResponse,
  type EventCodec,
  type EventRelType,
} from "@mortium/shared";
import { isUniqueViolation, type DbClient } from "../../db/client.js";
import {
  channelRecipients,
  channels,
  events,
  guildMembers,
  guilds,
  memberRoles,
  readStates,
  roles,
} from "../../db/schema.js";
import { AppError } from "../../errors.js";
import { nextId } from "../../id.js";
import type { GatewayService } from "../gateway/service.js";
import { dmPermissions, isPrivateChannelType, isRecipient, requireCanMessage, type ChannelRow } from "../dms/access.js";
import {
  channelPermissions,
  loadMemberContext,
  loadOverwrites,
  requireChannelPermission,
} from "../guilds/member-context.js";
import { toEventJson, type EventRow } from "./serialize.js";

/** Timeline events are the ones that advance a channel's `lastEventId`: a plain message or a reply. */
function isTimelineEvent(row: Pick<EventRow, "relType">): boolean {
  return row.relType === null || row.relType === "reply";
}

/** A channel that can hold events, and what the caller may do in it. */
interface ChannelAccess {
  channel: ChannelRow;
  /** The caller's permissions in the channel. A guild channel loads them on the first call only. */
  permissions(): Promise<bigint>;
}

/**
 * Find the channel and check that the caller may see it. There are two
 * kinds of channel that hold events. A guild text channel uses the member
 * context, the roles and the overwrites. A DM or group DM has no guild:
 * every recipient has the same permissions (see `DM_PERMISSIONS`).
 * A caller who cannot see the channel gets 404.
 */
export async function loadChannelAccess(db: DbClient, channelId: bigint, userId: bigint): Promise<ChannelAccess> {
  const rows = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
  const channel = rows[0];
  if (!channel) {
    throw new AppError(404, "NOT_FOUND", "This channel does not exist.");
  }

  if (isPrivateChannelType(channel.type)) {
    if (!(await isRecipient(db, channelId, userId))) {
      throw new AppError(404, "NOT_FOUND", "This channel does not exist.");
    }
    return { channel, permissions: async () => dmPermissions() };
  }

  if (channel.guildId === null) {
    throw new AppError(404, "NOT_FOUND", "This channel does not exist.");
  }
  if (channel.type !== "text") {
    throw new AppError(400, "CHANNEL_NOT_TEXT", "Only a text channel can hold events.");
  }
  const context = await loadMemberContext(db, channel.guildId, userId);
  if (!context) {
    throw new AppError(404, "NOT_FOUND", "This channel does not exist.");
  }
  let cached: bigint | undefined;
  return {
    channel,
    permissions: async () => {
      cached ??= await channelPermissions(db, channelId, context);
      return cached;
    },
  };
}

async function loadEventInChannel(db: DbClient, channelId: bigint, eventId: bigint): Promise<EventRow> {
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.channelId, channelId)))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new AppError(404, "NOT_FOUND", "This event does not exist.");
  }
  return row;
}

// ---- create -----------------------------------------------------------

export interface CreateEventInput {
  relType?: EventRelType;
  relatesToId?: bigint;
  codec: EventCodec;
  megolmSessionId?: string;
  ciphertext: string;
  nonce: string;
}

export interface CreateEventResult {
  event: EventRow;
  /** False when this call returned an existing event because the (device, nonce) pair was seen before. */
  created: boolean;
}

/**
 * Find the event that this device posted before with this nonce. Returns
 * undefined when no such event exists. Throws 409 when the event is in
 * another channel, because a nonce is unique for each device.
 */
async function findEventByNonce(db: DbClient, channelId: bigint, deviceId: string, nonce: string): Promise<EventRow | undefined> {
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.senderDeviceId, deviceId), eq(events.nonce, nonce)))
    .limit(1);
  const row = rows[0];
  if (row && row.channelId !== channelId) {
    throw new AppError(409, "NONCE_USED", "This device already used this nonce in another channel.");
  }
  return row;
}

export async function createEvent(
  db: DbClient,
  channelId: bigint,
  userId: bigint,
  deviceId: string,
  input: CreateEventInput,
  gateway?: GatewayService,
): Promise<CreateEventResult> {
  const access = await loadChannelAccess(db, channelId, userId);
  const permissions = await access.permissions();
  requireChannelPermission(permissions, Permission.VIEW_CHANNEL);

  const existing = await findEventByNonce(db, channelId, deviceId, input.nonce);
  if (existing) {
    return { event: existing, created: false };
  }

  await requireCanMessage(db, access.channel, userId);

  let target: EventRow | undefined;
  if (input.relatesToId !== undefined) {
    target = await loadEventInChannel(db, channelId, input.relatesToId);
    if (target.redactedAt) {
      throw new AppError(404, "NOT_FOUND", "This event does not exist.");
    }
  }

  if (input.relType === "reaction") {
    requireChannelPermission(permissions, Permission.ADD_REACTIONS);
    requireChannelPermission(permissions, Permission.READ_MESSAGE_HISTORY);
  } else if (input.relType === "edit") {
    if (!target || target.senderUserId !== userId || !isTimelineEvent(target)) {
      throw new AppError(403, "CANNOT_EDIT", "You can only edit your own message.");
    }
  } else {
    // A plain message (relType undefined) or a reply.
    requireChannelPermission(permissions, Permission.SEND_MESSAGES);
  }

  const ciphertextBytes = decodeBase64Url(input.ciphertext);
  const eventId = nextId();
  const relType = input.relType ?? null;
  const isTimeline = relType === null || relType === "reply";

  try {
    await db.transaction(async (tx) => {
      await tx.insert(events).values({
        id: eventId,
        channelId,
        senderUserId: userId,
        senderDeviceId: deviceId,
        relatesToId: input.relatesToId ?? null,
        relType,
        codec: input.codec,
        megolmSessionId: input.megolmSessionId ?? null,
        ciphertext: ciphertextBytes,
        nonce: input.nonce,
      });
      if (isTimeline) {
        await tx.update(channels).set({ lastEventId: eventId }).where(eq(channels.id, channelId));
      }
    });
  } catch (error) {
    // Two concurrent requests can both pass the earlier existence check with
    // the same (device, nonce) pair; the unique index lets only one insert
    // through, and the loser looks up the winner's row instead of failing.
    if (isUniqueViolation(error)) {
      const winner = await findEventByNonce(db, channelId, deviceId, input.nonce);
      if (winner) {
        return { event: winner, created: false };
      }
    }
    throw error;
  }

  const row = await loadEventInChannel(db, channelId, eventId);
  if (gateway) {
    if (isTimelineEvent(row)) {
      gateway.clearTyping(userId, channelId);
    }
    await gateway.toChannelViewers(db, channelId, DispatchEvent.EVENT_CREATE, toEventJson(row));
  }
  return { event: row, created: true };
}

// ---- rate limiting ------------------------------------------------------

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
}

export interface EventRateLimiter {
  check(userId: bigint): RateLimitResult;
}

/**
 * A simple in-memory sliding window: at most `maxEvents` per `windowMs`, per user.
 * At most once per window, a check removes the users with no recent event,
 * so the map does not grow with each user who ever posted.
 */
export function createEventRateLimiter(maxEvents = 10, windowMs = 5000): EventRateLimiter {
  const hits = new Map<string, number[]>();
  let lastSweep = Date.now();
  return {
    check(userId: bigint): RateLimitResult {
      const key = userId.toString();
      const now = Date.now();
      if (now - lastSweep >= windowMs) {
        lastSweep = now;
        for (const [otherKey, list] of hits) {
          if (now - list[list.length - 1]! >= windowMs) {
            hits.delete(otherKey);
          }
        }
      }
      const timestamps = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (timestamps.length >= maxEvents) {
        hits.set(key, timestamps);
        return { allowed: false, retryAfterMs: windowMs - (now - timestamps[0]!) };
      }
      timestamps.push(now);
      hits.set(key, timestamps);
      return { allowed: true, retryAfterMs: 0 };
    },
  };
}

// ---- list ---------------------------------------------------------------

export interface ListEventsInput {
  before?: bigint;
  after?: bigint;
  around?: bigint;
  limit: number;
}

export interface ListEventsResult {
  events: EventRow[];
  relations: EventRow[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

function timelineCondition() {
  return or(isNull(events.relType), eq(events.relType, "reply"));
}

async function fetchTimelinePage(
  db: DbClient,
  channelId: bigint,
  bound: { ltId?: bigint; gtId?: bigint },
  limit: number,
  order: "asc" | "desc",
): Promise<EventRow[]> {
  if (limit <= 0) {
    return [];
  }
  const conditions = [eq(events.channelId, channelId), timelineCondition()];
  if (bound.ltId !== undefined) {
    conditions.push(lt(events.id, bound.ltId));
  }
  if (bound.gtId !== undefined) {
    conditions.push(gt(events.id, bound.gtId));
  }
  return db
    .select()
    .from(events)
    .where(and(...conditions))
    .orderBy(order === "asc" ? asc(events.id) : desc(events.id))
    .limit(limit);
}

async function existsTimelineEvent(db: DbClient, channelId: bigint, direction: "lt" | "gt", id: bigint): Promise<boolean> {
  const conditions = [eq(events.channelId, channelId), timelineCondition()];
  conditions.push(direction === "lt" ? lt(events.id, id) : gt(events.id, id));
  const rows = await db
    .select({ id: events.id })
    .from(events)
    .where(and(...conditions))
    .limit(1);
  return rows.length > 0;
}

async function loadRelations(db: DbClient, channelId: bigint, pageIds: bigint[]): Promise<EventRow[]> {
  if (pageIds.length === 0) {
    return [];
  }
  return db
    .select()
    .from(events)
    .where(
      and(
        eq(events.channelId, channelId),
        inArray(events.relatesToId, pageIds),
        inArray(events.relType, ["edit", "reaction"]),
        isNull(events.redactedAt),
      ),
    );
}

export async function listEvents(
  db: DbClient,
  channelId: bigint,
  userId: bigint,
  input: ListEventsInput,
): Promise<ListEventsResult> {
  const access = await loadChannelAccess(db, channelId, userId);
  const permissions = await access.permissions();
  requireChannelPermission(permissions, Permission.VIEW_CHANNEL);
  requireChannelPermission(permissions, Permission.READ_MESSAGE_HISTORY);

  let page: EventRow[];
  if (input.around !== undefined) {
    const centerRows = await db
      .select()
      .from(events)
      .where(and(eq(events.channelId, channelId), eq(events.id, input.around), timelineCondition()))
      .limit(1);
    const remaining = input.limit - centerRows.length;
    const halfBefore = Math.ceil(remaining / 2);
    const halfAfter = remaining - halfBefore;
    const beforeRows = (await fetchTimelinePage(db, channelId, { ltId: input.around }, halfBefore, "desc")).reverse();
    const afterRows = await fetchTimelinePage(db, channelId, { gtId: input.around }, halfAfter, "asc");
    page = [...beforeRows, ...centerRows, ...afterRows];
  } else if (input.before !== undefined) {
    page = (await fetchTimelinePage(db, channelId, { ltId: input.before }, input.limit, "desc")).reverse();
  } else if (input.after !== undefined) {
    page = await fetchTimelinePage(db, channelId, { gtId: input.after }, input.limit, "asc");
  } else {
    page = (await fetchTimelinePage(db, channelId, {}, input.limit, "desc")).reverse();
  }

  let hasMoreBefore = false;
  let hasMoreAfter = false;
  if (page.length > 0) {
    hasMoreBefore = await existsTimelineEvent(db, channelId, "lt", page[0]!.id);
    hasMoreAfter = await existsTimelineEvent(db, channelId, "gt", page[page.length - 1]!.id);
  } else {
    if (input.before !== undefined) {
      hasMoreBefore = await existsTimelineEvent(db, channelId, "lt", input.before);
    }
    if (input.after !== undefined) {
      hasMoreAfter = await existsTimelineEvent(db, channelId, "gt", input.after);
    }
  }

  const relations = await loadRelations(db, channelId, page.map((row) => row.id));
  return { events: page, relations, hasMoreBefore, hasMoreAfter };
}

// ---- redact ---------------------------------------------------------------

export async function redactEvent(
  db: DbClient,
  channelId: bigint,
  eventId: bigint,
  userId: bigint,
  gateway?: GatewayService,
): Promise<void> {
  const access = await loadChannelAccess(db, channelId, userId);
  const target = await loadEventInChannel(db, channelId, eventId);

  if (target.senderUserId !== userId) {
    if (!isTimelineEvent(target)) {
      throw new AppError(403, "MISSING_PERMISSION", "You do not have permission to do this.");
    }
    // In a DM nobody has MANAGE_MESSAGES, so a person can redact only their own events.
    requireChannelPermission(await access.permissions(), Permission.MANAGE_MESSAGES);
  }

  if (target.redactedAt) {
    return;
  }

  const emptyCiphertext = new Uint8Array();
  const relationIds = await db.transaction(async (tx) => {
    await tx
      .update(events)
      .set({ redactedAt: new Date(), ciphertext: emptyCiphertext })
      .where(eq(events.id, eventId));

    const relations = await tx
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.relatesToId, eventId), isNull(events.redactedAt)));
    const ids = relations.map((row) => row.id);
    if (ids.length > 0) {
      await tx.update(events).set({ redactedAt: new Date(), ciphertext: emptyCiphertext }).where(inArray(events.id, ids));
    }
    return ids;
  });

  if (gateway) {
    await gateway.toChannelViewers(db, channelId, DispatchEvent.EVENT_REDACT, {
      channelId: channelId.toString(),
      ids: [eventId.toString(), ...relationIds.map((id) => id.toString())],
    });
  }
}

// ---- read state -----------------------------------------------------------

export async function updateReadState(
  db: DbClient,
  channelId: bigint,
  userId: bigint,
  deviceId: string,
  eventId: bigint,
  gateway?: GatewayService,
): Promise<void> {
  const access = await loadChannelAccess(db, channelId, userId);
  requireChannelPermission(await access.permissions(), Permission.VIEW_CHANNEL);

  const moved = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(readStates)
      .where(and(eq(readStates.userId, userId), eq(readStates.channelId, channelId)))
      .limit(1);
    const current = rows[0]?.lastReadEventId ?? null;
    if (current !== null && current >= eventId) {
      return false;
    }
    if (rows[0]) {
      await tx
        .update(readStates)
        .set({ lastReadEventId: eventId })
        .where(and(eq(readStates.userId, userId), eq(readStates.channelId, channelId)));
    } else {
      await tx.insert(readStates).values({ userId, channelId, lastReadEventId: eventId });
    }
    return true;
  });

  if (moved && gateway) {
    gateway.toUserExceptDevice(userId, deviceId, DispatchEvent.READ_STATE_UPDATE, {
      channelId: channelId.toString(),
      lastReadEventId: eventId.toString(),
    });
  }
}

// ---- channel members (for the E2EE key share) ----------------------------------

/**
 * The users who can view a channel now, with the roles, the overwrites and
 * the owner, so that the client can check each permission again. The
 * caller must be able to view the channel. The server computes the
 * permissions in memory with three queries, not with queries for each member.
 */
export async function listChannelMembers(db: DbClient, channelId: bigint, userId: bigint): Promise<ChannelMembersResponse> {
  const access = await loadChannelAccess(db, channelId, userId);
  requireChannelPermission(await access.permissions(), Permission.VIEW_CHANNEL);
  const { channel } = access;

  if (channel.guildId === null) {
    const recipients = await db
      .select({ userId: channelRecipients.userId })
      .from(channelRecipients)
      .where(eq(channelRecipients.channelId, channelId));
    return {
      guildId: null,
      ownerId: null,
      roles: [],
      overwrites: [],
      members: recipients.map((row) => ({ userId: row.userId.toString(), roles: [] })),
    };
  }

  const guildId = channel.guildId;
  const [guildRows, roleRows, memberRows, heldRows, overwrites] = await Promise.all([
    db.select({ ownerId: guilds.ownerId }).from(guilds).where(eq(guilds.id, guildId)).limit(1),
    db.select({ id: roles.id, permissions: roles.permissions }).from(roles).where(eq(roles.guildId, guildId)),
    db.select({ userId: guildMembers.userId }).from(guildMembers).where(eq(guildMembers.guildId, guildId)),
    db.select({ userId: memberRoles.userId, roleId: memberRoles.roleId }).from(memberRoles).where(eq(memberRoles.guildId, guildId)),
    loadOverwrites(db, [channelId]),
  ]);
  const ownerId = guildRows[0]?.ownerId ?? null;
  const everyone = roleRows.find((role) => role.id === guildId);
  if (!everyone) {
    throw new Error(`Guild ${guildId} has no @everyone role.`);
  }
  const permissionsById = new Map(roleRows.map((role) => [role.id, role.permissions]));
  const heldByUser = new Map<bigint, bigint[]>();
  for (const row of heldRows) {
    const list = heldByUser.get(row.userId) ?? [];
    list.push(row.roleId);
    heldByUser.set(row.userId, list);
  }
  const channelOverwrites = overwrites.get(channelId) ?? [];

  const members: ChannelMembersResponse["members"] = [];
  for (const { userId: memberId } of memberRows) {
    const held = (heldByUser.get(memberId) ?? []).filter((roleId) => roleId !== guildId && permissionsById.has(roleId));
    const permissions = computePermissions({
      isOwner: ownerId === memberId,
      everyoneRole: { id: everyone.id, permissions: everyone.permissions },
      memberRoles: held.map((roleId) => ({ id: roleId, permissions: permissionsById.get(roleId)! })),
      overwrites: channelOverwrites,
      memberId,
    });
    if (hasPermission(permissions, Permission.VIEW_CHANNEL)) {
      members.push({ userId: memberId.toString(), roles: held.map((roleId) => roleId.toString()) });
    }
  }

  return {
    guildId: guildId.toString(),
    ownerId: ownerId?.toString() ?? null,
    roles: roleRows.map((role) => ({ id: role.id.toString(), permissions: role.permissions.toString() })),
    overwrites: channelOverwrites.map((overwrite) => ({
      targetId: overwrite.targetId.toString(),
      targetType: overwrite.targetType,
      allow: overwrite.allow.toString(),
      deny: overwrite.deny.toString(),
    })),
    members,
  };
}

export async function loadReadStates(db: DbClient, userId: bigint) {
  return db.select().from(readStates).where(eq(readStates.userId, userId));
}

export { toEventJson } from "./serialize.js";
export type { EventRow } from "./serialize.js";
