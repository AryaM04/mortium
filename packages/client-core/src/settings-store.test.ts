// Tests for the synced settings store, the notification rule, the DM view
// helpers and the DM order in the realtime store.
import { describe, expect, it } from "vitest";
import { decodeBase64Url, encodeBase64Url, type DmChannelJson, type User } from "@mortium/shared";
import { ApiError, type ApiClient } from "./api.js";
import { dmDisplayName, dmOtherRecipients, sortDmChannels } from "./dm-view.js";
import { shouldNotify, type NotificationInput } from "./notifications.js";
import { applyDispatch, createInitialRealtimeState } from "./realtime-store.js";
import {
  createSettingsStore,
  decodeSettings,
  isDmHidden,
  notificationLevelOf,
  playRingSoundOf,
  type SettingsCipher,
  type SettingsValues,
} from "./settings-store.js";
import { openSettings, sealSettings, settingsKeyIdOf } from "./crypto/settings-key.js";

/** A cipher with real AES-GCM and a key map in memory. The test gives it keys, as a key share does. */
function memoryCipher() {
  const keys = new Map<string, Uint8Array>();
  const listeners = new Set<() => void>();
  const cipher: SettingsCipher = {
    async open(blob) {
      const id = blob ? settingsKeyIdOf(blob) : null;
      if (!blob || id === null) {
        return { plaintext: blob, keyId: null };
      }
      const key = keys.get(id);
      return key ? { plaintext: await openSettings(key, blob), keyId: id } : "locked";
    },
    async seal(plaintext, keyId) {
      let id = keyId;
      if (!id || !keys.has(id)) {
        id = encodeBase64Url(crypto.getRandomValues(new Uint8Array(8)));
        keys.set(id, crypto.getRandomValues(new Uint8Array(32)));
      }
      return { blob: await sealSettings(keys.get(id)!, id, plaintext), keyId: id };
    },
    onKey(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    cipher,
    keys,
    deliver(id: string, key: Uint8Array) {
      keys.set(id, key);
      listeners.forEach((listener) => listener());
    },
  };
}

/** A settings server in memory, with the same version rule as the real one. */
function fakeServer(initial: SettingsValues | null = null, initialVersion = 0) {
  const server = {
    data: initial === null ? null : encodeBase64Url(new TextEncoder().encode(JSON.stringify(initial))),
    version: initialVersion,
    puts: 0,
    /** Set to make the next PUT fail as if another device saved these values first. */
    racePut: null as SettingsValues | null,
  };
  const api = {
    async request(method: string, path: string, options?: { body?: unknown }) {
      expect(path).toBe("/users/@me/settings");
      if (method === "GET") {
        return { data: server.data, version: server.version };
      }
      server.puts += 1;
      if (server.racePut) {
        server.data = encodeBase64Url(new TextEncoder().encode(JSON.stringify(server.racePut)));
        server.version += 1;
        server.racePut = null;
      }
      const body = options!.body as { data: string; version: number };
      if (body.version !== server.version) {
        throw new ApiError(409, "VERSION_CONFLICT", "Another device saved the settings first.");
      }
      server.data = body.data;
      server.version += 1;
      return { data: server.data, version: server.version };
    },
  } as unknown as ApiClient;
  function values(): SettingsValues {
    return server.data === null ? {} : decodeSettings(decodeBase64Url(server.data));
  }
  return { server, api, values };
}

describe("settings store", () => {
  it("loads the server copy and saves a change with the read version", async () => {
    const { api, server, values } = fakeServer({ playRingSound: false }, 4);
    const store = createSettingsStore(api);
    await store.getState().load();
    expect(store.getState().loaded).toBe(true);
    expect(store.getState().version).toBe(4);
    expect(playRingSoundOf(store.getState().values)).toBe(false);

    await store.getState().update({ notificationLevels: { "10": "all" } });
    expect(server.version).toBe(5);
    expect(store.getState().version).toBe(5);
    expect(values()).toEqual({ playRingSound: false, notificationLevels: { "10": "all" } });
  });

  it("applies a change at once, before the save ends", () => {
    const { api } = fakeServer();
    const store = createSettingsStore(api);
    void store.getState().update({ playRingSound: false });
    expect(playRingSoundOf(store.getState().values)).toBe(false);
  });

  it("merges by key and tries once more after a version conflict", async () => {
    const { api, server, values } = fakeServer({ playRingSound: true }, 1);
    const store = createSettingsStore(api);
    await store.getState().load();
    // Another device saves a different key first.
    server.racePut = { playRingSound: true, hiddenDms: { "7": "70" } };
    await store.getState().update({ playRingSound: false });
    expect(server.puts).toBe(2);
    expect(values()).toEqual({ playRingSound: false, hiddenDms: { "7": "70" } });
    expect(store.getState().values).toEqual(values());
    expect(store.getState().version).toBe(server.version);
    expect(store.getState().error).toBeNull();
  });

  it("gives up after the second conflict and shows the server copy", async () => {
    const { api, server } = fakeServer({ playRingSound: true }, 1);
    const store = createSettingsStore(api);
    await store.getState().load();
    let conflicts = 0;
    const original = api.request.bind(api);
    (api as { request: ApiClient["request"] }).request = (async (method: string, path: string, options?: unknown) => {
      if (method === "PUT") {
        conflicts += 1;
        server.version += 1;
        throw new ApiError(409, "VERSION_CONFLICT", "Another device saved the settings first.");
      }
      return original(method, path, options as never);
    }) as ApiClient["request"];
    await store.getState().update({ playRingSound: false });
    expect(conflicts).toBe(2);
    expect(store.getState().error).not.toBeNull();
    expect(playRingSoundOf(store.getState().values)).toBe(true);
    expect(store.getState().version).toBe(server.version);
  });

  it("puts a second change into the next save while a save runs", async () => {
    const { api, values } = fakeServer();
    const store = createSettingsStore(api);
    const first = store.getState().update({ playRingSound: false });
    const second = store.getState().update({ notificationLevels: { "1": "none" } });
    await Promise.all([first, second]);
    expect(values()).toEqual({ playRingSound: false, notificationLevels: { "1": "none" } });
  });

  it("reads a newer version from another session and ignores an old one", async () => {
    const { api, server } = fakeServer({}, 2);
    const store = createSettingsStore(api);
    await store.getState().load();
    await store.getState().applyRemoteVersion(2);
    expect(store.getState().values).toEqual({});

    server.data = encodeBase64Url(new TextEncoder().encode(JSON.stringify({ playRingSound: false })));
    server.version = 3;
    await store.getState().applyRemoteVersion(3);
    expect(store.getState().version).toBe(3);
    expect(playRingSoundOf(store.getState().values)).toBe(false);
  });

  it("forgets everything on reset", async () => {
    const { api } = fakeServer({ playRingSound: false }, 2);
    const store = createSettingsStore(api);
    await store.getState().load();
    store.getState().reset();
    expect(store.getState()).toMatchObject({ loaded: false, version: 0, values: {}, error: null });
  });
});

describe("settings values", () => {
  it("uses safe defaults for missing or bad values", () => {
    expect(notificationLevelOf({}, "1")).toBe("mentions");
    expect(notificationLevelOf({ notificationLevels: { "1": "loud" } } as unknown as SettingsValues, "1")).toBe("mentions");
    expect(notificationLevelOf({ notificationLevels: { "1": "none" } }, "1")).toBe("none");
    expect(playRingSoundOf({})).toBe(true);
    expect(decodeSettings(new TextEncoder().encode("not json"))).toEqual({});
    expect(decodeSettings(new TextEncoder().encode("[1,2]"))).toEqual({});
    expect(decodeSettings(null)).toEqual({});
  });

  it("opens a closed DM again when a newer event arrives", () => {
    const values: SettingsValues = { hiddenDms: { "5": "100", "6": null } };
    expect(isDmHidden(values, "5", "100")).toBe(true);
    expect(isDmHidden(values, "5", "99")).toBe(true);
    expect(isDmHidden(values, "5", "101")).toBe(false);
    expect(isDmHidden(values, "6", null)).toBe(true);
    expect(isDmHidden(values, "6", "1")).toBe(false);
    expect(isDmHidden(values, "7", null)).toBe(false);
  });
});

describe("shouldNotify", () => {
  const base: NotificationInput = {
    isOwnMessage: false,
    isDm: false,
    level: "mentions",
    mentionsSelf: false,
    status: "online",
    windowFocused: false,
    channelOpen: false,
  };

  it("follows the guild level", () => {
    expect(shouldNotify({ ...base, level: "all" })).toBe(true);
    expect(shouldNotify({ ...base, level: "mentions" })).toBe(false);
    expect(shouldNotify({ ...base, level: "mentions", mentionsSelf: true })).toBe(true);
    expect(shouldNotify({ ...base, level: "none", mentionsSelf: true })).toBe(false);
  });

  it("always notifies for a DM, but not for own messages or in do not disturb", () => {
    expect(shouldNotify({ ...base, isDm: true, level: "none" })).toBe(true);
    expect(shouldNotify({ ...base, isDm: true, isOwnMessage: true })).toBe(false);
    expect(shouldNotify({ ...base, isDm: true, status: "dnd" })).toBe(false);
  });

  it("does not notify when the channel is open in a focused window", () => {
    expect(shouldNotify({ ...base, isDm: true, windowFocused: true, channelOpen: true })).toBe(false);
    expect(shouldNotify({ ...base, isDm: true, windowFocused: true, channelOpen: false })).toBe(true);
    expect(shouldNotify({ ...base, isDm: true, windowFocused: false, channelOpen: true })).toBe(true);
  });
});

function user(id: string): User {
  return { id, username: `user${id}`, displayName: `User ${id}`, avatarKey: null, statusText: null, createdAt: "" };
}

function dm(id: string, ids: string[], lastEventId: string | null, name: string | null = null): DmChannelJson {
  return {
    id,
    type: ids.length > 2 ? "group_dm" : "dm",
    name,
    ownerId: null,
    recipients: ids.map(user),
    lastEventId,
  };
}

describe("DM view helpers", () => {
  it("names a DM by the group name or by the other people", () => {
    expect(dmDisplayName(dm("1", ["1", "2"], null), "1")).toBe("User 2");
    expect(dmDisplayName(dm("1", ["1", "2", "3"], null), "1")).toBe("User 2, User 3");
    expect(dmDisplayName(dm("1", ["1", "2", "3"], null, "Crew"), "1")).toBe("Crew");
    expect(dmDisplayName(dm("1", ["1"], null), "1")).toBe("Empty group");
    expect(dmOtherRecipients(dm("1", ["1", "2"], null), "1").map((u) => u.id)).toEqual(["2"]);
  });

  it("sorts DMs by the newest event, with the channel id for an empty DM", () => {
    const sorted = sortDmChannels([dm("10", ["1", "2"], "50"), dm("20", ["1", "3"], null), dm("30", ["1", "4"], "9")]);
    expect(sorted.map((c) => c.id)).toEqual(["10", "20", "30"]);
  });

  it("moves a DM up when a new message arrives, but not for a reaction", () => {
    let state = createInitialRealtimeState();
    state = { ...state, privateChannels: { "10": dm("10", ["1", "2"], "50") } };
    const next = applyDispatch(state, { t: "EVENT_CREATE", d: { id: "60", channelId: "10", relType: null } });
    expect(next.privateChannels["10"]!.lastEventId).toBe("60");
    const reaction = applyDispatch(next, { t: "EVENT_CREATE", d: { id: "70", channelId: "10", relType: "reaction" } });
    expect(reaction).toBe(next);
    const older = applyDispatch(next, { t: "EVENT_CREATE", d: { id: "55", channelId: "10", relType: null } });
    expect(older).toBe(next);
    const guildEvent = applyDispatch(next, { t: "EVENT_CREATE", d: { id: "80", channelId: "99", relType: null } });
    expect(guildEvent).toBe(next);
  });
});

describe("encrypted settings", () => {
  it("encrypts the blob, and a second device with the key reads it", async () => {
    const { api, server } = fakeServer({ playRingSound: false }, 1);
    const first = memoryCipher();
    const store = createSettingsStore(api, first.cipher);
    await store.getState().load();
    await store.getState().update({ notificationLevels: { "10": "all" } });

    const blob = decodeBase64Url(server.data!);
    expect(settingsKeyIdOf(blob)).not.toBeNull();
    expect(new TextDecoder().decode(blob).includes("notificationLevels")).toBe(false);

    const second = memoryCipher();
    for (const [id, key] of first.keys) {
      second.keys.set(id, key);
    }
    const other = createSettingsStore(api, second.cipher);
    await other.getState().load();
    expect(other.getState().values).toEqual({ playRingSound: false, notificationLevels: { "10": "all" } });
  });

  it("without the key: shows the defaults, never overwrites the server blob, and saves after the key arrives", async () => {
    const { api, server } = fakeServer();
    const first = memoryCipher();
    const owner = createSettingsStore(api, first.cipher);
    await owner.getState().load();
    await owner.getState().update({ playRingSound: false, notificationLevels: { "10": "none" } });
    const saved = server.data;
    const puts = server.puts;

    const second = memoryCipher();
    const store = createSettingsStore(api, second.cipher);
    await store.getState().load();
    expect(store.getState().locked).toBe(true);
    expect(store.getState().loaded).toBe(true);
    expect(playRingSoundOf(store.getState().values)).toBe(true);

    await store.getState().update({ hiddenDms: { "5": null } });
    expect(server.puts).toBe(puts);
    expect(server.data).toBe(saved);
    expect(store.getState().values).toEqual({ hiddenDms: { "5": null } });

    // The key arrives. The store reads the server copy, puts the local change on top and saves.
    const [id, key] = [...first.keys][0]!;
    second.deliver(id, key);
    await expect.poll(() => server.puts).toBe(puts + 1);
    expect(store.getState().locked).toBe(false);
    await owner.getState().load();
    expect(owner.getState().values).toEqual({ playRingSound: false, notificationLevels: { "10": "none" }, hiddenDms: { "5": null } });
  });

  it("reads an old plaintext blob and encrypts it on the next save", async () => {
    const { api, server } = fakeServer({ playRingSound: false }, 2);
    const store = createSettingsStore(api, memoryCipher().cipher);
    await store.getState().load();
    expect(playRingSoundOf(store.getState().values)).toBe(false);
    await store.getState().update({ hiddenDms: {} });
    expect(settingsKeyIdOf(decodeBase64Url(server.data!))).not.toBeNull();
  });
});
