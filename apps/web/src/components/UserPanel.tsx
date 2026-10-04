// The signed-in user's panel, at the bottom of the channel column: the
// avatar, a status menu, and account settings. The ringing cards of
// incoming DM calls show above it, so they show on every page.
import { moveMenuFocus } from "../lib/menu-keys.js";
import { useEffect, useRef, useState } from "react";
import type { PresenceStatus } from "@mortium/shared";
import { useStore } from "zustand";
import { Avatar } from "./Avatar.js";
import { SettingsDialog } from "./SettingsDialog.js";
import { VoiceSettingsDialogLoader } from "./VoiceSettingsDialogLoader.js";
import { IncomingCallCards } from "./IncomingCallCards.js";
import { useSession } from "../lib/useSession.js";
import { chooseStatus, presenceUiStore } from "../lib/presence.js";

const STATUS_OPTIONS: Array<{ value: PresenceStatus; label: string; color: string }> = [
  { value: "online", label: "Online", color: "#3ba55d" },
  { value: "idle", label: "Idle", color: "#faa61a" },
  { value: "dnd", label: "Do not disturb", color: "#ed4245" },
  { value: "invisible", label: "Invisible", color: "#747f8d" },
];

function StatusMenu() {
  const chosenStatus = useStore(presenceUiStore, (s) => s.chosenStatus);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const current = STATUS_OPTIONS.find((o) => o.value === chosenStatus) ?? STATUS_OPTIONS[0];

  useEffect(() => {
    if (!open) return;
    function onDocClick(event: MouseEvent) {
      const target = event.target as Node;
      if (!buttonRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>("[aria-checked=true]")?.focus();
  }, [open]);

  function onKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      setOpen(false);
      buttonRef.current?.focus();
    } else {
      moveMenuFocus(event);
    }
  }

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Status: ${current!.label}. Change status.`}
        onClick={() => setOpen((o) => !o)}
        className="flex h-4 w-4 items-center justify-center rounded-full"
      >
        <span aria-hidden="true" className="h-3 w-3 rounded-full" style={{ backgroundColor: current!.color }} />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Set status"
          onKeyDown={onKeyDown}
          className="absolute bottom-full left-0 z-10 mb-1 w-44 rounded border py-1 shadow-lg"
          style={{ backgroundColor: "var(--color-bg-main)", borderColor: "var(--color-border)" }}
        >
          {STATUS_OPTIONS.map((option) => (
            <button
              key={option.value}
              role="menuitemradio"
              aria-checked={option.value === chosenStatus}
              type="button"
              onClick={() => {
                chooseStatus(option.value);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
            >
              <span aria-hidden="true" className="h-3 w-3 rounded-full" style={{ backgroundColor: option.color }} />
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function UserPanel() {
  const user = useSession((s) => s.user);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [voiceSettingsOpen, setVoiceSettingsOpen] = useState(false);

  if (!user) return null;

  return (
    <>
      <IncomingCallCards />
      <div
        className="flex items-center gap-2 border-t p-2"
        style={{ borderColor: "var(--color-border)" }}
      >
        <div className="relative">
          <Avatar user={user} size={32} />
          <div className="absolute -bottom-0.5 -right-0.5">
            <StatusMenu />
          </div>
        </div>
        <div className="flex-1 overflow-hidden">
          <div className="truncate text-sm font-medium">{user.displayName}</div>
          <div className="truncate text-xs" style={{ color: "var(--color-text-muted)" }}>
            @{user.username}
          </div>
        </div>
        <button
          type="button"
          aria-label="Open voice and video settings"
          onClick={() => setVoiceSettingsOpen(true)}
          className="rounded px-2 py-1 text-sm"
          style={{ color: "var(--color-text-muted)" }}
          title="Voice and video"
        >
          &#127908;
        </button>
        <button
          type="button"
          aria-label="Open account settings"
          onClick={() => setSettingsOpen(true)}
          className="rounded px-2 py-1 text-sm"
          style={{ color: "var(--color-text-muted)" }}
        >
          Settings
        </button>
        <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        {voiceSettingsOpen && <VoiceSettingsDialogLoader open={voiceSettingsOpen} onClose={() => setVoiceSettingsOpen(false)} />}
      </div>
    </>
  );
}
