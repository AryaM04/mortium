// Synced user settings routes.
import type { FastifyInstance } from "fastify";
import { MAX_SETTINGS_BYTES, putSettingsRequestSchema } from "@mortium/shared";
import type { AppDeps } from "../../app.js";
import { getSettings, putSettings } from "./service.js";

// Base64url text is 4/3 the size of the bytes. The extra room is for the JSON around it.
const SETTINGS_BODY_LIMIT_BYTES = Math.ceil((MAX_SETTINGS_BYTES * 4) / 3) + 1024;

export async function registerSettingsRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get("/users/@me/settings", { preHandler: app.authenticate }, async (request, reply) => {
    return reply.send(await getSettings(deps.db, request.auth!.userId));
  });

  app.put(
    "/users/@me/settings",
    { preHandler: app.authenticate, bodyLimit: SETTINGS_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const input = putSettingsRequestSchema.parse(request.body);
      const { userId, deviceId } = request.auth!;
      const result = await putSettings({ db: deps.db, gateway: deps.gateway }, userId, deviceId, input);
      return reply.send(result);
    },
  );
}
