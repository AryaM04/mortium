# Password keys

This note explains how the account password unlocks the encryption keys
on a new device, and why the server never gets the password. The code is
`packages/client-core/src/crypto/password-keys.ts` (the key derivation and
the key wrap), `packages/client-core/src/account-keys.ts` (the API calls),
`apps/web/src/lib/password-unlock.ts` (the automatic steps of the security
gate) and `apps/server/src/modules/auth`.

## The problem

The messages are end-to-end encrypted (see `olm-megolm.md`). A new device
must get the master key from the key backup before it can read the old
messages. The recovery key opens the key backup. Before this change, each
new sign-in asked for the recovery key. Many users do not keep a recovery
key near them. Thus the password must unlock the key backup. But the server
checks the password, and the server must never open the key backup.

## The design

The client derives two different keys from the password. The server gets
only one of them.

```
password (UTF-8), salt (16 random bytes for each account)
        |
        |  Argon2id, 64 MiB, 3 passes, 1 lane, 32 bytes
        v
   password key
        |
        +-- HKDF-SHA256, info "mortium:auth-key:v1"     --> auth key (32 bytes)
        |                                                   goes to the server
        |
        +-- HKDF-SHA256, info "mortium:password-wrap:v1" --> wrap key (AES-256-GCM)
                                                            stays on the device
```

- The **auth key** takes the place of the password on the wire. The
  server hashes it with argon2id, as it hashed the password before
  (`users.password_hash`). Thus a stolen auth key is not the password, and
  a stolen hash is not the auth key.
- The **wrap key** encrypts the recovery key. The result is the **key
  wrap**: base64url of a 12-byte IV and the AES-GCM ciphertext of the 32
  recovery key bytes. The additional data is
  `mortium:key-wrap:v1|<userId>|<backup version>`, so the server cannot
  give a key wrap to a different user or a different backup version.
- The wrap key never leaves the memory of the tab. The client does not
  store it. A reload removes it.
- The Argon2id function is the one of the crypto WASM
  (`derive_recovery_key`). HKDF and AES-GCM come from WebCrypto.

## Data on the server

| Column of `users` | Contents |
|---|---|
| `password_hash` | argon2id hash of the auth key. For a legacy account: of the password. |
| `kdf_salt` | the salt (base64url), or null. |
| `kdf_version` | 1, or null for a legacy account (an account from before this change). |
| `key_wrap` | the key wrap (base64url), or null. |
| `key_wrap_version` | the backup version that the recovery key in `key_wrap` opens. |

## Routes

| Route | Use |
|---|---|
| `POST /auth/prelogin {email}` | Gives `{kdf: "argon2id-v1", salt, memoryKib, iterations, parallelism}`, or `{kdf: "legacy"}`. |
| `POST /auth/register` | Takes `authKey`, `kdfSalt` and `kdfVersion: 1`. No password. |
| `POST /auth/login` | Takes `authKey`. Only a legacy account takes `password`. |
| `POST /auth/password/upgrade` | Signed in. Takes `password`, `authKey`, `kdfSalt`, `kdfVersion`. Gives a legacy account a password key. |
| `POST /auth/password/change` | Signed in. Takes `currentAuthKey`, `authKey`, `kdfSalt`, `kdfVersion` and `keyWrap` (or null). |
| `GET /auth/key-wrap` | Signed in. Gives `{keyWrap: {version, data} \| null}`. |
| `PUT /auth/key-wrap` | Signed in. Takes `version`, `data` and `kdfSalt`. |
| `POST /auth/reset-password` | Takes the token, `authKey`, `kdfSalt` and `kdfVersion`. Removes the key wrap. |
| `POST /keys/master/reset` | Takes `authKey` in place of the password. |

- The prelogin route has the rate limit of the sign-in route.
- For an unknown email (or an account with no password), the prelogin
  route gives a false salt: the first 16 bytes of HMAC-SHA256 with the
  server secret (`JWT_SECRET`) and the normalized email. The salt is the
  same for each call. Thus an unknown account looks like a real account.
- The client accepts only the version 1 values of Argon2id. A server
  cannot make the derivation weaker.
- `PUT /auth/key-wrap` stores the wrap only when `kdfSalt` is the salt of
  the current password. Thus a device that holds the wrap key of an old
  password cannot store a key wrap that the new password cannot open.
- The upgrade, the password change and the key wrap use one conditional
  `UPDATE` each, so a parallel change cannot mix two passwords.

## Flows

- **Sign-up.** The client makes a salt and derives the keys. It sends the
  auth key. When the crypto layer made the master key, the app makes the
  key backup with a random recovery key and stores the key wrap. Then the
  screen "Save your recovery key" shows the key one time, with "Copy",
  "Download" and "Continue".
- **Sign-in on a new device.** The client calls the prelogin route,
  derives the keys and sends the auth key. It keeps the wrap key in
  memory. The device is not signed, so the security gate gets the key
  wrap, opens it and restores the key backup with the recovery key. The
  restore imports the master key and signs the device. The user sees only
  the status "Unlocking your messages".
- **Reload.** The wrap key is not in memory. When the server has a key
  wrap for the current backup, the gate shows "Unlock with your password"
  first. The other ways stay: another device, the recovery key, the reset.
- **Legacy account.** The prelogin route gives `legacy`. The client sends
  the password one time. After the sign-in, it calls the upgrade route
  with a new salt and auth key. The account has no key wrap yet. The
  client stores one when it next holds the recovery key.
- **The key wrap stays current.** When the client holds the recovery key
  (after the automatic backup, after a restore with the recovery key, after
  a new backup in the settings) and holds a wrap key, and the key wrap on
  the server is missing or for an older backup, it stores a new key wrap.
- **Password change.** The settings dialog asks for the current and the
  new password. The client derives both keys, opens the key wrap with the
  current wrap key and encrypts the recovery key again with the new wrap
  key. One request changes the hash, the salt and the key wrap. The other
  sessions stay signed in.
- **Password reset by email.** The reset page derives a new auth key with
  a new salt. The server cannot encrypt the recovery key with the new
  password, so it removes the key wrap. The next sign-in shows the gate
  with the recovery key, another device or the reset. After a restore with
  the recovery key, the client stores a new key wrap.
- **OAuth account (GitHub, Google).** It has no password and no wrap key.
  The user makes the backup and confirms the recovery key, as before.
- **Identity reset.** The client derives the auth key and sends it to
  `POST /keys/master/reset`. After a success, it keeps the wrap key. Then
  the new backup gets a key wrap.

## Threat model

- The server never gets the password or the wrap key. It gets the auth
  key, which is a different HKDF output of the same password key.
- The server cannot open the key wrap or the key backup. A stolen
  database gives the salt, the argon2id hash of the auth key and the key
  wrap. To open the key wrap, an attacker must find the password with a
  brute force of Argon2id (64 MiB for each guess). A strong password
  makes this too slow.
- A weak password makes the key backup as weak as the password. The
  recovery key alone is still a random 32-byte key.
- A malicious server can send a changed web app that captures the
  password. The web client trusts the code that the server sends. The
  desktop apps bundle their code, so this attack does not work on them.
- A malicious server can answer `legacy` to the prelogin route. Then the
  client sends the password itself one time. The desktop apps have the
  same risk. This route exists only for accounts from before this change.
- A password reset by email removes the key wrap. Thus the automatic
  unlock stops until the next restore with the recovery key. This is
  necessary: a person who controls the email account must not get the
  messages.
