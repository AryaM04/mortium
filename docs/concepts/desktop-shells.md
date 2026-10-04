# Desktop shells: Tauri and Electron

This note explains why the app uses two different desktop tools, and how
to run the media diagnostics check by hand. See ADR 0003 for the formal
decision record.

## Why Tauri on Windows and macOS

Tauri wraps the web app in a small native window. It does not bundle a
browser. Instead, it uses the browser that is already part of the
operating system:

- On Windows, this is WebView2, which is built on Chromium. Chromium has
  full support for `RTCPeerConnection`, `getUserMedia` and
  `getDisplayMedia`, so voice, video and screen share all work.
- On macOS, this is WKWebView, Apple's own browser engine. It supports
  voice and video calls. Screen share needs usage strings and
  entitlements, which this shell already ships (see below).

Because Tauri does not bundle a browser, its installer and its running
memory use are both small. This matters for a friends-scale project that
should stay light on each person's machine.

## Why Electron on Linux

Linux does not have one standard system browser view. The most common
choice, WebKitGTK, has weak and inconsistent WebRTC support across
distributions. Electron bundles its own copy of Chromium, so voice, video
and screen share work the same way on every Linux distribution. The cost
is a larger installer and higher idle memory use, which is an accepted
trade-off only on Linux.

## What the Tauri app does

The Tauri app in `apps/desktop-tauri` loads the web build (`apps/web/dist`)
from its own origin: `http://tauri.localhost` on Windows and
`tauri://localhost` on macOS. In development, it opens the Vite dev server
URL. The web build finds the app through `window.__TAURI_INTERNALS__` and
loads `apps/web/src/desktop/desktop-platform.ts` and
`apps/web/src/desktop/tauri-bridge.ts` with a dynamic import, so the web
bundle does not grow.

Both desktop apps use one contract, `DesktopBridge` in
`packages/shared/src/desktop.ts`. The files in `apps/web/src/desktop` use
only this contract. The Tauri app supplies it with Tauri commands. The
Electron app supplies it with its preload script (see "What the Linux app
does" below).

### Server address

The app has no server of its own. On the first start, it asks for the
server address (for example `chat.example.com`). The app checks the
address with `GET /api/v1/health` and sends its own origin in the
`Origin` header. The server must answer with a CORS header for that
origin. Thus, the server must list the app origins:

```
CORS_ALLOWED_ORIGINS=http://tauri.localhost,tauri://localhost,app://mortium
```

The last value is the origin of the Linux app.

The app keeps the address in the OS key store. Every REST, gateway,
avatar and attachment URL goes through `apps/web/src/lib/server-url.ts`.
In a browser, that helper gives relative URLs (the server is the page
origin). "Change server" in the account settings signs out, forgets the
address and restarts the app.

### Content security policy

`tauri.conf.json` has a strict policy: scripts only from the app, no
remote scripts, `blob:` and `data:` images, and `connect-src` only for the
app and its IPC. At start, the Rust code adds the chosen server to
`connect-src` (with `ws:` or `wss:`) and to `img-src`. Tauri reads the
policy only at start, so a new server address restarts the app.

The window capability (`capabilities/default.json`) allows only the app
commands, event listen and unlisten, and opening http and https links in
the system browser.

### Services of the desktop platform

| Service | How it works |
|---|---|
| Secure store | The OS key store: Windows Credential Manager, macOS Keychain (`keyring` crate). It keeps only small values: the tokens, the pickle key and the server address. The bulk crypto data stays in IndexedDB, encrypted with the pickle key. |
| Notifications | Windows: a toast. A click opens `mortium://notification/<id>`, and the app opens the channel. macOS: the notification center. A click brings the app to the front, but it does not open the channel. |
| Push to talk | A global shortcut (`tauri-plugin-global-shortcut`). The Pressed and Released states go to the push-to-talk controller of the web app, also while the window has no focus. The voice settings record a key with its modifiers, for example Ctrl + Shift + T. Other apps do not get a registered key, so use a function key or a key with a modifier. |
| Deep links | Scheme `mortium` (`plugins.deep-link` in `tauri.conf.json`). `mortium://invite/<code>` opens the invite page. The single-instance plugin gives a link to the running app. |
| OAuth | The app opens the system browser at `/api/v1/auth/oauth/<provider>/start?client=desktop`. The server sends the browser back to `mortium://auth/callback#code=...` (see `auth.md`). |
| Link previews | The Rust command `link_preview_fetch` fetches the page and the image. It uses the same rules as the server route: only ports 80 and 443, each resolved address is checked (no private, loopback, link-local or unique-local address), each redirect is checked, 3 s, 512 KiB of HTML and a 2 MiB image. The web app reads the page with the same `readHtmlMeta` as the server. |
| Tray | Show, Mute, Deafen and Quit. Mute and Deafen work during a call. By default, the close button keeps the app in the tray. The account settings can turn this off. |
| Window state | `tauri-plugin-window-state` restores the size and the position. |
| Unread badge | Unread direct messages and mentions. macOS: a number on the dock icon. Windows: a red dot on the taskbar button. |
| Updates | See "Updates and signing" below. |

### Screen share

- Windows: WebView2 is Chromium, so `getDisplayMedia` works. The M0 spike
  showed this.
- macOS: WKWebView has no reliable `getDisplayMedia`. The app hides the
  screen share button and shows this reason: "Screen share is not
  available in this app on macOS. Use the web app." A later milestone can
  add a native ScreenCaptureKit plugin (plan section 8).

## Updates and signing

The app asks for
`https://github.com/AryaM04/mortium/releases/latest/download/latest.json`
30 s after start and then every 6 hours. When a newer version exists, the
app shows a prompt. It installs the update only after the user clicks
"Install and restart". The updater checks the signature of the download
with the public key in `plugins.updater.pubkey`.

CAUTION: Do not commit the private key. If you lose the private key, the
installed apps cannot get updates. Then you must give the users a new
installer.

To make a new key pair:

1. Run `pnpm --filter @mortium/desktop-tauri exec tauri signer generate -w <path-outside-the-repo>`.
2. Put the content of the `.pub` file in `plugins.updater.pubkey` in
   `tauri.conf.json`.
3. In the GitHub repository settings, add the secret
   `TAURI_SIGNING_PRIVATE_KEY` with the content of the private key file.
4. If the key has a password, add the secret
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

The updater URL must be public. A private repository gives no release
files without a login, so the check fails there.

## Build and release

- `pnpm --filter @mortium/desktop-tauri build` makes the MSI and the NSIS installer
  on Windows (in `src-tauri/target/release/bundle`). A local build makes
  no updater files, so it needs no signing key.
- `.github/workflows/release.yml` runs when CI passes on a push to main.
  It makes a release only when `apps/web`, `apps/desktop-tauri`,
  `apps/desktop-electron` or `packages` changed since the last tag. Start it
  by hand to release without an app change.
- The version is the last tag with the patch number plus one. To start a
  new minor or major version, set a higher `version` in `tauri.conf.json`.
- It builds on Windows and macOS (one universal app for Apple silicon and
  Intel) and on Linux, signs the updater files when the key secret exists,
  and publishes the release when all builds pass. Without the key, the
  release has installers only, and the workflow shows a warning.
- The macOS app is not signed with an Apple Developer ID. macOS shows a
  warning at the first start. Open the app from Finder with Control-click
  and "Open".

### Small binary settings

The release build uses these Cargo profile settings, in
`apps/desktop-tauri/src-tauri/Cargo.toml`, to keep the installer small:

- `opt-level = "s"`: optimize for size, not speed.
- `lto = true`: remove unused code across the whole build.
- `codegen-units = 1`: let the compiler optimize across the full crate.
- `strip = true`: remove debug symbols from the final binary.
- `panic = "abort"`: drop the unwinding code used for panic recovery.

### macOS notes (not yet tested on a Mac)

Two files prepare the shell for a macOS build:

- `src-tauri/Info.plist` adds `NSCameraUsageDescription` and
  `NSMicrophoneUsageDescription`. macOS shows this text when it asks the
  user for camera or microphone access.
- `src-tauri/entitlements.plist` grants the camera and microphone
  entitlements. Without these, macOS denies the access request before the
  user even sees a prompt.

The app needs macOS 12 or later (`minimumSystemVersion`), for camera and
microphone access in WKWebView. A real macOS build and test must happen
on a Mac before a release.

### Windows permission prompts

WebView2 shows its own permission prompt for `getUserMedia` and
`getDisplayMedia`, the same way the Edge browser does. No extra Rust code
was needed for this on Windows.

## What the Linux app does

The Linux app in `apps/desktop-electron` is an Electron app. It loads the
same web build. The web build finds the app through `window.desktopBridge`
and loads `apps/web/src/desktop/desktop-platform.ts` with a dynamic import.

### Window and security

- The window loads the web build from the `app://mortium` protocol,
  not from `file://`. Thus the page has a stable origin, which the server
  can allow in `CORS_ALLOWED_ORIGINS`. The protocol serves only files of
  the web build. A path without a file extension gets `index.html`.
- The window has `contextIsolation`, `sandbox` and no Node.js
  (`nodeIntegration: false`). The preload script
  (`src/preload/index.ts`) gives the page only the functions of
  `DesktopBridge`. It gives no general IPC access.
- The main process accepts a call only from the main frame of the app
  window on the app origin. It checks each argument before it uses it
  (`src/main/ipc.ts` and `src/main/validate.ts`).
- Each response of the protocol has the same content security policy as
  the Tauri app. The main process adds the chosen server to `connect-src`
  (with `ws:` or `wss:`) and to `img-src`. A new server address loads the
  page again, so the new policy applies at once.
- The app opens http and https links in the system browser. It refuses
  new windows, other protocols and navigation away from the app origin.
- The app gives the page only these permissions: microphone and camera,
  screen capture, clipboard write and full screen.
- The Electron fuses turn off `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and
  the Node.js inspector arguments.

### Server address

The first start shows the same server address page as the Tauri app. The
window is a secure page, and Chromium blocks http requests from a secure
page. Thus the Linux app needs an https address. It accepts http only for
this computer (`localhost`). The app keeps the address in `settings.json`
in the user data folder (`~/.config/Mortium`). The address is not a
secret.

### Services of the Linux app

| Service | How it works |
|---|---|
| Secure store | Electron `safeStorage`: each value is encrypted with a key from the system key ring (GNOME Keyring or KWallet, through the Secret Service API). The file `secure-store.json` holds only ciphertext. Without a key ring, Electron uses the `basic_text` backend, which is plain text in practice. The app then refuses to keep secrets, and shows a page with the fix (see below). |
| Notifications | An Electron notification (libnotify). A click shows the window and opens the channel. |
| Push to talk | On X11, `uiohook-napi` reads the key down and key up events of the whole desktop session, also while the window has no focus. Other apps also get the key, so use a key that they do not use, such as a function key. The hook runs only during a call in push-to-talk mode. On Wayland, see "Push to talk on Wayland" below. |
| Deep links | Scheme `mortium`. The deb package registers it in its desktop file. At start, the app also calls `setAsDefaultProtocolClient`. A second start of the app gives its link to the running app (single instance lock), and then stops. |
| OAuth | The same flow as the Tauri app: the system browser, then `mortium://auth/callback`. |
| Link previews | The main process uses the fetch of the server (`packages/link-preview-fetch`), with the same address rules. Thus a link cannot reach the private network of the user. |
| Tray | Show, Mute, Deafen and Quit. By default, the close button keeps the app in the tray. The tray uses the StatusNotifierItem protocol. GNOME shows it only with the AppIndicator extension. Without a tray icon, start the app again to show the window, or turn off "Keep the app in the tray" in the account settings. |
| Window state | The app keeps the size, the position and the maximized state in `window-state.json`. It does not use a position that is not on a screen. |
| Unread badge | `app.setBadgeCount`. Linux shows the number only on a Unity launcher, such as the Ubuntu dock. |
| Updates | See "Linux updates" below. |

### Push to talk on Wayland

Wayland does not let an app read the keys of other apps. The
GlobalShortcuts portal (Electron `globalShortcut` with
`--enable-features=GlobalShortcutsPortal`) reports only the key press, not
the key release. A hold-to-talk key needs the release, so the app does not
use the portal. On a Wayland session, the voice settings show "Global push
to talk is not available on this desktop session.", and push to talk works
only while the app window has focus. An X11 session (for example "GNOME on
Xorg") gives the global key.

### Without a key ring

When the app finds no key ring, it shows "The app cannot keep your sign-in
safely" with these steps:

1. Install GNOME Keyring (package `gnome-keyring`) or KWallet.
2. Make sure that the key ring starts with the desktop session and is
   unlocked.
3. On a desktop other than GNOME or KDE, start the app with
   `--password-store=gnome-libsecret` (or `--password-store=kwallet5`).
   Chromium selects the key ring from the desktop name, and it does not
   know other desktops.
4. Quit the app from the tray menu, then start it again.

### Screen share on Linux

A call to `getDisplayMedia` comes to `setDisplayMediaRequestHandler` in the
main process. The app gets the screens and the windows from
`desktopCapturer` and shows a small picker window with a thumbnail of each.

- X11: the picker shows each screen and each window. With only one
  source, the app shares it at once.
- Wayland: Chromium uses the PipeWire screen cast portal. The system shows
  its own picker, and the app then shares the one source that the system
  gives.
- System audio: Electron gives system audio ("loopback") only on Windows.
  On Linux, a screen share has no system audio. A later milestone can add
  a PipeWire audio capture.

### Linux updates

- The AppImage updates itself with `electron-updater`. The app asks for
  `latest-linux.yml` of the latest GitHub release, 30 s after start and
  then every 6 hours. It shows the same prompt as the Tauri app. The
  updater checks the SHA-512 hash of the download against
  `latest-linux.yml`. The Linux files have no code signature.
- The deb package does not update itself. To update, install the new deb
  package with the package manager, for example
  `sudo apt install ./mortium-<version>-amd64.deb`.
- The updater URL must be public, the same as for the Tauri app.

### Build, test and release the Linux app

- Run `pnpm --filter @mortium/desktop-electron package` on Linux.
  This makes the web build, bundles the Electron code with esbuild, and
  runs electron-builder. The output is in `apps/desktop-electron/release`:
  `mortium-<version>-x86_64.AppImage` (about 120 MiB),
  `mortium-<version>-amd64.deb` (about 95 MiB, 285 MiB after the
  install) and `latest-linux.yml`. Most of the size is Electron
  (Chromium). The code of the app is less than 1 MiB, and the web build
  is 1.4 MiB. Add `--arm64` for an arm64 build.
- The deb package installs to `/opt/mortium`. The product name of
  the package has no space: the SUID sandbox helper of Chromium cannot
  start an app from a path with a space.
- To start the app from the repository, run
  `node apps/desktop-electron/node_modules/electron/install.js` one time
  (pnpm does not run the install script of Electron). Then run
  `pnpm --filter @mortium/desktop-electron start`.
- The "electron" job of `.github/workflows/ci.yml` installs the deb package
  on Ubuntu, starts Postgres and the API, and runs
  `apps/desktop-electron/scripts/smoke.mjs` under `xvfb-run` with an
  unlocked GNOME Keyring. The script connects to the app through the
  Chrome DevTools Protocol. It checks the server address page, the sign-in
  page, CSP and CORS, the crypto WASM, the secure store, a link preview of
  a private address, screen share and the global push-to-talk key (with
  `xdotool`). A second run without a key ring checks the key ring page.
- The "linux" job of `.github/workflows/release.yml` builds the AppImage
  and the deb package, and attaches them with `latest-linux.yml` to the
  release. The workflow sets `version` in
  `apps/desktop-electron/package.json` to the release version.
- Ubuntu 23.10 and later limit user namespaces with AppArmor. The deb
  package installs an AppArmor profile for the app. An AppImage has no
  profile, so the Chromium sandbox can refuse to start on these systems.
  Use the deb package there. Do not start the app with `--no-sandbox`.

## How to run the media diagnostics check by hand

The web app has a small dev-only panel that checks the WebRTC and media
capture APIs. It is not part of the normal app.

1. Start the web app in dev mode: `pnpm --filter web dev`.
2. Open the printed URL with `?diag` added, for example
   `http://localhost:5173/?diag`.
3. A panel appears in the bottom right corner. It shows whether
   `RTCPeerConnection`, `getUserMedia` and `getDisplayMedia` are present.
4. Click "Test microphone", "Test camera" or "Test screen share".
   - The browser or the desktop shell may show its own permission
     prompt. A person must approve this by hand; no script can approve
     it.
   - After approval, the panel shows the track kind, the device label
     and the track settings, then it stops the track.

To run the same check inside the Tauri shell, start the shell in dev mode
(`pnpm --filter @mortium/desktop-tauri dev`) and add `?diag` to the window URL
through the same dev server, since the shell loads that URL directly.
