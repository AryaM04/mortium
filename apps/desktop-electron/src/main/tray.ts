// The tray icon of the Linux app: Show, Mute, Deafen and Quit. Mute and
// Deafen work only during a call. On Linux, the tray uses the
// StatusNotifierItem (AppIndicator) protocol. GNOME shows it only with the
// AppIndicator extension.
import { Menu, Tray, nativeImage } from "electron";

export interface TrayActions {
  show(): void;
  mute(): void;
  deafen(): void;
  quit(): void;
}

export interface VoiceState {
  inCall: boolean;
  muted: boolean;
  deafened: boolean;
}

export class AppTray {
  private readonly tray: Tray;
  private state: VoiceState = { inCall: false, muted: false, deafened: false };

  constructor(
    iconPath: string,
    private readonly actions: TrayActions,
  ) {
    this.tray = new Tray(nativeImage.createFromPath(iconPath));
    this.tray.setToolTip("Mortium");
    this.tray.on("click", () => actions.show());
    this.update();
  }

  setVoiceState(state: VoiceState): void {
    this.state = state;
    this.update();
  }

  private update(): void {
    const { inCall, muted, deafened } = this.state;
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Show", click: () => this.actions.show() },
        { type: "separator" },
        { label: "Mute", type: "checkbox", checked: muted, enabled: inCall, click: () => this.actions.mute() },
        { label: "Deafen", type: "checkbox", checked: deafened, enabled: inCall, click: () => this.actions.deafen() },
        { type: "separator" },
        { label: "Quit", click: () => this.actions.quit() },
      ]),
    );
  }

  destroy(): void {
    this.tray.destroy();
  }
}
