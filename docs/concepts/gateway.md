# The gateway

This note explains the WebSocket gateway: the message envelope, the
sequence number, the heartbeat, resume, and how the server sends events
to the right users.

## The envelope

The gateway is one WebSocket connection at `/gateway`. Every message on
it is one JSON object with this shape:

```
{ op, t?, s?, d }
```

- `op` says what kind of message this is (hello, identify, heartbeat,
  dispatch, and so on).
- `t` names the event, only on a dispatch (for example `GUILD_CREATE`).
- `s` is the sequence number, only on a dispatch.
- `d` is the payload. Its shape depends on `op` and `t`.

## Sign-in on the connection

1. The server sends `HELLO` right after the connection opens. It carries
   the heartbeat interval.
2. The client must send `IDENTIFY` with its access token and device ID
   within 10 seconds, or the server closes the connection (code 4003).
3. The server checks the token. A bad or expired token closes the
   connection (code 4004). The device ID in the token must match the
   device ID in the `IDENTIFY` message.
4. On success, the server sends `READY`: the session ID, the caller's own
   user, every guild the caller is in (with the roles and the channels
   the caller can view), and the presence of online users who share a
   guild with the caller or are friends of the caller. It also has the
   friends and blocks, and the DMs and DM calls of the caller (see
   `docs/concepts/dms-and-friends.md`).

## Sequence numbers and dispatch

Each session (one connection, after it signs in) keeps its own counter,
starting at 1. Every event the server sends to that session (a
"dispatch") gets the next number in `s`. The client remembers the last
number it saw, so it can ask the server to resume from that point after a
short drop in the connection.

The server registers the session before it builds `READY`. A change in
that time makes a dispatch, but the dispatch waits in the session buffer.
The server sends these dispatches right after `READY`, in order. Thus no
dispatch arrives before `READY`. A dispatch can repeat a change that
`READY` already has. The client stores the new state of the object, so a
repeated dispatch does no harm. The client sets its last sequence number
to 0 when it sends `IDENTIFY`, not when `READY` arrives.

## Heartbeat

The client must send `HEARTBEAT` on the interval `HELLO` gave it. The
server answers with `HEARTBEAT_ACK`. If 1.5 times the interval passes
with no heartbeat, the server closes the connection (code 4009), but
keeps the session so the client can resume.

## Resume

A short network drop should not force a full reload of every guild and
channel. So the server keeps, for each session, the last 500 dispatches
it sent, for 60 seconds after the connection drops. Within that time, the
client can open a new connection and send `RESUME` with its session ID
and the last sequence number it saw. The server replays every dispatch
after that number, then sends `RESUMED`.

When resume is not possible (the session is gone, or the client asks for
a sequence number the server no longer has), the server sends
`INVALID_SESSION`. The client must then `IDENTIFY` again, as a new
session.

After the 60 seconds pass, the server drops the session and its buffer
for good, so memory use stays flat no matter how many connections have
come and gone.

## To-device messages

`TO_DEVICE` dispatches have no `s` and are not in the resume buffer. The
`to_device_queue` table is their durable store. The server sends queued
messages after `IDENTIFY`, after `RESUME` and when a new message arrives.
The client sends op `TO_DEVICE_ACK` (15) to delete processed messages.
See `docs/concepts/olm-megolm.md` section 6.

## Fan-out

The server never guesses who should get an event: it sends a dispatch
only after the change it describes is already committed to the database.
One in-process hub (`GatewayService`) keeps three indexes in memory, so it
never needs a database query to find *who* to send to:

- `userId -> sessions`: a user's live connections.
- `guildId -> userIds`: who is a member of a guild.
- `userId -> userIds`: the accepted friends of a user, for presence.

A DM has no index. Its recipients come from one query on
`channel_recipients`.

For most events (a guild is renamed, a member joins) the hub sends to
every member of a guild, or to one user, straight from these indexes.
For a channel event, the hub also checks, once per event, which of the
guild's members can currently view that channel (permission overwrites
can hide a channel from some members), and sends only to those.

## Presence

Presence is memory-only; it is not stored in the database. A user is
`online` once they have at least one live connection. `PRESENCE_SET` lets
a client choose `idle`, `dnd`, or `invisible`; invisible looks like
`offline` to everyone else. The server tells other users about a
presence change only when the status other people would see actually
changes, and only to users who share a guild with that person or are
friends of that person.

## Close codes

Every close code the gateway uses is in the 4000-4999 range, so it never
collides with a close code from the WebSocket protocol itself:

| Code | Meaning |
| --- | --- |
| 4000 | Unknown server error |
| 4001 | Unknown opcode |
| 4002 | The message could not be decoded |
| 4003 | No `IDENTIFY` or `RESUME` in time |
| 4004 | Sign-in failed (bad token, or device ID mismatch) |
| 4005 | Already identified on this connection |
| 4008 | Too many messages (over 120 a minute, or over 1200 `TO_DEVICE_SEND` ops a minute) |
| 4009 | No heartbeat in time |
| 4010 | The device was signed out, removed, or the password was reset |
