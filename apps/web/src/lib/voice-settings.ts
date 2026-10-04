// Persisted voice and video settings: chosen devices, input mode, the
// push-to-talk key, and per-user volume/local-mute. Kept in localStorage,
// read on the next join and applied live during a call. Every read and
// write is wrapped in try/catch: localStorage can throw (private
// browsing, storage full, disabled), and a setting is never worth a crash.
import { createStore } from "zustand/vanilla";

export type VoiceInputMode = "voice-activity" | "push-to-talk";

export interface VoiceDeviceSettings {
  inputDeviceId: string | null;
  outputDeviceId: string | null;
  cameraDeviceId: string | null;
  inputMode: VoiceInputMode;
  /** A `KeyboardEvent.code` value, such as "Backquote", or null when never set. */
  pttKeyCode: string | null;
}

const DEVICE_KEY = "mortium:voice-devices";
const PER_USER_KEY = "mortium:voice-per-user";

function defaultDeviceSettings(): VoiceDeviceSettings {
  return {
    inputDeviceId: null,
    outputDeviceId: null,
    cameraDeviceId: null,
    inputMode: "voice-activity",
    pttKeyCode: null,
  };
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable or full: the setting just does not persist.
  }
}

export const voiceDeviceSettingsStore = createStore<VoiceDeviceSettings>(() => ({
  ...defaultDeviceSettings(),
  ...readJson<Partial<VoiceDeviceSettings>>(DEVICE_KEY),
}));

export function updateVoiceDeviceSettings(patch: Partial<VoiceDeviceSettings>): void {
  const next = { ...voiceDeviceSettingsStore.getState(), ...patch };
  voiceDeviceSettingsStore.setState(next);
  writeJson(DEVICE_KEY, next);
}

/** Per-user local settings: a volume multiplier (0 to 2) and whether the user is muted for this listener only. Never applies to the self user. */
export interface PerUserVoiceSetting {
  volume: number;
  mutedForMe: boolean;
}

function defaultPerUserSetting(): PerUserVoiceSetting {
  return { volume: 1, mutedForMe: false };
}

interface PerUserVoiceState {
  byUserId: Record<string, PerUserVoiceSetting>;
}

export const perUserVoiceStore = createStore<PerUserVoiceState>(() => ({
  byUserId: readJson<Record<string, PerUserVoiceSetting>>(PER_USER_KEY) ?? {},
}));

export function getPerUserVoiceSetting(userId: string): PerUserVoiceSetting {
  return perUserVoiceStore.getState().byUserId[userId] ?? defaultPerUserSetting();
}

/** The volume to hand the engine's `setUserVolume`: 0 when locally muted, otherwise the stored percentage as a 0-2 multiplier. */
export function effectiveVolumeFor(userId: string): number {
  const setting = getPerUserVoiceSetting(userId);
  return setting.mutedForMe ? 0 : setting.volume;
}

function setPerUserSetting(userId: string, patch: Partial<PerUserVoiceSetting>): PerUserVoiceSetting {
  const current = getPerUserVoiceSetting(userId);
  const next = { ...current, ...patch };
  const byUserId = { ...perUserVoiceStore.getState().byUserId, [userId]: next };
  perUserVoiceStore.setState({ byUserId });
  writeJson(PER_USER_KEY, byUserId);
  return next;
}

/** Sets a user's volume, 0 to 2 (0% to 200%). Clamped. Applies at once with `apply`, typically `engine.setUserVolume`. */
export function setUserVolumeSetting(userId: string, volume: number, apply: (userId: string, volume: number) => void): void {
  const clamped = Math.min(2, Math.max(0, volume));
  const setting = setPerUserSetting(userId, { volume: clamped });
  apply(userId, setting.mutedForMe ? 0 : clamped);
}

/** Toggles "mute for me". Applies at once with `apply`, typically `engine.setUserVolume`. */
export function toggleMutedForMe(userId: string, apply: (userId: string, volume: number) => void): void {
  const current = getPerUserVoiceSetting(userId);
  const setting = setPerUserSetting(userId, { mutedForMe: !current.mutedForMe });
  apply(userId, setting.mutedForMe ? 0 : setting.volume);
}
