// Tests for the gateway client: identify, heartbeat and missed-ack
// reconnect, resume, invalid session, backoff growth and cap, no
// reconnect on a fatal close code, and timer cleanup on close().
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayCloseCode, GatewayOpcode } from "@mortium/shared";
import { createGatewayClient, type GatewayDispatch, type GatewayState, type WebSocketLike } from "./gateway.js";

class FakeSocket implements WebSocketLike {
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: Array<Record<string, unknown>> = [];

  constructor(public readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  serverSend(envelope: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(envelope) });
  }

  serverClose(code: number, reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

function hello(heartbeatIntervalMs = 30_000) {
  return { op: GatewayOpcode.HELLO, d: { heartbeatIntervalMs } };
}

function ready(sessionId = "session-1") {
  return {
    op: GatewayOpcode.DISPATCH,
    t: "READY",
    d: { sessionId, user: { id: "1" }, guilds: [], presences: [], readStates: [] },
  };
}

const RESUMED = { op: GatewayOpcode.DISPATCH, t: "RESUMED", d: {} };

describe("createGatewayClient", () => {
  let sockets: FakeSocket[];
  let events: GatewayDispatch[];
  let states: GatewayState[];
  let accessTokenCalls: number;

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    events = [];
    states = [];
    accessTokenCalls = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeClient(overrides: Partial<Parameters<typeof createGatewayClient>[0]> = {}) {
    return createGatewayClient({
      url: "wss://gateway.test",
      deviceId: "device-1",
      api: {
        getAccessToken: async () => {
          accessTokenCalls += 1;
          return "token-" + accessTokenCalls;
        },
      },
      onEvent: (e) => events.push(e),
      onState: (s) => states.push(s),
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      ...overrides,
    });
  }

  function currentSocket(): FakeSocket {
    const socket = sockets[sockets.length - 1];
    if (!socket) throw new Error("no socket created yet");
    return socket;
  }

  it("identifies with a fresh access token and the device id after HELLO", async () => {
    makeClient();
    await vi.advanceTimersByTimeAsync(0);
    currentSocket().serverSend(hello());
    await vi.advanceTimersByTimeAsync(0);

    expect(currentSocket().sent).toEqual([
      { op: GatewayOpcode.IDENTIFY, d: { accessToken: "token-1", deviceId: "device-1" } },
    ]);

    currentSocket().serverSend(ready());
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toContain("ready");
    expect(events.some((e) => e.t === "READY")).toBe(true);
  });

  it("sends a heartbeat and reconnects when the previous one never got an ACK", async () => {
    // A fixed jitter: with a high random value, the reconnect comes after the end of this test.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const client = makeClient();
    await vi.advanceTimersByTimeAsync(0);
    currentSocket().serverSend(hello(10_000));
    currentSocket().serverSend(ready());
    await vi.advanceTimersByTimeAsync(0);

    // First heartbeat fires somewhere within [0, intervalMs).
    await vi.advanceTimersByTimeAsync(10_000);
    const heartbeats = currentSocket().sent.filter((m) => m.op === GatewayOpcode.HEARTBEAT);
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);

    // Acknowledge it, then the next beat on schedule should be fine.
    currentSocket().serverSend({ op: GatewayOpcode.HEARTBEAT_ACK });
    const socketCountBeforeMiss = sockets.length;

    // Now let a heartbeat go out and never ACK it: the one after should
    // detect the dead link and force a reconnect.
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sockets.length).toBeGreaterThan(socketCountBeforeMiss);
    expect(states).toContain("reconnecting");
    client.close();
  });

  it("resumes with the session id and last sequence after a drop", async () => {
    const client = makeClient();
    await vi.advanceTimersByTimeAsync(0);
    currentSocket().serverSend(hello());
    currentSocket().serverSend(ready("session-xyz"));
    await vi.advanceTimersByTimeAsync(0);
    currentSocket().serverSend({
      op: GatewayOpcode.DISPATCH,
      t: "PRESENCE_UPDATE",
      s: 7,
      d: { userId: "2", status: "online" },
    });
    await vi.advanceTimersByTimeAsync(0);

    // The connection drops abnormally.
    currentSocket().serverClose(1006, "abnormal");
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toContain("reconnecting");

    await vi.advanceTimersByTimeAsync(30_000);
    currentSocket().serverSend(hello());
    await vi.advanceTimersByTimeAsync(0);

    expect(currentSocket().sent).toEqual([
      { op: GatewayOpcode.RESUME, d: { accessToken: "token-2", sessionId: "session-xyz", lastSequence: 7 } },
    ]);

    currentSocket().serverSend(RESUMED);
    await vi.advanceTimersByTimeAsync(0);
    expect(events.some((e) => e.t === "RESUMED")).toBe(true);
    client.close();
  });

  it("forwards GUILD_ROLE_CREATE/UPDATE/DELETE and GUILD_BAN_ADD/REMOVE, not just logs them as unknown", async () => {
    const client = makeClient();
    await vi.advanceTimersByTimeAsync(0);
    currentSocket().serverSend(hello());
    currentSocket().serverSend(ready());
    await vi.advanceTimersByTimeAsync(0);

    const role = { id: "2", guildId: "1", name: "Mods", color: 0, position: 1, permissions: "0", mentionable: true, hoist: false };
    currentSocket().serverSend({ op: GatewayOpcode.DISPATCH, t: "GUILD_ROLE_CREATE", s: 1, d: { guildId: "1", role } });
    currentSocket().serverSend({ op: GatewayOpcode.DISPATCH, t: "GUILD_ROLE_UPDATE", s: 2, d: { guildId: "1", role } });
    currentSocket().serverSend({ op: GatewayOpcode.DISPATCH, t: "GUILD_ROLE_DELETE", s: 3, d: { guildId: "1", roleId: "2" } });
    currentSocket().serverSend({
      op: GatewayOpcode.DISPATCH,
      t: "GUILD_BAN_ADD",
      s: 4,
      d: { guildId: "1", userId: "3", reason: null, by: "9" },
    });
    currentSocket().serverSend({
      op: GatewayOpcode.DISPATCH,
      t: "GUILD_BAN_REMOVE",
      s: 5,
      d: { guildId: "1", userId: "3" },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(events.map((e) => e.t)).toEqual([
      "READY",
      "GUILD_ROLE_CREATE",
      "GUILD_ROLE_UPDATE",
      "GUILD_ROLE_DELETE",
      "GUILD_BAN_ADD",
      "GUILD_BAN_REMOVE",
    ]);
    client.close();
  });

  it("waits 1-5s then identifies again on INVALID_SESSION", async () => {
    const client = makeClient();
    await vi.advanceTimersByTimeAsync(0);
    currentSocket().serverSend(hello());
    currentSocket().serverSend(ready("session-old"));
    await vi.advanceTimersByTimeAsync(0);

    currentSocket().serverSend({ op: GatewayOpcode.INVALID_SESSION, d: { canResume: false } });
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toContain("reconnecting");

    const socketCountBefore = sockets.length;
    await vi.advanceTimersByTimeAsync(999);
    expect(sockets.length).toBe(socketCountBefore);
    await vi.advanceTimersByTimeAsync(4_001);
    expect(sockets.length).toBeGreaterThan(socketCountBefore);

    currentSocket().serverSend(hello());
    await vi.advanceTimersByTimeAsync(0);
    // A fresh IDENTIFY, not a RESUME: the session was thrown away.
    expect(currentSocket().sent[0]?.op).toBe(GatewayOpcode.IDENTIFY);
    client.close();
  });

  it("grows the backoff delay and caps it at 30s", async () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(1);
    try {
      makeClient();
      await vi.advanceTimersByTimeAsync(0);

      const expectedDelays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
      for (const expected of expectedDelays) {
        const countBefore = sockets.length;
        currentSocket().serverClose(1006, "boom");
        await vi.advanceTimersByTimeAsync(expected - 1);
        expect(sockets.length).toBe(countBefore);
        await vi.advanceTimersByTimeAsync(1);
        expect(sockets.length).toBe(countBefore + 1);
      }
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("resets the backoff after a stable READY", async () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(1);
    try {
      makeClient();
      await vi.advanceTimersByTimeAsync(0);
      currentSocket().serverClose(1006, "boom"); // attempt 0 -> next delay 2000ms
      await vi.advanceTimersByTimeAsync(1_000);
      currentSocket().serverSend(hello());
      currentSocket().serverSend(ready());
      await vi.advanceTimersByTimeAsync(0);

      const countBefore = sockets.length;
      currentSocket().serverClose(1006, "boom again");
      await vi.advanceTimersByTimeAsync(999);
      expect(sockets.length).toBe(countBefore);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets.length).toBe(countBefore + 1);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("does not reconnect after a device-revoked close (4010)", async () => {
    const onFatal = vi.fn();
    const client = makeClient({ onFatal });
    await vi.advanceTimersByTimeAsync(0);
    currentSocket().serverSend(hello());
    currentSocket().serverSend(ready());
    await vi.advanceTimersByTimeAsync(0);

    const countBefore = sockets.length;
    currentSocket().serverClose(GatewayCloseCode.DEVICE_REVOKED, "revoked");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(sockets.length).toBe(countBefore);
    expect(client.state).toBe("closed");
    expect(onFatal).toHaveBeenCalledWith("device-revoked");
  });

  it("retries once on auth-failed (4004), then signs out on a second failure", async () => {
    const onFatal = vi.fn();
    makeClient({ onFatal });
    await vi.advanceTimersByTimeAsync(0);
    currentSocket().serverClose(GatewayCloseCode.AUTH_FAILED, "bad token");
    await vi.advanceTimersByTimeAsync(0);
    expect(onFatal).not.toHaveBeenCalled();

    currentSocket().serverClose(GatewayCloseCode.AUTH_FAILED, "bad token again");
    await vi.advanceTimersByTimeAsync(0);
    expect(onFatal).toHaveBeenCalledWith("auth-failed");
  });

  it("leaves no timers running after close()", async () => {
    const client = makeClient();
    await vi.advanceTimersByTimeAsync(0);
    currentSocket().serverSend(hello());
    currentSocket().serverSend(ready());
    await vi.advanceTimersByTimeAsync(0);

    client.close();
    expect(vi.getTimerCount()).toBe(0);
    expect(client.state).toBe("closed");

    const countBefore = sockets.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets.length).toBe(countBefore);
  });
});
