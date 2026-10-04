// The middle column: the guild header menu, categories (collapsible,
// drag-and-drop reorder) and their channels, and the user panel.
import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Permission, hasPermission, type ChannelJson, type ChannelOrderRequest } from "@mortium/shared";
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

  return (
    <div className="relative">
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
        className="w-full truncate px-1 py-1 text-left font-semibold"
      >
        {items.length > 0 ? "▾" : ""}
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Server menu"
          onKeyDown={onKeyDown}
          className="absolute left-0 top-full z-10 w-52 rounded border py-1 shadow-lg"
          style={{ backgroundColor: "var(--color-bg-main)", borderColor: "var(--color-border)" }}
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
              className="block w-full px-3 py-2 text-left text-sm"
              style={{ color: item.danger ? "var(--color-danger-text)" : "var(--color-text-primary)" }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
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
  const connectedChannelId = useStore(voiceStore, (s) => (s.status === "connected" ? s.channelId : null));

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
        className="group flex items-center gap-1 rounded px-2 py-1"
        style={{ backgroundColor: active ? "var(--color-bg-main)" : "transparent" }}
      >
        <button
          type="button"
          onClick={onSelect}
          className="flex-1 truncate text-left text-sm"
          style={{
            color: bright ? "var(--color-text-primary)" : "var(--color-text-muted)",
            fontWeight: unread ? 600 : 400,
          }}
        >
          {isVoice ? "\u{1F50A}" : "#"} {channel.name}
        </button>
        {mentionCount > 0 && (
          <span
            className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none"
            style={{ backgroundColor: "var(--color-danger)", color: "white" }}
          >
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
          className="hidden px-1 text-sm group-hover:block"
          style={{ color: "var(--color-text-muted)" }}
        >
          &#8942;
        </button>
      </div>
      {isVoice && (
        <VoiceChannelParticipants guildId={guildId} channelId={channel.id} live={connectedChannelId === channel.id} />
      )}
    </div>
  );
}

export function ChannelColumn({ guildId, activeChannelId }: { guildId: string; activeChannelId: string | null }) {
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
  const [createDialog, setCreateDialog] = useState<{ kind: "channel" | "category"; parentId: string | null } | null>(
    null,
  );
  const draggedIdRef = useRef<string | null>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const [notificationMenuAt, setNotificationMenuAt] = useState<{ x: number; y: number } | null>(null);

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
          .applyDispatch({ t: "CHANNEL_UPDATE", d: { ...channel, position: entry.position, parentId: entry.parentId } });
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
            .applyDispatch({ t: "CHANNEL_UPDATE", d: { ...channel, position: entry.position, parentId: entry.parentId } });
        }
      }
    }
  }

  function handleDrop(draggedId: string, dropTargetId: string | null, dropParentId: string | null): void {
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
    const destList = destParent === sourceParent ? sourceList : (byParent.get(destParent) ?? []).filter((id) => id !== draggedId);
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
      channel.type === "text" && isChannelUnread(messageChannel?.lastEventId ?? null, messageChannel?.lastReadEventId ?? null);
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
    <aside aria-label="Channels" className="flex w-60 flex-col" style={{ backgroundColor: "var(--color-bg-sidebar)" }}>
      <div ref={headerRef} className="border-b px-3 py-3" style={{ borderColor: "var(--color-border)" }}>
        <GuildMenu
          items={[
            {
              label: "Notification settings",
              onSelect: () => {
                const rect = headerRef.current?.getBoundingClientRect();
                setNotificationMenuAt({ x: rect ? rect.left + 8 : 80, y: rect ? rect.bottom : 60 });
              },
            },
            { label: "Invite people", onSelect: () => setInviteChannelId(firstTextChannelId()), hidden: !canCreateInvite },
            { label: "Server settings", onSelect: () => setGuildSettingsOpen(true), hidden: !isOwner && !canManageChannels },
            { label: "Create channel", onSelect: () => setCreateDialog({ kind: "channel", parentId: null }), hidden: !canManageChannels },
            { label: "Create category", onSelect: () => setCreateDialog({ kind: "category", parentId: null }), hidden: !canManageChannels },
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
        <div className="truncate font-semibold">{guild.name}</div>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {uncategorizedIds.map(renderChannel)}

        {categoryChannels.map((category) => {
          const isCollapsed = collapsed.has(category.id);
          const children = childrenOf(category.id);
          return (
            <div key={category.id} className="mt-3">
              <div
                className="group flex items-center gap-1 px-1"
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
                  className="flex-1 truncate text-left text-xs font-semibold uppercase"
                  style={{ color: "var(--color-text-muted)" }}
                >
                  {isCollapsed ? "▸" : "▾"} {category.name}
                </button>
                {canManageChannels && (
                  <button
                    type="button"
                    aria-label={`Create a channel in ${category.name}`}
                    onClick={() => setCreateDialog({ kind: "channel", parentId: category.id })}
                    className="hidden px-1 text-sm group-hover:block"
                    style={{ color: "var(--color-text-muted)" }}
                  >
                    +
                  </button>
                )}
              </div>
              {!isCollapsed && <div className="mt-1">{children.map(renderChannel)}</div>}
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
        <InviteDialog open={true} channelId={inviteChannelId} onClose={() => setInviteChannelId(null)} />
      )}
      <GuildSettingsDialog open={guildSettingsOpen} guild={guild} isOwner={isOwner} onClose={() => setGuildSettingsOpen(false)} />
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
