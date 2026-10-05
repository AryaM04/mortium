// The voice engine: the client side of the WebRTC voice mesh. It owns
// one `RTCPeerConnection` per remote peer in the current voice channel,
// the local microphone track, and the Web Audio graph that mixes remote
// audio and drives speaking detection. It has no reference to `window`,
// `document`, `navigator` or the gateway: every browser API and every
// gateway call comes through `VoiceEngineDeps`, so a test can supply
// fakes for all of it. See docs/concepts/voice.md for the wire protocol
// this engine's signal transport rides on.
import type { VoiceErrorCode, VoiceStateJson } from "@mortium/shared";
import { applyOpusFec, capOpusBitrate } from "./sdp.js";
import { chooseVideoEncoding, type VideoEncodingKind } from "./adaptive.js";
import type { PeerKey, SignalPayload, SignalTransport } from "./signal-transport.js";

/** The audio bitrate when the server does not send one (an older server). */
export const DEFAULT_AUDIO_BITRATE_BPS = 40_000;

/** How often the shared speaking-detection timer samples every audio source. */
export const SPEAKING_TICK_MS = 100;
/** A source must stay below the volume threshold this long before speaking turns off. */
export const SPEAKING_OFF_MS = 300;
/** Average byte value (0-255) from `getByteFrequencyData` above which a source counts as speaking. */
export const SPEAKING_VOLUME_THRESHOLD = 12;

/** Delay before each ICE restart attempt: first attempt after 1 s, second after 2 s. */
export const ICE_RESTART_BACKOFFS_MS = [1_000, 2_000];
/** After this many failed restarts, the peer connection is closed and rebuilt from scratch. */
export const MAX_ICE_RESTARTS = ICE_RESTART_BACKOFFS_MS.length;

/** How long an offer can wait for an answer. Then the engine rolls the offer back and offers again. */
export const OFFER_ANSWER_TIMEOUT_MS = 10_000;

/** TURN credentials are re-fetched this long before they actually expire. */
export const TURN_REFRESH_SKEW_MS = 10 * 60 * 1_000;

/** How long `join()` waits for the server's own join echo before signaling anyway. */
export const JOIN_CONFIRM_TIMEOUT_MS = 5_000;

/** Pause between offering to each already-present peer at join. See the comment at its one call site. */
export const NEWCOMER_TRACK_SHARE_DELAY_MS = 600;

/** How long `setScreenShare(true)` waits for the server's VOICE_STATE_UPDATE confirmation before it proceeds anyway. */
export const STREAM_CONFIRM_TIMEOUT_MS = 5_000;

/** The camera's ideal capture size and frame rate, per the plan's video section. */
export const CAMERA_IDEAL_WIDTH = 1280;
export const CAMERA_IDEAL_HEIGHT = 720;
export const CAMERA_IDEAL_FRAME_RATE = 30;

/** How often the adaptive-quality timer samples stats and re-applies each video sender's encoding. */
export const ADAPTIVE_TICK_MS = 2_000;
/** The height assumed for a screen-share source when the captured track reports none. */
const SCREEN_ASSUMED_HEIGHT = 1080;

/**
 * Decide which side of a peer pair is "polite" for perfect negotiation.
 * Join each (userId, deviceId) pair into one string ("userId:deviceId")
 * and compare the two strings. The side whose string sorts LOWER is
 * polite. Both sides compute this the same way with no extra message,
 * because it depends only on identities both sides already know.
 */
export function comparePeerKeys(a: PeerKey, b: PeerKey): number {
  const aStr = `${a.userId}:${a.deviceId}`;
  const bStr = `${b.userId}:${b.deviceId}`;
  if (aStr < bStr) return -1;
  if (aStr > bStr) return 1;
  return 0;
}

/** True when `self` is the polite side of a negotiation with `peer`. */
export function isPolite(self: PeerKey, peer: PeerKey): boolean {
  return comparePeerKeys(self, peer) < 0;
}

function keyOf(key: PeerKey): string {
  return `${key.userId}:${key.deviceId}`;
}

/** The minimal shape of a remote `<audio>` element this engine needs. Real browser wiring uses `document.createElement("audio")`. */
export interface AudioElementLike {
  srcObject: MediaStream | null;
  muted: boolean;
}

export interface VoiceEngineDeps {
  getTurnCredentials(): Promise<{ iceServers: RTCIceServer[]; ttlSeconds: number; audioBitrateBps?: number }>;
  createSignalTransport(channelId: string): SignalTransport;
  sendVoiceJoin(channelId: string, selfMute: boolean, selfDeaf: boolean): void;
  sendVoiceLeave(): void;
  sendVoiceState(patch: { selfMute?: boolean; selfDeaf?: boolean; selfVideo?: boolean; selfStream?: boolean }): void;
  /** Who else is already in the channel, read once at join time (the newcomer offers to each of these). */
  getInitialPeers(channelId: string): PeerKey[];
  selfUserId: string;
  selfDeviceId: string;
  createPeerConnection(config: RTCConfiguration): RTCPeerConnection;
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  /** Captures the screen (or one window or tab), with system audio when the browser and the user's pick allow it. */
  getDisplayMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  createAudioContext(): AudioContext;
  /** Builds one remote audio sink. Defaults to `document.createElement("audio")` when `document` exists. */
  createAudioElement?(): AudioElementLike;
  /** Wall clock, injected for tests. Defaults to `Date.now`. */
  now?(): number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

/** One peer's connection state, for the UI to render a roster and derive a connection-quality summary. */
export interface VoicePeerState {
  userId: string;
  deviceId: string;
  connectionState: RTCPeerConnectionState;
  speaking: boolean;
  /** The peer's remote camera stream, or null when their camera is off. */
  cameraStream: MediaStream | null;
  /** The peer's remote screen-share stream, or null when they are not sharing. */
  screenStream: MediaStream | null;
}

export type VoiceEngineErrorKind =
  | "mic-permission-denied"
  | "camera-permission-denied"
  | "screen-permission-denied"
  | "output-device-unsupported"
  | "mic-disconnected"
  | "voice-error"
  | "ice-failed";

export interface VoiceEngineErrorEvent {
  kind: VoiceEngineErrorKind;
  message: string;
  code?: VoiceErrorCode;
}

export interface VoiceEngineEventMap {
  peers: VoicePeerState[];
  localSpeaking: boolean;
  error: VoiceEngineErrorEvent;
  /** The local camera or screen-share on/off state changed (a toggle call, or the browser's own "Stop sharing"). */
  localMedia: { cameraOn: boolean; screenOn: boolean };
  /** The engine muted the microphone itself, because the server refused an unmute. */
  forcedMute: true;
}

class Emitter<T> {
  private readonly listeners = new Set<(value: T) => void>();
  on(handler: (value: T) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }
  emit(value: T): void {
    for (const handler of this.listeners) {
      handler(value);
    }
  }
}

/** One peer's raw connection stats, for a debug panel or an end-to-end test. */
export interface VoiceDebugPeerStats {
  userId: string;
  deviceId: string;
  connectionState: RTCPeerConnectionState;
  /** The selected candidate pair's local candidate type, or null before ICE picks one. */
  selectedCandidateType: string | null;
  inboundBytesReceived: number;
  outboundBytesSent: number;
  inboundVideoBytesReceived: number;
  outboundVideoBytesSent: number;
  /** The adaptive-quality tier currently applied to the camera sender, or null when the camera is off for this peer. */
  cameraTier: number | null;
  /** The adaptive-quality tier currently applied to the screen-share sender, or null when not sharing to this peer. */
  screenTier: number | null;
}

export interface VoiceEngine {
  /** Join a voice channel. The guild id is null for the call of a DM or a group DM. Rejects when the server refuses the join. */
  join(guildId: string | null, channelId: string): Promise<void>;
  leave(): Promise<void>;
  setMute(muted: boolean): void;
  setDeafen(deafened: boolean): void;
  /** Use this microphone. Null means the default microphone. */
  setInputDevice(deviceId: string | null): void;
  /** Use this speaker or headset. Null means the default output device. */
  setOutputDevice(deviceId: string | null): Promise<void>;
  setUserVolume(userId: string, volume: number): void;
  /** Turn the local camera on or off, or switch its input device while on. A no-op when not in a call. */
  setCamera(on: boolean, deviceId?: string): Promise<void>;
  /** Turn local screen sharing on or off. A no-op when not in a call. See docs/concepts/voice.md for STREAM_IN_USE. */
  setScreenShare(on: boolean): Promise<void>;
  /** Forward a live VOICE_STATE_UPDATE dispatch for the current channel. See docs/concepts/voice.md. */
  onPeerVoiceState(update: VoiceStateJson): void;
  /** Forward a VOICE_ERROR dispatch. The caller owns the gateway subscription, not this engine. */
  handleVoiceError(payload: { code: VoiceErrorCode; message: string }): void;
  on<K extends keyof VoiceEngineEventMap>(event: K, handler: (value: VoiceEngineEventMap[K]) => void): () => void;
  /** Raw per-peer connection stats, read straight from each `RTCPeerConnection`. For a debug panel or a test, not the normal UI. */
  getDebugStats(): Promise<VoiceDebugPeerStats[]>;
  /** Whether the local microphone track is currently enabled, or null when not in a call. For a debug panel or a test. */
  isLocalTrackEnabled(): boolean | null;
  readonly peers: VoicePeerState[];
  /** The channel this engine is currently in, or null when not in a call. */
  readonly channelId: string | null;
  /** The guild that owns the current channel, or null when not in a call. */
  readonly guildId: string | null;
  /** Whether the local camera is on right now. */
  readonly cameraOn: boolean;
  /** Whether local screen sharing is on right now. */
  readonly screenOn: boolean;
  /** The local camera's stream, for a mirrored preview tile, or null when the camera is off. */
  readonly localCameraStream: MediaStream | null;
  /** The local screen-share stream, for a preview tile, or null when not sharing. */
  readonly localScreenStream: MediaStream | null;
}

interface SpeakingState {
  analyser: AnalyserNode | null;
  buffer: Uint8Array<ArrayBuffer> | null;
  speaking: boolean;
  belowTicks: number;
}

function createSpeakingState(): SpeakingState {
  return { analyser: null, buffer: null, speaking: false, belowTicks: 0 };
}

/** One video sender's running adaptive-quality state, kept across ticks so the policy sees consecutive samples and step-up cooldowns. */
interface AdaptiveSenderState {
  limitedSamples: number;
  tier: number | null;
  lastStepUpAt: number | null;
  lastApplied: { maxBitrate: number; scaleResolutionDownBy: number; maxFramerate: number } | null;
}

function createAdaptiveSenderState(): AdaptiveSenderState {
  return { limitedSamples: 0, tier: null, lastStepUpAt: null, lastApplied: null };
}

/**
 * Sample one audio source's analyser and apply the on/off hysteresis:
 * speaking turns on the first tick a source is above the threshold, and
 * turns off only after it has stayed below the threshold for
 * `SPEAKING_OFF_MS`. Returns the new speaking value when it changed, or
 * `null` when nothing changed this tick (the common case).
 */
function sampleSpeaking(state: SpeakingState): boolean | null {
  if (!state.analyser || !state.buffer) {
    return null;
  }
  state.analyser.getByteFrequencyData(state.buffer);
  let sum = 0;
  for (let i = 0; i < state.buffer.length; i += 1) {
    sum += state.buffer[i]!;
  }
  const average = sum / state.buffer.length;

  if (average > SPEAKING_VOLUME_THRESHOLD) {
    state.belowTicks = 0;
    if (!state.speaking) {
      state.speaking = true;
      return true;
    }
    return null;
  }

  state.belowTicks += 1;
  if (state.speaking && state.belowTicks * SPEAKING_TICK_MS >= SPEAKING_OFF_MS) {
    state.speaking = false;
    return false;
  }
  return null;
}

/** The Web Audio nodes and the helper element of one remote audio stream. */
interface RemoteAudio {
  source: MediaStreamAudioSourceNode | null;
  gain: GainNode | null;
  element: AudioElementLike | null;
}

interface PeerRuntime {
  key: PeerKey;
  pc: RTCPeerConnection;
  /** Whether this engine is the polite side of negotiation with this peer. See `isPolite`. */
  polite: boolean;
  makingOffer: boolean;
  /**
   * True only when code has just asked for the next `onnegotiationneeded`
   * event to start a real offer. Only `attemptIceRestart` sets this flag,
   * right before it calls `restartIce()`. `restartIce()` makes the browser
   * fire `onnegotiationneeded` to ask for a fresh offer with new ICE
   * credentials.
   *
   * Every other negotiation calls `negotiate()` directly at its own call
   * site, and does not rely on this event. Examples: the first offer to a
   * peer already in the call (see the newcomer loop in `join()`), and the
   * camera and screen share toggles (each calls `negotiate()` right after
   * it adds the transceiver that makes the call needed).
   *
   * For a peer that joins after us, we wait for their offer. We do not
   * send our own (see the comment on `onPeerVoiceState` below). But
   * `addTrack` in `ensurePeer` still makes the browser fire
   * `onnegotiationneeded` once on its own. Left unguarded, that fires an
   * unwanted offer, which collides with the newcomer's real offer. On the
   * polite side, that forces a rollback. On real Chromium, a connection
   * can fail to gather ICE candidates after such a rollback: both sides
   * reach signaling state "stable", but no candidates ever pass between
   * them, so `connectionState` stays at "new" forever.
   *
   * The flag defaults to false, so `onnegotiationneeded` does nothing
   * unless something just armed it. This stops the unwanted offer before
   * it starts, instead of recovering from the stuck connection after.
   */
  negotiationArmed: boolean;
  candidateQueue: RTCIceCandidateInit[];
  restartsAttempted: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
  /** Rolls back an offer that got no answer. See `OFFER_ANSWER_TIMEOUT_MS`. */
  offerTimer: ReturnType<typeof setTimeout> | null;
  /** The audio nodes of the peer's microphone. */
  micAudio: RemoteAudio | null;
  /** The audio nodes of the peer's screen share audio. They are apart from the microphone nodes. */
  screenAudio: RemoteAudio | null;
  connectionState: RTCPeerConnectionState;
  speakingState: SpeakingState;
  /** This peer's dedicated camera transceiver, added once and reused with `replaceTrack`. Null before the camera is ever turned on. */
  cameraTransceiver: RTCRtpTransceiver | null;
  /** This peer's dedicated screen-share video transceiver, added once and reused. */
  screenTransceiver: RTCRtpTransceiver | null;
  /** This peer's dedicated screen-share audio transceiver (system audio), added once and reused. */
  screenAudioTransceiver: RTCRtpTransceiver | null;
  /**
   * The stream id that this peer sees for our camera. A later toggle uses
   * `replaceTrack`, so the peer keeps the stream id of the first toggle.
   */
  cameraSentStreamId: string | null;
  /** The stream id that this peer sees for our screen share. See `cameraSentStreamId`. */
  screenSentStreamId: string | null;
  /** The remote camera stream id from the peer's last "media" signal, or null when they report no camera. */
  remoteCameraStreamId: string | null;
  /** The remote screen-share stream id from the peer's last "media" signal, or null when they report no screen share. */
  remoteScreenStreamId: string | null;
  /** The peer's remote camera stream, once `ontrack` and the media signal both identify it. */
  remoteCameraStream: MediaStream | null;
  /** The peer's remote screen-share stream, once `ontrack` and the media signal both identify it. */
  remoteScreenStream: MediaStream | null;
  /** Adaptive-quality running state for this peer's camera sender. */
  cameraAdaptive: AdaptiveSenderState;
  /** Adaptive-quality running state for this peer's screen-share sender. */
  screenAdaptive: AdaptiveSenderState;
  /** Each remote video stream of this peer that has a live, unmuted track, keyed by stream id. */
  remoteVideoStreams: Map<string, MediaStream>;
  /**
   * Every description-setting operation for this peer (an outgoing
   * negotiate() and an incoming handleDescription()) runs through this
   * queue, one at a time. Without it, an outgoing offer's createOffer()
   * and an incoming offer's rollback+setRemoteDescription can interleave
   * on the same RTCPeerConnection: the outgoing side's setLocalDescription
   * then fails ("wrong state: have-remote-offer") after the state moved
   * out from under it, and that peer connection never recovers, since
   * nothing schedules a retry. Serializing removes the interleaving
   * entirely: the signalingState a queued step reads is always still
   * current, because the previous step is fully finished by the time it
   * runs.
   */
  signalingQueue: Promise<void>;
}

export function createVoiceEngine(deps: VoiceEngineDeps): VoiceEngine {
  const nowFn = deps.now ?? (() => Date.now());
  const setTimeoutFn = deps.setTimeout ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeout ?? clearTimeout;

  const selfKey: PeerKey = { userId: deps.selfUserId, deviceId: deps.selfDeviceId };

  const emitters: { [K in keyof VoiceEngineEventMap]: Emitter<VoiceEngineEventMap[K]> } = {
    peers: new Emitter(),
    localSpeaking: new Emitter(),
    error: new Emitter(),
    localMedia: new Emitter(),
    forcedMute: new Emitter(),
  };

  const peers = new Map<string, PeerRuntime>();
  /** Peer ids currently being created by `ensurePeer`, so a concurrent caller joins the same creation instead of starting a second one. */
  const pendingEnsurePeer = new Map<string, Promise<PeerRuntime | null>>();
  const userVolumes = new Map<string, number>();

  let currentGuildId: string | null = null;
  let currentChannelId: string | null = null;
  let signalTransport: SignalTransport | null = null;
  let localStream: MediaStream | null = null;
  let audioContext: AudioContext | null = null;
  let masterGain: GainNode | null = null;
  let localSourceNode: MediaStreamAudioSourceNode | null = null;
  const localSpeakingState = createSpeakingState();
  let speakingTimer: ReturnType<typeof setTimeout> | null = null;
  /** Runs only while at least one local camera or screen track is live; see `ensureAdaptiveTimer`/`stopAdaptiveTimer`. */
  let adaptiveTimer: ReturnType<typeof setTimeout> | null = null;
  let turnCache: { iceServers: RTCIceServer[]; expiresAt: number } | null = null;
  // The server sets the voice audio bitrate. It comes with the TURN credentials.
  let audioBitrateBps = DEFAULT_AUDIO_BITRATE_BPS;
  // Resolves the moment our own VOICE_JOIN is confirmed by the server (its
  // VOICE_STATE_UPDATE echo for our own peer), so `join()` never starts
  // signaling before the server has actually registered us in the
  // channel. Without this, an offer sent right after VOICE_JOIN can beat
  // VOICE_JOIN's own processing and come back NOT_IN_VOICE. The value is
  // the message of a VOICE_ERROR when the server refused the join, or null.
  let joinConfirmed: ((refusal: string | null) => void) | null = null;
  // Resolves once the server confirms (or rejects) a pending
  // `setScreenShare(true)`'s VOICE_STATE selfStream=true. See
  // setScreenShare() for why capture must wait for this.
  let selfStreamConfirm: ((confirmed: boolean) => void) | null = null;
  let muted = false;
  let deafened = false;
  /** The flags that a moderator set on our own voice state. */
  let serverMuted = false;
  let serverDeafened = false;
  /**
   * True when the server can refuse an unmute: it forced the mute at join
   * (no SPEAK), or it refused an unmute. The track stays off until the
   * server accepts an unmute.
   */
  let speakDenied = false;
  /**
   * Goes up on each join, each leave and each input device change. A mic
   * request that finishes after a newer one of these started is stale:
   * its track is stopped, never used.
   */
  let micGeneration = 0;
  /** Goes up on each join and each teardown. A `join()` stops after an `await` when this value changed. */
  let callGeneration = 0;
  /** Goes up on each camera toggle and each teardown. A camera capture that finishes after a change is stopped. */
  let cameraGeneration = 0;
  /** Goes up on each screen share toggle and each teardown. See `cameraGeneration`. */
  let screenGeneration = 0;
  let inputDeviceId: string | undefined;
  /** The selected output device. Null is the default device. Undefined means that the user selected no device. */
  let outputDeviceId: string | null | undefined;
  let cameraStream: MediaStream | null = null;
  let screenStream: MediaStream | null = null;
  let cameraOn = false;
  let screenOn = false;

  function emitError(error: VoiceEngineErrorEvent): void {
    emitters.error.emit(error);
  }

  function emitLocalMedia(): void {
    emitters.localMedia.emit({ cameraOn, screenOn });
  }

  function snapshotPeers(): VoicePeerState[] {
    return [...peers.values()].map((runtime) => ({
      userId: runtime.key.userId,
      deviceId: runtime.key.deviceId,
      connectionState: runtime.connectionState,
      speaking: runtime.speakingState.speaking,
      cameraStream: runtime.remoteCameraStream,
      screenStream: runtime.remoteScreenStream,
    }));
  }

  /**
   * Tell one peer which of our streams are the camera and the screen
   * share. Each id is the stream id that this peer sees, which can be
   * different from the id of the local stream (see `cameraSentStreamId`).
   */
  function sendMediaSignal(runtime: PeerRuntime): void {
    const streams: { camera?: string; screen?: string } = {};
    if (cameraStream && runtime.cameraSentStreamId) {
      streams.camera = runtime.cameraSentStreamId;
    }
    if (screenStream && runtime.screenSentStreamId) {
      streams.screen = runtime.screenSentStreamId;
    }
    signalTransport?.send(runtime.key, { kind: "media", streams });
  }

  function broadcastMediaSignal(): void {
    for (const runtime of peers.values()) {
      sendMediaSignal(runtime);
    }
  }

  function emitPeers(): void {
    emitters.peers.emit(snapshotPeers());
  }

  // ---- TURN credentials -----------------------------------------------------

  async function getIceServers(): Promise<RTCIceServer[]> {
    const now = nowFn();
    if (turnCache && turnCache.expiresAt - TURN_REFRESH_SKEW_MS > now) {
      return turnCache.iceServers;
    }
    const result = await deps.getTurnCredentials();
    turnCache = { iceServers: result.iceServers, expiresAt: now + result.ttlSeconds * 1_000 };
    audioBitrateBps = result.audioBitrateBps ?? DEFAULT_AUDIO_BITRATE_BPS;
    return turnCache.iceServers;
  }

  // ---- local mute/deafen ------------------------------------------------------

  /** Mark the audio sender as high priority, once, right after it is created. Audio always wins uplink over video. */
  async function setAudioSenderPriority(sender: RTCRtpSender): Promise<void> {
    try {
      const parameters = sender.getParameters();
      if (!parameters.encodings || parameters.encodings.length === 0) {
        parameters.encodings = [{}];
      }
      (parameters as RTCRtpSendParameters & { priority?: RTCPriorityType }).priority = "high";
      (parameters.encodings[0] as RTCRtpEncodingParameters & { networkPriority?: RTCPriorityType }).networkPriority = "high";
      await sender.setParameters(parameters);
    } catch {
      // Not every fake/browser supports sender priority; best-effort.
    }
  }

  function stopTracks(stream: MediaStream): void {
    for (const track of stream.getTracks()) {
      track.stop();
    }
  }

  function applyMuteToLocalTrack(): void {
    if (!localStream) {
      return;
    }
    const enabled = !muted && !deafened && !serverMuted && !serverDeafened && !speakDenied;
    for (const track of localStream.getAudioTracks()) {
      track.enabled = enabled;
    }
  }

  function applyOutputGain(): void {
    if (masterGain) {
      masterGain.gain.value = deafened || serverDeafened ? 0 : 1;
    }
  }

  /** Send the remote audio to the selected output device. The audible path is the audio context. */
  function applyOutputDevice(): void {
    if (!audioContext || outputDeviceId === undefined) {
      return;
    }
    // The Audio Output Devices API adds `setSinkId` to `AudioContext`. It is not yet in TypeScript's DOM lib.
    const context = audioContext as AudioContext & { setSinkId?(deviceId: string): Promise<void> };
    if (!context.setSinkId) {
      emitError({
        kind: "output-device-unsupported",
        message: "The browser does not support output device selection.",
      });
      return;
    }
    // An empty string selects the default output device.
    context.setSinkId(outputDeviceId ?? "").catch(() => {
      emitError({
        kind: "output-device-unsupported",
        message: "The browser could not switch the output device.",
      });
    });
  }

  // ---- speaking detection (one shared timer for the whole call) ---------------

  function setupLocalSpeakingSource(): void {
    if (!audioContext || !localStream) {
      return;
    }
    const source = audioContext.createMediaStreamSource(localStream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    // Not connected onward: this branch exists only to read volume, never
    // to make the user hear themselves.
    source.connect(analyser);
    localSourceNode = source;
    localSpeakingState.analyser = analyser;
    localSpeakingState.buffer = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
    localSpeakingState.speaking = false;
    localSpeakingState.belowTicks = 0;
  }

  function speakingTick(): void {
    speakingTimer = null;

    const localChange = sampleSpeaking(localSpeakingState);
    if (localChange !== null) {
      emitters.localSpeaking.emit(localChange);
    }

    let peersChanged = false;
    for (const runtime of peers.values()) {
      const change = sampleSpeaking(runtime.speakingState);
      if (change !== null) {
        peersChanged = true;
      }
    }
    if (peersChanged) {
      emitPeers();
    }

    if (currentChannelId !== null) {
      speakingTimer = setTimeoutFn(speakingTick, SPEAKING_TICK_MS);
    }
  }

  function ensureSpeakingTimer(): void {
    if (speakingTimer || currentChannelId === null) {
      return;
    }
    speakingTimer = setTimeoutFn(speakingTick, SPEAKING_TICK_MS);
  }

  // ---- adaptive video quality ---------------------------------------------------

  /** One tick's read from a peer connection's `getStats()`: the uplink estimate and, per sender, whether it is limited. */
  interface AdaptiveStatsSnapshot {
    availableOutgoingBitrate?: number;
    /** `qualityLimitationReason` keyed by the outbound-rtp stat's `mid`, when the browser reports one. */
    reasonByMid: Map<string, string>;
    /** The lone video outbound-rtp stat's reason, when exactly one exists and its `mid` is unknown: the unambiguous fallback. */
    soleReason: string | null;
  }

  function readAdaptiveStats(report: RTCStatsReport): AdaptiveStatsSnapshot {
    const statsById = new Map<string, RTCStats>();
    report.forEach((stat) => {
      statsById.set(stat.id, stat);
    });

    let selectedPairId: string | null = null;
    for (const stat of statsById.values()) {
      const loose = stat as unknown as Record<string, unknown>;
      if (stat.type === "transport" && typeof loose.selectedCandidatePairId === "string") {
        selectedPairId = loose.selectedCandidatePairId;
      }
    }

    let availableOutgoingBitrate: number | undefined;
    const reasonByMid = new Map<string, string>();
    let videoOutboundCount = 0;
    let lastReason: string | null = null;

    for (const stat of statsById.values()) {
      const loose = stat as unknown as Record<string, unknown>;
      const isSelectedPair =
        stat.type === "candidate-pair" && (stat.id === selectedPairId || (selectedPairId === null && loose.nominated === true));
      if (isSelectedPair && typeof loose.availableOutgoingBitrate === "number") {
        availableOutgoingBitrate = loose.availableOutgoingBitrate;
      }
      if (stat.type === "outbound-rtp" && loose.kind === "video") {
        videoOutboundCount += 1;
        const reason = typeof loose.qualityLimitationReason === "string" ? loose.qualityLimitationReason : "none";
        lastReason = reason;
        if (typeof loose.mid === "string") {
          reasonByMid.set(loose.mid, reason);
        }
      }
    }

    return { availableOutgoingBitrate, reasonByMid, soleReason: videoOutboundCount === 1 ? lastReason : null };
  }

  /**
   * Whether one transceiver's sender is CPU- or bandwidth-limited this
   * tick. Matched by `mid` when the browser reports one on the
   * outbound-rtp stat; when a peer sends only one video track (the
   * common case: camera OR screen, not both, to most peers), the lone
   * video outbound-rtp stat is used instead, since there is nothing else
   * it could belong to.
   */
  function limitationReasonFor(stats: AdaptiveStatsSnapshot, transceiver: RTCRtpTransceiver | null): boolean {
    if (!transceiver) {
      return false;
    }
    const mid = transceiver.mid;
    const reason = (mid && stats.reasonByMid.get(mid)) ?? stats.soleReason ?? "none";
    return reason === "cpu" || reason === "bandwidth";
  }

  /** Apply the policy's result to one sender's parameters, only when it actually changed since the last tick. */
  async function applyEncodingToSender(transceiver: RTCRtpTransceiver, state: AdaptiveSenderState, limited: boolean, kind: VideoEncodingKind, remotePeerCount: number, activeVideoSenders: number, sourceHeight: number, availableOutgoingBitrate: number | undefined): Promise<void> {
    state.limitedSamples = limited ? state.limitedSamples + 1 : 0;

    const result = chooseVideoEncoding({
      kind,
      remotePeerCount,
      sourceHeight,
      availableOutgoingBitrate,
      activeVideoSenders,
      limitedSamples: state.limitedSamples,
      previousTier: state.tier ?? undefined,
      msSinceLastStepUp: state.lastStepUpAt === null ? undefined : nowFn() - state.lastStepUpAt,
    });

    if (state.tier !== null && result.tier < state.tier) {
      state.lastStepUpAt = nowFn();
    }
    state.tier = result.tier;

    const applied = {
      maxBitrate: result.maxBitrate,
      scaleResolutionDownBy: result.scaleResolutionDownBy,
      maxFramerate: result.maxFramerate,
    };
    const unchanged =
      state.lastApplied !== null &&
      state.lastApplied.maxBitrate === applied.maxBitrate &&
      state.lastApplied.scaleResolutionDownBy === applied.scaleResolutionDownBy &&
      state.lastApplied.maxFramerate === applied.maxFramerate;
    if (unchanged) {
      return;
    }
    state.lastApplied = applied;

    try {
      const parameters = transceiver.sender.getParameters();
      if (!parameters.encodings || parameters.encodings.length === 0) {
        parameters.encodings = [{}];
      }
      const encoding = parameters.encodings[0]!;
      encoding.maxBitrate = applied.maxBitrate;
      encoding.scaleResolutionDownBy = applied.scaleResolutionDownBy;
      encoding.maxFramerate = applied.maxFramerate;
      await transceiver.sender.setParameters(parameters);
    } catch {
      // Not every fake/browser accepts setParameters() for every state; best-effort.
    }
  }

  async function applyAdaptiveForPeer(runtime: PeerRuntime, remotePeerCount: number, activeVideoSenders: number): Promise<void> {
    if (!runtime.cameraTransceiver && !runtime.screenTransceiver) {
      return;
    }
    let report: RTCStatsReport;
    try {
      report = await runtime.pc.getStats();
    } catch {
      return;
    }
    const stats = readAdaptiveStats(report);

    if (runtime.cameraTransceiver && cameraOn) {
      const sourceHeight = cameraStream?.getVideoTracks()[0]?.getSettings().height ?? CAMERA_IDEAL_HEIGHT;
      await applyEncodingToSender(
        runtime.cameraTransceiver,
        runtime.cameraAdaptive,
        limitationReasonFor(stats, runtime.cameraTransceiver),
        "camera",
        remotePeerCount,
        activeVideoSenders,
        sourceHeight,
        stats.availableOutgoingBitrate,
      );
    }
    if (runtime.screenTransceiver && screenOn) {
      const sourceHeight = screenStream?.getVideoTracks()[0]?.getSettings().height ?? SCREEN_ASSUMED_HEIGHT;
      await applyEncodingToSender(
        runtime.screenTransceiver,
        runtime.screenAdaptive,
        limitationReasonFor(stats, runtime.screenTransceiver),
        "screen",
        remotePeerCount,
        activeVideoSenders,
        sourceHeight,
        stats.availableOutgoingBitrate,
      );
    }
  }

  async function adaptiveTick(): Promise<void> {
    adaptiveTimer = null;
    if (!cameraOn && !screenOn) {
      // The last video track stopped while this tick was already
      // scheduled: do nothing, and do not reschedule.
      return;
    }
    const remotePeerCount = peers.size;
    const activeVideoSenders = (cameraOn ? 1 : 0) + (screenOn ? 1 : 0);
    for (const runtime of peers.values()) {
      await applyAdaptiveForPeer(runtime, remotePeerCount, activeVideoSenders);
    }
    if (cameraOn || screenOn) {
      adaptiveTimer = setTimeoutFn(adaptiveTick, ADAPTIVE_TICK_MS);
    }
  }

  /** Start the adaptive-quality timer, only while a local camera or screen track is live. A no-op if it is already running. */
  function ensureAdaptiveTimer(): void {
    if (adaptiveTimer || (!cameraOn && !screenOn)) {
      return;
    }
    adaptiveTimer = setTimeoutFn(adaptiveTick, ADAPTIVE_TICK_MS);
  }

  /** Stop the adaptive-quality timer. Called once the last local video track goes off, and on leave. */
  function stopAdaptiveTimer(): void {
    if (adaptiveTimer) {
      clearTimeoutFn(adaptiveTimer);
      adaptiveTimer = null;
    }
  }

  // ---- remote audio graph ------------------------------------------------------

  function makeAudioElement(): AudioElementLike | null {
    if (deps.createAudioElement) {
      return deps.createAudioElement();
    }
    if (typeof document === "undefined") {
      return null;
    }
    return document.createElement("audio") as unknown as AudioElementLike;
  }

  /**
   * Play one remote audio stream. The first audio stream of a peer is the
   * microphone: the peer adds it before any screen share transceiver, and
   * a later microphone change uses `replaceTrack`. A later audio stream is
   * the screen share audio. It gets its own nodes, so that it does not
   * replace the microphone nodes, and only the microphone drives the
   * speaking ring.
   */
  function attachRemoteStream(runtime: PeerRuntime, stream: MediaStream): void {
    const isMic = runtime.micAudio === null;
    const audio: RemoteAudio = { source: null, gain: null, element: null };
    if (audioContext && masterGain) {
      const source = audioContext.createMediaStreamSource(stream);
      const gain = audioContext.createGain();
      gain.gain.value = userVolumes.get(runtime.key.userId) ?? 1;
      source.connect(gain);
      gain.connect(masterGain);
      audio.source = source;
      audio.gain = gain;

      if (isMic) {
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        runtime.speakingState.analyser = analyser;
        runtime.speakingState.buffer = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
      }
    }

    // Chromium is known to output silence from Web Audio for a
    // MediaStream that is never attached to a media element, even when
    // the audio graph above is wired correctly. A muted <audio> element
    // works around this; the audible path is the Web Audio graph, not
    // this element.
    const element = makeAudioElement();
    if (element) {
      element.srcObject = stream;
      element.muted = true;
      audio.element = element;
    }

    if (isMic) {
      runtime.micAudio = audio;
    } else {
      if (runtime.screenAudio) {
        releaseRemoteAudio(runtime.screenAudio);
      }
      runtime.screenAudio = audio;
    }
  }

  function releaseRemoteAudio(audio: RemoteAudio): void {
    audio.source?.disconnect();
    audio.gain?.disconnect();
    if (audio.element) {
      audio.element.srcObject = null;
    }
  }

  // ---- perfect negotiation ------------------------------------------------------

  /**
   * Run one signaling step (an outgoing negotiate or an incoming
   * description) after every step already queued for this peer has
   * finished. See the `signalingQueue` field for why this matters: it is
   * what keeps an outgoing offer and an incoming offer from touching the
   * same RTCPeerConnection at once.
   */
  function enqueueSignaling(runtime: PeerRuntime, step: () => Promise<void>): Promise<void> {
    const run = runtime.signalingQueue.then(step, step);
    // Keep the chain alive even after a step throws, so the NEXT queued
    // step still runs; each step already handles its own errors, this
    // just stops one failure from wedging every later signal for good.
    runtime.signalingQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function negotiate(runtime: PeerRuntime): Promise<void> {
    return enqueueSignaling(runtime, () => negotiateNow(runtime));
  }

  async function negotiateNow(runtime: PeerRuntime): Promise<void> {
    if (runtime.makingOffer || runtime.pc.signalingState !== "stable") {
      // Either we are already sending an offer, or an incoming
      // description moved us out of "stable" while this step waited its
      // turn in the queue: an offer would be rejected in either case.
      return;
    }
    try {
      runtime.makingOffer = true;
      const offer = await runtime.pc.createOffer();
      const patched = applyOpusFec(offer, audioBitrateBps);
      await runtime.pc.setLocalDescription(patched);
      signalTransport?.send(runtime.key, { kind: "description", description: patched });
      startOfferTimer(runtime);
    } catch {
      // A dropped offer is not fatal: `onnegotiationneeded` or the next
      // membership change tries again.
    } finally {
      runtime.makingOffer = false;
    }
  }

  function clearOfferTimer(runtime: PeerRuntime): void {
    if (runtime.offerTimer) {
      clearTimeoutFn(runtime.offerTimer);
      runtime.offerTimer = null;
    }
  }

  /**
   * The gateway drops a signal while the socket is down. Without an
   * answer, the connection stays in "have-local-offer", and each later
   * offer to this peer stops. Thus roll back an offer that got no answer
   * in time, and offer again.
   */
  function startOfferTimer(runtime: PeerRuntime): void {
    clearOfferTimer(runtime);
    runtime.offerTimer = setTimeoutFn(() => {
      runtime.offerTimer = null;
      void enqueueSignaling(runtime, async () => {
        if (runtime.pc.signalingState !== "have-local-offer") {
          return;
        }
        try {
          await runtime.pc.setLocalDescription({ type: "rollback" });
        } catch {
          return;
        }
        await negotiateNow(runtime);
      });
    }, OFFER_ANSWER_TIMEOUT_MS);
  }

  async function flushCandidateQueue(runtime: PeerRuntime): Promise<void> {
    const queued = runtime.candidateQueue;
    runtime.candidateQueue = [];
    for (const candidate of queued) {
      try {
        await runtime.pc.addIceCandidate(candidate);
      } catch {
        // A stale queued candidate is not fatal: ICE keeps trying with
        // whatever candidates did apply.
      }
    }
  }

  async function handleDescription(runtime: PeerRuntime, description: RTCSessionDescriptionInit): Promise<void> {
    return enqueueSignaling(runtime, () => handleDescriptionNow(runtime, description));
  }

  async function handleDescriptionNow(runtime: PeerRuntime, description: RTCSessionDescriptionInit): Promise<void> {
    if (description.type === "offer") {
      const offerCollision = runtime.makingOffer || runtime.pc.signalingState !== "stable";
      const shouldIgnore = !runtime.polite && offerCollision;
      if (shouldIgnore) {
        return;
      }
      if (offerCollision) {
        // The polite side yields: roll back its own in-flight offer
        // before accepting the peer's, per the perfect-negotiation
        // pattern (see engine.ts negotiate()/handleDescription()).
        clearOfferTimer(runtime);
        await runtime.pc.setLocalDescription({ type: "rollback" });
      }
      await runtime.pc.setRemoteDescription(description);
      await flushCandidateQueue(runtime);
      const answer = await runtime.pc.createAnswer();
      const patched = applyOpusFec(answer, audioBitrateBps);
      await runtime.pc.setLocalDescription(patched);
      signalTransport?.send(runtime.key, { kind: "description", description: patched });
      // A transceiver that we added before the offer arrived (a camera or
      // a screen share that is already on for a later peer) does not match
      // a line of that offer, and an answer cannot add a line. It has no
      // mid until we send an offer of our own.
      if (runtime.pc.getTransceivers().some((transceiver) => transceiver.mid === null)) {
        void negotiate(runtime);
      }
    } else {
      if (runtime.pc.signalingState !== "have-local-offer") {
        // A late answer to an offer that we rolled back. The new offer gets its own answer.
        return;
      }
      clearOfferTimer(runtime);
      await runtime.pc.setRemoteDescription(description);
      await flushCandidateQueue(runtime);
    }
  }

  async function handleSignal(from: PeerKey, payload: SignalPayload): Promise<void> {
    if (currentChannelId === null) {
      return;
    }
    const id = keyOf(from);
    if (payload.kind === "rebuild") {
      // The peer closed its connection to us and makes a new one. Close
      // ours too, so that its next offer goes to a new connection.
      const old = peers.get(id);
      if (old) {
        closePeer(old);
        peers.delete(id);
        emitPeers();
      }
      return;
    }
    // A later peer's offer (or an early candidate) can arrive before we
    // learned about them from VOICE_STATE_UPDATE: create the connection
    // now, lazily, rather than wait.
    const runtime = peers.get(id) ?? (await ensurePeer(from));
    if (!runtime) {
      return;
    }

    if (payload.kind === "description") {
      await handleDescription(runtime, payload.description);
    } else if (payload.kind === "candidate") {
      if (runtime.pc.remoteDescription) {
        try {
          await runtime.pc.addIceCandidate(payload.candidate);
        } catch {
          // A candidate WebRTC rejects outright is not fatal.
        }
      } else {
        runtime.candidateQueue.push(payload.candidate);
      }
    } else if (payload.kind === "media") {
      applyMediaSignal(runtime, payload.streams);
    }
  }

  /**
   * Apply a peer's "media" signal: which of their current tracks (if any)
   * are the camera and the screen share, identified by stream id. Handles
   * both orders against `ontrack`: the signal can arrive before or after
   * the matching track, since they travel over different channels (the
   * gateway and the peer connection).
   */
  function applyMediaSignal(runtime: PeerRuntime, streams: { camera?: string; screen?: string }): void {
    runtime.remoteCameraStreamId = streams.camera ?? null;
    runtime.remoteScreenStreamId = streams.screen ?? null;
    resolveRemoteVideo(runtime);
  }

  /** Match the live remote video streams of a peer to the stream ids of its last media signal. */
  function resolveRemoteVideo(runtime: PeerRuntime): void {
    const cameraId = runtime.remoteCameraStreamId;
    const screenId = runtime.remoteScreenStreamId;
    const camera = cameraId ? (runtime.remoteVideoStreams.get(cameraId) ?? null) : null;
    const screen = screenId ? (runtime.remoteVideoStreams.get(screenId) ?? null) : null;
    if (camera === runtime.remoteCameraStream && screen === runtime.remoteScreenStream) {
      return;
    }
    runtime.remoteCameraStream = camera;
    runtime.remoteScreenStream = screen;
    emitPeers();
  }

  /**
   * Keep one incoming remote video track. The media signal tells if its
   * stream is the camera or the screen share. The signal can arrive
   * before or after the track. A muted track hides its stream. The stream
   * shows again when the track unmutes, for example after the peer turns
   * the camera off and on again.
   */
  function handleRemoteVideoTrack(runtime: PeerRuntime, stream: MediaStream, track: MediaStreamTrack): void {
    const hide = (): void => {
      runtime.remoteVideoStreams.delete(stream.id);
      resolveRemoteVideo(runtime);
    };
    const show = (): void => {
      runtime.remoteVideoStreams.set(stream.id, stream);
      resolveRemoteVideo(runtime);
    };
    track.onended = hide;
    track.onmute = hide;
    track.onunmute = show;
    show();
  }

  // ---- ICE recovery ------------------------------------------------------------

  function closePeer(runtime: PeerRuntime): void {
    if (runtime.restartTimer) {
      clearTimeoutFn(runtime.restartTimer);
      runtime.restartTimer = null;
    }
    clearOfferTimer(runtime);
    runtime.pc.onicecandidate = null;
    runtime.pc.ontrack = null;
    runtime.pc.onconnectionstatechange = null;
    runtime.pc.onnegotiationneeded = null;
    runtime.pc.close();
    if (runtime.micAudio) {
      releaseRemoteAudio(runtime.micAudio);
    }
    if (runtime.screenAudio) {
      releaseRemoteAudio(runtime.screenAudio);
    }
  }

  /**
   * Close the connection to a peer and make a new one. Only the impolite
   * side does this, the same rule that decides who restarts ICE below. It
   * first sends a "rebuild" signal, so that the polite side also closes
   * its old connection and accepts the offer of the new one.
   */
  async function rebuildPeer(runtime: PeerRuntime): Promise<void> {
    const key = runtime.key;
    closePeer(runtime);
    peers.delete(keyOf(key));
    signalTransport?.send(key, { kind: "rebuild" });
    const fresh = await ensurePeer(key);
    if (fresh) {
      await negotiate(fresh);
    }
    emitPeers();
  }

  function attemptIceRestart(runtime: PeerRuntime): void {
    if (runtime.restartsAttempted >= MAX_ICE_RESTARTS) {
      emitError({ kind: "ice-failed", message: "The connection to a voice peer failed. The app makes a new connection." });
      void rebuildPeer(runtime);
      return;
    }
    const delay = ICE_RESTART_BACKOFFS_MS[runtime.restartsAttempted]!;
    runtime.restartsAttempted += 1;
    runtime.restartTimer = setTimeoutFn(() => {
      runtime.restartTimer = null;
      if (runtime.pc.connectionState !== "failed") {
        return; // Recovered on its own; nothing more to do.
      }
      try {
        // restartIce() fires a real, legitimate onnegotiationneeded to
        // ask for a fresh offer with new ICE credentials: arm the
        // guard (see `negotiationArmed`'s comment) so
        // `onnegotiationneeded` acts on that one firing instead of
        // ignoring it like every other one.
        runtime.negotiationArmed = true;
        runtime.pc.restartIce();
      } catch {
        // The next connectionstatechange (still "failed") drives the next attempt.
      }
    }, delay);
  }

  function handlePeerFailed(runtime: PeerRuntime): void {
    // Only the impolite side drives recovery, so the two sides never
    // restart ICE against each other at the same time.
    if (runtime.polite) {
      return;
    }
    attemptIceRestart(runtime);
  }

  // ---- peer connection lifecycle ------------------------------------------------

  /** Get or make the connection to a peer. Returns null when the call ended while the connection was made. */
  async function ensurePeer(key: PeerKey): Promise<PeerRuntime | null> {
    const id = keyOf(key);
    const existing = peers.get(id);
    if (existing) {
      return existing;
    }

    // Two callers can race to create the same peer: the eager "later
    // peer" path from onPeerVoiceState, and handleSignal reacting to
    // their offer or an early candidate. Both call ensurePeer before the
    // first one has finished (getIceServers() below is async), so the
    // check above alone is not enough. Share one in-flight creation per
    // peer id, so a racing caller gets the SAME runtime instead of a
    // second, orphaned RTCPeerConnection that never sees the signal
    // traffic meant for the first one.
    const pending = pendingEnsurePeer.get(id);
    if (pending) {
      return pending;
    }

    const call = callGeneration;
    const creating = (async (): Promise<PeerRuntime | null> => {
      const iceServers = await getIceServers();
      // A leave (or a new join) started during the wait. Do not make a connection that nothing closes.
      if (call !== callGeneration || currentChannelId === null) {
        return null;
      }
      const pc = deps.createPeerConnection({ iceServers });
      const runtime: PeerRuntime = {
        key,
        pc,
        polite: isPolite(selfKey, key),
        makingOffer: false,
        negotiationArmed: false,
        candidateQueue: [],
        restartsAttempted: 0,
        restartTimer: null,
        offerTimer: null,
        micAudio: null,
        screenAudio: null,
        connectionState: pc.connectionState,
        speakingState: createSpeakingState(),
        cameraTransceiver: null,
        screenTransceiver: null,
        screenAudioTransceiver: null,
        cameraSentStreamId: null,
        screenSentStreamId: null,
        remoteCameraStreamId: null,
        remoteScreenStreamId: null,
        remoteCameraStream: null,
        remoteScreenStream: null,
        cameraAdaptive: createAdaptiveSenderState(),
        screenAdaptive: createAdaptiveSenderState(),
        remoteVideoStreams: new Map(),
        signalingQueue: Promise.resolve(),
      };
      peers.set(id, runtime);

      if (localStream) {
        for (const track of localStream.getTracks()) {
          const sender = pc.addTrack(track, localStream);
          if (track.kind === "audio") {
            void capOpusBitrate(sender, audioBitrateBps).catch(() => {
              // Not every fake/browser supports setParameters(); the bitrate cap is best-effort.
            });
            void setAudioSenderPriority(sender);
          }
        }
      }
      // A late joiner: this peer connection starts with whatever camera
      // and screen share are already live, on their own dedicated
      // transceivers, the same as a mid-call toggle would set up. When the
      // peer offers first, these transceivers get a mid only from a later
      // offer of ours (see `handleDescriptionNow`).
      if (cameraOn && cameraStream) {
        const track = cameraStream.getVideoTracks()[0];
        if (track) {
          runtime.cameraTransceiver = pc.addTransceiver(track, { direction: "sendonly", streams: [cameraStream] });
          runtime.cameraSentStreamId = cameraStream.id;
        }
      }
      if (screenOn && screenStream) {
        const videoTrack = screenStream.getVideoTracks()[0];
        if (videoTrack) {
          runtime.screenTransceiver = pc.addTransceiver(videoTrack, { direction: "sendonly", streams: [screenStream] });
          runtime.screenSentStreamId = screenStream.id;
        }
        const audioTrack = screenStream.getAudioTracks()[0];
        if (audioTrack) {
          runtime.screenAudioTransceiver = pc.addTransceiver(audioTrack, { direction: "sendonly", streams: [screenStream] });
        }
      }
      if (cameraOn || screenOn) {
        sendMediaSignal(runtime);
      }

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          signalTransport?.send(key, { kind: "candidate", candidate: event.candidate.toJSON() });
        }
      };
      pc.ontrack = (event) => {
        const stream = event.streams[0] ?? new MediaStream(event.track ? [event.track] : []);
        if (event.track && event.track.kind === "video") {
          handleRemoteVideoTrack(runtime, stream, event.track);
        } else {
          attachRemoteStream(runtime, stream);
        }
      };
      pc.onconnectionstatechange = () => {
        runtime.connectionState = pc.connectionState;
        emitPeers();
        if (pc.connectionState === "connected") {
          // The connection recovered. A later failure gets all its ICE restarts again.
          runtime.restartsAttempted = 0;
        } else if (pc.connectionState === "failed") {
          handlePeerFailed(runtime);
        }
      };
      pc.onnegotiationneeded = () => {
        if (!runtime.negotiationArmed) {
          // See `negotiationArmed`'s own comment: every negotiation
          // this engine needs is already started directly by its own
          // call site, so an unarmed firing of this event is never a
          // real, missed need — acting on it anyway is what used to
          // send an unwanted offer to a newcomer we should be waiting
          // on instead.
          return;
        }
        runtime.negotiationArmed = false;
        void negotiate(runtime);
      };

      emitPeers();
      return runtime;
    })();

    pendingEnsurePeer.set(id, creating);
    try {
      return await creating;
    } finally {
      pendingEnsurePeer.delete(id);
    }
  }

  // ---- public: membership from VOICE_STATE_UPDATE ------------------------------

  function onPeerVoiceState(update: VoiceStateJson): void {
    if (update.userId === selfKey.userId && update.deviceId === selfKey.deviceId) {
      if (update.channelId === null) {
        // A rejoin from this device makes the server remove the old voice
        // state of this device. That leave has the call id of the old join.
        // It is not for the current call, so ignore it.
        if (update.callId !== undefined && update.callId !== signalTransport?.callId) {
          return;
        }
        // The server removed our own voice state (a VOICE_LEAVE echo, a
        // move to another device, or a kick): clean up the same way
        // `leave()` does, and let the caller's UI react.
        void teardown(false);
      } else if (update.channelId === currentChannelId) {
        if (joinConfirmed) {
          // The server forces the mute at join when we cannot speak in this channel.
          if (update.selfMute && !muted) {
            speakDenied = true;
            forceMute();
          }
          joinConfirmed(null);
          joinConfirmed = null;
        } else if (!update.selfMute) {
          // The server accepted an unmute, so we can speak.
          speakDenied = false;
        }
        serverMuted = update.serverMute;
        serverDeafened = update.serverDeaf;
        applyMuteToLocalTrack();
        applyOutputGain();
        if (selfStreamConfirm && update.selfStream) {
          selfStreamConfirm(true);
          selfStreamConfirm = null;
        }
      }
      return;
    }

    const key: PeerKey = { userId: update.userId, deviceId: update.deviceId };
    const id = keyOf(key);

    if (update.channelId === null || update.channelId !== currentChannelId) {
      const runtime = peers.get(id);
      if (runtime) {
        closePeer(runtime);
        peers.delete(id);
        emitPeers();
      }
      return;
    }

    if (currentChannelId !== null && !peers.has(id)) {
      // A peer we did not know about is in our channel. We are not the
      // newcomer here, so we only prepare the connection and wait for
      // their offer, rather than call createOffer ourselves.
      void ensurePeer(key);
    }
  }

  /** Mute the microphone without a VOICE_STATE, because the server already has the mute. */
  function forceMute(): void {
    muted = true;
    applyMuteToLocalTrack();
    emitters.forcedMute.emit(true);
  }

  function handleVoiceError(payload: { code: VoiceErrorCode; message: string }): void {
    const refusesJoin =
      payload.code === "CHANNEL_FULL" || payload.code === "NO_PERMISSION" || payload.code === "NOT_A_VOICE_CHANNEL";
    if (joinConfirmed && refusesJoin) {
      // The server refused the join that waits for its echo.
      joinConfirmed(payload.message);
      joinConfirmed = null;
    } else if (payload.code === "NO_PERMISSION" && currentChannelId !== null) {
      // The server refused an unmute. Undo the local unmute.
      speakDenied = true;
      forceMute();
    }
    if (payload.code === "STREAM_IN_USE" && selfStreamConfirm) {
      selfStreamConfirm(false);
      selfStreamConfirm = null;
    }
    emitError({ kind: "voice-error", message: payload.message, code: payload.code });
  }

  // ---- public: join/leave ------------------------------------------------------

  async function teardown(shouldSendLeave: boolean): Promise<void> {
    micGeneration += 1;
    callGeneration += 1;
    cameraGeneration += 1;
    screenGeneration += 1;
    // Let a join that waits for its echo continue now. It sees the new generation and stops.
    if (joinConfirmed) {
      joinConfirmed(null);
      joinConfirmed = null;
    }
    serverMuted = false;
    serverDeafened = false;
    speakDenied = false;
    const wasActive = currentChannelId !== null || peers.size > 0 || localStream !== null;
    if (!wasActive) {
      return;
    }

    if (speakingTimer) {
      clearTimeoutFn(speakingTimer);
      speakingTimer = null;
    }
    stopAdaptiveTimer();

    if (selfStreamConfirm) {
      selfStreamConfirm(false);
      selfStreamConfirm = null;
    }

    if (cameraStream) {
      for (const track of cameraStream.getTracks()) {
        track.stop();
      }
      cameraStream = null;
    }
    if (screenStream) {
      for (const track of screenStream.getTracks()) {
        track.stop();
      }
      screenStream = null;
    }
    const mediaWasOn = cameraOn || screenOn;
    cameraOn = false;
    screenOn = false;
    if (mediaWasOn) {
      emitLocalMedia();
    }

    for (const runtime of peers.values()) {
      closePeer(runtime);
    }
    peers.clear();

    if (localSourceNode) {
      localSourceNode.disconnect();
      localSourceNode = null;
    }
    localSpeakingState.analyser = null;
    localSpeakingState.buffer = null;
    localSpeakingState.speaking = false;
    localSpeakingState.belowTicks = 0;

    if (localStream) {
      for (const track of localStream.getTracks()) {
        track.stop();
      }
      localStream = null;
    }

    if (masterGain) {
      masterGain.disconnect();
      masterGain = null;
    }
    if (audioContext) {
      await audioContext.close();
      audioContext = null;
    }

    if (signalTransport) {
      signalTransport.close?.();
      signalTransport = null;
    }

    currentChannelId = null;
    currentGuildId = null;

    if (shouldSendLeave) {
      deps.sendVoiceLeave();
    }
    emitPeers();
  }

  async function join(guildId: string | null, channelId: string): Promise<void> {
    if (currentChannelId !== null) {
      // Switching channels: clean up the old call locally. The server
      // replaces our voice state on the next VOICE_JOIN by itself (see
      // docs/concepts/voice.md), so this does not send VOICE_LEAVE.
      await teardown(false);
    }

    currentGuildId = guildId;
    currentChannelId = channelId;
    const generation = ++micGeneration;
    const call = ++callGeneration;
    const requestedDeviceId = inputDeviceId;

    let stream: MediaStream;
    try {
      stream = await deps.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          ...(requestedDeviceId ? { deviceId: requestedDeviceId } : {}),
        },
      });
    } catch {
      if (generation !== micGeneration) {
        return;
      }
      currentChannelId = null;
      currentGuildId = null;
      emitError({
        kind: "mic-permission-denied",
        message: "The browser did not allow use of the microphone.",
      });
      // `join()` resolves rather than rejects even on mic denial: the
      // caller learns about the failure from the "error" event and finds
      // the engine already back in a clean, not-in-call state.
      return;
    }
    if (generation !== micGeneration) {
      // A leave (or a newer join) started while the browser opened the
      // mic. This join is void: stop its track and send nothing.
      stopTracks(stream);
      return;
    }

    useLocalStream(stream);
    if (inputDeviceId !== requestedDeviceId) {
      // The user chose another mic while the browser opened this one.
      reopenMic();
    }
    audioContext = deps.createAudioContext();
    masterGain = audioContext.createGain();
    applyOutputGain();
    masterGain.connect(audioContext.destination);
    applyOutputDevice();
    setupLocalSpeakingSource();

    signalTransport = deps.createSignalTransport(channelId);
    signalTransport.onSignal((from, payload) => {
      void handleSignal(from, payload);
    });

    deps.sendVoiceJoin(channelId, muted, deafened);

    // Wait for the server's own echo of our join (its VOICE_STATE_UPDATE
    // for our own peer) before sending any signal. Sending an offer
    // before the server has processed VOICE_JOIN can arrive first and
    // come back NOT_IN_VOICE (see onPeerVoiceState above). A short
    // timeout keeps this from hanging forever if that echo is ever lost.
    const refusal = await new Promise<string | null>((resolve) => {
      const timer = setTimeoutFn(() => {
        if (joinConfirmed === settle) {
          joinConfirmed = null;
        }
        resolve(null);
      }, JOIN_CONFIRM_TIMEOUT_MS);
      const settle = (value: string | null): void => {
        clearTimeoutFn(timer);
        resolve(value);
      };
      joinConfirmed = settle;
    });
    // A leave (or a newer join) started during the wait. This join must not make peer connections.
    if (call !== callGeneration) {
      return;
    }
    if (refusal !== null) {
      // During a channel change, the server keeps the old voice state when
      // it refuses the join. The leave removes it.
      await teardown(true);
      throw new Error(refusal);
    }

    const initialPeers = deps.getInitialPeers(channelId);
    for (const peerKey of initialPeers) {
      const runtime = await ensurePeer(peerKey);
      if (call !== callGeneration || !runtime) {
        return;
      }
      // We are the newcomer: we offer to every peer already here.
      await negotiate(runtime);
      // Observed on Chromium: adding the same local track as a sender to
      // a second RTCPeerConnection right after the first one can leave
      // that second sender producing no encoded audio at all, even
      // though the connection itself reaches "connected" normally. A
      // short pause between peers avoids it. This only affects the
      // newcomer's own catch-up loop (one peer at a time, already), not
      // ordinary calls with two people, so the added join time is small.
      await new Promise<void>((resolve) => setTimeoutFn(resolve, NEWCOMER_TRACK_SHARE_DELAY_MS));
      if (call !== callGeneration) {
        return;
      }
    }

    ensureSpeakingTimer();
  }

  async function leave(): Promise<void> {
    await teardown(true);
  }

  // ---- public: camera and screen share ------------------------------------------

  /** Wait for the server's VOICE_STATE_UPDATE echo of a pending selfStream=true, or a STREAM_IN_USE rejection. */
  function waitSelfStreamConfirm(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      selfStreamConfirm = resolve;
      setTimeoutFn(() => {
        if (selfStreamConfirm) {
          selfStreamConfirm = null;
          // No echo and no rejection within the timeout: proceed rather
          // than hang forever, the same choice join() makes for its own
          // confirm wait.
          resolve(true);
        }
      }, STREAM_CONFIRM_TIMEOUT_MS);
    });
  }

  async function setCamera(on: boolean, deviceId?: string): Promise<void> {
    if (currentChannelId === null) {
      return;
    }
    // A capture that is still open from an earlier toggle is now stale.
    const generation = ++cameraGeneration;

    if (!on) {
      if (!cameraOn) {
        return;
      }
      cameraOn = false;
      for (const runtime of peers.values()) {
        if (runtime.cameraTransceiver) {
          try {
            await runtime.cameraTransceiver.sender.replaceTrack(null);
          } catch {
            // Best-effort: the transceiver is torn down anyway if the peer connection is closed.
          }
        }
      }
      if (cameraStream) {
        for (const track of cameraStream.getTracks()) {
          track.stop();
        }
        cameraStream = null;
      }
      for (const runtime of peers.values()) {
        runtime.cameraAdaptive = createAdaptiveSenderState();
      }
      if (!screenOn) {
        stopAdaptiveTimer();
      }
      deps.sendVoiceState({ selfVideo: false });
      broadcastMediaSignal();
      emitLocalMedia();
      return;
    }

    let stream: MediaStream;
    try {
      stream = await deps.getUserMedia({
        video: {
          width: { ideal: CAMERA_IDEAL_WIDTH },
          height: { ideal: CAMERA_IDEAL_HEIGHT },
          frameRate: { ideal: CAMERA_IDEAL_FRAME_RATE },
          ...(deviceId ? { deviceId } : {}),
        },
      });
    } catch {
      if (generation === cameraGeneration) {
        emitError({ kind: "camera-permission-denied", message: "The browser did not allow use of the camera." });
      }
      return;
    }
    const track = stream.getVideoTracks()[0];
    if (!track || generation !== cameraGeneration) {
      // A leave, a camera "off" or a newer camera toggle started while the browser opened the camera.
      stopTracks(stream);
      return;
    }

    const oldStream = cameraStream;
    cameraStream = stream;
    cameraOn = true;

    for (const runtime of peers.values()) {
      if (runtime.cameraTransceiver) {
        await runtime.cameraTransceiver.sender.replaceTrack(track);
      } else {
        runtime.cameraTransceiver = runtime.pc.addTransceiver(track, { direction: "sendonly", streams: [stream] });
        runtime.cameraSentStreamId = stream.id;
        await negotiate(runtime);
      }
    }

    if (oldStream) {
      for (const t of oldStream.getTracks()) {
        t.stop();
      }
    }

    deps.sendVoiceState({ selfVideo: true });
    broadcastMediaSignal();
    emitLocalMedia();
    ensureAdaptiveTimer();
  }

  async function setScreenShare(on: boolean): Promise<void> {
    if (currentChannelId === null) {
      return;
    }

    if (!on) {
      // A screen share that still waits for the picker or the server is now stale.
      screenGeneration += 1;
      if (!screenOn) {
        return;
      }
      screenOn = false;
      for (const runtime of peers.values()) {
        if (runtime.screenTransceiver) {
          try {
            await runtime.screenTransceiver.sender.replaceTrack(null);
          } catch {
            // Best-effort.
          }
        }
        if (runtime.screenAudioTransceiver) {
          try {
            await runtime.screenAudioTransceiver.sender.replaceTrack(null);
          } catch {
            // Best-effort.
          }
        }
      }
      if (screenStream) {
        for (const track of screenStream.getTracks()) {
          track.stop();
        }
        screenStream = null;
      }
      for (const runtime of peers.values()) {
        runtime.screenAdaptive = createAdaptiveSenderState();
      }
      if (!cameraOn) {
        stopAdaptiveTimer();
      }
      deps.sendVoiceState({ selfStream: false });
      broadcastMediaSignal();
      emitLocalMedia();
      return;
    }

    if (screenOn) {
      return;
    }
    const generation = ++screenGeneration;
    const call = callGeneration;

    // Show the picker first. Firefox and Safari allow it only soon after a
    // user action, so it cannot wait for the server.
    let stream: MediaStream;
    try {
      stream = await deps.getDisplayMedia({ video: true, audio: true });
    } catch {
      // Permission denied, or the picker was cancelled.
      if (generation === screenGeneration) {
        emitError({ kind: "screen-permission-denied", message: "The browser did not allow screen capture." });
      }
      return;
    }
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack || generation !== screenGeneration) {
      stopTracks(stream);
      return;
    }

    // Then ask the server for the one screen share slot of the channel.
    deps.sendVoiceState({ selfStream: true });
    const confirmed = await waitSelfStreamConfirm();
    if (!confirmed || generation !== screenGeneration) {
      // On STREAM_IN_USE, handleVoiceError already sent an "error" event.
      stopTracks(stream);
      if (confirmed && call === callGeneration) {
        // The user stopped the share while the server confirmed it. Give the slot back.
        deps.sendVoiceState({ selfStream: false });
      }
      return;
    }

    // Tell the encoder this is detailed screen content, not a camera:
    // it favours sharpness over frame rate, which matches what people
    // expect when they read a shared screen.
    (videoTrack as MediaStreamTrack & { contentHint?: string }).contentHint = "detail";
    videoTrack.onended = () => {
      void setScreenShare(false);
    };

    screenStream = stream;
    screenOn = true;
    const audioTrack = stream.getAudioTracks()[0] ?? null;

    for (const runtime of peers.values()) {
      let needsNegotiate = false;
      if (runtime.screenTransceiver) {
        await runtime.screenTransceiver.sender.replaceTrack(videoTrack);
      } else {
        runtime.screenTransceiver = runtime.pc.addTransceiver(videoTrack, { direction: "sendonly", streams: [stream] });
        runtime.screenSentStreamId = stream.id;
        needsNegotiate = true;
      }
      if (audioTrack) {
        if (runtime.screenAudioTransceiver) {
          await runtime.screenAudioTransceiver.sender.replaceTrack(audioTrack);
        } else {
          runtime.screenAudioTransceiver = runtime.pc.addTransceiver(audioTrack, { direction: "sendonly", streams: [stream] });
          needsNegotiate = true;
        }
      }
      if (needsNegotiate) {
        await negotiate(runtime);
      }
    }

    broadcastMediaSignal();
    emitLocalMedia();
    ensureAdaptiveTimer();
  }

  // ---- public: mute/deafen/devices/volume ---------------------------------------

  function setMute(nextMuted: boolean): void {
    muted = nextMuted;
    applyMuteToLocalTrack();
    // Before a join, keep the value only: `join()` applies it to the new
    // track at once and sends it with VOICE_JOIN.
    if (currentChannelId !== null) {
      deps.sendVoiceState({ selfMute: muted });
    }
  }

  function setDeafen(nextDeafened: boolean): void {
    deafened = nextDeafened;
    applyOutputGain();
    // Un-deafening restores whatever `setMute` last set; it does not force an unmute.
    applyMuteToLocalTrack();
    if (currentChannelId !== null) {
      deps.sendVoiceState({ selfDeaf: deafened });
    }
  }

  /**
   * Make `stream` the local microphone stream. When its track ends (for
   * example, the user disconnects the headset), open the microphone again.
   * A track that we stop ourselves does not send "ended".
   */
  function useLocalStream(stream: MediaStream): void {
    localStream = stream;
    // Apply the current gate (mute, deafen, push to talk) before any peer can send the track.
    applyMuteToLocalTrack();
    const track = stream.getAudioTracks()[0];
    if (!track) {
      return;
    }
    track.onended = () => {
      if (localStream !== stream) {
        return;
      }
      emitError({
        kind: "mic-disconnected",
        message: "The microphone stopped. The app opens the microphone again.",
      });
      reopenMic();
    };
  }

  function setInputDevice(deviceId: string | null): void {
    const next = deviceId ?? undefined;
    if (next === inputDeviceId) {
      return;
    }
    inputDeviceId = next;
    reopenMic();
  }

  /** Open the selected microphone (or the default one) and put its track on each peer connection. */
  function reopenMic(): void {
    // Before a join, or while `join()` still opens the mic, do nothing: `join()` reads `inputDeviceId`.
    if (currentChannelId === null || localStream === null) {
      return;
    }
    const generation = ++micGeneration;
    const deviceId = inputDeviceId;
    void (async () => {
      let newStream: MediaStream;
      try {
        newStream = await deps.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            ...(deviceId ? { deviceId } : {}),
          },
        });
      } catch {
        if (generation !== micGeneration) {
          return;
        }
        emitError({
          kind: "mic-permission-denied",
          message: "The browser did not allow use of the microphone.",
        });
        return;
      }
      const newTrack = newStream.getAudioTracks()[0];
      if (!newTrack || generation !== micGeneration) {
        // A newer device change, a leave or a new join made this track stale.
        stopTracks(newStream);
        return;
      }
      const oldStream = localStream;
      useLocalStream(newStream);
      for (const runtime of peers.values()) {
        // The first audio sender is the microphone. The screen share audio sender comes later.
        const sender = runtime.pc.getSenders().find((s) => s.track?.kind === "audio");
        if (sender) {
          await sender.replaceTrack(newTrack);
        }
      }
      if (audioContext) {
        if (localSourceNode) {
          localSourceNode.disconnect();
        }
        setupLocalSpeakingSource();
      }
      if (oldStream) {
        stopTracks(oldStream);
      }
    })();
  }

  async function setOutputDevice(deviceId: string | null): Promise<void> {
    outputDeviceId = deviceId;
    applyOutputDevice();
  }

  function setUserVolume(userId: string, volume: number): void {
    const clamped = Math.min(2, Math.max(0, volume));
    userVolumes.set(userId, clamped);
    for (const runtime of peers.values()) {
      if (runtime.key.userId !== userId) {
        continue;
      }
      for (const audio of [runtime.micAudio, runtime.screenAudio]) {
        if (audio?.gain) {
          audio.gain.gain.value = clamped;
        }
      }
    }
  }

  async function getDebugStats(): Promise<VoiceDebugPeerStats[]> {
    const results: VoiceDebugPeerStats[] = [];
    for (const runtime of peers.values()) {
      const report = await runtime.pc.getStats();
      const statsById = new Map<string, RTCStats>();
      report.forEach((stat) => {
        statsById.set(stat.id, stat);
      });

      let selectedPairId: string | null = null;
      let selectedCandidateType: string | null = null;
      let inboundBytesReceived = 0;
      let outboundBytesSent = 0;
      let inboundVideoBytesReceived = 0;
      let outboundVideoBytesSent = 0;

      for (const stat of statsById.values()) {
        const loose = stat as unknown as Record<string, unknown>;
        if (stat.type === "transport" && typeof loose.selectedCandidatePairId === "string") {
          selectedPairId = loose.selectedCandidatePairId;
        }
      }
      for (const stat of statsById.values()) {
        const loose = stat as unknown as Record<string, unknown>;
        const isSelectedPair =
          stat.type === "candidate-pair" && (stat.id === selectedPairId || (selectedPairId === null && loose.nominated === true));
        if (isSelectedPair) {
          const localCandidateId = loose.localCandidateId;
          const localCandidate = typeof localCandidateId === "string" ? statsById.get(localCandidateId) : undefined;
          const candidateType = (localCandidate as unknown as Record<string, unknown> | undefined)?.candidateType;
          if (typeof candidateType === "string") {
            selectedCandidateType = candidateType;
          }
        }
        if (stat.type === "inbound-rtp" && loose.kind === "audio") {
          inboundBytesReceived += typeof loose.bytesReceived === "number" ? loose.bytesReceived : 0;
        }
        if (stat.type === "outbound-rtp" && loose.kind === "audio") {
          outboundBytesSent += typeof loose.bytesSent === "number" ? loose.bytesSent : 0;
        }
        if (stat.type === "inbound-rtp" && loose.kind === "video") {
          inboundVideoBytesReceived += typeof loose.bytesReceived === "number" ? loose.bytesReceived : 0;
        }
        if (stat.type === "outbound-rtp" && loose.kind === "video") {
          outboundVideoBytesSent += typeof loose.bytesSent === "number" ? loose.bytesSent : 0;
        }
      }

      results.push({
        userId: runtime.key.userId,
        deviceId: runtime.key.deviceId,
        connectionState: runtime.connectionState,
        selectedCandidateType,
        inboundBytesReceived,
        outboundBytesSent,
        inboundVideoBytesReceived,
        outboundVideoBytesSent,
        cameraTier: cameraOn ? runtime.cameraAdaptive.tier : null,
        screenTier: screenOn ? runtime.screenAdaptive.tier : null,
      });
    }
    return results;
  }

  function isLocalTrackEnabled(): boolean | null {
    const track = localStream?.getAudioTracks()[0];
    return track ? track.enabled : null;
  }

  return {
    join,
    leave,
    setMute,
    setDeafen,
    setInputDevice,
    setOutputDevice,
    setUserVolume,
    setCamera,
    setScreenShare,
    onPeerVoiceState,
    handleVoiceError,
    getDebugStats,
    isLocalTrackEnabled,
    on(event, handler) {
      return emitters[event].on(handler);
    },
    get peers() {
      return snapshotPeers();
    },
    get channelId() {
      return currentChannelId;
    },
    get guildId() {
      return currentGuildId;
    },
    get cameraOn() {
      return cameraOn;
    },
    get screenOn() {
      return screenOn;
    },
    get localCameraStream() {
      return cameraStream;
    },
    get localScreenStream() {
      return screenStream;
    },
  };
}
