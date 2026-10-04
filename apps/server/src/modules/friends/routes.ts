// Friend and block routes. Each handler validates input and calls the service.
import type { FastifyInstance } from "fastify";
import {
  MAX_FRIEND_REQUESTS_PER_MINUTE,
  relationshipActionRequestSchema,
  sendFriendRequestSchema,
} from "@mortium/shared";
import type { AppDeps } from "../../app.js";
import { AppError } from "../../errors.js";
import { createEventRateLimiter } from "../messages/service.js";
import {
  acceptFriendRequest,
  blockUser,
  listRelationships,
  removeRelationship,
  sendFriendRequest,
} from "./service.js";

function parseId(text: string): bigint {
  if (!/^[0-9]+$/.test(text)) {
    throw new AppError(404, "USER_NOT_FOUND", "This user does not exist.");
  }
  return BigInt(text);
}

export async function registerFriendRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const friendsDeps = { db: deps.db, gateway: deps.gateway };
  const requestLimiter = createEventRateLimiter(MAX_FRIEND_REQUESTS_PER_MINUTE, 60_000);

  app.get("/users/@me/relationships", { preHandler: app.authenticate }, async (request, reply) => {
    const relationships = await listRelationships(deps.db, request.auth!.userId);
    return reply.send({ relationships });
  });

  app.post("/users/@me/relationships", { preHandler: app.authenticate }, async (request, reply) => {
    const { userId } = request.auth!;
    const limit = requestLimiter.check(userId);
    if (!limit.allowed) {
      return reply.status(429).send({
        error: {
          code: "RATE_LIMITED",
          message: "You are sending friend requests too fast.",
          retryAfterMs: limit.retryAfterMs,
        },
      });
    }
    const input = sendFriendRequestSchema.parse(request.body);
    const result = await sendFriendRequest(friendsDeps, userId, input.username);
    return reply.status(result.created ? 201 : 200).send(result.relationship);
  });

  app.put("/users/@me/relationships/:userId", { preHandler: app.authenticate }, async (request, reply) => {
    const otherId = parseId((request.params as { userId: string }).userId);
    const input = relationshipActionRequestSchema.parse(request.body);
    const { userId } = request.auth!;
    const relationship =
      input.action === "accept"
        ? await acceptFriendRequest(friendsDeps, userId, otherId)
        : await blockUser(friendsDeps, userId, otherId);
    return reply.send(relationship);
  });

  app.delete("/users/@me/relationships/:userId", { preHandler: app.authenticate }, async (request, reply) => {
    const otherId = parseId((request.params as { userId: string }).userId);
    await removeRelationship(friendsDeps, request.auth!.userId, otherId);
    return reply.status(204).send();
  });
}
