// The gateway client: one WebSocket connection to the server's realtime
// gateway. It signs in, sends heartbeats, and resumes after a short
// network drop. See docs/concepts/gateway.md for the wire protocol.
import {
  GatewayCloseCode,
  GatewayOpcode,
  gatewayEnvelopeSchema,
  guildDeletePayloadSchema,
  guildMemberRemovePayloadSchema,
  channelDeletePayloadSchema,
  channelRecipientAddPayloadSchema,
  channelRecipientRemovePayloadSchema,
  callRingPayloadSchema,
  callRingStopPayloadSchema,
  dmChannelSchema,
  relationshipAddPayloadSchema,
  relationshipRemovePayloadSchema,
  userSettingsUpdatePayloadSchema,
  toDeviceDispatchPayloadSchema,
  deviceListUpdatePayloadSchema,
  guildSchema,
  guildViewSchema,
  channelSchema,
  guildMemberSchema,
  guildRoleCreatePayloadSchema,
  guildRoleUpdatePayloadSchema,
  guildRoleDeletePayloadSchema,
  guildBanAddPayloadSchema,
  guildBanRemovePayloadSchema,
  helloPayloadSchema,
  presenceUpdatePayloadSchema,
  readyPayloadSchema,
  resumedPayloadSchema,
  eventCreatePayloadSchema,
  eventRedactPayloadSchema,
  typingStartPayloadSchema,
  readStateUpdatePayloadSchema,
  voiceStateUpdatePayloadSchema,
  voiceErrorPayloadSchema,
  type DispatchEventName,
} from "@mortium/shared";
import { z } from "zod";

/** The connection's own lifecycle state, for a connection banner and the like. */
export type GatewayState = "connecting" | "ready" | "reconnecting" | "closed";

/** A dispatch, once decoded and validated. */
export interface GatewayDispatch {
  t: "READY" | "RESUMED" | DispatchEventName;
  d: unknown;
}

/** What the gateway client needs to get a fresh, usable access token. */
export interface GatewayApi {
  getAccessToken(): Promise<string>;
}

export interface CreateGatewayClientOptions {
  /** The gateway WebSocket URL, e.g. wss://host/gateway. */
  url: string;
  api: GatewayApi;
  /** The device ID of the signed-in session, sent on IDENTIFY and RESUME. */
  deviceId: string;
  onEvent(dispatch: GatewayDispatch): void;
  onState(state: GatewayState): void;
  /** Called when the client gives up for good: a stale device, or a token the server keeps rejecting. */
  onFatal?(reason: "device-revoked" | "auth-failed"): void;
  /** Injected for tests. Defaults to the global WebSocket. */
  createSocket?: (url: string) => WebSocketLike;
}

export interface GatewayClient {
  readonly state: GatewayState;
  /** Send a client-initiated message, e.g. PRESENCE_SET or TYPING. */
  send(op: number, d?: unknown): void;
  /** Close for good. No further reconnect happens after this. */
  close(): void;
}

/** The slice of the WebSocket interface this module needs, so tests can fake it. */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
}

const WS_OPEN = 1;

const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const INVALID_SESSION_MIN_WAIT_MS = 1_000;
const INVALID_SESSION_MAX_WAIT_MS = 5_000;

/** Zod schema for each dispatch event's payload, so unknown "t" values can be ignored safely. */
const DISPATCH_SCHEMAS: Record<string, z.ZodType> = {
  READY: readyPayloadSchema,
  RESUMED: resumedPayloadSchema,
  GUILD_CREATE: guildViewSchema,
  GUILD_UPDATE: guildSchema,
  GUILD_DELETE: guildDeletePayloadSchema,
  CHANNEL_CREATE: z.union([channelSchema, dmChannelSchema]),
  CHANNEL_UPDATE: z.union([channelSchema, dmChannelSchema]),
  CHANNEL_DELETE: channelDeletePayloadSchema,
  GUILD_MEMBER_ADD: guildMemberSchema,
  GUILD_MEMBER_UPDATE: guildMemberSchema,
  GUILD_MEMBER_REMOVE: guildMemberRemovePayloadSchema,
  GUILD_ROLE_CREATE: guildRoleCreatePayloadSchema,
  GUILD_ROLE_UPDATE: guildRoleUpdatePayloadSchema,
  GUILD_ROLE_DELETE: guildRoleDeletePayloadSchema,
  GUILD_BAN_ADD: guildBanAddPayloadSchema,
  GUILD_BAN_REMOVE: guildBanRemovePayloadSchema,
  PRESENCE_UPDATE: presenceUpdatePayloadSchema,
  EVENT_CREATE: eventCreatePayloadSchema,
  EVENT_REDACT: eventRedactPayloadSchema,
  TYPING_START: typingStartPayloadSchema,
  READ_STATE_UPDATE: readStateUpdatePayloadSchema,
  VOICE_STATE_UPDATE: voiceStateUpdatePayloadSchema,
  VOICE_ERROR: voiceErrorPayloadSchema,
  RELATIONSHIP_ADD: relationshipAddPayloadSchema,
  RELATIONSHIP_REMOVE: relationshipRemovePayloadSchema,
  CHANNEL_RECIPIENT_ADD: channelRecipientAddPayloadSchema,
  CHANNEL_RECIPIENT_REMOVE: channelRecipientRemovePayloadSchema,
  CALL_RING: callRingPayloadSchema,
  CALL_RING_STOP: callRingStopPayloadSchema,
  USER_SETTINGS_UPDATE: userSettingsUpdatePayloadSchema,
  TO_DEVICE: toDeviceDispatchPayloadSchema,
  DEVICE_LIST_UPDATE: deviceListUpdatePayloadSchema,
};

function defaultCreateSocket(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}

function randomBetween(minMs: number, maxMs: number): number {
  return minMs + Math.random() * (maxMs - minMs);
}

export function createGatewayClient(options: CreateGatewayClientOptions): GatewayClient {
  const createSocket = options.createSocket ?? defaultCreateSocket;

  let state: GatewayState = "connecting";
  let socket: WebSocketLike | null = null;
  let closedForGood = false;
  const unknownEventsLogged = new Set<string>();

  let sessionId: string | null = null;
  let lastSequence = 0;
  let hadReadySession = false;

  let heartbeatIntervalMs = 0;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let awaitingHeartbeatAck = false;

  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let consecutiveAuthFailures = 0;

  function setState(next: GatewayState): void {
    if (state === next) {
      return;
    }
    state = next;
    options.onState(state);
  }

  function clearHeartbeatTimer(): void {
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function rawSend(envelope: Record<string, unknown>): void {
    if (!socket || socket.readyState !== WS_OPEN) {
      return;
    }
    socket.send(JSON.stringify(envelope));
  }

  function sendHeartbeat(): void {
    awaitingHeartbeatAck = true;
    rawSend({ op: GatewayOpcode.HEARTBEAT, d: { s: lastSequence || null } });
  }

  function scheduleHeartbeat(delayMs: number): void {
    clearHeartbeatTimer();
    heartbeatTimer = setTimeout(() => {
      if (awaitingHeartbeatAck) {
        // The last heartbeat never got an ACK: the link is dead.
        teardownSocket();
        setState("reconnecting");
        scheduleReconnect();
        return;
      }
      sendHeartbeat();
      scheduleHeartbeat(heartbeatIntervalMs);
    }, delayMs);
  }

  function teardownSocket(): void {
    clearHeartbeatTimer();
    awaitingHeartbeatAck = false;
    if (socket) {
      socket.onopen = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      try {
        socket.close();
      } catch {
        // Already closed. Nothing to do.
      }
    }
    socket = null;
  }

  function scheduleReconnect(delayMsOverride?: number): void {
    clearReconnectTimer();
    const delay =
      delayMsOverride ?? Math.min(BACKOFF_MAX_MS, BACKOFF_INITIAL_MS * 2 ** reconnectAttempt) * Math.random();
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      connect();
    }, delay);
  }

  async function identify(): Promise<void> {
    const current = socket;
    const accessToken = await options.api.getAccessToken();
    // A new socket can replace this one while the token loads.
    if (socket !== current) {
      return;
    }
    // A new session starts. Its sequence numbers start again at 1.
    lastSequence = 0;
    rawSend({ op: GatewayOpcode.IDENTIFY, d: { accessToken, deviceId: options.deviceId } });
  }

  async function resume(): Promise<void> {
    const current = socket;
    const accessToken = await options.api.getAccessToken();
    if (socket !== current) {
      return;
    }
    rawSend({
      op: GatewayOpcode.RESUME,
      d: { accessToken, sessionId, lastSequence },
    });
  }

  function handleHello(payload: unknown): void {
    const parsed = helloPayloadSchema.safeParse(payload);
    const intervalMs = parsed.success ? parsed.data.heartbeatIntervalMs : 30_000;
    heartbeatIntervalMs = intervalMs;
    awaitingHeartbeatAck = false;
    scheduleHeartbeat(intervalMs * Math.random());

    if (sessionId && hadReadySession) {
      void resume();
    } else {
      void identify();
    }
  }

  function handleDispatch(t: string | undefined, d: unknown, seq: number | undefined): void {
    if (!t) {
      return;
    }
    if (t === "READY") {
      const parsed = readyPayloadSchema.safeParse(d);
      if (!parsed.success) {
        return;
      }
      // Do not set lastSequence here. IDENTIFY already set it to 0. A lower
      // value than a seen one would make a later RESUME replay old dispatches.
      sessionId = parsed.data.sessionId;
      hadReadySession = true;
      reconnectAttempt = 0;
      consecutiveAuthFailures = 0;
      setState("ready");
      options.onEvent({ t: "READY", d: parsed.data });
      return;
    }
    if (t === "RESUMED") {
      reconnectAttempt = 0;
      consecutiveAuthFailures = 0;
      setState("ready");
      options.onEvent({ t: "RESUMED", d: {} });
      return;
    }

    if (typeof seq === "number") {
      lastSequence = seq;
    }

    const schema = DISPATCH_SCHEMAS[t];
    if (!schema) {
      if (!unknownEventsLogged.has(t)) {
        unknownEventsLogged.add(t);
        console.warn(`The gateway sent an event this client does not know: ${t}.`);
      }
      return;
    }
    const parsed = schema.safeParse(d);
    if (!parsed.success) {
      if (!unknownEventsLogged.has(t)) {
        unknownEventsLogged.add(t);
        console.warn(`The gateway sent a ${t} event with a payload this client could not read.`);
      }
      return;
    }
    options.onEvent({ t: t as DispatchEventName, d: parsed.data });
  }

  function handleInvalidSession(): void {
    sessionId = null;
    hadReadySession = false;
    lastSequence = 0;
    setState("reconnecting");
    const delay = randomBetween(INVALID_SESSION_MIN_WAIT_MS, INVALID_SESSION_MAX_WAIT_MS);
    teardownSocket();
    scheduleReconnect(delay);
  }

  function handleMessage(raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return;
    }
    const parsed = gatewayEnvelopeSchema.safeParse(json);
    if (!parsed.success) {
      return;
    }
    const envelope = parsed.data;

    switch (envelope.op) {
      case GatewayOpcode.HELLO:
        handleHello(envelope.d);
        break;
      case GatewayOpcode.DISPATCH:
        handleDispatch(envelope.t, envelope.d, envelope.s);
        break;
      case GatewayOpcode.HEARTBEAT_ACK:
        awaitingHeartbeatAck = false;
        break;
      case GatewayOpcode.INVALID_SESSION:
        handleInvalidSession();
        break;
      case GatewayOpcode.RECONNECT:
        teardownSocket();
        setState("reconnecting");
        scheduleReconnect(0);
        break;
      default:
        // An opcode this client does not send or expect. Ignore it.
        break;
    }
  }

  function handleClose(code: number): void {
    teardownSocket();
    if (closedForGood) {
      return;
    }

    if (code === GatewayCloseCode.DEVICE_REVOKED) {
      setState("closed");
      closedForGood = true;
      options.onFatal?.("device-revoked");
      return;
    }

    if (code === GatewayCloseCode.AUTH_FAILED) {
      consecutiveAuthFailures += 1;
      if (consecutiveAuthFailures >= 2) {
        setState("closed");
        closedForGood = true;
        options.onFatal?.("auth-failed");
        return;
      }
      // First failure: try one more time with a freshly fetched token.
      setState("reconnecting");
      scheduleReconnect(0);
      return;
    }

    setState("reconnecting");
    scheduleReconnect();
  }

  function connect(): void {
    if (closedForGood) {
      return;
    }
    clearReconnectTimer();
    // Remove the old socket first. Its late close must not close the new socket.
    teardownSocket();

    const nextSocket = createSocket(options.url);
    socket = nextSocket;
    nextSocket.onmessage = (event) => handleMessage(event.data);
    nextSocket.onclose = (event) => handleClose(event.code);
    nextSocket.onerror = () => {
      // The close handler runs right after this and drives reconnect.
    };
    nextSocket.onopen = () => {
      // Nothing to send yet: the server speaks first, with HELLO.
    };
  }

  function handleOnline(): void {
    // Connect at once only while the client waits for the reconnect timer.
    // A socket that is open or opens now needs no second socket.
    if (state === "reconnecting" && !socket) {
      clearReconnectTimer();
      connect();
    }
  }

  if (typeof window !== "undefined") {
    window.addEventListener("online", handleOnline);
  }

  connect();

  return {
    get state() {
      return state;
    },
    send(op: number, d?: unknown): void {
      rawSend({ op, d });
    },
    close(): void {
      closedForGood = true;
      clearReconnectTimer();
      teardownSocket();
      if (typeof window !== "undefined") {
        window.removeEventListener("online", handleOnline);
      }
      setState("closed");
    },
  };
}
