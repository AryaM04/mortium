// The Linux desktop app (Electron). It loads the web build in a window,
// from the app:// protocol, and adds what a browser tab cannot do: a
// secure store (safeStorage), system notifications, a global push-to-talk
// key, a tray icon, deep links, link previews without a server, a screen
// picker and updates. See docs/concepts/desktop-shells.md.
//
// The window runs with context isolation, the sandbox and no Node.js. The
// preload script gives the page only the functions of `DesktopBridge`.
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Notification,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  type WebContents,
} from "electron";
import type { DesktopEvents, DesktopOs } from "@mortium/shared";
import { APP_HOST, APP_ORIGIN, APP_SCHEME, DEEP_LINK_SCHEME, eventChannel } from "../shared/channels.js";
import { createAppProtocolHandler } from "./app-protocol.js";
import { registerAppImageLinks } from "./appimage-links.js";
import { deepLinksIn, PendingLinks } from "./deep-links.js";
import { createCallHandlers, registerCalls, type DesktopServices } from "./ipc.js";
import { JsonFile } from "./json-file.js";
import { createLinkPreview } from "./link-preview.js";
import { GlobalPushToTalk, pushToTalkUnavailableReason, type KeyHook } from "./push-to-talk.js";
import { setUpScreenShare } from "./screen-picker.js";
import { SecureStore, secureStoreUnavailableReason } from "./secure-store.js";
import { checkServer, normalizeServerAddress } from "./server-address.js";
import { AppTray } from "./tray.js";
import { canUpdateItself, Updates } from "./updates.js";
import { DEFAULT_SIZE, MIN_SIZE, restorableState, type WindowState } from "./window-state.js";

/** The permissions that the app page can get. The default of Electron is to grant all. */
const ALLOWED_PERMISSIONS = new Set(["media", "display-capture", "clipboard-sanitized-write", "fullscreen"]);
/** The app keeps this many notifications, so that a click still reaches its handler. */
const MAX_NOTIFICATIONS = 20;

function isAppUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === `${APP_SCHEME}:` && parsed.host === APP_HOST;
  } catch {
    return false;
  }
}

function isWebUrl(url: string): boolean {
  try {
    const { protocol: scheme } = new URL(url);
    return scheme === "http:" || scheme === "https:";
  } catch {
    return false;
  }
}

function desktopOs(): DesktopOs {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "linux";
}

/** The folder of the web build: next to the app in a package, else apps/web/dist. */
function webRoot(): string {
  return app.isPackaged ? join(process.resourcesPath, "web") : join(__dirname, "..", "..", "web", "dist");
}

/** Refuse navigation away from the app and new windows. http and https links open in the system browser. */
function guardContents(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  contents.on("will-navigate", (event) => {
    if (!isAppUrl(event.url)) {
      event.preventDefault();
      if (isWebUrl(event.url)) {
        void shell.openExternal(event.url);
      }
    }
  });
  contents.on("will-redirect", (event) => {
    if (!isAppUrl(event.url)) {
      event.preventDefault();
    }
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
}

// The scheme must be registered before the app is ready. "standard" and
// "secure" give the page a real origin and a secure context (WebCrypto,
// getUserMedia).
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
]);

if (!app.requestSingleInstanceLock()) {
  // A second start gives its arguments (a deep link) to the first app, then stops.
  app.quit();
} else {
  start();
}

function start(): void {
  let mainWindow: BrowserWindow | null = null;
  let quitting = false;
  let closeToTray = true;
  let tray: AppTray | null = null;

  const userData = app.getPath("userData");
  const settingsFile = new JsonFile<{ serverUrl: string | null }>(join(userData, "settings.json"));
  const windowStateFile = new JsonFile<WindowState>(join(userData, "window-state.json"));
  const iconPath = join(__dirname, "..", "assets", "icon.png");

  let serverUrl: string | null = null;
  try {
    const stored = settingsFile.read()?.serverUrl;
    serverUrl = typeof stored === "string" ? normalizeServerAddress(stored) : null;
  } catch {
    // A kept address that is not valid counts as no address.
  }

  function send<K extends keyof DesktopEvents>(name: K, payload: DesktopEvents[K]): void {
    mainWindow?.webContents.send(eventChannel(name), payload);
  }

  const pendingLinks = new PendingLinks((links) => send("deep-link", links));
  pendingLinks.add(deepLinksIn(process.argv, DEEP_LINK_SCHEME));

  function showWindow(): void {
    if (!mainWindow) {
      createWindow();
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
  }

  function saveWindowState(window: BrowserWindow): void {
    void windowStateFile
      .write({ bounds: window.getNormalBounds(), maximized: window.isMaximized() })
      .catch(() => {
        // The next start uses the default size.
      });
  }

  function createWindow(): void {
    const state = restorableState(
      windowStateFile.read(),
      screen.getAllDisplays().map((display) => display.workArea),
    );
    const window = new BrowserWindow({
      ...(state?.bounds ?? DEFAULT_SIZE),
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      title: "Mortium",
      icon: iconPath,
      show: false,
      backgroundColor: "#313338",
      webPreferences: {
        preload: join(__dirname, "preload.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        // The spell checker downloads dictionaries from a Google server.
        spellcheck: false,
      },
    });
    if (state?.maximized) {
      window.maximize();
    }
    window.once("ready-to-show", () => window.show());
    window.on("close", (event) => {
      saveWindowState(window);
      if (!quitting && closeToTray) {
        event.preventDefault();
        window.hide();
      }
    });
    window.on("closed", () => {
      mainWindow = null;
    });
    // A new page load (start, reload, a new server) listens again only after `init`.
    window.webContents.on("did-start-loading", () => pendingLinks.hold());
    mainWindow = window;
    void window.loadURL(`${APP_ORIGIN}/`);
  }

  app.on("second-instance", (_event, argv) => {
    showWindow();
    pendingLinks.add(deepLinksIn(argv, DEEP_LINK_SCHEME));
  });
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("window-all-closed", () => app.quit());
  app.on("web-contents-created", (_event, contents) => guardContents(contents));

  void app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    const defaultSession = session.defaultSession;
    defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) =>
      callback(ALLOWED_PERMISSIONS.has(permission) && isAppUrl(details.requestingUrl)),
    );
    defaultSession.setPermissionCheckHandler(
      (_contents, permission, requestingOrigin) => ALLOWED_PERMISSIONS.has(permission) && isAppUrl(requestingOrigin),
    );
    protocol.handle(
      APP_SCHEME,
      createAppProtocolHandler({
        webRoot: webRoot(),
        desktopRoot: join(__dirname, "desktop"),
        host: APP_HOST,
        serverOrigin: () => serverUrl,
      }),
    );

    const secureReason = secureStoreUnavailableReason(safeStorage, process.platform);
    const secureStore = new SecureStore(join(userData, "secure-store.json"), safeStorage, secureReason);
    const pushToTalkReason = pushToTalkUnavailableReason(process.platform, process.env);
    const pushToTalk = new GlobalPushToTalk(
      async () => (await import("uiohook-napi")).uIOhook as unknown as KeyHook,
      (pressed) => send("push-to-talk", pressed),
    );
    const updates = new Updates(canUpdateItself(app.isPackaged, process.env), () => {
      quitting = true;
    });
    const fetchLinkPreview = createLinkPreview();
    const notifications = new Map<string, Notification>();

    const services: DesktopServices = {
      init: () => ({
        os: desktopOs(),
        version: app.getVersion(),
        serverUrl,
        deepLinks: pendingLinks.take(),
        secureStoreUnavailableReason: secureReason,
        pushToTalkUnavailableReason: pushToTalkReason,
      }),
      secureGet: (key) => secureStore.get(key),
      secureSet: (key, value) => secureStore.set(key, value),
      secureDelete: (key) => secureStore.delete(key),
      checkServer: (url) => checkServer(url, APP_ORIGIN),
      async setServerUrl(url) {
        const origin = url === null ? null : normalizeServerAddress(url);
        await settingsFile.write({ serverUrl: origin });
        serverUrl = origin;
        // Load the page again after the answer, so the new content policy applies.
        setImmediate(() => void mainWindow?.loadURL(`${APP_ORIGIN}/`));
      },
      fetchLinkPreview,
      notify(id, title, body) {
        if (!Notification.isSupported()) {
          return;
        }
        const notification = new Notification({ title, body, icon: iconPath });
        notification.on("click", () => {
          notifications.delete(id);
          showWindow();
          pendingLinks.add([`${DEEP_LINK_SCHEME}://notification/${id}`]);
        });
        notification.on("close", () => notifications.delete(id));
        notifications.set(id, notification);
        if (notifications.size > MAX_NOTIFICATIONS) {
          const oldest = notifications.keys().next().value;
          if (oldest !== undefined) notifications.delete(oldest);
        }
        notification.show();
      },
      async setPushToTalk(shortcut) {
        if (shortcut !== null && pushToTalkReason) {
          throw new Error(pushToTalkReason);
        }
        await pushToTalk.set(shortcut);
      },
      setVoiceState: (inCall, muted, deafened) => tray?.setVoiceState({ inCall, muted, deafened }),
      setCloseToTray(enabled) {
        closeToTray = enabled;
      },
      setUnreadBadge(count) {
        // Linux shows the count only on a Unity launcher (Ubuntu dock). Elsewhere, this does nothing.
        app.setBadgeCount(count);
      },
      checkUpdate: () => updates.check(),
      installUpdate: () => updates.install(),
      openUrl: (url) => shell.openExternal(url),
    };

    registerCalls(
      ipcMain,
      createCallHandlers(services),
      (event) =>
        mainWindow !== null &&
        event.sender === mainWindow.webContents &&
        event.senderFrame !== null &&
        event.senderFrame.parent === null &&
        isAppUrl(event.senderFrame.url),
    );
    setUpScreenShare({
      session: defaultSession,
      parent: () => mainWindow,
      isAppUrl,
      preload: join(__dirname, "picker-preload.cjs"),
      pageUrl: `${APP_ORIGIN}/__desktop/picker.html`,
    });

    tray = new AppTray(join(__dirname, "..", "assets", "tray.png"), {
      show: showWindow,
      mute: () => send("tray-action", "mute"),
      deafen: () => send("tray-action", "deafen"),
      quit: () => app.quit(),
    });

    if (app.isPackaged) {
      const appImage = process.env.APPIMAGE;
      if (appImage) {
        registerAppImageLinks(appImage, DEEP_LINK_SCHEME, process.env).catch((error: unknown) => {
          console.warn("The app could not register the mortium:// links.", error);
        });
      } else {
        // The deb package also registers the scheme in its desktop file.
        app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
      }
    }
    createWindow();
  });
}
