// Pure logic for the emoji picker: search, category grouping and the
// recent-emoji list. No DOM or React here, so a unit test needs neither.
// `EmojiPicker.tsx` imports this module and the emoji dataset together,
// so both load only inside the picker's lazy chunk.
import emojiData from "./emoji-data.json";

export interface EmojiRecord {
  /** The emoji character itself. */
  e: string;
  /** The emoji's name, in lower case English. */
  n: string;
  /** The Unicode category, for example "Smileys & Emotion". */
  c: string;
}

export const EMOJI_LIST = emojiData as EmojiRecord[];

/** Category order for the tab strip, plus the synthetic "Recent" tab. */
export const CATEGORY_ORDER = [
  "Smileys & Emotion",
  "People & Body",
  "Animals & Nature",
  "Food & Drink",
  "Travel & Places",
  "Activities",
  "Objects",
  "Symbols",
  "Flags",
] as const;

export const RECENT_CATEGORY = "Recent" as const;

export type CategoryId = typeof RECENT_CATEGORY | (typeof CATEGORY_ORDER)[number];

const CATEGORY_TAB_LABEL: Record<(typeof CATEGORY_ORDER)[number], string> = {
  "Smileys & Emotion": "Smileys",
  "People & Body": "People",
  "Animals & Nature": "Nature",
  "Food & Drink": "Food",
  "Travel & Places": "Travel",
  Activities: "Activities",
  Objects: "Objects",
  Symbols: "Symbols",
  Flags: "Flags",
};

export function categoryTabLabel(category: CategoryId): string {
  if (category === RECENT_CATEGORY) return "Recent";
  return CATEGORY_TAB_LABEL[category];
}

/**
 * Filter the emoji list by a search term (matched against the name,
 * case-insensitive, as a substring). An empty term matches everything.
 */
export function searchEmoji(list: EmojiRecord[], term: string): EmojiRecord[] {
  const needle = term.trim().toLowerCase();
  if (needle.length === 0) {
    return list;
  }
  return list.filter((item) => item.n.includes(needle));
}

/** The emoji of one category, in dataset order. */
export function emojiInCategory(list: EmojiRecord[], category: (typeof CATEGORY_ORDER)[number]): EmojiRecord[] {
  return list.filter((item) => item.c === category);
}

// ---- recent emoji (localStorage) ------------------------------------------

const RECENT_STORAGE_KEY = "mortium:recent-emoji";
export const MAX_RECENT_EMOJI = 24;

/** Move `emoji` to the front of `recent`, remove any duplicate, and cap the length. */
export function addRecentEmoji(recent: string[], emoji: string): string[] {
  const next = [emoji, ...recent.filter((item) => item !== emoji)];
  return next.slice(0, MAX_RECENT_EMOJI);
}

/** Read the recent-emoji list from storage. Returns an empty list on any failure. */
export function loadRecentEmoji(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string").slice(0, MAX_RECENT_EMOJI);
  } catch {
    return [];
  }
}

/** Save the recent-emoji list to storage. Does nothing on any failure. */
export function saveRecentEmoji(recent: string[]): void {
  try {
    localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(recent.slice(0, MAX_RECENT_EMOJI)));
  } catch {
    // Storage can be full or blocked (private mode). The recent list is
    // a convenience, not a requirement, so we drop the write silently.
  }
}

/** Resolve the emoji records for the recent-emoji list, in stored order, skipping unknown emoji. */
export function recentEmojiRecords(list: EmojiRecord[], recent: string[]): EmojiRecord[] {
  const byEmoji = new Map(list.map((item) => [item.e, item] as const));
  const out: EmojiRecord[] = [];
  for (const emoji of recent) {
    const record = byEmoji.get(emoji);
    if (record) out.push(record);
  }
  return out;
}
