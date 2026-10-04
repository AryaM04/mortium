// Guild, channel and invite routes. Each handler validates input, checks
// membership and permissions inside the service call, and replies.
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import {
  createBanRequestSchema,
  createChannelRequestSchema,
  createGuildRequestSchema,
  createInviteRequestSchema,
  updateGroupDmRequestSchema,
  createRoleRequestSchema,
  listMembersQuerySchema,
  putOverwriteRequestSchema,
  roleOrderRequestSchema,
  searchMembersQuerySchema,
  transferGuildRequestSchema,
  updateChannelRequestSchema,
  updateGuildRequestSchema,
  updateMemberRequestSchema,
  updateRoleRequestSchema,
  voiceModerationRequestSchema,
  channelOrderRequestSchema,
} from "@mortium/shared";
import type { AppDeps } from "../../app.js";
import { guilds } from "../../db/schema.js";
import { AppError } from "../../errors.js";
import { parseId } from "../../id.js";
import { checkRate } from "../keys/routes.js";
import { createEventRateLimiter } from "../messages/service.js";
import { detectImageContentType } from "../users/avatar.js";
import {
  createChannel,
  deleteChannel,
  reorderChannels,
  updateChannel,
} from "./channels.js";
import {
  acceptInvite,
  createInvite,
  deleteInvite,
  getInvitePreview,
  listGuildInvites,
} from "./invites.js";
import { isPrivateChannel, renameGroupDm } from "../dms/service.js";
import { readIconFile } from "./icon.js";
import {
  applyVoiceModeration,
  banMember,
  kickMember,
  listBans,
  transferOwnership,
  unbanMember,
} from "./moderation.js";
import { deleteOverwrite, putOverwrite } from "./overwrites.js";
import {
  addMemberRole,
  createRole,
  deleteRole,
  listRoles,
  removeMemberRole,
  reorderRoles,
  updateMemberNickname,
  updateRole,
} from "./roles.js";
import {
  createGuild,
  deleteGuild,
  getGuildView,
  leaveGuild,
  listMembers,
  removeGuildIcon,
  searchMembers,
  setGuildIcon,
  updateGuild,
} from "./service.js";
import { toChannelJson, toInviteJson, toInvitePreviewJson, toMemberJson, toRoleJson } from "./serialize.js";

const ICON_BODY_LIMIT_BYTES = 1024 * 1024; // 1 MiB
/** Invite lookups and joins for one user. The limit also stops a search for valid codes. */
const INVITE_LOOKUPS_PER_MINUTE = 30;
const INVITES_CREATED_PER_MINUTE = 30;

export async function registerGuildRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const guildsDeps = { db: deps.db, config: deps.config, gateway: deps.gateway, voice: deps.voice };
  const inviteLookupLimiter = createEventRateLimiter(INVITE_LOOKUPS_PER_MINUTE, 60_000);
  const inviteCreateLimiter = createEventRateLimiter(INVITES_CREATED_PER_MINUTE, 60_000);

  app.post("/guilds", { preHandler: app.authenticate }, async (request, reply) => {
    const input = createGuildRequestSchema.parse(request.body);
    const guild = await createGuild(guildsDeps, request.auth!.userId, input.name);
    return reply.status(201).send(guild);
  });

  app.get("/guilds/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const guildId = parseId((request.params as { id: string }).id);
    const guild = await getGuildView(deps.db, guildId, request.auth!.userId);
    return reply.send(guild);
  });

  app.patch("/guilds/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const guildId = parseId((request.params as { id: string }).id);
    const input = updateGuildRequestSchema.parse(request.body);
    const guild = await updateGuild(guildsDeps, guildId, request.auth!.userId, input);
    return reply.send(guild);
  });

  app.delete("/guilds/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const guildId = parseId((request.params as { id: string }).id);
    await deleteGuild(guildsDeps, guildId, request.auth!.userId);
    return reply.status(204).send();
  });

  app.put(
    "/guilds/:id/icon",
    { preHandler: app.authenticate, bodyLimit: ICON_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const guildId = parseId((request.params as { id: string }).id);
      const buffer = request.body as Buffer;
      if (!detectImageContentType(buffer)) {
        throw new AppError(400, "INVALID_IMAGE", "The file is not a PNG, JPEG or WEBP image.");
      }
      const guild = await setGuildIcon(guildsDeps, guildId, request.auth!.userId, buffer);
      return reply.send(guild);
    },
  );

  app.delete("/guilds/:id/icon", { preHandler: app.authenticate }, async (request, reply) => {
    const guildId = parseId((request.params as { id: string }).id);
    const guild = await removeGuildIcon(guildsDeps, guildId, request.auth!.userId);
    return reply.send(guild);
  });

  app.get("/icons/:guildId/:iconKey", async (request, reply) => {
    const { guildId: guildIdText, iconKey } = request.params as { guildId: string; iconKey: string };
    const guildId = parseId(guildIdText, "This icon does not exist.");

    const rows = await deps.db.select({ iconKey: guilds.iconKey }).from(guilds).where(eq(guilds.id, guildId)).limit(1);
    if (!rows[0] || rows[0].iconKey !== iconKey) {
      throw new AppError(404, "NOT_FOUND", "This icon does not exist.");
    }

    const buffer = await readIconFile(deps.config.dataDir, guildId);
    if (!buffer) {
      throw new AppError(404, "NOT_FOUND", "This icon does not exist.");
    }

    const contentType = detectImageContentType(buffer) ?? "application/octet-stream";
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    reply.header("Content-Type", contentType);
    return reply.send(buffer);
  });

  app.get("/guilds/:id/members", { preHandler: app.authenticate }, async (request, reply) => {
    const guildId = parseId((request.params as { id: string }).id);
    const query = listMembersQuerySchema.parse(request.query);
    const rows = await listMembers(deps.db, guildId, request.auth!.userId, {
      after: query.after ? BigInt(query.after) : undefined,
      limit: query.limit,
    });
    return reply.send({ members: rows.map((row) => toMemberJson(row, row.roleIds)) });
  });

  app.get("/guilds/:id/members/search", { preHandler: app.authenticate }, async (request, reply) => {
    const guildId = parseId((request.params as { id: string }).id);
    const query = searchMembersQuerySchema.parse(request.query);
    const rows = await searchMembers(deps.db, guildId, request.auth!.userId, { q: query.q, limit: query.limit });
    return reply.send({ members: rows.map((row) => toMemberJson(row, row.roleIds)) });
  });

  app.delete("/guilds/:id/members/@me", { preHandler: app.authenticate }, async (request, reply) => {
    const guildId = parseId((request.params as { id: string }).id);
    await leaveGuild(guildsDeps, guildId, request.auth!.userId);
    return reply.status(204).send();
  });

  app.post("/guilds/:id/channels", { preHandler: app.authenticate }, async (request, reply) => {
    const guildId = parseId((request.params as { id: string }).id);
    const input = createChannelRequestSchema.parse(request.body);
    const channel = await createChannel(
      deps.db,
      guildId,
      request.auth!.userId,
      {
        name: input.name,
        type: input.type,
        parentId: input.parentId ? BigInt(input.parentId) : null,
        topic: input.topic,
      },
      deps.gateway,
    );
    return reply.status(201).send(toChannelJson(channel));
  });

  app.put("/guilds/:id/channels/order", { preHandler: app.authenticate }, async (request, reply) => {
    const guildId = parseId((request.params as { id: string }).id);
    const input = channelOrderRequestSchema.parse(request.body);
    await reorderChannels(
      deps.db,
      guildId,
      request.auth!.userId,
      input.map((entry) => ({
        id: BigInt(entry.id),
        position: entry.position,
        parentId: entry.parentId ? BigInt(entry.parentId) : null,
      })),
    );
    return reply.status(204).send();
  });

  app.patch("/channels/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const channelId = parseId((request.params as { id: string }).id);
    if (await isPrivateChannel(deps.db, channelId)) {
      // A group DM shares this path with the guild channels. Only its name can change.
      const dmInput = updateGroupDmRequestSchema.parse(request.body);
      const dmDeps = { db: deps.db, gateway: deps.gateway, voice: deps.voice, ringer: deps.ringer };
      return reply.send(await renameGroupDm(dmDeps, request.auth!.userId, channelId, dmInput.name));
    }
    const input = updateChannelRequestSchema.parse(request.body);
    const channel = await updateChannel(
      deps.db,
      channelId,
      request.auth!.userId,
      {
        name: input.name,
        topic: input.topic,
        parentId: input.parentId === undefined ? undefined : input.parentId ? BigInt(input.parentId) : null,
      },
      deps.gateway,
    );
    return reply.send(toChannelJson(channel));
  });

  app.delete("/channels/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const channelId = parseId((request.params as { id: string }).id);
    await deleteChannel(deps.db, channelId, request.auth!.userId, deps.gateway, deps.voice);
    return reply.status(204).send();
  });

  app.post("/channels/:id/invites", { preHandler: app.authenticate }, async (request, reply) => {
    const channelId = parseId((request.params as { id: string }).id);
    checkRate(inviteCreateLimiter, request.auth!.userId);
    const input = createInviteRequestSchema.parse(request.body ?? {});
    const invite = await createInvite(deps.db, channelId, request.auth!.userId, input);
    return reply.status(201).send(toInviteJson(invite));
  });

  app.get("/guilds/:id/invites", { preHandler: app.authenticate }, async (request, reply) => {
    const guildId = parseId((request.params as { id: string }).id);
    const rows = await listGuildInvites(deps.db, guildId, request.auth!.userId);
    return reply.send({ invites: rows.map(toInviteJson) });
  });

  app.get("/invites/:code", { preHandler: app.authenticate }, async (request, reply) => {
    const { code } = request.params as { code: string };
    checkRate(inviteLookupLimiter, request.auth!.userId);
    const preview = await getInvitePreview(deps.db, code);
    return reply.send(toInvitePreviewJson(preview));
  });

  app.post("/invites/:code", { preHandler: app.authenticate }, async (request, reply) => {
    const { code } = request.params as { code: string };
    checkRate(inviteLookupLimiter, request.auth!.userId);
    const guild = await acceptInvite(deps.db, code, request.auth!.userId, deps.gateway);
    return reply.status(200).send({ guild });
  });

  app.delete("/invites/:code", { preHandler: app.authenticate }, async (request, reply) => {
    const { code } = request.params as { code: string };
    await deleteInvite(deps.db, code, request.auth!.userId);
    return reply.status(204).send();
  });

  // ---- roles ------------------------------------------------------------

  const rolesDeps = { db: deps.db, gateway: deps.gateway, voice: deps.voice };

  app.get("/guilds/:id/roles", { preHandler: app.authenticate }, async (request, reply) => {
    const guildId = parseId((request.params as { id: string }).id);
    const rows = await listRoles(deps.db, guildId, request.auth!.userId);
    return reply.send({ roles: rows.map(toRoleJson) });
  });

  app.post("/guilds/:id/roles", { preHandler: app.authenticate }, async (request, reply) => {
    const guildId = parseId((request.params as { id: string }).id);
    const input = createRoleRequestSchema.parse(request.body ?? {});
    const role = await createRole(rolesDeps, guildId, request.auth!.userId, input);
    return reply.status(201).send(toRoleJson(role));
  });

  app.patch("/guilds/:id/roles/:roleId", { preHandler: app.authenticate }, async (request, reply) => {
    const { id, roleId } = request.params as { id: string; roleId: string };
    const guildId = parseId(id);
    const input = updateRoleRequestSchema.parse(request.body);
    const role = await updateRole(rolesDeps, guildId, request.auth!.userId, parseId(roleId), input);
    return reply.send(toRoleJson(role));
  });

  app.delete("/guilds/:id/roles/:roleId", { preHandler: app.authenticate }, async (request, reply) => {
    const { id, roleId } = request.params as { id: string; roleId: string };
    await deleteRole(rolesDeps, parseId(id), request.auth!.userId, parseId(roleId));
    return reply.status(204).send();
  });

  app.put("/guilds/:id/roles/order", { preHandler: app.authenticate }, async (request, reply) => {
    const guildId = parseId((request.params as { id: string }).id);
    const input = roleOrderRequestSchema.parse(request.body);
    await reorderRoles(rolesDeps, guildId, request.auth!.userId, input);
    return reply.status(204).send();
  });

  // ---- member roles and nickname -----------------------------------------

  app.put(
    "/guilds/:id/members/:userId/roles/:roleId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id, userId: targetUserId, roleId } = request.params as { id: string; userId: string; roleId: string };
      await addMemberRole(rolesDeps, parseId(id), request.auth!.userId, parseId(targetUserId), parseId(roleId));
      return reply.status(204).send();
    },
  );

  app.delete(
    "/guilds/:id/members/:userId/roles/:roleId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id, userId: targetUserId, roleId } = request.params as { id: string; userId: string; roleId: string };
      await removeMemberRole(rolesDeps, parseId(id), request.auth!.userId, parseId(targetUserId), parseId(roleId));
      return reply.status(204).send();
    },
  );

  app.patch("/guilds/:id/members/:userId", { preHandler: app.authenticate }, async (request, reply) => {
    const { id, userId: targetUserId } = request.params as { id: string; userId: string };
    const input = updateMemberRequestSchema.parse(request.body);
    if (input.nickname !== undefined) {
      await updateMemberNickname(rolesDeps, parseId(id), request.auth!.userId, parseId(targetUserId), input.nickname);
    }
    return reply.status(204).send();
  });

  // ---- channel overwrites -------------------------------------------------

  app.put("/channels/:id/overwrites/:targetId", { preHandler: app.authenticate }, async (request, reply) => {
    const { id, targetId } = request.params as { id: string; targetId: string };
    const input = putOverwriteRequestSchema.parse(request.body);
    await putOverwrite(
      { db: deps.db, gateway: deps.gateway, voice: deps.voice },
      parseId(id),
      request.auth!.userId,
      parseId(targetId),
      input,
    );
    return reply.status(204).send();
  });

  app.delete("/channels/:id/overwrites/:targetId", { preHandler: app.authenticate }, async (request, reply) => {
    const { id, targetId } = request.params as { id: string; targetId: string };
    const query = request.query as { type?: string };
    const targetType = query.type === "member" ? "member" : "role";
    await deleteOverwrite(
      { db: deps.db, gateway: deps.gateway, voice: deps.voice },
      parseId(id),
      request.auth!.userId,
      parseId(targetId),
      targetType,
    );
    return reply.status(204).send();
  });

  // ---- moderation ---------------------------------------------------------

  const moderationDeps = { db: deps.db, gateway: deps.gateway, voice: deps.voice, log: app.log };

  app.delete("/guilds/:id/members/:userId", { preHandler: app.authenticate }, async (request, reply) => {
    const { id, userId: targetUserId } = request.params as { id: string; userId: string };
    await kickMember(moderationDeps, parseId(id), request.auth!.userId, parseId(targetUserId));
    return reply.status(204).send();
  });

  app.put("/guilds/:id/bans/:userId", { preHandler: app.authenticate }, async (request, reply) => {
    const { id, userId: targetUserId } = request.params as { id: string; userId: string };
    const input = createBanRequestSchema.parse(request.body ?? {});
    await banMember(moderationDeps, parseId(id), request.auth!.userId, parseId(targetUserId), input);
    return reply.status(204).send();
  });

  app.delete("/guilds/:id/bans/:userId", { preHandler: app.authenticate }, async (request, reply) => {
    const { id, userId: targetUserId } = request.params as { id: string; userId: string };
    await unbanMember(moderationDeps, parseId(id), request.auth!.userId, parseId(targetUserId));
    return reply.status(204).send();
  });

  app.get("/guilds/:id/bans", { preHandler: app.authenticate }, async (request, reply) => {
    const guildId = parseId((request.params as { id: string }).id);
    const rows = await listBans(deps.db, guildId, request.auth!.userId);
    return reply.send({ bans: rows });
  });

  app.patch("/guilds/:id/members/:userId/voice", { preHandler: app.authenticate }, async (request, reply) => {
    const { id, userId: targetUserId } = request.params as { id: string; userId: string };
    const input = voiceModerationRequestSchema.parse(request.body ?? {});
    await applyVoiceModeration(moderationDeps, parseId(id), request.auth!.userId, parseId(targetUserId), {
      mute: input.mute,
      deaf: input.deaf,
      channelId: input.channelId === undefined ? undefined : input.channelId ? parseId(input.channelId) : null,
    });
    return reply.status(204).send();
  });

  app.post("/guilds/:id/transfer", { preHandler: app.authenticate }, async (request, reply) => {
    const guildId = parseId((request.params as { id: string }).id);
    const input = transferGuildRequestSchema.parse(request.body);
    await transferOwnership(moderationDeps, guildId, request.auth!.userId, parseId(input.userId));
    return reply.status(204).send();
  });
}
