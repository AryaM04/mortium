// The voice call for this tab: join, leave, mute, deafen, and the state a
// voice status panel reads. The engine itself lives in
// `@mortium/client-core/voice` and is loaded only on the first
// join, per the resource rule in CLAUDE.md (load heavy parts, such as
// voice, only when needed).
import { createStore } from "zustand/vanilla";
import { GatewayOpcode } from "@mortium/shared";
import { getTurnCredentials } from "@mortium/client-core";
import type { CryptoClient } from "@mortium/client-core/crypto-client";
import type {
  VoiceDebugPeerStats,
  VoiceEngine,
  VoiceEngineErrorEvent,
  VoicePeerState,
} from "@mortium/client-core/voice";
import { session } from "./session.js";
import { cryptoReady } from "./messages.js";
import { gatewaySend, realtimeStore, subscribeDispatch } from "./realtime.js";
import { effectiveVolumeFor, updateVoiceDeviceSettings, voiceDeviceSettingsStore } from "./voice-settings.js";
import { startPushToTalkRuntime, stopPushToTalkRuntime } from "./voice-ptt-runtime.js";

export type VoiceConnectionState = "idle" | "connecting" | "connected";

/** The worst of every peer's connection state, in plain words, for the status panel. */
export type VoiceQuality = "good" | "poor" | "connecting" | "lost";

export interface VoiceUiState {
  status: VoiceConnectionState;
  guildId: string | null;
  channelId: string | null;
  muted: boolean;
  deafened: boolean;
  peers: VoicePeerState[];
  localSpeaking: boolean;
  quality: VoiceQuality;
  /** The last error, in plain words fit for direct display. Cleared on the next successful join. */
  errorMessage: string | null;
  /** Whether the local camera is on right now. */
  cameraOn: boolean;
  /** Whether local screen sharing is on right now. */
  screenOn: boolean;
  /** The local camera's stream, for the mirrored preview tile, or null when the camera is off. */
  localCameraStream: MediaStream | null;
  /** The local screen-share stream, for the preview tile, or null when not sharing. */
  localScreenStream: MediaStream | null;
  /** Whether the push-to-talk key is held right now (only meaningful when the input mode is push-to-talk). */
  pttActive: boolean;
}

function initialVoiceUiState(): VoiceUiState {
  return {
    status: "idle",
    guildId: null,
    channelId: null,
    muted: false,
    deafened: false,
    peers: [],
    localSpeaking: false,
    quality: "connecting",
    errorMessage: null,
    cameraOn: false,
    screenOn: false,
    localCameraStream: null,
    localScreenStream: null,
    pttActive: false,
  };
}

/** True when this browser supports the camera at all. Used to disable the camera button with a clear reason. */
export const cameraSupported = typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
/** True when this browser supports screen capture. Used to disable the screen button with a clear reason. */
export const screenShareSupported =
  typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getDisplayMedia);

export const voiceStore = createStore<VoiceUiState>(() => initialVoiceUiState());

function describeError(error: VoiceEngineErrorEvent): string {
  switch (error.kind) {
    case "mic-permission-denied":
      return "The browser did not allow use of the microphone. Voice chat needs microphone access.";
    case "camera-permission-denied":
      return "The browser did not allow use of the camera.";
    case "screen-permission-denied":
      return "The browser did not allow screen capture.";
    case "output-device-unsupported":
      return "This browser cannot change the audio output device.";
    case "ice-failed":
      return "The connection to a voice peer failed.";
    case "voice-error":
    default:
      return error.message;
  }
}

function worstQuality(peers: VoicePeerState[]): VoiceQuality {
  if (peers.length === 0) {
    return "connecting";
  }
  let quality: VoiceQuality = "good";
  for (const peer of peers) {
    if (peer.connectionState === "failed" || peer.connectionState === "closed") {
      return "lost";
    }
    if (peer.connectionState === "disconnected") {
      quality = "poor";
    } else if (peer.connectionState !== "connected" && quality === "good") {
      quality = "connecting";
    }
  }
  return quality;
}

let engine: VoiceEngine | null = null;
let engineLoad: Promise<VoiceEngine> | null = null;
/** The crypto layer for the signals of the current call. `joinVoiceChannel` sets it before the engine joins. */
let callCrypto: CryptoClient | null = null;
/** The random id of the current join. The signal transport makes it, and VOICE_JOIN sends it. */
let callId: string | undefined;

/** The user's explicit mute choice, kept apart from `voiceStore.muted` so push-to-talk can gate the mic without losing it. */
let manualMuted = false;

/** Recomputes whether the mic should be open and tells the engine, given the manual mute choice, deafen, and (in push-to-talk mode) whether the key is held. */
function applyMicGate(): void {
  if (!engine) {
    return;
  }
  const state = voiceStore.getState();
  if (state.deafened) {
    return;
  }
  const mode = voiceDeviceSettingsStore.getState().inputMode;
  const desiredMuted = mode === "push-to-talk" ? manualMuted || !state.pttActive : manualMuted;
  if (desiredMuted !== state.muted) {
    engine.setMute(desiredMuted);
  }
  voiceStore.setState({ muted: desiredMuted });
}

function setUpPushToTalkIfNeeded(): void {
  if (voiceDeviceSettingsStore.getState().inputMode === "push-to-talk") {
    startPushToTalkRuntime((active) => {
      voiceStore.setState({ pttActive: active });
      applyMicGate();
    });
  } else {
    stopPushToTalkRuntime();
  }
}

/** Called from the voice settings dialog when the input mode changes, live during a call. */
export function applyVoiceInputMode(): void {
  if (voiceStore.getState().status !== "connected") {
    return;
  }
  setUpPushToTalkIfNeeded();
  voiceStore.setState({ pttActive: false });
  applyMicGate();
}

/**
 * True when the page's first URL of this tab carried `?forceRelay`, a
 * test-only flag that forces every peer connection to use the TURN
 * relay, never a direct or server-reflexive path. The voice end-to-end
 * test uses this to prove the relay path works on its own, without a
 * real NAT in the way. Read once at module load, not on every call:
 * joining a voice channel also does a client-side route change (see
 * ChannelColumn's onSelect), which rewrites the URL and would otherwise
 * drop the flag before the engine ever reads it.
 */
const forceRelay = new URLSearchParams(window.location.search).has("forceRelay");
function shouldForceRelay(): boolean {
  return forceRelay;
}

async function loadEngine(): Promise<VoiceEngine> {
  if (engine) {
    return engine;
  }
  if (!engineLoad) {
    engineLoad = (async () => {
      const mod = await import("@mortium/client-core/voice");
      const selfUserId = realtimeStore.getState().selfUserId;
      const selfDeviceId = session.store.getState().deviceId;
      if (!selfUserId || !selfDeviceId) {
        throw new Error("Cannot start voice before the session is ready.");
      }

      const created = mod.createVoiceEngine({
        getTurnCredentials: () => getTurnCredentials(session.apiClient),
        createSignalTransport: (channelId) => {
          const handle = callCrypto;
          if (!handle) {
            throw new Error("Cannot start voice before the crypto layer is ready.");
          }
          callId = mod.newCallId();
          return mod.createOlmSignalTransport({
            channelId,
            callId,
            crypto: {
              async sendToDevice(target, type, content) {
                const result = await handle.encryptToDevices([target], type, content, { live: true });
                if (result.failed.length > 0) {
                  throw new Error(`No Olm session with device ${target.deviceId}.`);
                }
              },
              onToDevice: (handler) => handle.onToDevice(handler),
            },
            peerState: (userId) => realtimeStore.getState().voiceStatesByChannel[channelId]?.[userId] ?? null,
            log: (message) => console.warn(`[voice] ${message}`),
          });
        },
        sendVoiceJoin: (channelId, selfMute, selfDeaf) =>
          gatewaySend(GatewayOpcode.VOICE_JOIN, { channelId, selfMute, selfDeaf, callId }),
        sendVoiceLeave: () => gatewaySend(GatewayOpcode.VOICE_LEAVE, {}),
        sendVoiceState: (patch) => gatewaySend(GatewayOpcode.VOICE_STATE, patch),
        getInitialPeers: (channelId) => {
          const states = realtimeStore.getState().voiceStatesByChannel[channelId] ?? {};
          return Object.values(states)
            .filter((state) => state.userId !== selfUserId)
            .map((state) => ({ userId: state.userId, deviceId: state.deviceId }));
        },
        selfUserId,
        selfDeviceId,
        createPeerConnection: (config) =>
          new RTCPeerConnection(shouldForceRelay() ? { ...config, iceTransportPolicy: "relay" } : config),
        getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
        getDisplayMedia: (constraints) => navigator.mediaDevices.getDisplayMedia(constraints),
        createAudioContext: () => new AudioContext(),
      });

      const volumeAppliedTo = new Set<string>();
      created.on("peers", (peers) => {
        for (const peer of peers) {
          if (!volumeAppliedTo.has(peer.userId)) {
            volumeAppliedTo.add(peer.userId);
            created.setUserVolume(peer.userId, effectiveVolumeFor(peer.userId));
          }
        }
        voiceStore.setState({ peers, quality: worstQuality(peers) });
      });
      created.on("localSpeaking", (localSpeaking) => {
        voiceStore.setState({ localSpeaking });
      });
      created.on("error", (error) => {
        voiceStore.setState({ errorMessage: describeError(error) });
      });
      created.on("forcedMute", () => {
        // The server refused an unmute. In push-to-talk mode, the next key press tries again.
        if (voiceDeviceSettingsStore.getState().inputMode !== "push-to-talk") {
          manualMuted = true;
        }
        voiceStore.setState({ muted: true });
      });
      created.on("localMedia", ({ cameraOn, screenOn }) => {
        voiceStore.setState({
          cameraOn,
          screenOn,
          localCameraStream: created.localCameraStream,
          localScreenStream: created.localScreenStream,
        });
      });

      subscribeDispatch((event) => {
        if (event.t === "VOICE_STATE_UPDATE") {
          const update = event.d as Parameters<VoiceEngine["onPeerVoiceState"]>[0];
          created.onPeerVoiceState(update);
          // A leave dispatch for our own (userId, deviceId) means the
          // server removed us from voice (a kick, or a move to another
          // device). Reset the status panel straight from the dispatch,
          // rather than poll the engine's own state, since its teardown
          // runs asynchronously. A leave with the call id of an older join
          // is for an old voice state of this device, so the engine ignores it.
          if (
            update.channelId === null &&
            update.userId === selfUserId &&
            update.deviceId === selfDeviceId &&
            (update.callId === undefined || update.callId === callId)
          ) {
            voiceStore.setState({
              status: "idle",
              guildId: null,
              channelId: null,
              peers: [],
              cameraOn: false,
              screenOn: false,
              localCameraStream: null,
              localScreenStream: null,
            });
          }
          // A moderator moved this device to another channel. The server keeps
          // the call id, so join the new channel locally with a new call id.
          const current = voiceStore.getState();
          if (
            update.channelId !== null &&
            update.userId === selfUserId &&
            update.deviceId === selfDeviceId &&
            update.callId === callId &&
            current.status !== "idle" &&
            update.channelId !== current.channelId
          ) {
            void joinVoiceChannel(update.guildId, update.channelId, { keepAudio: true });
          }
        } else if (event.t === "VOICE_ERROR") {
          created.handleVoiceError(event.d as Parameters<VoiceEngine["handleVoiceError"]>[0]);
        } else if (event.t === "READY") {
          // A new session after a long network drop. The server can have
          // removed the voice state, and the peers ignore signals of a call
          // that they do not know. Thus join the same channel again.
          const { status, guildId, channelId } = voiceStore.getState();
          if (status !== "idle" && channelId !== null) {
            void joinVoiceChannel(guildId, channelId, { keepAudio: true });
          }
        }
      });

      engine = created;
      return created;
    })();
    // A failed load must not stay in the cache: the next join tries again.
    engineLoad.catch(() => {
      engineLoad = null;
    });
  }
  return engineLoad;
}

/**
 * Join a voice channel, or a DM call when `guildId` is null. Leave the current call first if there is one.
 * With `keepAudio`, the new call keeps the mute and deafen of the current call (a rejoin that the app starts).
 */
export async function joinVoiceChannel(
  guildId: string | null,
  channelId: string,
  options: { keepAudio?: boolean } = {},
): Promise<void> {
  voiceStore.setState({ status: "connecting", guildId, channelId, errorMessage: null });
  let voiceEngine: VoiceEngine;
  try {
    // Voice signals are Olm messages, so the call needs the crypto layer.
    callCrypto = await cryptoReady();
    voiceEngine = await loadEngine();
  } catch (error) {
    // Do not leave the panel in "connecting" for a join that cannot start.
    voiceStore.setState({
      status: "idle",
      guildId: null,
      channelId: null,
      errorMessage: error instanceof Error ? error.message : "The voice call could not start.",
    });
    return;
  }
  const saved = voiceDeviceSettingsStore.getState();
  voiceEngine.setInputDevice(saved.inputDeviceId);
  void voiceEngine.setOutputDevice(saved.outputDeviceId);
  // Set the mic gate before the join, so the engine applies it to the
  // mic track the moment the track exists. In push-to-talk mode the mic
  // is closed for the whole join, and the key works while it connects.
  if (options.keepAudio) {
    // The engine keeps the mute and the deafen of the current call. Only the push-to-talk key is up again.
    const muted = manualMuted || saved.inputMode === "push-to-talk";
    if (muted !== voiceStore.getState().muted) {
      voiceEngine.setMute(muted);
    }
    voiceStore.setState({ muted, pttActive: false });
  } else {
    manualMuted = false;
    const muted = saved.inputMode === "push-to-talk";
    voiceEngine.setDeafen(false);
    voiceEngine.setMute(muted);
    voiceStore.setState({ muted, deafened: false, pttActive: false });
  }
  setUpPushToTalkIfNeeded();
  try {
    await voiceEngine.join(guildId, channelId);
  } catch {
    // The server refused the join. The "error" event already carries the reason.
  }
  if (voiceEngine.channelId === channelId) {
    voiceStore.setState({ status: "connected" });
  } else {
    // join() left the engine in a clean, not-in-call state (for example,
    // the microphone permission was denied). The "error" event already
    // carries the reason.
    stopPushToTalkRuntime();
    voiceStore.setState({ status: "idle", guildId: null, channelId: null, pttActive: false });
  }
}

export async function leaveVoice(): Promise<void> {
  stopPushToTalkRuntime();
  if (!engine) {
    voiceStore.setState(initialVoiceUiState());
    return;
  }
  await engine.leave();
  voiceStore.setState(initialVoiceUiState());
}

export function toggleMute(): void {
  if (!engine) {
    return;
  }
  manualMuted = !manualMuted;
  applyMicGate();
}

// Remembers the manual mute choice from right before a deafen, so the
// status panel's mute icon can be restored correctly when the user
// un-deafens.
let mutedBeforeDeafen = false;

export function toggleDeafen(): void {
  if (!engine) {
    return;
  }
  const nextDeafened = !voiceStore.getState().deafened;
  engine.setDeafen(nextDeafened);
  if (nextDeafened) {
    mutedBeforeDeafen = manualMuted;
    manualMuted = true;
    voiceStore.setState({ deafened: true, muted: true });
  } else {
    manualMuted = mutedBeforeDeafen;
    voiceStore.setState({ deafened: false });
    applyMicGate();
  }
}

/** Turn the local camera on or off. Does nothing when not in a call. */
export function toggleCamera(): void {
  if (!engine) {
    return;
  }
  void engine.setCamera(!voiceStore.getState().cameraOn);
}

/** Turn local screen sharing on or off. Does nothing when not in a call. */
export function toggleScreenShare(): void {
  if (!engine) {
    return;
  }
  void engine.setScreenShare(!voiceStore.getState().screenOn);
}

/** Debug stats for the e2e test and dev tooling. See `main.tsx` for where `window.__voiceDebug` is installed. */
export async function getVoiceDebugStats(): Promise<VoiceDebugPeerStats[]> {
  if (!engine) {
    return [];
  }
  return engine.getDebugStats();
}

/** Whether the local microphone track is enabled right now, or null when not in a call. */
export function isLocalVoiceTrackEnabled(): boolean | null {
  return engine ? engine.isLocalTrackEnabled() : null;
}

/** Applies a peer's volume (0 to 2) at once, when in a call. Persistence happens in `voice-settings.ts`; this is only the live apply step. */
export function applyPeerVolume(userId: string, volume: number): void {
  engine?.setUserVolume(userId, volume);
}

/** Hot-swaps the microphone during a call. Null is the default microphone. Does nothing when not in a call; the choice still applies on the next join. */
export function applyInputDeviceLive(deviceId: string | null): void {
  if (voiceStore.getState().status === "connected") {
    engine?.setInputDevice(deviceId);
  }
}

/** Hot-swaps the audio output device during a call. Null is the default device. Does nothing when not in a call. */
export function applyOutputDeviceLive(deviceId: string | null): void {
  if (voiceStore.getState().status === "connected") {
    void engine?.setOutputDevice(deviceId);
  }
}

/** Hot-swaps the camera during a call, only while the camera is already on. Null is the default camera. */
export function applyCameraDeviceLive(deviceId: string | null): void {
  if (voiceStore.getState().status === "connected" && voiceStore.getState().cameraOn) {
    void engine?.setCamera(true, deviceId ?? undefined);
  }
}

/**
 * If the microphone, speaker, or camera the user picked in the voice
 * settings dialog disappears (unplugged, driver reset), fall back to the
 * browser's default device and say so, instead of leaving the call on a
 * dead device. Only acts while in a call.
 */
async function handleDeviceChange(): Promise<void> {
  if (!engine || voiceStore.getState().status !== "connected") {
    return;
  }
  let devices: MediaDeviceInfo[];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return;
  }
  const ids = new Set(devices.map((d) => d.deviceId));
  const settings = voiceDeviceSettingsStore.getState();
  let notice: string | null = null;

  if (settings.inputDeviceId && !ids.has(settings.inputDeviceId)) {
    updateVoiceDeviceSettings({ inputDeviceId: null });
    engine.setInputDevice(null);
    notice = "The chosen microphone was disconnected. Using the default microphone.";
  }
  if (settings.outputDeviceId && !ids.has(settings.outputDeviceId)) {
    updateVoiceDeviceSettings({ outputDeviceId: null });
    void engine.setOutputDevice(null);
    notice = "The chosen speaker was disconnected. Using the default speaker.";
  }
  if (settings.cameraDeviceId && !ids.has(settings.cameraDeviceId) && voiceStore.getState().cameraOn) {
    updateVoiceDeviceSettings({ cameraDeviceId: null });
    void engine.setCamera(true);
    notice = "The chosen camera was disconnected. Using the default camera.";
  }
  if (notice) {
    voiceStore.setState({ errorMessage: notice });
  }
}

if (typeof navigator !== "undefined" && navigator.mediaDevices) {
  navigator.mediaDevices.addEventListener("devicechange", () => {
    void handleDeviceChange();
  });
}

session.store.subscribe((state) => {
  if (state.status === "signedOut") {
    void leaveVoice();
  }
});

// The socket is still open on pagehide. Send the leave now, so that the
// others do not see this device in the call until the grace timer ends.
window.addEventListener("pagehide", (event) => {
  if (voiceStore.getState().status === "idle") {
    return;
  }
  gatewaySend(GatewayOpcode.VOICE_LEAVE, {});
  if (event.persisted) {
    // The page can come back from the browser cache. Then it must not show the old call.
    void leaveVoice();
  }
});
