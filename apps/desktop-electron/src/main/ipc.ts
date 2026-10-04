// The IPC calls of the app window. Each handler checks the sender (only
// the main frame of the app window, on the app origin) and each argument,
// and then calls a service. The result goes back as a `CallResult`, so
// the web app gets the plain error message.
import type { DesktopInit, DesktopLinkPreview, DesktopUpdateInfo } from "@mortium/shared";
import { CALLS, callChannel, type CallName, type CallResult } from "../shared/channels.js";
import {
  ArgumentError,
  bool,
  integer,
  matching,
  MAX_SECURE_VALUE,
  NOTIFICATION_ID,
  SECURE_KEY,
  SHORTCUT,
  text,
  textOrNull,
  webUrl,
} from "./validate.js";

/** The services behind the calls. index.ts supplies the real ones; a test supplies fakes. */
export interface DesktopServices {
  init(): DesktopInit;
  secureGet(key: string): Promise<string | null>;
  secureSet(key: string, value: string): Promise<void>;
  secureDelete(key: string): Promise<void>;
  checkServer(url: string): Promise<string>;
  setServerUrl(url: string | null): Promise<void>;
  fetchLinkPreview(url: string): Promise<DesktopLinkPreview | null>;
  notify(id: string, title: string, body: string): void;
  setPushToTalk(shortcut: string | null): void;
  setVoiceState(inCall: boolean, muted: boolean, deafened: boolean): void;
  setCloseToTray(enabled: boolean): void;
  setUnreadBadge(count: number): void;
  checkUpdate(): Promise<DesktopUpdateInfo | null>;
  installUpdate(): Promise<void>;
  openUrl(url: string): Promise<void>;
}

type Handler = (args: unknown[]) => unknown;

/** The argument count and the checks of each call. */
export function createCallHandlers(services: DesktopServices): Record<CallName, Handler> {
  return {
    init: () => services.init(),
    secureGet: ([key]) => services.secureGet(matching(key, "key name", SECURE_KEY, 128)),
    secureSet: ([key, value]) =>
      services.secureSet(matching(key, "key name", SECURE_KEY, 128), text(value, "value", MAX_SECURE_VALUE)),
    secureDelete: ([key]) => services.secureDelete(matching(key, "key name", SECURE_KEY, 128)),
    checkServer: ([url]) => services.checkServer(text(url, "server address", 2048)),
    setServerUrl: ([url]) => services.setServerUrl(textOrNull(url, "server address", 2048)),
    fetchLinkPreview: ([url]) => services.fetchLinkPreview(webUrl(url, "link").href),
    notify: ([id, title, body]) =>
      services.notify(
        matching(id, "notification id", NOTIFICATION_ID, 40),
        text(title, "notification title", 1000),
        text(body, "notification text", 2000),
      ),
    setPushToTalk: ([shortcut]) =>
      services.setPushToTalk(shortcut === null ? null : matching(shortcut, "shortcut", SHORTCUT, 64)),
    setVoiceState: ([inCall, muted, deafened]) =>
      services.setVoiceState(bool(inCall, "call state"), bool(muted, "mute state"), bool(deafened, "deafen state")),
    setCloseToTray: ([enabled]) => services.setCloseToTray(bool(enabled, "tray setting")),
    setUnreadBadge: ([count]) => services.setUnreadBadge(integer(count, "unread count", 0, 1_000_000)),
    checkUpdate: () => services.checkUpdate(),
    installUpdate: () => services.installUpdate(),
    openUrl: ([url]) => services.openUrl(webUrl(url, "link").href),
  };
}

/** The number of arguments of each call. A call with another count is refused. */
export const ARGUMENT_COUNTS: Record<CallName, number> = {
  init: 0,
  secureGet: 1,
  secureSet: 2,
  secureDelete: 1,
  checkServer: 1,
  setServerUrl: 1,
  fetchLinkPreview: 1,
  notify: 3,
  setPushToTalk: 1,
  setVoiceState: 3,
  setCloseToTray: 1,
  setUnreadBadge: 1,
  checkUpdate: 0,
  installUpdate: 0,
  openUrl: 1,
};

/** Run one call: check the argument count, then the handler. Never throws. */
export async function runCall(handlers: Record<CallName, Handler>, name: CallName, args: unknown[]): Promise<CallResult> {
  try {
    if (args.length !== ARGUMENT_COUNTS[name]) {
      throw new ArgumentError("The call has the wrong number of arguments.");
    }
    return { ok: true, value: (await handlers[name](args)) ?? null };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "The call did not complete." };
  }
}

/** The part of an IPC event that the sender check uses. */
export interface CallEvent {
  sender: unknown;
  senderFrame: { url: string; parent: unknown } | null;
}

/** The part of `ipcMain` that this file uses. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: CallEvent, ...args: unknown[]) => Promise<CallResult>): void;
}

/** Register all calls. `isTrusted` accepts only the app window. */
export function registerCalls(
  ipcMain: IpcMainLike,
  handlers: Record<CallName, Handler>,
  isTrusted: (event: CallEvent) => boolean,
): void {
  for (const name of CALLS) {
    ipcMain.handle(callChannel(name), async (event, ...args) => {
      if (!isTrusted(event)) {
        return { ok: false, message: "This page cannot use the desktop app." };
      }
      return runCall(handlers, name, args);
    });
  }
}
