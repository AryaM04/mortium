// Tests for the voice engine: the politeness comparator, ICE candidate
// queueing before the remote description is set, glare handling, the
// speaking hysteresis window, leave() cleanup, and peer add/remove
// reacting to onPeerVoiceState per the newcomer/later-peer offer rule.
// Every WebRTC and Web Audio object is a small hand-written fake; no real
// network or DOM is used.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceStateJson } from "@mortium/shared";
import {
  ADAPTIVE_TICK_MS,
  comparePeerKeys,
  createVoiceEngine,
  ICE_RESTART_BACKOFFS_MS,
  isPolite,
  JOIN_CONFIRM_TIMEOUT_MS,
  NEWCOMER_TRACK_SHARE_DELAY_MS,
  DEFAULT_AUDIO_BITRATE_BPS,
  SPEAKING_OFF_MS,
  SPEAKING_TICK_MS,
  SPEAKING_VOLUME_THRESHOLD,
  type VoiceEngineDeps,
} from "./engine.js";
import type { PeerKey, SignalPayload, SignalTransport } from "./signal-transport.js";

const OPUS_SDP = [
  "v=0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=10",
  "",
].join("\r\n");

// ---- fakes ------------------------------------------------------------------

class FakeTrack {
  stopped = false;
  enabled = true;
  onended: (() => void) | null = null;
  onmute: (() => void) | null = null;
  /** Only the `height` field is read by the engine (adaptive-quality source resolution). */
  settings: MediaTrackSettings = {};
  constructor(public readonly kind: "audio" | "video" = "audio") {}
  stop(): void {
    this.stopped = true;
  }
  getSettings(): MediaTrackSettings {
    return this.settings;
  }
}

let streamCounter = 0;

class FakeMediaStream {
  readonly id: string;
  constructor(
    private readonly tracks: FakeTrack[] = [new FakeTrack()],
    id?: string,
  ) {
    streamCounter += 1;
    this.id = id ?? `stream-${streamCounter}`;
  }
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === "video");
  }
}

let transceiverMidCounter = 0;

class FakeTransceiver {
  sender: FakeSender;
  direction: string;
  mid: string | null;
  constructor(track: FakeTrack | null, direction: string) {
    this.sender = new FakeSender(track);
    this.direction = direction;
    transceiverMidCounter += 1;
    this.mid = `mid-${transceiverMidCounter}`;
  }
}

class FakeSender {
  /** Every `setParameters()` call this sender received, for the adaptive-quality applier tests. */
  setParametersCalls: RTCRtpSendParameters[] = [];
  constructor(public track: FakeTrack | null) {}
  getParameters(): RTCRtpSendParameters {
    return { encodings: [{}] } as unknown as RTCRtpSendParameters;
  }
  async setParameters(parameters: RTCRtpSendParameters): Promise<void> {
    this.setParametersCalls.push(parameters);
  }
  async replaceTrack(track: FakeTrack | null): Promise<void> {
    this.track = track;
  }
}

/** A minimal stand-in for `RTCStatsReport`: iterable with `forEach`, built from a plain list. */
class FakeStatsReport {
  constructor(private readonly stats: RTCStats[]) {}
  forEach(callback: (stat: RTCStats) => void): void {
    for (const stat of this.stats) {
      callback(stat);
    }
  }
}

/** Build a fake `getStats()` report with one selected candidate pair and, optionally, per-video-sender outbound-rtp stats keyed by `mid`. */
function fakeStatsReport(options: {
  availableOutgoingBitrate?: number;
  video?: Array<{ mid: string; qualityLimitationReason?: string }>;
}): FakeStatsReport {
  const stats: RTCStats[] = [
    { id: "transport-1", type: "transport", timestamp: 0, selectedCandidatePairId: "pair-1" } as unknown as RTCStats,
    {
      id: "pair-1",
      type: "candidate-pair",
      timestamp: 0,
      nominated: true,
      availableOutgoingBitrate: options.availableOutgoingBitrate,
    } as unknown as RTCStats,
  ];
  for (const [i, v] of (options.video ?? []).entries()) {
    stats.push({
      id: `outbound-video-${i}`,
      type: "outbound-rtp",
      timestamp: 0,
      kind: "video",
      mid: v.mid,
      qualityLimitationReason: v.qualityLimitationReason ?? "none",
    } as unknown as RTCStats);
  }
  return new FakeStatsReport(stats);
}

type SignalingState = "stable" | "have-local-offer" | "have-remote-offer";

class FakePeerConnection {
  connectionState: RTCPeerConnectionState = "new";
  signalingState: SignalingState = "stable";
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  senders: FakeSender[] = [];
  offerCount = 0;
  answerCount = 0;
  restartIceCalls = 0;
  closed = false;
  addedCandidates: RTCIceCandidateInit[] = [];
  transceivers: FakeTransceiver[] = [];
  /** The report `getStats()` returns; the adaptive-quality tests set this per tick. */
  statsReport: FakeStatsReport = new FakeStatsReport([]);
  getStatsCallCount = 0;

  ontrack: ((event: { track: FakeTrack; streams: FakeMediaStream[] }) => void) | null = null;
  onicecandidate: ((event: { candidate: RTCIceCandidate | null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  onnegotiationneeded: (() => void) | null = null;

  addTrack(track: FakeTrack, _stream: FakeMediaStream): FakeSender {
    const sender = new FakeSender(track);
    this.senders.push(sender);
    return sender;
  }
  getSenders(): FakeSender[] {
    return this.senders;
  }
  addTransceiver(track: FakeTrack, init?: { direction?: string; streams?: FakeMediaStream[] }): FakeTransceiver {
    const transceiver = new FakeTransceiver(track, init?.direction ?? "sendrecv");
    this.transceivers.push(transceiver);
    return transceiver;
  }
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    this.offerCount += 1;
    return { type: "offer", sdp: OPUS_SDP };
  }
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    this.answerCount += 1;
    return { type: "answer", sdp: OPUS_SDP };
  }
  async setLocalDescription(description?: RTCSessionDescriptionInit): Promise<void> {
    if (description?.type === "rollback") {
      this.signalingState = "stable";
      this.localDescription = null;
      return;
    }
    this.localDescription = description ?? null;
    this.signalingState = description?.type === "offer" ? "have-local-offer" : "stable";
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description;
    this.signalingState = description.type === "offer" ? "have-remote-offer" : "stable";
  }
  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    this.addedCandidates.push(candidate);
  }
  restartIce(): void {
    this.restartIceCalls += 1;
  }
  async getStats(): Promise<FakeStatsReport> {
    this.getStatsCallCount += 1;
    return this.statsReport;
  }
  close(): void {
    this.closed = true;
    this.connectionState = "closed";
  }
}

class FakeAnalyser {
  fftSize = 512;
  frequencyBinCount = 32;
  /** Test-controlled average byte value the next sample returns. */
  value = 0;
  getByteFrequencyData(buffer: Uint8Array): void {
    buffer.fill(this.value);
  }
}

class FakeAudioNode {
  connect(): void {}
  disconnect(): void {}
}

class FakeGainNode extends FakeAudioNode {
  gain = { value: 1 };
}

class FakeAudioContext {
  closed = false;
  destination = new FakeAudioNode();
  lastAnalyser: FakeAnalyser | null = null;
  createGain(): FakeGainNode {
    return new FakeGainNode();
  }
  createMediaStreamSource(_stream: unknown): FakeAudioNode {
    return new FakeAudioNode();
  }
  createAnalyser(): FakeAnalyser {
    const analyser = new FakeAnalyser();
    this.lastAnalyser = analyser;
    return analyser;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeSignalTransport implements SignalTransport {
  sent: Array<{ target: PeerKey; payload: SignalPayload }> = [];
  private readonly handlers = new Set<(from: PeerKey, payload: SignalPayload) => void>();
  closed = false;

  send(target: PeerKey, payload: SignalPayload): void {
    this.sent.push({ target, payload });
  }
  onSignal(handler: (from: PeerKey, payload: SignalPayload) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  close(): void {
    this.closed = true;
    this.handlers.clear();
  }
  emit(from: PeerKey, payload: SignalPayload): void {
    for (const handler of this.handlers) {
      handler(from, payload);
    }
  }
}

interface TestSetup {
  deps: VoiceEngineDeps;
  pcs: FakePeerConnection[];
  transport: FakeSignalTransport;
  audioContexts: FakeAudioContext[];
  streams: FakeMediaStream[];
}

function makeDeps(overrides: Partial<VoiceEngineDeps> = {}): TestSetup {
  const pcs: FakePeerConnection[] = [];
  const audioContexts: FakeAudioContext[] = [];
  const streams: FakeMediaStream[] = [];
  const transport = new FakeSignalTransport();

  const deps: VoiceEngineDeps = {
    getTurnCredentials: async () => ({ iceServers: [], ttlSeconds: 3600 }),
    createSignalTransport: () => transport,
    sendVoiceJoin: vi.fn(),
    sendVoiceLeave: vi.fn(),
    sendVoiceState: vi.fn(),
    getInitialPeers: () => [],
    selfUserId: "a",
    selfDeviceId: "d1",
    createPeerConnection: () => {
      const pc = new FakePeerConnection();
      pcs.push(pc);
      return pc as unknown as RTCPeerConnection;
    },
    getUserMedia: async (constraints?: MediaStreamConstraints) => {
      const wantsVideo = Boolean(constraints && (constraints as { video?: unknown }).video);
      const stream = new FakeMediaStream([new FakeTrack(wantsVideo ? "video" : "audio")]);
      streams.push(stream);
      return stream as unknown as MediaStream;
    },
    getDisplayMedia: async () => {
      const stream = new FakeMediaStream([new FakeTrack("video"), new FakeTrack("audio")]);
      streams.push(stream);
      return stream as unknown as MediaStream;
    },
    createAudioContext: () => {
      const ctx = new FakeAudioContext();
      audioContexts.push(ctx);
      return ctx as unknown as AudioContext;
    },
    ...overrides,
  };

  return { deps, pcs, transport, audioContexts, streams };
}

/**
 * The server's own echo of a join: `join()` waits for this (see
 * JOIN_CONFIRM_TIMEOUT_MS in engine.ts) before it signals anyone, so a
 * real-timer test must deliver it, the same way the real server does.
 */
function selfJoinUpdate(deps: VoiceEngineDeps, guildId: string, channelId: string): VoiceStateJson {
  return {
    guildId,
    channelId,
    userId: deps.selfUserId,
    deviceId: deps.selfDeviceId,
    selfMute: false,
    selfDeaf: false,
    selfVideo: false,
    selfStream: false,
    serverMute: false,
    serverDeaf: false,
    joinedAt: new Date().toISOString(),
  };
}

/** Start `join()`, deliver the server's own join echo, then wait for it to finish. */
async function joinAndConfirm(
  engine: ReturnType<typeof createVoiceEngine>,
  deps: VoiceEngineDeps,
  guildId: string,
  channelId: string,
): Promise<void> {
  const joinPromise = engine.join(guildId, channelId);
  await vi.waitFor(() => expect(deps.sendVoiceJoin).toHaveBeenCalled());
  engine.onPeerVoiceState(selfJoinUpdate(deps, guildId, channelId));
  await joinPromise;
}

// ---- politeness comparator ---------------------------------------------------

describe("comparePeerKeys / isPolite", () => {
  it("orders peer keys by the joined userId:deviceId string", () => {
    expect(comparePeerKeys({ userId: "a", deviceId: "d1" }, { userId: "b", deviceId: "d1" })).toBeLessThan(0);
    expect(comparePeerKeys({ userId: "b", deviceId: "d1" }, { userId: "a", deviceId: "d1" })).toBeGreaterThan(0);
    expect(comparePeerKeys({ userId: "a", deviceId: "d1" }, { userId: "a", deviceId: "d1" })).toBe(0);
  });

  it("the lower-sorting side is polite, and the two sides never agree", () => {
    const a: PeerKey = { userId: "a", deviceId: "d1" };
    const b: PeerKey = { userId: "b", deviceId: "d1" };
    expect(isPolite(a, b)).toBe(true);
    expect(isPolite(b, a)).toBe(false);
  });
});

// ---- ICE candidate queueing ---------------------------------------------------

describe("ICE candidate queueing", () => {
  it("queues a candidate that arrives before the remote description, then flushes it", async () => {
    const peerB: PeerKey = { userId: "b", deviceId: "d1" };
    const { deps, pcs, transport } = makeDeps({ getInitialPeers: () => [peerB] });
    const engine = createVoiceEngine(deps);

    await joinAndConfirm(engine, deps, "guild-1", "channel-1");
    const pc = pcs[0]!;
    expect(pc.offerCount).toBe(1); // newcomer offered to the initial peer

    transport.emit(peerB, { kind: "candidate", candidate: { candidate: "c1" } });
    expect(pc.addedCandidates).toHaveLength(0); // no remote description yet: queued, not applied

    transport.emit(peerB, { kind: "description", description: { type: "answer", sdp: OPUS_SDP } });
    await vi.waitFor(() => expect(pc.remoteDescription).not.toBeNull());
    await vi.waitFor(() => expect(pc.addedCandidates).toHaveLength(1));
    expect(pc.addedCandidates[0]).toEqual({ candidate: "c1" });
  });
});

// ---- glare handling ------------------------------------------------------------

describe("glare handling", () => {
  it("the polite side rolls back its own offer and accepts the peer's instead", async () => {
    // self = "a:d1", peer = "b:d1" -> self is polite (see comparePeerKeys).
    const peerB: PeerKey = { userId: "b", deviceId: "d1" };
    const { deps, pcs, transport } = makeDeps({ selfUserId: "a", selfDeviceId: "d1", getInitialPeers: () => [peerB] });
    const engine = createVoiceEngine(deps);

    await joinAndConfirm(engine, deps, "guild-1", "channel-1");
    const pc = pcs[0]!;
    expect(pc.signalingState).toBe("have-local-offer"); // our own offer is in flight

    transport.emit(peerB, { kind: "description", description: { type: "offer", sdp: OPUS_SDP } });
    await vi.waitFor(() => expect(pc.remoteDescription).not.toBeNull());

    expect(pc.remoteDescription?.type).toBe("offer"); // accepted the peer's offer after rollback
    expect(pc.answerCount).toBe(1); // and answered it
  });

  it("never offers to a later peer on its own, even when the browser fires onnegotiationneeded", async () => {
    // Regression test for the flaky voice e2e tests (see the debug
    // trace that found this). We are already in the channel; a peer
    // joins later, and `ensurePeer`'s `addTrack` makes the browser
    // fire onnegotiationneeded for our connection to them regardless
    // of which side we are — but we must NOT act on it: the design
    // (see the comment on `onPeerVoiceState` in engine.ts) is that the
    // later peer waits passively for the newcomer's own offer instead
    // of sending one of our own. Sending one anyway collides with the
    // newcomer's real offer moments later, forcing an unnecessary
    // perfect-negotiation rollback on our (polite) side — and on real
    // Chromium, a rollback like that can leave the connection's ICE
    // candidate gathering broken for good: signaling completes (both
    // sides reach "stable"), but connectionState sits at "new"
    // forever, because no candidates are ever exchanged. Every
    // negotiation this engine actually needs (the initial offer to an
    // already-present peer, the camera and screen share toggles, and
    // an ICE restart) already starts explicitly at its own call site
    // (see `negotiationArmed`'s comment in engine.ts), so
    // onnegotiationneeded firing here is never a real, missed need.
    const peerB: PeerKey = { userId: "b", deviceId: "d1" };
    const { deps, pcs, transport } = makeDeps({ selfUserId: "a", selfDeviceId: "d1" }); // no initial peers: b joins later
    const engine = createVoiceEngine(deps);
    await joinAndConfirm(engine, deps, "guild-1", "channel-1");

    engine.onPeerVoiceState({
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "b",
      deviceId: "d1",
      selfMute: false,
      selfDeaf: false,
      selfVideo: false,
      selfStream: false,
      serverMute: false,
      serverDeaf: false,
      joinedAt: new Date().toISOString(),
    });
    await Promise.resolve();
    await Promise.resolve();
    const pc = pcs[0]!;
    expect(pc.offerCount).toBe(0); // ensurePeer alone does not offer; see the "later peer" test

    // The real addTrack-triggered onnegotiationneeded fires, but must
    // be ignored: we are the later peer for this pair, not the
    // newcomer.
    pc.onnegotiationneeded?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(pc.offerCount).toBe(0); // still no unprompted offer

    // B's offer, sent because B is the newcomer here, arrives with no
    // collision at all and is accepted plainly.
    transport.emit(peerB, { kind: "description", description: { type: "offer", sdp: OPUS_SDP } });
    await vi.waitFor(() => expect(pc.remoteDescription).not.toBeNull());
    expect(pc.answerCount).toBe(1); // answered B's offer
    expect(pc.offerCount).toBe(0); // never sent an offer of our own

    // The browser can fire onnegotiationneeded again after that; it
    // must still be ignored.
    pc.onnegotiationneeded?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(pc.offerCount).toBe(0);
  });

  it("the impolite side ignores an offer that collides with its own in-flight offer", async () => {
    // self = "b:d1", peer = "a:d1" -> self is impolite.
    const peerA: PeerKey = { userId: "a", deviceId: "d1" };
    const { deps, pcs, transport } = makeDeps({ selfUserId: "b", selfDeviceId: "d1", getInitialPeers: () => [peerA] });
    const engine = createVoiceEngine(deps);

    await joinAndConfirm(engine, deps, "guild-1", "channel-1");
    const pc = pcs[0]!;
    expect(pc.signalingState).toBe("have-local-offer");

    transport.emit(peerA, { kind: "description", description: { type: "offer", sdp: OPUS_SDP } });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(pc.remoteDescription).toBeNull(); // ignored, not applied
    expect(pc.answerCount).toBe(0);
  });
});

// ---- ICE restart ------------------------------------------------------------

describe("ICE restart", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("still renegotiates after restartIce(), even though onnegotiationneeded already fired once", async () => {
    // restartIce() fires a real onnegotiationneeded of its own, to ask
    // for a fresh offer with new ICE credentials. The fix above that
    // ignores a SECOND onnegotiationneeded firing (see the "ignores a
    // second onnegotiationneeded after a rollback" test) must not
    // also swallow this legitimate one, or a connection that actually
    // failed would never recover.
    // Only the impolite side drives ICE recovery (see handlePeerFailed
    // in engine.ts), so self must be impolite here: self = "b:d1",
    // peer = "a:d1" -> self is impolite (see comparePeerKeys).
    const peerA: PeerKey = { userId: "a", deviceId: "d1" };
    const { deps, pcs } = makeDeps({ selfUserId: "b", selfDeviceId: "d1", getInitialPeers: () => [peerA] });
    const engine = createVoiceEngine(deps);

    const joinPromise = engine.join("guild-1", "channel-1");
    await vi.advanceTimersByTimeAsync(JOIN_CONFIRM_TIMEOUT_MS + NEWCOMER_TRACK_SHARE_DELAY_MS);
    await joinPromise;
    const pc = pcs[0]!;
    expect(pc.offerCount).toBe(1); // our own initial offer, in flight

    // The peer's answer arrives, completing the first negotiation
    // (ICE can still fail independently of signaling once connected).
    pc.signalingState = "stable";
    pc.connectionState = "failed";
    pc.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(ICE_RESTART_BACKOFFS_MS[0]!);

    expect(pc.restartIceCalls).toBe(1);
    // The real browser fires onnegotiationneeded right after
    // restartIce(); the fake stands in for that here.
    pc.onnegotiationneeded?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(pc.offerCount).toBe(2); // the restart's own offer went out
  });
});

// ---- speaking hysteresis --------------------------------------------------------

describe("speaking hysteresis", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("turns on after one tick above threshold, and off only after 300ms continuously below", async () => {
    const { deps, audioContexts } = makeDeps();
    const engine = createVoiceEngine(deps);
    const speakingEvents: boolean[] = [];
    engine.on("localSpeaking", (speaking) => speakingEvents.push(speaking));

    const joinPromise = engine.join("guild-1", "channel-1");
    await vi.advanceTimersByTimeAsync(JOIN_CONFIRM_TIMEOUT_MS);
    await joinPromise;

    const analyser = audioContexts[0]!.lastAnalyser!;

    // Silent: no change.
    analyser.value = 0;
    await vi.advanceTimersByTimeAsync(SPEAKING_TICK_MS);
    expect(speakingEvents).toEqual([]);

    // One tick above threshold: speaking turns on immediately.
    analyser.value = SPEAKING_VOLUME_THRESHOLD + 50;
    await vi.advanceTimersByTimeAsync(SPEAKING_TICK_MS);
    expect(speakingEvents).toEqual([true]);

    // Drop below threshold: speaking must stay on until 300ms pass.
    analyser.value = 0;
    await vi.advanceTimersByTimeAsync(SPEAKING_TICK_MS);
    expect(speakingEvents).toEqual([true]); // 100ms below: still speaking
    await vi.advanceTimersByTimeAsync(SPEAKING_TICK_MS);
    expect(speakingEvents).toEqual([true]); // 200ms below: still speaking
    await vi.advanceTimersByTimeAsync(SPEAKING_TICK_MS);
    expect(speakingEvents).toEqual([true, false]); // 300ms below: turns off
    expect(SPEAKING_OFF_MS).toBe(300);
  });
});

// ---- leave() cleanup -------------------------------------------------------------

describe("leave()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops every track, closes every peer connection, closes the audio context and clears all timers", async () => {
    const peerB: PeerKey = { userId: "b", deviceId: "d1" };
    const { deps, pcs, streams, audioContexts } = makeDeps({ getInitialPeers: () => [peerB] });
    const engine = createVoiceEngine(deps);

    const joinPromise = engine.join("guild-1", "channel-1");
    // The confirm wait, then the newcomer's pause before moving on to
    // the next initial peer (there is only one here, but join() still
    // waits it out before resolving).
    await vi.advanceTimersByTimeAsync(JOIN_CONFIRM_TIMEOUT_MS + NEWCOMER_TRACK_SHARE_DELAY_MS);
    await joinPromise;

    expect(pcs).toHaveLength(1);
    expect(streams).toHaveLength(1);
    expect(vi.getTimerCount()).toBeGreaterThan(0); // the shared speaking timer is running

    await engine.leave();

    for (const stream of streams) {
      for (const track of stream.getTracks()) {
        expect(track.stopped).toBe(true);
      }
    }
    for (const pc of pcs) {
      expect(pc.closed).toBe(true);
    }
    for (const ctx of audioContexts) {
      expect(ctx.closed).toBe(true);
    }
    expect(vi.getTimerCount()).toBe(0);
    expect(deps.sendVoiceLeave).toHaveBeenCalledTimes(1);
  });

  it("is a safe no-op when not in a call", async () => {
    const { deps } = makeDeps();
    const engine = createVoiceEngine(deps);
    await engine.leave();
    expect(deps.sendVoiceLeave).not.toHaveBeenCalled();
  });
});

// ---- peer add/remove from onPeerVoiceState ---------------------------------------

describe("onPeerVoiceState", () => {
  it("prepares a connection for a later peer without offering, and removes a peer who leaves", async () => {
    const { deps, pcs } = makeDeps(); // no initial peers: we are already in the channel alone
    const engine = createVoiceEngine(deps);
    await joinAndConfirm(engine, deps, "guild-1", "channel-1");
    expect(pcs).toHaveLength(0);

    const laterPeer: VoiceStateJson = {
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "b",
      deviceId: "d1",
      selfMute: false,
      selfDeaf: false,
      selfVideo: false,
      selfStream: false,
      serverMute: false,
      serverDeaf: false,
      joinedAt: new Date().toISOString(),
    };
    engine.onPeerVoiceState(laterPeer);
    await Promise.resolve();
    await Promise.resolve();

    expect(pcs).toHaveLength(1);
    expect(pcs[0]!.offerCount).toBe(0); // we wait for their offer; we do not offer to a later joiner
    expect(engine.peers).toHaveLength(1);

    engine.onPeerVoiceState({ ...laterPeer, channelId: null });
    expect(engine.peers).toHaveLength(0);
    expect(pcs[0]!.closed).toBe(true);
  });

  it("cleans up locally when the server reports our own voice state left", async () => {
    const { deps } = makeDeps();
    const engine = createVoiceEngine(deps);
    await joinAndConfirm(engine, deps, "guild-1", "channel-1");

    engine.onPeerVoiceState({
      guildId: "guild-1",
      channelId: null,
      userId: "a",
      deviceId: "d1",
      selfMute: false,
      selfDeaf: false,
      selfVideo: false,
      selfStream: false,
      serverMute: false,
      serverDeaf: false,
      joinedAt: new Date().toISOString(),
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(deps.sendVoiceLeave).not.toHaveBeenCalled(); // local cleanup only, no extra VOICE_LEAVE
  });
});

// ---- camera --------------------------------------------------------------------

describe("setCamera", () => {
  it("adds one transceiver on the first toggle and reuses it on every later toggle", async () => {
    const { deps, pcs } = makeDeps();
    const engine = createVoiceEngine(deps);
    await joinAndConfirm(engine, deps, "guild-1", "channel-1");

    // A later peer, so a peer connection exists to hold the transceiver.
    engine.onPeerVoiceState({
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "b",
      deviceId: "d1",
      selfMute: false,
      selfDeaf: false,
      selfVideo: false,
      selfStream: false,
      serverMute: false,
      serverDeaf: false,
      joinedAt: new Date().toISOString(),
    });
    await Promise.resolve();
    await Promise.resolve();
    const pc = pcs[0]!;

    await engine.setCamera(true);
    await engine.setCamera(false);
    await engine.setCamera(true);

    const cameraTransceivers = pc.transceivers.filter((t) => t.sender.track?.kind === "video" || t.direction === "sendonly");
    expect(pc.transceivers).toHaveLength(1); // toggling 3 times never adds a second transceiver
    expect(pc.transceivers[0]!.sender.track).not.toBeNull(); // last toggle left the track attached
    expect(cameraTransceivers).toHaveLength(1);
    expect(deps.sendVoiceState).toHaveBeenCalledWith({ selfVideo: true });
  });

  it("sends selfVideo=false and stops the track when turned off", async () => {
    const { deps, streams } = makeDeps();
    const engine = createVoiceEngine(deps);
    await joinAndConfirm(engine, deps, "guild-1", "channel-1");

    await engine.setCamera(true);
    const cameraStream = streams.find((s) => s.getVideoTracks().length > 0)!;
    await engine.setCamera(false);

    expect(deps.sendVoiceState).toHaveBeenCalledWith({ selfVideo: false });
    expect(cameraStream.getVideoTracks()[0]!.stopped).toBe(true);
  });
});

// ---- screen share ----------------------------------------------------------------

describe("setScreenShare", () => {
  it("waits for the server's confirmation before it captures the screen", async () => {
    const { deps } = makeDeps();
    const getDisplayMedia = vi.fn(deps.getDisplayMedia);
    const engine = createVoiceEngine({ ...deps, getDisplayMedia });
    await joinAndConfirm(engine, deps, "guild-1", "channel-1");

    const sharePromise = engine.setScreenShare(true);
    await vi.waitFor(() => expect(deps.sendVoiceState).toHaveBeenCalledWith({ selfStream: true }));
    expect(getDisplayMedia).not.toHaveBeenCalled(); // no capture before the server confirms

    engine.onPeerVoiceState({
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "a",
      deviceId: "d1",
      selfMute: false,
      selfDeaf: false,
      selfVideo: false,
      selfStream: true,
      serverMute: false,
      serverDeaf: false,
      joinedAt: new Date().toISOString(),
    });
    await sharePromise;

    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    expect(engine.screenOn).toBe(true);
  });

  it("does not capture the screen on STREAM_IN_USE", async () => {
    const { deps } = makeDeps();
    const getDisplayMedia = vi.fn(deps.getDisplayMedia);
    const engine = createVoiceEngine({ ...deps, getDisplayMedia });
    const errors: string[] = [];
    engine.on("error", (e) => errors.push(e.kind));
    await joinAndConfirm(engine, deps, "guild-1", "channel-1");

    const sharePromise = engine.setScreenShare(true);
    await vi.waitFor(() => expect(deps.sendVoiceState).toHaveBeenCalledWith({ selfStream: true }));
    engine.handleVoiceError({ code: "STREAM_IN_USE", message: "Someone else is already sharing." });
    await sharePromise;

    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(engine.screenOn).toBe(false);
    expect(errors).toContain("voice-error");
  });

  it("turns selfStream off when the browser's own Stop sharing control ends the track", async () => {
    const { deps, streams } = makeDeps();
    const engine = createVoiceEngine(deps);
    await joinAndConfirm(engine, deps, "guild-1", "channel-1");

    const sharePromise = engine.setScreenShare(true);
    await vi.waitFor(() => expect(deps.sendVoiceState).toHaveBeenCalledWith({ selfStream: true }));
    engine.onPeerVoiceState({
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "a",
      deviceId: "d1",
      selfMute: false,
      selfDeaf: false,
      selfVideo: false,
      selfStream: true,
      serverMute: false,
      serverDeaf: false,
      joinedAt: new Date().toISOString(),
    });
    await sharePromise;
    expect(engine.screenOn).toBe(true);

    const screenStream = streams.find((s) => s.getVideoTracks().length > 0 && s.getAudioTracks().length > 0)!;
    const videoTrack = screenStream.getVideoTracks()[0]! as unknown as { onended: (() => void) | null };
    videoTrack.onended!();
    await vi.waitFor(() => expect(deps.sendVoiceState).toHaveBeenCalledWith({ selfStream: false }));
    expect(engine.screenOn).toBe(false);
  });

  it("rolls back selfStream when the browser denies screen capture", async () => {
    const { deps } = makeDeps({
      getDisplayMedia: async () => {
        throw new Error("denied");
      },
    });
    const engine = createVoiceEngine(deps);
    const errors: string[] = [];
    engine.on("error", (e) => errors.push(e.kind));
    await joinAndConfirm(engine, deps, "guild-1", "channel-1");

    const sharePromise = engine.setScreenShare(true);
    await vi.waitFor(() => expect(deps.sendVoiceState).toHaveBeenCalledWith({ selfStream: true }));
    engine.onPeerVoiceState({
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "a",
      deviceId: "d1",
      selfMute: false,
      selfDeaf: false,
      selfVideo: false,
      selfStream: true,
      serverMute: false,
      serverDeaf: false,
      joinedAt: new Date().toISOString(),
    });
    await sharePromise;

    expect(deps.sendVoiceState).toHaveBeenCalledWith({ selfStream: false });
    expect(engine.screenOn).toBe(false);
    expect(errors).toContain("screen-permission-denied");
  });
});

// ---- remote camera/screen identification ------------------------------------------

describe("remote media identification", () => {
  it("matches ontrack to the media signal when the signal arrives first", async () => {
    const peerB: PeerKey = { userId: "b", deviceId: "d1" };
    const { deps, pcs, transport } = makeDeps({ getInitialPeers: () => [peerB] });
    const engine = createVoiceEngine(deps);
    await joinAndConfirm(engine, deps, "guild-1", "channel-1");
    const pc = pcs[0]!;

    transport.emit(peerB, { kind: "media", streams: { camera: "remote-cam-1" } });
    expect(engine.peers[0]!.cameraStream).toBeNull(); // no track yet

    const remoteStream = new FakeMediaStream([new FakeTrack("video")], "remote-cam-1");
    pc.ontrack!({ track: remoteStream.getVideoTracks()[0]!, streams: [remoteStream] });

    expect(engine.peers[0]!.cameraStream).not.toBeNull();
  });

  it("matches ontrack to the media signal when the track arrives first", async () => {
    const peerB: PeerKey = { userId: "b", deviceId: "d1" };
    const { deps, pcs, transport } = makeDeps({ getInitialPeers: () => [peerB] });
    const engine = createVoiceEngine(deps);
    await joinAndConfirm(engine, deps, "guild-1", "channel-1");
    const pc = pcs[0]!;

    const remoteStream = new FakeMediaStream([new FakeTrack("video")], "remote-screen-1");
    pc.ontrack!({ track: remoteStream.getVideoTracks()[0]!, streams: [remoteStream] });
    expect(engine.peers[0]!.screenStream).toBeNull(); // no signal yet, held pending

    transport.emit(peerB, { kind: "media", streams: { screen: "remote-screen-1" } });

    expect(engine.peers[0]!.screenStream).not.toBeNull();
  });

  it("clears the remote camera stream once the media signal reports it off", async () => {
    const peerB: PeerKey = { userId: "b", deviceId: "d1" };
    const { deps, pcs, transport } = makeDeps({ getInitialPeers: () => [peerB] });
    const engine = createVoiceEngine(deps);
    await joinAndConfirm(engine, deps, "guild-1", "channel-1");
    const pc = pcs[0]!;

    transport.emit(peerB, { kind: "media", streams: { camera: "remote-cam-2" } });
    const remoteStream = new FakeMediaStream([new FakeTrack("video")], "remote-cam-2");
    pc.ontrack!({ track: remoteStream.getVideoTracks()[0]!, streams: [remoteStream] });
    expect(engine.peers[0]!.cameraStream).not.toBeNull();

    transport.emit(peerB, { kind: "media", streams: {} });
    expect(engine.peers[0]!.cameraStream).toBeNull();
  });
});

// ---- leave() stops video tracks too ------------------------------------------------

describe("leave() with camera and screen on", () => {
  it("stops the camera and screen tracks", async () => {
    const { deps, streams } = makeDeps();
    const engine = createVoiceEngine(deps);
    await joinAndConfirm(engine, deps, "guild-1", "channel-1");

    await engine.setCamera(true);
    const sharePromise = engine.setScreenShare(true);
    await vi.waitFor(() => expect(deps.sendVoiceState).toHaveBeenCalledWith({ selfStream: true }));
    engine.onPeerVoiceState({
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "a",
      deviceId: "d1",
      selfMute: false,
      selfDeaf: false,
      selfVideo: true,
      selfStream: true,
      serverMute: false,
      serverDeaf: false,
      joinedAt: new Date().toISOString(),
    });
    await sharePromise;

    await engine.leave();

    for (const stream of streams) {
      for (const track of stream.getTracks()) {
        expect(track.stopped).toBe(true);
      }
    }
    expect(engine.cameraOn).toBe(false);
    expect(engine.screenOn).toBe(false);
  });
});

// ---- adaptive video quality applier ------------------------------------------------

describe("adaptive quality applier", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not run the stats timer while no local video track is live", async () => {
    const peerB: PeerKey = { userId: "b", deviceId: "d1" };
    const { deps, pcs } = makeDeps({ getInitialPeers: () => [peerB] });
    const engine = createVoiceEngine(deps);
    const joinPromise = engine.join("guild-1", "channel-1");
    await vi.advanceTimersByTimeAsync(JOIN_CONFIRM_TIMEOUT_MS + NEWCOMER_TRACK_SHARE_DELAY_MS);
    await joinPromise;

    await vi.advanceTimersByTimeAsync(ADAPTIVE_TICK_MS * 3);

    expect(pcs[0]!.getStatsCallCount).toBe(0);
  });

  it("starts the timer once the camera turns on, and stops it once the last video track turns off", async () => {
    const peerB: PeerKey = { userId: "b", deviceId: "d1" };
    const { deps, pcs } = makeDeps({ getInitialPeers: () => [peerB] });
    const engine = createVoiceEngine(deps);
    const joinPromise = engine.join("guild-1", "channel-1");
    await vi.advanceTimersByTimeAsync(JOIN_CONFIRM_TIMEOUT_MS + NEWCOMER_TRACK_SHARE_DELAY_MS);
    await joinPromise;
    const pc = pcs[0]!;

    await engine.setCamera(true);
    await vi.advanceTimersByTimeAsync(ADAPTIVE_TICK_MS);
    expect(pc.getStatsCallCount).toBeGreaterThan(0);

    const countWhileOn = pc.getStatsCallCount;
    await engine.setCamera(false);
    await vi.advanceTimersByTimeAsync(ADAPTIVE_TICK_MS * 3);
    expect(pc.getStatsCallCount).toBe(countWhileOn); // the timer stopped, not just idling
  });

  it("stops the timer on leave", async () => {
    const peerB: PeerKey = { userId: "b", deviceId: "d1" };
    const { deps, pcs } = makeDeps({ getInitialPeers: () => [peerB] });
    const engine = createVoiceEngine(deps);
    const joinPromise = engine.join("guild-1", "channel-1");
    await vi.advanceTimersByTimeAsync(JOIN_CONFIRM_TIMEOUT_MS + NEWCOMER_TRACK_SHARE_DELAY_MS);
    await joinPromise;
    const pc = pcs[0]!;

    await engine.setCamera(true);
    await vi.advanceTimersByTimeAsync(ADAPTIVE_TICK_MS);
    await engine.leave();

    const countAfterLeave = pc.getStatsCallCount;
    await vi.advanceTimersByTimeAsync(ADAPTIVE_TICK_MS * 3);
    expect(pc.getStatsCallCount).toBe(countAfterLeave);
  });

  it("does not call setParameters again when the chosen encoding has not changed", async () => {
    const peerB: PeerKey = { userId: "b", deviceId: "d1" };
    const { deps, pcs } = makeDeps({ getInitialPeers: () => [peerB] });
    const engine = createVoiceEngine(deps);
    const joinPromise = engine.join("guild-1", "channel-1");
    await vi.advanceTimersByTimeAsync(JOIN_CONFIRM_TIMEOUT_MS + NEWCOMER_TRACK_SHARE_DELAY_MS);
    await joinPromise;
    const pc = pcs[0]!;

    await engine.setCamera(true);
    await vi.advanceTimersByTimeAsync(ADAPTIVE_TICK_MS);
    const sender = pc.transceivers[0]!.sender;
    expect(sender.setParametersCalls).toHaveLength(1);

    // Steady state: same peer count, same (empty) stats every tick.
    await vi.advanceTimersByTimeAsync(ADAPTIVE_TICK_MS * 3);
    expect(sender.setParametersCalls).toHaveLength(1);
  });

  it("re-applies exactly once when the remote peer count crosses into a worse camera tier", async () => {
    const peerB: PeerKey = { userId: "b", deviceId: "d1" };
    const { deps, pcs } = makeDeps({ getInitialPeers: () => [peerB] });
    const engine = createVoiceEngine(deps);
    const joinPromise = engine.join("guild-1", "channel-1");
    await vi.advanceTimersByTimeAsync(JOIN_CONFIRM_TIMEOUT_MS + NEWCOMER_TRACK_SHARE_DELAY_MS);
    await joinPromise;
    const pc = pcs[0]!;

    await engine.setCamera(true);
    await vi.advanceTimersByTimeAsync(ADAPTIVE_TICK_MS);
    const sender = pc.transceivers[0]!.sender;
    expect(sender.setParametersCalls).toHaveLength(1); // tier 0: 1 remote peer

    // A second remote peer: still 1-2 peers, tier 0, no change.
    engine.onPeerVoiceState({
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "c",
      deviceId: "d1",
      selfMute: false,
      selfDeaf: false,
      selfVideo: false,
      selfStream: false,
      serverMute: false,
      serverDeaf: false,
      joinedAt: new Date().toISOString(),
    });
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(ADAPTIVE_TICK_MS);
    expect(sender.setParametersCalls).toHaveLength(1);

    // A third remote peer crosses into the 3-4 peer tier: exactly one more apply.
    engine.onPeerVoiceState({
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "e",
      deviceId: "d1",
      selfMute: false,
      selfDeaf: false,
      selfVideo: false,
      selfStream: false,
      serverMute: false,
      serverDeaf: false,
      joinedAt: new Date().toISOString(),
    });
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(ADAPTIVE_TICK_MS);
    expect(sender.setParametersCalls).toHaveLength(2);

    // Steady state again: no further calls.
    await vi.advanceTimersByTimeAsync(ADAPTIVE_TICK_MS * 3);
    expect(sender.setParametersCalls).toHaveLength(2);
  });

  it("caps the audio sender at the bitrate from the server, or at the default without one", async () => {
    for (const [audioBitrateBps, expected] of [
      [128_000, 128_000],
      [undefined, DEFAULT_AUDIO_BITRATE_BPS],
    ] as const) {
      const peerB: PeerKey = { userId: "b", deviceId: "d1" };
      const { deps, pcs } = makeDeps({
        getInitialPeers: () => [peerB],
        getTurnCredentials: async () => ({ iceServers: [], ttlSeconds: 3600, audioBitrateBps }),
      });
      const engine = createVoiceEngine(deps);
      const joinPromise = engine.join("guild-1", "channel-1");
      await vi.advanceTimersByTimeAsync(JOIN_CONFIRM_TIMEOUT_MS + NEWCOMER_TRACK_SHARE_DELAY_MS);
      await joinPromise;
      const audioSender = pcs[0]!.senders.find((s) => s.track?.kind === "audio")!;
      await Promise.resolve();
      const capCall = audioSender.setParametersCalls.find((p) => p.encodings?.[0]?.maxBitrate !== undefined);
      expect(capCall?.encodings[0]!.maxBitrate).toBe(expected);
      await engine.leave();
    }
  });

  it("sets the audio sender to high priority once, unaffected by later ticks", async () => {
    const peerB: PeerKey = { userId: "b", deviceId: "d1" };
    const { deps, pcs } = makeDeps({ getInitialPeers: () => [peerB] });
    const engine = createVoiceEngine(deps);
    const joinPromise = engine.join("guild-1", "channel-1");
    await vi.advanceTimersByTimeAsync(JOIN_CONFIRM_TIMEOUT_MS + NEWCOMER_TRACK_SHARE_DELAY_MS);
    await joinPromise;
    const pc = pcs[0]!;
    const audioSender = pc.senders.find((s) => s.track?.kind === "audio")!;
    await Promise.resolve();
    await Promise.resolve();

    const priorityCall = audioSender.setParametersCalls.find(
      (p) => (p as unknown as { priority?: string }).priority === "high",
    );
    expect(priorityCall).toBeDefined();
    const callsBeforeVideo = audioSender.setParametersCalls.length;

    await engine.setCamera(true);
    await vi.advanceTimersByTimeAsync(ADAPTIVE_TICK_MS * 3);

    expect(audioSender.setParametersCalls).toHaveLength(callsBeforeVideo); // the adaptive tick never touches the audio sender
  });

  it("reads qualityLimitationReason from getStats() and steps the tier down after 2 limited samples", async () => {
    const peerB: PeerKey = { userId: "b", deviceId: "d1" };
    const { deps, pcs } = makeDeps({ getInitialPeers: () => [peerB] });
    const engine = createVoiceEngine(deps);
    const joinPromise = engine.join("guild-1", "channel-1");
    await vi.advanceTimersByTimeAsync(JOIN_CONFIRM_TIMEOUT_MS + NEWCOMER_TRACK_SHARE_DELAY_MS);
    await joinPromise;
    const pc = pcs[0]!;

    await engine.setCamera(true);
    const transceiver = pc.transceivers[0]!;
    pc.statsReport = fakeStatsReport({ video: [{ mid: transceiver.mid!, qualityLimitationReason: "bandwidth" }] });

    await vi.advanceTimersByTimeAsync(ADAPTIVE_TICK_MS); // 1st limited sample: no step down yet
    let lastParams = transceiver.sender.setParametersCalls.at(-1)!;
    expect((lastParams.encodings![0] as RTCRtpEncodingParameters).scaleResolutionDownBy).toBeCloseTo(1); // still tier 0 (720p)

    await vi.advanceTimersByTimeAsync(ADAPTIVE_TICK_MS); // 2nd consecutive limited sample: steps down to tier 1 (540p)
    lastParams = transceiver.sender.setParametersCalls.at(-1)!;
    expect((lastParams.encodings![0] as RTCRtpEncodingParameters).maxFramerate).toBe(30);
    expect((lastParams.encodings![0] as RTCRtpEncodingParameters).maxBitrate).toBe(800_000);
    expect((lastParams.encodings![0] as RTCRtpEncodingParameters).scaleResolutionDownBy).toBeCloseTo(720 / 540);
  });
});

// ---- the mic gate and the order of track events ---------------------------------

/** A `getUserMedia` whose calls resolve only when the test says so, in any order. */
function deferredGetUserMedia(): {
  getUserMedia: VoiceEngineDeps["getUserMedia"];
  pending: Array<{ stream: FakeMediaStream; resolve: () => void }>;
} {
  const pending: Array<{ stream: FakeMediaStream; resolve: () => void }> = [];
  const getUserMedia = () =>
    new Promise<MediaStream>((resolve) => {
      const stream = new FakeMediaStream([new FakeTrack("audio")]);
      pending.push({ stream, resolve: () => resolve(stream as unknown as MediaStream) });
    });
  return { getUserMedia, pending };
}

describe("the mic gate", () => {
  it("applies a mute set before join to the new track, and sends it with VOICE_JOIN only", async () => {
    // Push to talk mutes before the join, so the mic is never open while
    // the call connects. A VOICE_STATE before VOICE_JOIN is not valid.
    const { deps, streams } = makeDeps();
    const engine = createVoiceEngine(deps);
    engine.setMute(true);
    expect(deps.sendVoiceState).not.toHaveBeenCalled();

    await joinAndConfirm(engine, deps, "guild-1", "channel-1");

    expect(deps.sendVoiceJoin).toHaveBeenCalledWith("channel-1", true, false);
    expect(streams[0]!.getAudioTracks()[0]!.enabled).toBe(false);
    expect(engine.isLocalTrackEnabled()).toBe(false);
  });

  it("stops the new track and does not join when leave() runs while the mic is requested", async () => {
    const gum = deferredGetUserMedia();
    const { deps } = makeDeps({ getUserMedia: gum.getUserMedia });
    const engine = createVoiceEngine(deps);

    const joinPromise = engine.join("guild-1", "channel-1");
    await vi.waitFor(() => expect(gum.pending).toHaveLength(1));
    await engine.leave();
    gum.pending[0]!.resolve();
    await joinPromise;

    expect(gum.pending[0]!.stream.getAudioTracks()[0]!.stopped).toBe(true);
    expect(deps.sendVoiceJoin).not.toHaveBeenCalled();
    expect(engine.channelId).toBeNull();
    expect(engine.isLocalTrackEnabled()).toBeNull();
  });

  it("keeps the newest input device when two device changes finish out of order", async () => {
    const { deps, streams } = makeDeps();
    const engine = createVoiceEngine(deps);
    await joinAndConfirm(engine, deps, "guild-1", "channel-1");
    engine.setMute(true);

    const gum = deferredGetUserMedia();
    deps.getUserMedia = gum.getUserMedia;
    engine.setInputDevice("mic-old");
    engine.setInputDevice("mic-new");
    await vi.waitFor(() => expect(gum.pending).toHaveLength(2));
    gum.pending[1]!.resolve();
    await vi.waitFor(() => expect(streams[0]!.getAudioTracks()[0]!.stopped).toBe(true));
    gum.pending[0]!.resolve();
    await vi.waitFor(() => expect(gum.pending[0]!.stream.getAudioTracks()[0]!.stopped).toBe(true));

    const newest = gum.pending[1]!.stream.getAudioTracks()[0]!;
    expect(newest.stopped).toBe(false);
    expect(newest.enabled).toBe(false); // The mute (the push-to-talk gate) holds on the new track.
    expect(engine.isLocalTrackEnabled()).toBe(false);
  });

  it("stops a device change track that arrives after leave()", async () => {
    const { deps } = makeDeps();
    const engine = createVoiceEngine(deps);
    await joinAndConfirm(engine, deps, "guild-1", "channel-1");

    const gum = deferredGetUserMedia();
    deps.getUserMedia = gum.getUserMedia;
    engine.setInputDevice("mic-2");
    await vi.waitFor(() => expect(gum.pending).toHaveLength(1));
    await engine.leave();
    gum.pending[0]!.resolve();
    await vi.waitFor(() => expect(gum.pending[0]!.stream.getAudioTracks()[0]!.stopped).toBe(true));
    expect(engine.isLocalTrackEnabled()).toBeNull();
  });
});
