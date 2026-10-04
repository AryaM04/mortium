// Desktop notifications for new messages. The rule is `shouldNotify` in
// client-core. The service is `platform.notify` (the Notification API on
// the web). This file asks for the permission only from a button in the
// user settings, never on page load.
import { navigate } from "wouter/use-browser-location";
import { dmDisplayName, notificationLevelOf, shouldNotify } from "@mortium/client-core";
import type { EventJson } from "@mortium/shared";
import { realtimeStore, subscribeDispatch } from "./realtime.js";
import { messageCodec } from "./messages.js";
import { settingsStore } from "./settings.js";
import { presenceUiStore } from "./presence.js";
import { displayNameOf } from "./members.js";
import { dmPath } from "./dms.js";
import { currentPlatform, desktopFeatures } from "./platform.js";

const MAX_BODY_LENGTH = 200;
const MENTION_RE = /<@(\d+)>/g;

export type NotificationPermissionState = "granted" | "denied" | "default" | "unsupported";

export function notificationPermission(): NotificationPermissionState {
  // The desktop app shows system notifications. It needs no browser permission.
  if (desktopFeatures()) {
    return "granted";
  }
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

/** Ask the browser for the permission. Call this only from a click. */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (desktopFeatures()) {
    return "granted";
  }
  if (typeof Notification === "undefined") {
    return "unsupported";
  }
  return Notification.requestPermission();
}

/** The channel id in the address, for `/app/<guild or @me>/<channel>`. */
function openChannelId(): string | null {
  const parts = window.location.pathname.split("/");
  return parts[1] === "app" ? (parts[3] ?? null) : null;
}

async function handleNewEvent(event: EventJson): Promise<void> {
  if (notificationPermission() !== "granted" || (event.relType !== null && event.relType !== "reply")) {
    return;
  }
  const state = realtimeStore.getState();
  const dm = state.privateChannels[event.channelId];
  const channel = state.channels[event.channelId];
  if (!dm && !channel) {
    return;
  }
  const result = await messageCodec.decode(event);
  if (!result.ok || result.payload.type === "reaction") {
    return;
  }
  const payload = result.payload;
  const guildId = channel ? channel.guildId : null;
  const notify = shouldNotify({
    isOwnMessage: event.senderId === state.selfUserId,
    isDm: dm !== undefined,
    level: guildId ? notificationLevelOf(settingsStore.getState().values, guildId) : "all",
    mentionsSelf: state.selfUserId !== null && payload.mentions.includes(state.selfUserId),
    status: presenceUiStore.getState().chosenStatus,
    windowFocused: document.hasFocus(),
    channelOpen: openChannelId() === event.channelId,
  });
  if (!notify) {
    return;
  }

  const sender = displayNameOf(state, guildId, event.senderId);
  let title = sender;
  if (dm && dm.type === "group_dm") {
    title = `${sender} in ${dmDisplayName(dm, state.selfUserId)}`;
  } else if (channel) {
    title = `${sender} in #${channel.name ?? ""} (${state.guilds[channel.guildId]?.name ?? ""})`;
  }
  const text = payload.body.replace(MENTION_RE, (_match, id: string) => `@${displayNameOf(state, guildId, id)}`);
  const body = text.length > MAX_BODY_LENGTH ? `${text.slice(0, MAX_BODY_LENGTH)}…` : text;
  const path = dm ? dmPath(event.channelId) : `/app/${guildId}/${event.channelId}`;

  currentPlatform().notify?.({ title, body, tag: event.channelId, onClick: () => navigate(path) });
}

subscribeDispatch((dispatch) => {
  if (dispatch.t === "EVENT_CREATE") {
    void handleNewEvent(dispatch.d as EventJson);
  }
});
