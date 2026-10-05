# Accounts, sessions and tokens

This note explains how sign-in works: the two kinds of token, why there
are two, token rotation, reuse detection, why the server hashes passwords
with argon2id, and how OAuth sign-in fits in.

## Two tokens, not one

A signed-in app needs to prove, on every request, who the user is. One
simple design is a single long-lived token. This app does not use that
design, because a single long-lived token is worth stealing: whoever has
it can act as the user for weeks or months.

Instead, the server gives out two tokens:

- The **access token** is a JWT (a signed piece of text with a user ID and
  a device ID inside it). It is valid for only 15 minutes. The client
  sends it with every request, in the `Authorization: Bearer` header. The
  server checks its signature and its expiry. It never looks the access
  token up in the database, so checking it is fast and needs no database
  call.
- The **refresh token** is a long random value. It is valid for 30 days.
  The client keeps it in a secure, local store and sends it only to the
  `/auth/refresh` route, to get a new access token. The server stores
  only a SHA-256 hash of it, never the value itself, the same way it
  stores password hashes and not passwords.

If the access token leaks (for example, in a server log), the damage is
bounded to 15 minutes. If the refresh token leaks, the damage is bounded
to one device's session, because of rotation and reuse detection below.

## Token rotation

Each time a client calls `/auth/refresh`, the server does three things in
one step:

1. It marks the refresh token the client sent as used (`revoked_at`).
2. It makes a brand new refresh token and stores its hash.
3. It signs a brand new access token.

The client must throw away the old refresh token and use the new one next
time. This is called rotation. It means a refresh token is good for one
use only.

The server does the "mark as used" step with a single conditional SQL
`UPDATE ... WHERE revoked_at IS NULL RETURNING ...`. This matters when two
requests race to refresh the very same token at almost the same instant:
the database processes the two `UPDATE` statements one after another, and
only the first one finds a row with `revoked_at IS NULL`. The second gets
zero rows back and fails. Without this, a rare race could let both
requests believe they won, and hand out two valid new tokens for a token
that should only ever be used once.

## Reuse detection

Because each refresh token works only once, a second attempt to use the
same (now revoked) refresh token is a signal that something is wrong. It
usually means one of two things: a genuine bug in a client that resent an
old request, or someone else got a copy of the refresh token and is now
racing the real device to use it.

The server cannot tell these two cases apart. So it assumes the worse
case: it revokes every refresh token that belongs to that device,
immediately signing that device out everywhere. The user has to log in
again on that device, but a stolen token stops working at the same time.

## Why argon2id

The server never gets the password. The client derives an **auth key**
from the password and sends that in place of the password (see
`password-keys.md`). The text below says "password" for the value that
the client sends. The server never stores it. It stores a **hash** of it,
made with argon2id. A hash cannot be turned back into the password. When
a user logs in, the server hashes the password they typed and compares
the two hashes.

argon2id is the current standard choice for password hashing, because it
is deliberately slow and deliberately memory-hungry. A normal login pays
this cost once, in a fraction of a second. An attacker who steals the
password hash table and tries to guess passwords by hashing millions of
guesses pays this cost millions of times, which makes guessing far too
slow to be worth it. Older, faster hash functions (MD5, SHA-256 on its
own) do not have this property, so they are not safe for passwords.

To stop an attacker from learning "this email has no account" from a
faster response time, the login route always hashes something and
compares it, even when the email does not exist. It hashes a fixed dummy
value instead of a real password hash in that case, so a missing account
and a wrong password take about the same amount of time to answer.

## OAuth sign-in

A user can also sign in with GitHub or Google, instead of a password.
The flow looks like this:

```
Browser                     This server                  GitHub/Google
   |                              |                              |
   |-- GET /auth/oauth/:p/start ->|                              |
   |                              |-- makes a random "state" --  |
   |                              |   value, and (for Google) a  |
   |                              |   PKCE code verifier. Both   |
   |                              |   go in a signed cookie.     |
   |<-- 302 redirect ------------ |                              |
   |------------------------------------------------------------->|
   |                              |         user signs in         |
   |<-------------------------------------------------------------|
   |-- GET /auth/oauth/:p/callback?code=...&state=... ---------->|
   |                              |-- checks state matches the -->|
   |                              |   signed cookie               |
   |                              |-- exchanges code for tokens ->|
   |                              |<------------------------------|
   |                              |-- fetches the verified email->|
   |                              |<------------------------------|
   |                              |-- links or makes a user      |
   |                              |-- makes a device session     |
   |                              |-- stores it under a one-time |
   |                              |   code (60 seconds, one use)  |
   |<-- 302 to the web app, with the one-time code in the URL -- |
   |-- POST /auth/oauth/exchange {code} ------------------------>|
   |<-- access token, refresh token, user ------------------------|
```

Two points are worth a closer look:

- The **state** value stops a forged callback: the server only accepts a
  callback whose `state` matches the value it put in a signed, short-lived
  cookie when the flow started. A forged link with no matching cookie
  fails.
- The **one-time exchange code** stops the tokens from ever appearing in
  a browser URL, a bookmark, or a server log line, since a URL is a much
  less safe place for a secret than a request body. The code is a random
  value, good for one use, and it expires after 60 seconds if it is never
  used.

The server links accounts by email only when the provider says the email
address is verified. This stops one person from claiming somebody else's
email address through an OAuth account that never confirmed it.

The existing account must also have a verified email. Another person can
register an email address with a password and not verify it. If the
server linked the provider to that account, that person would keep access.
Thus the server refuses the link with 409 `OAUTH_ACCOUNT_NOT_VERIFIED`.
The owner must sign in with the password and verify the email first.

### OAuth sign-in from the desktop app

The desktop app cannot get the redirect in its own window, because the
provider page must open in the system browser. The flow has two changes:

1. The desktop app opens the system browser at
   `/auth/oauth/:p/start?client=desktop`. The signed cookie records the
   value `desktop`.
2. After the callback, the server sends the browser to
   `<DESKTOP_URL_SCHEME>://auth/callback#code=...` (default scheme:
   `mortium`). The operating system gives this link to the desktop
   app, and the app exchanges the code as the web app does.

An error goes to the same link, with `#error=<code>`. A sign-in from the
web app keeps the old return address on `WEB_ORIGIN`.
