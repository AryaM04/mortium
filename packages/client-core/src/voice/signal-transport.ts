// The signal transport: the one module in the voice package that knows how
// signals travel. `VoiceEngine` depends only on the `SignalTransport`
// interface below. The real transport sends each signal as an Olm
// to-device message to the exact peer device, so the server cannot read
// or change SDP and ICE data (see docs/concepts/voice.md).

/** One live voice session: one user, connected from one device. */
export interface PeerKey {
  userId: string;
  deviceId: string;
}

/** One signaling message. It travels inside an Olm envelope. */
export type SignalPayload =
  | { kind: "description"; description: RTCSessionDescriptionInit }
  | { kind: "candidate"; candidate: RTCIceCandidateInit }
  | { kind: "media"; streams: { camera?: string; screen?: string } };

export interface SignalTransport {
  /** The random id of the join that this transport belongs to, when it has one. */
  readonly callId?: string;
  send(target: PeerKey, payload: SignalPayload): void;
  /** Register a handler for an incoming signal. Returns a function that removes the handler. */
  onSignal(handler: (from: PeerKey, payload: SignalPayload) => void): () => void;
  /** Stop and release the subscription. The engine calls this one time per call, on `leave()`. */
  close?(): void;
}

/** The to-device envelope type of a voice signal. See docs/concepts/olm-megolm.md section 6. */
export const VOICE_SIGNAL_TYPE = "voice.signal";

/** The part of the crypto layer that the transport uses. The voice package does not import the crypto package. */
export interface SignalCrypto {
  /** Encrypt one envelope for one device and send it over the gateway at once. */
  sendToDevice(target: PeerKey, type: string, content: Record<string, unknown>): Promise<void>;
  /** Watch decrypted envelopes. The sender is the verified device of the Olm session. */
  onToDevice(handler: (event: { type: string; content: Record<string, unknown>; sender: PeerKey }) => void): () => void;
}

/** The voice state of a peer, as this client knows it now. */
export interface PeerVoiceState {
  deviceId: string;
  callId?: string;
}

export interface OlmSignalTransportDeps {
  channelId: string;
  /** The random id of this join. The server puts it in the voice state of this device. */
  callId: string;
  crypto: SignalCrypto;
  /** The current voice state of a user in this channel, or null when the user is not in it. */
  peerState(userId: string): PeerVoiceState | null;
  log?(message: string): void;
}

/** The content of a `voice.signal` envelope. */
interface SignalContent {
  channelId: string;
  /** The call id of the sender. */
  callId: string;
  /** The call id of the receiver, as the sender knows it. */
  targetCallId: string;
  payload: SignalPayload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSignalPayload(value: unknown): value is SignalPayload {
  if (!isRecord(value)) {
    return false;
  }
  switch (value.kind) {
    case "description":
      return isRecord(value.description) && typeof value.description.type === "string";
    case "candidate":
      return isRecord(value.candidate);
    case "media":
      return isRecord(value.streams);
    default:
      return false;
  }
}

/** Make a random call id for one join. */
export function newCallId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Build a `SignalTransport` for one voice channel that sends each signal
 * as an Olm to-device message. The receiver accepts a signal only when all
 * of these are true: the channel is this channel, the target call id is
 * the call id of this join, the sender device is the device in the voice
 * state of the sender in this channel, and the sender call id is the call
 * id in that voice state. Thus the server cannot inject, redirect or replay
 * a signal, and the DTLS fingerprints in the SDP are authentic.
 */
export function createOlmSignalTransport(deps: OlmSignalTransportDeps): SignalTransport {
  const handlers = new Set<(from: PeerKey, payload: SignalPayload) => void>();
  const log = deps.log ?? (() => {});
  // One chain for all sends, so that a peer gets the signals in the order of the calls.
  let chain: Promise<void> = Promise.resolve();
  let closed = false;

  const unsubscribe = deps.crypto.onToDevice((event) => {
    if (closed || event.type !== VOICE_SIGNAL_TYPE) {
      return;
    }
    const content = event.content as Partial<SignalContent>;
    if (content.channelId !== deps.channelId) {
      return;
    }
    if (content.targetCallId !== deps.callId) {
      log(`A voice signal from device ${event.sender.deviceId} is for a different call. It was dropped.`);
      return;
    }
    const state = deps.peerState(event.sender.userId);
    if (!state || state.deviceId !== event.sender.deviceId) {
      log(`A voice signal came from device ${event.sender.deviceId}, which is not in this call. It was dropped.`);
      return;
    }
    if (!state.callId || content.callId !== state.callId) {
      log(`A voice signal from device ${event.sender.deviceId} has a stale call id. It was dropped.`);
      return;
    }
    if (!isSignalPayload(content.payload)) {
      return;
    }
    const from: PeerKey = { userId: event.sender.userId, deviceId: event.sender.deviceId };
    for (const handler of handlers) {
      handler(from, content.payload);
    }
  });

  return {
    callId: deps.callId,
    send(target, payload) {
      const state = deps.peerState(target.userId);
      if (!state?.callId || state.deviceId !== target.deviceId) {
        log(`Device ${target.deviceId} is not in this call. The voice signal was not sent.`);
        return;
      }
      const content: SignalContent = { channelId: deps.channelId, callId: deps.callId, targetCallId: state.callId, payload };
      chain = chain
        .then(() => deps.crypto.sendToDevice(target, VOICE_SIGNAL_TYPE, content as unknown as Record<string, unknown>))
        .catch((error: unknown) => log(`A voice signal could not be sent: ${String(error)}`));
    },
    onSignal(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    close() {
      closed = true;
      handlers.clear();
      unsubscribe();
    },
  };
}
