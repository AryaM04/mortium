// The emoji picker popover. This module and its emoji dataset load only
// when the user first opens the picker (see `EmojiPickerLauncher.tsx`),
// so the main bundle stays small.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CATEGORY_ORDER,
  EMOJI_LIST,
  MAX_RECENT_EMOJI,
  RECENT_CATEGORY,
  addRecentEmoji,
  categoryTabLabel,
  emojiInCategory,
  loadRecentEmoji,
  recentEmojiRecords,
  saveRecentEmoji,
  searchEmoji,
  type CategoryId,
  type EmojiRecord,
} from "./emoji-logic.js";

const GRID_COLUMNS = 8;
const ALL_TABS: CategoryId[] = [RECENT_CATEGORY, ...CATEGORY_ORDER];

export interface EmojiPickerProps {
  /** The element that opened the picker. Escape returns focus to it. */
  anchorEl: HTMLElement | null;
  onPick: (emoji: string) => void;
  onClose: () => void;
}

export function EmojiPicker({ anchorEl, onPick, onClose }: EmojiPickerProps) {
  const [recent, setRecent] = useState<string[]>(() => loadRecentEmoji());
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CategoryId>(
    recent.length > 0 ? RECENT_CATEGORY : CATEGORY_ORDER[0],
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const [style, setStyle] = useState<{ top: number; left: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const searching = query.trim().length > 0;

  const items: EmojiRecord[] = useMemo(() => {
    if (searching) {
      return searchEmoji(EMOJI_LIST, query);
    }
    if (category === RECENT_CATEGORY) {
      return recentEmojiRecords(EMOJI_LIST, recent);
    }
    return emojiInCategory(EMOJI_LIST, category);
  }, [searching, query, category, recent]);

  // Keep the active grid cell inside the current item list.
  useEffect(() => {
    setActiveIndex(0);
  }, [searching, query, category]);

  // Position the popover next to its anchor, clamped to stay inside the
  // viewport (the popover is a fixed size, so this measures itself once
  // it has rendered and re-measures if the window is resized).
  useEffect(() => {
    function place(): void {
      const anchorRect = anchorEl?.getBoundingClientRect();
      const popover = rootRef.current;
      if (!anchorRect || !popover) return;
      const popRect = popover.getBoundingClientRect();
      const margin = 8;
      let top = anchorRect.top - popRect.height - margin;
      if (top < margin) {
        top = Math.min(anchorRect.bottom + margin, window.innerHeight - popRect.height - margin);
      }
      top = Math.max(margin, top);
      let left = anchorRect.right - popRect.width;
      left = Math.min(Math.max(margin, left), window.innerWidth - popRect.width - margin);
      setStyle({ top, left });
    }
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchorEl]);

  // Close on outside click. This is a document-level listener (not the
  // root div's own onKeyDown for Escape below) because the button that
  // opens the picker is its sibling, not its ancestor: a click there, or
  // anywhere else outside the popover, would never reach a handler on
  // the popover itself.
  useEffect(() => {
    function onPointerDown(event: PointerEvent): void {
      const root = rootRef.current;
      if (root && !root.contains(event.target as Node) && event.target !== anchorEl) {
        onClose();
      }
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [anchorEl, onClose]);

  // Close on Escape from anywhere, not only while the popover holds
  // focus: right after opening, focus is still on the button that
  // opened it (a sibling of the popover, so key events there would
  // never reach the popover's own onKeyDown).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
    // `close` is stable enough to skip here: `onClose` only calls a
    // `useState` setter (a stable function), and `anchorEl` does not
    // change while the picker stays open.
  }, []);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  function pick(record: EmojiRecord): void {
    const nextRecent = addRecentEmoji(recent, record.e);
    setRecent(nextRecent);
    saveRecentEmoji(nextRecent);
    onPick(record.e);
  }

  function close(): void {
    onClose();
    anchorEl?.focus();
  }

  function handleKeyDown(event: React.KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (items.length === 0) return;
    if (event.key === "Enter") {
      event.preventDefault();
      pick(items[activeIndex]!);
      return;
    }
    const moves: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: GRID_COLUMNS,
      ArrowUp: -GRID_COLUMNS,
    };
    const delta = moves[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    setActiveIndex((current) => {
      const next = current + delta;
      return Math.min(Math.max(0, next), items.length - 1);
    });
  }

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="Choose an emoji"
      onKeyDown={handleKeyDown}
      className="fixed z-50 flex w-72 flex-col rounded border shadow-lg"
      style={{
        // Placed off-screen until the placement effect below measures
        // the popover and moves it next to its anchor. Off-screen (not
        // `visibility: hidden`) keeps the popover focusable right away,
        // so the search box can take focus as soon as the picker opens.
        top: style?.top ?? -9999,
        left: style?.left ?? -9999,
        backgroundColor: "var(--color-bg-main)",
        borderColor: "var(--color-border)",
      }}
    >
      <div className="p-2">
        <input
          ref={searchRef}
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search for an emoji"
          aria-label="Search for an emoji"
          className="w-full rounded px-2 py-1 text-sm outline-none"
          style={{ backgroundColor: "var(--color-bg-sidebar)", color: "var(--color-text-primary)" }}
        />
      </div>
      {!searching && (
        <div
          className="flex gap-1 overflow-x-auto border-b px-2 pb-1 border-line"
          role="tablist"
          aria-label="Emoji categories"
        >
          {ALL_TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={category === tab}
              onClick={() => setCategory(tab)}
              className="shrink-0 rounded px-1.5 py-0.5 text-xs"
              style={{
                backgroundColor: category === tab ? "var(--color-bg-sidebar)" : "transparent",
                color: "var(--color-text-primary)",
              }}
            >
              {categoryTabLabel(tab)}
            </button>
          ))}
        </div>
      )}
      <div className="grid max-h-56 grid-cols-8 gap-0.5 overflow-y-auto p-2" role="group" aria-label="Emoji">
        {items.length === 0 && (
          <p className="col-span-8 py-4 text-center text-xs text-muted">
            No emoji found.
          </p>
        )}
        {items.map((record, index) => (
          <button
            key={record.e}
            type="button"
            title={record.n}
            aria-label={record.n}
            onClick={() => pick(record)}
            onMouseEnter={() => setActiveIndex(index)}
            className="flex items-center justify-center rounded text-lg"
            style={{
              backgroundColor: index === activeIndex ? "var(--color-bg-sidebar)" : "transparent",
              outline: index === activeIndex ? "1px solid var(--color-accent)" : "none",
            }}
          >
            {record.e}
          </button>
        ))}
      </div>
      {category === RECENT_CATEGORY && !searching && recent.length === 0 && (
        <p className="px-3 pb-2 text-xs text-muted">
          You have no recent emoji. They keep the last {MAX_RECENT_EMOJI} you used.
        </p>
      )}
    </div>
  );
}
