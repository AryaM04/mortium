// Users routes: the signed-in user's own profile, and the public avatar file.
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { updateMeRequestSchema } from "@mortium/shared";
import type { AppDeps } from "../../app.js";
import { users } from "../../db/schema.js";
import { AppError } from "../../errors.js";
import { parseId } from "../../id.js";
import { deleteDevice, listDevices } from "../auth/service.js";
import { toUserJson } from "./serialize.js";
import { detectImageContentType, readAvatarFile } from "./avatar.js";
import { getUserOrThrow, removeAvatar, setAvatar, updateMe } from "./service.js";

const AVATAR_BODY_LIMIT_BYTES = 1024 * 1024; // 1 MiB

export async function registerUserRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const usersDeps = { db: deps.db, config: deps.config };

  app.get("/users/@me", { preHandler: app.authenticate }, async (request, reply) => {
    const user = await getUserOrThrow(deps.db, request.auth!.userId);
    return reply.send(toUserJson(user, { includePrivate: true }));
  });

  app.patch("/users/@me", { preHandler: app.authenticate }, async (request, reply) => {
    const input = updateMeRequestSchema.parse(request.body);
    const user = await updateMe(usersDeps, request.auth!.userId, input);
    return reply.send(toUserJson(user, { includePrivate: true }));
  });

  app.put(
    "/users/@me/avatar",
    { preHandler: app.authenticate, bodyLimit: AVATAR_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const buffer = request.body as Buffer;
      if (!detectImageContentType(buffer)) {
        throw new AppError(400, "INVALID_IMAGE", "The file is not a PNG, JPEG or WEBP image.");
      }
      const user = await setAvatar(usersDeps, request.auth!.userId, buffer);
      return reply.send(toUserJson(user, { includePrivate: true }));
    },
  );

  app.delete("/users/@me/avatar", { preHandler: app.authenticate }, async (request, reply) => {
    const user = await removeAvatar(usersDeps, request.auth!.userId);
    return reply.send(toUserJson(user, { includePrivate: true }));
  });

  app.get("/users/@me/devices", { preHandler: app.authenticate }, async (request, reply) => {
    const authDeps = { db: deps.db, config: deps.config, mailer: deps.mailer, gateway: deps.gateway };
    const result = await listDevices(authDeps, request.auth!.userId, request.auth!.deviceId);
    return reply.send({ devices: result });
  });

  app.delete("/users/@me/devices/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const authDeps = { db: deps.db, config: deps.config, mailer: deps.mailer, gateway: deps.gateway };
    const { id } = request.params as { id: string };
    await deleteDevice(authDeps, request.auth!.userId, id);
    return reply.status(204).send();
  });

  app.get("/avatars/:userId/:avatarKey", async (request, reply) => {
    const { userId: userIdText, avatarKey } = request.params as { userId: string; avatarKey: string };
    const userId = parseId(userIdText, "This avatar does not exist.");

    const rows = await deps.db.select({ avatarKey: users.avatarKey }).from(users).where(eq(users.id, userId)).limit(1);
    if (!rows[0] || rows[0].avatarKey !== avatarKey) {
      throw new AppError(404, "NOT_FOUND", "This avatar does not exist.");
    }

    const buffer = await readAvatarFile(deps.config.dataDir, userId);
    if (!buffer) {
      throw new AppError(404, "NOT_FOUND", "This avatar does not exist.");
    }

    const contentType = detectImageContentType(buffer) ?? "application/octet-stream";
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    reply.header("Content-Type", contentType);
    return reply.send(buffer);
  });
}
