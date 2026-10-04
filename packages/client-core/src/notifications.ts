// The rule that decides when a new message shows a desktop notification.
// It is a pure function, so each app shell can use it with its own
// notification service (see `Platform.notify`).
import type { PresenceStatus } from "@mortium/shared";
import type { NotificationLevel } from "./settings-store.js";

export interface NotificationInput {
  /** True when the signed-in user sent the message. */
  isOwnMessage: boolean;
  /** True for a DM or a group DM. */
  isDm: boolean;
  /** The level of the guild of the channel. Not used for a DM. */
  level: NotificationLevel;
  /** True when the message mentions the signed-in user. */
  mentionsSelf: boolean;
  /** The status that the user chose. "dnd" stops all notifications. */
  status: PresenceStatus;
  /** True when the app window has the focus. */
  windowFocused: boolean;
  /** True when the channel of the message is open on the screen. */
  channelOpen: boolean;
}

export function shouldNotify(input: NotificationInput): boolean {
  if (input.isOwnMessage || input.status === "dnd") {
    return false;
  }
  // The user sees the message already.
  if (input.windowFocused && input.channelOpen) {
    return false;
  }
  if (input.isDm) {
    return true;
  }
  switch (input.level) {
    case "all":
      return true;
    case "mentions":
      return input.mentionsSelf;
    default:
      return false;
  }
}
