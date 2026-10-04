// The preload script of the app window. It runs in the sandbox, with
// context isolation, and gives the web app only `window.desktopBridge`:
// the functions of the `DesktopBridge` contract (packages/shared). It
// gives no general IPC access. The main process checks each argument
// again (src/main/ipc.ts).
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { DesktopBridge, DesktopEventName } from "@mortium/shared";
import { callChannel, EVENTS, eventChannel, type CallName, type CallResult } from "../shared/channels.js";

async function call<T>(name: CallName, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(callChannel(name), ...args)) as CallResult;
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.value as T;
}

export const desktopBridge: DesktopBridge = {
  init: () => call("init"),
  secureGet: (key) => call("secureGet", key),
  secureSet: (key, value) => call("secureSet", key, value),
  secureDelete: (key) => call("secureDelete", key),
  checkServer: (url) => call("checkServer", url),
  setServerUrl: (url) => call("setServerUrl", url),
  fetchLinkPreview: (url) => call("fetchLinkPreview", url),
  notify: (id, title, body) => call("notify", id, title, body),
  setPushToTalk: (shortcut) => call("setPushToTalk", shortcut),
  setVoiceState: (inCall, muted, deafened) => call("setVoiceState", inCall, muted, deafened),
  setCloseToTray: (enabled) => call("setCloseToTray", enabled),
  setUnreadBadge: (count) => call("setUnreadBadge", count),
  checkUpdate: () => call("checkUpdate"),
  installUpdate: () => call("installUpdate"),
  openUrl: (url) => call("openUrl", url),
  async onEvent(name, handler) {
    if (!(EVENTS as readonly string[]).includes(name) || typeof handler !== "function") {
      throw new Error("The event name is not valid.");
    }
    const channel = eventChannel(name as DesktopEventName);
    // Give the web app only the payload, never the IPC event object.
    const listener = (_event: IpcRendererEvent, payload: unknown) => handler(payload as never);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },
};

contextBridge.exposeInMainWorld("desktopBridge", desktopBridge);
