// The middle column: the guild header menu, categories (collapsible,
// drag-and-drop reorder) and their channels, and the user panel.
import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import {
  Permission,
  hasPermission,
  type ChannelJson,
  type ChannelOrderRequest,
} from "@mortium/shared";
import {
  countMentions,
  formatBadgeCount,
  isChannelUnread,
  leaveGuild,
  reorderChannels,
  selfGuildPermissions,
} from "@mortium/client-core";
import { useStore } from "zustand";
import { session } from "../lib/session.js";
import { realtimeStore } from "../lib/realtime.js";
import { useRealtime } from "../lib/useRealtime.js";
import { useMessages } from "../lib/useMessages.js";
import { readCollapsedCategories, writeCollapsedCategories } from "../lib/lastLocation.js";
import { joinVoiceChannel, voiceStore } from "../lib/voice.js";
import { UserPanel } from "./UserPanel.js";
import { VoiceStatusPanel } from "./VoiceStatusPanel.js";
import { VoiceChannelParticipants } from "./VoiceChannelParticipants.js";
import { InviteDialog } from "./InviteDialog.js";
import { GuildSettingsDialog } from "./GuildSettingsDialog.js";
import { ChannelSettingsDialog } from "./ChannelSettingsDialog.js";
import { CreateChannelDialog } from "./CreateChannelDialog.js";
import { NotificationLevelMenu } from "./NotificationLevelMenu.js";
import { ChevronDownIcon, HashIcon, PlusIcon, SettingsIcon, SpeakerIcon } from "./icons.js";

function GuildMenu({
  items,
}: {
  items: Array<{ label: string; onSelect: () => void; danger?: boolean; hidden?: boolean }>;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const visibleItems = items.filter((item) => !item.hidden);

  useEffect(() => {
    if (!open) return;
    function onDocClick(event: MouseEvent) {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target)) return;
      if (itemRefs.current.some((el) => el?.contains(target))) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  useEffect(() => {
    if (open) {
      itemRefs.current[activeIndex]?.focus();
    }
  }, [open, activeIndex]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      setOpen(false);
      buttonRef.current?.focus();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((i) => (i + 1) % visibleItems.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => (i - 1 + visibleItems.length) % visibleItems.length);
    }
  }

  // The menu opens under the full header (the nearest positioned parent).
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Open server menu"
        onClick={() => {
          setOpen((o) => !o);
          setActiveIndex(0);
        }}
        className="icon-btn h-7 w-7"
      >
        {items.length > 0 && (
          <ChevronDownIcon
            className={`transition-transform duration-150 ${open ? "rotate-180" : ""}`}
          />
        )}
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Server menu"
          onKeyDown={onKeyDown}
          className="menu absolute left-2 right-2 top-full z-10 mt-1"
        >
          {visibleItems.map((item, index) => (
            <button
              key={item.label}
              ref={(el) => {
                itemRefs.current[index] = el;
              }}
              role="menuitem"
              type="button"
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={`menu-item ${item.danger ? "text-danger-text hover:bg-danger-soft" : "text-primary"}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function ChannelRow({
  channel,
  guildId,
  active,
  unread,
  mentionCount,
  href,
  draggable,
  onDragStartId,
  onDropOn,
  onOpenSettings,
}: {
  channel: ChannelJson;
  guildId: string;
  active: boolean;
  unread: boolean;
  mentionCount: number;
  href: string;
  draggable: boolean;
  onDragStartId: (id: string) => void;
  onDropOn: (targetId: string) => void;
  onOpenSettings: () => void;
}) {
  const [, navigate] = useLocation();
  const bright = active || unread;
  const isVoice = channel.type === "voice";
  const connectedChannelId = useStore(voiceStore, (s) =>
    s.status === "connected" ? s.channelId : null,
  );

  function onSelect(): void {
    navigate(href);
    // Do not join again when this tab is already in this channel, or connects to it now.
    const voice = voiceStore.getState();
    if (isVoice && !(voice.status !== "idle" && voice.channelId === channel.id)) {
      void joinVoiceChannel(guildId, channel.id);
    }
  }

  return (
    <div data-voice-channel={isVoice ? channel.name : undefined}>
      <div
        draggable={draggable}
        data-channel-row={channel.name}
        onDragStart={() => onDragStartId(channel.id)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          onDropOn(channel.id);
        }}
        data-active={active}
        className="nav-row group flex h-8 items-center gap-1 rounded-lg pl-2 pr-1"
      >
        <button
          type="button"
          onClick={onSelect}
          className={`flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm ${bright ? "text-primary" : ""}`}
          style={{ fontWeight: unread ? 600 : 400 }}
        >
          {isVoice ? (
            <SpeakerIcon className={active ? "shrink-0 text-accent-text" : "shrink-0 text-muted"} />
          ) : (
            <HashIcon className={active ? "shrink-0 text-accent-text" : "shrink-0 text-muted"} />
          )}
          {/* Keep the channel type in the accessible name, as before the icons. */}
          <span className="sr-only">{isVoice ? "\u{1F50A}" : "#"} </span>
          <span className="truncate">{channel.name}</span>
        </button>
        {mentionCount > 0 && (
          <span className="badge">
            <span aria-hidden="true">{formatBadgeCount(mentionCount)}</span>
            <span className="sr-only">
              {mentionCount} {mentionCount === 1 ? "mention" : "mentions"}
            </span>
          </span>
        )}
        <button
          type="button"
          aria-label={`${channel.name} settings`}
          onClick={onOpenSettings}
          className="icon-btn hidden h-6 w-6 group-hover:inline-flex"
        >
          <SettingsIcon size={14} />
        </button>
      </div>
      {isVoice && (
        <VoiceChannelParticipants
          guildId={guildId}
          channelId={channel.id}
          live={connectedChannelId === channel.id}
        />
      )}
    </div>
  );
}

export function ChannelColumn({
  guildId,
  activeChannelId,
}: {
  guildId: string;
  activeChannelId: string | null;
}) {
  const state = useRealtime((s) => s);
  const guild = state.guilds[guildId];
  const channels = state.channels;
  const channelIds = state.channelIdsByGuild[guildId] ?? [];
  const messageChannels = useMessages((s) => s.channels);
  const selfUserId = useMessages((s) => s.selfUserId);
  const [, navigate] = useLocation();

  const [collapsed, setCollapsed] = useState<Set<string>>(() => readCollapsedCategories(guildId));
  const [inviteChannelId, setInviteChannelId] = useState<string | null>(null);
  const [guildSettingsOpen, setGuildSettingsOpen] = useState(false);
  const [channelSettingsId, setChannelSettingsId] = useState<string | null>(null);
  const [createDialog, setCreateDialog] = useState<{
    kind: "channel" | "category";
    parentId: string | null;
  } | null>(null);
  const draggedIdRef = useRef<string | null>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const [notificationMenuAt, setNotificationMenuAt] = useState<{ x: number; y: number } | null>(
    null,
  );

  useEffect(() => {
    setCollapsed(readCollapsedCategories(guildId));
  }, [guildId]);

  if (!guild) {
    return null;
  }

  const isOwner = guild.ownerId === state.selfUserId;
  const permissions = selfGuildPermissions(state, guildId);
  const canManageChannels = hasPermission(permissions, Permission.MANAGE_CHANNELS);
  const canCreateInvite = hasPermission(permissions, Permission.CREATE_INVITE);

  const topLevelIds = channelIds.filter((id) => channels[id]?.parentId === null);
  const uncategorizedIds = topLevelIds.filter((id) => channels[id]?.type !== "category");

  function childrenOf(categoryId: string): string[] {
    return channelIds.filter((id) => channels[id]?.parentId === categoryId);
  }

  function firstTextChannelId(): string | null {
    return channelIds.find((id) => channels[id]?.type === "text") ?? null;
  }

  function toggleCollapsed(categoryId: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(categoryId)) {
        next.delete(categoryId);
      } else {
        next.add(categoryId);
      }
      writeCollapsedCategories(guildId, next);
      return next;
    });
  }

  async function applyReorder(entries: ChannelOrderRequest, previous: ChannelOrderRequest) {
    for (const entry of entries) {
      const channel = channels[entry.id];
      if (channel) {
        realtimeStore
          .getState()
          .applyDispatch({
            t: "CHANNEL_UPDATE",
            d: { ...channel, position: entry.position, parentId: entry.parentId },
          });
      }
    }
    try {
      await reorderChannels(session.apiClient, guildId, entries);
    } catch {
      for (const entry of previous) {
        const channel = channels[entry.id];
        if (channel) {
          realtimeStore
            .getState()
            .applyDispatch({
              t: "CHANNEL_UPDATE",
              d: { ...channel, position: entry.position, parentId: entry.parentId },
            });
        }
      }
    }
  }

  function handleDrop(
    draggedId: string,
    dropTargetId: string | null,
    dropParentId: string | null,
  ): void {
    const dragged = channels[draggedId];
    if (!dragged || dragged.type === "category" || draggedId === dropTargetId) {
      return;
    }

    const byParent = new Map<string | null, string[]>();
    for (const id of channelIds) {
      const c = channels[id];
      if (!c || c.type === "category") continue;
      const list = byParent.get(c.parentId) ?? [];
      list.push(id);
      byParent.set(c.parentId, list);
    }

    const sourceParent = dragged.parentId;
    const sourceList = (byParent.get(sourceParent) ?? []).filter((id) => id !== draggedId);
    byParent.set(sourceParent, sourceList);

    const destParent = dropParentId;
    const destList =
      destParent === sourceParent
        ? sourceList
        : (byParent.get(destParent) ?? []).filter((id) => id !== draggedId);
    let insertIndex = destList.length;
    if (dropTargetId) {
      const idx = destList.indexOf(dropTargetId);
      insertIndex = idx === -1 ? destList.length : idx;
    }
    destList.splice(insertIndex, 0, draggedId);
    byParent.set(destParent, destList);

    const touchedParents = [...new Set([sourceParent, destParent])];
    const entries: ChannelOrderRequest = [];
    const previous: ChannelOrderRequest = [];
    for (const parentId of touchedParents) {
      const ids = byParent.get(parentId) ?? [];
      ids.forEach((id, index) => {
        entries.push({ id, position: index, parentId });
        const existing = channels[id];
        if (existing) {
          previous.push({ id, position: existing.position, parentId: existing.parentId });
        }
      });
    }
    void applyReorder(entries, previous);
  }

  function renderChannel(id: string) {
    const channel = channels[id];
    if (!channel) return null;
    const messageChannel = messageChannels[id];
    const unread =
      channel.type === "text" &&
      isChannelUnread(messageChannel?.lastEventId ?? null, messageChannel?.lastReadEventId ?? null);
    const mentionCount = messageChannel ? countMentions(messageChannel, selfUserId) : 0;
    return (
      <ChannelRow
        key={id}
        channel={channel}
        guildId={guildId}
        active={id === activeChannelId}
        unread={unread}
        mentionCount={mentionCount}
        href={`/app/${guildId}/${id}`}
        draggable={canManageChannels}
        onDragStartId={(dragId) => {
          draggedIdRef.current = dragId;
        }}
        onDropOn={(targetId) => {
          const target = channels[targetId];
          if (draggedIdRef.current) {
            handleDrop(draggedIdRef.current, targetId, target?.parentId ?? null);
          }
        }}
        onOpenSettings={() => setChannelSettingsId(id)}
      />
    );
  }

  const categoryChannels = channelIds
    .map((id) => channels[id])
    .filter((c): c is ChannelJson => !!c && c.type === "category");

  return (
    <aside aria-label="Channels" className="panel flex w-60 shrink-0 flex-col">
      <div
        ref={headerRef}
        className="relative flex h-12 shrink-0 items-center gap-2 border-b border-line pl-4 pr-2"
      >
        <div className="min-w-0 flex-1 truncate font-semibold">{guild.name}</div>
        <GuildMenu
          items={[
            {
              label: "Notification settings",
              onSelect: () => {
                const rect = headerRef.current?.getBoundingClientRect();
                setNotificationMenuAt({ x: rect ? rect.left + 8 : 80, y: rect ? rect.bottom : 60 });
              },
            },
            {
              label: "Invite people",
              onSelect: () => setInviteChannelId(firstTextChannelId()),
              hidden: !canCreateInvite,
            },
            {
              label: "Server settings",
              onSelect: () => setGuildSettingsOpen(true),
              hidden: !isOwner && !canManageChannels,
            },
            {
              label: "Create channel",
              onSelect: () => setCreateDialog({ kind: "channel", parentId: null }),
              hidden: !canManageChannels,
            },
            {
              label: "Create category",
              onSelect: () => setCreateDialog({ kind: "category", parentId: null }),
              hidden: !canManageChannels,
            },
            {
              label: "Leave server",
              danger: true,
              hidden: isOwner,
              onSelect: () => {
                void leaveGuild(session.apiClient, guildId).then(() => {
                  realtimeStore.getState().applyDispatch({ t: "GUILD_DELETE", d: { id: guildId } });
                  navigate("/app");
                });
              },
            },
          ]}
        />
      </div>

      <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2">
        {uncategorizedIds.map(renderChannel)}

        {categoryChannels.map((category) => {
          const isCollapsed = collapsed.has(category.id);
          const children = childrenOf(category.id);
          return (
            <div key={category.id} className="mt-3 first:mt-1">
              <div
                className="group flex h-6 items-center gap-1 pl-1 pr-1"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (draggedIdRef.current) {
                    handleDrop(draggedIdRef.current, children[0] ?? null, category.id);
                  }
                }}
              >
                <button
                  type="button"
                  onClick={() => toggleCollapsed(category.id)}
                  aria-expanded={!isCollapsed}
                  className="eyebrow flex min-w-0 flex-1 items-center gap-1 text-left hover:text-secondary"
                >
                  <ChevronDownIcon
                    size={12}
                    className={`shrink-0 transition-transform duration-150 ${isCollapsed ? "-rotate-90" : ""}`}
                  />
                  <span className="truncate">{category.name}</span>
                </button>
                {canManageChannels && (
                  <button
                    type="button"
                    aria-label={`Create a channel in ${category.name}`}
                    onClick={() => setCreateDialog({ kind: "channel", parentId: category.id })}
                    className="icon-btn hidden h-6 w-6 group-hover:inline-flex"
                  >
                    <PlusIcon size={14} />
                  </button>
                )}
              </div>
              {!isCollapsed && (
                <div className="mt-0.5 flex flex-col gap-0.5">{children.map(renderChannel)}</div>
              )}
            </div>
          );
        })}
      </div>

      <VoiceStatusPanel />
      <UserPanel />

      {notificationMenuAt && (
        <NotificationLevelMenu
          guildId={guildId}
          guildName={guild.name}
          position={notificationMenuAt}
          onClose={() => setNotificationMenuAt(null)}
        />
      )}

      {inviteChannelId && (
        <InviteDialog
          open={true}
          channelId={inviteChannelId}
          onClose={() => setInviteChannelId(null)}
        />
      )}
      <GuildSettingsDialog
        open={guildSettingsOpen}
        guild={guild}
        isOwner={isOwner}
        onClose={() => setGuildSettingsOpen(false)}
      />
      {channelSettingsId && channels[channelSettingsId] && (
        <ChannelSettingsDialog
          open={true}
          channel={channels[channelSettingsId]!}
          onClose={() => setChannelSettingsId(null)}
          onMove={(direction) => {
            const channel = channels[channelSettingsId]!;
            const siblings = channel.parentId ? childrenOf(channel.parentId) : uncategorizedIds;
            const index = siblings.indexOf(channelSettingsId);
            const swapWith = direction === "up" ? siblings[index - 1] : siblings[index + 1];
            if (swapWith) {
              handleDrop(channelSettingsId, swapWith, channel.parentId);
            }
          }}
        />
      )}
      {createDialog && (
        <CreateChannelDialog
          open={true}
          guildId={guildId}
          kind={createDialog.kind}
          defaultParentId={createDialog.parentId}
          categories={categoryChannels}
          onClose={() => setCreateDialog(null)}
        />
      )}
    </aside>
  );
}
