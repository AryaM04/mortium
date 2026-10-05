# Voice signaling

This note explains the server's part of voice calls: the mesh design, the
gateway ops, peer identity, the disconnect grace period, and the member
cap. See `docs/concepts/nat-turn.md` for how a client reaches the TURN
server. The client side (the WebRTC mesh) is in
`packages/client-core/src/voice`.

## The mesh: the server never touches media

Voice and video are peer-to-peer. Every participant in a voice channel
opens one WebRTC connection to every other participant, and audio, video
and screen-share tracks flow straight between them. The server has two
jobs only:

1. Keep voice state in memory: who is in which channel, and their mute,
   deafen, video and screen-share flags.
2. Carry signaling messages (offers, answers and ICE candidates) between
   the participants as Olm to-device messages. The server cannot read
   them (see "Encrypted signaling" below).

The server never decodes, stores or forwards audio or video.

## A peer is a (user, device) pair

A "peer" is one live voice session: one user, connected from one
device. A user has at most one voice state at a time. Joining a voice
channel from a second device, or joining a different channel, replaces
the old voice state:

- The old session gets a `VOICE_STATE_UPDATE` with `channelId: null`, so
  its own client knows to tear down its call.
- Everyone who could see the old channel, and everyone who can see the
  new one, sees the move.

This matches how a real phone call works: a person is in one call at a
time, not two.

## The gateway ops

Voice uses three gateway ops from the client, and two kinds of dispatch
back:

| Client sends | Meaning |
| --- | --- |
| `VOICE_JOIN` | Join a voice channel, or move to it. It has a random `callId`. |
| `VOICE_LEAVE` | Leave voice. |
| `VOICE_STATE` | Change self-mute, self-deafen, video or screen-share. |

| Server sends | Meaning |
| --- | --- |
| `VOICE_STATE_UPDATE` | A peer's voice state changed (including a leave). |
| `VOICE_ERROR` | The op above was rejected, with a stable `code`. |

`VOICE_STATE_UPDATE` goes to every guild member who can currently view
the channel, the same rule the gateway already uses for channel events.
The voice state has the `callId` of the join.

A rejected op gets one `VOICE_ERROR` sent back to the caller alone. The
codes are: `CHANNEL_FULL`, `NO_PERMISSION`, `NOT_A_VOICE_CHANNEL`,
`STREAM_IN_USE` and `NOT_IN_VOICE`.

## Encrypted signaling

Each signal is an Olm to-device message (envelope type `voice.signal`,
see `docs/concepts/olm-megolm.md` section 6) to the exact device of the
peer. The client sends it with the gateway op `TO_DEVICE_SEND`. This op
has the same rules as `POST /to-device` (visibility, size, queue), and the
server keeps the order of the ops of one connection. The op has no
reply. The route and the op had almost the same delay in a local test
(median 14 ms and 13 ms). The op has no per-user request limit, and it
keeps the order of the signals.

The envelope content is `{ channelId, callId, targetCallId, payload }`.
Each join has a new random `callId`. The receiver drops a signal when one
of these is true:

- `channelId` is not the channel of the current call.
- `targetCallId` is not the `callId` of the current join of the receiver.
  Thus a queued signal for an earlier call does nothing.
- The Olm sender device is not the device in the voice state of the
  sender in this channel.
- `callId` is not the `callId` in that voice state.

Olm proves the sender device. Thus the server cannot read, change, add
or send again a signal. The DTLS fingerprints in the SDP are authentic,
so the server cannot put itself between two peers. The server can still
drop signals, or give a wrong `callId` in a voice state. Both only stop
the call.

The earlier plaintext relay (op 14, `VOICE_SIGNAL`) is removed. The
gateway closes a connection that sends it with `UNKNOWN_OPCODE`.

## Permissions

`VOICE_JOIN` needs `VIEW_CHANNEL` and `CONNECT` on the channel, or the
server answers `NO_PERMISSION`. A member who lacks `SPEAK` can still
join, but the server forces `selfMute` on; a later `VOICE_STATE` op that
tries to unmute is rejected the same way. Only one peer in a channel may
set `selfStream` at a time; a second peer trying to share their screen
gets `STREAM_IN_USE`.

## Signaling is never buffered for resume

To-device messages are not in the resume buffer. The queue table keeps
them (see `docs/concepts/olm-megolm.md` section 6). A client that comes
back later gets old signals from the queue. The call id check drops them,
because an old SDP offer or ICE candidate does not match the state of
either side now.

## The disconnect grace period

A voice call should survive a short network hiccup. When a session's
socket closes, its voice state is not removed at once. Instead, a grace
timer starts (15 seconds by default). If the client reconnects and
`RESUME`s within that time, the timer is cancelled and the voice state
stays exactly as it was: nobody else even sees a flicker. If the timer
fires first, the peer is removed and everyone who could see its channel
gets a `VOICE_STATE_UPDATE` leave.

Logout and device revoke skip the grace period: they remove the voice
state at once, because the device is deliberately gone, not merely
disconnected.

The timer is cleared whenever the peer's state changes for any other
reason (a resume, a move, a leave, a channel delete), so a stale timer
never fires against a peer that already left on its own.

## Caps and cleanup

A voice channel holds at most 10 peers; the 11th `VOICE_JOIN` gets
`CHANNEL_FULL`. The old voice state of the user who joins does not count,
so a rejoin into a full channel is possible. When a voice channel is deleted, every peer in it is
removed and told to leave. When a member leaves a guild, is removed
from it, or loses `VIEW_CHANNEL` or `CONNECT`
through a permission change, the same cleanup runs: the server calls
`revalidate` for that guild, which drops any peer whose current
permissions no longer allow them to be there.

All of this state lives only in memory, in `VoiceService`
(`apps/server/src/modules/voice/service.ts`). It holds no database rows
and starts empty on every restart: a voice call is a live session, not a
record, so this matches the resource rule in `CLAUDE.md` to keep memory
use flat.

## TURN credentials

`GET /api/v1/voice/turn-credentials` returns a STUN URL, a TURN URL
(UDP and TCP), and optionally a `turns:` (TURN over TLS) URL, together
with one set of time-limited credentials built by
`createTurnCredentials` (see `docs/concepts/nat-turn.md`). The route is
rate-limited and requires a signed-in caller; the credentials expire
after 12 hours.
