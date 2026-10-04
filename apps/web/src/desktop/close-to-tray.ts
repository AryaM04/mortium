// The "close to the tray" setting of the desktop app. It is on by default:
// the close button hides the window, and the app stays in the tray. The
// value lives in localStorage, and the app sends it to the Rust side at
// start and on each change.
import { commands } from "./bridge.js";

const KEY = "mortium:close-to-tray";

export function readCloseToTray(): boolean {
  try {
    return localStorage.getItem(KEY) !== "false";
  } catch {
    return true;
  }
}

export async function writeCloseToTray(enabled: boolean): Promise<void> {
  try {
    localStorage.setItem(KEY, String(enabled));
  } catch {
    // The setting then lasts only until the app closes.
  }
  await commands.setCloseToTray(enabled);
}
