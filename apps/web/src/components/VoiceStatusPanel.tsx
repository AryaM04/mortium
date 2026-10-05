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
import {
  HeadphonesIcon,
  HeadphonesOffIcon,
  MicIcon,
  MicOffIcon,
  PhoneOffIcon,
  ScreenIcon,
  SettingsIcon,
  VideoIcon,
} from "./icons.js";

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
      <div className="card mx-2 mt-1 px-3 py-2 text-xs text-danger-text" role="alert">
        {errorMessage}
      </div>
    ) : null;
  }

  // A pressed toggle shows in the danger color, so a muted microphone is easy to see.
  const toggle = (on: boolean) =>
    `icon-btn h-8 w-auto flex-1 ${on ? "bg-danger-soft text-danger-text hover:text-danger-text" : "bg-hover text-secondary"}`;

  return (
    <div className="card mx-2 mt-1 flex flex-col gap-2 p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="flex items-center gap-1.5 text-sm font-semibold text-success-text" data-voice-status={status}>
            <span
              aria-hidden="true"
              className={`h-2 w-2 shrink-0 rounded-full ${status === "connecting" ? "bg-warning" : "bg-success"}`}
            />
            <span className="truncate">
              {status === "connecting" ? "Voice connecting" : "Voice connected"}
              {channelName ? `: ${channelName}` : ""}
            </span>
          </span>
          <span className="text-xs text-muted" data-voice-quality={quality}>
            {status === "connecting" ? "Connecting" : QUALITY_LABEL[quality]}
          </span>
          {inputMode === "push-to-talk" && (
            <span className="text-xs text-muted" data-voice-ptt-active={pttActive}>
              Push to talk{pttKeyCode ? ` (${describeKeyCode(pttKeyCode)})` : ""}:{" "}
              {pttActive ? "open" : "closed"}
            </span>
          )}
        </div>
        <button
          type="button"
          aria-label="Voice call settings"
          onClick={() => setVoiceSettingsOpen(true)}
          className="icon-btn h-7 w-7"
          title="Voice and video settings"
        >
          <SettingsIcon size={15} />
        </button>
      </div>
      {voiceSettingsOpen && (
        <VoiceSettingsDialogLoader
          open={voiceSettingsOpen}
          onClose={() => setVoiceSettingsOpen(false)}
        />
      )}
      {errorMessage && (
        <span className="text-xs text-danger-text" role="alert">
          {errorMessage}
        </span>
      )}
      {/* Icon buttons. Each aria-label is the text that the button showed before. */}
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={toggleCamera}
          aria-pressed={cameraOn}
          disabled={!cameraSupported}
          aria-label={cameraOn ? "Stop camera" : "Camera"}
          title={!cameraSupported ? "This browser does not support the camera." : cameraOn ? "Stop camera" : "Camera"}
          data-voice-camera={cameraOn}
          className={`icon-btn h-8 w-auto flex-1 ${cameraOn ? "bg-accent text-on-accent hover:bg-accent-hover hover:text-on-accent" : "bg-hover text-secondary"}`}
        >
          <VideoIcon />
        </button>
        {screenUnavailableReason ? (
          <span className="flex-1 text-xs text-muted" data-voice-screen-unavailable="true">
            {screenUnavailableReason}
          </span>
        ) : (
          <button
            type="button"
            onClick={toggleScreenShare}
            aria-pressed={screenOn}
            disabled={!screenShareSupported}
            aria-label={screenOn ? "Stop share" : "Share screen"}
            title={
              !screenShareSupported
                ? "This browser does not support screen sharing."
                : screenOn
                  ? "Stop share"
                  : "Share screen"
            }
            data-voice-screen={screenOn}
            className={`icon-btn h-8 w-auto flex-1 ${screenOn ? "bg-accent text-on-accent hover:bg-accent-hover hover:text-on-accent" : "bg-hover text-secondary"}`}
          >
            <ScreenIcon />
          </button>
        )}
        <button
          type="button"
          onClick={toggleMute}
          disabled={serverMuted}
          aria-label={muted || serverMuted ? "Unmute" : "Mute"}
          title={serverMuted ? "A moderator muted you. You cannot unmute yourself." : muted ? "Unmute" : "Mute"}
          aria-pressed={muted || serverMuted}
          data-voice-muted={muted || serverMuted}
          className={toggle(muted || serverMuted)}
        >
          {muted || serverMuted ? <MicOffIcon /> : <MicIcon />}
        </button>
        <button
          type="button"
          onClick={toggleDeafen}
          disabled={serverDeafened}
          aria-label={deafened || serverDeafened ? "Undeafen" : "Deafen"}
          title={
            serverDeafened
              ? "A moderator deafened you. You cannot undeafen yourself."
              : deafened
                ? "Undeafen"
                : "Deafen"
          }
          aria-pressed={deafened || serverDeafened}
          data-voice-deafened={deafened || serverDeafened}
          className={toggle(deafened || serverDeafened)}
        >
          {deafened || serverDeafened ? <HeadphonesOffIcon /> : <HeadphonesIcon />}
        </button>
        <button
          type="button"
          onClick={() => void leaveVoice()}
          aria-label="Disconnect"
          title="Disconnect"
          className="icon-btn h-8 w-auto flex-1 bg-danger text-white hover:bg-danger-hover hover:text-white"
        >
          <PhoneOffIcon />
        </button>
      </div>
      {serverMuted && (
        <span className="text-xs text-danger-text" role="status" data-voice-server-muted="true">
          A moderator muted you. You cannot unmute yourself.
        </span>
      )}
      {serverDeafened && (
        <span className="text-xs text-danger-text" role="status" data-voice-server-deafened="true">
          A moderator deafened you. You cannot undeafen yourself.
        </span>
      )}
    </div>
  );
}
