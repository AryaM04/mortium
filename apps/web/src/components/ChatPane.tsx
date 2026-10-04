// The main pane: a channel header and its content. A text channel shows
// its message list and composer; a voice channel shows a short notice
// here, since a voice channel is joined from the channel list, not from
// this pane (see ChannelColumn and the voice status panel above the
// user panel). A DM or group DM uses the same list and composer, with the
// DM header, and shows the call view above the messages during a DM call.
import { useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import { dmOtherRecipients, needsStaleRefetch, type AggregatedMessage } from "@mortium/client-core";
import { Permission, hasPermission } from "@mortium/shared";
import { ConnectionBanner } from "./ConnectionBanner.js";
import { Composer, type EditTarget, type ReplyTarget } from "./Composer.js";
import { MessageList } from "./MessageList.js";
import { TypingIndicator } from "./TypingIndicator.js";
import { MessageAnnouncer } from "./MessageAnnouncer.js";
import { VoiceCallView } from "./VoiceCallView.js";
import { DmHeader } from "./DmHeader.js";
import { useRealtime } from "../lib/useRealtime.js";
import { useMessages } from "../lib/useMessages.js";
import { messagesStore } from "../lib/messages.js";
import { selfChannelPermissions } from "@mortium/client-core";
import { displayNameOf } from "../lib/members.js";
import { voiceStore } from "../lib/voice.js";
import { jumpStore } from "../lib/jump.js";
import { SearchBox } from "./SearchBox.js";

export function ChatPane({ channelId }: { channelId: string | null }) {
  const guildChannel = useRealtime((s) => (channelId ? s.channels[channelId] : undefined));
  const dmChannel = useRealtime((s) => (channelId ? s.privateChannels[channelId] : undefined));
  const channel = guildChannel ?? dmChannel;
  // A DM has no guild. The chat parts find names in the DM recipients.
  const guildId = guildChannel ? guildChannel.guildId : null;
  const isTextLike = channel !== undefined && channel.type !== "voice" && channel.type !== "category";
  const realtimeState = useRealtime((s) => s);
  const messagesState = useMessages((s) => s);
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);

  const permissions = channelId ? selfChannelPermissions(realtimeState, channelId) : 0n;
  // A block that this user made stops the send at once, with the reason.
  // A block by the other user shows as a failed send with the server reason.
  const blockedOther =
    dmChannel?.type === "dm" &&
    dmOtherRecipients(dmChannel, realtimeState.selfUserId).some(
      (other) => realtimeState.relationships[other.id]?.status === "blocked",
    );
  const canSend = hasPermission(permissions, Permission.SEND_MESSAGES) && !blockedOther;
  const canManageMessages = hasPermission(permissions, Permission.MANAGE_MESSAGES);

  const channelState = channelId ? messagesState.channels[channelId] : undefined;
  const connectedVoiceChannelId = useStore(voiceStore, (s) => (s.status === "connected" ? s.channelId : null));

  useEffect(() => {
    setReplyTarget(null);
    setEditTarget(null);
    // A jump to a message of this channel loads its own page (see MessageList).
    const jumping = jumpStore.getState().request?.channelId === channelId;
    if (channelId && channel && isTextLike && !jumping) {
      // A fresh READY (see `applyDispatch` in the store) already seeds
      // this channel's read marker before this effect runs, so read it
      // from the store instead of passing `null`: passing `null` would
      // wipe out the marker and break the unread and mention badges as
      // soon as the channel is opened.
      const seeded = messagesStore.getState().channels[channelId];
      void messagesStore
        .getState()
        .openChannel(channelId, seeded?.lastEventId ?? channel.lastEventId, seeded?.lastReadEventId ?? null);
    }
    // Open the window again only when the channel changes, not on each new event.
  }, [channelId, isTextLike]);

  // A gateway reconnect that gets a fresh READY (not a RESUMED) marks
  // every cached channel window `stale`, because a fresh READY carries
  // no guarantee that no event was missed while disconnected. Refetch
  // the currently open channel's latest page when that happens, so its
  // messages do not silently fall behind.
  useEffect(() => {
    if (channelId && needsStaleRefetch(channelState)) {
      void messagesStore.getState().refetchLatest(channelId);
    }
  }, [channelId, channelState?.stale]);

  // Mark the channel read once its window catches up to the newest
  // message: this only fires when the tab has focus and the view is at
  // the bottom, per the `markRead` debounce in the store.
  useEffect(() => {
    if (!channelId || !channelState || !document.hasFocus() || !channelState.atLatest) {
      return;
    }
    const newest = channelState.eventIds[channelState.eventIds.length - 1];
    if (newest) {
      messagesStore.getState().markRead(channelId, newest);
    }
  }, [channelId, channelState?.eventIds.length, channelState?.atLatest]);

  const lastOwnMessageId = useMemo(() => {
    if (!channelState) return null;
    for (let i = channelState.eventIds.length - 1; i >= 0; i -= 1) {
      const id = channelState.eventIds[i]!;
      const event = channelState.eventsById[id];
      if (event && event.senderId === messagesState.selfUserId && !event.redactedAt) {
        return event;
      }
    }
    return null;
  }, [channelState, messagesState.selfUserId]);

  if (!channelId || !channel) {
    return (
      <main className="flex flex-1 flex-col" style={{ backgroundColor: "var(--color-bg-main)" }}>
        <ConnectionBanner />
        <div className="flex flex-1 items-center justify-center" style={{ color: "var(--color-text-muted)" }}>
          Choose a channel to start.
        </div>
      </main>
    );
  }

  function startReply(message: AggregatedMessage): void {
    setEditTarget(null);
    setReplyTarget({ id: message.id, authorName: displayNameOf(realtimeState, guildId, message.senderId), preview: message.body });
  }

  function startEdit(message: AggregatedMessage): void {
    setReplyTarget(null);
    setEditTarget({ id: message.id, body: message.body });
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col" style={{ backgroundColor: "var(--color-bg-main)" }}>
      <ConnectionBanner />
      {dmChannel ? (
        <div className="relative flex items-center">
          <div className="min-w-0 flex-1">
            <DmHeader channel={dmChannel} />
          </div>
          <SearchBox guildId={null} />
        </div>
      ) : (
        <div className="relative flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: "var(--color-border)" }}>
          <h1 className="font-semibold">
            {channel.type === "voice" ? "\u{1F50A}" : "#"} {channel.name}
          </h1>
          {guildChannel?.topic && (
            <span className="truncate text-sm" style={{ color: "var(--color-text-muted)" }}>
              {guildChannel.topic}
            </span>
          )}
          <SearchBox guildId={guildId} />
        </div>
      )}

      {dmChannel && connectedVoiceChannelId === channelId && (
        <div className="flex max-h-[45%] min-h-[180px] border-b" style={{ borderColor: "var(--color-border)" }}>
          <VoiceCallView guildId={null} channelId={channelId} />
        </div>
      )}

      {channel.type === "voice" ? (
        connectedVoiceChannelId === channelId ? (
          <VoiceCallView guildId={guildId} channelId={channelId} />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center p-3 text-center">
            <p style={{ color: "var(--color-text-muted)" }}>
              Click this channel in the list on the left to join the voice call.
            </p>
          </div>
        )
      ) : (
        <>
          <MessageList
            channelId={channelId}
            guildId={guildId}
            canManageMessages={canManageMessages}
            onReply={startReply}
            onEdit={startEdit}
          />
          <MessageAnnouncer channelId={channelId} guildId={guildId} />
          <TypingIndicator channelId={channelId} guildId={guildId} />
          <Composer
            key={channelId}
            channelId={channelId}
            guildId={guildId}
            dmRecipients={dmChannel?.recipients}
            canSend={canSend}
            disabledReason={
              blockedOther
                ? "You blocked this user. Unblock the user to send a message."
                : "You do not have permission to send a message here."
            }
            replyTarget={replyTarget}
            onCancelReply={() => setReplyTarget(null)}
            editTarget={editTarget}
            onCancelEdit={() => setEditTarget(null)}
            onRequestEditLast={() => {
              if (lastOwnMessageId) {
                const payloads = channelState?.payloads ?? {};
                const body =
                  payloads[lastOwnMessageId.id] && payloads[lastOwnMessageId.id]?.type !== "reaction"
                    ? (payloads[lastOwnMessageId.id] as { body: string }).body
                    : "";
                setEditTarget({ id: lastOwnMessageId.id, body });
              }
            }}
          />
        </>
      )}
    </main>
  );
}
