// Server settings > Bans: the ban list, with unban. Loaded only when the
// Bans tab opens.
import { useEffect, useState } from "react";
import { listBans, unbanMember } from "@mortium/client-core";
import { session } from "../lib/session.js";
import { describeError } from "../lib/errors.js";
import { realtimeStore } from "../lib/realtime.js";
import { useRealtime } from "../lib/useRealtime.js";

export function BansTab({ guildId }: { guildId: string }) {
  const bans = useRealtime((s) => s.bansByGuild[guildId]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const sessionId = useRealtime((s) => s.sessionId);

  // READY clears the ban list. Load it after each READY, never before the first one.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setLoading(true);
    listBans(session.apiClient, guildId)
      .then((result) => {
        if (!cancelled) {
          realtimeStore.getState().setBans(guildId, result.bans);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(describeError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [guildId, sessionId]);

  async function handleUnban(userId: string) {
    setBusyUserId(userId);
    setError(null);
    try {
      await unbanMember(session.apiClient, guildId, userId);
      realtimeStore.getState().applyDispatch({ t: "GUILD_BAN_REMOVE", d: { guildId, userId } });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusyUserId(null);
    }
  }

  const list = Object.values(bans ?? {});

  return (
    <div className="flex h-full min-h-0 flex-col">
      {error && (
        <p role="alert" className="mb-2 text-sm text-danger-text">
          {error}
        </p>
      )}
      {loading ? (
        <p className="text-sm text-muted">
          Loading bans...
        </p>
      ) : list.length === 0 ? (
        <p className="text-sm text-muted">
          Nobody is banned from this server.
        </p>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
          {list.map((ban) => (
            <li
              key={ban.userId}
              className="flex items-center gap-2 rounded-lg border border-line bg-main px-3 py-2"
            >
              <div className="flex-1">
                <div className="text-sm">User {ban.userId}</div>
                {ban.reason && (
                  <div className="text-xs text-muted">
                    {ban.reason}
                  </div>
                )}
              </div>
              <button
                type="button"
                disabled={busyUserId === ban.userId}
                onClick={() => void handleUnban(ban.userId)}
                className="btn btn-secondary px-2 py-1 text-xs"
              >
                Unban
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
