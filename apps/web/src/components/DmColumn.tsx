// The channel column of the Home page: the "Friends" entry and the DM
// list. The list has the newest activity first. An unread DM is bold and
// has a badge. The close button closes a DM: it hides the DM on this account until
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
import { CloseIcon, PlusIcon, UsersIcon } from "./icons.js";

// The dialog loads only when it opens, to keep the main bundle small.
const NewGroupDmDialog = lazy(() => import("./NewGroupDmDialog.js"));

function GroupIcon({ channel }: { channel: DmChannelJson }) {
  return (
    <div
      aria-hidden="true"
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-active text-xs font-semibold text-secondary"
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
      data-active={active}
      className="nav-row group flex items-center gap-2 rounded-lg px-2 py-1.5"
      data-dm-row={name}
      data-dm-unread={unread}
    >
      <Link
        href={dmPath(channel.id)}
        aria-current={active ? "page" : undefined}
        className="flex min-w-0 flex-1 items-center gap-2"
      >
        {isGroup || !others[0] ? (
          <GroupIcon channel={channel} />
        ) : (
          <Avatar user={others[0]} size={32} />
        )}
        <div className="min-w-0 flex-1">
          <div
            className={`truncate text-sm ${active || unread ? "text-primary" : ""}`}
            style={{ fontWeight: unread ? 600 : 400 }}
          >
            {name}
          </div>
          {isGroup && (
            <div className="truncate text-xs text-muted">{channel.recipients.length} members</div>
          )}
        </div>
      </Link>
      {unreadCount > 0 && (
        <span className="badge" data-dm-badge={unreadCount}>
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
        className="icon-btn hidden h-6 w-6 group-hover:inline-flex group-focus-within:inline-flex"
      >
        <CloseIcon size={14} />
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
    (channel) =>
      channel.id === activeChannelId ||
      !isDmHidden(settingsValues, channel.id, channel.lastEventId),
  );

  return (
    <aside aria-label="Conversations" className="panel flex w-60 shrink-0 flex-col">
      <div className="flex h-12 shrink-0 items-center border-b border-line px-4 font-semibold">
        Home
      </div>
      <nav aria-label="Direct messages" className="flex-1 overflow-y-auto p-2">
        <Link
          href={HOME_PATH}
          aria-current={activeChannelId === null ? "page" : undefined}
          className="nav-row mb-3 flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium"
        >
          <UsersIcon className={activeChannelId === null ? "text-accent-text" : ""} /> Friends
        </Link>
        <div className="flex items-center justify-between py-1 pl-2 pr-1">
          <span className="eyebrow">Direct messages</span>
          <button
            type="button"
            aria-label="New group DM"
            title="New group DM"
            onClick={() => setNewGroupOpen(true)}
            className="icon-btn h-6 w-6"
          >
            <PlusIcon size={14} />
          </button>
        </div>
        {visible.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted">You have no conversations yet.</p>
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
