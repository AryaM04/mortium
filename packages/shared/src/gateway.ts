// Gateway protocol types: opcodes, close codes and message envelope schemas.
// The gateway is a WebSocket connection. Every message is one JSON envelope:
//   { op, t?, s?, d }
// "op" says what kind of message it is. "t" names a dispatch event.
// "s" is a sequence number, used to resume after a disconnect.
// "d" is the payload, and its shape depends on "op" and "t".

import { z } from "zod";
import { banSchema, guildMemberSchema, guildViewSchema, roleSchema } from "./api/guilds.js";
import { eventSchema, readStateSchema } from "./api/messages.js";
import { idSchema } from "./api/common.js";
import { callRingPayloadSchema, dmChannelSchema } from "./api/dms.js";
import { relationshipSchema } from "./api/friends.js";
import { voiceStateSchema } from "./api/voice.js";

export const GatewayOpcode = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 3,
  HELLO: 4,
  HEARTBEAT_ACK: 5,
  VOICE_JOIN: 6,
  VOICE_LEAVE: 7,
  VOICE_STATE: 8,
  /** Sent by the client: to-device messages, with the rules of `POST /to-device`. Voice signals use it. */
  TO_DEVICE_SEND: 9,
  TYPING: 10,
  PRESENCE_SET: 11,
  INVALID_SESSION: 12,
  RECONNECT: 13,
  // 14 was VOICE_SIGNAL, the plaintext signal relay. Voice signals are now Olm to-device messages.
  /** Sent by the client: to-device messages up to an id are processed. */
  TO_DEVICE_ACK: 15,
} as const;

export type GatewayOpcodeValue = (typeof GatewayOpcode)[keyof typeof GatewayOpcode];

/**
 * Close codes the gateway uses on `ws.close(code, reason)`. Every one is
 * in the 4000-4999 application range, so it never collides with a
 * protocol-level WebSocket close code.
 */
export const GatewayCloseCode = {
  UNKNOWN_ERROR: 4000,
  UNKNOWN_OPCODE: 4001,
  DECODE_ERROR: 4002,
  NOT_AUTHENTICATED: 4003,
  AUTH_FAILED: 4004,
  ALREADY_AUTHENTICATED: 4005,
  RATE_LIMITED: 4008,
  SESSION_TIMED_OUT: 4009,
  DEVICE_REVOKED: 4010,
} as const;

export type GatewayCloseCodeValue = (typeof GatewayCloseCode)[keyof typeof GatewayCloseCode];

export const gatewayEnvelopeSchema = z.object({
  op: z.number().int(),
  t: z.string().optional(),
  s: z.number().int().optional(),
  d: z.unknown(),
});

export type GatewayEnvelope = z.infer<typeof gatewayEnvelopeSchema>;

/** Sent by the server right after the connection opens. */
export const helloPayloadSchema = z.object({
  heartbeatIntervalMs: z.number().int().positive(),
});

/** Sent by the client to log in on this connection. */
export const identifyPayloadSchema = z.object({
  accessToken: z.string().min(1),
  deviceId: z.string().min(1),
});

/** Sent by the client to resume a dropped connection without a full reload. */
export const resumePayloadSchema = z.object({
  accessToken: z.string().min(1),
  sessionId: z.string().min(1),
  lastSequence: z.number().int().nonnegative(),
});

/** Sent by the client to report a heartbeat. `s` is the last sequence it saw, or null. */
export const heartbeatPayloadSchema = z.object({
  s: z.number().int().nonnegative().nullable(),
});

/** Sent by the client to set its own presence status. */
export const presenceStatusSchema = z.enum(["online", "idle", "dnd", "invisible"]);
export const presenceSetPayloadSchema = z.object({
  status: presenceStatusSchema,
});

/** The presence the server shows to other users: invisible looks like offline. */
export const visiblePresenceStatusSchema = z.enum(["online", "idle", "dnd", "offline"]);

export const presenceEntrySchema = z.object({
  userId: z.string().min(1),
  status: visiblePresenceStatusSchema,
});

/** Sent by the server once IDENTIFY or RESUME succeeds. */
export const readyPayloadSchema = z.object({
  sessionId: z.string().min(1),
  user: z.object({ id: z.string().min(1) }).passthrough(),
  guilds: z.array(guildViewSchema),
  presences: z.array(presenceEntrySchema),
  /** The caller's last-read event id per channel, for unread markers. */
  readStates: z.array(readStateSchema),
  /** Every friend, pending request and block of the caller. */
  relationships: z.array(relationshipSchema).default([]),
  /** Every DM and group DM the caller is in. */
  privateChannels: z.array(dmChannelSchema).default([]),
  /** The current voice state of every peer in a DM call of the caller. */
  privateVoiceStates: z.array(voiceStateSchema).default([]),
  /** Each DM call that rings for the caller now, so that a reload keeps the call card. */
  incomingCalls: z.array(callRingPayloadSchema).default([]),
  /** How many one-time keys the server has for this device. */
  oneTimeKeyCount: z.number().int().nonnegative().default(0),
  /** True when this device has no fallback key, or a claim used it. */
  needsFallbackKey: z.boolean().default(false),
});

/** Sent by the server after a successful RESUME, once missed dispatches replay. */
export const resumedPayloadSchema = z.object({});

/** Sent by the server when RESUME cannot succeed. The client must IDENTIFY again. */
export const invalidSessionPayloadSchema = z.object({
  canResume: z.literal(false),
});

/** Sent by the server to guild members after a role is created. */
export const guildRoleCreatePayloadSchema = z.object({ guildId: idSchema, role: roleSchema });
/** Sent by the server to guild members after a role is edited. */
export const guildRoleUpdatePayloadSchema = z.object({ guildId: idSchema, role: roleSchema });
/** Sent by the server to guild members after a role is deleted. */
export const guildRoleDeletePayloadSchema = z.object({ guildId: idSchema, roleId: idSchema });

/** Sent to members with BAN_MEMBERS after a ban is added or removed. */
export const guildBanAddPayloadSchema = banSchema;
export const guildBanRemovePayloadSchema = z.object({ guildId: idSchema, userId: idSchema });

/** Sent by the server after a member's roles or nickname change. */
export const guildMemberUpdatePayloadSchema = guildMemberSchema;

export const guildDeletePayloadSchema = z.object({ id: z.string().min(1) });
/** `guildId` is null when the channel is a DM or a group DM. */
export const channelDeletePayloadSchema = z.object({ id: z.string().min(1), guildId: z.string().min(1).nullable() });
export const guildMemberRemovePayloadSchema = z.object({
  guildId: z.string().min(1),
  userId: z.string().min(1),
});
export const presenceUpdatePayloadSchema = presenceEntrySchema;

/** Sent by the server to channel viewers right after a new event commits. */
export const eventCreatePayloadSchema = eventSchema;

/** Sent by the server to channel viewers after a redaction: the target event and its redacted relations. */
export const eventRedactPayloadSchema = z.object({
  channelId: idSchema,
  ids: z.array(idSchema).min(1),
});

/** Sent by the client to say it is typing in a channel. */
export const typingPayloadSchema = z.object({
  channelId: idSchema,
});

/** Sent by the server to other viewers of a channel when someone is typing. */
export const typingStartPayloadSchema = z.object({
  channelId: idSchema,
  userId: idSchema,
});

/** Sent by the server to a user's other sessions once one session marks a channel read. */
export const readStateUpdatePayloadSchema = readStateSchema;

/** Sent by the client to join a voice channel, or to move to a new one. */
export const voiceJoinPayloadSchema = z.object({
  channelId: idSchema,
  selfMute: z.boolean(),
  selfDeaf: z.boolean(),
  /** A random id for this join. Encrypted voice signals carry it, so that a peer can drop a stale signal. */
  callId: z.string().min(1).max(64).optional(),
});

/** Sent by the client to leave voice. It carries no fields. */
export const voiceLeavePayloadSchema = z.object({});

/** Sent by the client to change its own mute, deafen, video or stream state. */
export const voiceStatePayloadSchema = z.object({
  selfMute: z.boolean().optional(),
  selfDeaf: z.boolean().optional(),
  selfVideo: z.boolean().optional(),
  selfStream: z.boolean().optional(),
});

/** Sent by the server: the current voice state of one peer, to guild members who can view the channel. */
export const voiceStateUpdatePayloadSchema = voiceStateSchema;

/** The stable codes the server uses to reject a voice op. */
export const voiceErrorCodeSchema = z.enum([
  "CHANNEL_FULL",
  "NO_PERMISSION",
  "NOT_A_VOICE_CHANNEL",
  "STREAM_IN_USE",
  "NOT_IN_VOICE",
]);
export type VoiceErrorCode = z.infer<typeof voiceErrorCodeSchema>;

/** Sent by the server when a voice op is rejected. */
export const voiceErrorPayloadSchema = z.object({
  code: voiceErrorCodeSchema,
  message: z.string(),
});

export type HelloPayload = z.infer<typeof helloPayloadSchema>;
export type IdentifyPayload = z.infer<typeof identifyPayloadSchema>;
export type ResumePayload = z.infer<typeof resumePayloadSchema>;
export type HeartbeatPayload = z.infer<typeof heartbeatPayloadSchema>;
export type PresenceSetPayload = z.infer<typeof presenceSetPayloadSchema>;
export type PresenceStatus = z.infer<typeof presenceStatusSchema>;
export type VisiblePresenceStatus = z.infer<typeof visiblePresenceStatusSchema>;
export type PresenceEntry = z.infer<typeof presenceEntrySchema>;
export type ReadyPayload = z.infer<typeof readyPayloadSchema>;
export type InvalidSessionPayload = z.infer<typeof invalidSessionPayloadSchema>;
export type GuildRoleCreatePayload = z.infer<typeof guildRoleCreatePayloadSchema>;
export type GuildRoleUpdatePayload = z.infer<typeof guildRoleUpdatePayloadSchema>;
export type GuildRoleDeletePayload = z.infer<typeof guildRoleDeletePayloadSchema>;
export type GuildBanAddPayload = z.infer<typeof guildBanAddPayloadSchema>;
export type GuildBanRemovePayload = z.infer<typeof guildBanRemovePayloadSchema>;
export type GuildMemberUpdatePayload = z.infer<typeof guildMemberUpdatePayloadSchema>;
export type GuildDeletePayload = z.infer<typeof guildDeletePayloadSchema>;
export type ChannelDeletePayload = z.infer<typeof channelDeletePayloadSchema>;
export type GuildMemberRemovePayload = z.infer<typeof guildMemberRemovePayloadSchema>;
export type PresenceUpdatePayload = z.infer<typeof presenceUpdatePayloadSchema>;
export type EventCreatePayload = z.infer<typeof eventCreatePayloadSchema>;
export type EventRedactPayload = z.infer<typeof eventRedactPayloadSchema>;
export type TypingPayload = z.infer<typeof typingPayloadSchema>;
export type TypingStartPayload = z.infer<typeof typingStartPayloadSchema>;
export type ReadStateUpdatePayload = z.infer<typeof readStateUpdatePayloadSchema>;
export type VoiceJoinPayload = z.infer<typeof voiceJoinPayloadSchema>;
export type VoiceLeavePayload = z.infer<typeof voiceLeavePayloadSchema>;
export type VoiceStatePayload = z.infer<typeof voiceStatePayloadSchema>;
export type VoiceStateUpdatePayload = z.infer<typeof voiceStateUpdatePayloadSchema>;
export type VoiceErrorPayload = z.infer<typeof voiceErrorPayloadSchema>;

/** Names of every dispatch event ("t" field), for the fan-out code and tests. */
export const DispatchEvent = {
  GUILD_CREATE: "GUILD_CREATE",
  GUILD_UPDATE: "GUILD_UPDATE",
  GUILD_DELETE: "GUILD_DELETE",
  CHANNEL_CREATE: "CHANNEL_CREATE",
  CHANNEL_UPDATE: "CHANNEL_UPDATE",
  CHANNEL_DELETE: "CHANNEL_DELETE",
  GUILD_MEMBER_ADD: "GUILD_MEMBER_ADD",
  GUILD_MEMBER_UPDATE: "GUILD_MEMBER_UPDATE",
  GUILD_MEMBER_REMOVE: "GUILD_MEMBER_REMOVE",
  GUILD_ROLE_CREATE: "GUILD_ROLE_CREATE",
  GUILD_ROLE_UPDATE: "GUILD_ROLE_UPDATE",
  GUILD_ROLE_DELETE: "GUILD_ROLE_DELETE",
  GUILD_BAN_ADD: "GUILD_BAN_ADD",
  GUILD_BAN_REMOVE: "GUILD_BAN_REMOVE",
  PRESENCE_UPDATE: "PRESENCE_UPDATE",
  EVENT_CREATE: "EVENT_CREATE",
  EVENT_REDACT: "EVENT_REDACT",
  TYPING_START: "TYPING_START",
  READ_STATE_UPDATE: "READ_STATE_UPDATE",
  VOICE_STATE_UPDATE: "VOICE_STATE_UPDATE",
  VOICE_ERROR: "VOICE_ERROR",
  RELATIONSHIP_ADD: "RELATIONSHIP_ADD",
  RELATIONSHIP_REMOVE: "RELATIONSHIP_REMOVE",
  CHANNEL_RECIPIENT_ADD: "CHANNEL_RECIPIENT_ADD",
  CHANNEL_RECIPIENT_REMOVE: "CHANNEL_RECIPIENT_REMOVE",
  CALL_RING: "CALL_RING",
  CALL_RING_STOP: "CALL_RING_STOP",
  USER_SETTINGS_UPDATE: "USER_SETTINGS_UPDATE",
  TO_DEVICE: "TO_DEVICE",
  DEVICE_LIST_UPDATE: "DEVICE_LIST_UPDATE",
  /** The user of the session changed, for example after an email verification. The payload is the full user. */
  USER_UPDATE: "USER_UPDATE",
} as const;

export type DispatchEventName = (typeof DispatchEvent)[keyof typeof DispatchEvent];
