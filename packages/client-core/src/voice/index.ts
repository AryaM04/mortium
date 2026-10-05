// Public surface of the voice subpackage. Import this only from
// "@mortium/client-core/voice", never from the main barrel: voice
// pulls in WebRTC- and Web Audio-shaped types, and the plan keeps it out
// of the main bundle until a call actually starts.
export {
  createVoiceEngine,
  comparePeerKeys,
  isPolite,
  DEFAULT_AUDIO_BITRATE_BPS,
  SPEAKING_TICK_MS,
  SPEAKING_OFF_MS,
  SPEAKING_VOLUME_THRESHOLD,
  ICE_RESTART_BACKOFFS_MS,
  MAX_ICE_RESTARTS,
  OFFER_ANSWER_TIMEOUT_MS,
  TURN_REFRESH_SKEW_MS,
  JOIN_CONFIRM_TIMEOUT_MS,
  NEWCOMER_TRACK_SHARE_DELAY_MS,
  STREAM_CONFIRM_TIMEOUT_MS,
  CAMERA_IDEAL_WIDTH,
  CAMERA_IDEAL_HEIGHT,
  CAMERA_IDEAL_FRAME_RATE,
  type VoiceEngine,
  type VoiceEngineDeps,
  type VoicePeerState,
  type VoiceEngineErrorEvent,
  type VoiceEngineErrorKind,
  type VoiceEngineEventMap,
  type AudioElementLike,
  type VoiceDebugPeerStats,
} from "./engine.js";

export {
  createOlmSignalTransport,
  newCallId,
  VOICE_SIGNAL_TYPE,
  type SignalTransport,
  type SignalCrypto,
  type PeerKey,
  type PeerVoiceState,
  type SignalPayload,
  type OlmSignalTransportDeps,
} from "./signal-transport.js";

export { preferOpusFec, applyOpusFec, capOpusBitrate } from "./sdp.js";
