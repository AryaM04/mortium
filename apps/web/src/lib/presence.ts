// The status menu's own state, plus auto-idle: after 10 minutes with no
// input while the chosen status is Online, switch to Idle; any input
// switches back. One listener set and one timeout at a time, no polling.
import { createStore } from "zustand/vanilla";
import type { PresenceStatus } from "@mortium/shared";
import { setPresence } from "./realtime.js";

const IDLE_AFTER_MS = 10 * 60_000;

export interface PresenceUiState {
  chosenStatus: PresenceStatus;
}

export const presenceUiStore = createStore<PresenceUiState>(() => ({ chosenStatus: "online" }));

let autoIdle = false;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let listening = false;

function clearIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function scheduleIdleTimer(): void {
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    autoIdle = true;
    setPresence("idle");
  }, IDLE_AFTER_MS);
}

function onActivity(): void {
  if (presenceUiStore.getState().chosenStatus !== "online") {
    return;
  }
  if (autoIdle) {
    autoIdle = false;
    setPresence("online");
  }
  scheduleIdleTimer();
}

/** Call once, when the app starts. Safe to call more than once. */
export function startAutoIdle(): void {
  if (listening) {
    return;
  }
  listening = true;
  window.addEventListener("mousemove", onActivity, { passive: true });
  window.addEventListener("keydown", onActivity, { passive: true });
  if (presenceUiStore.getState().chosenStatus === "online") {
    scheduleIdleTimer();
  }
}

/** Called from the status menu: Online, Idle, Do not disturb, Invisible. */
export function chooseStatus(status: PresenceStatus): void {
  autoIdle = false;
  presenceUiStore.setState({ chosenStatus: status });
  setPresence(status);
  if (status === "online") {
    scheduleIdleTimer();
  } else {
    clearIdleTimer();
  }
}
