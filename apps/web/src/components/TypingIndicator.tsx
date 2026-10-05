// Shows who is typing in the current channel, under the composer. While a
// send waits for the encryption setup, it shows that instead.
import { useEffect } from "react";
import { useStore } from "zustand";
import { useMessages } from "../lib/useMessages.js";
import { useRealtime } from "../lib/useRealtime.js";
import { displayNameOf } from "../lib/members.js";
import { encryptionSetupStore, messagesStore } from "../lib/messages.js";

// A stable fallback object: a fresh `{}` on every render would break the
// store subscription (it always looks "changed"), causing a render loop,
// so a module-level constant is used instead (see `MemberList.tsx`).
const EMPTY_TYPING: Record<string, number> = {};

export function TypingIndicator({
  channelId,
  guildId,
}: {
  channelId: string;
  guildId: string | null;
}) {
  const typing = useMessages((s) => s.channels[channelId]?.typing ?? EMPTY_TYPING);
  const state = useRealtime((s) => s);
  const userIds = Object.keys(typing);
  const settingUp = useStore(encryptionSetupStore, (s) => s.settingUp);

  // Expire stale entries on a slow timer, so the line clears itself
  // without waiting for the next gateway message.
  useEffect(() => {
    const timer = setInterval(() => messagesStore.getState().tickTyping(channelId), 1_000);
    return () => clearInterval(timer);
  }, [channelId]);

  const names = userIds.map((id) => displayNameOf(state, guildId, id));
  let text = "";
  if (settingUp) {
    text = "Setting up encryption…";
  } else if (names.length === 1) {
    text = `${names[0]} is typing…`;
  } else if (names.length === 2) {
    text = `${names[0]} and ${names[1]} are typing…`;
  } else if (names.length > 2) {
    text = "Several people are typing…";
  }

  // One live region stays in the page, so a screen reader reads each change.
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="h-5 truncate px-4 text-xs text-muted"
    >
      {text}
    </div>
  );
}
