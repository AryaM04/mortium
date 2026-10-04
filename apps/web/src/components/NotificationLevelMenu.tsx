// A small menu that sets the notification level of one guild: all
// messages, only @mentions, or nothing. The level is a synced setting.
import { moveMenuFocus } from "../lib/menu-keys.js";
import { useEffect, useRef } from "react";
import { notificationLevelOf, type NotificationLevel } from "@mortium/client-core";
import { settingsStore, useSettings } from "../lib/settings.js";

const LEVELS: Array<{ value: NotificationLevel; label: string }> = [
  { value: "all", label: "All messages" },
  { value: "mentions", label: "Only @mentions" },
  { value: "none", label: "Nothing" },
];

export function setNotificationLevel(guildId: string, level: NotificationLevel): void {
  const saved = settingsStore.getState().values.notificationLevels;
  const current = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  void settingsStore.getState().update({ notificationLevels: { ...current, [guildId]: level } });
}

export function NotificationLevelMenu({
  guildId,
  guildName,
  position,
  onClose,
}: {
  guildId: string;
  guildName: string;
  /** Fixed screen position of the menu. */
  position: { x: number; y: number };
  onClose: () => void;
}) {
  const level = useSettings((s) => notificationLevelOf(s.values, guildId));
  const menuRef = useRef<HTMLDivElement>(null);
  // The parent can give a new function on each render. Keep the latest one without new listeners.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    function onDocClick(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        onCloseRef.current();
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onCloseRef.current();
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    menuRef.current?.querySelector<HTMLButtonElement>("[aria-checked=true]")?.focus();
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div
      ref={menuRef}
      role="menu"
      onKeyDown={moveMenuFocus}
      aria-label={`Notification settings for ${guildName}`}
      className="fixed z-40 w-56 rounded border py-1 shadow-lg"
      style={{
        left: position.x,
        top: position.y,
        backgroundColor: "var(--color-bg-main)",
        borderColor: "var(--color-border)",
      }}
    >
      <div className="px-3 py-1 text-xs font-semibold uppercase" style={{ color: "var(--color-text-muted)" }}>
        Notifications
      </div>
      {LEVELS.map((option) => (
        <button
          key={option.value}
          type="button"
          role="menuitemradio"
          aria-checked={option.value === level}
          onClick={() => {
            setNotificationLevel(guildId, option.value);
            onClose();
          }}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
        >
          <span aria-hidden="true" className="w-3">
            {option.value === level ? "●" : "○"}
          </span>
          {option.label}
        </button>
      ))}
    </div>
  );
}
