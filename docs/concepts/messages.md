# Channel events (messages, edits, reactions)

This note explains the event model for text chat: what the server stores,
what it never reads, and how a client finds its way through history.

## Why the server never reads message content

The app is end-to-end encrypted. The server treats the content of every
event as an opaque blob. Milestone M3 had only plain JSON content. The
server stores:

- `ciphertext`: raw bytes. The server never parses them.
- Plaintext routing metadata: the channel, the sender (user and device),
  the relation type and target, the codec, and the times.

A client decodes `ciphertext` with the codec named on the event. From
milestone M6, every new event uses the codec `megolm-v1`: the bytes are a
Megolm message, and the event has a `megolmSessionId`
(`docs/concepts/olm-megolm.md` section 8). The Megolm plaintext is the
UTF-8 JSON of `encodePlainPayload` in `packages/shared`. Old events from
milestone M3 use `plain-v1`: the bytes are that JSON with no encryption.
The server rejects a new `plain-v1` event with `PLAINTEXT_NOT_ALLOWED`,
but clients can still read the old ones. The server code that stores and
moves events does not read the bytes of either codec.

## The decrypted payload

Once a client decodes `ciphertext`, it gets one of three shapes,
discriminated by `type`:

- `message`: `body` (0 to 4000 characters), `mentions` (up to 50 user
  IDs), `attachments` (see `attachments.md`) and `embeds` (at most one
  link preview, see `link-previews.md`). A message needs a body unless it
  has an attachment.
- `edit`: `body` and `mentions`, same limits as a message.
- `reaction`: `key`, one emoji, 1 to 32 characters.

## Relations

An edit or a reaction is its own event, not a change to an old one. It
carries a plaintext `relatesToId` (the event it applies to) and a
`relType` (`edit` or `reaction`). A reply is also its own event, with
`relType` set to `reply`; unlike an edit or a reaction, a reply still
counts as part of the timeline.

This is why the server can order and paginate history correctly without
reading any content: `relType` is metadata, and it is metadata the server
must know, so it needs no encryption.

## The timeline and `lastEventId`

A channel's timeline is the events with `relType` set to `null` or
`reply`. Every text channel keeps a `lastEventId`, the newest timeline
event, updated in the same transaction as the insert. A client uses this
one field, together with its own read marker, to decide whether a channel
has anything unread, without fetching any events.

## Posting an event

`POST /channels/:id/events` takes `codec`, `megolmSessionId`,
`ciphertext`, a client-made `nonce`, and, for an edit, a reply or a
reaction, `relType` and `relatesToId`. The rules:

- A `megolm-v1` event needs `megolmSessionId`. A `plain-v1` event gets
  400 `PLAINTEXT_NOT_ALLOWED`, unless `ALLOW_PLAINTEXT_EVENTS` is true.

- A plain message or a reply needs `SEND_MESSAGES`.
- A reaction needs `ADD_REACTIONS` and `READ_MESSAGE_HISTORY`.
- An edit's target must be the caller's own, non-redacted timeline event
  in the same channel, or the server answers 403.
- A reply's or a reaction's target must exist in the same channel and not
  be redacted, or the server answers 404.

The `nonce` exists so a client can safely retry a post that may or may not
have reached the server (a dropped connection, a timeout): the same
(device, nonce) pair always returns the same event, with 200 instead of
201 the second time. A unique index on the database enforces this, so no
in-memory table is needed. The server checks the channel access before it
looks at the nonce. A nonce that the device used in a different channel
gets 409 `NONCE_USED`.

A user cannot post more than 10 events in 5 seconds; past that the server
answers 429 with `retryAfterMs`.

## Reading history

`GET /channels/:id/events` takes `before`, `after` or `around` (an event
ID), and `limit` (1 to 100, default 50). It needs `VIEW_CHANNEL` and
`READ_MESSAGE_HISTORY`. The response has:

- `events`: the requested page of timeline events, oldest to newest.
- `relations`: the non-redacted edits and reactions that target an event
  in that page, so a client can render them without a second request.
- `hasMoreBefore` / `hasMoreAfter`: whether paging again from this page's
  own oldest or newest event would return more.

A redacted timeline event still comes back, as a tombstone with an empty
`ciphertext`, so a reply that targets it can still show something.

## Redacting an event

`DELETE /channels/:id/events/:eventId` lets the author delete their own
event, or lets a `MANAGE_MESSAGES` holder delete someone else's timeline
event. The server sets `redactedAt`, wipes `ciphertext` to zero bytes, and,
in the same transaction, redacts every non-redacted edit or reaction that
targets the event. Deleting your own reaction is just deleting that
reaction event: there is no separate "remove reaction" route.

## Read state

`PUT /channels/:id/read` moves the caller's read marker forward, never
back. It dispatches `READ_STATE_UPDATE` to the caller's other sessions, so
a second device clears its unread badge too. `READY` and `GUILD_CREATE`
carry each channel's `lastEventId` and the caller's read markers, so a
freshly connected client can compute unread state at once, without a
history fetch.

## Gateway dispatches

After a post, an edit, a reaction or a redaction commits, the server sends
one dispatch to every current viewer of the channel (computed the same
way as any other channel event, described in `docs/concepts/gateway.md`):

- `EVENT_CREATE`: the new event, in the same wire shape `GET` returns.
- `EVENT_REDACT`: `{ channelId, ids }`, the redacted event and any
  relations redacted with it.

Typing uses the gateway directly, with no database row: the client sends
`TYPING` with a channel ID, and the server checks `VIEW_CHANNEL` and
`SEND_MESSAGES`, throttles to once per 3 seconds per user and channel, and
dispatches `TYPING_START` to the channel's other viewers. It never echoes
back to the person who is typing.
