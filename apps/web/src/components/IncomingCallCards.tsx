// The ringing cards for incoming DM calls, above the user panel on every
// page. "Accept" joins the call and opens the DM. "Decline" hides the card
// on this tab only. The call goes on for the other people.
import { useLocation } from "wouter";
import { dmDisplayName } from "@mortium/client-core";
import { Avatar } from "./Avatar.js";
import { useRealtime } from "../lib/useRealtime.js";
import { memberUser } from "../lib/members.js";
import { declineCall, useIncomingCalls, type IncomingCall } from "../lib/ring.js";
import { joinVoiceChannel } from "../lib/voice.js";
import { dmPath } from "../lib/dms.js";

function IncomingCallCard({ call }: { call: IncomingCall }) {
  const state = useRealtime((s) => s);
  const [, navigate] = useLocation();
  const caller = memberUser(state, null, call.userId);
  const channel = state.privateChannels[call.channelId];
  const callerName = caller?.displayName ?? "Someone";
  const where = channel?.type === "group_dm" ? dmDisplayName(channel, state.selfUserId) : null;

  return (
    <div
      role="alertdialog"
      aria-label={`Incoming call from ${callerName}`}
      data-incoming-call={call.channelId}
      className="flex flex-col gap-2 border-t px-3 py-2"
      style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-main)" }}
    >
      <div className="flex items-center gap-2">
        {caller && <Avatar user={caller} size={32} />}
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{callerName}</div>
          <div className="truncate text-xs" style={{ color: "var(--color-text-muted)" }}>
            {where ? `Incoming call in ${where}` : "Incoming call"}
          </div>
        </div>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => {
            navigate(dmPath(call.channelId));
            void joinVoiceChannel(null, call.channelId);
          }}
          className="flex-1 rounded px-2 py-1 text-sm font-medium"
          style={{ backgroundColor: "var(--color-success)", color: "white" }}
        >
          Accept
        </button>
        <button
          type="button"
          onClick={() => declineCall(call.channelId)}
          className="flex-1 rounded px-2 py-1 text-sm font-medium"
          style={{ backgroundColor: "var(--color-danger)", color: "white" }}
        >
          Decline
        </button>
      </div>
    </div>
  );
}

export function IncomingCallCards() {
  const calls = useIncomingCalls();
  return (
    <>
      {calls.map((call) => (
        <IncomingCallCard key={call.channelId} call={call} />
      ))}
    </>
  );
}
