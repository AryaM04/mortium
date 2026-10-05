# Encrypted attachments

This note explains how files travel in a message. The server keeps only
ciphertext. It never gets a key, a file name or a file type.

## Send

1. The user picks, drops or pastes files in the composer. A message has at
   most 10 files.
2. For each file, the client makes a random AES-256-GCM key and a random
   12-byte IV with WebCrypto. It encrypts the file and computes the
   SHA-256 of the ciphertext.
3. For a PNG, JPEG, GIF or WebP image, the client also makes a thumbnail of
   at most 320 px (WebP), and encrypts it with its own key and IV. It keeps
   the width and the height of the image.
4. The client uploads each ciphertext with
   `POST /channels/:id/attachments` (body: `application/octet-stream`). The
   composer shows the progress, and the user can cancel an upload.
5. The Megolm payload of the message has one entry for each file:
   `{ id, name, mime, size, key, iv, sha256, width?, height?, thumbnail? }`.
   The thumbnail entry is `{ id, key, iv, sha256, width, height }`. Keys,
   IVs and hashes are base64url.
6. After the message is sent, the client calls
   `POST /attachments/:id/claim` for each file and thumbnail.

## Receive

- An image shows its decrypted thumbnail. A click opens the full image in
  a lightbox.
- Every other file shows a card with the name, the size and a download
  button. Video and audio files are download cards too. This pass has no
  streaming decryption.
- The client downloads with `GET /attachments/:id`, checks the SHA-256
  **before** it decrypts, and then decrypts. A hash mismatch shows an
  error and decrypts nothing.
- The client makes an object URL from the plaintext. Only PNG, JPEG, GIF
  and WebP keep their type from the payload. Every other file (SVG too)
  gets `application/octet-stream`, and a download uses the `download`
  attribute. Thus the page never shows or runs untrusted content.
- Decrypted files stay in a memory cache of at most 50 MB (least recently
  used). The cache revokes the object URL of each file that it removes, and
  it is empty after sign-out.
- The upload and download code loads with a dynamic import, only when the
  user attaches or views a file.

## Server rules

- Upload: the caller needs `VIEW_CHANNEL`, `SEND_MESSAGES` and
  `ATTACH_FILES` in the channel (a DM recipient has them). The request
  needs a `content-length` of at most `MAX_ATTACHMENT_BYTES` (default
  25 MiB). The files of one user have a total limit of
  `ATTACHMENT_QUOTA_BYTES` (default 2 GiB). Above it, the server answers
  413 `QUOTA_EXCEEDED`.
- The server streams the body to `${DATA_DIR}/attachments/<id>.tmp`, and
  then renames it to `<id>`. It never keeps the whole file in memory. A
  test shows that a 20 MiB upload adds less than 4 MiB of live memory.
- Download: the caller needs `VIEW_CHANNEL` and `READ_MESSAGE_HISTORY` in
  the channel of the file. The response has `Cache-Control: private` and
  `X-Content-Type-Options: nosniff`.
- Claim: only the uploader can claim a file. A second claim does nothing.
- Delete: `DELETE /attachments/:id` removes the file and its row. Only the
  uploader can delete a file. Other users get 404. The space returns to the
  quota of the uploader.

## Cleanup

The server cannot see which message holds a file, because the payload is
encrypted. Thus:

- One timer runs the cleanup at start and then one time per hour. It
  deletes each file that nobody claimed in 24 hours.
- The rows of a deleted channel go with the channel. The cleanup deletes
  a file with no row when it is older than 24 hours, and a temp file older
  than one hour.
- The server cannot map a redacted event to its files. Thus, when a user
  deletes an own message, the client calls `DELETE /attachments/:id` for
  each file, thumbnail and embed image of that message.
- When a moderator deletes the message of another user, the files stay.
  They count toward the quota of the uploader.

## Code

- Server: `apps/server/src/modules/attachments`.
- Client: `packages/client-core/src/attachments.ts` (file crypto, cache,
  helpers), `apps/web/src/lib/attachment-files.ts` (upload, thumbnail,
  download), `apps/web/src/components/AttachmentList.tsx`.
