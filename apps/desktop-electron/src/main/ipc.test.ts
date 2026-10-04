// Tests for the IPC handlers: the argument checks of each call, the
// argument count, the sender check and the error results.
import { describe, expect, it, vi } from "vitest";
import { CALLS, callChannel, type CallName, type CallResult } from "../shared/channels.js";
import {
  ARGUMENT_COUNTS,
  createCallHandlers,
  registerCalls,
  runCall,
  type CallEvent,
  type DesktopServices,
} from "./ipc.js";

function fakeServices(): DesktopServices {
  return {
    init: vi.fn(() => ({ os: "linux" as const, version: "0.1.0", serverUrl: null, deepLinks: [] })),
    secureGet: vi.fn(async () => "value"),
    secureSet: vi.fn(async () => {}),
    secureDelete: vi.fn(async () => {}),
    checkServer: vi.fn(async () => "https://chat.example.com"),
    setServerUrl: vi.fn(async () => {}),
    fetchLinkPreview: vi.fn(async () => null),
    notify: vi.fn(),
    setPushToTalk: vi.fn(),
    setVoiceState: vi.fn(),
    setCloseToTray: vi.fn(),
    setUnreadBadge: vi.fn(),
    checkUpdate: vi.fn(async () => null),
    installUpdate: vi.fn(async () => {}),
    openUrl: vi.fn(async () => {}),
  };
}

async function call(services: DesktopServices, name: CallName, ...args: unknown[]): Promise<CallResult> {
  return runCall(createCallHandlers(services), name, args);
}

describe("the call handlers", () => {
  it("has a handler and an argument count for each call", () => {
    const handlers = createCallHandlers(fakeServices());
    for (const name of CALLS) {
      expect(typeof handlers[name]).toBe("function");
      expect(ARGUMENT_COUNTS[name]).toBeGreaterThanOrEqual(0);
    }
  });

  it("passes valid arguments to the services", async () => {
    const services = fakeServices();
    expect(await call(services, "secureGet", "crypto-pickle-key:2:B1")).toEqual({ ok: true, value: "value" });
    expect(await call(services, "secureSet", "session", "{}")).toEqual({ ok: true, value: null });
    expect(services.secureSet).toHaveBeenCalledWith("session", "{}");
    await call(services, "notify", "abc123n1", "Title", "Body");
    expect(services.notify).toHaveBeenCalledWith("abc123n1", "Title", "Body");
    await call(services, "setPushToTalk", "Control+Shift+KeyT");
    await call(services, "setPushToTalk", null);
    expect(services.setPushToTalk).toHaveBeenNthCalledWith(1, "Control+Shift+KeyT");
    expect(services.setPushToTalk).toHaveBeenNthCalledWith(2, null);
    await call(services, "setVoiceState", true, false, true);
    expect(services.setVoiceState).toHaveBeenCalledWith(true, false, true);
    await call(services, "setUnreadBadge", 7);
    expect(services.setUnreadBadge).toHaveBeenCalledWith(7);
    await call(services, "openUrl", "https://example.com/a b");
    expect(services.openUrl).toHaveBeenCalledWith("https://example.com/a%20b");
    await call(services, "setServerUrl", null);
    expect(services.setServerUrl).toHaveBeenCalledWith(null);
  });

  it("refuses arguments of the wrong type or form, and does not call the service", async () => {
    const services = fakeServices();
    const refused: Array<[CallName, unknown[]]> = [
      ["secureGet", ["../etc/passwd"]],
      ["secureGet", [""]],
      ["secureGet", [42]],
      ["secureSet", ["session", { toString: () => "x" }]],
      ["secureSet", ["session", "x".repeat(16 * 1024 + 1)]],
      ["secureDelete", ["a".repeat(129)]],
      ["checkServer", [null]],
      ["setServerUrl", [123]],
      ["fetchLinkPreview", ["file:///etc/passwd"]],
      ["fetchLinkPreview", ["javascript:alert(1)"]],
      ["notify", ["../x", "Title", "Body"]],
      ["notify", ["abc", "Title", 5]],
      ["setPushToTalk", ["Control+Shift+Key T"]],
      ["setPushToTalk", [undefined]],
      ["setVoiceState", [true, "no", false]],
      ["setCloseToTray", ["true"]],
      ["setUnreadBadge", [-1]],
      ["setUnreadBadge", [1.5]],
      ["setUnreadBadge", [Number.NaN]],
      ["openUrl", ["file:///home"]],
      ["openUrl", ["smb://server/share"]],
    ];
    for (const [name, args] of refused) {
      const result = await call(services, name, ...args);
      expect(result.ok, `${name} ${JSON.stringify(args)}`).toBe(false);
    }
    for (const service of Object.values(services)) {
      if (service !== services.init) {
        expect(service).not.toHaveBeenCalled();
      }
    }
  });

  it("refuses a call with the wrong number of arguments", async () => {
    const services = fakeServices();
    expect(await call(services, "secureGet", "session", "extra")).toEqual({
      ok: false,
      message: "The call has the wrong number of arguments.",
    });
    expect(await call(services, "setVoiceState", true, false)).toMatchObject({ ok: false });
    expect(services.secureGet).not.toHaveBeenCalled();
  });

  it("gives the plain message of a service error", async () => {
    const services = fakeServices();
    services.checkServer = vi.fn(async () => {
      throw new Error("The server at https://x.test did not answer. Check the address.");
    });
    expect(await call(services, "checkServer", "x.test")).toEqual({
      ok: false,
      message: "The server at https://x.test did not answer. Check the address.",
    });
  });
});

describe("registerCalls", () => {
  it("registers one channel for each call and refuses an untrusted sender", async () => {
    const listeners = new Map<string, (event: CallEvent, ...args: unknown[]) => Promise<CallResult>>();
    const services = fakeServices();
    const trusted = { url: "app://mortium/", parent: null };
    registerCalls(
      { handle: (channel, listener) => listeners.set(channel, listener) },
      createCallHandlers(services),
      (event) => event.senderFrame === trusted,
    );
    expect([...listeners.keys()].sort()).toEqual(CALLS.map(callChannel).sort());

    const listener = listeners.get(callChannel("secureGet"))!;
    expect(await listener({ sender: {}, senderFrame: trusted }, "session")).toEqual({ ok: true, value: "value" });
    expect(
      await listener({ sender: {}, senderFrame: { url: "https://evil.example/", parent: null } }, "session"),
    ).toEqual({ ok: false, message: "This page cannot use the desktop app." });
    expect(services.secureGet).toHaveBeenCalledTimes(1);
  });
});
