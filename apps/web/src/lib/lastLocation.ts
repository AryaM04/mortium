// Remember the last guild and channel a person opened, so `/app` can
// return them there. localStorage can throw (private mode, a full quota),
// so every call is wrapped.

const KEY = "mortium:last-location";

export function rememberLastLocation(guildId: string, channelId: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ guildId, channelId }));
  } catch {
    // Not fatal: the person just starts at the home view next time.
  }
}

/** Forget the last location, e.g. after the guild it points to stops being reachable. */
export function clearLastLocation(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Not fatal.
  }
}

export function readLastLocation(): { guildId: string; channelId: string } | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { guildId?: unknown; channelId?: unknown };
    if (typeof parsed.guildId === "string" && typeof parsed.channelId === "string") {
      return { guildId: parsed.guildId, channelId: parsed.channelId };
    }
    return null;
  } catch {
    return null;
  }
}

const COLLAPSED_KEY_PREFIX = "mortium:collapsed-categories:";

export function readCollapsedCategories(guildId: string): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY_PREFIX + guildId);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? new Set(parsed.filter((v) => typeof v === "string")) : new Set();
  } catch {
    return new Set();
  }
}

export function writeCollapsedCategories(guildId: string, ids: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY_PREFIX + guildId, JSON.stringify([...ids]));
  } catch {
    // Not fatal: categories just default to expanded next time.
  }
}
