// The voice status panel: shown above the user panel while a voice call
// is connecting or connected. It names the channel, gives a plain-word
// connection quality reading, and holds the mute, deafen and disconnect
// controls. See docs/concepts/voice.md for the call this panel controls.
import { useState } from "react";
import { useStore } from "zustand";
import { dmDisplayName } from "@mortium/client-core";
import { useRealtime } from "../lib/useRealtime.js";
import {
  cameraSupported,
  leaveVoice,
  screenShareSupported,
  toggleCamera,
  toggleDeafen,
  toggleMute,
  toggleScreenShare,
  voiceStore,
} from "../lib/voice.js";
import { describeKeyCode } from "../lib/ptt.js";
import { desktopFeatures } from "../lib/platform.js";
import { voiceDeviceSettingsStore } from "../lib/voice-settings.js";
import { VoiceSettingsDialogLoader } from "./VoiceSettingsDialogLoader.js";

const QUALITY_LABEL: Record<string, string> = {
  good: "Good connection",
  poor: "Weak connection",
  connecting: "Connecting",
  lost: "Connection lost",
};

export function VoiceStatusPanel() {
  const status = useStore(voiceStore, (s) => s.status);
  const channelId = useStore(voiceStore, (s) => s.channelId);
  const muted = useStore(voiceStore, (s) => s.muted);
  const deafened = useStore(voiceStore, (s) => s.deafened);
  const cameraOn = useStore(voiceStore, (s) => s.cameraOn);
  const screenOn = useStore(voiceStore, (s) => s.screenOn);
  const quality = useStore(voiceStore, (s) => s.quality);
  const errorMessage = useStore(voiceStore, (s) => s.errorMessage);
  const pttActive = useStore(voiceStore, (s) => s.pttActive);
  const inputMode = useStore(voiceDeviceSettingsStore, (s) => s.inputMode);
  // For example, the macOS desktop app cannot share a screen (see docs/concepts/desktop-shells.md).
  const screenUnavailableReason = desktopFeatures()?.screenShareUnavailableReason ?? null;
  const pttKeyCode = useStore(voiceDeviceSettingsStore, (s) => s.pttKeyCode);
  const channelName = useRealtime((s) => {
    if (!channelId) return undefined;
    const dm = s.privateChannels[channelId];
    return dm ? dmDisplayName(dm, s.selfUserId) : s.channels[channelId]?.name;
  });
  const selfVoiceState = useRealtime((s) =>
    channelId && s.selfUserId ? s.voiceStatesByChannel[channelId]?.[s.selfUserId] : undefined,
  );
  const serverMuted = selfVoiceState?.serverMute ?? false;
  const serverDeafened = selfVoiceState?.serverDeaf ?? false;
  const [voiceSettingsOpen, setVoiceSettingsOpen] = useState(false);

  if (status === "idle") {
    return errorMessage ? (
      <div
        className="border-t px-3 py-2 text-xs"
        style={{ borderColor: "var(--color-border)", color: "var(--color-danger-text)" }}
        role="alert"
      >
        {errorMessage}
      </div>
    ) : null;
  }

  return (
    <div
      className="flex flex-col gap-1 border-t px-3 py-2"
      style={{ borderColor: "var(--color-border)" }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col">
          <span
            className="text-sm font-semibold"
            style={{ color: "var(--color-text-primary)" }}
            data-voice-status={status}
          >
            {status === "connecting" ? "Voice connecting" : "Voice connected"}
            {channelName ? `: ${channelName}` : ""}
          </span>
          <span
            className="text-xs"
            style={{ color: "var(--color-text-muted)" }}
            data-voice-quality={quality}
          >
            {status === "connecting" ? "Connecting" : QUALITY_LABEL[quality]}
          </span>
          {inputMode === "push-to-talk" && (
            <span
              className="text-xs"
              style={{ color: "var(--color-text-muted)" }}
              data-voice-ptt-active={pttActive}
            >
              Push to talk{pttKeyCode ? ` (${describeKeyCode(pttKeyCode)})` : ""}:{" "}
              {pttActive ? "open" : "closed"}
            </span>
          )}
        </div>
        <button
          type="button"
          aria-label="Voice call settings"
          onClick={() => setVoiceSettingsOpen(true)}
          className="rounded px-1 text-sm"
          style={{ color: "var(--color-text-muted)" }}
          title="Voice and video settings"
        >
          &#9881;
        </button>
      </div>
      {voiceSettingsOpen && (
        <VoiceSettingsDialogLoader
          open={voiceSettingsOpen}
          onClose={() => setVoiceSettingsOpen(false)}
        />
      )}
      {errorMessage && (
        <span className="text-xs" style={{ color: "var(--color-danger-text)" }} role="alert">
          {errorMessage}
        </span>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={toggleCamera}
          aria-pressed={cameraOn}
          disabled={!cameraSupported}
          title={!cameraSupported ? "This browser does not support the camera." : undefined}
          data-voice-camera={cameraOn}
          className="flex-1 rounded px-2 py-1 text-xs"
          style={{
            backgroundColor: cameraOn ? "var(--color-accent)" : "var(--color-bg-main)",
            color: cameraOn ? "white" : "var(--color-text-primary)",
          }}
        >
          {cameraOn ? "Stop camera" : "Camera"}
        </button>
        {screenUnavailableReason ? (
          <span
            className="flex-1 text-xs"
            style={{ color: "var(--color-text-muted)" }}
            data-voice-screen-unavailable="true"
          >
            {screenUnavailableReason}
          </span>
        ) : (
          <button
            type="button"
            onClick={toggleScreenShare}
            aria-pressed={screenOn}
            disabled={!screenShareSupported}
            title={
              !screenShareSupported ? "This browser does not support screen sharing." : undefined
            }
            data-voice-screen={screenOn}
            className="flex-1 rounded px-2 py-1 text-xs"
            style={{
              backgroundColor: screenOn ? "var(--color-accent)" : "var(--color-bg-main)",
              color: screenOn ? "white" : "var(--color-text-primary)",
            }}
          >
            {screenOn ? "Stop share" : "Share screen"}
          </button>
        )}
      </div>
      {serverMuted && (
        <span
          className="text-xs"
          style={{ color: "var(--color-danger-text)" }}
          role="status"
          data-voice-server-muted="true"
        >
          A moderator muted you. You cannot unmute yourself.
        </span>
      )}
      {serverDeafened && (
        <span
          className="text-xs"
          style={{ color: "var(--color-danger-text)" }}
          role="status"
          data-voice-server-deafened="true"
        >
          A moderator deafened you. You cannot undeafen yourself.
        </span>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={toggleMute}
          disabled={serverMuted}
          title={serverMuted ? "A moderator muted you. You cannot unmute yourself." : undefined}
          aria-pressed={muted || serverMuted}
          data-voice-muted={muted || serverMuted}
          className="flex-1 rounded px-2 py-1 text-xs"
          style={{ backgroundColor: "var(--color-bg-main)", color: "var(--color-text-primary)" }}
        >
          {muted || serverMuted ? "Unmute" : "Mute"}
        </button>
        <button
          type="button"
          onClick={toggleDeafen}
          disabled={serverDeafened}
          title={
            serverDeafened ? "A moderator deafened you. You cannot undeafen yourself." : undefined
          }
          aria-pressed={deafened || serverDeafened}
          data-voice-deafened={deafened || serverDeafened}
          className="flex-1 rounded px-2 py-1 text-xs"
          style={{ backgroundColor: "var(--color-bg-main)", color: "var(--color-text-primary)" }}
        >
          {deafened || serverDeafened ? "Undeafen" : "Deafen"}
        </button>
        <button
          type="button"
          onClick={() => void leaveVoice()}
          className="flex-1 rounded px-2 py-1 text-xs"
          style={{ backgroundColor: "var(--color-danger)", color: "white" }}
        >
          Disconnect
        </button>
      </div>
    </div>
  );
}
