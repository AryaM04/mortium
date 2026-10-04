// The bridge to the desktop shell: Tauri (Windows, macOS) or Electron
// (Linux). `startDesktop` sets it once at start. The desktop files use
// `commands` and never import a shell API directly, so one set of files
// serves both shells.
import type { DesktopBridge, DesktopEventName, DesktopEvents } from "@mortium/shared";

/** The services of the desktop shell. Set by `setDesktopBridge` before any use. */
export let commands: DesktopBridge;

export function setDesktopBridge(bridge: DesktopBridge): void {
  commands = bridge;
}

export function onDesktopEvent<K extends DesktopEventName>(
  name: K,
  handler: (payload: DesktopEvents[K]) => void,
): Promise<() => void> {
  return commands.onEvent(name, handler);
}

/** The plain message of a shell error. Tauri rejects with a text, Electron with an Error. */
export function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
