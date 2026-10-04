// The left-most rail: the Home button (friends and DMs), one icon per
// guild, a "+" to create or join one, and a plain pill to mark the active
// guild. A right-click on a guild icon sets its notification level.
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

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}

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
      {active && (
        <span
          aria-hidden="true"
          className="absolute left-0 h-8 w-1 rounded-r"
          style={{ backgroundColor: "var(--color-text-primary)" }}
        />
      )}
      <Link
        href={href}
        title={name}
        aria-label={name}
        aria-current={active ? "page" : undefined}
        onContextMenu={(event) => {
          event.preventDefault();
          onOpenMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        {iconKey ? (
          <img
            src={serverUrl(`/api/v1/icons/${id}/${iconKey}`)}
            alt=""
            className="h-12 w-12 rounded-full object-cover"
          />
        ) : (
          <div
            className="flex h-12 w-12 items-center justify-center rounded-full font-semibold"
            style={{ backgroundColor: "var(--color-bg-sidebar)" }}
          >
            {initialsOf(name)}
          </div>
        )}
      </Link>
      {mentionCount > 0 ? (
        <span
          className="absolute -right-1 -top-1 flex h-5 min-w-[20px] items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none"
          style={{ backgroundColor: "var(--color-danger)", color: "white" }}
        >
          <span aria-hidden="true">{formatBadgeCount(mentionCount)}</span>
          <span className="sr-only">
            {mentionCount} {mentionCount === 1 ? "mention" : "mentions"}
          </span>
        </span>
      ) : (
        hasUnread && (
          <span
            className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2"
            style={{ backgroundColor: "white", borderColor: "var(--color-bg-rail)" }}
          >
            <span className="sr-only">Unread channels</span>
          </span>
        )
      )}
    </div>
  );
}

function UnreadBadge({ count, label }: { count: number; label: string }) {
  return (
    <span
      className="absolute -right-1 -top-1 flex h-5 min-w-[20px] items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none"
      style={{ backgroundColor: "var(--color-danger)", color: "white" }}
    >
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
      {active && (
        <span
          aria-hidden="true"
          className="absolute left-0 h-8 w-1 rounded-r"
          style={{ backgroundColor: "var(--color-text-primary)" }}
        />
      )}
      <Link
        href={HOME_PATH}
        title="Home"
        aria-label="Home"
        aria-current={active ? "page" : undefined}
        className="flex h-12 w-12 items-center justify-center rounded-full font-semibold"
        style={{ backgroundColor: "var(--color-accent)", color: "white" }}
      >
        DC
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
      className="flex w-[72px] flex-col items-center gap-2 overflow-y-auto py-3"
      style={{ backgroundColor: "var(--color-bg-rail)" }}
    >
      <HomeButton active={activeGuildId === undefined || activeGuildId === "@me"} />
      <div className="my-1 h-px w-8" style={{ backgroundColor: "var(--color-border)" }} />
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
        className="flex h-12 w-12 items-center justify-center rounded-full text-2xl"
        style={{ backgroundColor: "var(--color-bg-sidebar)", color: "var(--color-text-muted)" }}
      >
        +
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
