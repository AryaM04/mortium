# End-to-end encryption: Olm and Megolm

This note is the protocol specification for milestone M6. Passes 2 to 4
implement against it. Pass 1 builds sections 1 to 6. Read ADR 0002 first.

Words in this note:

- **Device**: one sign-in (see `docs/architecture.md` section 4). Each
  device has its own keys.
- **Identity keys**: the Curve25519 key and the Ed25519 key of one device.
  They never change.
- **Olm**: a 1:1 encrypted channel between two devices (double ratchet).
- **Megolm**: a group ratchet. One sender device, many receiver devices.
- **To-device message**: an Olm message from one device to one device,
  through the server queue.

## 1. Threat model

The server is **honest but curious** for content. It stores and forwards
data correctly, but we assume that the operator (or a thief of the disk)
reads everything that the server has.

The server is **trusted for membership**. It says who is in a guild, a DM
or a channel, and which permissions they have. A malicious server can add
a fake member or a fake device. That member then gets new Megolm keys.
Clients reduce this risk:

- Device keys are signed. The server cannot change the keys of a device.
- The master key of each user is trusted on first use (TOFU). A change
  shows a loud warning and is never accepted silently. A SAS
  verification (section 10) confirms a master key.
- Only devices that the master key of their user signed get keys
  (section 4). Thus a fake device of a real user gets nothing.
- The channel shows a notice when a new member or a new device appears.

The server **cannot** read message text, file bytes, reactions, edits,
settings or WebRTC signaling. It **can** see this metadata:

- Who is in which guild, channel and DM, and their roles.
- Who sends a message or a to-device message to whom, when, and its size.
- The Megolm session id of each event and the event relations
  (`relates_to_id`, `rel_type`).
- The device list of each user and the number of one-time keys.
- Voice presence and the IP addresses of connections.

Not in scope: a compromised client device, a malicious web bundle from
the server (the web client trusts the code that the server sends; the
desktop apps do not), traffic analysis.

## 2. Encodings

- Curve25519 keys, Ed25519 keys and signatures use **unpadded standard
  base64**. This is the vodozemac form. The server and the clients do not
  change it.
- To-device ciphertext and Megolm ciphertext on the wire use base64url,
  as for all other binary data (`docs/architecture.md` section 2).
- **Canonical JSON** is the input of every signature. Rules: object keys
  in sorted order (by UTF-16 code unit), no white space, strings escaped
  as `JSON.stringify` does, only strings, booleans, null, safe integers,
  arrays and objects. The code is `canonicalJson` in `packages/shared`.
- Each signed object has a `type` field. Thus a signature for one purpose
  cannot be used for a different purpose.

## 3. Device identity and key upload

On the first sign-in, the device makes a vodozemac `Account`. It then
uploads its keys with `POST /keys/upload`:

```json
{
  "deviceKeys": { "curve25519": "...", "ed25519": "...", "signature": "..." },
  "oneTimeKeys": { "<keyId>": { "key": "...", "signature": "..." } },
  "fallbackKey": { "keyId": "...", "key": "...", "signature": "..." }
}
```

All parts are optional. The response is
`{ "oneTimeKeyCount": n, "needsFallbackKey": true|false }`.

Signed objects (the device Ed25519 key signs each one):

| Object | Canonical JSON input |
|---|---|
| Device keys | `{type:"device_keys", userId, deviceId, curve25519, ed25519}` |
| One-time key | `{type:"one_time_key", userId, deviceId, keyId, key}` |
| Fallback key | `{type:"fallback_key", userId, deviceId, keyId, key}` |

The `userId` and `deviceId` are in the signed object. Thus the server
cannot move keys to a different device or user.

Server rules:

- The server verifies each signature with `node:crypto`. It rejects a bad
  signature with 400. Clients still verify each signature themselves.
- Identity keys are set one time. The same keys again are accepted. Other
  keys give 409 `DEVICE_KEYS_EXIST`.
- One-time keys and fallback keys need the identity keys first.
- The server keeps at most 100 one-time keys for each device. The client
  keeps 50 (`max_number_of_one_time_keys`).
- A removed device (signed out, or removed from the device list) cannot
  upload. Its keys, one-time keys and queued messages are deleted.

`READY` has `oneTimeKeyCount` and `needsFallbackKey` for the device.

### One-time keys and fallback keys

`POST /keys/claim` takes `{ devices: [{ userId, deviceId }] }`. For each
device it removes one one-time key and returns it. The claim is atomic
(`DELETE ... FOR UPDATE SKIP LOCKED ... RETURNING`), so two callers never
get the same key. When no one-time key is left, the server returns the
fallback key with `fallback: true`, and marks the fallback key as used.

The client verifies the signature of the claimed key with the Ed25519 key
from its verified device list. It rejects a key with a bad signature.

The device keeps its keys topped up:

- It uploads 50 one-time keys and one fallback key at setup.
- When `READY` or an upload response shows fewer than 25 keys, it makes
  and uploads new keys until the server has 50.
- After each new inbound session, it counts down. At 25 it asks the
  server for the true count (an empty upload).
- When `needsFallbackKey` is true, it makes a new fallback key. vodozemac
  keeps the previous fallback key, so late messages still decrypt.

Crash safety: the client saves the account pickle after it makes keys and
before it uploads them. It marks the keys as published only after the
upload succeeds. The server ignores a key id that it already has.

## 4. Device lists and the master key

### Query

`POST /keys/query` takes `{ userIds }` (at most 500). The response has,
for each visible user, the master key and the devices with keys:

```json
{ "users": [ {
  "userId": "1",
  "masterKey": { "publicKey": "...", "deviceId": "...", "deviceSignature": "..." },
  "devices": [ { "deviceId": "...", "curve25519": "...", "ed25519": "...",
                 "signature": "...", "masterSignature": "..." } ]
} ] }
```

A user is **visible** to the caller when one of these is true: it is the
caller, the two users share a guild, the two users share a DM or a group
DM, or the two users are friends. The server omits other users. The same
rule controls `/keys/claim` and `/to-device`.

### Master key (simplified cross-signing)

Each user has one Ed25519 **master key**. It signs the device keys of the
devices of that user. There is no separate self-signing key.

- The first device of a user makes the master key. It uploads it with
  `PUT /keys/master`:
  `{ publicKey, deviceSignature, masterSignature }`.
  - `deviceSignature`: the device Ed25519 key signs
    `{type:"master_key", userId, publicKey}`.
  - `masterSignature`: the master key signs the device keys object of
    this device.
- The master key is set one time. A different key gives 409
  `MASTER_KEY_EXISTS`. Only the reset (below) replaces it.
- The same key again from a different device replaces `deviceId` and
  `deviceSignature` of the master key. The `masterSignature` proves that
  this device holds the master private key. The server sends
  `DEVICE_LIST_UPDATE`. A device that holds the master key does this at
  start when the device that vouches for the key is removed, and after it
  takes the key from the key backup.
- The master private key is **not** on every device. These devices hold
  it, encrypted with the pickle key: the device that made it, a device
  that got it from the key backup (section 9), and the device that did a
  reset.

### Signing the other devices of a user (pass 4)

A new device of a user is not signed. It becomes signed in one of two
ways:

1. **Verification.** The user verifies the new device from a device that
   holds the master key, with SAS (section 10). After the SAS, the device
   with the master key signs the new device.
2. **Recovery key.** The user enters the recovery key or the passphrase on
   the new device. The device decrypts the master private key from the key
   backup, checks that its public key is the master key of the user, keeps
   it, and signs itself (`POST /keys/upload` with `masterSignature`).

`POST /keys/signatures { deviceId, signature }` stores the master
signature of a different device of the same user. The server checks the
signature with the stored master key. It rejects a bad signature with 400
and a device of a different user with 403. It sends
`DEVICE_LIST_UPDATE`.

### Master key reset

A user who lost all signed devices and the recovery key cannot sign a new
device. `POST /keys/master/reset` takes the body of `PUT /keys/master` and
the account `password`:

- The server checks the password. A wrong password gives 401
  `INVALID_PASSWORD`. An account without a password (OAuth only) gives 403
  `PASSWORD_REQUIRED`. The route allows 5 tries in 15 minutes.
- It replaces the master key, removes the master signature of every other
  device of the user, signs the calling device, and deletes the key
  backup (the old master key is in it). It sends `DEVICE_LIST_UPDATE`.
- Other users see a changed master key: the loud warning below. They send
  no keys to that user until they accept the change.

### Which devices get keys

A device gets a Megolm key (`megolm.session`, `megolm.forward`, the
answer to `megolm.request`) and the settings key only when:

- the trusted master key of its user signed it (`ownerVerified`), and
- the master key of its user did not change since this device trusted it.

This rule is the same for the devices of other users and for the other
devices of the same user. A device that the server added cannot get
keys. The UI shows an unsigned device as "Not verified". A new sign-in
shows the blocking screen "Verify this device" in place of the app (the
security gate, `apps/web/src/components/SecurityGate.tsx`). It has two
ways forward: "Verify with another device" (SAS) and "Enter recovery
key" (a restore that also imports the master key). An account without a
key backup gets "Reset encryption" in place of the restore. There is no
way to skip the screen.
When the device becomes signed, it asks again for each key that it did
not get, and for the settings key.

Keys that an unsigned device sends are still accepted. The binding
signature of each session (section 8) still applies.

### Client verification

For each user in the query response, the client:

1. Verifies the signature of each device. It drops a device with a bad
   signature, a wrong `userId` or a wrong `deviceId`.
2. Keeps the first master key that it sees for this user (TOFU). A
   master key counts only when a listed device vouches for it: the
   `deviceSignature` of the device in `masterKey.deviceId` is valid, or a
   listed device has a `masterSignature` that the key made. Thus the key
   stays trusted when the device that made it is removed.
3. If the master key changes, it sets `changedMasterKey` for this user.
   The UI shows a loud warning. The client never replaces the stored key
   silently. The user must accept the new key (or verify it with SAS).
4. Marks a device as **owner-verified** when `masterSignature` verifies
   with the trusted master key.
5. Keeps the known identity keys of a device. If a device id appears with
   different identity keys, the client drops the new keys (identity keys
   never change).

The client tracks users: its own user, and later the members of each
encrypted channel. The gateway sends `DEVICE_LIST_UPDATE { userId }` to
each user who can see that user when a device gets keys, is removed, or
gets a master signature, or when the master key is set. The client marks
that user as outdated and queries again before the next encryption.
These events are lost while a device is offline, so after each new
`READY` (not `RESUMED`) the client marks all tracked users as outdated.

## 5. Olm sessions

### Create

To send to a device without a session, the client claims a one-time key,
verifies it, and calls `create_outbound_session`. The first messages are
pre-key messages (type 0). They stay pre-key messages until the other
device replies.

### Select

A device can have more than one session with a peer device. Each session
record has `createdAt` and `lastReceivedAt`. To send, the client uses the
session with the highest `max(createdAt, lastReceivedAt)`. This makes
both sides move to the newest working session.

To receive:

- A pre-key message: use the session where `session_matches` is true.
  If none matches, call `create_inbound_session`. This removes the
  one-time key from the account.
- A normal message (type 1): try each session, newest first.

The client keeps at most 5 sessions for each peer device. It deletes the
oldest.

### Recover a wedged session

A session is **wedged** when no session can decrypt a message from a peer
device, for example after a restore of old state. The receiver then:

1. Claims a new one-time key and makes a new outbound session.
2. Sends a `dummy` envelope on the new session.
3. Does this at most one time per peer device per hour.

The peer creates the inbound session from the pre-key message. Because
it is the newest session, both sides use it from then on. The lost
message is not recovered by Olm. Megolm key requests (pass 3) get the
lost room keys again.

### Per-peer order

All operations on the sessions of one peer device run in one queue. The
account has its own queue. A task that needs both takes the peer queue
first. Thus two tasks never use the same session at the same time.

Only one context of a device runs the crypto layer: the crypto
SharedWorker, or one tab when the browser has no SharedWorker. It holds
the Web Lock `crypto:<userId>:<deviceId>`. See section 13.

## 6. To-device messages

### Send

`POST /to-device` takes at most 100 messages. Each ciphertext is at most
64 KiB after base64url decode.

```json
{ "messages": [ { "userId": "2", "deviceId": "abc", "type": "olm.v1", "ciphertext": "<base64url>" } ] }
```

The ciphertext bytes are one byte for the Olm message type (0 or 1),
then the Olm message. The server rejects the whole request with 403 when
a recipient user is not visible (section 4). It skips unknown, removed or
keyless devices and lists them in `skipped`.

The queue keeps at most 10 000 messages for each recipient device. The
server deletes the oldest messages above that limit and writes a log
line. The route has a rate limit for each user.

### Deliver and acknowledge

The server sends `TO_DEVICE` dispatches:
`{ id, senderUserId, senderDeviceId, type, ciphertext, createdAt }`.

- `TO_DEVICE` is not in the resume buffer. The queue table is the durable
  store.
- Each gateway session has a window of 100 messages that are sent but not
  acknowledged. The server sends in id order.
- A row with a lower id can commit after a row with a higher id, because
  each request takes its ids before its transaction. Thus the server
  sends every queued row that it did not send to this session yet, also
  a row with a lower id than a row that it sent before.
- The client sends op `TO_DEVICE_ACK { upToId }` after it saved the
  result of each message up to that id. The server deletes only rows
  that it sent to this session: the rows that it sent before the row
  `upToId`, or every sent row up to `upToId` when it did not send that
  row. Then it sends more. The client never acknowledges an id at or
  above a message that still waits in its local queue.
- `TO_DEVICE_ACK { upToId, resync: true }` also tells the server to send
  again every queued message. The crypto layer sends it when it starts
  and after each `READY` or `RESUMED`.
- The server also starts a delivery after `IDENTIFY` and `RESUME`.
- The client drops a message with an id that it already processed. It
  keeps the last 1000 processed ids for this check, not only the highest
  id. It acknowledges the copies too. It sends one acknowledgement when
  its local queue is empty, at most one time in 2 seconds.
- Each tab of a device has its own gateway session. The crypto worker
  drops the copies, and only one tab sends the acknowledgements (see
  section 13).

### Envelope

The Olm plaintext is a versioned JSON envelope:

```json
{
  "v": 1,
  "id": "<16 random bytes, base64url>",
  "type": "dummy",
  "content": {},
  "sender": { "userId": "1", "deviceId": "abc", "ed25519": "..." },
  "recipient": { "userId": "2", "deviceId": "def", "curve25519": "..." },
  "ts": 1790000000000
}
```

Olm proves that the sender holds the Curve25519 key of the session. The
envelope binds the rest. The receiver accepts the envelope only when all
of these are true:

- `v` is 1.
- `sender.userId` and `sender.deviceId` are the sender that the server
  reported in the dispatch.
- The Curve25519 key of the Olm session belongs to that device in the
  verified device list, and `sender.ed25519` is the Ed25519 key of that
  device.
- `recipient.userId`, `recipient.deviceId` and `recipient.curve25519` are
  the values of the receiving device.
- The `id` was not seen before (the client keeps the last 1000 ids).

Thus the server cannot forward a message to a different device, or say
that it comes from a different device.

Envelope types: `dummy` (session recovery), `debug.ping` (development
only), and from pass 2: `megolm.session`, `megolm.forward`,
`megolm.request`, `voice.signal` (see `docs/concepts/voice.md`),
`settings.key` and `settings.request` (section 11), and from pass 4 the
`verification.*` types (section 10).

Voice signals use the gateway op `TO_DEVICE_SEND { messages }`. It has
the same rules as `POST /to-device` (visibility, size, queue) and no
reply. The server stores the ops of one connection in the order that they
arrive.

The client saves the session state, the account state and the seen id
in one IndexedDB transaction. It saves the queue id only after the
handlers of the event are done. A temporary error (no network, a rate
limit, a server fault or a storage error) keeps the message first in the
local queue. The client tries it again after 1 second, then after a
longer time each time, up to 30 seconds, and at once after `READY` or
`RESUMED`. Only the handlers that did not finish run again. A message
that fails for good is dropped and acknowledged. Olm can
decrypt a message only one time, so a crash after the save and before the
end of the handlers loses the event. Megolm key requests (pass 3) get lost
room keys again.

## 7. Local store and the pickle key

The `CryptoStore` is one IndexedDB database for each user and device:
`crypto:<userId>:<deviceId>`. It holds the account pickle, the Olm
sessions of each peer device, the device list cache with the tracked
users and the outdated flags, the TOFU master keys, the master private key
(when this device has it), the seen envelope ids and the last processed
queue id.

vodozemac encrypts each pickle with a 32-byte **pickle key**. The pickle
key is random. It is kept through `platform.secureStore`:

- Web: the secure store encrypts each value with an AES-GCM `CryptoKey`
  that is **not extractable**. The `CryptoKey` object is kept in
  IndexedDB.
  - Gain: a copy of the IndexedDB files (a disk image, a backup, a
    different program on the computer) does not give the pickle key,
    because the browser keeps the raw AES key outside of the page data in
    a form that the page cannot export.
  - Limit: code that runs in the page (for example XSS) can still use the
    key to decrypt. The browser profile folder also has the key material.
    This protects against offline copies, not against a live attack.
- Tauri and Electron (M7): the OS key store (Keychain, Credential
  Manager, libsecret) keeps the value.

## 8. Megolm (pass 2 and pass 3)

Pass 2 builds this section. The code is `packages/client-core/src/crypto/megolm.ts`
and `membership.ts`.

### Readers of a channel

A user may **read** a channel when it has `VIEW_CHANNEL` and
`READ_MESSAGE_HISTORY`. Only readers get keys. In a DM or a group DM,
every recipient is a reader.

- `GET /channels/:id/members` gives the users who can view the channel,
  with the roles, the overwrites and the owner. The caller must be able
  to view the channel. The server computes the permissions in memory.
- The client computes the permissions again with `computePermissions` in
  `packages/shared`, and keeps only the readers. It fetches the list
  lazily, only for the channels where it sends or answers.
- The client keeps the result for at most 10 minutes. These gateway events
  clear it: `READY`, `GUILD_MEMBER_*`, `GUILD_ROLE_*`, `GUILD_BAN_ADD`,
  `GUILD_CREATE`, `GUILD_DELETE`, `CHANNEL_CREATE`, `CHANNEL_UPDATE`,
  `CHANNEL_DELETE` and `CHANNEL_RECIPIENT_*`.

### Send

- Each sending device has one outbound Megolm session for each channel.
  DMs and group DMs are channels.
- The event has `codec: "megolm-v1"` and `megolmSessionId` in clear text.
  The Megolm plaintext is the `DecryptedPayload` JSON of the message
  codec (`docs/concepts/messages.md`). On the wire, the Megolm message is
  base64url.
- Before each encryption, the client gets the current readers and their
  verified devices. Then it does these steps, in this order:
  1. **Rotate** the outbound session when one of these is true: it
     encrypted 100 messages; it is 7 days old; a reader device that the
     sender saw while the session was in use is not a reader device now
     (leave, kick, ban, role change, overwrite change, recipient removed,
     sign-out, new identity keys); the session is marked for rotation
     (see below).
  2. **Share** the session key (`megolm.session`) with each reader device
     that does not have it, from the current index. This includes the
     other devices of the sender. A new device of a reader
     (`DEVICE_LIST_UPDATE`) thus gets the key before the next message. A
     device that fails gets no new try for 60 seconds.
  3. Encrypt, and save the session before the event goes out.
- The rotation check runs at the next send, with the membership that the
  events above keep fresh. Thus the client never shares a key with a
  device that is not a reader at that moment.
- A reader can forward an outbound session that is still in use (history
  share, key request). The sender does not see that. Thus the sender
  marks its outbound sessions for rotation when a reader can have gone:
  - at once for `GUILD_MEMBER_REMOVE`, `GUILD_BAN_ADD`, `GUILD_DELETE`,
    `CHANNEL_DELETE` and `CHANNEL_RECIPIENT_REMOVE` (in the scope of the
    event), and for `READY` (all sessions: events can be lost while the
    gateway is down);
  - after a role or overwrite change, when the new reader list lacks a
    user of the reader snapshot of the channel.
- The sender also keeps an inbound copy of its own session, so all its
  devices decrypt the same way.

### Session binding

When the sender makes a session, its device Ed25519 key signs
`{type:"megolm_session", channelId, sessionId, userId, deviceId}`. The
signature goes in `megolm.session` and in each `megolm.forward`.

- `megolm.session { channelId, sessionId, sessionKey, signature }`: the
  receiver checks the signature with the key of the Olm sender device,
  and that the session id of the key is `sessionId`.
- `megolm.forward { channelId, sessionId, sessionKey, senderUserId,
  senderDeviceId, senderEd25519, signature }`: `sessionKey` is exported at
  the first known index. When the sender device is in the verified device
  list, `senderEd25519` must be its key. The signature must verify with
  `senderEd25519`.
- The session id is the public key of the session, so it is unique. The
  first sender that a session id arrives with owns it. A later key for
  the same id with a different sender or channel is rejected. A later key
  with an earlier first index replaces the stored one.

### Receive

The receiver finds the inbound session by the session id of the event.
It shows "This message cannot be read." and never throws when one of
these is true:

- The session belongs to a different channel, user or device than the
  event names.
- The sender device is still in the device list, but with a different
  Ed25519 key than the session came with.
- The Megolm message does not decrypt (Megolm also checks the signature
  of the message).
- The message index was already used by a different event id (a replay).
  The client keeps the event id of each index of each session.

When the session is not there (or the message is older than its first
index), the message shows "This message cannot be read yet. The app asks
for the key." The client asks for the key, and decodes the event again
when the key arrives. No reload is necessary.

### History for new readers (`megolm.forward`)

- The client keeps a snapshot of the readers of each channel where it
  has a session. After a membership event (1 second debounce), it
  compares the readers with the snapshot.
- For each new reader, the online devices of the old readers are sorted.
  The first device sends each inbound session of the channel at once.
  The next two devices send after a random delay of 20 to 40 seconds,
  in case the first device is not really online. The other devices send
  nothing. A device sends the history of one channel to one user at most
  one time in 10 minutes.
- Before it sends, the device checks again that the user is a reader.
- The receiver keeps only the best key of each session, so a second copy
  does nothing.

### Key requests (`megolm.request { channelId, sessionId }`)

- A device that cannot decrypt an event asks the devices of its own user,
  the devices of the sender, and the devices of at most 3 other readers
  (online users first). The other readers are necessary: after a new
  sign-in, the old device of the user can be gone, and only other
  members have the keys.
- Tries: at once, then after 5 s, 30 s, 2 min and 10 min. It stops when
  the key arrives. After `READY` or `RESUMED`, the open requests go out
  again at once.
- A device answers only when the requester device may get keys (section
  4), when the requester user is a reader now, and at most one time in 30
  seconds for each requester device and session. The answer is a
  `megolm.forward` to the requester device only.
- A request with no answer after the last try is kept (at most 1000).
  When the device becomes signed, it tries each one again.

### Storage and memory

- The crypto store (IndexedDB version 2) keeps the outbound sessions, the
  inbound sessions and the reader snapshots. The pickles are encrypted
  with the pickle key.
- At most 100 inbound sessions stay unpickled in memory (least recently
  used). The store keeps all of them.

### Plaintext

The server rejects a new `plain-v1` event with 400
`PLAINTEXT_NOT_ALLOWED`. `ALLOW_PLAINTEXT_EVENTS=true` turns the check
off, for old development clients only. The clients never send `plain-v1`.
They can still read old `plain-v1` events.

### Deviations from the first draft of this section, and why

- Readers need `READ_MESSAGE_HISTORY` as well as `VIEW_CHANNEL`, for the
  live key share too. A user without history permission therefore cannot
  read new messages either. Reason: one rule for the key share and the
  history share is simpler to check, and it never gives a key that the
  history rule would refuse.
- The receiver finds a session by its session id, not by the Curve25519
  key of the sender device and the session id. The record keeps the
  sender that was verified when the key arrived. Reason: a sign-out
  removes the device from the device list, and the messages of that
  device must stay readable.
- The session binding signature is new. Reason: without it, a member
  that has a key could forward it and say that a different device made
  it.
- A forward for a sender device that is not in the device list now (for
  example after its sign-out) is accepted when its signature verifies
  with the `senderEd25519` in the forward. Thus the forwarder vouches for
  that key. Risk: a member with a key can say that a removed device of a
  different user made a session. That is useful only together with a
  server that forges events, and the first-owner rule stops it for a
  session that the receiver already has.
- Key requests also go to up to 3 other readers (see above).
- A second tab of the same device waits for the Web Lock of the crypto
  layer. Until it gets the lock, it cannot encrypt or decrypt. It shows
  the banner "Encryption runs in another tab of this app. Use that tab,
  or close it." (section 13).

## 9. Key backup (pass 4)

The code is `packages/client-core/src/crypto/key-backup.ts`,
`recovery-key.ts` and `packages/crypto-wasm/src/backup.rs`.

### Recovery key and passphrase

- The **recovery key** is 32 bytes. The app shows it one time.
- Text form (the Matrix form): the bytes `0x8B 0x01`, the 32 key bytes,
  and one parity byte (the XOR of all bytes before it), in base58
  (Bitcoin alphabet), in groups of 4 characters. The parity byte finds a
  wrong character before a download. Spaces do not count.
- Without a passphrase, the key is random. With a passphrase, the key is
  Argon2id (version 0x13) of the passphrase, with m = 64 MiB, t = 3,
  p = 1, a random 16-byte salt and a 32-byte output. The app still shows
  the key: it and the passphrase open the same backup. The client refuses
  parameters above m = 256 MiB, t = 10, p = 4 (the server stores them).
- To set up a backup, the user sees the key and types its last group
  again. Only then does the client make the backup on the server.
- The backup is necessary (CRY-09). Else a sign-out of the only device
  loses the master key. A device that holds the master key and finds no
  backup on the server shows the blocking screen "Save your recovery
  key" in place of the app. This occurs after the sign-up, after a reset
  of the identity, and one time for accounts from before this rule.

### Backup key pair and encryption

The labels in this section keep the old project name on purpose.
A new label would make old backups unreadable.

- The backup secret key is HKDF-SHA256 of the recovery key (no salt,
  info `discord-clone:backup-key:v1`, 32 bytes), used as an X25519
  secret. The public key is in the backup version.
- Encryption to the public key `P` (ECIES):
  1. Make a new X25519 key `e` for each message. `E = e·G`.
  2. `S = X25519(e, P)`. Refuse an all-zero result.
  3. `okm = HKDF-SHA256(ikm = S, salt = E ‖ P, info =
     "discord-clone:backup-ecies:v1", 44 bytes)`. The AES-256-GCM key is
     the first 32 bytes, the nonce is the last 12 bytes. The key `e` is
     new for each message, so a nonce never repeats for one AES key.
  4. Output: the version byte `1`, `E` (32 bytes), then the AES-GCM
     ciphertext and its 16-byte tag.
- The associated data is canonical JSON:
  - a session: `{type:"backup_session", userId, version, sessionId}`;
  - a secret: `{type:"backup_secret", userId, version, name}`.
  Thus the server cannot move an item to a different user, version,
  session or secret name.
- `packages/crypto-wasm/src/backup.rs` has test vectors. An independent
  check with `node:crypto` and the Argon2 reference code gave the same
  values.

### What the backup holds

- **Sessions.** Each inbound Megolm session, exported at its first known
  index, as the JSON of a `megolm.forward` (`channelId`, `sessionId`,
  `sessionKey`, `senderUserId`, `senderDeviceId`, `senderEd25519`,
  `signature`). The server also sees `channelId`, `sessionId` and the
  first index in clear text. It already knows them from the events.
- **Secrets.** `master` (the 32 secret bytes of the master key) and
  `settings:<keyId>` (each settings key). The plaintext is
  `{name, value, signer, signature}`. The master key (`signer: "master"`)
  or the uploader device signs `{type:"backup_secret", userId, name,
  value}`. Anyone can encrypt to the public key, so this signature stops
  the server from adding a settings key of its own. The master secret
  proves itself: its public key must be the master key of the user.

### Routes

Only the owner reaches its backup. A version of a different user gives
404 `BACKUP_NOT_FOUND`.

- `POST /keys/backup/version { publicKey, authData }` → 201 `{ version }`.
  `authData` is `{ passphrase, deviceId, signature, masterSignature }`.
  The Ed25519 key of the device `deviceId` of the caller signs
  `{type:"key_backup", userId, publicKey, passphrase}`. The master key
  signs the same text when the device holds it (else null). The server
  checks the device signature. A new version deletes the old version with
  its sessions and secrets: there is one version for each user.
- `GET /keys/backup/version` → `{ backup: { version, publicKey, authData,
  secrets } | null }`.
- `DELETE /keys/backup/version/:version` → 204.
- `PUT /keys/backup/sessions { version, sessions }`: at most 100 sessions,
  each at most 8 KiB. For a known session id, the server keeps the copy
  with the lower first index. The response is `{ stored }`.
- `GET /keys/backup/sessions?version=&channelId=&after=&limit=`: in
  session id order, at most 500 in a page. `next` is the `after` value of
  the next page, or null.
- `PUT /keys/backup/secrets { version, secrets }`: at most 16 secrets in
  one backup.

### Trust in a backup version

A device uploads to a backup version only when one of these is true:

- this device made it, or opened it with the recovery key (the client
  keeps this in the store);
- the trusted master key of the user signed the auth data;
- a device of the user that may get keys (section 4) signed the auth data.

Else a malicious server could put in its own public key and read each
key that the devices upload.

### Upload

- After a new version, at start, after `READY` and when this device
  becomes signed, the client gets the current version and checks it.
- It uploads the secrets that the backup does not have (the master key
  when this device holds it, and the settings keys).
- It scans the inbound sessions (200 at a time) and uploads each session
  whose `backupVersion` is not the current version, in batches of 50,
  with 1 second between batches. After each batch it marks the sessions
  with the version (only when their first index did not change). Thus
  the upload can stop and go on later.
- A new or better key starts an upload after 2 seconds.
- `BACKUP_NOT_FOUND` means that a different device made a new version or
  deleted the backup: the client gets the version again.

### Restore

1. Get the version. Decode the recovery key text, or derive the key from
   the passphrase with the stored parameters.
2. The backup public key of the key must be the public key of the
   version. Else: "This recovery key or passphrase does not open the key
   backup."
3. Decrypt `master`. When its public key is the master key of the user,
   keep it and sign this device.
4. Decrypt the settings keys with a valid signature and add them.
5. Download the sessions in pages. Each session gets the checks of a
   `megolm.forward` (section 8). It is saved with `backupVersion`, so it
   is not uploaded again. Each new key re-decodes the events that wait
   for it. The UI shows the number of keys.

## 10. Verification (pass 4)

The code is `packages/client-core/src/crypto/verification.ts` and the
`Sas` type in `packages/crypto-wasm/src/sas.rs` (vodozemac SAS).

Two devices compare 7 emojis. The emojis are the same only when each
device has the real Curve25519 key of the other device. The messages are
Olm to-device envelopes, so they are bound to the device keys. The SAS
checks that the server gave the right device keys.

### Messages

Each message has `txnId` (16 random bytes, base64url).

| Type | From | Content |
|---|---|---|
| `verification.request` | initiator, to each target device | `methods: ["sas.v1"]` |
| `verification.ready` | the device that accepts | — |
| `verification.start` | initiator | `method`, `commitment` |
| `verification.key` | responder, then initiator | `key` (SAS Curve25519 public key) |
| `verification.mac` | both | `keys`, `keyIds` |
| `verification.done` | both | `signed` (same user only) |
| `verification.cancel` | either | `code` |

1. The initiator sends `request` to the other devices of its user (or one
   of them), or to the devices of a different user.
2. The first device that accepts sends `ready`. The initiator sends
   `cancel` with `accepted` to the other devices.
3. The initiator makes a SAS key and sends `start` with
   `commitment = base64url(SHA-256(key + "|" + txnId))`.
4. The responder sends its key. Then the initiator sends its key. The
   responder checks the commitment. Thus neither device can choose its
   key after it saw the other key.
5. Both devices show 7 emojis: vodozemac SAS bytes with the info
   `MORTIUM_SAS_EMOJI_V1|<initiator userId>|<deviceId>|<key>|<responder userId>|<deviceId>|<key>|<txnId>`,
   and the Matrix emoji table.
6. The user clicks "They match". The device sends `mac`: a MAC of its
   Ed25519 key (key id `ed25519:<deviceId>`), a MAC of the master key of
   its user (key id `master`), and a MAC of the sorted key ids. The MAC
   info is `MORTIUM_SAS_MAC_V1|<sender userId>|<deviceId>|<receiver userId>|<deviceId>|<txnId>|<keyId>`.
7. The receiver checks each MAC with the keys in its device list. The
   master MAC must match the trusted master key or the new key of an
   identity change. For a different user, the master MAC is necessary.

### Result

- Two devices of one user: the device that holds the master key signs the
  other device when it is not signed (`POST /keys/signatures`). Then it
  sends `done` with `signed`. The dialog says if both devices are signed
  now. When no device holds the master key, the dialog tells the user to
  enter the recovery key.
- A different user: the client marks the master key of that user as
  verified (a badge in the member menu). It is stronger than trust on
  first use. A verified new key after an identity change is accepted.

### Rules

- "They do not match" sends `cancel` with `mismatch`. Nothing is signed.
- A bad MAC or a bad commitment cancels the verification.
- A verification stops after 10 minutes (`timeout`).
- One verification at a time for each pair of devices. A request from a
  device with a verification in progress gets `cancel` with `busy`.
- The verification state is only in memory. A restart ends it.

## 11. Encrypted settings (pass 3)

The synced settings blob (`PUT /users/@me/settings`) is encrypted with
the **settings key** of the user: one random AES-256-GCM key. The code is
`packages/client-core/src/crypto/settings-key.ts`.

- Blob: one version byte (1), the 8-byte key id, a 12-byte IV, then the
  AES-GCM ciphertext of the settings JSON. The version byte and the key id
  are the additional data. An old plaintext blob starts with `{`. The
  client reads it, and the next save encrypts it.
- The first device that saves settings, when the server blob is empty or
  plaintext, makes the key. It sends `settings.key { keyId, key }` to each
  other device of the same user in the verified device list.
- A device that reads a blob with an unknown key id sends
  `settings.request { keyId }` to its other devices (at most one time a
  minute). A device that has the key answers with `settings.key` (at most
  one time in 30 seconds for each device). The receiver accepts
  `settings.key` only from a device of the same user, and never replaces a
  known key id with a different value.
- Until the key arrives, the device is **locked**: it shows the defaults
  and its own changes, and it never writes the server blob. When the key
  arrives, it reads the blob again, puts its changes on top and saves.
- The crypto store keeps the keys, encrypted with the pickle key.
- The key backup keeps the settings keys (section 9).
- Since pass 4, only a signed device (section 4) gets the key, and a
  device accepts `settings.key` and `settings.request` only from a signed
  device of the same user.

Deviations and why:

- Two new devices can make two keys at the same time. The second save
  then gets `VERSION_CONFLICT`, reads a blob with the other key, and is
  locked until that key arrives. Its own key is never used again.

## 12. Deviations of pass 4 from the plan, and why

- There is no separate self-signing key. The master key signs the
  devices, as in pass 1. Reason: one key is simpler, and the master
  private key is on few devices (section 4).
- A SAS-verified device does not get the master private key. Thus it
  cannot sign a different device. Reason: the plan keeps the key on few
  devices. The recovery key on that device, or a SAS with a device that
  holds the key, gives the signature.
- The backup encryption is our own ECIES (section 9), not HPKE. Reason:
  it uses the crates that vodozemac already has (hkdf, sha2, aes), so the
  WASM file stays small. Argon2id, AES-GCM and SAS add 14 kB gzip to the
  WASM file (157 kB to 171 kB), less than the 60 kB limit, so Argon2 stays
  in the same WASM file.
- The secrets in the backup have a signature inside the ciphertext.
  Reason: anyone can encrypt to the backup public key, so the server
  could add a settings key of its own.
- The master key reset needs the account password. An account with only
  OAuth sign-in must set a password first.
- A new backup version deletes the old one. Reason: one version is
  simpler, and an old version has no use.

## 13. More than one tab

The Olm and Megolm state of a device must have one owner. Two owners
would use the same one-time keys and ratchets, and they would break
sessions. The owner holds the Web Lock `crypto:<userId>:<deviceId>`.

### The crypto layer in a SharedWorker (M9)

- **Owner.** The browser runs one `SharedWorker` for each device. Its
  name is `crypto:<userId>:<deviceId>`
  (`apps/web/src/lib/crypto-worker.ts`). It holds the device lock while
  it runs `startCrypto`. It loads the WASM file, opens the crypto store,
  tracks the device lists, keeps the one-time keys, handles the to-device
  messages, shares and asks for Megolm keys, uploads the key backup, and
  holds the settings key. It also writes the local search index, so two
  tabs never write the index at the same time.
- **Lock.** The worker gets the device lock before it starts the crypto
  layer. A worker of a different build has a different script URL, thus
  it is a different worker. It waits for the lock, and its tabs show the
  banner "Encryption runs in another tab of this app. Use that tab, or
  close it." A tab of an old build without the worker holds the same
  lock. Thus two owners never write the state at the same time.
- **RPC.** Each tab gets a `MessagePort`
  (`packages/client-core/src/crypto/client.ts`, `host.ts`, `rpc.ts`).
  The tab sends `{ id, method, args }`, and the worker sends
  `{ id, value }` or `{ id, error }`. An error keeps its name, message,
  `code` and `status`, so an `ApiError` stays an `ApiError`. The tab
  loads only the client (about 2 kB gzip). It never loads the WASM file.
  - `security.setUpBackup` gives a token. The worker keeps the `create`
    function, and `security.createBackup` uses the token.
  - `security.restoreBackup` sends `progress` messages with the id of the
    call.
  - The ciphertext of `codec.encode` moves to the tab as a transferred
    `ArrayBuffer`. Attachments do not cross the port: the tab encrypts
    each file with its own AES-GCM key (see `attachments.md`).
- **Events.** The worker sends `keys`, `settingsKey`, `security`,
  `verification` (with the new list) and `toDevice` events to every tab.
  The worker does not send the to-device types that it uses itself
  (`megolm.*`, `settings.*`, `verification.*`), so room keys stay in the
  worker. Each tab keeps its own listeners.
- **Network.** The worker has no session tokens and no gateway. It sends
  each network call of `CryptoTransport` to one tab, the **ack tab**. The
  tab makes the call with its API client or its gateway, and sends the
  result back.
- **Presence.** Each tab sends the list of offline users. The worker uses
  the last list for the history rule of section 8.

### To-device delivery with more than one tab

Each tab has its own gateway session. The server sends the queue to each
session of the device, with a window of 100 messages for each session
(section 6). An ack of one session deletes the rows for the device, but
it frees only the window of that session.

1. Every tab forwards all of its dispatches to the worker.
2. The worker drops a `TO_DEVICE` message with a queue id that is in its
   inbox or that it processed (section 6). Thus each id is processed one
   time.
3. Only the ack tab sends `TO_DEVICE_ACK`, the live signals
   (`TO_DEVICE_SEND`) and the network calls. Thus there is one ack
   stream.
4. The tab that sent the last `READY` or `RESUMED` becomes the ack tab.
   The crypto layer then sends the resync ack through its session.
5. The window of a different session fills and stops. This is not a
   problem: its messages also come through the ack tab.
6. When the ack tab closes, the worker selects a different tab and sends
   `TO_DEVICE_ACK { upToId, resync: true }` through it. The server
   deletes the processed rows, clears the window of that session, and
   sends every queued row again. Thus no message is lost.
7. Dispatches that arrive while the crypto layer starts stay in a buffer
   (at most 1000) and go to the layer when it is ready.

### Lifetime

- A tab holds the lock `crypto-tab:<random>` while it lives, and sends
  its name in `hello`. The worker asks for that lock. When it gets the
  lock, the tab is gone: the worker drops the port, fails the network
  calls that wait for that tab (`NETWORK_ERROR`), forgets its backup
  tokens, and does not send the results of its calls.
- The worker holds the lock `crypto-worker:<random>` while it lives, and
  sends its name in `welcome`. A tab asks for that lock. When the tab
  gets it, the worker stopped (for example, it crashed). The tab fails
  its open calls with `CryptoWorkerLostError`, starts a new worker and
  sends `hello` again. The new worker sends all events to the tab again,
  and the tab keeps its listeners.
- When no tab is left, or the last tab signs out, the worker stops the
  crypto layer, closes the store and the index, and releases the device
  lock.

### Fallback: the lock and a banner in the page

A browser without `SharedWorker` runs the crypto layer in the page
(`apps/web/src/lib/crypto.ts`):

1. A tab asks for the device lock with `ifAvailable`. When it gets the
   lock, it starts the crypto layer.
2. When a different context holds the lock, this tab shows the banner.
   Then it waits for the lock.
3. When the other context stops, the browser gives the lock to the
   waiting tab. The banner goes, and the crypto layer starts there.
4. The tab keeps the gateway dispatches that arrive while the crypto
   layer starts (at most 1000), as the worker does.

A waiting tab can read the channel list, but it cannot encrypt or
decrypt.

When the crypto layer does not start (in the page or in the worker), the
tab tries again after 2 seconds, then after a longer time each time, up
to 60 seconds. Each failure fails the calls that wait for the layer, so
a send does not wait for all time. An event that could not decode
because the layer was missing shows as "waiting". It decodes again when
the layer is ready.

The desktop apps also use this fallback. Their webviews (WebView2,
WKWebView, Electron) have `SharedWorker`. But the OS key store, which
keeps the pickle key, is behind the bridge of the page, and a worker
cannot reach the bridge. Also, a desktop app has one window.

### Deviations from the first draft, and why

- The tabs do not send `bye` on `pagehide`. A lock for each tab shows
  that a tab is gone, also after a crash, and a page with a lock does not
  go into the back-forward cache.
- The worker writes the search index. It does not give the index keys to
  the tabs.
- The worker does not send each ack through "any live tab". It sends
  them through one ack tab, which changes only after a new gateway
  session or a closed tab. Each change sends a resync ack.

- WASM wrapper: `packages/crypto-wasm/src/lib.rs`, `backup.rs`, `sas.rs`.
- Server: `apps/server/src/modules/keys`, `apps/server/src/modules/to-device`,
  `GET /channels/:id/members` in `apps/server/src/modules/messages`.
- Client: `packages/client-core/src/crypto`.
- Web: `apps/web/src/lib/crypto.ts` starts the layer, and the codec in
  `apps/web/src/lib/messages.ts` waits for it. `SecurityBanner.tsx`,
  `SecurityDialog.tsx` and `VerificationDialog.tsx` are the UI of
  sections 4, 9 and 10. The two dialogs load only when they open.
