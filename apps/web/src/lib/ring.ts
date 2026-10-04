// Incoming DM calls for this tab: the calls that show a ringing card, the
// local "Decline", and a short ring sound. The sound is made with Web
// Audio (no audio file). It plays only while a card shows and the "Play
// ring sound" setting is on. The audio context closes when the ring stops.
import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { playRingSoundOf } from "@mortium/client-core";
import { realtimeStore } from "./realtime.js";
import { settingsStore } from "./settings.js";
import { voiceStore } from "./voice.js";

const RING_INTERVAL_MS = 2_000;

interface DeclinedCallsState {
  /** Rings that the user declined on this tab, by DM channel id. */
  declined: Record<string, true>;
}

const declinedStore = createStore<DeclinedCallsState>(() => ({ declined: {} }));

/** Hide the ringing card on this tab. The call goes on for the other people. */
export function declineCall(channelId: string): void {
  declinedStore.setState({ declined: { ...declinedStore.getState().declined, [channelId]: true } });
}

export interface IncomingCall {
  channelId: string;
  userId: string;
}

// A stable empty list, so the React hook does not render again for no change.
const NO_CALLS: IncomingCall[] = [];
let lastCalls: IncomingCall[] = NO_CALLS;

/** The rings that show a card: not declined, and not the call that this tab is in. */
function currentCalls(): IncomingCall[] {
  const { incomingCalls } = realtimeStore.getState();
  const { declined } = declinedStore.getState();
  const voice = voiceStore.getState();
  const inCall = voice.status === "idle" ? null : voice.channelId;
  const calls = Object.values(incomingCalls).filter((call) => !declined[call.channelId] && call.channelId !== inCall);
  if (calls.length === lastCalls.length && calls.every((call, index) => call === lastCalls[index])) {
    return lastCalls;
  }
  lastCalls = calls.length === 0 ? NO_CALLS : calls;
  return lastCalls;
}

export function useIncomingCalls(): IncomingCall[] {
  // Each store change can change the list, so read the list again on each of them.
  useStore(realtimeStore, (s) => s.incomingCalls);
  useStore(declinedStore, (s) => s.declined);
  useStore(voiceStore, (s) => (s.status === "idle" ? null : s.channelId));
  return currentCalls();
}

// ---- the ring sound -------------------------------------------------------------

let audioContext: AudioContext | null = null;
let ringTimer: ReturnType<typeof setInterval> | null = null;

/** Two short tones, with a soft start and end so they do not click. */
function playTones(context: AudioContext): void {
  const start = context.currentTime;
  [660, 880].forEach((frequency, index) => {
    const at = start + index * 0.2;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.15, at + 0.02);
    gain.gain.linearRampToValueAtTime(0, at + 0.18);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(at);
    oscillator.stop(at + 0.2);
  });
}

function startRing(): void {
  if (ringTimer || typeof AudioContext === "undefined") {
    return;
  }
  const context = new AudioContext();
  audioContext = context;
  // The browser can keep the context suspended until the user clicks the page. Then the ring is silent.
  void context.resume().catch(() => undefined);
  playTones(context);
  ringTimer = setInterval(() => playTones(context), RING_INTERVAL_MS);
}

function stopRing(): void {
  if (ringTimer) {
    clearInterval(ringTimer);
    ringTimer = null;
  }
  if (audioContext) {
    void audioContext.close().catch(() => undefined);
    audioContext = null;
  }
}

/** True while the ring sound plays. For tests and diagnostics. */
export function isRinging(): boolean {
  return ringTimer !== null;
}

function updateRing(): void {
  const ring = currentCalls().length > 0 && playRingSoundOf(settingsStore.getState().values);
  if (ring) {
    startRing();
  } else {
    stopRing();
  }
}

realtimeStore.subscribe((state, previous) => {
  if (state.incomingCalls === previous.incomingCalls) {
    return;
  }
  // A ring that stopped can ring again later. Forget a decline for it.
  const { declined } = declinedStore.getState();
  const kept = Object.fromEntries(Object.keys(declined).filter((id) => id in state.incomingCalls).map((id) => [id, true]));
  if (Object.keys(kept).length !== Object.keys(declined).length) {
    declinedStore.setState({ declined: kept as Record<string, true> });
  }
  updateRing();
});
declinedStore.subscribe(updateRing);
voiceStore.subscribe((state, previous) => {
  if (state.status !== previous.status || state.channelId !== previous.channelId) {
    updateRing();
  }
});
settingsStore.subscribe((state, previous) => {
  if (state.values !== previous.values) {
    updateRing();
  }
});
