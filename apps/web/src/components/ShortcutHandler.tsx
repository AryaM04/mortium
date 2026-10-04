// The global keyboard shortcuts (see lib/shortcuts.ts). It renders nothing
// until a shortcut opens a dialog. The dialogs load at that time.
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { navigate } from "wouter/use-browser-location";
import { isChannelUnread, isDmHidden, sortDmChannels } from "@mortium/client-core";
import { realtimeStore } from "../lib/realtime.js";
import { messagesStore } from "../lib/messages.js";
import { settingsStore } from "../lib/settings.js";
import { toggleDeafen, toggleMute } from "../lib/voice.js";
import { dmPath } from "../lib/dms.js";
import {
  adjacentId,
  isMacPlatform,
  matchShortcut,
  orderedTextChannelIds,
  shouldRunShortcut,
  type ShortcutId,
} from "../lib/shortcuts.js";

const QuickSwitcher = lazy(() => import("./ShortcutDialogs.js").then((m) => ({ default: m.QuickSwitcher })));
const ShortcutsHelp = lazy(() => import("./ShortcutDialogs.js").then((m) => ({ default: m.ShortcutsHelp })));

/** The ids and the paths of the channels that a channel shortcut moves between. */
function navigationList(guildId: string | undefined): { ids: string[]; pathOf: (id: string) => string } {
  const state = realtimeStore.getState();
  if (guildId && guildId !== "@me") {
    return {
      ids: orderedTextChannelIds(state.channelIdsByGuild[guildId] ?? [], state.channels),
      pathOf: (id) => `/app/${guildId}/${id}`,
    };
  }
  const hidden = settingsStore.getState().values;
  const ids = sortDmChannels(Object.values(state.privateChannels))
    .filter((channel) => !isDmHidden(hidden, channel.id, channel.lastEventId))
    .map((channel) => channel.id);
  return { ids, pathOf: dmPath };
}

function markChannelRead(channelId: string | undefined): void {
  const channel = channelId ? messagesStore.getState().channels[channelId] : undefined;
  const newest = channel?.eventIds[channel.eventIds.length - 1];
  if (channelId && channel?.atLatest && newest && document.hasFocus()) {
    messagesStore.getState().markRead(channelId, newest);
  }
}

export function ShortcutHandler({ guildId, channelId }: { guildId: string | undefined; channelId: string | undefined }) {
  const [overlay, setOverlay] = useState<"switcher" | "help" | null>(null);
  // The listener reads the route from a ref, so it does not need a new listener on each route change.
  const routeRef = useRef({ guildId, channelId });
  routeRef.current = { guildId, channelId };

  useEffect(() => {
    const mac = isMacPlatform();
    function run(id: ShortcutId): void {
      const route = routeRef.current;
      switch (id) {
        case "quick-switcher":
          setOverlay("switcher");
          break;
        case "show-help":
          setOverlay("help");
          break;
        case "toggle-mute":
          toggleMute();
          break;
        case "toggle-deafen":
          toggleDeafen();
          break;
        case "mark-read":
          markChannelRead(route.channelId);
          break;
        default: {
          const { ids, pathOf } = navigationList(route.guildId);
          const step = id === "previous-channel" || id === "previous-unread" ? -1 : 1;
          const onlyUnread = id === "previous-unread" || id === "next-unread";
          const messageChannels = messagesStore.getState().channels;
          const unread = (other: string) =>
            isChannelUnread(messageChannels[other]?.lastEventId ?? null, messageChannels[other]?.lastReadEventId ?? null);
          const next = adjacentId(ids, route.channelId ?? null, step, onlyUnread ? unread : undefined);
          if (next) navigate(pathOf(next));
        }
      }
    }
    function onKeyDown(event: KeyboardEvent): void {
      const id = matchShortcut(event, mac);
      if (!id || event.defaultPrevented || !shouldRunShortcut(id, event.target)) return;
      // An open dialog or menu owns the keys. Escape closes it.
      const inPopup = event.target instanceof Element && event.target.closest('[role="menu"], [role="dialog"]');
      if (document.querySelector("dialog[open]") || (id === "mark-read" && inPopup)) return;
      if (id !== "mark-read") event.preventDefault();
      run(id);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!overlay) return null;
  const close = () => setOverlay(null);
  return (
    <Suspense fallback={null}>
      {overlay === "switcher" ? <QuickSwitcher guildId={guildId ?? null} onClose={close} /> : <ShortcutsHelp onClose={close} />}
    </Suspense>
  );
}
