// The right-hand member list: keyset-paginated over REST, kept live by
// gateway events. Members with a hoisted role show as a separate section
// per role (ordered by role position), then everyone else Online, then
// everyone Offline. A name shows in its highest role's color. Right-click
// (or a click) opens the member context menu.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { listGuildMembers } from "@mortium/client-core";
import type { GuildMemberJson, RoleJson } from "@mortium/shared";
import { session } from "../lib/session.js";
import { realtimeStore } from "../lib/realtime.js";
import { useRealtime } from "../lib/useRealtime.js";
import { presenceUiStore } from "../lib/presence.js";
import { MemberContextMenu, type VoiceContext } from "./MemberContextMenu.js";
import { serverUrl } from "../lib/server-url.js";

const PAGE_SIZE = 50;

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}

const PRESENCE_LABEL: Record<string, string> = {
  online: "Online",
  idle: "Idle",
  dnd: "Do not disturb",
  offline: "Offline",
};

const PRESENCE_COLOR: Record<string, string> = {
  online: "var(--color-online)",
  idle: "var(--color-idle)",
  dnd: "var(--color-dnd)",
  offline: "var(--color-offline)",
};

function roleColorOf(memberRoles: RoleJson[]): string | undefined {
  const colored = memberRoles
    .filter((r) => r.color !== 0)
    .sort((a, b) => b.position - a.position)[0];
  return colored ? `#${colored.color.toString(16).padStart(6, "0")}` : undefined;
}

function MemberRow({
  member,
  status,
  nameColor,
  onOpenMenu,
}: {
  member: GuildMemberJson;
  status: string;
  nameColor: string | undefined;
  onOpenMenu: (event: React.MouseEvent) => void;
}) {
  const name = member.nickname ?? member.user?.displayName ?? member.userId;
  return (
    <>
      <button
        type="button"
        onContextMenu={(e) => {
          e.preventDefault();
          onOpenMenu(e);
        }}
        onClick={onOpenMenu}
        className="flex h-10 w-full items-center gap-2.5 rounded-lg px-2 text-left hover:bg-hover"
      >
        <div className="relative">
          {member.user?.avatarKey ? (
            <img
              src={serverUrl(`/api/v1/avatars/${member.userId}/${member.user.avatarKey}`)}
              alt=""
              className="h-8 w-8 rounded-full object-cover"
            />
          ) : (
            <div
              className="flex h-8 w-8 items-center justify-center rounded-full bg-avatar text-xs font-semibold text-avatar-text"
              aria-hidden="true"
            >
              {initialsOf(member.user?.displayName ?? name)}
            </div>
          )}
          <span
            aria-hidden="true"
            className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-sidebar"
            style={{ backgroundColor: PRESENCE_COLOR[status] ?? PRESENCE_COLOR.offline }}
          />
        </div>
        <span
          className={`truncate text-sm ${status === "offline" ? "text-muted" : "text-secondary"}`}
          style={{ color: nameColor }}
        >
          {name}
        </span>
        <span className="sr-only">{PRESENCE_LABEL[status] ?? "Offline"}</span>
      </button>
    </>
  );
}

const EMPTY_MEMBERS: Record<string, GuildMemberJson> = {};
const EMPTY_ROLES: RoleJson[] = [];
const EMPTY_CHANNEL_IDS: string[] = [];

export function MemberList({ guildId }: { guildId: string }) {
  // A stable fallback object: a fresh `{}` or `[]` on every render would
  // break the store subscription (it always looks "changed"), causing a
  // render loop, so a module-level constant is used instead.
  const members = useRealtime((s) => s.membersByGuild[guildId] ?? EMPTY_MEMBERS);
  const roles = useRealtime((s) => s.rolesByGuild[guildId] ?? EMPTY_ROLES);
  const presences = useRealtime((s) => s.presences);
  const selfUserId = useRealtime((s) => s.selfUserId);
  const channelIds = useRealtime((s) => s.channelIdsByGuild[guildId] ?? EMPTY_CHANNEL_IDS);
  const voiceStatesByChannel = useRealtime((s) => s.voiceStatesByChannel);
  const guild = useRealtime((s) => s.guilds[guildId]);
  // The server never tells a user their own presence (there is no "you"
  // to broadcast to), so the signed-in user's own row uses the status
  // they chose instead of the shared presence map.
  const chosenStatus = useStore(presenceUiStore, (s) => s.chosenStatus);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [done, setDone] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const loadingRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const sessionId = useRealtime((s) => s.sessionId);

  const loadMore = useCallback(async () => {
    // READY clears the member pages. A page that arrives before READY is lost, so wait for a session.
    if (!sessionId || loadingRef.current || done) return;
    loadingRef.current = true;
    try {
      const page = await listGuildMembers(session.apiClient, guildId, {
        after: cursor,
        limit: PAGE_SIZE,
      });
      realtimeStore.getState().addMemberPage(guildId, page.members);
      if (page.members.length < PAGE_SIZE) {
        setDone(true);
      }
      const last = page.members[page.members.length - 1];
      if (last) {
        setCursor(last.userId);
      }
    } finally {
      loadingRef.current = false;
    }
  }, [guildId, sessionId, cursor, done]);

  // Reset paging state and load the first page again when the guild
  // changes, or when a new READY clears the member pages.
  useEffect(() => {
    setCursor(undefined);
    setDone(false);
    loadingRef.current = false;
  }, [guildId, sessionId]);

  // Load the first page once the guild-change effect above has reset the
  // cursor. `loadMore` itself is stable enough for this: it always reads
  // the latest `cursor` and `done` through the closure it was built with.
  useEffect(() => {
    if (cursor === undefined && !done) {
      void loadMore();
    }
  }, [guildId, cursor, done, loadMore]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) {
        void loadMore();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore]);

  function statusOf(userId: string): string {
    if (userId === selfUserId) {
      return chosenStatus === "invisible" ? "offline" : chosenStatus;
    }
    return presences[userId] ?? "offline";
  }

  function voiceContextOf(userId: string): VoiceContext | null {
    for (const channelId of channelIds) {
      const state = voiceStatesByChannel[channelId]?.[userId];
      if (state) {
        return { channelId, serverMute: state.serverMute, serverDeaf: state.serverDeaf };
      }
    }
    return null;
  }

  const hoistedRoles = useMemo(
    () => roles.filter((r) => r.hoist && r.id !== guildId).sort((a, b) => b.position - a.position),
    [roles, guildId],
  );

  const grouped = useMemo(() => {
    const list = Object.values(members);
    const sections: Array<{ label: string; members: GuildMemberJson[] }> = [];
    const claimed = new Set<string>();

    for (const role of hoistedRoles) {
      const inRole = list.filter(
        (m) =>
          !claimed.has(m.userId) && m.roles.includes(role.id) && statusOf(m.userId) !== "offline",
      );
      for (const m of inRole) claimed.add(m.userId);
      sections.push({ label: `${role.name} (${inRole.length})`, members: inRole });
    }

    const online = list.filter((m) => !claimed.has(m.userId) && statusOf(m.userId) !== "offline");
    for (const m of online) claimed.add(m.userId);
    sections.push({ label: `Online (${online.length})`, members: online });

    const offline = list.filter((m) => !claimed.has(m.userId));
    sections.push({ label: `Offline (${offline.length})`, members: offline });

    return sections;
    // statusOf closes over chosenStatus / presences / selfUserId, already listed below.
  }, [members, hoistedRoles, presences, selfUserId, chosenStatus]);

  if (!guild) {
    return null;
  }

  return (
    <aside aria-label="Members" className="panel flex w-60 shrink-0 flex-col overflow-y-auto p-2">
      {grouped.map(
        (section) =>
          section.members.length > 0 && (
            <div key={section.label}>
              <div className="eyebrow mb-1 mt-3 px-2">{section.label}</div>
              <ul>
                {section.members.map((member) => {
                  const memberRoles = roles.filter((r) => member.roles.includes(r.id));
                  return (
                    <li key={member.userId} className="relative">
                      <MemberRow
                        member={member}
                        status={statusOf(member.userId)}
                        nameColor={roleColorOf(memberRoles)}
                        onOpenMenu={() =>
                          setMenuFor(menuFor === member.userId ? null : member.userId)
                        }
                      />
                      {menuFor === member.userId && (
                        <MemberContextMenu
                          guildId={guildId}
                          member={member}
                          isTargetOwner={member.userId === guild.ownerId}
                          voice={voiceContextOf(member.userId)}
                          onClose={() => setMenuFor(null)}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ),
      )}
      <div ref={sentinelRef} aria-hidden="true" style={{ height: 1 }} />
    </aside>
  );
}
