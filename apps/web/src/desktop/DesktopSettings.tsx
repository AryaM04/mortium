// The desktop part of the account settings: the server address and the
// "close to the tray" setting. Only the desktop app loads this file.
import { useState } from "react";
import { serverOrigin } from "../lib/server-url.js";
import { session } from "../lib/session.js";
import { commands, errorText } from "./bridge.js";
import { readCloseToTray, writeCloseToTray } from "./close-to-tray.js";

export default function DesktopSettings() {
  const [closeToTray, setCloseToTray] = useState(readCloseToTray);
  const [error, setError] = useState<string | null>(null);

  async function changeServer(): Promise<void> {
    if (!window.confirm("Change the server? This signs you out of this server on this device.")) {
      return;
    }
    // Sign out first: the tokens belong to the old server.
    await session.store.getState().logout();
    try {
      await commands.setServerUrl(null);
    } catch (reason) {
      setError(errorText(reason));
    }
  }

  function toggleCloseToTray(enabled: boolean): void {
    setCloseToTray(enabled);
    writeCloseToTray(enabled).catch((reason: unknown) => setError(errorText(reason)));
  }

  return (
    <section className="mb-4 flex flex-col gap-2 border-t border-line pt-4">
      <h3 className="text-sm font-semibold">Desktop app</h3>
      <p className="text-sm text-muted">
        Server: <span data-desktop-server>{serverOrigin()}</span>
      </p>
      <button type="button" onClick={() => void changeServer()} className="self-start text-sm link">
        Change server
      </button>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={closeToTray}
          onChange={(event) => toggleCloseToTray(event.target.checked)}
        />
        Keep the app in the tray when I close the window
      </label>
      {error && (
        <p role="alert" className="text-xs text-danger-text">
          {error}
        </p>
      )}
    </section>
  );
}
