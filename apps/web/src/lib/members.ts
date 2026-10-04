// Look up a user's display name and user record from the realtime store,
// for message authors, mentions, typing text and voice tiles. A guild
// channel uses the guild member rows. A DM (guild id null) uses the DM
// recipients and the friend list.
import type { RealtimeState } from "@mortium/client-core";
import type { User } from "@mortium/shared";
import { session } from "./session.js";
import { serverUrl } from "./server-url.js";

/** The signed-in user's own profile. The session keeps it even before a member row loads. */
function selfUser(state: RealtimeState, guildId: string | null): User | undefined {
  const fromMember = guildId === null ? undefined : state.selfMemberByGuild[guildId]?.user;
  return fromMember ?? session.store.getState().user ?? undefined;
}

/** A user from a DM or the friend list. A short scan: a user has few DMs in memory. */
function privateUser(state: RealtimeState, userId: string): User | undefined {
  const relationship = state.relationships[userId];
  if (relationship) {
    return relationship.user;
  }
  for (const channel of Object.values(state.privateChannels)) {
    const recipient = channel.recipients.find((candidate) => candidate.id === userId);
    if (recipient) {
      return recipient;
    }
  }
  return undefined;
}

export function memberUser(state: RealtimeState, guildId: string | null, userId: string): User | undefined {
  if (userId === state.selfUserId) {
    return selfUser(state, guildId);
  }
  if (guildId === null) {
    return privateUser(state, userId);
  }
  return state.membersByGuild[guildId]?.[userId]?.user;
}

export function displayNameOf(state: RealtimeState, guildId: string | null, userId: string): string {
  const member =
    guildId === null
      ? undefined
      : userId === state.selfUserId
        ? state.selfMemberByGuild[guildId]
        : state.membersByGuild[guildId]?.[userId];
  return member?.nickname ?? memberUser(state, guildId, userId)?.displayName ?? userId;
}

export function avatarUrlOf(user: User | undefined): string | undefined {
  return user?.avatarKey ? serverUrl(`/api/v1/avatars/${user.id}/${user.avatarKey}`) : undefined;
}
