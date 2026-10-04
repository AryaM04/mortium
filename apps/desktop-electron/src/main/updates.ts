// Updates of the Linux app, with electron-updater and GitHub Releases.
// Only the AppImage updates itself: the updater reads latest-linux.yml of
// the latest release and checks the SHA-512 of the download. A deb package
// updates through the package manager, so the app does not check then.
// The web app asks 30 s after start and then every 6 hours, and installs
// only after the user clicks "Install and restart".
import type { DesktopUpdateInfo } from "@mortium/shared";

/** True when this copy of the app can update itself: a packaged AppImage. */
export function canUpdateItself(isPackaged: boolean, env: NodeJS.ProcessEnv): boolean {
  return isPackaged && typeof env.APPIMAGE === "string" && env.APPIMAGE.length > 0;
}

type Updater = typeof import("electron-updater").autoUpdater;

export class Updates {
  private updater: Updater | null = null;

  constructor(
    private readonly enabled: boolean,
    private readonly beforeInstall: () => void,
  ) {}

  private async load(): Promise<Updater> {
    if (!this.updater) {
      // Load the updater code only when it is needed.
      const { autoUpdater } = await import("electron-updater");
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = false;
      autoUpdater.logger = null;
      this.updater = autoUpdater;
    }
    return this.updater;
  }

  async check(): Promise<DesktopUpdateInfo | null> {
    if (!this.enabled) {
      return null;
    }
    const updater = await this.load();
    const result = await updater.checkForUpdates();
    if (!result?.isUpdateAvailable) {
      return null;
    }
    const notes = result.updateInfo.releaseNotes;
    return { version: result.updateInfo.version, notes: typeof notes === "string" ? notes : null };
  }

  async install(): Promise<void> {
    if (!this.enabled) {
      throw new Error("This copy of the app updates through the package manager.");
    }
    const updater = await this.load();
    await updater.downloadUpdate();
    this.beforeInstall();
    updater.quitAndInstall();
  }
}
