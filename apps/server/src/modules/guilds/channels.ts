// Channel logic and database access: create, update, delete and reorder.
import { and, eq, inArray } from "drizzle-orm";
import { DispatchEvent, Permission, type ChannelType } from "@mortium/shared";
import type { DbClient } from "../../db/client.js";
import { channels } from "../../db/schema.js";
import { AppError } from "../../errors.js";
import { nextId } from "../../id.js";
import type { GatewayService } from "../gateway/service.js";
import { removeChannelVoice } from "../voice/gateway-ops.js";
import type { VoiceService } from "../voice/service.js";
import { loadMemberContext, loadOverwrites } from "./member-context.js";
import { requirePermission } from "./service.js";
import { toChannelJson } from "./serialize.js";

/** Lowercase, spaces to dashes, and strip anything outside [a-z0-9-_]. */
export function normalizeTextChannelName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_]/g, "");
  if (normalized.length < 1 || normalized.length > 100) {
    throw new AppError(
      400,
      "INVALID_CHANNEL_NAME",
      "The channel name must have 1 to 100 characters after normalization.",
    );
  }
  return normalized;
}

/** Trim a voice or category name and check its length. */
export function normalizeSimpleName(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length < 1 || trimmed.length > 100) {
    throw new AppError(400, "INVALID_CHANNEL_NAME", "The name must have 1 to 100 characters.");
  }
  return trimmed;
}

export function normalizeChannelName(type: ChannelType, raw: string): string {
  return type === "text" ? normalizeTextChannelName(raw) : normalizeSimpleName(raw);
}

async function loadChannelOrThrow(db: DbClient, channelId: bigint) {
  const rows = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
  const channel = rows[0];
  if (!channel || channel.guildId === null) {
    throw new AppError(404, "NOT_FOUND", "This channel does not exist.");
  }
  return channel;
}

async function validateParent(
  db: DbClient,
  guildId: bigint,
  type: ChannelType,
  parentId: bigint | null,
): Promise<void> {
  if (parentId === null) {
    return;
  }
  if (type === "category") {
    throw new AppError(400, "CATEGORY_CANNOT_HAVE_PARENT", "A category channel cannot have a parent.");
  }
  const parentRows = await db.select().from(channels).where(eq(channels.id, parentId)).limit(1);
  const parent = parentRows[0];
  if (!parent || parent.guildId !== guildId || parent.type !== "category") {
    throw new AppError(400, "INVALID_PARENT", "The parent must be a category channel in the same guild.");
  }
}

export interface CreateChannelInput {
  name: string;
  type: ChannelType;
  parentId?: bigint | null;
  topic?: string;
}

export async function createChannel(
  db: DbClient,
  guildId: bigint,
  userId: bigint,
  input: CreateChannelInput,
  gateway?: GatewayService,
) {
  const context = await loadMemberContext(db, guildId, userId);
  if (!context) {
    throw new AppError(404, "NOT_FOUND", "This guild does not exist.");
  }
  requirePermission(context, Permission.MANAGE_CHANNELS);

  const parentId = input.parentId ?? null;
  await validateParent(db, guildId, input.type, parentId);
  const name = normalizeChannelName(input.type, input.name);

  const channelId = nextId();
  await db.insert(channels).values({
    id: channelId,
    guildId,
    type: input.type,
    name,
    topic: input.topic ?? null,
    parentId,
    position: 0,
  });

  const channel = await loadChannelOrThrow(db, channelId);
  if (gateway) {
    const overwrites = await loadOverwrites(db, [channelId]);
    await gateway.toChannelViewers(
      db,
      channelId,
      DispatchEvent.CHANNEL_CREATE,
      toChannelJson(channel, overwrites.get(channelId) ?? []),
    );
  }
  return channel;
}

export interface UpdateChannelInput {
  name?: string;
  topic?: string | null;
  parentId?: bigint | null;
}

export async function updateChannel(
  db: DbClient,
  channelId: bigint,
  userId: bigint,
  input: UpdateChannelInput,
  gateway?: GatewayService,
) {
  const channel = await loadChannelOrThrow(db, channelId);
  const context = await loadMemberContext(db, channel.guildId!, userId);
  if (!context) {
    throw new AppError(404, "NOT_FOUND", "This channel does not exist.");
  }
  requirePermission(context, Permission.MANAGE_CHANNELS);

  const patch: { name?: string; topic?: string | null; parentId?: bigint | null } = {};
  if (input.name !== undefined) {
    patch.name = normalizeChannelName(channel.type as ChannelType, input.name);
  }
  if (input.topic !== undefined) {
    patch.topic = input.topic;
  }
  if (input.parentId !== undefined) {
    await validateParent(db, channel.guildId!, channel.type as ChannelType, input.parentId);
    patch.parentId = input.parentId;
  }

  if (Object.keys(patch).length > 0) {
    await db.update(channels).set(patch).where(eq(channels.id, channelId));
  }
  const updated = await loadChannelOrThrow(db, channelId);
  if (gateway) {
    // A permission-affecting update (parent, and later overwrites in M5)
    // can change who may view the channel; a simple UPDATE is sent to
    // today's viewers, which is right whenever visibility did not change.
    const overwrites = await loadOverwrites(db, [channelId]);
    await gateway.toChannelViewers(
      db,
      channelId,
      DispatchEvent.CHANNEL_UPDATE,
      toChannelJson(updated, overwrites.get(channelId) ?? []),
    );
  }
  return updated;
}

export async function deleteChannel(
  db: DbClient,
  channelId: bigint,
  userId: bigint,
  gateway?: GatewayService,
  voice?: VoiceService,
): Promise<void> {
  const channel = await loadChannelOrThrow(db, channelId);
  const context = await loadMemberContext(db, channel.guildId!, userId);
  if (!context) {
    throw new AppError(404, "NOT_FOUND", "This channel does not exist.");
  }
  requirePermission(context, Permission.MANAGE_CHANNELS);

  // Compute who could see the channel before it is gone: once the DELETE
  // commits, the permission-overwrite rows for this channel cascade away.
  const viewerIds = gateway ? await gateway.computeChannelViewers(db, channel.guildId!, channelId) : [];

  await db.transaction(async (tx) => {
    if (channel.type === "category") {
      await tx.update(channels).set({ parentId: null }).where(eq(channels.parentId, channelId));
    }
    await tx.delete(channels).where(eq(channels.id, channelId));
  });

  gateway?.toUsers(viewerIds, DispatchEvent.CHANNEL_DELETE, {
    id: channelId.toString(),
    guildId: channel.guildId!.toString(),
  });

  if (channel.type === "voice" && gateway && voice) {
    removeChannelVoice({ gateway, voice }, channelId, viewerIds);
  }
}

export interface ChannelOrderEntry {
  id: bigint;
  position: number;
  parentId: bigint | null;
}

export async function reorderChannels(
  db: DbClient,
  guildId: bigint,
  userId: bigint,
  entries: ChannelOrderEntry[],
): Promise<void> {
  const context = await loadMemberContext(db, guildId, userId);
  if (!context) {
    throw new AppError(404, "NOT_FOUND", "This guild does not exist.");
  }
  requirePermission(context, Permission.MANAGE_CHANNELS);

  const guildChannels = await db.select().from(channels).where(eq(channels.guildId, guildId));
  const byId = new Map(guildChannels.map((channel) => [channel.id, channel]));

  const entryIds = entries.map((entry) => entry.id);
  if (new Set(entryIds).size !== entryIds.length) {
    throw new AppError(400, "INVALID_CHANNEL_ORDER", "The order list has a duplicate channel id.");
  }

  for (const entry of entries) {
    const channel = byId.get(entry.id);
    if (!channel) {
      throw new AppError(400, "INVALID_CHANNEL_ORDER", "One of the channel ids is not in this guild.");
    }
    if (entry.parentId !== null) {
      if (channel.type === "category") {
        throw new AppError(400, "CATEGORY_CANNOT_HAVE_PARENT", "A category channel cannot have a parent.");
      }
      const parent = byId.get(entry.parentId);
      if (!parent || parent.type !== "category") {
        throw new AppError(400, "INVALID_PARENT", "The parent must be a category channel in the same guild.");
      }
    }
  }

  await db.transaction(async (tx) => {
    for (const entry of entries) {
      await tx
        .update(channels)
        .set({ position: entry.position, parentId: entry.parentId })
        .where(eq(channels.id, entry.id));
    }
  });
}

// Used by the invite module to check a channel belongs to the guild it claims.
export async function channelsInGuild(db: DbClient, guildId: bigint, ids: bigint[]) {
  if (ids.length === 0) {
    return [];
  }
  return db
    .select()
    .from(channels)
    .where(and(eq(channels.guildId, guildId), inArray(channels.id, ids)));
}
