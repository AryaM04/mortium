# Known issues

This file records the known defects in Mortium. A code review found them
on 2026-10-01. The review read the code. It did not run the app.

## How to use this file

- Each issue has an ID, such as `CRY-01`. Use the ID in commit messages.
- When you fix an issue, set its status to "Fixed in `<commit>`".
- Remove an issue only when it is fixed and released.
- Add new issues at the end of the correct section, with the next free ID.

**Severity**

| Severity | Meaning |
|---|---|
| Critical | Data loss, a security hole, or the server stops. Fix first. |
| High | A main feature fails in normal use. |
| Medium | A feature fails in some cases, or a workaround exists. |
| Low | A small fault, or a fault in a rare case. |

**Confidence**

| Confidence | Meaning |
|---|---|
| Confirmed | The review traced the full code path. "Checked" means a second person read the code again. |
| Likely | The code path is clear, but the trigger depends on timing. |
| Suspected | The fault is possible. Test it before you fix it. |

**User-reported** marks the issues that cause the faults the user saw:

1. The encryption system is messy, and new accounts are not verified.
2. Keys are forgotten easily.
3. On the desktop app, a device that was verified lost the state at once, and the chat could not be read.
4. A page reload while in a voice channel is not clean.
5. "You are no longer in this conversation" shows after a click away from a chat.

## Summary

| Area | Critical | High | Medium | Low | Total |
|---|---|---|---|---|---|
| [Gateway and session](#gateway-and-session-gw-ses) | 1 | 3 | 5 | 0 | 9 |
| [Encryption](#encryption-cry) | 1 | 8 | 4 | 4 | 17 |
| [Voice and video](#voice-and-video-vc) | 1 | 6 | 10 | 4 | 21 |
| [Chat and interface](#chat-and-interface-ui) | 0 | 2 | 6 | 4 | 12 |
| [Server](#server-srv) | 0 | 2 | 3 | 5 | 10 |
| [Desktop and operations](#desktop-and-operations-ops) | 0 | 0 | 4 | 2 | 6 |
| **Total** | **3** | **21** | **32** | **19** | **75** |

## Recommended fix order

1. `GW-01`. Any signed-in user can stop the server.
2. `SES-01`, `SES-02`. These sign the user out and make a new device. All local keys are then lost. This is the main cause of "keys are forgotten".
3. `CRY-01`, `CRY-02`, `CRY-03`. These make devices unverified, so no keys go to them.
4. `CRY-04` to `CRY-08`. These lose keys in transit or at start.
5. `VC-01`, `VC-02`, `VC-04`. These are the voice reload faults.
6. `UI-01`. This is the "no longer in this conversation" fault.
7. `SRV-01`, `SRV-02`. These are security faults.
8. The remaining issues, by severity.

---

## Gateway and session (GW, SES)

### GW-01: One TYPING message with a very large channel id stops the server

- Severity: Critical. Confidence: Confirmed, checked. Status: Fixed in v0.2.1.
- Symptom: A signed-in user sends `TYPING` with `channelId: "99999999999999999999"`. The Node process stops for all users.
- Cause:
  - `idSchema` accepts any number of digits (`packages/shared/src/api/common.ts:5`).
  - `handler.ts:295` calls `void handleTyping(...)` with no `.catch`. Postgres refuses the out-of-range `bigint`, and the promise rejects.
  - The server has no `unhandledRejection` handler, so Node stops the process.
  - `moderation.ts:39` has the same `void` pattern (`revalidateGuildVoice`).
- Fix: Limit `idSchema` to the range of a signed 64-bit integer. Add `.catch` to each `void` promise. Add a process-level `unhandledRejection` handler that logs the error.

### SES-01: A network error at start signs the user out, and all local keys are lost

- Severity: High. Confidence: Confirmed. Status: Fixed in v0.2.1. **User-reported (2, 3).**
- Symptom: The app opens while the server is down, restarts or cannot be reached. The user is signed out. After the next sign-in, the user has a new device, and old messages cannot be read. Auto-deploy restarts the server on each commit, so this occurs often.
- Cause:
  - `session.init()` calls `clearSession()` on any `fetchMe` error, also on `NETWORK_ERROR` and 5xx (`packages/client-core/src/session.ts:119-125`). The cross-tab "signed-in" handler does the same (`session.ts:101-105`).
  - The server makes a new device id on each sign-in (`apps/server/src/modules/auth/service.ts:85`). The crypto store belongs to one device id.
  - `clearSession` does not call `/auth/logout`. The old device stays on the server as a ghost, and other users continue to encrypt to it.
  - `refresh()` calls `navigator.locks.request` with no check (`api.ts:147`). On a plain-http address, each refresh fails and signs the user out.
- Fix: Clear the session only on a 401 with an auth error code. On other errors, keep the tokens and try again. Run the refresh without the lock when `navigator.locks` is missing.

### SES-02: A refresh response that is lost signs the device out and retires its keys

- Severity: High. Confidence: Confirmed. Status: Fixed in v0.2.1. **User-reported (2).**
- Symptom: After a network drop, a server restart or a refresh in two tabs at the same time, the user is signed out and the device keys are gone.
- Cause: The server rotates the refresh token. If the client does not get the reply and sends the old token again, the server sees `TOKEN_REUSED`. It revokes the device and calls `retireDeviceKeys` (`auth/service.ts:202-217`, `262-274`). The revoke and the insert of the new token are not in one transaction.
- Fix: Accept the previous token again for a short time (about 10 s), and return the same new token. Put the rotation in one transaction.

### SES-03: Other tabs do not start real-time updates or encryption after a sign-in in one tab

- Severity: Medium. Confidence: Confirmed. Status: Fixed in v0.2.1.
- Symptom: The other open tabs show the chats, but messages do not decrypt and nothing updates until a reload.
- Cause: The broadcast handler calls `fetchMe()`, which sets only `status` and `user` (`session.ts:92`, `105`). `deviceId` stays null. `crypto.ts:268` and `realtime.ts:86` need `deviceId`.
- Fix: In the "signed-in" handler, read the tokens and set `deviceId` with the status.

### GW-02: An old socket that closes after RESUME disconnects the resumed session

- Severity: High. Confidence: Confirmed. Status: Fixed in v0.2.1. **User-reported (4).**
- Symptom: After a network change, the client resumes on a new socket. When the old socket times out (up to 45 s), the server detaches the session. The user shows offline, events stop, to-device delivery stops, and the user is removed from voice 15 s later.
- Cause: `resumeSession` (`gateway/service.ts:135`) changes `session.ws` but does not close the old socket. The close handler of the old socket (`handler.ts:166-168`, `487-519`) still has the same session id. It calls `delivery.stop`, `disconnectSession` and `voice.scheduleGrace`.
- Fix: Close the old socket in `resumeSession`. In `disconnectSession`, `stop` and `scheduleGrace`, do nothing when `session.ws` is not the socket that closed.

### GW-03: A client that disconnects during IDENTIFY or RESUME leaves a session that never ends

- Severity: Medium. Confidence: Confirmed. Status: Fixed in v0.2.1.
- Symptom: The user shows online for all time. The server keeps the session and a buffer of 500 events in memory.
- Cause: `handleIdentify` (`handler.ts:221-222`) and `handleResume` (`handler.ts:256`) do not check `state.closed` after `await verifyAccessToken`. The close handler already ran with no session id, so nothing removes the session.
- Fix: After each `await`, if the socket is closed, do not create or attach the session.

### GW-04: An error while the server builds READY stops the server

- Severity: Medium. Confidence: Likely. Status: Fixed in v0.2.1.
- Symptom: A database error during READY gives an unhandled rejection (see `GW-01`). If the process continues, the connection has no heartbeat timeout and stays "online".
- Cause: `void handleIdentify(...)` (`handler.ts:453`) has no `.catch`. The heartbeat timeout starts only after READY (`handler.ts:230`).
- Fix: Catch errors in `handleIdentify` and close the socket. Start the heartbeat timeout before READY.

### GW-05: The client can open two sockets after the network comes back

- Severity: Medium. Confidence: Confirmed. Status: Fixed in v0.2.3.
- Symptom: After the network comes back, the gateway drops again, and the status banner changes between states.
- Cause: `handleOnline` (`packages/client-core/src/gateway.ts:410-415`) calls `connect()` while a reconnect socket is still opening. `connect()` (`gateway.ts:392-408`) does not remove the old socket first. The old socket later closes and calls `teardownSocket()`, which closes the new socket.
- Fix: Call `teardownSocket()` at the start of `connect()`. Do not connect in `handleOnline` when a socket exists. After `await getAccessToken()`, check that the socket did not change.

### GW-06: Events sent before READY are lost, and the sequence starts again at 0

- Severity: Medium. Confidence: Likely. Status: Fixed in v0.2.3.
- Symptom: A change just after connect, for example to a channel, a member or a DM, does not show. A later RESUME can send old events again.
- Cause: The server registers the session (`handler.ts:221`) before it builds READY (`handler.ts:225`). Events in that gap go out before READY. READY then builds the client store again from an empty state (`realtime-store.ts:172`) and sets `lastSequence = 0` (`gateway.ts:275`).
- Fix: On the server, hold events until READY is sent. On the client, do not set `lastSequence` lower than a value it already got.

---

## Encryption (CRY)

### CRY-01: Once the first device of an account is removed, no device of that account is trusted

- Severity: Critical. Confidence: Confirmed, checked. Status: Fixed in v0.2.1. **User-reported (1, 3).**
- Symptom: A user signs out of the device that made the account. After that, other users and new own devices see every device of the account as not verified. They send it no keys and refuse its key requests. SAS verification on a new device shows "The keys did not match", but the other device shows "verified". Messages cannot be read.
- Cause:
  - The server returns `masterKey.deviceId`, the device that made the master key, as the device that vouches for it (`apps/server/src/modules/keys/service.ts:326`).
  - `queryKeys` leaves out removed devices (`keys/service.ts:316`).
  - The client accepts the master key only when the vouching device is in the list (`device-list.ts:227-235`). Otherwise `masterKey` stays null, and every device gets `ownerVerified = false` (`device-list.ts:253-260`).
  - A sign-out, a device removal, `TOKEN_REUSED` (`SES-02`) and a password reset all remove the vouching device.
  - In SAS, `checkMac` cancels with `mac_mismatch` when the local `masterKey` is null (`verification.ts:437-446`). The other device has already finished and signed (`verification.ts:459-476`).
  - No code makes a live device vouch for the master key again. `importMasterKey` uploads only `masterSignature` (`device-manager.ts:197-217`).
- Fix: When a device that holds the master key starts, or imports it from the backup, upload a new `deviceSignature` and `deviceId` for the master key. Also accept a master key when a listed device has a valid `masterSignature` from it.

### CRY-02: A new account shows "Verify this device" right after sign-up

- Severity: High. Confidence: Confirmed. Status: Fixed in v0.2.1. **User-reported (1).**
- Symptom: The first device of a new account holds the master key and signed itself. But the banner "Verify this device to read old messages" shows, and the security dialog says "Not verified". On the desktop app, the state stays false.
- Cause:
  - `ensureMasterKey` uploads the key and signs the device (`device-manager.ts:253-297`). It reads the server with `transport.queryKeys`, not with `deviceList.refresh`.
  - `trustOwnMasterKey` only marks the user as outdated (`device-list.ts:195-206`).
  - `isSelfVerified` reads the store with no fetch (`crypto/index.ts:352-355`). So `selfVerified` is false (`index.ts:487`, `492`), and `SecurityBanner.tsx:47` shows the banner.
  - In the browser, a later `DEVICE_LIST_UPDATE` corrects the state. The desktop app subscribes to events too late (`CRY-05`), so the state stays false.
- Fix: Call `devices.refresh([userId])` at the end of `setup()`. Make `isSelfVerified` use `getDevices`, which fetches when the list is outdated.

### CRY-03: Device list changes that occur while a device is offline are never fetched

- Severity: High. Confidence: Confirmed. Status: Fixed in v0.2.1. **User-reported (3).**
- Symptom: A contact's new or newly verified device gets no keys and cannot read messages. Its key requests are refused as "not verified". Messages stay "waiting".
- Cause:
  - The server sends `DEVICE_LIST_UPDATE` only to live sessions. The resume buffer keeps events for 60 s (`gateway/service.ts:30-35`, `520`).
  - On READY, the client does not mark the users it tracks as outdated (`crypto/index.ts:470-483`).
  - `getDevice` fetches only for an unknown device, not for a known device whose state changed (`device-list.ts:133-148`).
  - `answerRequest` and `trustedDevicesOfUsers` use the old flag (`megolm.ts:757-761`, `device-list.ts:118-125`).
- Fix: On a new READY (not on RESUMED), mark all tracked users as outdated. Alternatively, send a "changed since" list in READY.

### CRY-04: To-device messages can be lost when two devices send at the same time

- Severity: High. Confidence: Confirmed, checked. Status: Fixed in v0.2.1. **User-reported (2, 3).**
- Symptom: Some room keys never arrive. This occurs when two devices send to the same device at the same time, which is usual in group chats.
- Cause: Each row id comes from `nextId()` in the transaction of its request (`to-device/service.ts:82`). A row with a higher id can commit first. The delivery reads only `id > lastSentId` (`to-device/service.ts:213`), so a row with a lower id that commits later is never sent. The next ack deletes it (`id <= upToId`, `to-device/service.ts:157-159`). The client also drops lower ids (`crypto/index.ts:455`, `olm-machine.ts:146`).
- Fix: Use a database sequence that follows the commit order. Alternatively, deliver every row that was not sent and not acked, and let the client accept lower ids.

### CRY-05: The desktop app drops events while encryption starts, and loses to-device messages

- Severity: High. Confidence: Confirmed (the effect depends on timing). Status: Fixed in v0.2.1. **User-reported (3).**
- Symptom: In the Tauri and Electron apps, keys that were sent while the app was closed sometimes never arrive.
- Cause: In-page encryption subscribes to gateway events only after `startCrypto` resolves (`apps/web/src/lib/crypto.ts:196-208`). `startCrypto` already sent the resync ack (`crypto/index.ts:486`). `TO_DEVICE`, `DEVICE_LIST_UPDATE` and `READY` events in that gap are dropped. A later message with a higher id is acked, and the server deletes the dropped rows. The SharedWorker path keeps these events in a buffer (`host.ts:66-67`). The in-page path does not.
- Fix: Subscribe and keep events in a buffer before `startCrypto`, as the worker host does.

### CRY-06: The queue position moves before the key is stored, and a temporary error drops the message

- Severity: High. Confidence: Confirmed. Status: Fixed in v0.2.1. **User-reported (2).**
- Symptom: Room keys or history forwards are lost when the tab closes during processing, or when the network fails at that time.
- Cause:
  - `OlmMachine.handleToDevice` saves `lastProcessedId` with the Olm session (`olm-machine.ts:158-161`, `445-452`). Only then do the handlers store the Megolm session (`olm-machine.ts:163-171`).
  - A network or 429 error in `decrypt` also saves the position and drops the message (`olm-machine.ts:155-160`, `349`).
  - In `receiveForward`, an error from `getDevice` is only logged (`megolm.ts:~455`, `~511`).
- Fix: Do not move the position on a temporary error. Try again. Store the Megolm session in the same transaction as the position, or move the position after the handlers finish.

### CRY-07: The rate limit on `/keys/query` makes key backup restore fail with no message

- Severity: High. Confidence: Likely. Status: Partly fixed in v0.2.3. The restore asks for all senders in one request and tries again after a 429. The server limit is not changed. **User-reported (2).**
- Symptom: A restore reports many "failed" sessions, and old chats stay unreadable. On a new device, many keys that arrive together are dropped.
- Cause: `/keys/query` allows 60 requests a minute for each user, for all devices together (`keys/routes.ts:30`, `49`, `96`, `132`). The client asks for one user at a time. `restoreSessions` calls `getDevice` for each unknown sender device (`device-list.ts:134-148`). A 429 counts the session as `failed`, and nothing tries again (`key-backup.ts:555-591`).
- Fix: Ask for many devices in one request during a restore. Try again after a 429. Raise the limit or count it for each device.

### CRY-08: When encryption does not start, the app does not try again, and pages wait for all time

- Severity: High. Confidence: Confirmed. Status: Fixed in v0.2.1. **User-reported (3).**
- Symptom: After a network error at start, every message shows "This message cannot be read." until a reload. In a second tab, or on a plain-http address with no `navigator.locks`, channels never load and sends stay "sending".
- Cause:
  - `startCrypto` uses the network in `setup()` (`crypto/index.ts:288`, `device-manager.ts:48-60`). In the worker, an error sets the state to "failed" (`host.ts:250-257`). The tab only logs it (`crypto.ts:173-175`).
  - Decode errors are stored as "cannot read" without `waiting`, so a later key does not decode them again (`messages.ts:69-77`, `messages-store.ts:1213`).
  - In page mode, `cryptoReady()` never resolves (`lib/messages.ts:46-48`, `62`, `75`; `crypto.ts:236-249`).
  - `applyPage` decodes the full page before it stores it (`messages-store.ts:855-866`). One encrypted event stops the full page.
- Fix: Start again with a backoff. Mark decode errors from a missing encryption layer as "waiting". Reject the waiters when the start fails. Store the page first, then decode.

### CRY-09: A sign-out of the only device without a key backup loses the master key for good

- Severity: High. Confidence: Confirmed (this follows the current design). Status: Fixed in v0.2.1. **User-reported (1, 2).**
- Symptom: After a sign-in, every new message shows "cannot be read yet". Key requests are refused because "its owner did not verify it".
- Cause: Keys go only to devices that the master key signed (`megolm.ts:214`). Only a device that holds the master private key can sign another device (`device-manager.ts:170-190`). The master private key is only in the store of the device that made it, or in the key backup, which is optional. "Reset identity" removes the signatures from all own devices, and each contact must accept the change by hand (`device-list.ts:122`).
- Fix: Before a sign-out, require the key backup when this device holds the master key. Ask a new device to verify or restore at once.

### CRY-10: When the local store or the pickle key is lost, encryption fails with no message

- Severity: Medium. Confidence: Likely. Status: Partly fixed in v0.2.3. The app shows the reason and a sign-out button. The Tauri app does not send the secure store reason yet.
- Symptom: After the WebView data is cleared, a reinstall, or a browser that removes IndexedDB, encryption never starts on that device. The interface shows nothing.
- Cause:
  - If the pickle key cannot be read, `loadPickleKey` makes a new key and writes over the old one (`crypto/index.ts:218-227`). `from_pickle` then fails at each start. The error goes only to `console.warn` (`crypto.ts:236-238`).
  - If the pickle is missing, the app makes a new account, and the server refuses the new keys with 409 `DEVICE_KEYS_EXIST`.
  - Electron `decryptString` returns null on a failure (`secure-store.ts:66-71`).
  - Tauri `desktop_init` never sends `secureStoreUnavailableReason` (`lib.rs:27-48`), so the error page cannot show on Windows or macOS.
  - The web app never calls `navigator.storage.persist()`.
- Fix: Never make a new pickle key when the store already holds an account. Show a "encryption failed" state with a reason and a reset button. When the store and the server device do not agree, sign the device out and make a new one, with a clear message. Call `navigator.storage.persist()`.

### CRY-11: An error during SAS confirmation stops the verification for 10 minutes

- Severity: Medium. Confidence: Confirmed. Status: Fixed in v0.2.3. **User-reported (3).**
- Symptom: The dialog says "Wait for your other device" until the timeout. A retry is not possible. The other side can show "got a message that it did not expect".
- Cause: `confirm()` has no `try/catch` (`verification.ts:219-231`). `checkMac` sets `macChecked = true` first (`verification.ts:422`). A network error in `finish` or `send` goes to `void ...confirm()` (`VerificationDialog.tsx:106`).
- Fix: Catch errors in `confirm`, as `handleToDevice` does. Cancel the verification with a clear reason, and log the error.

### CRY-12: A device list fetch can undo a verification or a master key change

- Severity: Medium. Confidence: Likely. Status: Fixed in v0.2.3. **User-reported (3).**
- Symptom: Right after a verification, a reset or a restore, the device can show its own "identity changed" banner or show as not verified.
- Cause: `markMasterKeyVerified`, `acceptMasterKeyChange` and `trustOwnMasterKey` read and write the user outside `REFRESH_QUEUE` (`device-list.ts:160-206`). `apply` reads the user at its start and writes it at its end (`device-list.ts:212-264`). A fetch at the same time writes the old values back.
- Fix: Run these writes in `REFRESH_QUEUE`, or read the user again in `apply` just before the write.

### CRY-13: One error stops all later to-device processing until a reload

- Severity: Medium. Confidence: Confirmed. Status: Fixed in v0.2.1. **User-reported (2).**
- Symptom: No more keys arrive until a reload.
- Cause: `drain()` has no `try/finally` (`crypto/index.ts:422-435`). If `olm.handleToDevice` rejects, for example on an IndexedDB error, `draining` is never reset. Each later `drain()` returns the rejected promise.
- Fix: Use `try/finally` to reset `draining`. Log the error and continue.

### CRY-14: An old master private key stays after another device resets the identity

- Severity: Low. Confidence: Confirmed. Status: Fixed in v0.2.3.
- Symptom: The device reports that it holds the master key. It puts the old key in a new backup and signs secrets with it. New devices refuse these secrets.
- Cause: `ensureMasterKey` returns when the server key is different (`device-manager.ts:275-277`), but it keeps the old key (`device-manager.ts:142-144`; `key-backup.ts:257`, `350`, `378`).
- Fix: Delete the stored master key when the server key is different.

### CRY-15: A failed key backup upload is not tried again

- Severity: Low. Confidence: Confirmed. Status: Fixed in v0.2.3.
- Symptom: Keys stay out of the backup until a new key or a READY arrives. The interface says "The app tries again later".
- Cause: On an error, `uploadAll` sets `lastError` but does not schedule a retry (`key-backup.ts:338-339`).
- Fix: Schedule a retry with a backoff.

### CRY-16: Old local data and ghost devices are never removed

- Severity: Low. Confidence: Confirmed. Status: Partly fixed in v0.2.3. Sign-out deletes the local data. Old ghost devices on the server stay.
- Symptom: The browser storage, the OS keychain and the server queue grow with each sign-in.
- Cause:
  - Each sign-in leaves a `crypto:` and a `search:` IndexedDB database and a `crypto-pickle-key:*` secure-store entry. Sign-out does not delete them (`session.ts:146-154`).
  - Ghost devices from `SES-01` collect up to 10,000 to-device rows each (`to-device/service.ts:17`), and senders use their one-time keys.
  - `MegolmMachine.forwarded` (`megolm.ts:153`) and `OlmMachine.lastRecovery` are never pruned.
- Fix: On sign-out, delete the local databases and the pickle key. Retire the device on the server when the local session is cleared. Prune the maps by age.

### CRY-17: Contacts always show as "Identity not verified"

- Severity: Low. Confidence: Confirmed. Status: Fixed in v0.2.3. **User-reported (1).**
- Symptom: Each contact shows "Identity not verified" until a SAS verification between the two users, also when keys work correctly. The menu does not update after a SAS. An email verified in another browser does not update an open app.
- Cause: `MemberContextMenu.tsx:44-60` shows "verified" only when `verifiedMasterKey === masterKey` (`crypto/index.ts:510-516`). A key trusted on first use never shows as verified. The menu reads the state once. The server sends no event when the email is verified (`session.ts:194`).
- Fix: Show a neutral text for a key trusted on first use, for example "Not verified with emojis". Subscribe to `security.onChange`. Send an event when the email is verified.

---

## Voice and video (VC)

What occurs now when the user reloads the page in a voice channel:

1. The page sends no `VOICE_LEAVE`. The server keeps the voice state for 15 s (up to 60 s when the socket has no close frame).
2. READY contains the old voice state. The interface shows the user in the channel, but the voice panel is idle. Other users keep a dead connection and see "Connection lost".
3. The user clicks the channel. The server sends a "left" event for the old state to all users, also to this user. The client removes its own new call (`VC-01`). The server now has a voice state with no client. It stays until the socket closes.

### VC-01: A rejoin from the same device stops the new call and leaves a ghost

- Severity: Critical. Confidence: Confirmed, checked. Status: Fixed in v0.2.1. **User-reported (4).**
- Symptom: A rejoin after a reload fails at once. The same occurs when the user changes voice channel, clicks the current channel again, or starts or answers a DM call while in a guild call. The panel goes idle, others see the user in the channel, and a rejoin is not possible until a reload and a 15 s wait.
- Cause:
  - `handleVoiceJoin` sends `broadcastVoiceLeave(previous)` also to the user who joins (`apps/server/src/modules/voice/gateway-ops.ts:123-125`). The previous state has the same user and device.
  - `onPeerVoiceState` stops the call on any "left" event for its own device (`packages/client-core/src/voice/engine.ts:1171-1176`). No code compares `callId`.
  - The "left" event arrives while `join()` waits (`engine.ts:1371-1379`). `join()` then makes new peer connections after `peers.clear()` (`engine.ts:1381-1394`), which leaks them.
  - `ChannelColumn.tsx:148-152` joins again also when the user is already in that channel.
- Fix: Ignore a "left" event for the own device when its `callId` is not the current one. Alternatively, do not send the old-state event to the device that joins. Make `join()` stop after each `await` when a teardown started.

### VC-02: The voice grace timer belongs to the device, not to the session

- Severity: High. Confidence: Confirmed. Status: Fixed in v0.2.1. **User-reported (4).**
- Symptom: The user closes or reloads another tab of the same browser. The tab in the call is removed from voice 15 s later. A reconnect that ends with IDENTIFY also removes the user after 15 s.
- Cause: Each socket close calls `scheduleGrace(userId, deviceId)` (`handler.ts:513`). `VoiceState` has no session id. `handleIdentify` never calls `cancelGrace` (`handler.ts:194-231`). `scheduleGrace` replaces the timer without clearing the old one (`voice/service.ts:240-250`), so the old timer still fires.
- Fix: Store the session id in `VoiceState`. Start the grace only when the session that closes owns the state. Clear an old timer in `scheduleGrace`. Cancel the grace on IDENTIFY.

### VC-03: A new READY during a call does not update the call

- Severity: High. Confidence: Confirmed. Status: Fixed in v0.2.3. **User-reported (4).**
- Symptom: After a long network drop, the panel still says "connected", and peers show "Connection lost" for all time. The server removes the user 15 s later. The app does not rejoin.
- Cause: `INVALID_SESSION` leads to IDENTIFY (`gateway.ts:258-262`, `314-322`). READY builds the store again (`realtime-store.ts:172`). `voice.ts:257-281` ignores READY and RESUMED. Peers drop signals from a sender with no voice state (`signal-transport.ts:118-121`).
- Fix: On READY during a call, send `VOICE_JOIN` again with a new `callId`, or stop the call cleanly.

### VC-04: The page sends no leave when it closes or reloads

- Severity: Medium. Confidence: Confirmed, checked. Status: Fixed in v0.2.1. **User-reported (4).**
- Symptom: After a reload, the user and the others see the user in the call for 15 s (up to about 60 s). Other users see "Connection lost". The screen share slot stays taken.
- Cause: The app has no `pagehide` or `beforeunload` handler. A socket close always uses the grace path (`handler.ts:512-516`).
- Fix: On `pagehide`, send `VOICE_LEAVE` when a call is active. The socket is still open at that time.

### VC-05: Server mute, server deafen and a missing SPEAK permission do not stop the media

- Severity: High. Confidence: Confirmed. Status: Fixed in v0.2.3.
- Symptom: A server-muted user, or a user without SPEAK, still sends audio. Others see the user as muted but hear the user. A server-deafened user still hears all. Push to talk sends audio while server-muted.
- Cause: The server only sets flags (`voice/service.ts:165`, `314-326`; `guilds/moderation.ts:228`). The client only disables a button (`VoiceStatusPanel.tsx:192`). The engine never reads `serverMute`, `serverDeaf` or the returned `selfMute` (`voice.ts:124-138`, `engine.ts:1622-1642`). When the server refuses an unmute (`voice/service.ts:207-212`), the local track is already on.
- Fix: On a voice state update for the own device, turn the track off for `serverMute` or `selfMute`, and set the output gain to 0 for `serverDeaf`. Undo a local unmute when `NO_PERMISSION` arrives.

### VC-06: A move by a moderator disconnects the user and leaves a ghost

- Severity: High. Confidence: Confirmed. Status: Fixed in v0.2.3.
- Symptom: The moved user's voice panel goes idle. The server shows the user in the new channel with no media.
- Cause: `moveUser` sends a "left" event and then the new state (`moderation.ts:261-267`). The engine stops the call on the "left" event (`engine.ts:1172-1176`). It then ignores the new state, because `currentChannelId` is null (`engine.ts:1177`). The moved state keeps `selfStream`, so the one-stream check is skipped (`voice/service.ts:349`).
- Fix: Treat an own state with a new channel id as a move, and join that channel locally. Ignore the "left" event by `callId` (see `VC-01`).

### VC-07: Users who join later do not see a camera or screen share that is already on

- Severity: High. Confidence: Confirmed. Status: Fixed in v0.2.3.
- Symptom: A user joins after another user turned on a camera or screen share. The new user does not see it.
- Cause: `ensurePeer` adds send-only video transceivers with `addTransceiver` before the offer of the new user arrives (`engine.ts:1099-1117`). `setRemoteDescription` matches offer lines only with transceivers from `addTrack`, so these stay unmatched. The answer cannot add lines. The later `negotiationneeded` event is ignored (`engine.ts:1142-1151`), and `handleDescriptionNow` does not offer again (`engine.ts:858-881`).
- Fix: After the answer is set, if a transceiver has `mid === null`, start a new negotiation.

### VC-08: A camera or screen share that is turned off and on again is not visible to peers

- Severity: High. Confidence: Confirmed (stream id), Likely (`onmute`). Status: Fixed in v0.2.3.
- Symptom: The camera or screen share works only the first time. A short network mute can also hide a remote video until the call ends.
- Cause: The second toggle uses `replaceTrack` with no new negotiation (`engine.ts:1485-1486`, `1596-1597`). The receiver keeps the first stream id. The "media" signal sends the new local `stream.id` (`engine.ts:422-431`, `1500`), so `applyMediaSignal` cannot find it (`engine.ts:926-927`). `track.onmute` removes the stream, and nothing adds it again on unmute (`engine.ts:938-950`).
- Fix: Send the stream id that the receiver sees (keep the first stream, or call `sender.setStreams`). Show the stream again on `onunmute`.

### VC-09: A join that the server refuses shows as connected

- Severity: Medium. Confidence: Confirmed. Status: Fixed in v0.2.3.
- Symptom: After `CHANNEL_FULL`, `NO_PERMISSION` or a blocked DM, the panel says "Voice connected" with an open microphone and no peers. During a channel change, the server still shows the user in the old channel.
- Cause: `handleVoiceError` only sends an error event (`engine.ts:1211-1217`). `join()` waits for the 5 s timeout and continues (`engine.ts:1371-1394`). `voice.ts:327-329` then sets `connected`. The server fails before it removes the old state (`voice/service.ts:147-157`).
- Fix: Treat a `VOICE_ERROR` during the join wait as a failed join. Stop the call and reject. During a channel change, send `VOICE_LEAVE` when the join fails.

### VC-10: The selected output device has no effect

- Severity: Medium. Confidence: Confirmed. Status: Fixed in v0.2.3.
- Symptom: The selected speaker or headset is ignored. Audio always plays on the default device.
- Cause: Audio goes through `masterGain` to `audioContext.destination` (`engine.ts:745-761`, `1356`). `setSinkId` is used only on a muted helper `<audio>` element (`engine.ts:768-776`, `1695-1702`). `AudioContext.setSinkId` is never called.
- Fix: Call `audioContext.setSinkId(deviceId)` when it exists. Use the saved device when the context is made.

### VC-11: Screen share audio from a peer takes control of that peer's volume and speaking ring

- Severity: Medium. Confidence: Confirmed. Status: Fixed in v0.2.3.
- Symptom: After a peer shares a screen with audio, the volume slider and "Mute for me" do not change the peer's voice. The speaking ring follows the screen audio.
- Cause: Each audio `ontrack` calls `attachRemoteStream` (`engine.ts:1127-1134`), which replaces `sourceNode`, `gainNode`, the analyser and `audioEl` (`engine.ts:757-775`). `setUserVolume` and `closePeer` cannot reach the old microphone nodes (`engine.ts:975-983`, `1704-1712`).
- Fix: Keep separate nodes for the microphone and the screen audio. Apply the volume to both.

### VC-12: A camera or screen capture can start after the user left the call

- Severity: Medium. Confidence: Confirmed. Status: Fixed in v0.2.3.
- Symptom: The user leaves while the camera prompt or the screen picker is open. The capture starts anyway, and the camera light stays on.
- Cause: `setCamera` and `setScreenShare` do not check the call state after `await getUserMedia` or `getDisplayMedia` (`engine.ts:1458-1503`, `1563-1618`). A camera "off" during a pending start is ignored (`engine.ts:1427`).
- Fix: Add a media generation counter, as `micGeneration` does. Stop the stream when the counter changed.

### VC-13: A leave while the join waits leaks peer connections

- Severity: Medium. Confidence: Confirmed. Status: Fixed in v0.2.3.
- Symptom: The user disconnects while the panel says "connecting". Peer connections stay open, and the idle panel can show peers.
- Cause: `teardown` does not clear `joinConfirmed`. `join()` continues after the wait and calls `ensurePeer` (`engine.ts:1221-1300`, `1371-1394`).
- Fix: Read a join generation after each `await` in `join()`, and return when it changed.

### VC-14: A connection that fails three times does not recover

- Severity: Medium. Confidence: Likely. Status: Fixed in v0.2.3.
- Symptom: A peer connection that failed stays broken.
- Cause: Only the impolite side makes a new connection (`engine.ts:986-998`, `1026-1033`). The polite side keeps its old connection and refuses the offer from the new one. The error is not shown. `restartsAttempted` is never reset after a recovery (`engine.ts:1001-1006`).
- Fix: Send a "rebuild" signal so that both sides make a new connection. Reset the counter on "connected".

### VC-15: A lost offer or answer stops all later negotiation with that peer

- Severity: Medium. Confidence: Likely. Status: Fixed in v0.2.3.
- Symptom: A camera or screen toggle, or an ICE restart, during a gateway reconnect never takes effect for some peers.
- Cause: Signals are dropped while the socket is down (`crypto/transport.ts:86`). A connection in `have-local-offer` makes each later `negotiateNow` return (`engine.ts:821-826`).
- Fix: Add a timeout for `have-local-offer` that rolls back and offers again. Alternatively, keep signals in a queue until the gateway is ready.

### VC-16: Voice signals count toward the gateway rate limit

- Severity: Medium. Confidence: Likely. Status: Fixed in v0.2.3.
- Symptom: In calls with about 6 to 10 users, a join and a camera toggle can close the socket with `RATE_LIMITED`. Signals are then lost.
- Cause: The limit is 120 messages per 60 s for each connection (`handler.ts:55-56`, `429-435`). Each ICE candidate, offer, answer and "media" signal is a separate `TO_DEVICE_SEND` (`signal-transport.ts:137-147`, `olm-machine.ts:288-290`).
- Fix: Count `TO_DEVICE_SEND` separately, or send many signals in one message.

### VC-17: A disconnected default microphone stays dead

- Severity: Medium. Confidence: Likely. Status: Fixed in v0.2.3.
- Symptom: The user uses the default microphone and disconnects the headset. Others hear nothing, and the app shows no message.
- Cause: `handleDeviceChange` acts only when `settings.inputDeviceId` is set (`voice.ts:454-458`). The engine does not listen for `ended` on the local track (`engine.ts:1347`).
- Fix: On `devicechange` or `ended`, open the default microphone again.

### VC-18: The voice channel limit counts the user's own old state

- Severity: Low. Confidence: Confirmed. Status: Fixed in v0.2.3.
- Symptom: A rejoin, or a change of device, into a full channel (10 users) gets `CHANNEL_FULL`.
- Cause: `VoiceService.join` checks `peers.size` before it removes the old state (`voice/service.ts:147-158`, `577-580`). `moveUser` has the same fault (`voice/service.ts:343-345`).
- Fix: Do not count the user's own state when it is already in that channel.

### VC-19: An incoming call disappears after a reload

- Severity: Low. Confidence: Confirmed. Status: Fixed in v0.2.3.
- Symptom: The called user reloads during the ring. The call card and the sound stop.
- Cause: READY clears `incomingCalls` (`realtime-store.ts:172`) and contains no rings (`handler.ts:86-100`).
- Fix: Put the active rings for the user in READY.

### VC-20: Selecting "Default" during a call has no effect until the next join

- Severity: Low. Confidence: Confirmed. Status: Fixed in v0.2.3.
- Symptom: A change back to the default microphone, speaker or camera during a call does nothing.
- Cause: `if (deviceId) apply…Live(deviceId)` skips null (`VoiceSettingsDialog.tsx:265`, `316`, `345`).
- Fix: Apply the default device when the value is null.

### VC-21: Screen share can fail in Firefox and Safari when the server is slow

- Severity: Low. Confidence: Suspected. Status: Fixed in v0.2.3.
- Symptom: Screen share fails when the server takes long to confirm the slot.
- Cause: `getDisplayMedia` runs only after the server confirms (up to 5 s) (`engine.ts:1556-1565`). Firefox and Safari require a recent user action for this call.
- Fix: Show the picker first, then ask for the slot, and roll back on `STREAM_IN_USE`.

---

## Chat and interface (UI)

### UI-01: "You are no longer in this conversation" shows when the user leaves a DM

- Severity: High. Confidence: Confirmed, checked. Status: Fixed in v0.2.1. **User-reported (5).**
- Symptom: The user opens a DM, then clicks "Friends", the Home icon or the "×" of the open DM. The notice shows, and the app adds a second history entry.
- Cause:
  - `AppShell.tsx:110-111` uses the same `HomeView` for `/app/@me` and `/app/@me/:id`. React keeps the component and its `wasLoadedRef`.
  - The DM sets `wasLoadedRef.current = true` (`HomeView.tsx:34-36`).
  - On `/app/@me`, `channelId` is null and `channel` is undefined. The effect sees `wasLoadedRef.current === true` and shows the notice (`HomeView.tsx:33-46`). It calls `navigate(HOME_PATH)`, which adds a history entry.
  - The same false notice shows for a DM link that is not loaded yet, and when the user leaves a group DM.
- Fix: Store the id of the loaded channel, not a boolean. Show the notice only when `channelId` equals that id and the channel is gone. Use `navigate(HOME_PATH, { replace: true })`. Do not show the notice when the user left the group.

### UI-02: Older history removes the newest messages and leaves a gap

- Severity: High. Confidence: Confirmed. Status: Fixed in v0.2.5.
- Symptom: The user scrolls up past about 300 messages. The newest messages disappear from the end and do not load again. New messages show after the gap.
- Cause: `loadOlder` cuts the newest events and sets `hasMoreAfter = true`, but it does not change `atLatest` (`messages-store.ts:264-267`, `926-934`). Live events are still added at the end (`messages-store.ts:381`). `MessageList.tsx:246-249` loads newer events only when `atLatest` is false.
- Fix: Set `atLatest = false` when `hasMoreAfter` becomes true.

### UI-03: The draft follows the user to another channel, and an edit can post as a new message

- Severity: Medium. Confidence: Confirmed. Status: Fixed in v0.2.1.
- Symptom: Text typed in channel A shows in channel B. When the user starts an edit and changes channel, Enter posts the old text as a new message in the other channel.
- Cause: `Composer` has no `key` (`ChatPane.tsx:180`). The channel change effect resets only mentions and uploads, not the text (`Composer.tsx:228-235`). `ChatPane.tsx:53-55` clears the edit target, but the text stays (`Composer.tsx:212-217`).
- Fix: Use `key={channelId}` on `Composer`, or keep one draft for each channel.

### UI-04: A failed load shows an empty pane, and failed edits, reactions and deletes show nothing

- Severity: Medium. Confidence: Confirmed. Status: Fixed in v0.2.5.
- Symptom: A network error or a 403 on the first page gives an empty pane with no retry. A failed jump also gives an empty pane. A failed edit or reaction is lost, and the composer text is already cleared.
- Cause: `void openChannel(...)` has no `catch` (`ChatPane.tsx:65-67`). `MessageList.tsx:206-207` shows nothing while no channel state exists. `jumpTo` ignores errors (`MessageList.tsx:173`), and `ChatPane.tsx:57-58` skipped `openChannel`. Edit, react and delete errors go to `void` calls (`Composer.tsx:383`, `MessageList.tsx:288-297`).
- Fix: Add an `error` field for each channel, and show it with a "Retry" button. Call `openChannel` when `jumpTo` fails. Catch failed changes and show a notice.

### UI-05: The status that the user sees and the status that others see can be different

- Severity: Medium. Confidence: Confirmed. Status: Fixed in v0.2.5.
- Symptom: A user sets "Invisible" or "Do not disturb". After a server restart, others see the user as online, but the user's interface still says "Invisible". After a reload, the opposite can occur.
- Cause: `presenceUiStore` is only in memory and starts as "online" (`lib/presence.ts:14`). IDENTIFY sends no status (`gateway.ts:240`). The server never clears its presence map (`gateway/service.ts:76`, `321`), and READY does not contain the user's own status (`gateway/service.ts:340`).
- Fix: Save the selected status, and send `PRESENCE_SET` after each READY. Alternatively, put the own status in READY.

### UI-06: The read marker stops when the channel holds 300 events

- Severity: Medium. Confidence: Confirmed. Status: Fixed in v0.2.5.
- Symptom: The user keeps a busy channel open for a long time. The channel stays unread.
- Cause: The mark-read effect depends on `eventIds.length` (`ChatPane.tsx:86-94`). At 300 events, each new event removes one at the start (`messages-store.ts:391`), so the length does not change.
- Fix: Depend on the id of the newest event.

### UI-07: A channel stays unread when the window gets focus again

- Severity: Medium. Confidence: Confirmed. Status: Fixed in v0.2.5.
- Symptom: A message arrives while the window has no focus. The user focuses the window with that channel open. The channel stays unread.
- Cause: `ChatPane.tsx:87` checks `document.hasFocus()` only when the effect runs.
- Fix: Add a window `focus` listener that runs the mark-read logic.

### UI-08: The last location can point to a server that the user left

- Severity: Medium. Confidence: Confirmed. Status: Fixed in v0.2.5.
- Symptom: The user leaves a server, or is kicked, on another device. Each visit to `/app` then opens an empty server page ("Choose a channel to start.").
- Cause: `AppHome` goes to `readLastLocation()` (`AppShell.tsx:34-40`). `GuildView` leaves only when `wasLoadedRef` is true (`AppShell.tsx:57-72`), so `clearLastLocation` never runs.
- Fix: When READY arrived and the server is not in it, call `clearLastLocation()` and go to `/app/@me`.

### UI-09: ArrowUp edits the first text of a message, not the last edit

- Severity: Low. Confidence: Confirmed. Status: Fixed in v0.2.5.
- Symptom: ArrowUp opens the text before earlier edits. A save then undoes those edits.
- Cause: `ChatPane.tsx:194-201` reads `payloads[id].body`, which is the first version.
- Fix: Use `aggregateEvent`, as `MessageList` does, or use `startEdit`.

### UI-10: Unread state is lost for channels that leave the cache, and the cache grows

- Severity: Low. Confidence: Confirmed. Status: Fixed in v0.2.5.
- Symptom: After the user opens more than 20 channels, the older ones lose their "New" marker and read state. Memory grows with channels that the user never opened.
- Cause: `touchChannel` deletes the full channel state, also `lastEventId` and `lastReadEventId` (`messages-store.ts:727-738`). `EVENT_CREATE` makes a window for channels that are not open (`messages-store.ts:1160-1165`). These windows are never removed.
- Fix: Keep the read fields when a channel leaves the cache, and remove only the events. Do not add live events to channels that are not open.

### UI-11: Opening a channel can set the newest event id back to an older value

- Severity: Low. Confidence: Confirmed. Status: Fixed in v0.2.5.
- Symptom: The unread state can be wrong for a short time when a message arrives while the first page loads.
- Cause: The value read before the fetch writes over a newer value from a live event (`messages-store.ts:916-919`).
- Fix: Keep the newer of the two ids, as the code does for `lastReadEventId`.

### UI-12: A jump to an old search result can leave the message row hidden

- Severity: Low. Confidence: Suspected. Status: Fixed in v0.2.5.
- Symptom: A click on an old search result loads the correct page, but the target message does not show. The e2e test `search.spec.ts` fails about one time in three on a Windows PC under load.
- Cause: Not known. The row is in the page but has no visible size. The jump logic in `MessageList.tsx` (`wasAtLatestRef`, about line 75) had a similar fault before.
- Fix: Find the cause with a trace of the virtual list during the jump.

---

## Server (SRV)

### SRV-01: A member who is kicked, banned or leaves keeps all roles after a rejoin

- Severity: High. Confidence: Confirmed. Status: Fixed in v0.2.3.
- Symptom: A moderator is kicked, then joins again with an invite. The moderator gets all old roles back, also admin roles.
- Cause: `member_roles` has no foreign key to `guild_members`. `removeMember` (`moderation.ts:23`) and `leaveGuild` delete only the `guild_members` row. `acceptInvite` adds the member again (`invites.ts:185`), and the old roles apply.
- Fix: In the same transaction as the member delete, delete the member's roles and member overwrites for that server.

### SRV-02: An OAuth sign-in can link to an account that another person made with the same email

- Severity: High. Confidence: Confirmed. Status: Fixed in v0.2.3.
- Symptom: An attacker registers `victim@example.com` with a password and does not verify the email. The victim later signs in with Google or GitHub. The provider links to the attacker's account, and the attacker keeps password access.
- Cause: `completeOAuthLogin` links to `existingByEmail` without a check of `emailVerified` (`auth/oauth.ts:180-185`). It also keeps the password and the sessions.
- Fix: Refuse the link when the account is not verified. Alternatively, set the email as verified, remove the password and revoke all sessions before the link.

### SRV-03: A very large id in a REST route gives a 500 error

- Severity: Medium. Confidence: Confirmed. Status: Fixed in v0.2.1.
- Symptom: `GET /guilds/99999999999999999999`, a large `before` value, or a large id in a body gives `500 INTERNAL_ERROR`. The correct reply is 400 or 404.
- Cause: Each `parseId` (for example `guilds/routes.ts:82`) checks only for digits. Postgres refuses the value.
- Fix: Use one shared `parseId` with a range check (see `GW-01`).

### SRV-04: The attachment quota can never be freed

- Severity: Medium. Confidence: Confirmed. Status: Fixed in v0.2.3.
- Symptom: After a user reaches the quota, uploads fail with "Delete some files first", but no way to delete a file exists.
- Cause: The quota adds all files of the user (`attachments/service.ts:726-731`). No delete route exists. A message delete does not remove its files.
- Fix: Add `DELETE /attachments/:id` for the uploader. Remove the file when its message is deleted.

### SRV-05: Each message and typing event runs about four queries for each server member

- Severity: Medium. Confidence: Confirmed. Status: Fixed in v0.2.3.
- Symptom: High CPU and database load on the home server in large channels.
- Cause: `computeChannelViewers` (`gateway/service.ts`) calls `loadMemberContext` (four queries) and `channelPermissions` for each member, on each event. `notifyVisibilityChanges` and `snapshotViewableChannels` do the same.
- Fix: Load the server, roles, member roles and overwrites once, and compute the viewers in memory, as `listChannelMembers` does.

### SRV-06: A failed or double join uses an invite use

- Severity: Low. Confidence: Confirmed. Status: Fixed in v0.2.3.
- Symptom: A double click on an invite uses two uses. Limited invites run out too early.
- Cause: The `uses + 1` update runs before the member insert (`invites.ts:157`, `170-178`, `185`). The two writes are not in one transaction.
- Fix: Do the insert and the update in one transaction. Increase `uses` only when the insert added a row.

### SRV-07: The message nonce check ignores the channel and runs before the access check

- Severity: Low. Confidence: Confirmed. Status: Partly fixed in v0.2.3. The access check runs first and the nonce check uses the channel. A nonce stays used for all time.
- Symptom: A nonce used again returns an old event from another channel, and the new message is not posted. A user who lost access can still get that old event.
- Cause: `messages/service.ts:132-138` looks up only `(deviceId, nonce)`, before `loadChannelAccess`. The unique index makes the check permanent, but the docs say 10 minutes.
- Fix: Add `channelId` to the check, and do the access check first. Add a time limit.

### SRV-08: Invite creation and channel overwrites use the wrong scope

- Severity: Low. Confidence: Confirmed. Status: Fixed in v0.2.3.
- Symptom: A user can make an invite for a channel that the user cannot see. The invite preview shows the channel name. An overwrite can name a role or user from another server.
- Cause: `createInvite` checks `CREATE_INVITE` for the server, not for the channel (`invites.ts`). `putOverwrite` does not check `targetId` (`overwrites.ts`).
- Fix: Check `VIEW_CHANNEL` and `CREATE_INVITE` on the channel. Check that `targetId` is a role or member of the server.

### SRV-09: Migration 0008 fails on a database that has rows

- Severity: Low. Confidence: Suspected. Status: Not fixed in code. docs/deploy.md tells how to upgrade a database from before migration 0008.
- Symptom: An upgrade of an old database stops in `migrate()`, and the server does not start.
- Cause: `apps/server/drizzle/0008_m6_keys_and_to_device.sql` adds `NOT NULL` columns with no default and no fill.
- Fix: Delete the old rows first, or add the columns as nullable, fill them, then add `NOT NULL`.

### SRV-10: The rate limiter maps never remove idle users

- Severity: Low. Confidence: Confirmed. Status: Fixed in v0.2.3.
- Symptom: Memory grows slowly, with one entry for each user who ever used a route.
- Cause: `createEventRateLimiter` deletes a key only when its list is empty, which does not occur (`messages/service.ts:654-674`).
- Fix: Remove old keys on a timer, or when the map passes a size limit.

---

## Desktop and operations (OPS)

### OPS-01: Auto-deploy does not try a failed build again

- Severity: Medium. Confidence: Confirmed. Status: Fixed in v0.2.3.
- Symptom: A temporary build failure, for example a network error, leaves the old containers. Removal of `.deploy/skip`, as the docs say, does nothing. No deploy occurs until a newer commit.
- Cause: `scripts/auto-deploy.sh:59` merges before the build. After a build failure, `HEAD` is already the new commit, so line 38 stops at once on each run. `docs/deploy.md` describes a retry that cannot work.
- Fix: Keep the last commit that built correctly in `.deploy/deployed`, and compare with that value, not with `HEAD`.

### OPS-02: A data restore fails on a new host

- Severity: Medium. Confidence: Likely. Status: Fixed in v0.2.3.
- Symptom: `restore.sh` restores the database, then `tar -xzf` fails with "permission denied". The stack does not start again, and avatars and attachments stay lost.
- Cause: `infra/scripts/restore.sh:108-110` makes the `api-data` volume through the backup image. That image has no `/data` folder owned by 100:101, so the volume belongs to root. The backup service runs as 100:101 (`docker-compose.yml:269`, `infra/scripts/backup.sh:66-67`).
- Fix: In the backup `Dockerfile`, make `/data` and set its owner to 100:101.

### OPS-03: The Linux AppImage cannot open `mortium://` links, so OAuth sign-in fails there

- Severity: Medium. Confidence: Suspected. Status: Fixed in v0.2.3.
- Symptom: GitHub or Google sign-in from the AppImage opens the browser, but the final link opens nothing. The deb package works.
- Cause: `apps/desktop-electron/src/main/index.ts:413-416` registers the link handler only through the desktop file of the deb package. An AppImage without desktop integration has no desktop file.
- Fix: For an AppImage, write a desktop file with `MimeType=x-scheme-handler/mortium` and register it with `xdg-mime`. Alternatively, document that the AppImage needs desktop integration.

### OPS-04: `latest.json` can lose the Windows or macOS entry

- Severity: Medium. Confidence: Suspected. Status: Fixed in v0.2.3.
- Symptom: After a release, the Tauri updater finds no update for one platform.
- Cause: The two Tauri jobs in `release.yml` run at the same time. Both read, merge and upload the same `latest.json`. One upload can write over the other. Releases v0.1.0 and v0.1.1 have all entries.
- Fix: Set `max-parallel: 1` on the matrix, or build `latest.json` once in the `publish` job.

### OPS-05: The global push-to-talk key can stay active after a call on Linux

- Severity: Low. Confidence: Likely. Status: Fixed in v0.2.3.
- Symptom: After a call, the push-to-talk key is still captured system-wide.
- Cause: `set()` in `apps/desktop-electron/src/main/push-to-talk.ts` sets `stopCurrent` only after `await this.loadHook()`. A `set(null)` during that wait does nothing, and the pending `set(shortcut)` then installs the hook. The web side does not wait (`apps/web/src/desktop/desktop-platform.ts:291-294`).
- Fix: Run the `set` calls one after the other in a promise queue, or drop an old call with a generation counter.

### OPS-06: A backup hour with a leading zero can stop the backups

- Severity: Low. Confidence: Suspected. Status: Fixed in v0.2.3.
- Symptom: With `BACKUP_HOUR=08` or `09`, the backup container restarts in a loop and makes no backup.
- Cause: `infra/scripts/backup.sh:83-84` uses the value in shell arithmetic. The shell reads `08` and `09` as invalid octal numbers.
- Fix: Remove leading zeros before the arithmetic.
