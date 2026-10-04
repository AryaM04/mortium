// Tests for the friend, DM and settings support in client-core: the
// realtime reducer cases, the DM permissions, the messages store with DM
// channel ids, the gateway client's payload checks, and the API wrappers.
import { describe, expect, it, vi } from "vitest";
import { DM_PERMISSIONS, Permission, encodeBase64Url } from "@mortium/shared";
import type { DmChannelJson, RelationshipJson, User } from "@mortium/shared";
import { ApiError, type ApiClient } from "./api.js";
import { createFakeCodec } from "./test/fake-codec.js";
import { acceptFriendRequest, blockUser, listRelationships, removeRelationship, sendFriendRequest } from "./friends-api.js";
import { addDmRecipient, listDmChannels, openDm, removeDmRecipient, renameGroupDm } from "./dms-api.js";
import { createGatewayClient, type GatewayDispatch, type WebSocketLike } from "./gateway.js";
import { createMessagesStore } from "./messages-store.js";
import { selfChannelPermissions } from "./permissions.js";
import { applyDispatch, createInitialRealtimeState, type RealtimeState } from "./realtime-store.js";
import { getSettings, putSettings, settingsBytes } from "./settings-api.js";

function user(id: string): User {
  return {
    id,
    username: `user${id}`,
    displayName: `User ${id}`,
    avatarKey: null,
    statusText: null,
    createdAt: "2024-01-01T00:00:00.000Z",
  };
}

function relationship(id: string, status: RelationshipJson["status"]): RelationshipJson {
  return { userId: id, status, user: user(id) };
}

function dm(id: string, recipientIds: string[], overrides: Partial<DmChannelJson> = {}): DmChannelJson {
  return {
    id,
    type: recipientIds.length > 2 ? "group_dm" : "dm",
    name: null,
    ownerId: recipientIds.length > 2 ? recipientIds[0]! : null,
    recipients: recipientIds.map(user),
    lastEventId: null,
    ...overrides,
  };
}

function voiceState(userId: string, channelId: string | null, guildId: string | null = null) {
  return {
    guildId,
    channelId,
    userId,
    deviceId: "device-1",
    selfMute: false,
    selfDeaf: false,
    selfVideo: false,
    selfStream: false,
    serverMute: false,
    serverDeaf: false,
    joinedAt: "2024-01-01T00:00:00.000Z",
  };
}

function apply(state: RealtimeState, t: string, d: unknown): RealtimeState {
  return applyDispatch(state, { t: t as GatewayDispatch["t"], d });
}

function readyWith(extra: Record<string, unknown>): RealtimeState {
  return applyDispatch(createInitialRealtimeState(), {
    t: "READY",
    d: { user: { id: "1" }, guilds: [], presences: [], ...extra },
  });
}

describe("realtime store: READY", () => {
  it("loads relationships, private channels and DM call states", () => {
    const state = readyWith({
      relationships: [relationship("2", "accepted"), relationship("3", "pending_incoming")],
      privateChannels: [dm("50", ["1", "2"])],
      privateVoiceStates: [voiceState("2", "50")],
    });
    expect(Object.keys(state.relationships)).toEqual(["2", "3"]);
    expect(state.relationships["3"]!.status).toBe("pending_incoming");
    expect(Object.keys(state.privateChannels)).toEqual(["50"]);
    expect(state.voiceStatesByChannel["50"]!["2"]!.guildId).toBeNull();
  });

  it("works for a READY without the new fields", () => {
    const state = readyWith({});
    expect(state.relationships).toEqual({});
    expect(state.privateChannels).toEqual({});
  });

  it("resets calls and the settings version", () => {
    let state = readyWith({});
    state = apply(state, "CALL_RING", { channelId: "50", userId: "2" });
    state = apply(state, "USER_SETTINGS_UPDATE", { version: 4 });
    const fresh = applyDispatch(state, { t: "READY", d: { user: { id: "1" }, guilds: [], presences: [] } });
    expect(fresh.incomingCalls).toEqual({});
    expect(fresh.remoteSettingsVersion).toBeNull();
  });
});

describe("realtime store: relationships", () => {
  it("adds, replaces and removes a relationship", () => {
    let state = readyWith({});
    state = apply(state, "RELATIONSHIP_ADD", relationship("2", "pending_outgoing"));
    expect(state.relationships["2"]!.status).toBe("pending_outgoing");
    state = apply(state, "RELATIONSHIP_ADD", relationship("2", "accepted"));
    expect(state.relationships["2"]!.status).toBe("accepted");
    state = apply(state, "RELATIONSHIP_REMOVE", { userId: "2" });
    expect(state.relationships).toEqual({});
  });

  it("returns the same state when the removed relationship is unknown", () => {
    const state = readyWith({});
    expect(apply(state, "RELATIONSHIP_REMOVE", { userId: "9" })).toBe(state);
  });

  it("does not change its input", () => {
    const state = readyWith({ relationships: [relationship("2", "accepted")] });
    const copy = structuredClone(state);
    apply(state, "RELATIONSHIP_REMOVE", { userId: "2" });
    expect(state).toEqual(copy);
  });
});

describe("realtime store: private channels", () => {
  it("adds and updates a DM with CHANNEL_CREATE and CHANNEL_UPDATE, with no guild", () => {
    let state = readyWith({});
    state = apply(state, "CHANNEL_CREATE", dm("50", ["1", "2", "3"]));
    expect(state.privateChannels["50"]!.recipients).toHaveLength(3);
    expect(state.channels["50"]).toBeUndefined();
    state = apply(state, "CHANNEL_UPDATE", dm("50", ["1", "2", "3"], { name: "The crew" }));
    expect(state.privateChannels["50"]!.name).toBe("The crew");
  });

  it("removes a DM, its call state and its ring with CHANNEL_DELETE and a null guild", () => {
    let state = readyWith({ privateChannels: [dm("50", ["1", "2"])], privateVoiceStates: [voiceState("2", "50")] });
    state = apply(state, "CALL_RING", { channelId: "50", userId: "2" });
    state = apply(state, "CHANNEL_DELETE", { id: "50", guildId: null });
    expect(state.privateChannels).toEqual({});
    expect(state.voiceStatesByChannel).toEqual({});
    expect(state.incomingCalls).toEqual({});
  });

  it("ignores the delete of an unknown DM", () => {
    const state = readyWith({});
    expect(apply(state, "CHANNEL_DELETE", { id: "50", guildId: null })).toBe(state);
  });

  it("adds and removes a recipient once", () => {
    let state = readyWith({ privateChannels: [dm("50", ["1", "2", "3"])] });
    state = apply(state, "CHANNEL_RECIPIENT_ADD", { channelId: "50", user: user("4") });
    expect(state.privateChannels["50"]!.recipients.map((u) => u.id)).toEqual(["1", "2", "3", "4"]);
    const again = apply(state, "CHANNEL_RECIPIENT_ADD", { channelId: "50", user: user("4") });
    expect(again).toBe(state);

    state = apply(state, "CHANNEL_RECIPIENT_REMOVE", { channelId: "50", userId: "2" });
    expect(state.privateChannels["50"]!.recipients.map((u) => u.id)).toEqual(["1", "3", "4"]);
    expect(apply(state, "CHANNEL_RECIPIENT_REMOVE", { channelId: "50", userId: "2" })).toBe(state);
  });

  it("ignores a recipient change for a channel it does not know", () => {
    const state = readyWith({});
    expect(apply(state, "CHANNEL_RECIPIENT_ADD", { channelId: "50", user: user("4") })).toBe(state);
    expect(apply(state, "CHANNEL_RECIPIENT_REMOVE", { channelId: "50", userId: "4" })).toBe(state);
  });

  it("keeps a guild channel out of the private channels", () => {
    let state = readyWith({
      guilds: [
        {
          id: "10",
          name: "Guild",
          iconKey: null,
          ownerId: "1",
          createdAt: "2024-01-01T00:00:00.000Z",
          roles: [],
          channels: [],
          member: { guildId: "10", userId: "1", nickname: null, joinedAt: "2024-01-01T00:00:00.000Z", roles: [] },
        },
      ],
    });
    state = apply(state, "CHANNEL_CREATE", {
      id: "11",
      guildId: "10",
      type: "text",
      name: "chat",
      topic: null,
      position: 0,
      parentId: null,
      lastEventId: null,
      permissionOverwrites: [],
    });
    expect(state.channels["11"]).toBeDefined();
    expect(state.privateChannels).toEqual({});
  });

  it("tracks a DM call with a null guild in the voice states", () => {
    let state = readyWith({ privateChannels: [dm("50", ["1", "2"])] });
    state = apply(state, "VOICE_STATE_UPDATE", voiceState("2", "50"));
    expect(state.voiceStatesByChannel["50"]!["2"]!.guildId).toBeNull();
    state = apply(state, "VOICE_STATE_UPDATE", voiceState("2", null));
    expect(state.voiceStatesByChannel["50"]).toBeUndefined();
  });
});

describe("realtime store: calls and settings", () => {
  it("adds a ring with CALL_RING and removes it with CALL_RING_STOP", () => {
    let state = readyWith({});
    state = apply(state, "CALL_RING", { channelId: "50", userId: "2" });
    expect(state.incomingCalls).toEqual({ "50": { channelId: "50", userId: "2" } });
    state = apply(state, "CALL_RING_STOP", { channelId: "50" });
    expect(state.incomingCalls).toEqual({});
    expect(apply(state, "CALL_RING_STOP", { channelId: "50" })).toBe(state);
  });

  it("keeps the newest settings version from USER_SETTINGS_UPDATE", () => {
    let state = readyWith({});
    state = apply(state, "USER_SETTINGS_UPDATE", { version: 3 });
    expect(state.remoteSettingsVersion).toBe(3);
    expect(apply(state, "USER_SETTINGS_UPDATE", { version: 2 })).toBe(state);
    state = apply(state, "USER_SETTINGS_UPDATE", { version: 5 });
    expect(state.remoteSettingsVersion).toBe(5);
  });
});

describe("permissions in a DM", () => {
  it("gives every recipient the DM permissions and no MANAGE permission", () => {
    const state = readyWith({ privateChannels: [dm("50", ["1", "2"])] });
    const permissions = selfChannelPermissions(state, "50");
    expect(permissions).toBe(DM_PERMISSIONS);
    for (const name of ["SEND_MESSAGES", "READ_MESSAGE_HISTORY", "ADD_REACTIONS", "CONNECT", "SPEAK"] as const) {
      expect(permissions & Permission[name]).toBe(Permission[name]);
    }
    for (const name of ["MANAGE_MESSAGES", "MANAGE_CHANNELS", "MANAGE_ROLES", "MANAGE_GUILD", "ADMINISTRATOR"] as const) {
      expect(permissions & Permission[name]).toBe(0n);
    }
  });

  it("still works for a guild channel with a partial state, like the settings dialogs build", () => {
    // The web settings dialogs pass a state with only the guild fields. It has no private channels.
    const partial = {
      guilds: { "10": { id: "10", ownerId: "1" } },
      selfMemberByGuild: { "10": { guildId: "10", userId: "1", nickname: null, joinedAt: "", roles: [] } },
      rolesByGuild: { "10": [{ id: "10", guildId: "10", name: "@everyone", color: 0, position: 0, permissions: "0", mentionable: true, hoist: false }] },
      channels: {
        "11": { id: "11", guildId: "10", type: "text", name: "chat", topic: null, position: 0, parentId: null, lastEventId: null, permissionOverwrites: [] },
      },
      selfUserId: "1",
    } as unknown as RealtimeState;
    expect(selfChannelPermissions(partial, "11") & Permission.MANAGE_ROLES).toBe(Permission.MANAGE_ROLES);
  });

  it("gives no permission for an unknown channel", () => {
    expect(selfChannelPermissions(readyWith({}), "50")).toBe(0n);
  });
});

describe("messages store with DM channel ids", () => {
  function makeStore() {
    const api = { request: vi.fn() } as unknown as ApiClient;
    return createMessagesStore({ api, codec: createFakeCodec(), send: vi.fn() });
  }

  it("seeds the unread baseline of a DM from READY", () => {
    const store = makeStore();
    store.getState().applyDispatch("READY", {
      guilds: [],
      privateChannels: [dm("50", ["1", "2"], { lastEventId: "900" })],
      readStates: [{ channelId: "50", lastReadEventId: "800" }],
    });
    const channel = store.getState().channels["50"]!;
    expect(channel.lastEventId).toBe("900");
    expect(channel.lastReadEventId).toBe("800");
  });

  it("seeds a new DM from CHANNEL_CREATE, and leaves a guild channel alone", () => {
    const store = makeStore();
    store.getState().applyDispatch("CHANNEL_CREATE", dm("50", ["1", "2"], { lastEventId: "700" }));
    expect(store.getState().channels["50"]!.lastEventId).toBe("700");
    store.getState().applyDispatch("CHANNEL_CREATE", { id: "60", guildId: "10", type: "text", lastEventId: "700" });
    expect(store.getState().channels["60"]).toBeUndefined();
  });

  it("tracks the events, unread state and typing of a DM like any channel", async () => {
    const store = makeStore();
    store.getState().applyDispatch("READY", {
      guilds: [],
      privateChannels: [dm("50", ["1", "2"])],
      readStates: [],
    });
    store.getState().applyDispatch("EVENT_CREATE", {
      id: "901",
      channelId: "50",
      senderId: "2",
      senderDeviceId: "device-2",
      relType: null,
      relatesToId: null,
      codec: "plain-v1",
      megolmSessionId: null,
      ciphertext: encodeBase64Url(new TextEncoder().encode(JSON.stringify({ type: "message", body: "hi", mentions: [] }))),
      nonce: "n1",
      createdAt: "2024-01-01T00:00:00.000Z",
      redactedAt: null,
    });
    store.getState().applyDispatch("TYPING_START", { channelId: "50", userId: "2" });
    await vi.waitFor(() => expect(store.getState().channels["50"]!.payloads["901"]).toBeDefined());
    const channel = store.getState().channels["50"]!;
    expect(channel.lastEventId).toBe("901");
    expect(Object.keys(channel.typing)).toEqual(["2"]);
  });

  it("sends a message to a DM with the same route as a guild channel", async () => {
    const request = vi.fn().mockResolvedValue({
      id: "902",
      channelId: "50",
      senderId: "1",
      senderDeviceId: "device-1",
      relType: null,
      relatesToId: null,
      codec: "plain-v1",
      megolmSessionId: null,
      ciphertext: "AAAA",
      nonce: "n2",
      createdAt: "2024-01-01T00:00:00.000Z",
      redactedAt: null,
    });
    const store = createMessagesStore({
      api: { request } as unknown as ApiClient,
      codec: createFakeCodec(),
      send: vi.fn(),
      makeNonce: () => "n2",
    });
    store.getState().setSelfUserId("1");
    await store.getState().sendMessage("50", "hello", []);
    expect(request).toHaveBeenCalledWith("POST", "/channels/50/events", expect.anything());
  });

  it("keeps the server error of a failed send, such as a block", async () => {
    const request = vi.fn().mockRejectedValue(new ApiError(403, "CANNOT_MESSAGE_USER", "You cannot send messages to this user."));
    const store = createMessagesStore({
      api: { request } as unknown as ApiClient,
      codec: createFakeCodec(),
      send: vi.fn(),
      makeNonce: () => "n3",
    });
    await store.getState().sendMessage("50", "hello", []);
    const pending = store.getState().channels["50"]!.pending[0]!;
    expect(pending.state).toBe("failed");
    expect(pending.error).toBe("You cannot send messages to this user.");
  });
});

describe("gateway client with the new dispatches", () => {
  class FakeSocket implements WebSocketLike {
    readyState = 1;
    onopen: (() => void) | null = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    send(): void {}
    close(): void {}
    serverSend(envelope: Record<string, unknown>): void {
      this.onmessage?.({ data: JSON.stringify(envelope) });
    }
  }

  async function connected() {
    const events: GatewayDispatch[] = [];
    let socket!: FakeSocket;
    const client = createGatewayClient({
      url: "wss://gateway.test",
      deviceId: "device-1",
      api: { getAccessToken: async () => "token" },
      onEvent: (event) => events.push(event),
      onState: () => undefined,
      createSocket: () => {
        socket = new FakeSocket();
        return socket;
      },
    });
    await Promise.resolve();
    socket.serverSend({ op: 4, d: { heartbeatIntervalMs: 600_000 } });
    socket.serverSend({
      op: 0,
      t: "READY",
      d: { sessionId: "s1", user: { id: "1" }, guilds: [], presences: [], readStates: [] },
    });
    return { events, socket, client };
  }

  it("passes on every new dispatch with a valid payload, and drops an invalid one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { events, socket, client } = await connected();
    const dispatch = (t: string, d: unknown, s: number) => socket.serverSend({ op: 0, t, s, d });

    dispatch("RELATIONSHIP_ADD", relationship("2", "accepted"), 1);
    dispatch("RELATIONSHIP_REMOVE", { userId: "2" }, 2);
    dispatch("CHANNEL_CREATE", dm("50", ["1", "2"]), 3);
    dispatch("CHANNEL_UPDATE", dm("50", ["1", "2", "3"]), 4);
    dispatch("CHANNEL_DELETE", { id: "50", guildId: null }, 5);
    dispatch("CHANNEL_RECIPIENT_ADD", { channelId: "50", user: user("4") }, 6);
    dispatch("CHANNEL_RECIPIENT_REMOVE", { channelId: "50", userId: "4" }, 7);
    dispatch("CALL_RING", { channelId: "50", userId: "2" }, 8);
    dispatch("CALL_RING_STOP", { channelId: "50" }, 9);
    dispatch("USER_SETTINGS_UPDATE", { version: 2 }, 10);
    dispatch("VOICE_STATE_UPDATE", voiceState("2", "50"), 11);
    dispatch("CALL_RING", { channelId: 50 }, 12);

    const names = events.map((event) => event.t).filter((t) => t !== "READY");
    expect(names).toEqual([
      "RELATIONSHIP_ADD",
      "RELATIONSHIP_REMOVE",
      "CHANNEL_CREATE",
      "CHANNEL_UPDATE",
      "CHANNEL_DELETE",
      "CHANNEL_RECIPIENT_ADD",
      "CHANNEL_RECIPIENT_REMOVE",
      "CALL_RING",
      "CALL_RING_STOP",
      "USER_SETTINGS_UPDATE",
      "VOICE_STATE_UPDATE",
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    client.close();
  });
});

describe("api wrappers", () => {
  function fakeApi(result: unknown = undefined) {
    const request = vi.fn().mockResolvedValue(result);
    return { api: { request } as unknown as ApiClient, request };
  }

  it("calls the relationship routes", async () => {
    const { api, request } = fakeApi({ relationships: [relationship("2", "accepted")] });
    expect(await listRelationships(api)).toHaveLength(1);
    expect(request).toHaveBeenLastCalledWith("GET", "/users/@me/relationships", expect.anything());

    await sendFriendRequest(api, "  Alice ");
    expect(request).toHaveBeenLastCalledWith(
      "POST",
      "/users/@me/relationships",
      expect.objectContaining({ body: { username: "alice" } }),
    );
    await acceptFriendRequest(api, "7");
    expect(request).toHaveBeenLastCalledWith("PUT", "/users/@me/relationships/7", expect.objectContaining({ body: { action: "accept" } }));
    await blockUser(api, "7");
    expect(request).toHaveBeenLastCalledWith("PUT", "/users/@me/relationships/7", expect.objectContaining({ body: { action: "block" } }));
    await removeRelationship(api, "7");
    expect(request).toHaveBeenLastCalledWith("DELETE", "/users/@me/relationships/7");
  });

  it("rejects a bad username before it calls the server", () => {
    const { api, request } = fakeApi();
    expect(() => sendFriendRequest(api, "Not Valid!")).toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("calls the DM routes", async () => {
    const { api, request } = fakeApi({ channels: [dm("50", ["1", "2"])] });
    expect(await listDmChannels(api)).toHaveLength(1);
    expect(request).toHaveBeenLastCalledWith("GET", "/users/@me/channels", expect.anything());

    await openDm(api, ["2"]);
    expect(request).toHaveBeenLastCalledWith("POST", "/users/@me/channels", expect.objectContaining({ body: { recipientIds: ["2"] } }));
    await addDmRecipient(api, "50", "3");
    expect(request).toHaveBeenLastCalledWith("PUT", "/channels/50/recipients/3");
    await removeDmRecipient(api, "50", "3");
    expect(request).toHaveBeenLastCalledWith("DELETE", "/channels/50/recipients/3");
    await renameGroupDm(api, "50", { name: "Crew" });
    expect(request).toHaveBeenLastCalledWith("PATCH", "/channels/50", expect.objectContaining({ body: { name: "Crew" } }));
  });

  it("checks the recipient list before it calls the server", () => {
    const { api, request } = fakeApi();
    expect(() => openDm(api, [])).toThrow();
    expect(() => openDm(api, ["2", "2"])).toThrow();
    expect(() => openDm(api, Array.from({ length: 10 }, (_, i) => String(i + 1)))).toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("reads and saves the settings as bytes", async () => {
    const bytes = new TextEncoder().encode('{"theme":"dark"}');
    const { api, request } = fakeApi({ data: encodeBase64Url(bytes), version: 3 });
    const response = await getSettings(api);
    expect(settingsBytes(response)).toEqual(bytes);
    expect(settingsBytes({ data: null, version: 0 })).toBeNull();

    await putSettings(api, bytes, 3);
    expect(request).toHaveBeenLastCalledWith(
      "PUT",
      "/users/@me/settings",
      expect.objectContaining({ body: { data: encodeBase64Url(bytes), version: 3 } }),
    );
  });

  it("refuses to save settings over 64 KiB", () => {
    const { api, request } = fakeApi();
    expect(() => putSettings(api, new Uint8Array(64 * 1024 + 1), 0)).toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});
