// The left-most rail: the Home button (friends and DMs), one icon per
// guild, and a "+" to create or join one. An accent bar and an accent ring
// mark the active item. A right-click on a guild icon sets its notification level.
import { useState } from "react";
import { Link } from "wouter";
import { aggregateGuildUnread, countUnreadMessages, formatBadgeCount } from "@mortium/client-core";
import { useRealtime } from "../lib/useRealtime.js";
import { useMessages } from "../lib/useMessages.js";
import { CreateOrJoinGuildDialog } from "./CreateOrJoinGuildDialog.js";
import { readLastLocation } from "../lib/lastLocation.js";
import { HOME_PATH } from "../lib/dms.js";
import { NotificationLevelMenu } from "./NotificationLevelMenu.js";
import { serverUrl } from "../lib/server-url.js";
import { MessageIcon, PlusIcon } from "./icons.js";

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}

/** The short accent bar at the left of the active rail item. */
function ActiveBar() {
  return <span aria-hidden="true" className="absolute left-0 h-5 w-1 rounded-r-full bg-accent" />;
}

const tile =
  "flex h-10 w-10 items-center justify-center rounded-[12px] border text-sm font-semibold transition-colors duration-150";

function GuildIcon({
  id,
  name,
  iconKey,
  active,
  firstChannelId,
  hasUnread,
  mentionCount,
  onOpenMenu,
}: {
  id: string;
  name: string;
  iconKey: string | null;
  active: boolean;
  firstChannelId: string | null;
  hasUnread: boolean;
  mentionCount: number;
  onOpenMenu: (position: { x: number; y: number }) => void;
}) {
  const href = firstChannelId ? `/app/${id}/${firstChannelId}` : `/app/${id}`;
  return (
    <div className="relative flex w-full items-center justify-center">
      {active && <ActiveBar />}
      <Link
        href={href}
        title={name}
        aria-label={name}
        aria-current={active ? "page" : undefined}
        onContextMenu={(event) => {
          event.preventDefault();
          onOpenMenu({ x: event.clientX, y: event.clientY });
        }}
        className={`rounded-[12px] ${active ? "ring-2 ring-accent ring-offset-2 ring-offset-canvas" : ""}`}
      >
        {iconKey ? (
          <img
            src={serverUrl(`/api/v1/icons/${id}/${iconKey}`)}
            alt=""
            className="h-10 w-10 rounded-[12px] object-cover"
          />
        ) : (
          <div
            className={`${tile} ${
              active
                ? "border-transparent bg-accent-soft text-accent-text"
                : "border-line bg-elevated text-secondary hover:bg-hover hover:text-primary"
            }`}
          >
            {initialsOf(name)}
          </div>
        )}
      </Link>
      {mentionCount > 0 ? (
        <span className="badge absolute right-1.5 -top-1 ring-2 ring-canvas">
          <span aria-hidden="true">{formatBadgeCount(mentionCount)}</span>
          <span className="sr-only">
            {mentionCount} {mentionCount === 1 ? "mention" : "mentions"}
          </span>
        </span>
      ) : (
        hasUnread && (
          <span className="absolute right-2.5 top-0 h-2.5 w-2.5 rounded-full bg-accent ring-2 ring-canvas">
            <span className="sr-only">Unread channels</span>
          </span>
        )
      )}
    </div>
  );
}

function UnreadBadge({ count, label }: { count: number; label: string }) {
  return (
    <span className="badge absolute right-1.5 -top-1 ring-2 ring-canvas">
      <span aria-hidden="true">{formatBadgeCount(count)}</span>
      <span className="sr-only">
        {count} {label}
      </span>
    </span>
  );
}

/** The Home button. Its badge counts the unread DM messages. */
function HomeButton({ active }: { active: boolean }) {
  const privateChannels = useRealtime((s) => s.privateChannels);
  const messageChannels = useMessages((s) => s.channels);
  const selfUserId = useMessages((s) => s.selfUserId);
  let unread = 0;
  for (const id of Object.keys(privateChannels)) {
    const channel = messageChannels[id];
    if (channel) unread += countUnreadMessages(channel, selfUserId);
  }
  return (
    <div className="relative flex w-full items-center justify-center">
      {active && <ActiveBar />}
      <Link
        href={HOME_PATH}
        title="Home"
        aria-label="Home"
        aria-current={active ? "page" : undefined}
        className={`${tile} ${
          active
            ? "border-transparent bg-accent text-on-accent ring-2 ring-accent ring-offset-2 ring-offset-canvas"
            : "border-line bg-elevated text-accent-text hover:bg-hover"
        }`}
      >
        <MessageIcon size={18} />
      </Link>
      {unread > 0 && <UnreadBadge count={unread} label={unread === 1 ? "unread direct message" : "unread direct messages"} />}
    </div>
  );
}

export function ServerRail({ activeGuildId }: { activeGuildId?: string }) {
  const guilds = useRealtime((s) => s.guilds);
  const channelIdsByGuild = useRealtime((s) => s.channelIdsByGuild);
  const channels = useRealtime((s) => s.channels);
  const messageChannels = useMessages((s) => s.channels);
  const selfUserId = useMessages((s) => s.selfUserId);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [menu, setMenu] = useState<{ guildId: string; position: { x: number; y: number } } | null>(null);

  const guildList = Object.values(guilds).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));

  function firstTextChannel(guildId: string): string | null {
    const ids = channelIdsByGuild[guildId] ?? [];
    const remembered = readLastLocation();
    if (remembered?.guildId === guildId && channels[remembered.channelId]) {
      return remembered.channelId;
    }
    const firstText = ids.find((id) => channels[id]?.type !== "category");
    return firstText ?? null;
  }

  /** The server already sends only the channels this user can view. */
  function viewableTextChannelIds(guildId: string): string[] {
    const ids = channelIdsByGuild[guildId] ?? [];
    return ids.filter((id) => channels[id]?.type === "text");
  }

  return (
    <nav
      aria-label="Servers"
      className="flex w-[64px] shrink-0 flex-col items-center gap-2.5 overflow-y-auto py-1"
    >
      <HomeButton active={activeGuildId === undefined || activeGuildId === "@me"} />
      <div className="h-px w-6 shrink-0 bg-line-strong" />
      {guildList.map((guild) => {
        const summary = aggregateGuildUnread(messageChannels, viewableTextChannelIds(guild.id), selfUserId);
        return (
          <GuildIcon
            key={guild.id}
            id={guild.id}
            name={guild.name}
            iconKey={guild.iconKey}
            active={guild.id === activeGuildId}
            firstChannelId={firstTextChannel(guild.id)}
            hasUnread={summary.hasUnread}
            mentionCount={summary.mentionCount}
            onOpenMenu={(position) => setMenu({ guildId: guild.id, position })}
          />
        );
      })}
      <button
        type="button"
        title="Add a server"
        aria-label="Add a server"
        onClick={() => setDialogOpen(true)}
        className={`${tile} shrink-0 border-dashed border-line-strong bg-transparent text-muted hover:border-accent hover:text-accent-text`}
      >
        <PlusIcon size={18} />
      </button>
      <CreateOrJoinGuildDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
      {menu && guilds[menu.guildId] && (
        <NotificationLevelMenu
          guildId={menu.guildId}
          guildName={guilds[menu.guildId]!.name}
          position={menu.position}
          onClose={() => setMenu(null)}
        />
      )}
    </nav>
  );
}
