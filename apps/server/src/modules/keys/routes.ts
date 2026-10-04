// Key server routes. Each handler validates input and calls the service.
// See docs/concepts/olm-megolm.md sections 3 and 4.
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  claimKeysRequestSchema,
  createBackupVersionRequestSchema,
  getBackupSessionsQuerySchema,
  putBackupSecretsRequestSchema,
  putBackupSessionsRequestSchema,
  putMasterKeyRequestSchema,
  queryKeysRequestSchema,
  resetMasterKeyRequestSchema,
  uploadKeysRequestSchema,
  uploadSignatureRequestSchema,
} from "@mortium/shared";
import type { AppDeps } from "../../app.js";
import { AppError } from "../../errors.js";
import { createEventRateLimiter, type EventRateLimiter } from "../messages/service.js";
import {
  createBackupVersion,
  deleteBackupVersion,
  getBackupSessions,
  getBackupVersion,
  putBackupSecrets,
  putBackupSessions,
} from "./backup.js";
import { claimKeys, putMasterKey, queryKeys, resetMasterKey, uploadKeys, uploadSignature } from "./service.js";

const REQUESTS_PER_MINUTE = 60;
/** A password check is slow on purpose. Allow only a few tries. */
const RESETS_PER_15_MINUTES = 5;
/** The background upload of a large backup sends many batches. */
const BACKUP_REQUESTS_PER_MINUTE = 120;

const versionParamsSchema = z.object({ version: z.coerce.number().int().positive() });

/** Throw 429 when this user called the route too often in the last minute. */
export function checkRate(limiter: EventRateLimiter, userId: bigint): void {
  const limit = limiter.check(userId);
  if (!limit.allowed) {
    throw new AppError(429, "RATE_LIMITED", "Too many requests. Try again later.");
  }
}

export async function registerKeyRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const keysDeps = { db: deps.db, gateway: deps.gateway };
  const uploadLimiter = createEventRateLimiter(REQUESTS_PER_MINUTE, 60_000);
  const queryLimiter = createEventRateLimiter(REQUESTS_PER_MINUTE, 60_000);
  const claimLimiter = createEventRateLimiter(REQUESTS_PER_MINUTE, 60_000);
  const resetLimiter = createEventRateLimiter(RESETS_PER_15_MINUTES, 15 * 60_000);
  const backupLimiter = createEventRateLimiter(BACKUP_REQUESTS_PER_MINUTE, 60_000);

  app.post("/keys/upload", { preHandler: app.authenticate }, async (request, reply: FastifyReply) => {
    const { userId, deviceId } = request.auth!;
    checkRate(uploadLimiter, userId);
    const input = uploadKeysRequestSchema.parse(request.body);
    return reply.send(await uploadKeys(keysDeps, userId, deviceId, input));
  });

  app.put("/keys/master", { preHandler: app.authenticate }, async (request, reply) => {
    const { userId, deviceId } = request.auth!;
    checkRate(uploadLimiter, userId);
    const input = putMasterKeyRequestSchema.parse(request.body);
    await putMasterKey(keysDeps, userId, deviceId, input);
    return reply.status(204).send();
  });

  app.post("/keys/signatures", { preHandler: app.authenticate }, async (request, reply) => {
    const { userId } = request.auth!;
    checkRate(uploadLimiter, userId);
    const input = uploadSignatureRequestSchema.parse(request.body);
    await uploadSignature(keysDeps, userId, input);
    return reply.status(204).send();
  });

  app.post("/keys/master/reset", { preHandler: app.authenticate }, async (request, reply) => {
    const { userId, deviceId } = request.auth!;
    checkRate(resetLimiter, userId);
    const input = resetMasterKeyRequestSchema.parse(request.body);
    await resetMasterKey(keysDeps, userId, deviceId, input);
    return reply.status(204).send();
  });

  // ---- key backup: only the owner reaches its own backup ----

  app.post("/keys/backup/version", { preHandler: app.authenticate }, async (request, reply) => {
    const { userId } = request.auth!;
    checkRate(uploadLimiter, userId);
    const input = createBackupVersionRequestSchema.parse(request.body);
    return reply.status(201).send(await createBackupVersion(deps.db, userId, input));
  });

  app.get("/keys/backup/version", { preHandler: app.authenticate }, async (request, reply) => {
    const { userId } = request.auth!;
    checkRate(queryLimiter, userId);
    return reply.send({ backup: await getBackupVersion(deps.db, userId) });
  });

  app.delete("/keys/backup/version/:version", { preHandler: app.authenticate }, async (request, reply) => {
    const { userId } = request.auth!;
    checkRate(uploadLimiter, userId);
    const { version } = versionParamsSchema.parse(request.params);
    await deleteBackupVersion(deps.db, userId, version);
    return reply.status(204).send();
  });

  app.put("/keys/backup/sessions", { preHandler: app.authenticate }, async (request, reply) => {
    const { userId } = request.auth!;
    checkRate(backupLimiter, userId);
    const input = putBackupSessionsRequestSchema.parse(request.body);
    return reply.send(await putBackupSessions(deps.db, userId, input));
  });

  app.get("/keys/backup/sessions", { preHandler: app.authenticate }, async (request, reply) => {
    const { userId } = request.auth!;
    checkRate(backupLimiter, userId);
    const query = getBackupSessionsQuerySchema.parse(request.query);
    return reply.send(await getBackupSessions(deps.db, userId, query));
  });

  app.put("/keys/backup/secrets", { preHandler: app.authenticate }, async (request, reply) => {
    const { userId } = request.auth!;
    checkRate(uploadLimiter, userId);
    const input = putBackupSecretsRequestSchema.parse(request.body);
    await putBackupSecrets(deps.db, userId, input.version, input.secrets);
    return reply.status(204).send();
  });

  app.post("/keys/query", { preHandler: app.authenticate }, async (request, reply) => {
    const { userId } = request.auth!;
    checkRate(queryLimiter, userId);
    const input = queryKeysRequestSchema.parse(request.body);
    const users = await queryKeys(
      deps.db,
      userId,
      input.userIds.map((id) => BigInt(id)),
    );
    return reply.send({ users });
  });

  app.post("/keys/claim", { preHandler: app.authenticate }, async (request, reply) => {
    const { userId } = request.auth!;
    checkRate(claimLimiter, userId);
    const input = claimKeysRequestSchema.parse(request.body);
    return reply.send({ keys: await claimKeys(deps.db, userId, input.devices) });
  });
}
