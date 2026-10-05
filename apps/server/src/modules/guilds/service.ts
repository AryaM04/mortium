// Guild logic and database access. Routes stay thin and call these functions.
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { hasPermission, Permission } from "@mortium/shared";
import { DispatchEvent } from "@mortium/shared";
import type { AppConfig } from "../../config.js";
import type { DbClient } from "../../db/client.js";
import { channels, guildMembers, guilds, memberRoles, permissionOverwrites, roles, users } from "../../db/schema.js";
import { AppError } from "../../errors.js";
import { nextId } from "../../id.js";
import type { GatewayService } from "../gateway/service.js";
import { revalidateGuildVoice } from "../voice/gateway-ops.js";
import { toVoiceStateUpdate, type VoiceService } from "../voice/service.js";
import { deleteIconFile, generateIconKey, saveIconFile } from "./icon.js";
import {
  guildPermissions,
  loadMemberContext,
  loadOverwrites,
  loadViewableChannels,
  type ChannelRow,
  type MemberContext,
} from "./member-context.js";
import { toGuildView, type MemberRow } from "./serialize.js";

export const MAX_OWNED_GUILDS = 100;
export const MAX_JOINED_GUILDS = 200;

// The @everyone role a new guild gets, in one bitmask.
const DEFAULT_EVERYONE_PERMISSIONS =
  Permission.VIEW_CHANNEL |
  Permission.SEND_MESSAGES |
  Permission.READ_MESSAGE_HISTORY |
  Permission.ADD_REACTIONS |
  Permission.ATTACH_FILES |
  Permission.CREATE_INVITE |
  Permission.CONNECT |
  Permission.SPEAK |
  Permission.VIDEO |
  Permission.STREAM |
  Permission.CHANGE_NICKNAME;

export interface GuildsDeps {
  db: DbClient;
  config: AppConfig;
  gateway?: GatewayService;
  voice?: VoiceService;
}

const memberSelectColumns = {
  guildId: guildMembers.guildId,
  userId: guildMembers.userId,
  nickname: guildMembers.nickname,
  joinedAt: guildMembers.joinedAt,
  username: users.username,
  displayName: users.displayName,
  avatarKey: users.avatarKey,
  statusText: users.statusText,
  userCreatedAt: users.createdAt,
};

/** Load the caller's own member row with the user profile, as a member list page does. */
async function loadOwnMemberRow(db: DbClient, guildId: bigint, userId: bigint): Promise<MemberRow> {
  const rows = await db
    .select(memberSelectColumns)
    .from(guildMembers)
    .innerJoin(users, eq(users.id, guildMembers.userId))
    .where(and(eq(guildMembers.guildId, guildId), eq(guildMembers.userId, userId)))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new AppError(500, "INTERNAL_ERROR", "The member row was not found right after it was made.");
  }
  return row;
}

/**
 * Build the full guild view (guild, roles, viewable channels, own member,
 * and the live voice states of the caller's viewable voice channels) for
 * one caller. `voice` is left out for a caller that does not need voice
 * state, such as a plain REST guild fetch; READY and GUILD_CREATE pass it.
 */
export async function buildGuildView(db: DbClient, guildId: bigint, userId: bigint, voice?: VoiceService) {
  const context = await loadMemberContext(db, guildId, userId);
  if (!context) {
    throw new AppError(404, "NOT_FOUND", "This guild does not exist.");
  }
  const viewableChannels = await loadViewableChannels(db, context);
  const member = await loadOwnMemberRow(db, guildId, userId);
  const overwritesByChannel = await loadOverwrites(db, viewableChannels.map((channel) => channel.id));
  const voiceStates = voice
    ? viewableChannels
        .filter((channel) => channel.type === "voice")
        .flatMap((channel) => voice.channelStates(channel.id).map((peerState) => toVoiceStateUpdate(peerState)))
    : [];
  return toGuildView(
    context.guild,
    context.allRoles,
    viewableChannels,
    member,
    [...context.memberRoles.map((role) => role.id)],
    overwritesByChannel,
    voiceStates,
  );
}

export async function createGuild(deps: GuildsDeps, userId: bigint, name: string) {
  const { db, gateway, voice } = deps;

  const ownedCount = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(guilds)
    .where(eq(guilds.ownerId, userId));
  if ((ownedCount[0]?.count ?? 0) >= MAX_OWNED_GUILDS) {
    throw new AppError(403, "OWNED_GUILD_LIMIT", `You cannot own more than ${MAX_OWNED_GUILDS} guilds.`);
  }
  const joinedCount = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(guildMembers)
    .where(eq(guildMembers.userId, userId));
  if ((joinedCount[0]?.count ?? 0) >= MAX_JOINED_GUILDS) {
    throw new AppError(403, "JOINED_GUILD_LIMIT", `You cannot be in more than ${MAX_JOINED_GUILDS} guilds.`);
  }

  const guildId = nextId();

  await db.transaction(async (tx) => {
    await tx.insert(guilds).values({ id: guildId, name, ownerId: userId });

    await tx.insert(roles).values({
      id: guildId,
      guildId,
      name: "@everyone",
      color: 0,
      position: 0,
      permissions: DEFAULT_EVERYONE_PERMISSIONS,
      mentionable: true,
    });

    await tx.insert(guildMembers).values({ guildId, userId, nickname: null });

    const textCategoryId = nextId();
    const voiceCategoryId = nextId();
    await tx.insert(channels).values([
      { id: textCategoryId, guildId, type: "category", name: "Text channels", position: 0 },
      { id: nextId(), guildId, type: "text", name: "general", position: 0, parentId: textCategoryId },
      { id: voiceCategoryId, guildId, type: "category", name: "Voice channels", position: 1 },
      { id: nextId(), guildId, type: "voice", name: "General", position: 0, parentId: voiceCategoryId },
    ]);
  });

  gateway?.addUserToGuild(guildId, userId);
  const view = await buildGuildView(db, guildId, userId, voice);
  gateway?.toUser(userId, DispatchEvent.GUILD_CREATE, view);
  return view;
}

export async function getGuildView(db: DbClient, guildId: bigint, userId: bigint) {
  return buildGuildView(db, guildId, userId);
}

export async function updateGuild(
  deps: GuildsDeps,
  guildId: bigint,
  userId: bigint,
  patch: { name?: string },
) {
  const { db, gateway } = deps;
  const context = await loadMemberContext(db, guildId, userId);
  if (!context) {
    throw new AppError(404, "NOT_FOUND", "This guild does not exist.");
  }
  requirePermission(context, Permission.MANAGE_GUILD);

  if (patch.name !== undefined) {
    await db.update(guilds).set({ name: patch.name }).where(eq(guilds.id, guildId));
  }
  const view = await buildGuildView(db, guildId, userId);
  gateway?.toGuild(guildId, DispatchEvent.GUILD_UPDATE, {
    id: view.id,
    name: view.name,
    iconKey: view.iconKey,
    ownerId: view.ownerId,
    createdAt: view.createdAt,
  });
  return view;
}

export async function deleteGuild(deps: GuildsDeps, guildId: bigint, userId: bigint): Promise<void> {
  const { db, config, gateway, voice } = deps;
  const context = await loadMemberContext(db, guildId, userId);
  if (!context) {
    throw new AppError(404, "NOT_FOUND", "This guild does not exist.");
  }
  if (!context.isOwner) {
    throw new AppError(403, "OWNER_ONLY", "Only the guild owner can delete the guild.");
  }

  const memberRows = await db
    .select({ userId: guildMembers.userId })
    .from(guildMembers)
    .where(eq(guildMembers.guildId, guildId));

  await db.delete(guilds).where(eq(guilds.id, guildId));
  if (context.guild.iconKey) {
    await deleteIconFile(config.dataDir, guildId);
  }

  if (gateway) {
    gateway.toUsers(memberRows.map((row) => row.userId), DispatchEvent.GUILD_DELETE, { id: guildId.toString() });
    gateway.removeGuild(guildId);
  }
  // GUILD_DELETE above already tells every client to tear down this
  // guild's voice UI, so no separate leave broadcast is needed here.
  await voice?.revalidate(guildId, async () => false);
}

export async function setGuildIcon(deps: GuildsDeps, guildId: bigint, userId: bigint, buffer: Buffer) {
  const { db, config } = deps;
  const context = await loadMemberContext(db, guildId, userId);
  if (!context) {
    throw new AppError(404, "NOT_FOUND", "This guild does not exist.");
  }
  requirePermission(context, Permission.MANAGE_GUILD);

  await saveIconFile(config.dataDir, guildId, buffer);
  const iconKey = generateIconKey();
  await db.update(guilds).set({ iconKey }).where(eq(guilds.id, guildId));
  return buildGuildView(db, guildId, userId);
}

export async function removeGuildIcon(deps: GuildsDeps, guildId: bigint, userId: bigint) {
  const { db, config } = deps;
  const context = await loadMemberContext(db, guildId, userId);
  if (!context) {
    throw new AppError(404, "NOT_FOUND", "This guild does not exist.");
  }
  requirePermission(context, Permission.MANAGE_GUILD);

  await deleteIconFile(config.dataDir, guildId);
  await db.update(guilds).set({ iconKey: null }).where(eq(guilds.id, guildId));
  return buildGuildView(db, guildId, userId);
}

/**
 * Remove a member row, with the roles and the member overwrites of that
 * member in this guild. A later rejoin then starts with no old permissions.
 */
export async function deleteMembership(db: DbClient, guildId: bigint, userId: bigint): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(guildMembers).where(and(eq(guildMembers.guildId, guildId), eq(guildMembers.userId, userId)));
    await tx.delete(memberRoles).where(and(eq(memberRoles.guildId, guildId), eq(memberRoles.userId, userId)));
    const guildChannels = tx.select({ id: channels.id }).from(channels).where(eq(channels.guildId, guildId));
    await tx
      .delete(permissionOverwrites)
      .where(
        and(
          eq(permissionOverwrites.targetType, "member"),
          eq(permissionOverwrites.targetId, userId),
          inArray(permissionOverwrites.channelId, guildChannels),
        ),
      );
  });
}

export async function leaveGuild(deps: GuildsDeps, guildId: bigint, userId: bigint): Promise<void> {
  const { db, gateway, voice } = deps;
  const context = await loadMemberContext(db, guildId, userId);
  if (!context) {
    throw new AppError(404, "NOT_FOUND", "This guild does not exist.");
  }
  if (context.isOwner) {
    throw new AppError(409, "OWNER_CANNOT_LEAVE", "The guild owner cannot leave. Delete the guild instead.");
  }
  await deleteMembership(db, guildId, userId);

  gateway?.toGuild(guildId, DispatchEvent.GUILD_MEMBER_REMOVE, { guildId: guildId.toString(), userId: userId.toString() });
  gateway?.toUser(userId, DispatchEvent.GUILD_DELETE, { id: guildId.toString() });
  gateway?.removeUserFromGuild(guildId, userId);
  // The member row is already gone, so this also removes a voice peer this
  // user left behind, and tells the rest of that channel they left.
  if (gateway && voice) {
    await revalidateGuildVoice({ db, gateway, voice }, guildId);
  }
}

export interface ListMembersInput {
  after?: bigint;
  limit: number;
}

export interface ListedMember extends MemberRow {
  roleIds: bigint[];
}

/** Attach each row's role ids, loaded in one query for the whole page. */
async function attachRoleIds(db: DbClient, guildId: bigint, rows: MemberRow[]): Promise<ListedMember[]> {
  const userIds = rows.map((row) => row.userId);
  const roleRows =
    userIds.length > 0
      ? await db
          .select({ userId: memberRoles.userId, roleId: memberRoles.roleId })
          .from(memberRoles)
          .where(and(eq(memberRoles.guildId, guildId), inArray(memberRoles.userId, userIds)))
      : [];
  const roleIdsByUser = new Map<string, bigint[]>();
  for (const row of roleRows) {
    const key = row.userId.toString();
    const list = roleIdsByUser.get(key) ?? [];
    list.push(row.roleId);
    roleIdsByUser.set(key, list);
  }
  return rows.map((row) => ({ ...row, roleIds: roleIdsByUser.get(row.userId.toString()) ?? [] }));
}

/**
 * One keyset page of a guild's members, ordered by user id, each with the
 * user's own profile (name, avatar) and role ids, so the client can show
 * and permission-check members without a second request per member.
 */
export async function listMembers(
  db: DbClient,
  guildId: bigint,
  userId: bigint,
  input: ListMembersInput,
): Promise<ListedMember[]> {
  const context = await loadMemberContext(db, guildId, userId);
  if (!context) {
    throw new AppError(404, "NOT_FOUND", "This guild does not exist.");
  }

  const conditions = [eq(guildMembers.guildId, guildId)];
  if (input.after !== undefined) {
    conditions.push(gt(guildMembers.userId, input.after));
  }

  const rows = await db
    .select(memberSelectColumns)
    .from(guildMembers)
    .innerJoin(users, eq(users.id, guildMembers.userId))
    .where(and(...conditions))
    .orderBy(asc(guildMembers.userId))
    .limit(input.limit);

  return attachRoleIds(db, guildId, rows);
}

export interface SearchMembersInput {
  q: string;
  limit: number;
}

/**
 * Escape the LIKE wildcards `%`, `_` and the escape character itself, so a
 * search term is always matched as literal text, never as a pattern.
 */
export function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, "\\$&");
}

/**
 * Case-insensitive prefix search over a guild's members, by username,
 * display name or nickname. Returns the same shape as `listMembers`, so
 * the client can render either list with one component.
 */
export async function searchMembers(
  db: DbClient,
  guildId: bigint,
  userId: bigint,
  input: SearchMembersInput,
): Promise<ListedMember[]> {
  const context = await loadMemberContext(db, guildId, userId);
  if (!context) {
    throw new AppError(404, "NOT_FOUND", "This guild does not exist.");
  }

  const pattern = `${escapeLikePattern(input.q.toLowerCase())}%`;

  const rows = await db
    .select(memberSelectColumns)
    .from(guildMembers)
    .innerJoin(users, eq(users.id, guildMembers.userId))
    .where(
      and(
        eq(guildMembers.guildId, guildId),
        sql`(lower(${users.username}) LIKE ${pattern} ESCAPE '\\'
          OR lower(${users.displayName}) LIKE ${pattern} ESCAPE '\\'
          OR lower(${guildMembers.nickname}) LIKE ${pattern} ESCAPE '\\')`,
      ),
    )
    .orderBy(asc(users.username))
    .limit(input.limit);

  return attachRoleIds(db, guildId, rows);
}

/** Throw 403 when the caller lacks the given guild-level permission. Call after a membership check. */
export function requirePermission(context: MemberContext, permission: bigint): void {
  if (!hasPermission(guildPermissions(context), permission)) {
    throw new AppError(403, "MISSING_PERMISSION", "You do not have permission to do this.");
  }
}

export type { ChannelRow };
