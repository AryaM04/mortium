// The channel column of the Home page: the "Friends" entry and the DM
// list. The list has the newest activity first. An unread DM is bold and
// has a badge. The "×" closes a DM: it hides the DM on this account until
// a new message arrives. The history stays.
import { Suspense, lazy, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  countUnreadMessages,
  dmDisplayName,
  dmOtherRecipients,
  formatBadgeCount,
  isChannelUnread,
  isDmHidden,
  sortDmChannels,
} from "@mortium/client-core";
import type { DmChannelJson } from "@mortium/shared";
import { Avatar } from "./Avatar.js";
import { UserPanel } from "./UserPanel.js";
import { VoiceStatusPanel } from "./VoiceStatusPanel.js";
import { useRealtime } from "../lib/useRealtime.js";
import { useMessages } from "../lib/useMessages.js";
import { useSettings } from "../lib/settings.js";
import { closeDm, dmPath, HOME_PATH } from "../lib/dms.js";

// The dialog loads only when it opens, to keep the main bundle small.
const NewGroupDmDialog = lazy(() => import("./NewGroupDmDialog.js"));

function GroupIcon({ channel }: { channel: DmChannelJson }) {
  return (
    <div
      aria-hidden="true"
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
      style={{ backgroundColor: "var(--color-success)", color: "white" }}
    >
      {channel.recipients.length}
    </div>
  );
}

function DmRow({
  channel,
  selfUserId,
  active,
  unreadCount,
  unread,
}: {
  channel: DmChannelJson;
  selfUserId: string | null;
  active: boolean;
  unreadCount: number;
  unread: boolean;
}) {
  const others = dmOtherRecipients(channel, selfUserId);
  const name = dmDisplayName(channel, selfUserId);
  const isGroup = channel.type === "group_dm";
  const [, navigate] = useLocation();
  return (
    <li
      className="group flex items-center gap-2 rounded px-2 py-1"
      style={{ backgroundColor: active ? "var(--color-bg-main)" : "transparent" }}
      data-dm-row={name}
      data-dm-unread={unread}
    >
      <Link
        href={dmPath(channel.id)}
        aria-current={active ? "page" : undefined}
        className="flex min-w-0 flex-1 items-center gap-2"
      >
        {isGroup || !others[0] ? <GroupIcon channel={channel} /> : <Avatar user={others[0]} size={32} />}
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-sm"
            style={{
              color: active || unread ? "var(--color-text-primary)" : "var(--color-text-muted)",
              fontWeight: unread ? 600 : 400,
            }}
          >
            {name}
          </div>
          {isGroup && (
            <div className="truncate text-xs" style={{ color: "var(--color-text-muted)" }}>
              {channel.recipients.length} members
            </div>
          )}
        </div>
      </Link>
      {unreadCount > 0 && (
        <span
          className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none"
          style={{ backgroundColor: "var(--color-danger)", color: "white" }}
          data-dm-badge={unreadCount}
        >
          <span aria-hidden="true">{formatBadgeCount(unreadCount)}</span>
          <span className="sr-only">
            {unreadCount} {unreadCount === 1 ? "unread message" : "unread messages"}
          </span>
        </span>
      )}
      <button
        type="button"
        aria-label={`Close the conversation with ${name}`}
        title="Close"
        onClick={() => {
          closeDm(channel);
          if (active) navigate(HOME_PATH);
        }}
        className="hidden px-1 text-sm group-hover:block group-focus-within:block"
        style={{ color: "var(--color-text-muted)" }}
      >
        ×
      </button>
    </li>
  );
}

export function DmColumn({ activeChannelId }: { activeChannelId: string | null }) {
  const privateChannels = useRealtime((s) => s.privateChannels);
  const selfUserId = useRealtime((s) => s.selfUserId);
  const messageChannels = useMessages((s) => s.channels);
  const settingsValues = useSettings((s) => s.values);
  const [newGroupOpen, setNewGroupOpen] = useState(false);

  const visible = sortDmChannels(Object.values(privateChannels)).filter(
    (channel) => channel.id === activeChannelId || !isDmHidden(settingsValues, channel.id, channel.lastEventId),
  );

  return (
    <aside aria-label="Conversations" className="flex w-60 shrink-0 flex-col" style={{ backgroundColor: "var(--color-bg-sidebar)" }}>
      <div className="border-b px-3 py-3 font-semibold" style={{ borderColor: "var(--color-border)" }}>
        Home
      </div>
      <nav aria-label="Direct messages" className="flex-1 overflow-y-auto p-2">
        <Link
          href={HOME_PATH}
          aria-current={activeChannelId === null ? "page" : undefined}
          className="mb-2 flex items-center gap-2 rounded px-2 py-2 text-sm font-medium"
          style={{ backgroundColor: activeChannelId === null ? "var(--color-bg-main)" : "transparent" }}
        >
          <span aria-hidden="true">&#128101;</span> Friends
        </Link>
        <div className="flex items-center justify-between px-2 py-1">
          <span className="text-xs font-semibold uppercase" style={{ color: "var(--color-text-muted)" }}>
            Direct messages
          </span>
          <button
            type="button"
            aria-label="New group DM"
            title="New group DM"
            onClick={() => setNewGroupOpen(true)}
            className="px-1 text-sm"
            style={{ color: "var(--color-text-muted)" }}
          >
            +
          </button>
        </div>
        {visible.length === 0 ? (
          <p className="px-2 py-2 text-xs" style={{ color: "var(--color-text-muted)" }}>
            You have no conversations yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {visible.map((channel) => {
              const state = messageChannels[channel.id];
              const unread = state
                ? isChannelUnread(state.lastEventId, state.lastReadEventId)
                : false;
              return (
                <DmRow
                  key={channel.id}
                  channel={channel}
                  selfUserId={selfUserId}
                  active={channel.id === activeChannelId}
                  unread={unread}
                  unreadCount={state ? countUnreadMessages(state, selfUserId) : 0}
                />
              );
            })}
          </ul>
        )}
      </nav>
      <VoiceStatusPanel />
      <UserPanel />
      {newGroupOpen && (
        <Suspense fallback={null}>
          <NewGroupDmDialog onClose={() => setNewGroupOpen(false)} />
        </Suspense>
      )}
    </aside>
  );
}
