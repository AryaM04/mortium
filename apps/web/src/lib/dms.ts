// DM actions that more than one view uses: open (or find) a DM, show a
// closed DM again, and close a DM. A close only hides the DM on this
// account (in the synced settings). The history stays on the server.
import { navigate } from "wouter/use-browser-location";
import { hiddenDmsOf, openDm } from "@mortium/client-core";
import type { DmChannelJson } from "@mortium/shared";
import { session } from "./session.js";
import { realtimeStore } from "./realtime.js";
import { settingsStore } from "./settings.js";

export const HOME_PATH = "/app/@me";

// The ids of the group DMs that the user is leaving now. The Home view
// shows no "no longer in this conversation" notice for these.
export const leftDmIds = new Set<string>();

export function dmPath(channelId: string): string {
  return `${HOME_PATH}/${channelId}`;
}

/** Show a closed DM in the list again. Does nothing for a DM that is not closed. */
export function unhideDm(channelId: string): void {
  const hidden = hiddenDmsOf(settingsStore.getState().values);
  if (!(channelId in hidden)) {
    return;
  }
  const next = { ...hidden };
  delete next[channelId];
  void settingsStore.getState().update({ hiddenDms: next });
}

/** Hide a DM from the list until a newer message arrives. */
export function closeDm(channel: DmChannelJson): void {
  const hidden = hiddenDmsOf(settingsStore.getState().values);
  void settingsStore.getState().update({ hiddenDms: { ...hidden, [channel.id]: channel.lastEventId } });
}

/** Add a DM from a REST answer to the store, so the view does not wait for CHANNEL_CREATE. */
export function rememberDm(channel: DmChannelJson): void {
  realtimeStore.getState().applyDispatch({ t: "CHANNEL_CREATE", d: channel });
}

/** Find or make the 1:1 DM with a user, and open it. Throws the server error. */
export async function openDmWith(userId: string): Promise<DmChannelJson> {
  const channel = await openDm(session.apiClient, [userId]);
  rememberDm(channel);
  unhideDm(channel.id);
  navigate(dmPath(channel.id));
  return channel;
}
