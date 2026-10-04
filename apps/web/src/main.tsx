// Web app entry point.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { VoiceDebugPeerStats } from "@mortium/client-core/voice";
import type { DesktopBridge } from "@mortium/shared";
import { App } from "./App.js";
import { cryptoDebug, type CryptoDebug } from "./lib/crypto.js";
import { getVoiceDebugStats, isLocalVoiceTrackEnabled } from "./lib/voice.js";
import "./theme.css";

declare global {
  interface Window {
    /** A voice call's raw stats, for the voice end-to-end test only. See CLAUDE.md: never in a production build. */
    __voiceDebug?: {
      getStats(): Promise<VoiceDebugPeerStats[]>;
      isLocalTrackEnabled(): boolean | null;
    };
    /** The crypto layer state, for the E2EE end-to-end test only. Never in a production build. */
    __cryptoDebug?: CryptoDebug;
  }
}

// Expose voice debug stats only in a dev build or a test run, never in
// production: this hook exists for the voice end-to-end test alone.
if (import.meta.env.DEV || import.meta.env.MODE === "test") {
  window.__voiceDebug = {
    getStats: getVoiceDebugStats,
    isLocalTrackEnabled: isLocalVoiceTrackEnabled,
  };
  window.__cryptoDebug = cryptoDebug;
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found. Check the id in index.html.");
}

/**
 * The Tauri app (Windows, macOS) puts `__TAURI_INTERNALS__` on the window.
 * The Electron app (Linux) puts `desktopBridge` there with its preload
 * script. The desktop platform loads with a dynamic import, so the web
 * bundle does not grow. It sets the server address and the platform
 * before the app renders.
 */
async function start(root: HTMLElement): Promise<void> {
  if ("__TAURI_INTERNALS__" in window) {
    const [{ startDesktop }, { tauriBridge }] = await Promise.all([
      import("./desktop/desktop-platform.js"),
      import("./desktop/tauri-bridge.js"),
    ]);
    await startDesktop(root, tauriBridge);
  } else if ("desktopBridge" in window) {
    const { startDesktop } = await import("./desktop/desktop-platform.js");
    await startDesktop(root, (window as unknown as { desktopBridge: DesktopBridge }).desktopBridge);
  }
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start(rootElement);
