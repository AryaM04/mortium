// The in-memory voice hub. It holds voice state only, for live sessions.
// It never touches media: media flows peer to peer (see docs/concepts/voice.md).
//
// A "peer" is a (userId, deviceId) pair. A user has at most one voice state
// at a time: joining from another device, or another channel, replaces the
// old state. Two indexes make lookups cheap and keep this bounded by the
// number of live voice sessions:
//   userPeer:     userId    -> VoiceState (a user's one live voice state)
//   channelPeers: channelId -> peerKey -> VoiceState (who is in a channel)
import type { VoiceErrorCode, VoiceStateUpdatePayload } from "@mortium/shared";

/** How many peers a voice channel can hold at once. */
export const VOICE_CHANNEL_CAP = 10;

/** How long a disconnected peer's voice state stays, in case it resumes. Default 15 s. */
export const DEFAULT_VOICE_GRACE_MS = 15_000;

/** Thrown by a VoiceService method when a voice op must be rejected. The
 * gateway handler turns this into a VOICE_ERROR sent back to the caller. */
export class VoiceError extends Error {
  readonly code: VoiceErrorCode;
  constructor(code: VoiceErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface VoiceState {
  userId: bigint;
  deviceId: string;
  /** The guild of the channel. Null for a call in a DM or a group DM. */
  guildId: bigint | null;
  channelId: bigint;
  selfMute: boolean;
  selfDeaf: boolean;
  selfVideo: boolean;
  selfStream: boolean;
  /** Set by a moderator with MUTE_MEMBERS/DEAFEN_MEMBERS. A server-muted peer cannot self-unmute. */
  serverMute: boolean;
  serverDeaf: boolean;
  joinedAt: string;
  /** The random id that the client chose for this join, or undefined. */
  callId?: string;
  /** The gateway session that owns this state. Only a close of this session starts the grace timer. */
  sessionId: string;
}

export interface JoinInput {
  userId: bigint;
  deviceId: string;
  sessionId: string;
  guildId: bigint | null;
  channelId: bigint;
  selfMute: boolean;
  selfDeaf: boolean;
  /** True when the caller lacks SPEAK in this channel: selfMute is forced on. */
  forceMute: boolean;
  callId?: string;
}

export interface UpdateStateInput {
  selfMute?: boolean;
  selfDeaf?: boolean;
  selfVideo?: boolean;
  selfStream?: boolean;
}

/** Turn one voice state into the wire shape sent as VOICE_STATE_UPDATE. */
export function toVoiceStateUpdate(state: VoiceState, leaving = false): VoiceStateUpdatePayload {
  return {
    guildId: state.guildId?.toString() ?? null,
    channelId: leaving ? null : state.channelId.toString(),
    userId: state.userId.toString(),
    deviceId: state.deviceId,
    selfMute: state.selfMute,
    selfDeaf: state.selfDeaf,
    selfVideo: state.selfVideo,
    selfStream: state.selfStream,
    serverMute: state.serverMute,
    serverDeaf: state.serverDeaf,
    joinedAt: state.joinedAt,
    ...(state.callId === undefined ? {} : { callId: state.callId }),
  };
}

function sameGuild(state: VoiceState | undefined, guildId: bigint | null): state is VoiceState {
  return state !== undefined && guildId !== null && state.guildId === guildId;
}

export class VoiceService {
  private readonly graceMs: number;
  private readonly userPeer = new Map<string, VoiceState>();
  private readonly channelPeers = new Map<string, Map<string, VoiceState>>();
  private readonly graceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(graceMs: number = DEFAULT_VOICE_GRACE_MS) {
    this.graceMs = graceMs;
  }

  private peerKey(userId: bigint, deviceId: string): string {
    return `${userId.toString()}:${deviceId}`;
  }

  /** The caller's current voice state, if any. */
  getUserState(userId: bigint): VoiceState | undefined {
    return this.userPeer.get(userId.toString());
  }

  /** Every peer currently in a channel. */
  channelStates(channelId: bigint): VoiceState[] {
    return [...(this.channelPeers.get(channelId.toString())?.values() ?? [])];
  }

  private addInternal(state: VoiceState): void {
    this.userPeer.set(state.userId.toString(), state);
    const channelKey = state.channelId.toString();
    let peers = this.channelPeers.get(channelKey);
    if (!peers) {
      peers = new Map();
      this.channelPeers.set(channelKey, peers);
    }
    peers.set(this.peerKey(state.userId, state.deviceId), state);
  }

  private removeInternal(state: VoiceState): void {
    this.userPeer.delete(state.userId.toString());
    const channelKey = state.channelId.toString();
    const peers = this.channelPeers.get(channelKey);
    if (!peers) {
      return;
    }
    peers.delete(this.peerKey(state.userId, state.deviceId));
    if (peers.size === 0) {
      this.channelPeers.delete(channelKey);
    }
  }

  private clearGrace(state: VoiceState): void {
    const key = this.peerKey(state.userId, state.deviceId);
    const timer = this.graceTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.graceTimers.delete(key);
    }
  }

  /**
   * Join a channel, or move to it from wherever the user was. Throws
   * CHANNEL_FULL when the target channel is already at capacity. Returns
   * the new state, and the state the user had before (if any), so the
   * caller can broadcast a leave for the old channel.
   */
  join(input: JoinInput): { state: VoiceState; previous: VoiceState | null } {
    const existing = this.userPeer.get(input.userId.toString());
    this.checkCapacity(input.channelId, existing);

    let previous: VoiceState | null = null;
    if (existing) {
      previous = existing;
      this.removeInternal(existing);
      this.clearGrace(existing);
    }

    const state: VoiceState = {
      userId: input.userId,
      deviceId: input.deviceId,
      guildId: input.guildId,
      channelId: input.channelId,
      selfMute: input.forceMute ? true : input.selfMute,
      selfDeaf: input.selfDeaf,
      selfVideo: false,
      selfStream: false,
      // A rejoin in the same guild keeps the moderator flags, so that a rejoin does not remove them.
      serverMute: sameGuild(existing, input.guildId) ? existing.serverMute : false,
      serverDeaf: sameGuild(existing, input.guildId) ? existing.serverDeaf : false,
      joinedAt: new Date().toISOString(),
      callId: input.callId,
      sessionId: input.sessionId,
    };
    this.addInternal(state);
    return { state, previous };
  }

  /**
   * Throw CHANNEL_FULL when the channel has no free place. The old state of
   * the user does not count, because the join or the move replaces it.
   */
  private checkCapacity(channelId: bigint, existing: VoiceState | undefined): void {
    const peers = this.channelPeers.get(channelId.toString());
    const ownPlace = existing && existing.channelId === channelId ? 1 : 0;
    if (peers && peers.size - ownPlace >= VOICE_CHANNEL_CAP) {
      throw new VoiceError("CHANNEL_FULL", "This voice channel already has the most members it can hold.");
    }
  }

  /** Leave voice. A no-op (returns null) when the caller is not the live device for this user. */
  leave(userId: bigint, deviceId: string): VoiceState | null {
    const state = this.userPeer.get(userId.toString());
    if (!state || state.deviceId !== deviceId) {
      return null;
    }
    this.removeInternal(state);
    this.clearGrace(state);
    return state;
  }

  /**
   * Apply a self-state patch (mute, deafen, video, stream). Throws
   * NOT_IN_VOICE, STREAM_IN_USE or NO_PERMISSION when the change must be
   * rejected. `hasSpeak` is only consulted when the caller tries to unmute.
   */
  updateState(userId: bigint, deviceId: string, patch: UpdateStateInput, hasSpeak: boolean): VoiceState {
    const state = this.userPeer.get(userId.toString());
    if (!state || state.deviceId !== deviceId) {
      throw new VoiceError("NOT_IN_VOICE", "You are not in a voice channel.");
    }
    if (patch.selfStream === true && !state.selfStream) {
      const streaming = this.channelStates(state.channelId).some(
        (peer) => peer.selfStream && peer.userId !== userId,
      );
      if (streaming) {
        throw new VoiceError("STREAM_IN_USE", "Someone else in this channel is already sharing their screen.");
      }
    }
    if (patch.selfMute === false && !hasSpeak) {
      throw new VoiceError("NO_PERMISSION", "You do not have permission to speak in this channel.");
    }
    if (patch.selfMute === false && state.serverMute) {
      throw new VoiceError("NO_PERMISSION", "A moderator muted you. You cannot unmute yourself.");
    }

    if (patch.selfMute !== undefined) {
      state.selfMute = patch.selfMute;
    }
    if (patch.selfDeaf !== undefined) {
      state.selfDeaf = patch.selfDeaf;
    }
    if (patch.selfVideo !== undefined) {
      state.selfVideo = patch.selfVideo;
    }
    if (patch.selfStream !== undefined) {
      state.selfStream = patch.selfStream;
    }
    return state;
  }

  /**
   * Start the grace timer for a peer whose socket just disconnected. If
   * the peer is still this exact (user, device) when the timer fires, its
   * state is removed and `onExpire` runs with the removed state. Does
   * nothing if the state already changed (a move, a leave, or a rejoin),
   * or if another session of the same device owns the state.
   */
  scheduleGrace(userId: bigint, deviceId: string, sessionId: string, onExpire: (state: VoiceState) => void): void {
    const state = this.userPeer.get(userId.toString());
    if (!state || state.deviceId !== deviceId || state.sessionId !== sessionId) {
      return;
    }
    this.clearGrace(state);
    const key = this.peerKey(userId, deviceId);
    const timer = setTimeout(() => {
      this.graceTimers.delete(key);
      const current = this.userPeer.get(userId.toString());
      if (current && current.deviceId === deviceId) {
        this.removeInternal(current);
        onExpire(current);
      }
    }, this.graceMs);
    timer.unref?.();
    this.graceTimers.set(key, timer);
  }

  /** Cancel a pending grace timer, e.g. because the session that owns the state resumed in time. */
  cancelGrace(userId: bigint, deviceId: string, sessionId: string): void {
    const state = this.userPeer.get(userId.toString());
    if (state && state.deviceId === deviceId && state.sessionId === sessionId) {
      this.clearGrace(state);
    }
  }

  /**
   * Give the voice state of a device to a new session of that device, and
   * cancel its grace timer. Call this after IDENTIFY. Does nothing when the
   * session that owns the state is still live (`isLive` returns true),
   * for example another tab of the same browser.
   */
  claimForSession(userId: bigint, deviceId: string, sessionId: string, isLive: (sessionId: string) => boolean): void {
    const state = this.userPeer.get(userId.toString());
    if (!state || state.deviceId !== deviceId || isLive(state.sessionId)) {
      return;
    }
    this.clearGrace(state);
    state.sessionId = sessionId;
  }

  /** Remove a device's voice state at once, with no grace period, e.g. on logout or device revoke. */
  removeImmediate(userId: bigint, deviceId: string): VoiceState | null {
    const state = this.userPeer.get(userId.toString());
    if (!state || state.deviceId !== deviceId) {
      return null;
    }
    this.clearGrace(state);
    this.removeInternal(state);
    return state;
  }

  /** Remove every peer of one channel, e.g. because the channel was deleted. */
  removeChannel(channelId: bigint): VoiceState[] {
    const peers = this.channelPeers.get(channelId.toString());
    if (!peers) {
      return [];
    }
    const removed = [...peers.values()];
    for (const state of removed) {
      this.clearGrace(state);
    }
    this.channelPeers.delete(channelId.toString());
    for (const state of removed) {
      this.userPeer.delete(state.userId.toString());
    }
    return removed;
  }

  /**
   * Remove every peer of one guild whose current state fails `isAllowed`
   * (no more VIEW_CHANNEL or CONNECT). Call this whenever guild membership
   * or permissions change: a leave, a kick, a ban, or a role or overwrite
   * edit. Returns the removed states, so the caller can broadcast a leave.
   */
  async revalidate(guildId: bigint, isAllowed: (state: VoiceState) => Promise<boolean>): Promise<VoiceState[]> {
    const candidates = [...this.userPeer.values()].filter((state) => state.guildId === guildId);
    const removed: VoiceState[] = [];
    for (const state of candidates) {
      if (!(await isAllowed(state))) {
        this.clearGrace(state);
        this.removeInternal(state);
        removed.push(state);
      }
    }
    return removed;
  }

  /**
   * Set the server-mute or server-deafen flag of a live peer. A no-op
   * (returns null) when the target is not in voice.
   */
  applyServerModeration(userId: bigint, patch: { serverMute?: boolean; serverDeaf?: boolean }): VoiceState | null {
    const state = this.userPeer.get(userId.toString());
    if (!state) {
      return null;
    }
    if (patch.serverMute !== undefined) {
      state.serverMute = patch.serverMute;
    }
    if (patch.serverDeaf !== undefined) {
      state.serverDeaf = patch.serverDeaf;
    }
    return state;
  }

  /**
   * Move a live peer to another voice channel, or disconnect it when
   * `channelId` is null. Throws CHANNEL_FULL when the destination is
   * already at capacity. Returns null when the target is not in voice.
   */
  moveUser(userId: bigint, channelId: bigint | null): { previous: VoiceState; next: VoiceState | null } | null {
    const existing = this.userPeer.get(userId.toString());
    if (!existing) {
      return null;
    }
    if (channelId === null) {
      this.removeInternal(existing);
      this.clearGrace(existing);
      return { previous: existing, next: null };
    }
    this.checkCapacity(channelId, existing);
    this.removeInternal(existing);
    this.clearGrace(existing);
    // The client joins the new channel again with a new call id. Until then it
    // sends no camera or screen share there, and the one-stream check must apply.
    const next: VoiceState = { ...existing, channelId, selfVideo: false, selfStream: false };
    this.addInternal(next);
    return { previous: existing, next };
  }

  /** Test helper: how many peers (across every channel) are tracked right now. */
  get peerCount(): number {
    return this.userPeer.size;
  }
}
