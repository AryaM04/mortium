// The platform of the desktop apps: Tauri (Windows, macOS) and Electron
// (Linux). `main.tsx` loads this file with a dynamic import, only when the
// page runs in a desktop app, and gives it the bridge of that shell. It
// gives:
//
// - the secure store of the shell (OS key store, or Electron safeStorage),
// - system notifications, and link previews that the app fetches itself,
// - a global push-to-talk shortcut, a tray menu, an unread badge, deep
//   links and update prompts.
//
// See docs/concepts/desktop-shells.md.
import { createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { navigate } from "wouter/use-browser-location";
import {
  countMentions,
  countUnreadMessages,
  type NotifyOptions,
  type Platform,
} from "@mortium/client-core";
import type { DesktopBridge, DesktopInit } from "@mortium/shared";
import { installDesktopPlatform, type DesktopFeatures } from "../lib/platform.js";
import { setServerOrigin } from "../lib/server-url.js";
import { messagesStore } from "../lib/messages.js";
import { realtimeStore } from "../lib/realtime.js";
import { toggleDeafen, toggleMute, voiceStore } from "../lib/voice.js";
import { commands, onDesktopEvent, setDesktopBridge } from "./bridge.js";
import { readCloseToTray } from "./close-to-tray.js";
import { startUpdateChecks } from "./updates.js";

/** The app keeps the click actions of this many recent notifications. */
const MAX_NOTIFICATION_ACTIONS = 50;
const INVITE_CODE = /^[A-Za-z0-9_-]{1,64}$/;

const notificationActions = new Map<string, () => void>();
let notificationCount = 0;
// Each start of the page has its own id prefix, so a click on an old notification does not run a new action.
const notificationPrefix = Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => (byte % 36).toString(36)).join("");

function notify(options: NotifyOptions): void {
  notificationCount += 1;
  const id = `${notificationPrefix}n${notificationCount}`;
  if (options.onClick) {
    notificationActions.set(id, options.onClick);
    if (notificationActions.size > MAX_NOTIFICATION_ACTIONS) {
      const oldest = notificationActions.keys().next().value;
      if (oldest !== undefined) notificationActions.delete(oldest);
    }
  }
  void commands.notify(id, options.title, options.body).catch(() => {
    // A notification is not worth an error message.
  });
}

const platform: Platform = {
  secureStore: {
    get: (key) => commands.secureGet(key),
    set: (key, value) => commands.secureSet(key, value),
    delete: (key) => commands.secureDelete(key),
  },
  notify,
  fetchLinkPreview: (url) => commands.fetchLinkPreview(url),
};

/** The text under the push-to-talk key in the voice settings. */
function pushToTalkHint(init: DesktopInit): string {
  if (init.pushToTalkUnavailableReason) {
    return `${init.pushToTalkUnavailableReason} Push to talk works only while this window has focus.`;
  }
  if (init.os === "linux") {
    // The Linux app reads the key without taking it from other apps.
    return "Push to talk works in all apps. Other apps also get this key, so use a key that they do not use, such as a function key.";
  }
  return "Push to talk works in all apps. Other apps do not get this key, so use a function key or add Ctrl, Alt or Shift.";
}

function makeFeatures(init: DesktopInit): DesktopFeatures {
  return {
    os: init.os,
    screenShareUnavailableReason:
      init.os === "macos" ? "Screen share is not available in this app on macOS. Use the web app." : null,
    pushToTalkHint: pushToTalkHint(init),
    async registerPushToTalk(shortcut, onChange) {
      if (init.pushToTalkUnavailableReason) {
        throw new Error(init.pushToTalkUnavailableReason);
      }
      const unlisten = await onDesktopEvent("push-to-talk", onChange);
      try {
        await commands.setPushToTalk(shortcut);
      } catch (error) {
        unlisten();
        throw error;
      }
      return () => {
        unlisten();
        void commands.setPushToTalk(null).catch(() => {});
      };
    },
    openExternal: (url) => commands.openUrl(url),
  };
}

/**
 * Open a deep link: "mortium://invite/<code>", "mortium://auth/callback#code=<code>"
 * or "mortium://notification/<id>".
 */
function openDeepLink(link: string): void {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return;
  }
  // In "mortium://invite/abc", the host is "invite" and the path is "/abc".
  const parts = `${url.host}${url.pathname}`.split("/").filter((part) => part.length > 0);
  if (parts[0] === "invite" && parts.length === 2 && INVITE_CODE.test(parts[1]!)) {
    navigate(`/invite/${parts[1]}`);
  } else if (parts[0] === "auth" && parts[1] === "callback" && parts.length === 2) {
    navigate(`/auth/callback${url.hash}`);
  } else if (parts[0] === "notification" && parts.length === 2) {
    // A click on a notification (Windows, Linux). The id is unknown after a restart: the window then only shows.
    notificationActions.get(parts[1]!)?.();
  }
}

/** The number on the taskbar or dock icon: unread direct messages and mentions. */
function unreadCount(): number {
  const { channels, selfUserId } = messagesStore.getState();
  const { privateChannels } = realtimeStore.getState();
  let count = 0;
  for (const [id, channel] of Object.entries(channels)) {
    count += privateChannels[id] ? countUnreadMessages(channel, selfUserId) : countMentions(channel, selfUserId);
  }
  return count;
}

/** Keep the badge up to date. The stores change often, so the count goes out at most 4 times each second. */
function watchUnreadBadge(): void {
  let sent = -1;
  let scheduled = false;
  const update = () => {
    scheduled = false;
    const count = unreadCount();
    if (count !== sent) {
      sent = count;
      void commands.setUnreadBadge(count).catch(() => {});
    }
  };
  const schedule = () => {
    if (!scheduled) {
      scheduled = true;
      // Not an animation frame: a window in the tray gets none.
      setTimeout(update, 250);
    }
  };
  messagesStore.subscribe(schedule);
  realtimeStore.subscribe(schedule);
}

/** Tell the tray menu the call state, and do what the tray menu asks. */
function wireTray(): void {
  let last = "";
  voiceStore.subscribe((state) => {
    const inCall = state.status === "connected";
    const key = `${inCall}:${state.muted}:${state.deafened}`;
    if (key !== last) {
      last = key;
      void commands.setVoiceState(inCall, state.muted, state.deafened).catch(() => {});
    }
  });
  void onDesktopEvent("tray-action", (action) => {
    if (action === "mute") toggleMute();
    else if (action === "deafen") toggleDeafen();
  });
}

/** Show a page in place of the app. The app starts again after the page does its job, so this never resolves. */
function showStartPage(root: HTMLElement, page: ReactElement): Promise<never> {
  createRoot(root).render(page);
  return new Promise<never>(() => {});
}

/** Set up the desktop platform. `main.tsx` calls this before the app renders. */
export async function startDesktop(root: HTMLElement, bridge: DesktopBridge): Promise<void> {
  setDesktopBridge(bridge);
  const init = await commands.init();
  if (!init.serverUrl) {
    const { ServerAddressPage } = await import("./ServerAddressPage.js");
    await showStartPage(root, createElement(ServerAddressPage));
  }
  if (init.secureStoreUnavailableReason) {
    const { SecureStoreUnavailablePage } = await import("./SecureStoreUnavailablePage.js");
    await showStartPage(root, createElement(SecureStoreUnavailablePage, { reason: init.secureStoreUnavailableReason }));
  }
  setServerOrigin(init.serverUrl ?? "");
  installDesktopPlatform(platform, makeFeatures(init));

  void onDesktopEvent("deep-link", (links) => links.forEach(openDeepLink));
  void commands.setCloseToTray(readCloseToTray()).catch(() => {});
  wireTray();
  watchUnreadBadge();
  startUpdateChecks();
  // The router starts after this function returns, so the start links open then.
  setTimeout(() => init.deepLinks.forEach(openDeepLink), 0);
}
