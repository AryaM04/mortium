// The voice REST route: TURN credentials and the voice audio bitrate. Voice join/leave/state/signal go
// through the gateway, not REST (see modules/voice/gateway-ops.ts).
import type { FastifyInstance } from "fastify";
import type { TurnCredentialsResponse } from "@mortium/shared";
import type { AppDeps } from "../../app.js";
import { createTurnCredentials } from "../../turn.js";

const TURN_CREDENTIALS_TTL_SECONDS = 12 * 60 * 60; // 12 hours

export async function registerVoiceRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get(
    "/voice/turn-credentials",
    { preHandler: app.authenticate, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { config } = deps;
      const { username, credential } = createTurnCredentials(
        config.turnSecret,
        request.auth!.userId.toString(),
        TURN_CREDENTIALS_TTL_SECONDS,
      );

      const stunUrl = `stun:${config.turnPublicHost}:${config.turnPort}`;
      const turnUdpUrl = `turn:${config.turnPublicHost}:${config.turnPort}?transport=udp`;
      const turnTcpUrl = `turn:${config.turnPublicHost}:${config.turnPort}?transport=tcp`;
      const urls = [stunUrl, turnUdpUrl, turnTcpUrl];
      if (config.turnTlsEnabled) {
        urls.push(`turns:${config.turnPublicHost}:${config.turnTlsPort}`);
      }

      const response: TurnCredentialsResponse = {
        iceServers: [{ urls, username, credential }],
        ttlSeconds: TURN_CREDENTIALS_TTL_SECONDS,
        audioBitrateBps: config.voiceAudioBitrateBps,
      };
      return reply.send(response);
    },
  );
}
