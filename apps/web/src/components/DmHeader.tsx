// The header of a DM or group DM: the other people, the group name (any
// member can change it) and the call button.
import { useState } from "react";
import { useStore } from "zustand";
import { dmDisplayName, dmOtherRecipients, renameGroupDm } from "@mortium/client-core";
import { groupDmNameSchema, type DmChannelJson } from "@mortium/shared";
import { Avatar } from "./Avatar.js";
import { session } from "../lib/session.js";
import { describeError } from "../lib/errors.js";
import { rememberDm } from "../lib/dms.js";
import { useRealtime } from "../lib/useRealtime.js";
import { joinVoiceChannel, leaveVoice, voiceStore } from "../lib/voice.js";

function GroupNameEditor({ channel, onDone }: { channel: DmChannelJson; onDone: () => void }) {
  const [name, setName] = useState(channel.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    const parsed = trimmed === "" ? null : groupDmNameSchema.safeParse(trimmed);
    if (parsed && !parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "This name is not valid.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      rememberDm(await renameGroupDm(session.apiClient, channel.id, { name: parsed ? parsed.data : null }));
      onDone();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={save} className="flex items-center gap-1">
      <input
        aria-label="Group name"
        value={name}
        autoFocus
        maxLength={100}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onDone();
        }}
        className="rounded border px-2 py-1 text-sm"
        style={{ backgroundColor: "var(--color-bg-sidebar)", borderColor: "var(--color-border)", color: "var(--color-text-primary)" }}
      />
      <button
        type="submit"
        disabled={pending}
        className="rounded px-2 py-1 text-sm"
        style={{ backgroundColor: "var(--color-accent)", color: "white" }}
      >
        Save
      </button>
      <button type="button" onClick={onDone} className="rounded px-2 py-1 text-sm">
        Cancel
      </button>
      {error && (
        <span role="alert" className="text-xs" style={{ color: "var(--color-danger-text)" }}>
          {error}
        </span>
      )}
    </form>
  );
}

export function DmHeader({ channel }: { channel: DmChannelJson }) {
  const selfUserId = useRealtime((s) => s.selfUserId);
  const callSize = useRealtime((s) => Object.keys(s.voiceStatesByChannel[channel.id] ?? {}).length);
  const connectedHere = useStore(voiceStore, (s) => s.status !== "idle" && s.channelId === channel.id);
  const [editing, setEditing] = useState(false);
  const others = dmOtherRecipients(channel, selfUserId);
  const name = dmDisplayName(channel, selfUserId);
  const isGroup = channel.type === "group_dm";

  return (
    <div className="flex items-center gap-2 border-b px-4 py-2" style={{ borderColor: "var(--color-border)" }}>
      {!isGroup && others[0] && <Avatar user={others[0]} size={24} />}
      {editing ? (
        <GroupNameEditor channel={channel} onDone={() => setEditing(false)} />
      ) : (
        <h1 className="truncate font-semibold" data-dm-title={name}>
          {name}
        </h1>
      )}
      {isGroup && !editing && (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="rounded px-2 py-1 text-xs"
          style={{ color: "var(--color-text-muted)" }}
        >
          Edit name
        </button>
      )}
      <div className="flex-1" />
      {connectedHere ? (
        <button
          type="button"
          onClick={() => void leaveVoice()}
          className="rounded px-3 py-1 text-sm font-medium"
          style={{ backgroundColor: "var(--color-danger)", color: "white" }}
        >
          Leave call
        </button>
      ) : (
        <button
          type="button"
          onClick={() => void joinVoiceChannel(null, channel.id)}
          className="rounded px-3 py-1 text-sm font-medium"
          style={{ backgroundColor: "var(--color-success)", color: "white" }}
        >
          {callSize > 0 ? "Join call" : "Start call"}
        </button>
      )}
    </div>
  );
}
