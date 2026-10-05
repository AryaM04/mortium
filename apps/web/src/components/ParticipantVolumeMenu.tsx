// A small menu for one other voice participant: a volume slider (0% to
// 200%) and "Mute for me". Opens on right-click on the participant row,
// or on a keyboard-reachable menu button, so the same control works
// without a mouse. Never shown for the self user.
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { applyPeerVolume } from "../lib/voice.js";
import {
  getPerUserVoiceSetting,
  perUserVoiceStore,
  setUserVolumeSetting,
  toggleMutedForMe,
} from "../lib/voice-settings.js";

export function useParticipantMenu() {
  const [openForUserId, setOpenForUserId] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);

  function openAt(userId: string, x: number, y: number) {
    setOpenForUserId(userId);
    setAnchor({ x, y });
  }
  function onContextMenu(event: React.MouseEvent, userId: string) {
    event.preventDefault();
    openAt(userId, event.clientX, event.clientY);
  }
  function close() {
    setOpenForUserId(null);
    setAnchor(null);
  }

  return { openForUserId, anchor, openAt, onContextMenu, close };
}

export function ParticipantVolumeMenu({
  userId,
  anchor,
  onClose,
}: {
  userId: string;
  anchor: { x: number; y: number };
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const setting = useStore(perUserVoiceStore, () => getPerUserVoiceSetting(userId));

  useEffect(() => {
    function onDocClick(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        onClose();
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const percent = Math.round(setting.volume * 100);

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Volume for this person"
      className="menu fixed z-50 w-56 p-3"
      style={{ left: anchor.x, top: anchor.y }}
    >
      <label
        className="mb-1.5 block text-xs font-medium text-secondary"
        htmlFor={`volume-${userId}`}
      >
        Volume: {percent}%
      </label>
      <input
        id={`volume-${userId}`}
        type="range"
        min={0}
        max={200}
        step={5}
        value={percent}
        disabled={setting.mutedForMe}
        onChange={(event) =>
          setUserVolumeSetting(userId, Number(event.target.value) / 100, applyPeerVolume)
        }
        className="w-full"
      />
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={setting.mutedForMe}
        onClick={() => toggleMutedForMe(userId, applyPeerVolume)}
        className="btn btn-secondary mt-3 w-full justify-start px-2.5 py-1.5"
      >
        {setting.mutedForMe ? "Unmute for me" : "Mute for me"}
      </button>
    </div>
  );
}
