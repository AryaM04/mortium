// The `/gateway` WebSocket route. One connection can carry one session.
// The protocol is documented in packages/shared/src/gateway.ts and in
// docs/concepts/gateway.md.
import { eq } from "drizzle-orm";
import {
  GatewayCloseCode,
  GatewayOpcode,
  gatewayEnvelopeSchema,
  heartbeatPayloadSchema,
  identifyPayloadSchema,
  presenceSetPayloadSchema,
  resumePayloadSchema,
  sendToDeviceRequestSchema,
  toDeviceAckPayloadSchema,
  typingPayloadSchema,
  voiceJoinPayloadSchema,
  voiceStatePayloadSchema,
  type DispatchEventName,
  type ReadyPayload,
} from "@mortium/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppConfig } from "../../config.js";
import { AppError } from "../../errors.js";
import type { DbClient } from "../../db/client.js";
import { users } from "../../db/schema.js";
import { createOriginCheck } from "../../origins.js";
import { verifyAccessToken } from "../auth/tokens.js";
import { buildPrivateReadyData } from "../dms/service.js";
import { listRelationships } from "../friends/service.js";
import { buildGuildView } from "../guilds/service.js";
import { keyCounts } from "../keys/service.js";
import { handleTyping } from "../messages/typing.js";
import { loadReadStates } from "../messages/service.js";
import {
  broadcastVoiceLeave,
  handleVoiceJoin,
  handleVoiceLeave,
  handleVoiceState,
} from "../voice/gateway-ops.js";
import { sendToDevice, TO_DEVICE_QUEUE_LIMIT, type ToDeviceDelivery } from "../to-device/service.js";
import type { CallRinger } from "../voice/calls.js";
import { VoiceError, type VoiceService, type VoiceState } from "../voice/service.js";
import { GatewayService, loadGuildIdsForUser, type GatewaySocket } from "./service.js";

export interface GatewayTimingOptions {
  /** How often HELLO tells the client to heartbeat. Default 30000. */
  heartbeatIntervalMs?: number;
  /** How long a connection has to IDENTIFY before it is closed. Default 10000. */
  identifyTimeoutMs?: number;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_IDENTIFY_TIMEOUT_MS = 10_000;
const HEARTBEAT_TIMEOUT_FACTOR = 1.5;
const RATE_LIMIT_MAX_MESSAGES = 120;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_PAYLOAD_BYTES = 64 * 1024;

interface ConnectionState {
  sessionId: string | null;
  identifyTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setTimeout> | null;
  messageTimestamps: number[];
  closed: boolean;
  /** TO_DEVICE_SEND ops of this connection run one after the other, so the queue keeps their order. */
  toDeviceChain: Promise<void>;
}

async function buildReadyPayload(
  db: DbClient,
  gateway: GatewayService,
  voice: VoiceService,
  userId: bigint,
  deviceId: string,
  sessionId: string,
): Promise<ReadyPayload> {
  const userRows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const user = userRows[0];
  const guildIds = await loadGuildIdsForUser(db, userId);
  const guilds = await Promise.all(guildIds.map((guildId) => buildGuildView(db, guildId, userId, voice)));
  const readStateRows = await loadReadStates(db, userId);
  const relationships = await listRelationships(db, userId);
  const { privateChannels, privateVoiceStates } = await buildPrivateReadyData(db, voice, userId);
  const { oneTimeKeyCount, needsFallbackKey } = await keyCounts(db, deviceId);

  return {
    sessionId,
    user: { id: userId.toString(), username: user?.username, displayName: user?.displayName },
    guilds,
    presences: gateway.onlinePresencesFor(userId),
    readStates: readStateRows.map((row) => ({
      channelId: row.channelId.toString(),
      lastReadEventId: row.lastReadEventId?.toString() ?? null,
    })),
    relationships,
    privateChannels,
    privateVoiceStates,
    oneTimeKeyCount,
    needsFallbackKey,
  };
}

export function registerGatewayRoute(
  app: FastifyInstance,
  deps: {
    db: DbClient;
    config: AppConfig;
    gateway: GatewayService;
    voice: VoiceService;
    ringer?: CallRinger;
    delivery?: ToDeviceDelivery;
    toDeviceQueueLimit?: number;
  },
  timing: GatewayTimingOptions = {},
): void {
  const heartbeatIntervalMs = timing.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const identifyTimeoutMs = timing.identifyTimeoutMs ?? DEFAULT_IDENTIFY_TIMEOUT_MS;
  const { db, config, gateway, voice, ringer, delivery } = deps;
  const voiceOpsDeps = { db, gateway, voice, ringer };

  const isAllowedOrigin = createOriginCheck(config);

  // A web page on any site can open a WebSocket to this server, and the
  // browser does not stop it (no CORS on WebSockets). So the upgrade checks
  // the Origin header itself, and refuses other sites before the upgrade.
  const checkOrigin = async (request: FastifyRequest) => {
    if (!isAllowedOrigin(request.headers.origin, request.headers.host)) {
      throw new AppError(403, "ORIGIN_NOT_ALLOWED", "This origin cannot open the gateway.");
    }
  };

  app.get("/gateway", { websocket: true, preValidation: checkOrigin }, (rawSocket) => {
    const socket = rawSocket as unknown as GatewaySocket & {
      on(event: "message", listener: (data: Buffer | string) => void): void;
      on(event: "close", listener: (code: number, reason: Buffer) => void): void;
      on(event: "error", listener: (error: Error) => void): void;
    };

    const state: ConnectionState = {
      sessionId: null,
      identifyTimer: null,
      heartbeatTimer: null,
      messageTimestamps: [],
      closed: false,
      toDeviceChain: Promise.resolve(),
    };

    function send(op: number, d?: unknown, extra?: Record<string, unknown>): void {
      if (state.closed) {
        return;
      }
      socket.send(JSON.stringify({ op, d, ...extra }));
    }

    /**
     * Detach the session from this socket. This runs one time for each socket.
     * It does nothing when a RESUME moved the session to another socket.
     */
    function detachSession(code: number): void {
      const sessionId = state.sessionId;
      state.sessionId = null;
      if (!sessionId || !gateway.disconnectSession(sessionId, socket)) {
        return;
      }
      delivery?.stop(sessionId);
      const info = gateway.getSession(sessionId);
      if (!info) {
        return;
      }
      gateway.notifyConnectionCountChanged(info.userId);

      // The device was signed out, removed, or its password was reset:
      // its voice state must go at once, with no grace period. Any
      // other disconnect (a network drop, a heartbeat timeout, a
      // normal client close) gets the usual grace, so a short drop
      // does not knock the user out of the call.
      if (code === GatewayCloseCode.DEVICE_REVOKED) {
        const removed = voice.removeImmediate(info.userId, info.deviceId);
        if (removed) {
          announceVoiceLeave(removed);
        }
      } else {
        voice.scheduleGrace(info.userId, info.deviceId, sessionId, (removedState) => {
          announceVoiceLeave(removedState);
        });
      }
    }

    function closeConnection(code: number, reason: string): void {
      if (state.closed) {
        return;
      }
      state.closed = true;
      if (state.identifyTimer) {
        clearTimeout(state.identifyTimer);
      }
      if (state.heartbeatTimer) {
        clearTimeout(state.heartbeatTimer);
      }
      detachSession(code);
      socket.close(code, reason);
    }

    function scheduleHeartbeatTimeout(): void {
      if (state.heartbeatTimer) {
        clearTimeout(state.heartbeatTimer);
      }
      state.heartbeatTimer = setTimeout(() => {
        closeConnection(GatewayCloseCode.SESSION_TIMED_OUT, "No heartbeat received in time.");
      }, heartbeatIntervalMs * HEARTBEAT_TIMEOUT_FACTOR);
      state.heartbeatTimer.unref?.();
    }

    state.identifyTimer = setTimeout(() => {
      closeConnection(GatewayCloseCode.NOT_AUTHENTICATED, "No IDENTIFY or RESUME received in time.");
    }, identifyTimeoutMs);
    state.identifyTimer.unref?.();

    send(GatewayOpcode.HELLO, { heartbeatIntervalMs });

    async function handleIdentify(payload: unknown): Promise<void> {
      if (state.sessionId) {
        closeConnection(GatewayCloseCode.ALREADY_AUTHENTICATED, "This connection already identified.");
        return;
      }
      const parsed = identifyPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        closeConnection(GatewayCloseCode.DECODE_ERROR, "The IDENTIFY payload is not valid.");
        return;
      }
      let claims;
      try {
        claims = await verifyAccessToken(config.jwtSecret, parsed.data.accessToken);
      } catch {
        closeConnection(GatewayCloseCode.AUTH_FAILED, "The access token is not valid or has expired.");
        return;
      }
      // The socket can close while the token check runs. Then no session must start.
      if (state.closed || state.sessionId) {
        return;
      }
      if (claims.deviceId !== parsed.data.deviceId) {
        closeConnection(GatewayCloseCode.AUTH_FAILED, "The device id does not match the access token.");
        return;
      }

      if (state.identifyTimer) {
        clearTimeout(state.identifyTimer);
        state.identifyTimer = null;
      }
      // Start the heartbeat timeout before READY, so a slow READY cannot keep a dead connection.
      scheduleHeartbeatTimeout();

      const session = gateway.createSession(socket, claims.userId, claims.deviceId);
      state.sessionId = session.id;
      gateway.notifyConnectionCountChanged(claims.userId);
      voice.claimForSession(claims.userId, claims.deviceId, session.id, (id) => gateway.hasLiveSession(id));

      const ready = await buildReadyPayload(db, gateway, voice, claims.userId, claims.deviceId, session.id);
      // A close during the build already detached the session.
      if (state.closed) {
        return;
      }
      send(GatewayOpcode.DISPATCH, ready, { t: "READY" });
      // Dispatches made while READY was built waited in the session buffer. Send them now.
      gateway.markSessionReady(session.id);
      delivery?.start(session.id, claims.deviceId);
    }

    function handleResume(payload: unknown): void {
      if (state.sessionId) {
        closeConnection(GatewayCloseCode.ALREADY_AUTHENTICATED, "This connection already has a session.");
        return;
      }
      const parsed = resumePayloadSchema.safeParse(payload);
      if (!parsed.success) {
        closeConnection(GatewayCloseCode.DECODE_ERROR, "The RESUME payload is not valid.");
        return;
      }
      verifyAccessToken(config.jwtSecret, parsed.data.accessToken)
        .then((claims) => {
          // The socket can close while the token check runs. Then the session must stay detached.
          if (state.closed || state.sessionId) {
            return;
          }
          const result = gateway.resumeSession(
            parsed.data.sessionId,
            claims.userId,
            claims.deviceId,
            parsed.data.lastSequence,
            socket,
          );
          if (!result) {
            send(GatewayOpcode.INVALID_SESSION, { canResume: false });
            return;
          }
          if (state.identifyTimer) {
            clearTimeout(state.identifyTimer);
            state.identifyTimer = null;
          }
          state.sessionId = parsed.data.sessionId;
          gateway.notifyConnectionCountChanged(claims.userId);
          voice.cancelGrace(claims.userId, claims.deviceId, parsed.data.sessionId);
          for (const entry of result.replay) {
            send(GatewayOpcode.DISPATCH, entry.d, { t: entry.t, s: entry.seq });
          }
          send(GatewayOpcode.DISPATCH, {}, { t: "RESUMED" });
          delivery?.start(parsed.data.sessionId, claims.deviceId);
          scheduleHeartbeatTimeout();
        })
        .catch(() => {
          closeConnection(GatewayCloseCode.AUTH_FAILED, "The access token is not valid or has expired.");
        });
    }

    function handleHeartbeat(payload: unknown): void {
      const parsed = heartbeatPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        closeConnection(GatewayCloseCode.DECODE_ERROR, "The HEARTBEAT payload is not valid.");
        return;
      }
      scheduleHeartbeatTimeout();
      send(GatewayOpcode.HEARTBEAT_ACK);
    }

    function handleTypingOp(payload: unknown): void {
      if (!state.sessionId) {
        closeConnection(GatewayCloseCode.NOT_AUTHENTICATED, "Identify before sending typing.");
        return;
      }
      const parsed = typingPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        closeConnection(GatewayCloseCode.DECODE_ERROR, "The TYPING payload is not valid.");
        return;
      }
      const info = gateway.getSession(state.sessionId);
      if (info) {
        handleTyping(db, gateway, info.userId, BigInt(parsed.data.channelId)).catch((error: unknown) => {
          app.log.error(error, "The server could not send a typing event.");
        });
      }
    }

    function handlePresenceSet(payload: unknown): void {
      if (!state.sessionId) {
        closeConnection(GatewayCloseCode.NOT_AUTHENTICATED, "Identify before setting presence.");
        return;
      }
      const parsed = presenceSetPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        closeConnection(GatewayCloseCode.DECODE_ERROR, "The PRESENCE_SET payload is not valid.");
        return;
      }
      const info = gateway.getSession(state.sessionId);
      if (info) {
        gateway.setPresence(info.userId, parsed.data.status);
      }
    }

    /** Tell the audience that a peer left. A failure is logged, and never becomes an unhandled rejection. */
    function announceVoiceLeave(removed: VoiceState): void {
      broadcastVoiceLeave(voiceOpsDeps, removed).catch((error) => {
        app.log.error(error, "The server could not tell the audience that a voice peer left.");
      });
    }

    function sendVoiceError(error: unknown): void {
      if (error instanceof VoiceError) {
        send(GatewayOpcode.DISPATCH, { code: error.code, message: error.message }, { t: "VOICE_ERROR" });
        return;
      }
      app.log.error(error, "A voice op failed for a reason that is not a VoiceError.");
      closeConnection(GatewayCloseCode.UNKNOWN_ERROR, "A voice op failed unexpectedly.");
    }

    function handleVoiceJoinOp(payload: unknown): void {
      if (!state.sessionId) {
        closeConnection(GatewayCloseCode.NOT_AUTHENTICATED, "Identify before joining voice.");
        return;
      }
      const parsed = voiceJoinPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        closeConnection(GatewayCloseCode.DECODE_ERROR, "The VOICE_JOIN payload is not valid.");
        return;
      }
      const info = gateway.getSession(state.sessionId);
      if (!info) {
        return;
      }
      handleVoiceJoin(voiceOpsDeps, info.userId, info.deviceId, info.id, parsed.data).catch(sendVoiceError);
    }

    function handleVoiceLeaveOp(): void {
      if (!state.sessionId) {
        closeConnection(GatewayCloseCode.NOT_AUTHENTICATED, "Identify before leaving voice.");
        return;
      }
      const info = gateway.getSession(state.sessionId);
      if (!info) {
        return;
      }
      handleVoiceLeave(voiceOpsDeps, info.userId, info.deviceId).catch(sendVoiceError);
    }

    function handleVoiceStateOp(payload: unknown): void {
      if (!state.sessionId) {
        closeConnection(GatewayCloseCode.NOT_AUTHENTICATED, "Identify before changing voice state.");
        return;
      }
      const parsed = voiceStatePayloadSchema.safeParse(payload);
      if (!parsed.success) {
        closeConnection(GatewayCloseCode.DECODE_ERROR, "The VOICE_STATE payload is not valid.");
        return;
      }
      const info = gateway.getSession(state.sessionId);
      if (!info) {
        return;
      }
      handleVoiceState(voiceOpsDeps, info.userId, info.deviceId, parsed.data).catch(sendVoiceError);
    }

    function handleToDeviceSend(payload: unknown): void {
      if (!state.sessionId) {
        closeConnection(GatewayCloseCode.NOT_AUTHENTICATED, "Identify before you send to-device messages.");
        return;
      }
      const parsed = sendToDeviceRequestSchema.safeParse(payload);
      if (!parsed.success) {
        closeConnection(GatewayCloseCode.DECODE_ERROR, "The TO_DEVICE_SEND payload is not valid.");
        return;
      }
      const info = gateway.getSession(state.sessionId);
      if (!delivery || !info) {
        return;
      }
      // The same rules as POST /to-device. The op has no reply: a voice signal that fails is lost, and WebRTC recovers.
      const toDeviceDeps = { db, delivery, log: app.log };
      state.toDeviceChain = state.toDeviceChain
        .then(() =>
          sendToDevice(toDeviceDeps, info.userId, info.deviceId, parsed.data.messages, deps.toDeviceQueueLimit ?? TO_DEVICE_QUEUE_LIMIT),
        )
        .then(
          () => undefined,
          (error: unknown) => {
            if (error instanceof AppError) {
              app.log.info({ code: error.code }, "The server rejected a TO_DEVICE_SEND op.");
            } else {
              app.log.error(error, "The server could not store the messages of a TO_DEVICE_SEND op.");
            }
          },
        );
    }

    function handleToDeviceAck(payload: unknown): void {
      if (!state.sessionId) {
        closeConnection(GatewayCloseCode.NOT_AUTHENTICATED, "Identify before you acknowledge messages.");
        return;
      }
      const parsed = toDeviceAckPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        closeConnection(GatewayCloseCode.DECODE_ERROR, "The TO_DEVICE_ACK payload is not valid.");
        return;
      }
      delivery?.ack(state.sessionId, BigInt(parsed.data.upToId), parsed.data.resync ?? false).catch((error) => {
        app.log.error(error, "The server could not delete acknowledged to-device messages.");
      });
    }

    socket.on("message", (raw) => {
      if (state.closed) {
        return;
      }

      const now = Date.now();
      state.messageTimestamps = state.messageTimestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
      state.messageTimestamps.push(now);
      if (state.messageTimestamps.length > RATE_LIMIT_MAX_MESSAGES) {
        closeConnection(GatewayCloseCode.RATE_LIMITED, "Too many messages.");
        return;
      }

      let envelope;
      try {
        const text = typeof raw === "string" ? raw : raw.toString("utf8");
        envelope = gatewayEnvelopeSchema.parse(JSON.parse(text));
      } catch {
        closeConnection(GatewayCloseCode.DECODE_ERROR, "The message is not a valid gateway envelope.");
        return;
      }

      if (!state.sessionId && envelope.op !== GatewayOpcode.IDENTIFY && envelope.op !== GatewayOpcode.RESUME) {
        closeConnection(GatewayCloseCode.NOT_AUTHENTICATED, "Identify before sending other messages.");
        return;
      }

      switch (envelope.op) {
        case GatewayOpcode.IDENTIFY:
          handleIdentify(envelope.d).catch((error: unknown) => {
            app.log.error(error, "The server could not complete an IDENTIFY.");
            closeConnection(GatewayCloseCode.UNKNOWN_ERROR, "The server could not start the session.");
          });
          break;
        case GatewayOpcode.RESUME:
          handleResume(envelope.d);
          break;
        case GatewayOpcode.HEARTBEAT:
          handleHeartbeat(envelope.d);
          break;
        case GatewayOpcode.PRESENCE_SET:
          handlePresenceSet(envelope.d);
          break;
        case GatewayOpcode.TYPING:
          handleTypingOp(envelope.d);
          break;
        case GatewayOpcode.VOICE_JOIN:
          handleVoiceJoinOp(envelope.d);
          break;
        case GatewayOpcode.VOICE_LEAVE:
          handleVoiceLeaveOp();
          break;
        case GatewayOpcode.VOICE_STATE:
          handleVoiceStateOp(envelope.d);
          break;
        case GatewayOpcode.TO_DEVICE_SEND:
          handleToDeviceSend(envelope.d);
          break;
        case GatewayOpcode.TO_DEVICE_ACK:
          handleToDeviceAck(envelope.d);
          break;
        default:
          closeConnection(GatewayCloseCode.UNKNOWN_OPCODE, "Unknown opcode.");
      }
    });

    socket.on("close", (code: number) => {
      state.closed = true;
      if (state.identifyTimer) {
        clearTimeout(state.identifyTimer);
      }
      if (state.heartbeatTimer) {
        clearTimeout(state.heartbeatTimer);
      }
      detachSession(code);
    });

    socket.on("error", () => {
      closeConnection(GatewayCloseCode.UNKNOWN_ERROR, "Connection error.");
    });
  });
}

export { GatewayService, MAX_PAYLOAD_BYTES };

export type { DispatchEventName };
