// Invite logic and database access: create, preview, accept, list, delete.
import { randomInt } from "node:crypto";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { DispatchEvent, Permission } from "@mortium/shared";
import { isUniqueViolation, type DbClient } from "../../db/client.js";
import { bans, channels, guildMembers, guilds, invites, users } from "../../db/schema.js";
import { AppError } from "../../errors.js";
import type { GatewayService } from "../gateway/service.js";
import { loadMemberContext } from "./member-context.js";
import { requirePermission } from "./service.js";
import { channelsInGuild } from "./channels.js";
import { buildGuildView } from "./service.js";
import { toMemberJson } from "./serialize.js";

const CODE_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const CODE_LENGTH = 8;

function generateInviteCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

export interface CreateInviteInput {
  maxAgeSeconds: number;
  maxUses: number;
}

export async function createInvite(
  db: DbClient,
  channelId: bigint,
  userId: bigint,
  input: CreateInviteInput,
) {
  const channelRows = await channelsInGuildOfChannel(db, channelId);
  if (!channelRows) {
    throw new AppError(404, "NOT_FOUND", "This channel does not exist.");
  }
  const { guildId } = channelRows;

  const context = await loadMemberContext(db, guildId, userId);
  if (!context) {
    throw new AppError(404, "NOT_FOUND", "This channel does not exist.");
  }
  requirePermission(context, Permission.CREATE_INVITE);

  const expiresAt = input.maxAgeSeconds === 0 ? null : new Date(Date.now() + input.maxAgeSeconds * 1000);
  const maxUses = input.maxUses === 0 ? null : input.maxUses;

  // Collisions are astronomically unlikely (62^8 codes), but retry once
  // just in case, instead of surfacing a raw database error to the caller.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateInviteCode();
    try {
      await db.insert(invites).values({
        code,
        guildId,
        channelId,
        inviterId: userId,
        maxUses,
        uses: 0,
        expiresAt,
      });
      return loadInviteOrThrow(db, code);
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
    }
  }
  throw new AppError(500, "INTERNAL_ERROR", "Could not generate a unique invite code.");
}

async function channelsInGuildOfChannel(db: DbClient, channelId: bigint) {
  const rows = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
  const row = rows[0];
  if (!row || row.guildId === null) {
    return null;
  }
  return { id: row.id, guildId: row.guildId };
}

async function loadInviteOrThrow(db: DbClient, code: string) {
  const rows = await db.select().from(invites).where(eq(invites.code, code)).limit(1);
  const invite = rows[0];
  if (!invite) {
    throw new AppError(500, "INTERNAL_ERROR", "The invite was not found right after it was made.");
  }
  return invite;
}

function isInviteExpiredOrUsedUp(invite: { expiresAt: Date | null; maxUses: number | null; uses: number }): boolean {
  if (invite.expiresAt && invite.expiresAt.getTime() <= Date.now()) {
    return true;
  }
  if (invite.maxUses !== null && invite.uses >= invite.maxUses) {
    return true;
  }
  return false;
}

export async function getInvitePreview(db: DbClient, code: string) {
  const rows = await db.select().from(invites).where(eq(invites.code, code)).limit(1);
  const invite = rows[0];
  if (!invite || isInviteExpiredOrUsedUp(invite)) {
    throw new AppError(404, "INVITE_NOT_FOUND", "This invite is not valid, expired or fully used.");
  }

  const guildRows = await db.select().from(guilds).where(eq(guilds.id, invite.guildId)).limit(1);
  const guild = guildRows[0];
  const channelRows = await channelsInGuild(db, invite.guildId, [invite.channelId]);
  const channel = channelRows[0];
  const inviterRows = await db.select().from(users).where(eq(users.id, invite.inviterId)).limit(1);
  const inviter = inviterRows[0];
  if (!guild || !channel || !inviter) {
    throw new AppError(404, "INVITE_NOT_FOUND", "This invite is not valid, expired or fully used.");
  }

  const memberCountRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(guildMembers)
    .where(eq(guildMembers.guildId, invite.guildId));

  return {
    code: invite.code,
    guild: { id: guild.id, name: guild.name, iconKey: guild.iconKey },
    channel: { id: channel.id, name: channel.name },
    inviter: {
      id: inviter.id,
      username: inviter.username,
      displayName: inviter.displayName,
      avatarKey: inviter.avatarKey,
    },
    memberCount: memberCountRows[0]?.count ?? 0,
    expiresAt: invite.expiresAt,
  };
}

export async function acceptInvite(db: DbClient, code: string, userId: bigint, gateway?: GatewayService) {
  const rows = await db.select().from(invites).where(eq(invites.code, code)).limit(1);
  const invite = rows[0];
  if (!invite || isInviteExpiredOrUsedUp(invite)) {
    throw new AppError(404, "INVITE_NOT_FOUND", "This invite is not valid, expired or fully used.");
  }

  const banRows = await db
    .select()
    .from(bans)
    .where(and(eq(bans.guildId, invite.guildId), eq(bans.userId, userId)))
    .limit(1);
  if (banRows[0]) {
    throw new AppError(403, "BANNED", "You are banned from this guild.");
  }

  const existingMemberRows = await db
    .select({ userId: guildMembers.userId })
    .from(guildMembers)
    .where(and(eq(guildMembers.guildId, invite.guildId), eq(guildMembers.userId, userId)))
    .limit(1);
  if (existingMemberRows[0]) {
    return buildGuildView(db, invite.guildId, userId);
  }

  // Increment atomically, guarded by the same not-expired/not-used-up
  // condition. Of many parallel accepts, only as many as maxUses allows
  // can match this WHERE clause; the database serializes the rest out.
  const now = new Date();
  const usesCondition =
    invite.maxUses === null ? sql`true` : lt(invites.uses, invite.maxUses);
  const expiryCondition = invite.expiresAt === null ? sql`true` : gt(invites.expiresAt, now);

  const updated = await db
    .update(invites)
    .set({ uses: sql`${invites.uses} + 1` })
    .where(and(eq(invites.code, code), usesCondition, expiryCondition))
    .returning({ code: invites.code });

  if (!updated[0]) {
    throw new AppError(404, "INVITE_NOT_FOUND", "This invite is not valid, expired or fully used.");
  }

  const memberRows = await db
    .insert(guildMembers)
    .values({ guildId: invite.guildId, userId, nickname: null })
    .onConflictDoNothing()
    .returning();
  const memberRow = memberRows[0];

  const view = await buildGuildView(db, invite.guildId, userId);

  if (gateway && memberRow) {
    gateway.addUserToGuild(invite.guildId, userId);
    // Existing members get the new member's profile too, so they can show
    // a name and an avatar without a second request.
    const userRows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const joinedUser = userRows[0];
    gateway.toGuild(
      invite.guildId,
      DispatchEvent.GUILD_MEMBER_ADD,
      toMemberJson(
        {
          ...memberRow,
          username: joinedUser?.username,
          displayName: joinedUser?.displayName,
          avatarKey: joinedUser?.avatarKey,
          statusText: joinedUser?.statusText,
          userCreatedAt: joinedUser?.createdAt,
        },
        [],
      ),
      userId,
    );
    gateway.toUser(userId, DispatchEvent.GUILD_CREATE, view);
    // The new guild is now a shared guild too: tell the other members the
    // joining user's current presence, since they never got it before.
    gateway.notifyConnectionCountChanged(userId);
  }

  return view;
}

export async function listGuildInvites(db: DbClient, guildId: bigint, userId: bigint) {
  const context = await loadMemberContext(db, guildId, userId);
  if (!context) {
    throw new AppError(404, "NOT_FOUND", "This guild does not exist.");
  }
  requirePermission(context, Permission.MANAGE_GUILD);

  return db.select().from(invites).where(eq(invites.guildId, guildId));
}

export async function deleteInvite(db: DbClient, code: string, userId: bigint): Promise<void> {
  const rows = await db.select().from(invites).where(eq(invites.code, code)).limit(1);
  const invite = rows[0];
  if (!invite) {
    throw new AppError(404, "NOT_FOUND", "This invite does not exist.");
  }

  const context = await loadMemberContext(db, invite.guildId, userId);
  if (!context) {
    throw new AppError(404, "NOT_FOUND", "This invite does not exist.");
  }

  const isCreator = invite.inviterId === userId;
  if (!isCreator) {
    requirePermission(context, Permission.MANAGE_GUILD);
  }

  await db.delete(invites).where(eq(invites.code, code));
}
