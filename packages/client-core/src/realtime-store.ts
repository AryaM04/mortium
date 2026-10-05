// The realtime store: everything the gateway keeps up to date live
// (guilds, channels, roles, members, presence). `applyDispatch` is a
// pure reducer, so it is easy to test on its own; `createRealtimeStore`
// wraps it in a vanilla zustand store for the app to read and subscribe to.
import { createStore, type StoreApi } from "zustand/vanilla";
import type {
  BanJson,
  ChannelJson,
  DmChannelJson,
  GuildJson,
  GuildMemberJson,
  RelationshipJson,
  RoleJson,
  User,
  VisiblePresenceStatus,
  VoiceStateJson,
} from "@mortium/shared";
import type { GatewayDispatch } from "./gateway.js";

export interface RealtimeState {
  selfUserId: string | null;
  /**
   * The gateway session of the latest READY. Null until the first READY.
   * Each READY clears the REST caches (member pages, bans). A view that
   * fills these caches must wait for a session and fill them again when it changes.
   */
  sessionId: string | null;
  guilds: Record<string, GuildJson>;
  channels: Record<string, ChannelJson>;
  /** Channel ids per guild, ordered by position then id. */
  channelIdsByGuild: Record<string, string[]>;
  rolesByGuild: Record<string, RoleJson[]>;
  /** The signed-in user's own member row in each guild they are in. */
  selfMemberByGuild: Record<string, GuildMemberJson>;
  /** Other members, loaded a page at a time over REST and kept live by events. */
  membersByGuild: Record<string, Record<string, GuildMemberJson>>;
  /** Bans, loaded over REST (BAN_MEMBERS required) and kept live for holders of that permission. */
  bansByGuild: Record<string, Record<string, BanJson>>;
  presences: Record<string, VisiblePresenceStatus>;
  /** Who is in each voice channel right now: channel id -> user id -> voice state. */
  voiceStatesByChannel: Record<string, Record<string, VoiceStateJson>>;
  /** Friends, pending requests and blocks of the signed-in user, by the other user's id. */
  relationships: Record<string, RelationshipJson>;
  /** Every DM and group DM of the signed-in user, by channel id. */
  privateChannels: Record<string, DmChannelJson>;
  /** DM calls that ring for the signed-in user right now, by channel id. */
  incomingCalls: Record<string, { channelId: string; userId: string }>;
  /** The newest settings version that another session announced. Null when none came yet. */
  remoteSettingsVersion: number | null;
}

/** True when a channel payload is a DM or a group DM, and not a guild channel. */
export function isDmChannel(channel: ChannelJson | DmChannelJson): channel is DmChannelJson {
  return channel.type === "dm" || channel.type === "group_dm";
}

export function createInitialRealtimeState(): RealtimeState {
  return {
    selfUserId: null,
    sessionId: null,
    guilds: {},
    channels: {},
    channelIdsByGuild: {},
    rolesByGuild: {},
    selfMemberByGuild: {},
    membersByGuild: {},
    bansByGuild: {},
    presences: {},
    voiceStatesByChannel: {},
    relationships: {},
    privateChannels: {},
    incomingCalls: {},
    remoteSettingsVersion: null,
  };
}

/**
 * Remove a user's voice state from every channel it may be tracked
 * under. A user has at most one voice state, so this is a small scan,
 * not an index: it keeps the reducer simple and still correct when a
 * move event arrives out of the order the two dispatches were sent in.
 */
function withoutVoiceState(
  voiceStatesByChannel: Record<string, Record<string, VoiceStateJson>>,
  userId: string,
): Record<string, Record<string, VoiceStateJson>> {
  let changed = false;
  const next: Record<string, Record<string, VoiceStateJson>> = {};
  for (const [channelId, states] of Object.entries(voiceStatesByChannel)) {
    if (userId in states) {
      changed = true;
      const remaining = without(states, userId);
      if (Object.keys(remaining).length > 0) {
        next[channelId] = remaining;
      }
    } else {
      next[channelId] = states;
    }
  }
  return changed ? next : voiceStatesByChannel;
}

function withVoiceStates(
  voiceStatesByChannel: Record<string, Record<string, VoiceStateJson>>,
  states: VoiceStateJson[] | undefined,
): Record<string, Record<string, VoiceStateJson>> {
  let next = voiceStatesByChannel;
  for (const state of states ?? []) {
    next = withoutVoiceState(next, state.userId);
    if (state.channelId) {
      next = {
        ...next,
        [state.channelId]: { ...(next[state.channelId] ?? {}), [state.userId]: state },
      };
    }
  }
  return next;
}

function compareChannelIds(channels: Record<string, ChannelJson>) {
  return (a: string, b: string): number => {
    const posA = channels[a]?.position ?? 0;
    const posB = channels[b]?.position ?? 0;
    if (posA !== posB) {
      return posA - posB;
    }
    // Same position: break the tie by id, oldest first. Ids are decimal
    // snowflakes, so compare as bigint, not as text.
    const idA = BigInt(a);
    const idB = BigInt(b);
    return idA < idB ? -1 : idA > idB ? 1 : 0;
  };
}

function withSortedChannelIds(channels: Record<string, ChannelJson>, ids: string[]): string[] {
  return [...ids].sort(compareChannelIds(channels));
}

function without<T extends Record<string, unknown>>(record: T, key: string): T {
  if (!(key in record)) {
    return record;
  }
  const next = { ...record };
  delete next[key];
  return next;
}

/**
 * Apply one gateway dispatch to the realtime state, returning a new
 * state. Never mutates its input. Unknown guild ids (an event for a
 * guild this client has not loaded) are ignored rather than crashing.
 */
export function applyDispatch(state: RealtimeState, event: GatewayDispatch): RealtimeState {
  switch (event.t) {
    case "READY": {
      const payload = event.d as {
        sessionId: string;
        user: { id: string };
        guilds: Array<
          GuildJson & {
            roles: RoleJson[];
            channels: ChannelJson[];
            member: GuildMemberJson;
            voiceStates?: VoiceStateJson[];
          }
        >;
        presences: Array<{ userId: string; status: VisiblePresenceStatus }>;
        relationships?: RelationshipJson[];
        privateChannels?: DmChannelJson[];
        privateVoiceStates?: VoiceStateJson[];
        incomingCalls?: Array<{ channelId: string; userId: string }>;
      };
      const next = createInitialRealtimeState();
      next.selfUserId = payload.user.id;
      next.sessionId = payload.sessionId;
      for (const guild of payload.guilds) {
        next.guilds[guild.id] = {
          id: guild.id,
          name: guild.name,
          iconKey: guild.iconKey,
          ownerId: guild.ownerId,
          createdAt: guild.createdAt,
        };
        next.rolesByGuild[guild.id] = guild.roles;
        next.selfMemberByGuild[guild.id] = guild.member;
        const ids: string[] = [];
        for (const channel of guild.channels) {
          next.channels[channel.id] = channel;
          ids.push(channel.id);
        }
        next.channelIdsByGuild[guild.id] = withSortedChannelIds(next.channels, ids);
        next.voiceStatesByChannel = withVoiceStates(next.voiceStatesByChannel, guild.voiceStates);
      }
      for (const presence of payload.presences) {
        next.presences[presence.userId] = presence.status;
      }
      for (const relationship of payload.relationships ?? []) {
        next.relationships[relationship.userId] = relationship;
      }
      for (const channel of payload.privateChannels ?? []) {
        next.privateChannels[channel.id] = channel;
      }
      next.voiceStatesByChannel = withVoiceStates(next.voiceStatesByChannel, payload.privateVoiceStates);
      for (const ring of payload.incomingCalls ?? []) {
        next.incomingCalls[ring.channelId] = ring;
      }
      return next;
    }

    case "RESUMED":
      return state;

    case "GUILD_CREATE": {
      const guild = event.d as GuildJson & {
        roles: RoleJson[];
        channels: ChannelJson[];
        member: GuildMemberJson;
        voiceStates?: VoiceStateJson[];
      };
      const channels = { ...state.channels };
      const ids: string[] = [];
      for (const channel of guild.channels) {
        channels[channel.id] = channel;
        ids.push(channel.id);
      }
      return {
        ...state,
        guilds: {
          ...state.guilds,
          [guild.id]: {
            id: guild.id,
            name: guild.name,
            iconKey: guild.iconKey,
            ownerId: guild.ownerId,
            createdAt: guild.createdAt,
          },
        },
        rolesByGuild: { ...state.rolesByGuild, [guild.id]: guild.roles },
        selfMemberByGuild: { ...state.selfMemberByGuild, [guild.id]: guild.member },
        channels,
        channelIdsByGuild: {
          ...state.channelIdsByGuild,
          [guild.id]: withSortedChannelIds(channels, ids),
        },
        voiceStatesByChannel: withVoiceStates(state.voiceStatesByChannel, guild.voiceStates),
      };
    }

    case "GUILD_UPDATE": {
      const patch = event.d as GuildJson;
      if (!(patch.id in state.guilds)) {
        return state;
      }
      return {
        ...state,
        guilds: { ...state.guilds, [patch.id]: { ...state.guilds[patch.id], ...patch } },
      };
    }

    case "GUILD_DELETE": {
      const { id } = event.d as { id: string };
      if (!(id in state.guilds)) {
        return state;
      }
      const channelIds = state.channelIdsByGuild[id] ?? [];
      const channels = { ...state.channels };
      const voiceStatesByChannel = { ...state.voiceStatesByChannel };
      for (const channelId of channelIds) {
        delete channels[channelId];
        delete voiceStatesByChannel[channelId];
      }
      return {
        ...state,
        guilds: without(state.guilds, id),
        rolesByGuild: without(state.rolesByGuild, id),
        selfMemberByGuild: without(state.selfMemberByGuild, id),
        membersByGuild: without(state.membersByGuild, id),
        bansByGuild: without(state.bansByGuild, id),
        channelIdsByGuild: without(state.channelIdsByGuild, id),
        channels,
        voiceStatesByChannel,
      };
    }

    case "CHANNEL_CREATE":
    case "CHANNEL_UPDATE": {
      const channel = event.d as ChannelJson | DmChannelJson;
      if (isDmChannel(channel)) {
        return { ...state, privateChannels: { ...state.privateChannels, [channel.id]: channel } };
      }
      if (!(channel.guildId in state.guilds)) {
        return state;
      }
      const channels = { ...state.channels, [channel.id]: channel };
      const existingIds = state.channelIdsByGuild[channel.guildId] ?? [];
      const ids = existingIds.includes(channel.id) ? existingIds : [...existingIds, channel.id];
      return {
        ...state,
        channels,
        channelIdsByGuild: {
          ...state.channelIdsByGuild,
          [channel.guildId]: withSortedChannelIds(channels, ids),
        },
      };
    }

    case "CHANNEL_DELETE": {
      const { id, guildId } = event.d as { id: string; guildId: string | null };
      if (guildId === null) {
        // A DM or group DM: the person left it, or the owner removed the person.
        if (!(id in state.privateChannels)) {
          return state;
        }
        return {
          ...state,
          privateChannels: without(state.privateChannels, id),
          incomingCalls: without(state.incomingCalls, id),
          voiceStatesByChannel: without(state.voiceStatesByChannel, id),
        };
      }
      if (!(guildId in state.guilds) || !(id in state.channels)) {
        return state;
      }
      const ids = (state.channelIdsByGuild[guildId] ?? []).filter((channelId) => channelId !== id);
      return {
        ...state,
        channels: without(state.channels, id),
        channelIdsByGuild: { ...state.channelIdsByGuild, [guildId]: ids },
        voiceStatesByChannel: without(state.voiceStatesByChannel, id),
      };
    }

    case "GUILD_MEMBER_ADD":
    case "GUILD_MEMBER_UPDATE": {
      const incoming = event.d as GuildMemberJson;
      if (!(incoming.guildId in state.guilds)) {
        return state;
      }
      // GUILD_MEMBER_UPDATE (sent after a role or nickname change) does
      // not carry `user`: the server does not re-look-up and re-send the
      // profile on every such change. Keep the previously known profile
      // in that case, so a role change never reverts a name to a raw id.
      const existing = state.membersByGuild[incoming.guildId]?.[incoming.userId];
      const member: GuildMemberJson = incoming.user ? incoming : { ...incoming, user: existing?.user };
      const guildMembers = {
        ...(state.membersByGuild[member.guildId] ?? {}),
        [member.userId]: member,
      };
      // The signed-in user's own member row (roles, nickname) lives in
      // `selfMemberByGuild`, separate from `membersByGuild`: keep it in
      // sync too, so a role change takes effect for the caller's own
      // derived permissions immediately, with no reload.
      const selfMemberByGuild =
        member.userId === state.selfUserId
          ? { ...state.selfMemberByGuild, [member.guildId]: member }
          : state.selfMemberByGuild;
      return {
        ...state,
        membersByGuild: { ...state.membersByGuild, [member.guildId]: guildMembers },
        selfMemberByGuild,
      };
    }

    case "GUILD_MEMBER_REMOVE": {
      const { guildId, userId } = event.d as { guildId: string; userId: string };
      const guildMembers = state.membersByGuild[guildId];
      if (!guildMembers || !(userId in guildMembers)) {
        return state;
      }
      return {
        ...state,
        membersByGuild: { ...state.membersByGuild, [guildId]: without(guildMembers, userId) },
      };
    }

    case "GUILD_ROLE_CREATE":
    case "GUILD_ROLE_UPDATE": {
      const { guildId, role } = event.d as { guildId: string; role: RoleJson };
      if (!(guildId in state.guilds)) {
        return state;
      }
      const existing = state.rolesByGuild[guildId] ?? [];
      const index = existing.findIndex((r) => r.id === role.id);
      const nextRoles =
        index === -1 ? [...existing, role] : existing.map((r, i) => (i === index ? role : r));
      return { ...state, rolesByGuild: { ...state.rolesByGuild, [guildId]: nextRoles } };
    }

    case "GUILD_ROLE_DELETE": {
      const { guildId, roleId } = event.d as { guildId: string; roleId: string };
      const existing = state.rolesByGuild[guildId];
      if (!existing) {
        return state;
      }
      return {
        ...state,
        rolesByGuild: {
          ...state.rolesByGuild,
          [guildId]: existing.filter((role) => role.id !== roleId),
        },
      };
    }

    case "GUILD_BAN_ADD": {
      const ban = event.d as BanJson;
      const existing = state.bansByGuild[ban.guildId] ?? {};
      return {
        ...state,
        bansByGuild: { ...state.bansByGuild, [ban.guildId]: { ...existing, [ban.userId]: ban } },
      };
    }

    case "GUILD_BAN_REMOVE": {
      const { guildId, userId } = event.d as { guildId: string; userId: string };
      const existing = state.bansByGuild[guildId];
      if (!existing || !(userId in existing)) {
        return state;
      }
      return {
        ...state,
        bansByGuild: { ...state.bansByGuild, [guildId]: without(existing, userId) },
      };
    }

    case "PRESENCE_UPDATE": {
      const { userId, status } = event.d as { userId: string; status: VisiblePresenceStatus };
      return { ...state, presences: { ...state.presences, [userId]: status } };
    }

    case "RELATIONSHIP_ADD": {
      const relationship = event.d as RelationshipJson;
      return { ...state, relationships: { ...state.relationships, [relationship.userId]: relationship } };
    }

    case "RELATIONSHIP_REMOVE": {
      const { userId } = event.d as { userId: string };
      if (!(userId in state.relationships)) {
        return state;
      }
      return { ...state, relationships: without(state.relationships, userId) };
    }

    case "CHANNEL_RECIPIENT_ADD": {
      const { channelId, user } = event.d as { channelId: string; user: User };
      const channel = state.privateChannels[channelId];
      if (!channel || channel.recipients.some((recipient) => recipient.id === user.id)) {
        return state;
      }
      return {
        ...state,
        privateChannels: { ...state.privateChannels, [channelId]: { ...channel, recipients: [...channel.recipients, user] } },
      };
    }

    case "CHANNEL_RECIPIENT_REMOVE": {
      const { channelId, userId } = event.d as { channelId: string; userId: string };
      const channel = state.privateChannels[channelId];
      if (!channel || !channel.recipients.some((recipient) => recipient.id === userId)) {
        return state;
      }
      return {
        ...state,
        privateChannels: {
          ...state.privateChannels,
          [channelId]: { ...channel, recipients: channel.recipients.filter((recipient) => recipient.id !== userId) },
        },
      };
    }

    case "CALL_RING": {
      const ring = event.d as { channelId: string; userId: string };
      return { ...state, incomingCalls: { ...state.incomingCalls, [ring.channelId]: ring } };
    }

    case "CALL_RING_STOP": {
      const { channelId } = event.d as { channelId: string };
      if (!(channelId in state.incomingCalls)) {
        return state;
      }
      return { ...state, incomingCalls: without(state.incomingCalls, channelId) };
    }

    case "USER_SETTINGS_UPDATE": {
      const { version } = event.d as { version: number };
      if (state.remoteSettingsVersion !== null && state.remoteSettingsVersion >= version) {
        return state;
      }
      return { ...state, remoteSettingsVersion: version };
    }

    case "EVENT_CREATE": {
      // Keep the newest event of a DM, for the order of the DM list and to open a closed DM again.
      const created = event.d as { id: string; channelId: string; relType: string | null };
      const channel = state.privateChannels[created.channelId];
      if (!channel || (created.relType !== null && created.relType !== "reply")) {
        return state;
      }
      if (channel.lastEventId !== null && BigInt(channel.lastEventId) >= BigInt(created.id)) {
        return state;
      }
      return {
        ...state,
        privateChannels: { ...state.privateChannels, [channel.id]: { ...channel, lastEventId: created.id } },
      };
    }

    case "VOICE_STATE_UPDATE": {
      const voiceState = event.d as VoiceStateJson;
      return {
        ...state,
        voiceStatesByChannel: withVoiceStates(state.voiceStatesByChannel, [voiceState]),
      };
    }

    default:
      return state;
  }
}

export interface RealtimeActions {
  applyDispatch(event: GatewayDispatch): void;
  /** Merge one REST-loaded page of members into the store. */
  addMemberPage(guildId: string, members: GuildMemberJson[]): void;
  /** Replace the known ban list for a guild with one REST-loaded snapshot. */
  setBans(guildId: string, bans: BanJson[]): void;
  reset(): void;
}

export type RealtimeStore = RealtimeState & RealtimeActions;

export function createRealtimeStore(): StoreApi<RealtimeStore> {
  return createStore<RealtimeStore>((set, get) => ({
    ...createInitialRealtimeState(),

    applyDispatch(event: GatewayDispatch) {
      const current = get();
      const next = applyDispatch(current, event);
      if (next !== current) {
        set(next);
      }
    },

    addMemberPage(guildId: string, members: GuildMemberJson[]) {
      const existing = get().membersByGuild[guildId] ?? {};
      const merged = { ...existing };
      for (const member of members) {
        merged[member.userId] = member;
      }
      set({ membersByGuild: { ...get().membersByGuild, [guildId]: merged } });
    },

    setBans(guildId: string, bans: BanJson[]) {
      const byUserId: Record<string, BanJson> = {};
      for (const ban of bans) {
        byUserId[ban.userId] = ban;
      }
      set({ bansByGuild: { ...get().bansByGuild, [guildId]: byUserId } });
    },

    reset() {
      set(createInitialRealtimeState());
    },
  }));
}
