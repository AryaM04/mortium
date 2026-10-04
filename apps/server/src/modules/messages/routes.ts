// Channel event routes: post, list, redact and mark read.
import type { FastifyInstance } from "fastify";
import { createEventRequestSchema, listEventsQuerySchema, updateReadStateRequestSchema } from "@mortium/shared";
import type { AppDeps } from "../../app.js";
import { AppError } from "../../errors.js";
import {
  createEvent,
  createEventRateLimiter,
  listChannelMembers,
  listEvents,
  redactEvent,
  updateReadState,
} from "./service.js";
import { toEventJson } from "./serialize.js";

function parseId(text: string): bigint {
  if (!/^[0-9]+$/.test(text)) {
    throw new AppError(404, "NOT_FOUND", "This does not exist.");
  }
  return BigInt(text);
}

export async function registerMessageRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const rateLimiter = createEventRateLimiter();

  app.post("/channels/:id/events", { preHandler: app.authenticate }, async (request, reply) => {
    const channelId = parseId((request.params as { id: string }).id);
    const { userId, deviceId } = request.auth!;

    const limit = rateLimiter.check(userId);
    if (!limit.allowed) {
      return reply
        .status(429)
        .send({ error: { code: "RATE_LIMITED", message: "You are sending events too fast.", retryAfterMs: limit.retryAfterMs } });
    }

    const input = createEventRequestSchema.parse(request.body);
    if (input.codec === "plain-v1" && !deps.config.allowPlaintextEvents) {
      throw new AppError(400, "PLAINTEXT_NOT_ALLOWED", "The server does not accept messages that are not encrypted.");
    }
    const { event, created } = await createEvent(
      deps.db,
      channelId,
      userId,
      deviceId,
      {
        relType: input.relType,
        relatesToId: input.relatesToId ? BigInt(input.relatesToId) : undefined,
        codec: input.codec,
        megolmSessionId: input.megolmSessionId,
        ciphertext: input.ciphertext,
        nonce: input.nonce,
      },
      deps.gateway,
    );
    return reply.status(created ? 201 : 200).send(toEventJson(event));
  });

  app.get("/channels/:id/events", { preHandler: app.authenticate }, async (request, reply) => {
    const channelId = parseId((request.params as { id: string }).id);
    const query = listEventsQuerySchema.parse(request.query);
    const result = await listEvents(deps.db, channelId, request.auth!.userId, {
      before: query.before ? BigInt(query.before) : undefined,
      after: query.after ? BigInt(query.after) : undefined,
      around: query.around ? BigInt(query.around) : undefined,
      limit: query.limit,
    });
    return reply.send({
      events: result.events.map(toEventJson),
      relations: result.relations.map(toEventJson),
      hasMoreBefore: result.hasMoreBefore,
      hasMoreAfter: result.hasMoreAfter,
    });
  });

  app.delete("/channels/:id/events/:eventId", { preHandler: app.authenticate }, async (request, reply) => {
    const { id, eventId } = request.params as { id: string; eventId: string };
    await redactEvent(deps.db, parseId(id), parseId(eventId), request.auth!.userId, deps.gateway);
    return reply.status(204).send();
  });

  app.get("/channels/:id/members", { preHandler: app.authenticate }, async (request, reply) => {
    const channelId = parseId((request.params as { id: string }).id);
    return reply.send(await listChannelMembers(deps.db, channelId, request.auth!.userId));
  });

  app.put("/channels/:id/read",{ preHandler: app.authenticate }, async (request, reply) => {
    const channelId = parseId((request.params as { id: string }).id);
    const input = updateReadStateRequestSchema.parse(request.body);
    const { userId, deviceId } = request.auth!;
    await updateReadState(deps.db, channelId, userId, deviceId, BigInt(input.eventId), deps.gateway);
    return reply.status(204).send();
  });
}
