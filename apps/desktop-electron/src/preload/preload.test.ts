// Tests for the preload script: it gives the page only the bridge
// functions, sends each call on its own channel, turns a failed result
// into an Error, and checks the event names.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopBridge } from "@mortium/shared";

const exposed = new Map<string, unknown>();
const invoke = vi.fn();
const listeners = new Map<string, (...args: unknown[]) => void>();

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: (name: string, value: unknown) => exposed.set(name, value) },
  ipcRenderer: {
    invoke: (...args: unknown[]) => invoke(...args),
    on: (channel: string, listener: (...args: unknown[]) => void) => listeners.set(channel, listener),
    removeListener: (channel: string) => listeners.delete(channel),
  },
}));

const { desktopBridge } = await import("./index.js");

beforeEach(() => {
  invoke.mockReset();
});

describe("the preload bridge", () => {
  it("exposes only desktopBridge, with only the contract functions", () => {
    expect([...exposed.keys()]).toEqual(["desktopBridge"]);
    const bridge = exposed.get("desktopBridge") as DesktopBridge;
    expect(Object.keys(bridge).sort()).toEqual(
      [
        "init",
        "secureGet",
        "secureSet",
        "secureDelete",
        "checkServer",
        "setServerUrl",
        "fetchLinkPreview",
        "notify",
        "setPushToTalk",
        "setVoiceState",
        "setCloseToTray",
        "setUnreadBadge",
        "checkUpdate",
        "installUpdate",
        "openUrl",
        "onEvent",
      ].sort(),
    );
    for (const value of Object.values(bridge)) {
      expect(typeof value).toBe("function");
    }
  });

  it("sends each call on its channel with its arguments", async () => {
    invoke.mockResolvedValue({ ok: true, value: "stored" });
    expect(await desktopBridge.secureGet("session")).toBe("stored");
    expect(invoke).toHaveBeenLastCalledWith("desktop:secureGet", "session");
    invoke.mockResolvedValue({ ok: true, value: null });
    await desktopBridge.setVoiceState(true, false, true);
    expect(invoke).toHaveBeenLastCalledWith("desktop:setVoiceState", true, false, true);
    await desktopBridge.notify("n1", "Title", "Body");
    expect(invoke).toHaveBeenLastCalledWith("desktop:notify", "n1", "Title", "Body");
  });

  it("rejects with the plain message of a failed call", async () => {
    invoke.mockResolvedValue({ ok: false, message: "The server does not allow this app." });
    await expect(desktopBridge.checkServer("x.test")).rejects.toThrow(/^The server does not allow this app\.$/);
  });

  it("gives an event handler only the payload, and removes it", async () => {
    const handler = vi.fn();
    const remove = await desktopBridge.onEvent("push-to-talk", handler);
    const listener = listeners.get("desktop-event:push-to-talk")!;
    listener({ sender: "the IPC event" }, true);
    expect(handler).toHaveBeenCalledWith(true);
    remove();
    expect(listeners.has("desktop-event:push-to-talk")).toBe(false);
  });

  it("refuses an unknown event name", async () => {
    await expect(desktopBridge.onEvent("secret-event" as "deep-link", () => {})).rejects.toThrow(
      "The event name is not valid.",
    );
    expect(listeners.has("desktop-event:secret-event")).toBe(false);
  });
});
