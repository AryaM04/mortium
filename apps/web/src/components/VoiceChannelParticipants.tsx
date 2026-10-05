// The list of people in one voice channel, shown under its row in the
// channel column. Speaking rings only show for the channel this tab is
// connected to, since that is the only channel with live audio data.
import { useStore } from "zustand";
import { useRealtime } from "../lib/useRealtime.js";
import { voiceStore } from "../lib/voice.js";
import { ParticipantVolumeMenu, useParticipantMenu } from "./ParticipantVolumeMenu.js";
import { serverUrl } from "../lib/server-url.js";
import { HeadphonesOffIcon, MicOffIcon, MoreIcon } from "./icons.js";

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}

export function VoiceChannelParticipants({
  guildId,
  channelId,
  live,
}: {
  guildId: string;
  channelId: string;
  live: boolean;
}) {
  const states = useRealtime((s) => s.voiceStatesByChannel[channelId]);
  const selfUserId = useRealtime((s) => s.selfUserId);
  const selfMember = useRealtime((s) => s.selfMemberByGuild[guildId]);
  const members = useRealtime((s) => s.membersByGuild[guildId]);
  const voicePeers = useStore(voiceStore, (s) => s.peers);
  const localSpeaking = useStore(voiceStore, (s) => s.localSpeaking);

  const { openForUserId, anchor, onContextMenu, openAt, close } = useParticipantMenu();

  const entries = states ? Object.values(states) : [];
  if (entries.length === 0) {
    return null;
  }

  return (
    <ul className="ml-6 mt-0.5 flex flex-col gap-0.5 pb-1">
      {entries.map((state) => {
        const isSelf = state.userId === selfUserId;
        const member = isSelf ? selfMember : members?.[state.userId];
        const name = member?.nickname ?? member?.user?.displayName ?? state.userId;
        const speaking =
          live &&
          (isSelf
            ? localSpeaking
            : (voicePeers.find((p) => p.userId === state.userId)?.speaking ?? false));

        return (
          <li
            key={state.userId}
            className="group flex h-7 items-center gap-2 rounded-md px-1.5 hover:bg-hover"
            data-voice-participant={name}
            data-voice-participant-muted={state.selfMute}
            data-voice-participant-deafened={state.selfDeaf}
            onContextMenu={isSelf ? undefined : (event) => onContextMenu(event, state.userId)}
          >
            <div
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-avatar text-[9px] font-semibold text-avatar-text"
              style={{ boxShadow: speaking ? "0 0 0 2px var(--color-success)" : undefined }}
              aria-hidden="true"
            >
              {member?.user?.avatarKey ? (
                <img
                  src={serverUrl(`/api/v1/avatars/${state.userId}/${member.user.avatarKey}`)}
                  alt=""
                  className="h-5 w-5 rounded-full object-cover"
                />
              ) : (
                initialsOf(name)
              )}
            </div>
            <span className="truncate text-xs text-muted">{name}</span>
            {state.selfMute && (
              <span aria-hidden="true" title="Muted" className="text-danger-text">
                <MicOffIcon size={12} />
              </span>
            )}
            {state.selfMute && <span className="sr-only">{name} has muted the microphone.</span>}
            {state.selfDeaf && (
              <span aria-hidden="true" title="Deafened" className="text-danger-text">
                <HeadphonesOffIcon size={12} />
              </span>
            )}
            {state.selfDeaf && <span className="sr-only">{name} has muted all sound.</span>}
            {!isSelf && (
              <button
                type="button"
                aria-label={`Volume for ${name}`}
                aria-haspopup="menu"
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  openAt(state.userId, rect.left, rect.bottom);
                }}
                className="icon-btn ml-auto h-5 w-5"
              >
                <MoreIcon size={14} />
              </button>
            )}
          </li>
        );
      })}
      {openForUserId && anchor && (
        <ParticipantVolumeMenu userId={openForUserId} anchor={anchor} onClose={close} />
      )}
    </ul>
  );
}
