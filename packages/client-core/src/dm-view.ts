// Small view helpers for DMs and group DMs: the other people, the name
// to show, and the order of the DM list.
import type { DmChannelJson, User } from "@mortium/shared";
import { compareIds } from "./messages-store.js";

/** The people in a DM other than the signed-in user. */
export function dmOtherRecipients(channel: DmChannelJson, selfUserId: string | null): User[] {
  return channel.recipients.filter((recipient) => recipient.id !== selfUserId);
}

/** The group name, or the names of the other people. */
export function dmDisplayName(channel: DmChannelJson, selfUserId: string | null): string {
  if (channel.type === "group_dm" && channel.name) {
    return channel.name;
  }
  const others = dmOtherRecipients(channel, selfUserId);
  if (others.length === 0) {
    return "Empty group";
  }
  return others.map((recipient) => recipient.displayName).join(", ");
}

/** The sort key of a DM: its newest event, or its own id when it has no event yet. */
function activityId(channel: DmChannelJson): string {
  return channel.lastEventId ?? channel.id;
}

/** DMs with the newest activity first. */
export function sortDmChannels(channels: DmChannelJson[]): DmChannelJson[] {
  return [...channels].sort((a, b) => compareIds(activityId(b), activityId(a)));
}
