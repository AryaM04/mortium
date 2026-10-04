// The to-device send route. Delivery happens over the gateway, in
// service.ts. See docs/concepts/olm-megolm.md section 6.
import type { FastifyInstance } from "fastify";
import { MAX_TO_DEVICE_MESSAGES, sendToDeviceRequestSchema } from "@mortium/shared";
import type { AppDeps } from "../../app.js";
import { checkRate } from "../keys/routes.js";
import { createEventRateLimiter } from "../messages/service.js";
import { sendToDevice, type ToDeviceDelivery } from "./service.js";

const REQUESTS_PER_MINUTE = 120;
// 100 messages of 64 KiB, as base64url in JSON, with room for the other fields.
const BODY_LIMIT_BYTES = MAX_TO_DEVICE_MESSAGES * 88 * 1024 + 64 * 1024;

export async function registerToDeviceRoutes(
  app: FastifyInstance,
  deps: AppDeps & { delivery: ToDeviceDelivery },
): Promise<void> {
  const limiter = createEventRateLimiter(REQUESTS_PER_MINUTE, 60_000);

  app.post(
    "/to-device",
    { preHandler: app.authenticate, bodyLimit: BODY_LIMIT_BYTES },
    async (request, reply) => {
      const { userId, deviceId } = request.auth!;
      checkRate(limiter, userId);
      const input = sendToDeviceRequestSchema.parse(request.body);
      const result = await sendToDevice(
        { db: deps.db, delivery: deps.delivery, log: request.log },
        userId,
        deviceId,
        input.messages,
        deps.toDeviceQueueLimit,
      );
      return reply.send(result);
    },
  );
}
