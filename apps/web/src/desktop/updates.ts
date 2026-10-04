// Update prompts of the desktop app. The app asks GitHub Releases for a
// newer version 30 s after start and then every 6 hours. The Rust side
// checks the signature of the download. The app installs an update only
// after the user clicks "Install and restart". The prompt is plain DOM, so
// it adds no code to the web bundle.
import type { DesktopUpdateInfo as UpdateInfo } from "@mortium/shared";
import { commands, errorText } from "./bridge.js";

const FIRST_CHECK_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** The version that the user put off with "Later". The app does not ask again for it. */
let dismissedVersion: string | null = null;
let banner: HTMLElement | null = null;

function button(text: string, primary: boolean): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = text;
  element.className = "rounded px-3 py-1 text-sm font-medium";
  element.style.backgroundColor = primary ? "var(--color-accent)" : "var(--color-bg-main)";
  element.style.color = primary ? "white" : "var(--color-text-primary)";
  return element;
}

function showPrompt(update: UpdateInfo): void {
  if (banner || update.version === dismissedVersion) {
    return;
  }
  const box = document.createElement("div");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "App update");
  box.className = "fixed bottom-4 right-4 z-50 flex max-w-xs flex-col gap-2 rounded-lg border p-4 text-sm shadow-lg";
  box.style.backgroundColor = "var(--color-bg-sidebar)";
  box.style.borderColor = "var(--color-border)";
  box.style.color = "var(--color-text-primary)";

  const text = document.createElement("p");
  text.textContent = `Version ${update.version} of the app is ready to install. The app restarts after the install.`;
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.style.color = "var(--color-text-muted)";
  const actions = document.createElement("div");
  actions.className = "flex justify-end gap-2";
  const later = button("Later", false);
  const install = button("Install and restart", true);
  actions.append(later, install);
  box.append(text, status, actions);

  later.onclick = () => {
    dismissedVersion = update.version;
    box.remove();
    banner = null;
  };
  install.onclick = () => {
    install.disabled = true;
    later.disabled = true;
    status.textContent = "Downloading the update…";
    commands.installUpdate().catch((error: unknown) => {
      status.textContent = `The update did not install: ${errorText(error)}`;
      later.disabled = false;
    });
  };

  document.body.append(box);
  banner = box;
}

async function check(): Promise<void> {
  try {
    const update = await commands.checkUpdate();
    if (update) {
      showPrompt(update);
    }
  } catch {
    // No network, or no release yet. The next check tries again.
  }
}

export function startUpdateChecks(): void {
  setTimeout(() => {
    void check();
    setInterval(() => void check(), CHECK_INTERVAL_MS);
  }, FIRST_CHECK_DELAY_MS);
}
