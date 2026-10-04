// Which users may read a channel, for the Megolm key share. A user may
// read a channel when it has VIEW_CHANNEL and READ_MESSAGE_HISTORY. The
// server gives the members and the permission inputs, and this client
// computes the permissions again with the shared `computePermissions`.
// A short cache keeps the result. Gateway events that can change the
// result clear it. See docs/concepts/olm-megolm.md section 8.
import {
  computePermissions,
  hasPermission,
  Permission,
  type ChannelMembersResponse,
  type RoleInput,
} from "@mortium/shared";

/** The users who may read one channel now. The list includes this user when it may read the channel. */
export interface Eligibility {
  guildId: string | null;
  userIds: string[];
}

/** What a gateway event changed: every channel, the channels of one guild, or one channel. */
export type MembershipScope = "all" | { guildId: string } | { channelId: string };

const CACHE_MS = 10 * 60 * 1000;
const MAX_CACHED_CHANNELS = 100;
const READ_PERMISSIONS = Permission.VIEW_CHANNEL | Permission.READ_MESSAGE_HISTORY;

/** The users in the response who have VIEW_CHANNEL and READ_MESSAGE_HISTORY, by this client's own check. */
export function eligibleUserIds(response: ChannelMembersResponse): string[] {
  if (response.guildId === null) {
    return response.members.map((member) => member.userId);
  }
  const guildId = response.guildId;
  const everyone = response.roles.find((role) => role.id === guildId);
  if (!everyone) {
    return [];
  }
  const rolesById = new Map(response.roles.map((role) => [role.id, BigInt(role.permissions)]));
  const overwrites = response.overwrites.map((overwrite) => ({
    targetId: BigInt(overwrite.targetId),
    targetType: overwrite.targetType,
    allow: BigInt(overwrite.allow),
    deny: BigInt(overwrite.deny),
  }));
  return response.members
    .filter((member) => {
      const memberRoles: RoleInput[] = member.roles
        .filter((roleId) => roleId !== guildId && rolesById.has(roleId))
        .map((roleId) => ({ id: BigInt(roleId), permissions: rolesById.get(roleId)! }));
      const permissions = computePermissions({
        isOwner: response.ownerId === member.userId,
        everyoneRole: { id: BigInt(everyone.id), permissions: BigInt(everyone.permissions) },
        memberRoles,
        overwrites,
        memberId: BigInt(member.userId),
      });
      return hasPermission(permissions, READ_PERMISSIONS);
    })
    .map((member) => member.userId);
}

function field(value: unknown, name: string): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const result = (value as Record<string, unknown>)[name];
  return typeof result === "string" ? result : null;
}

/** The part of the membership that a gateway dispatch can change, or null when it changes nothing. */
export function membershipScope(dispatch: { t: string; d: unknown }): MembershipScope | null {
  switch (dispatch.t) {
    case "READY":
      return "all";
    case "GUILD_MEMBER_ADD":
    case "GUILD_MEMBER_UPDATE":
    case "GUILD_MEMBER_REMOVE":
    case "GUILD_ROLE_CREATE":
    case "GUILD_ROLE_UPDATE":
    case "GUILD_ROLE_DELETE":
    case "GUILD_BAN_ADD": {
      const guildId = field(dispatch.d, "guildId");
      return guildId ? { guildId } : null;
    }
    case "GUILD_CREATE":
    case "GUILD_DELETE": {
      const guildId = field(dispatch.d, "id");
      return guildId ? { guildId } : null;
    }
    case "CHANNEL_CREATE":
    case "CHANNEL_UPDATE":
    case "CHANNEL_DELETE": {
      const channelId = field(dispatch.d, "id");
      return channelId ? { channelId } : null;
    }
    case "CHANNEL_RECIPIENT_ADD":
    case "CHANNEL_RECIPIENT_REMOVE": {
      const channelId = field(dispatch.d, "channelId");
      return channelId ? { channelId } : null;
    }
    default:
      return null;
  }
}

interface CacheEntry {
  at: number;
  /** Null until the response arrives. */
  guildId: string | null | undefined;
  value: Promise<Eligibility>;
}

export class ChannelMembership {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly fetchMembers: (channelId: string) => Promise<ChannelMembersResponse>,
    private readonly now: () => number = Date.now,
  ) {}

  /** The users who may read the channel now. It uses the cache when the cache is fresh. */
  eligible(channelId: string): Promise<Eligibility> {
    const cached = this.cache.get(channelId);
    if (cached && this.now() - cached.at < CACHE_MS) {
      this.cache.delete(channelId);
      this.cache.set(channelId, cached);
      return cached.value;
    }
    const entry: CacheEntry = { at: this.now(), guildId: undefined, value: Promise.resolve({ guildId: null, userIds: [] }) };
    entry.value = this.fetchMembers(channelId).then((response) => {
      entry.guildId = response.guildId;
      return { guildId: response.guildId, userIds: eligibleUserIds(response) };
    });
    entry.value.catch(() => {
      if (this.cache.get(channelId) === entry) {
        this.cache.delete(channelId);
      }
    });
    this.cache.delete(channelId);
    this.cache.set(channelId, entry);
    while (this.cache.size > MAX_CACHED_CHANNELS) {
      this.cache.delete(this.cache.keys().next().value!);
    }
    return entry.value;
  }

  /** Forget the cached results that a change can make wrong. A result that did not arrive yet is also forgotten. */
  invalidate(scope: MembershipScope): void {
    if (scope === "all") {
      this.cache.clear();
      return;
    }
    for (const [channelId, entry] of this.cache) {
      const hit =
        "channelId" in scope ? channelId === scope.channelId : entry.guildId === undefined || entry.guildId === scope.guildId;
      if (hit) {
        this.cache.delete(channelId);
      }
    }
  }
}
