// The IPC channel names of the Linux desktop app. The preload script and
// the main process both import this file, so the names stay the same.

/** The origin of the web build in the app window. The server must list it in CORS_ALLOWED_ORIGINS. */
export const APP_SCHEME = "app";
export const APP_HOST = "mortium";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/** The URL scheme of deep links. It must match DESKTOP_URL_SCHEME on the server. */
export const DEEP_LINK_SCHEME = "mortium";

/** The calls from the app window to the main process (ipcRenderer.invoke). */
export const CALLS = [
  "init",
  "secureGet",
  "secureSet",
  "secureDelete",
  "checkServer",
  "setServerUrl",
  "fetchLinkPreview",
  "notify",
  "setPushToTalk",
  "setVoiceState",
  "setCloseToTray",
  "setUnreadBadge",
  "checkUpdate",
  "installUpdate",
  "openUrl",
] as const;

export type CallName = (typeof CALLS)[number];

export function callChannel(name: CallName): string {
  return `desktop:${name}`;
}

/** The events from the main process to the app window. */
export const EVENTS = ["deep-link", "push-to-talk", "tray-action"] as const;

export function eventChannel(name: (typeof EVENTS)[number]): string {
  return `desktop-event:${name}`;
}

/** The result of each call. An Error does not cross IPC with its plain message, so the main process sends this. */
export type CallResult = { ok: true; value: unknown } | { ok: false; message: string };

/** The calls of the screen picker window. */
export const PICKER_SOURCES = "picker:sources";
export const PICKER_CHOOSE = "picker:choose";

/** A screen or a window that the user can share. */
export interface PickerSource {
  id: string;
  name: string;
  /** A PNG data URL. */
  thumbnail: string;
}
