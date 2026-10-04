// DM and group DM routes. Each handler validates input and calls the service.
// The rename route, PATCH /channels/:id, lives with the guild channel routes,
// because both kinds of channel share that path.
import type { FastifyInstance } from "fastify";
import { createDmRequestSchema } from "@mortium/shared";
import type { AppDeps } from "../../app.js";
import { parseId } from "../../id.js";
import { addRecipient, createDm, listDmChannels, removeRecipient } from "./service.js";

export async function registerDmRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const dmsDeps = { db: deps.db, gateway: deps.gateway, voice: deps.voice, ringer: deps.ringer };

  app.post("/users/@me/channels", { preHandler: app.authenticate }, async (request, reply) => {
    const input = createDmRequestSchema.parse(request.body);
    const result = await createDm(dmsDeps, request.auth!.userId, input.recipientIds.map(BigInt));
    return reply.status(result.created ? 201 : 200).send(result.channel);
  });

  app.get("/users/@me/channels", { preHandler: app.authenticate }, async (request, reply) => {
    const channels = await listDmChannels(deps.db, request.auth!.userId);
    return reply.send({ channels });
  });

  app.put("/channels/:id/recipients/:userId", { preHandler: app.authenticate }, async (request, reply) => {
    const { id, userId: targetId } = request.params as { id: string; userId: string };
    await addRecipient(dmsDeps, request.auth!.userId, parseId(id), parseId(targetId));
    return reply.status(204).send();
  });

  app.delete("/channels/:id/recipients/:userId", { preHandler: app.authenticate }, async (request, reply) => {
    const { id, userId: targetId } = request.params as { id: string; userId: string };
    await removeRecipient(dmsDeps, request.auth!.userId, parseId(id), parseId(targetId));
    return reply.status(204).send();
  });
}
