// The contract between the web build and a desktop shell. The web app
// (apps/web/src/desktop) talks to the shell only through a `DesktopBridge`.
// The Tauri app (Windows, macOS) supplies it with Tauri commands. The
// Electron app (Linux, apps/desktop-electron) supplies it through its
// preload script. This file has types only, so it adds no code to a bundle.

export type DesktopOs = "windows" | "macos" | "linux";

/** The start data of the desktop app. */
export interface DesktopInit {
  os: DesktopOs;
  version: string;
  /** The server origin that the user chose, or null before the first choice. */
  serverUrl: string | null;
  /** The deep links that started the app, such as "mortium://invite/abc". */
  deepLinks: string[];
  /** A reason in plain words when the app cannot keep secrets safely, or null. The app then does not start. */
  secureStoreUnavailableReason?: string | null;
  /** A reason in plain words when a global push-to-talk key is not possible, or null. */
  pushToTalkUnavailableReason?: string | null;
}

export interface DesktopUpdateInfo {
  version: string;
  notes: string | null;
}

/** A link preview that the desktop app made. The same shape as `LinkPreviewData` in client-core. */
export interface DesktopLinkPreview {
  url: string;
  title?: string;
  description?: string;
  siteName?: string;
  image?: { bytes: Uint8Array; mime: string };
}

/** The events that the desktop shell sends to the web app. */
export interface DesktopEvents {
  "deep-link": string[];
  "push-to-talk": boolean;
  "tray-action": "mute" | "deafen";
}

export type DesktopEventName = keyof DesktopEvents;

/** The services of a desktop shell. Each function rejects with an Error that has a plain message. */
export interface DesktopBridge {
  init(): Promise<DesktopInit>;
  secureGet(key: string): Promise<string | null>;
  secureSet(key: string, value: string): Promise<void>;
  secureDelete(key: string): Promise<void>;
  /** Check that a server answers and allows this app (CORS). Returns the server origin. */
  checkServer(url: string): Promise<string>;
  /** Keep the server origin (null forgets it) and start the web app again, so the new content policy applies. */
  setServerUrl(url: string | null): Promise<void>;
  /** Make the preview of a link with the address rules of the server. Null when the page has no preview. */
  fetchLinkPreview(url: string): Promise<DesktopLinkPreview | null>;
  /** Show a system notification. A click sends the deep link "mortium://notification/<id>". */
  notify(id: string, title: string, body: string): Promise<void>;
  /** Register a global push-to-talk shortcut such as "Control+Shift+KeyT", or remove it (null). */
  setPushToTalk(shortcut: string | null): Promise<void>;
  setVoiceState(inCall: boolean, muted: boolean, deafened: boolean): Promise<void>;
  setCloseToTray(enabled: boolean): Promise<void>;
  setUnreadBadge(count: number): Promise<void>;
  /** A newer version, or null. */
  checkUpdate(): Promise<DesktopUpdateInfo | null>;
  /** Download and install the update, then restart the app. */
  installUpdate(): Promise<void>;
  /** Open an http or https URL in the system browser. */
  openUrl(url: string): Promise<void>;
  /** Listen for an event of the shell. The result removes the listener. */
  onEvent<K extends DesktopEventName>(name: K, handler: (payload: DesktopEvents[K]) => void): Promise<() => void>;
}
