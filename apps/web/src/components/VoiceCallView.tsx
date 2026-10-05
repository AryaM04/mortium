// The main pane's view for the voice channel this tab is connected to: a
// responsive grid of tiles, one per participant, each a video when their
// camera is on or an avatar with a speaking ring when it is not. A screen
// share, local or remote, shows as one large tile above the others.
//
// Off-screen and hidden-page tiles stop rendering video: `srcObject` is
// detached so the decoder does no work, and reattached when the tile is
// visible again (CLAUDE.md: stop what is not in use). Clicking a tile
// focuses it full-size; clicking again returns to the grid. A fullscreen
// button on a video tile asks the browser's own fullscreen for that tile.
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { useRealtime } from "../lib/useRealtime.js";
import { voiceStore } from "../lib/voice.js";
import { avatarUrlOf, displayNameOf, memberUser } from "../lib/members.js";
import { ParticipantVolumeMenu, useParticipantMenu } from "./ParticipantVolumeMenu.js";
import { MaximizeIcon } from "./icons.js";

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}

/** True once the page is visible and the element is at least partly on screen. Used to pause video decoding for tiles nobody can see. */
function useTileVisible(ref: React.RefObject<HTMLElement | null>): boolean {
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === "visible");
  const [onScreen, setOnScreen] = useState(true);

  useEffect(() => {
    function onVisibilityChange() {
      setPageVisible(document.visibilityState === "visible");
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry) {
          setOnScreen(entry.isIntersecting);
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return pageVisible && onScreen;
}

function VideoTile({
  stream,
  name,
  avatarUrl,
  speaking,
  mirrored,
  large,
  onClick,
  canFullscreen,
}: {
  stream: MediaStream | null;
  name: string;
  avatarUrl?: string;
  speaking: boolean;
  mirrored: boolean;
  large: boolean;
  onClick?: () => void;
  canFullscreen?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const visible = useTileVisible(containerRef);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) {
      return;
    }
    el.srcObject = visible ? stream : null;
    return () => {
      el.srcObject = null;
    };
  }, [stream, visible]);

  function goFullscreen(event: React.MouseEvent) {
    event.stopPropagation();
    void containerRef.current?.requestFullscreen?.();
  }

  return (
    <div
      ref={containerRef}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      className="relative flex items-center justify-center overflow-hidden rounded-xl border border-line bg-elevated"
      style={{
        boxShadow: speaking
          ? "0 0 0 2px var(--color-success), 0 0 18px rgba(34, 197, 94, 0.25)"
          : undefined,
        aspectRatio: large ? "16 / 9" : "4 / 3",
        minHeight: large ? "240px" : "120px",
        cursor: onClick ? "pointer" : undefined,
      }}
    >
      {stream ? (
        <video
          ref={videoRef}
          muted
          playsInline
          autoPlay
          className="h-full w-full object-cover"
          style={{ transform: mirrored ? "scaleX(-1)" : undefined }}
        />
      ) : (
        <div
          className="flex items-center justify-center rounded-full bg-avatar font-semibold text-avatar-text"
          style={{
            width: large ? "96px" : "56px",
            height: large ? "96px" : "56px",
            fontSize: large ? "28px" : "18px",
          }}
          aria-hidden="true"
        >
          {avatarUrl ? (
            <img src={avatarUrl} alt="" className="h-full w-full rounded-full object-cover" />
          ) : (
            initialsOf(name)
          )}
        </div>
      )}
      <span className="absolute bottom-2 left-2 rounded-md bg-black/70 px-2 py-0.5 text-xs font-medium text-white backdrop-blur-sm">
        {name}
      </span>
      {stream && canFullscreen && (
        <button
          type="button"
          aria-label="Full screen"
          onClick={goFullscreen}
          className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-md bg-black/70 text-white hover:bg-black/85"
        >
          <MaximizeIcon size={14} />
        </button>
      )}
    </div>
  );
}

/** The call view of a guild voice channel, or of a DM call (guild id null). */
export function VoiceCallView({
  guildId,
  channelId,
}: {
  guildId: string | null;
  channelId: string;
}) {
  const states = useRealtime((s) => s.voiceStatesByChannel[channelId]);
  const selfUserId = useRealtime((s) => s.selfUserId);
  const realtimeState = useRealtime((s) => s);
  const voicePeers = useStore(voiceStore, (s) => s.peers);
  const localSpeaking = useStore(voiceStore, (s) => s.localSpeaking);
  const cameraOn = useStore(voiceStore, (s) => s.cameraOn);
  const screenOn = useStore(voiceStore, (s) => s.screenOn);
  const localCameraStream = useStore(voiceStore, (s) => s.localCameraStream);
  const localScreenStream = useStore(voiceStore, (s) => s.localScreenStream);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const { openForUserId, anchor, onContextMenu, close } = useParticipantMenu();

  const entries = states ? Object.values(states) : [];

  function nameOf(userId: string): { name: string; avatarUrl?: string } {
    return {
      name: displayNameOf(realtimeState, guildId, userId),
      avatarUrl: avatarUrlOf(memberUser(realtimeState, guildId, userId)),
    };
  }

  const tiles = entries.map((state) => {
    const isSelf = state.userId === selfUserId;
    const { name, avatarUrl } = nameOf(state.userId);
    if (isSelf) {
      return {
        key: "self",
        userId: state.userId,
        isSelf: true,
        name,
        avatarUrl,
        speaking: localSpeaking,
        stream: cameraOn ? localCameraStream : null,
        mirrored: true,
      };
    }
    const peer = voicePeers.find((p) => p.userId === state.userId);
    return {
      key: state.userId,
      userId: state.userId,
      isSelf: false,
      name,
      avatarUrl,
      speaking: peer?.speaking ?? false,
      stream: peer?.cameraStream ?? null,
      mirrored: false,
    };
  });

  const remoteSharerId = entries.find((state) => {
    if (state.userId === selfUserId) {
      return false;
    }
    return Boolean(voicePeers.find((p) => p.userId === state.userId)?.screenStream);
  })?.userId;

  const screenTile: {
    key: string;
    name: string;
    stream: MediaStream | null;
    avatarUrl?: string;
    speaking: boolean;
    mirrored: boolean;
  } | null = screenOn
    ? {
        key: "screen:self",
        name: `${nameOf(selfUserId ?? "").name} (you) is sharing their screen`,
        stream: localScreenStream,
        speaking: false,
        mirrored: false,
      }
    : remoteSharerId
      ? {
          key: `screen:${remoteSharerId}`,
          name: `${nameOf(remoteSharerId).name} is sharing their screen`,
          stream: voicePeers.find((p) => p.userId === remoteSharerId)?.screenStream ?? null,
          speaking: false,
          mirrored: false,
        }
      : null;

  const focused =
    focusedKey === screenTile?.key ? screenTile : (tiles.find((t) => t.key === focusedKey) ?? null);

  if (focused) {
    return (
      <div
        className="flex flex-1 flex-col gap-3 overflow-y-auto p-3"
        data-voice-call-view={channelId}
      >
        <VideoTile
          stream={focused.stream}
          name={focused.name}
          avatarUrl={focused.avatarUrl}
          speaking={focused.speaking}
          mirrored={focused.mirrored}
          large
          canFullscreen
          onClick={() => setFocusedKey(null)}
        />
      </div>
    );
  }

  return (
    <div
      className="flex flex-1 flex-col gap-3 overflow-y-auto p-3"
      data-voice-call-view={channelId}
    >
      {screenTile && (
        <VideoTile
          stream={screenTile.stream}
          name={screenTile.name}
          speaking={false}
          mirrored={false}
          large
          canFullscreen
          onClick={() => setFocusedKey(screenTile.key)}
        />
      )}
      <div
        className={screenTile ? "flex gap-2 overflow-x-auto" : "grid justify-center gap-3"}
        style={
          screenTile
            ? { flexShrink: 0 }
            : { gridTemplateColumns: "repeat(auto-fit, minmax(180px, 280px))" }
        }
      >
        {tiles.map((tile) => (
          <div
            key={tile.key}
            className={screenTile ? "w-40 flex-shrink-0" : undefined}
            onContextMenu={tile.isSelf ? undefined : (event) => onContextMenu(event, tile.userId)}
          >
            <VideoTile
              stream={tile.stream}
              name={tile.name}
              avatarUrl={tile.avatarUrl}
              speaking={tile.speaking}
              mirrored={tile.mirrored}
              large={false}
              onClick={() => setFocusedKey(tile.key)}
            />
          </div>
        ))}
      </div>
      {openForUserId && anchor && (
        <ParticipantVolumeMenu userId={openForUserId} anchor={anchor} onClose={close} />
      )}
    </div>
  );
}
