// Validate and forward the three voice gateway ops (VOICE_JOIN, VOICE_LEAVE,
// VOICE_STATE). Voice signals are Olm to-device messages, so the server
// cannot read them (see docs/concepts/voice.md). Each function loads permissions, calls
// VoiceService, and sends the right dispatch through the gateway. A
// rejected op throws VoiceError; the gateway handler turns that into a
// VOICE_ERROR sent back to the caller.
//
// A voice state has a guild for a guild voice channel, and no guild for the
// call of a DM or a group DM. The audience of a guild call is the guild
// members who can view the channel. The audience of a DM call is the
// recipients of the DM.
import { eq } from "drizzle-orm";
import {
  DispatchEvent,
  hasPermission,
  Permission,
  type VoiceJoinPayload,
  type VoiceStatePayload,
} from "@mortium/shared";
import type { DbClient } from "../../db/client.js";
import { channels } from "../../db/schema.js";
import { isMessagingBlocked, isPrivateChannelType, isRecipient } from "../dms/access.js";
import { channelPermissions, loadMemberContext } from "../guilds/member-context.js";
import { loadRecipientIds, type GatewayService } from "../gateway/service.js";
import type { CallRinger } from "./calls.js";
import { VoiceError, toVoiceStateUpdate, type VoiceService, type VoiceState } from "./service.js";

export interface VoiceOpsDeps {
  db: DbClient;
  gateway: GatewayService;
  voice: VoiceService;
  /** Rings the recipients of a DM call. Guild calls do not use it. */
  ringer?: CallRinger;
}

/** Everyone who must see the voice state of `state`. */
async function stateAudience(deps: Pick<VoiceOpsDeps, "db" | "gateway">, state: VoiceState): Promise<bigint[]> {
  if (state.guildId === null) {
    return loadRecipientIds(deps.db, state.channelId);
  }
  return deps.gateway.computeChannelViewers(deps.db, state.guildId, state.channelId);
}

/** Send a VOICE_STATE_UPDATE for `state` to everyone who can view its channel. */
export async function broadcastVoiceState(deps: Pick<VoiceOpsDeps, "db" | "gateway">, state: VoiceState): Promise<void> {
  const audience = await stateAudience(deps, state);
  deps.gateway.toUsers(audience, DispatchEvent.VOICE_STATE_UPDATE, toVoiceStateUpdate(state));
}

/**
 * Send a VOICE_STATE_UPDATE with a null channelId for `state`, to the
 * viewers of the channel it left. When the call of a DM is now empty, the
 * ring of that call stops.
 */
export async function broadcastVoiceLeave(
  deps: Pick<VoiceOpsDeps, "db" | "gateway"> & Partial<Pick<VoiceOpsDeps, "voice" | "ringer">>,
  state: VoiceState,
): Promise<void> {
  const audience = await stateAudience(deps, state);
  deps.gateway.toUsers(audience, DispatchEvent.VOICE_STATE_UPDATE, toVoiceStateUpdate(state, true));
  if (state.guildId === null && deps.voice && deps.voice.channelStates(state.channelId).length === 0) {
    deps.ringer?.stop(state.channelId);
  }
}

/** What the join op needs to know about the channel it joins. */
interface JoinTarget {
  guildId: bigint | null;
  forceMute: boolean;
}

async function resolveJoinTarget(deps: VoiceOpsDeps, userId: bigint, channelId: bigint): Promise<JoinTarget> {
  const rows = await deps.db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
  const channel = rows[0];
  if (!channel) {
    throw new VoiceError("NOT_A_VOICE_CHANNEL", "This is not a voice channel.");
  }

  if (isPrivateChannelType(channel.type)) {
    if (!(await isRecipient(deps.db, channelId, userId))) {
      throw new VoiceError("NO_PERMISSION", "You are not in this DM.");
    }
    if (await isMessagingBlocked(deps.db, channel, userId)) {
      throw new VoiceError("NO_PERMISSION", "You cannot call this user.");
    }
    return { guildId: null, forceMute: false };
  }

  if (channel.guildId === null || channel.type !== "voice") {
    throw new VoiceError("NOT_A_VOICE_CHANNEL", "This is not a voice channel.");
  }
  const context = await loadMemberContext(deps.db, channel.guildId, userId);
  if (!context) {
    throw new VoiceError("NO_PERMISSION", "You are not a member of this guild.");
  }
  const permissions = await channelPermissions(deps.db, channelId, context);
  if (!hasPermission(permissions, Permission.VIEW_CHANNEL) || !hasPermission(permissions, Permission.CONNECT)) {
    throw new VoiceError("NO_PERMISSION", "You do not have permission to join this voice channel.");
  }
  return { guildId: channel.guildId, forceMute: !hasPermission(permissions, Permission.SPEAK) };
}

export async function handleVoiceJoin(
  deps: VoiceOpsDeps,
  userId: bigint,
  deviceId: string,
  sessionId: string,
  payload: VoiceJoinPayload,
): Promise<void> {
  const channelId = BigInt(payload.channelId);
  const target = await resolveJoinTarget(deps, userId, channelId);

  const { state, previous } = deps.voice.join({
    userId,
    deviceId,
    sessionId,
    guildId: target.guildId,
    channelId,
    selfMute: payload.selfMute,
    selfDeaf: payload.selfDeaf,
    forceMute: target.forceMute,
    callId: payload.callId,
  });

  if (previous) {
    await broadcastVoiceLeave(deps, previous);
  }
  await broadcastVoiceState(deps, state);

  if (target.guildId === null && deps.ringer) {
    const peerCount = deps.voice.channelStates(channelId).length;
    if (peerCount > 1) {
      // Someone answered: the call does not need to ring any more.
      deps.ringer.stop(channelId);
    } else if (previous?.channelId !== channelId) {
      // The first person joined. A caller who only moves to another device does not ring again.
      deps.ringer.start(channelId, userId, await loadRecipientIds(deps.db, channelId));
    }
  }
}

export async function handleVoiceLeave(deps: VoiceOpsDeps, userId: bigint, deviceId: string): Promise<void> {
  const state = deps.voice.leave(userId, deviceId);
  if (!state) {
    return;
  }
  await broadcastVoiceLeave(deps, state);
}

export async function handleVoiceState(
  deps: VoiceOpsDeps,
  userId: bigint,
  deviceId: string,
  payload: VoiceStatePayload,
): Promise<void> {
  const current = deps.voice.getUserState(userId);
  if (!current || current.deviceId !== deviceId) {
    throw new VoiceError("NOT_IN_VOICE", "You are not in a voice channel.");
  }

  let hasSpeak = true;
  if (payload.selfMute === false && current.guildId !== null) {
    const context = await loadMemberContext(deps.db, current.guildId, userId);
    const permissions = context ? await channelPermissions(deps.db, current.channelId, context) : 0n;
    hasSpeak = hasPermission(permissions, Permission.SPEAK);
  }

  const state = deps.voice.updateState(userId, deviceId, payload, hasSpeak);
  await broadcastVoiceState(deps, state);
}

/**
 * Remove every voice peer of a channel that is being deleted, and send
 * each one a leave. `viewerIds` must be computed before the delete
 * commits, because deleted channels can no longer answer "who can view
 * this": the caller already has this list, from the CHANNEL_DELETE send.
 */
export function removeChannelVoice(
  deps: Pick<VoiceOpsDeps, "gateway" | "voice">,
  channelId: bigint,
  viewerIds: bigint[],
): void {
  const removed = deps.voice.removeChannel(channelId);
  for (const state of removed) {
    deps.gateway.toUsers(viewerIds, DispatchEvent.VOICE_STATE_UPDATE, toVoiceStateUpdate(state, true));
  }
}

/**
 * Remove every voice peer of `guildId` who no longer has VIEW_CHANNEL and
 * CONNECT in their channel, and broadcast a leave for each. Call this
 * after any change to guild membership or permissions: a leave, a kick, a
 * ban, or (in M5) a role or overwrite edit.
 */
export async function revalidateGuildVoice(deps: VoiceOpsDeps, guildId: bigint): Promise<void> {
  const removed = await deps.voice.revalidate(guildId, async (state) => {
    const context = await loadMemberContext(deps.db, guildId, state.userId);
    if (!context) {
      return false;
    }
    const permissions = await channelPermissions(deps.db, state.channelId, context);
    return hasPermission(permissions, Permission.VIEW_CHANNEL) && hasPermission(permissions, Permission.CONNECT);
  });
  for (const state of removed) {
    await broadcastVoiceLeave(deps, state);
  }
}
