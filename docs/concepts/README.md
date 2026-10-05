# Concept notes

This folder holds short notes. Each note explains one concept in plain
terms, with links to the real code.

- `auth.md`: accounts, tokens, devices, OAuth and rate limits.
- `gateway.md`: the WebSocket protocol between the client and the server.
- `permissions.md`: the permission bit flags and the overwrite algorithm.
- `messages.md`: channel events (messages, edits, reactions) and history.
- `attachments.md`: encrypted files in a message.
- `link-previews.md`: link previews that the sender makes, and the SSRF rules of the server route.
- `search.md`: the local, encrypted search index of each device.
- `dms-and-friends.md`: friends, DMs, group DMs and user settings.
- `voice.md`: voice signaling, the mesh and the member cap.
- `nat-turn.md`: why NAT traversal is hard, and how STUN and TURN help.
- `olm-megolm.md`: the end-to-end encryption design used by this app.
- `password-keys.md`: the auth key and the key wrap that come from the password.
- `desktop-shells.md`: the Tauri and Electron apps, updates and releases.

For the design decisions, see `docs/adr`.
