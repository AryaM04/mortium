// The one synced settings store for this tab. It reads the settings after
// each READY and again when another session announces a new version. It
// forgets everything on sign-out. The blob is encrypted with the settings
// key of the user, so the settings wait for the crypto layer.
import { useStore } from "zustand";
import { createSettingsStore, type SettingsCipher, type SettingsStore } from "@mortium/client-core";
import type { CryptoClient } from "@mortium/client-core/crypto-client";
import { cryptoReady } from "./messages.js";
import { session } from "./session.js";
import { realtimeStore } from "./realtime.js";

const keyListeners = new Set<() => void>();
let watched: CryptoClient | null = null;

/** Get the crypto layer, and forward its key arrivals to the store one time for each handle. */
async function settingsCrypto(): Promise<CryptoClient> {
  const handle = await cryptoReady();
  if (watched !== handle) {
    watched = handle;
    handle.settings.onKey(() => keyListeners.forEach((listener) => listener()));
  }
  return handle;
}

const cipher: SettingsCipher = {
  async open(blob) {
    const handle = await settingsCrypto();
    try {
      return await handle.settings.open(blob);
    } catch (error) {
      if (error instanceof Error && error.name === "SettingsKeyMissingError") {
        return "locked";
      }
      throw error;
    }
  },
  seal: async (plaintext, keyId) => (await settingsCrypto()).settings.seal(plaintext, keyId),
  onKey(listener) {
    keyListeners.add(listener);
    return () => keyListeners.delete(listener);
  },
};

export const settingsStore = createSettingsStore(session.apiClient, cipher);

export function useSettings<T>(selector: (state: SettingsStore) => T): T {
  return useStore(settingsStore, selector);
}

function loadSettings(): void {
  settingsStore
    .getState()
    .load()
    .catch((error: unknown) => {
      console.warn("The synced settings did not load.", error);
    });
}

realtimeStore.subscribe((state, previous) => {
  if (state.sessionId !== previous.sessionId) {
    if (state.sessionId === null) {
      settingsStore.getState().reset();
    } else {
      loadSettings();
    }
  }
  if (state.remoteSettingsVersion !== null && state.remoteSettingsVersion !== previous.remoteSettingsVersion) {
    settingsStore
      .getState()
      .applyRemoteVersion(state.remoteSettingsVersion)
      .catch((error: unknown) => {
        console.warn("The new synced settings did not load.", error);
      });
  }
});
