# Friends, DMs, DM calls and settings

This note explains friends, blocks, direct messages (DMs), group DMs, DM
calls and the synced settings. Read `docs/concepts/gateway.md` and
`docs/concepts/messages.md` first.

## Friends and blocks

Two users have one row each in `friendships`, one for each direction.

| Status | Meaning |
|---|---|
| `pending_outgoing` | This user sent a request. |
| `pending_incoming` | The other user sent a request. |
| `accepted` | The two users are friends. |
| `blocked` | This user blocked the other user. |

Every change to a pair runs in one transaction. The transaction holds an
advisory lock on the pair. Thus two requests at the same time cannot make
half a pair.

- `POST /users/@me/relationships` sends a request by username. If the
  other user already sent a request, the server accepts both requests.
- `PUT /users/@me/relationships/:userId` takes `accept` or `block`.
- `DELETE /users/@me/relationships/:userId` unfriends, cancels, declines or
  unblocks.
- A user can send 10 friend requests in one minute.

A block makes one `blocked` row, for the user who blocked. It removes the
other direction. The blocked user has no row and gets no event about the
block. A friend request to the blocker fails with 404 `USER_NOT_FOUND`, the
same answer as for a user that does not exist.

## DMs and group DMs

A DM is a channel with the type `dm` or `group_dm`. It has no guild. Its
people are in `channel_recipients`.

- A 1:1 DM is unique for a pair. The channel has a `dm_key` (the two user
  ids, the smaller first). A unique constraint on `dm_key` makes parallel
  requests safe: one insert wins, and the others read its row.
- `POST /users/@me/channels` with one id finds or makes the 1:1 DM. It
  answers 403 `CANNOT_MESSAGE_USER` when one user blocked the other.
- The same route with 2 to 9 ids makes a group DM. Each id must be a friend
  of the caller. A group DM has at most 10 people.
- `PUT` and `DELETE /channels/:id/recipients/:userId` change a group DM.
  The owner adds friends and removes anyone. Any member can remove
  themselves, which is a leave.
- When the owner leaves, the member who joined first becomes the owner.
  When the last member leaves, the server deletes the group DM.
- `PATCH /channels/:id` renames a group DM. Any member can do it.
- "Close DM" does not exist on the server. The client hides the DM and the
  history stays.

## Permissions in a DM

Every person in a DM can view the channel, send, read the history, add
reactions, attach files, connect, speak, share video and share the screen.
Nobody has a `MANAGE_*` permission. Thus a person can delete only their
own events. The mask is `DM_PERMISSIONS` in `packages/shared`.

The message code has one branch for the two kinds of channel:
`loadChannelAccess` in `apps/server/src/modules/messages/service.ts`. A
guild channel uses the member context. A DM checks `channel_recipients`. A
person who is not a recipient gets 404. In a 1:1 DM, a block stops all new
events, typing and calls in both directions. A block does not stop the
history or the deletion of an own event.

## Gateway dispatches

| Event | Sent to | Payload |
|---|---|---|
| `RELATIONSHIP_ADD` | The users of the pair | `{ userId, status, user }` |
| `RELATIONSHIP_REMOVE` | The users of the pair | `{ userId }` |
| `CHANNEL_CREATE` | The new recipients | A DM channel with `recipients` |
| `CHANNEL_UPDATE` | All recipients | A DM channel (rename, new owner) |
| `CHANNEL_DELETE` | A person who left or was removed | `{ id, guildId: null }` |
| `CHANNEL_RECIPIENT_ADD` | The other recipients | `{ channelId, user }` |
| `CHANNEL_RECIPIENT_REMOVE` | The other recipients | `{ channelId, userId }` |
| `CALL_RING` | The other recipients | `{ channelId, userId }` |
| `CALL_RING_STOP` | The people who were ringing | `{ channelId }` |
| `USER_SETTINGS_UPDATE` | Other devices of the user | `{ version }` |

`READY` has four new fields: `relationships`, `privateChannels`,
`privateVoiceStates` (the people in DM calls) and `incomingCalls` (the
calls that ring for the user now, as `CALL_RING` payloads). Event, typing and read
dispatches for a DM go to the recipients. The server finds them with one
query on `channel_recipients`.

## Friend presence

The gateway keeps an index of accepted friends in memory. It loads the
index at start. A presence change goes to the users who share a guild with
the person, and to the friends of the person. `READY` lists the online
users of both groups. When two users become friends, each gets the presence
of the other at once.

## DM calls

A person joins a DM call with `VOICE_JOIN` and the id of the DM. The voice
rules of `docs/concepts/voice.md` apply, with these changes:

- The voice state has `guildId: null`.
- The recipients of the DM get `VOICE_STATE_UPDATE`.
- A person who is not a recipient, or who is blocked, gets `NO_PERMISSION`.
- A person removed from a group DM also leaves its call.

When the first person joins, the server sends `CALL_RING` to the other
recipients. `CallRinger` keeps one timer for each ringing call. The ring
stops in three cases. Someone else joins the call. The caller leaves, in
any way, also when the disconnect grace period ends. Or 30 seconds pass.
Each case clears the timer and sends `CALL_RING_STOP`. A caller who moves
to another device does not ring again.

## Synced settings

`GET /users/@me/settings` returns `{ data, version }`. `data` is base64url
bytes, or null before the first save. `PUT /users/@me/settings` takes
`{ data, version }`. The data can have at most 64 KiB once decoded. The
`version` is the version that the client last read (0 for the first save).
A save with an old version fails with 409 `VERSION_CONFLICT`. A save that
works adds 1 to the version and sends `USER_SETTINGS_UPDATE` to the other
devices of the user.

The server never reads the bytes. The client encrypts the JSON with the
settings key of the user.

## The web client

- Home is at `/app/@me`. It shows the Friends page and the DM list. The
  list has the newest activity first. The realtime store keeps the newest
  event of each DM.
- A DM uses the same chat pane and message store as a guild channel. The
  guild id is null. Names come from the DM recipients and the friends.
- "Close DM" keeps the id of the newest event of the DM in the synced
  settings (`hiddenDms`). A newer event shows the DM again. Thus no save
  is necessary when a message arrives.
- `createSettingsStore` in client-core is the single place for synced
  settings: `hiddenDms`, `notificationLevels` (one level for each guild,
  "mentions" when not set) and `playRingSound`. A change applies at once.
  On `VERSION_CONFLICT` the store reads the server copy, puts the local
  keys on top, and tries one more time. `USER_SETTINGS_UPDATE` makes the
  store read a newer version.
- `CALL_RING` shows a ringing card above the user panel. A Web Audio tone
  plays while a card shows. "Decline" hides the card on this tab only.
- `shouldNotify` in client-core decides on a desktop notification. The
  web app shows it with `platform.notify` (the Notification API). The app
  asks for the permission only from a button in the account settings.
