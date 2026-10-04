// The host of this web build: a browser tab (the default), or the desktop
// app. `main.tsx` checks for the desktop app before the app renders, and
// loads its platform with a dynamic import, so the web bundle does not
// grow. Every module reads the platform through this file.
import { webPlatform, type Platform } from "@mortium/client-core";

/** Services that only the desktop app has. */
export interface DesktopFeatures {
  os: "windows" | "macos" | "linux";
  /** A reason in plain words when this app cannot share a screen, or null. */
  screenShareUnavailableReason: string | null;
  /** The text under the push-to-talk key in the voice settings. */
  pushToTalkHint: string;
  /**
   * Register a global shortcut, such as "Control+Shift+KeyT", for push to
   * talk. It works while the app window has no focus. Returns a function
   * that removes the shortcut. Throws when the system refuses the shortcut.
   */
  registerPushToTalk(shortcut: string, onChange: (pressed: boolean) => void): Promise<() => void>;
  /** Open a web page in the system browser. */
  openExternal(url: string): Promise<void>;
}

let current: Platform = webPlatform;
let desktop: DesktopFeatures | null = null;

/** Use the desktop platform. Call this only at start, before the app renders. */
export function installDesktopPlatform(platform: Platform, features: DesktopFeatures): void {
  current = platform;
  desktop = features;
}

/** The platform of this host. */
export function currentPlatform(): Platform {
  return current;
}

/** The desktop services, or null in a browser. */
export function desktopFeatures(): DesktopFeatures | null {
  return desktop;
}

/**
 * A platform for the session store. The store is made when its module
 * loads, before the start code knows the host. So each call goes to the
 * platform of that moment.
 */
export const sessionPlatform: Platform = {
  secureStore: {
    get: (key) => current.secureStore.get(key),
    set: (key, value) => current.secureStore.set(key, value),
    delete: (key) => current.secureStore.delete(key),
  },
};
