// The results of a local search: channel, author, time and a snippet for
// each message. A click shows the message in its channel. The search
// reads only the local index of this device (see lib/search-indexer.ts),
// so it finds only the messages that this device decrypted.
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { dmDisplayName, type RealtimeState } from "@mortium/client-core";
import {
  foldText,
  isEmptyQuery,
  makeSnippet,
  parseSearchQuery,
  type IndexResult,
} from "@mortium/client-core/search";
import { realtimeStore } from "../lib/realtime.js";
import { displayNameOf } from "../lib/members.js";
import { dmPath } from "../lib/dms.js";
import { requestJump } from "../lib/jump.js";
import { flushSearchQueue } from "../lib/search-queue.js";
import { searchLocal } from "../lib/search-indexer.js";
import { CloseIcon } from "./icons.js";

/** The ids of the known users whose user name, display name or nickname folds to `name`. */
function usersNamed(state: RealtimeState, name: string): string[] {
  const ids = new Set<string>();
  const check = (id: string, names: Array<string | null | undefined>) => {
    if (names.some((value) => value && foldText(value) === name)) ids.add(id);
  };
  for (const members of Object.values(state.membersByGuild)) {
    for (const member of Object.values(members)) {
      check(member.userId, [member.nickname, member.user?.username, member.user?.displayName]);
    }
  }
  for (const channel of Object.values(state.privateChannels)) {
    for (const user of channel.recipients) check(user.id, [user.username, user.displayName]);
  }
  for (const member of Object.values(state.selfMemberByGuild)) {
    check(member.userId, [member.nickname, member.user?.username, member.user?.displayName]);
  }
  return [...ids];
}

/** The ids of the channels named `name`: first in the current guild, else in any guild. */
function channelsNamed(state: RealtimeState, guildId: string | null, name: string): string[] {
  const all = Object.values(state.channels).filter(
    (channel) => channel.name && foldText(channel.name) === name,
  );
  const local = all.filter((channel) => channel.guildId === guildId);
  return (local.length > 0 ? local : all).map((channel) => channel.id);
}

function channelLabel(state: RealtimeState, channelId: string): string {
  const dm = state.privateChannels[channelId];
  if (dm) return dmDisplayName(dm, state.selfUserId);
  const channel = state.channels[channelId];
  return channel ? `#${channel.name}` : "Unknown channel";
}

export default function SearchPanel({
  query,
  guildId,
  onClose,
}: {
  query: string;
  guildId: string | null;
  onClose: () => void;
}) {
  const [results, setResults] = useState<IndexResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, navigate] = useLocation();
  const parsed = parseSearchQuery(query);

  useEffect(() => {
    let active = true;
    setResults(null);
    setError(null);
    void (async () => {
      const state = realtimeStore.getState();
      const senderIds =
        parsed.from.length > 0 ? parsed.from.flatMap((name) => usersNamed(state, name)) : undefined;
      const channelIds =
        parsed.in.length > 0
          ? parsed.in.flatMap((name) => channelsNamed(state, guildId, name))
          : undefined;
      if (isEmptyQuery(parsed)) return [];
      await flushSearchQueue();
      return searchLocal({
        terms: parsed.terms,
        has: parsed.has,
        senderIds,
        channelIds,
        limit: 50,
      });
    })()
      .then((found) => active && setResults(found))
      .catch(() => active && setError("The search did not work. Try again."));
    return () => {
      active = false;
    };
  }, [query, guildId]);

  const state = realtimeStore.getState();
  function open(result: IndexResult): void {
    const channel = state.channels[result.channelId];
    navigate(channel ? `/app/${channel.guildId}/${result.channelId}` : dmPath(result.channelId));
    requestJump(result.channelId, result.id);
    onClose();
  }

  return (
    <div
      role="dialog"
      aria-label="Search results"
      className="menu absolute right-2 top-full z-20 mt-1 flex max-h-[70vh] w-96 flex-col p-0"
    >
      <div className="flex items-center justify-between gap-2 border-b border-line py-1.5 pl-3 pr-1.5 text-xs">
        <span className="text-muted">Search shows only messages this device has seen.</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close search"
          className="icon-btn h-7 w-7"
        >
          <CloseIcon size={14} />
        </button>
      </div>
      <div
        className="overflow-y-auto p-1"
        data-search-state={results === null && !error ? "loading" : "done"}
      >
        {error && <p className="p-3 text-sm">{error}</p>}
        {results?.length === 0 && <p className="p-3 text-sm text-secondary">No message matches.</p>}
        {results?.map((result) => {
          const channel = state.channels[result.channelId];
          return (
            <button
              key={result.id}
              type="button"
              onClick={() => open(result)}
              data-search-result={result.id}
              className="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-hover"
            >
              <div className="flex gap-2 text-xs text-muted">
                <span>{channelLabel(state, result.channelId)}</span>
                <span className="font-medium text-primary">
                  {displayNameOf(state, channel?.guildId ?? null, result.senderId)}
                </span>
                <span>{new Date(result.createdAt).toLocaleString()}</span>
              </div>
              <div className="truncate">{makeSnippet(result.body, parsed.terms)}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
