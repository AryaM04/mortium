import { describe, expect, it, vi } from "vitest";
import { encodeBase64Url, encodePlainPayload, type DecryptedPayload, type EventJson } from "@mortium/shared";
import type { ApiClient } from "./api.js";
import { createFakeCodec } from "./test/fake-codec.js";
import {
  addPending,
  advanceReadMarker,
  aggregateEvent,
  applyEventCreate,
  applyEventRedact,
  clearTypingForSender,
  compareIds,
  aggregateGuildUnread,
  countMentions,
  countUnreadMessages,
  createChannelMessagesState,
  expireTyping,
  formatBadgeCount,
  isChannelUnread,
  laterReadMarker,
  loadPage,
  markAllStale,
  markPendingFailed,
  markTypingSent,
  MAX_WINDOW_EVENTS,
  needsStaleRefetch,
  reconcilePosted,
  removePending,
  seedChannelBaseline,
  setPayload,
  setTypingStart,
  shouldSendTyping,
  touchChannel,
  trimWindow,
  createInitialMessagesState,
  createMessagesStore,
  WAITING_FOR_KEY_TEXT,
  type ChannelMessagesState,
  type MessagesState,
  type PendingMessage,
} from "./messages-store.js";

function event(overrides: Partial<EventJson> = {}): EventJson {
  return {
    id: "1",
    channelId: "10",
    senderId: "20",
    senderDeviceId: "device-1",
    relType: null,
    relatesToId: null,
    codec: "plain-v1",
    megolmSessionId: null,
    ciphertext: "cipher",
    nonce: "n1",
    createdAt: "2026-01-01T00:00:00.000Z",
    redactedAt: null,
    ...overrides,
  };
}

function withEvent(channel: ChannelMessagesState, e: EventJson): ChannelMessagesState {
  return { ...channel, eventIds: [...channel.eventIds, e.id], eventsById: { ...channel.eventsById, [e.id]: e } };
}

/** Type helper so payload literals in tests infer as `DecryptedPayload`, not widened strings. */
function payloadsOf(record: Record<string, DecryptedPayload>): Record<string, DecryptedPayload> {
  return record;
}

describe("compareIds", () => {
  it("compares snowflakes numerically, not as text", () => {
    expect(compareIds("9", "10")).toBeLessThan(0);
    expect(compareIds("10", "9")).toBeGreaterThan(0);
    expect(compareIds("10", "10")).toBe(0);
  });
});

describe("aggregateEvent", () => {
  it("uses the original payload when there is no edit", () => {
    const original = event({ id: "1" });
    const result = aggregateEvent(
      original,
      [],
      payloadsOf({ "1": { type: "message", body: "hi", mentions: [], attachments: [], embeds: [] } }),
    );
    expect(result.body).toBe("hi");
    expect(result.edited).toBe(false);
  });

  it("applies the latest edit from the original sender", () => {
    const original = event({ id: "1", senderId: "20" });
    const edit1 = event({ id: "2", senderId: "20", relType: "edit", relatesToId: "1" });
    const edit2 = event({ id: "3", senderId: "20", relType: "edit", relatesToId: "1" });
    const payloads = payloadsOf({
      "1": { type: "message", body: "original", mentions: [], attachments: [], embeds: [] },
      "2": { type: "edit", body: "first edit", mentions: [] },
      "3": { type: "edit", body: "second edit", mentions: [] },
    });
    const result = aggregateEvent(original, [edit1, edit2], payloads);
    expect(result.body).toBe("second edit");
    expect(result.edited).toBe(true);
  });

  it("ignores an edit from anyone but the original sender", () => {
    const original = event({ id: "1", senderId: "20" });
    const impostorEdit = event({ id: "2", senderId: "99", relType: "edit", relatesToId: "1" });
    const payloads = payloadsOf({
      "1": { type: "message", body: "original", mentions: [], attachments: [], embeds: [] },
      "2": { type: "edit", body: "hijacked", mentions: [] },
    });
    const result = aggregateEvent(original, [impostorEdit], payloads);
    expect(result.body).toBe("original");
    expect(result.edited).toBe(false);
  });

  it("aggregates reactions by key into a set of user ids", () => {
    const original = event({ id: "1" });
    const r1 = event({ id: "2", senderId: "a", relType: "reaction", relatesToId: "1" });
    const r2 = event({ id: "3", senderId: "b", relType: "reaction", relatesToId: "1" });
    const payloads = payloadsOf({
      "1": { type: "message", body: "hi", mentions: [], attachments: [], embeds: [] },
      "2": { type: "reaction", key: "👍" },
      "3": { type: "reaction", key: "👍" },
    });
    const result = aggregateEvent(original, [r1, r2], payloads);
    expect(result.reactions).toEqual([{ key: "👍", userIds: ["a", "b"], ownEventId: null }]);
  });

  it("marks the self user's own reaction event id, for removal", () => {
    const original = event({ id: "1" });
    const own = event({ id: "2", senderId: "self", relType: "reaction", relatesToId: "1" });
    const payloads = payloadsOf({
      "1": { type: "message", body: "hi", mentions: [], attachments: [], embeds: [] },
      "2": { type: "reaction", key: "👍" },
    });
    const result = aggregateEvent(original, [own], payloads, "self");
    expect(result.reactions[0]!.ownEventId).toBe("2");
  });

  it("drops a redacted reaction from the aggregate", () => {
    const original = event({ id: "1" });
    const removed = event({ id: "2", senderId: "a", relType: "reaction", relatesToId: "1", redactedAt: "2026-01-01T00:00:01.000Z" });
    const payloads = payloadsOf({ "1": { type: "message", body: "hi", mentions: [], attachments: [], embeds: [] } });
    const result = aggregateEvent(original, [removed], payloads);
    expect(result.reactions).toEqual([]);
  });

  it("shows a tombstone for a redacted event, without a body payload", () => {
    const redacted = event({ id: "1", redactedAt: "2026-01-01T00:00:01.000Z", ciphertext: "" });
    const result = aggregateEvent(redacted, [], {});
    expect(result.deleted).toBe(true);
    expect(result.body).toBe("This message was deleted.");
  });

  it("marks a message that failed to decode as cannotRead, with the fallback text", () => {
    const original = event({ id: "1" });
    const result = aggregateEvent(original, [], { "1": null });
    expect(result.cannotRead).toBe(true);
    expect(result.body).toBe("This message cannot be read.");
  });
});

describe("trimWindow", () => {
  it("does nothing under the cap", () => {
    const channel: ChannelMessagesState = { ...createChannelMessagesState(), eventIds: ["1", "2", "3"] };
    expect(trimWindow(channel, "after")).toBe(channel);
  });

  it("drops from the front and sets hasMoreBefore when the after side grew past the cap", () => {
    const ids = Array.from({ length: MAX_WINDOW_EVENTS + 5 }, (_, i) => String(i + 1));
    const eventsById: Record<string, EventJson> = {};
    for (const id of ids) eventsById[id] = event({ id });
    const channel: ChannelMessagesState = { ...createChannelMessagesState(), eventIds: ids, eventsById };
    const trimmed = trimWindow(channel, "after");
    expect(trimmed.eventIds.length).toBe(MAX_WINDOW_EVENTS);
    expect(trimmed.eventIds[0]).toBe("6");
    expect(trimmed.hasMoreBefore).toBe(true);
  });

  it("drops from the back and sets hasMoreAfter when the before side grew past the cap", () => {
    const ids = Array.from({ length: MAX_WINDOW_EVENTS + 5 }, (_, i) => String(i + 1));
    const eventsById: Record<string, EventJson> = {};
    for (const id of ids) eventsById[id] = event({ id });
    const channel: ChannelMessagesState = { ...createChannelMessagesState(), eventIds: ids, eventsById };
    const trimmed = trimWindow(channel, "before");
    expect(trimmed.eventIds.length).toBe(MAX_WINDOW_EVENTS);
    expect(trimmed.eventIds[trimmed.eventIds.length - 1]).toBe(String(MAX_WINDOW_EVENTS));
    expect(trimmed.hasMoreAfter).toBe(true);
  });

  it("sets atLatest to false when an older page drops the newest events", () => {
    const ids = Array.from({ length: MAX_WINDOW_EVENTS }, (_, i) => String(i + 100));
    const eventsById: Record<string, EventJson> = {};
    for (const id of ids) eventsById[id] = event({ id });
    const channel: ChannelMessagesState = { ...createChannelMessagesState(), eventIds: ids, eventsById };
    const older = { events: [event({ id: "50" }), event({ id: "51" })], relations: [], hasMoreBefore: true, hasMoreAfter: false };
    const next = loadPage(channel, older, "before");
    expect(next.hasMoreAfter).toBe(true);
    expect(next.atLatest).toBe(false);
  });
});

describe("loadPage", () => {
  it("sets up the initial page with the server's hasMore flags", () => {
    const channel = createChannelMessagesState();
    const page = { events: [event({ id: "1" }), event({ id: "2" })], relations: [], hasMoreBefore: true, hasMoreAfter: false };
    const next = loadPage(channel, page, "initial");
    expect(next.eventIds).toEqual(["1", "2"]);
    expect(next.hasMoreBefore).toBe(true);
    expect(next.hasMoreAfter).toBe(false);
  });

  it("prepends an older page and keeps newer events", () => {
    let channel = createChannelMessagesState();
    channel = loadPage(channel, { events: [event({ id: "5" })], relations: [], hasMoreBefore: true, hasMoreAfter: false }, "initial");
    channel = loadPage(channel, { events: [event({ id: "3" }), event({ id: "4" })], relations: [], hasMoreBefore: false, hasMoreAfter: false }, "before");
    expect(channel.eventIds).toEqual(["3", "4", "5"]);
    expect(channel.hasMoreBefore).toBe(false);
  });

  it("appends a newer page and keeps older events", () => {
    let channel = createChannelMessagesState();
    channel = loadPage(channel, { events: [event({ id: "1" })], relations: [], hasMoreBefore: false, hasMoreAfter: true }, "initial");
    channel = loadPage(channel, { events: [event({ id: "2" }), event({ id: "3" })], relations: [], hasMoreBefore: false, hasMoreAfter: false }, "after");
    expect(channel.eventIds).toEqual(["1", "2", "3"]);
    expect(channel.hasMoreAfter).toBe(false);
  });
});

describe("applyEventCreate and pending reconciliation", () => {
  const pending: PendingMessage = {
    nonce: "abc",
    channelId: "10",
    body: "hello",
    mentions: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    state: "sending",
  };

  it("appends a live event when the window is at the latest page", () => {
    const channel = createChannelMessagesState();
    const next = applyEventCreate(channel, event({ id: "1" }));
    expect(next.eventIds).toEqual(["1"]);
  });

  it("does not append when the window is not at the latest page, but tracks lastEventId", () => {
    const channel: ChannelMessagesState = { ...createChannelMessagesState(), atLatest: false };
    const next = applyEventCreate(channel, event({ id: "1" }));
    expect(next.eventIds).toEqual([]);
    expect(next.lastEventId).toBe("1");
  });

  it("reconciles pending-then-EVENT_CREATE: the create removes the pending entry and is added", () => {
    let channel = addPending(createChannelMessagesState(), pending);
    channel = applyEventCreate(channel, event({ id: "1", nonce: "abc" }));
    expect(channel.pending).toEqual([]);
    expect(channel.eventIds).toEqual(["1"]);
  });

  it("reconciles EVENT_CREATE-then-POST-response: the POST response is a no-op beyond dropping pending", () => {
    let channel = addPending(createChannelMessagesState(), pending);
    channel = applyEventCreate(channel, event({ id: "1", nonce: "abc" }));
    // The POST response arrives after the dispatch already added the event.
    const posted = event({ id: "1", nonce: "abc" });
    channel = reconcilePosted(channel, posted);
    expect(channel.eventIds).toEqual(["1"]);
    expect(channel.pending).toEqual([]);
  });

  it("reconciles POST-response-before-EVENT_CREATE: the POST response adds the event, and the later dispatch is ignored", () => {
    let channel = addPending(createChannelMessagesState(), pending);
    const posted = event({ id: "1", nonce: "abc" });
    channel = reconcilePosted(channel, posted);
    expect(channel.eventIds).toEqual(["1"]);
    expect(channel.pending).toEqual([]);
    // The EVENT_CREATE dispatch for the same id now arrives; it must not duplicate.
    channel = applyEventCreate(channel, posted);
    expect(channel.eventIds).toEqual(["1"]);
  });

  it("routes an edit/reaction relation to its target instead of the timeline", () => {
    const channel = createChannelMessagesState();
    const reaction = event({ id: "2", relType: "reaction", relatesToId: "1" });
    const next = applyEventCreate(channel, reaction);
    expect(next.eventIds).toEqual([]);
    expect(next.relationsByTarget["1"]).toEqual([reaction]);
  });

  it("marks a pending send as failed", () => {
    let channel = addPending(createChannelMessagesState(), pending);
    channel = markPendingFailed(channel, "abc");
    expect(channel.pending[0]!.state).toBe("failed");
  });

  it("discards a pending send", () => {
    let channel = addPending(createChannelMessagesState(), pending);
    channel = removePending(channel, "abc");
    expect(channel.pending).toEqual([]);
  });
});

describe("applyEventRedact", () => {
  it("removes a timeline event with no reply pointing at it", () => {
    let channel = createChannelMessagesState();
    channel = withEvent(channel, event({ id: "1" }));
    channel = applyEventRedact(channel, ["1"]);
    expect(channel.eventIds).toEqual([]);
  });

  it("tombstones a timeline event that a loaded reply targets", () => {
    let channel = createChannelMessagesState();
    channel = withEvent(channel, event({ id: "1" }));
    channel = withEvent(channel, event({ id: "2", relType: "reply", relatesToId: "1" }));
    channel = applyEventRedact(channel, ["1"]);
    expect(channel.eventIds).toContain("1");
    expect(channel.eventsById["1"]!.redactedAt).not.toBeNull();
  });

  it("removes a redacted relation from its target's aggregate", () => {
    let channel = createChannelMessagesState();
    const reaction = event({ id: "2", relType: "reaction", relatesToId: "1" });
    channel = { ...channel, relationsByTarget: { "1": [reaction] } };
    channel = applyEventRedact(channel, ["2"]);
    expect(channel.relationsByTarget["1"]).toBeUndefined();
  });
});

describe("stale refetch", () => {
  it("marks every open window stale after a fresh READY", () => {
    const channels = { "1": createChannelMessagesState(), "2": createChannelMessagesState() };
    const next = markAllStale(channels);
    expect(next["1"]!.stale).toBe(true);
    expect(next["2"]!.stale).toBe(true);
  });

  it("needsStaleRefetch is true only for a stale channel", () => {
    expect(needsStaleRefetch({ ...createChannelMessagesState(), stale: true })).toBe(true);
    expect(needsStaleRefetch(createChannelMessagesState())).toBe(false);
    expect(needsStaleRefetch(undefined)).toBe(false);
  });
});

describe("seedChannelBaseline", () => {
  it("creates a channel entry for a channel with no window, from READY data", () => {
    const channels = seedChannelBaseline({}, "10", "5", "3");
    expect(channels["10"]!.lastEventId).toBe("5");
    expect(channels["10"]!.lastReadEventId).toBe("3");
  });

  it("never moves an already-tracked lastEventId or read marker backward", () => {
    let channels = seedChannelBaseline({}, "10", "5", "3");
    channels = seedChannelBaseline(channels, "10", "2", "1");
    expect(channels["10"]!.lastEventId).toBe("5");
    expect(channels["10"]!.lastReadEventId).toBe("3");
  });

  it("does not disturb an already-loaded window's events", () => {
    let channel = createChannelMessagesState();
    channel = withEvent(channel, event({ id: "1" }));
    const channels = seedChannelBaseline({ "10": channel }, "10", "1", null);
    expect(channels["10"]!.eventIds).toEqual(["1"]);
  });
});

describe("unread and mentions", () => {
  it("a channel is unread when lastEventId is newer than the read marker", () => {
    expect(isChannelUnread("5", "3")).toBe(true);
    expect(isChannelUnread("3", "5")).toBe(false);
    expect(isChannelUnread("5", null)).toBe(true);
    expect(isChannelUnread(null, null)).toBe(false);
  });

  it("counts decoded messages after the read marker that mention self", () => {
    let channel = createChannelMessagesState();
    channel = { ...channel, lastReadEventId: "1" };
    channel = withEvent(channel, event({ id: "2" }));
    channel = withEvent(channel, event({ id: "3" }));
    channel = setPayload(channel, "2", { type: "message", body: "hey @self", mentions: ["self"], attachments: [], embeds: [] });
    channel = setPayload(channel, "3", { type: "message", body: "no mention", mentions: [], attachments: [], embeds: [] });
    expect(countMentions(channel, "self")).toBe(1);
  });

  it("does not count a message at or before the read marker", () => {
    let channel = createChannelMessagesState();
    channel = { ...channel, lastReadEventId: "2" };
    channel = withEvent(channel, event({ id: "2" }));
    channel = setPayload(channel, "2", { type: "message", body: "hey @self", mentions: ["self"], attachments: [], embeds: [] });
    expect(countMentions(channel, "self")).toBe(0);
  });
});

describe("countUnreadMessages", () => {
  it("counts loaded messages from other people after the read marker", () => {
    let channel = createChannelMessagesState();
    channel = { ...channel, lastReadEventId: "1" };
    channel = applyEventCreate(channel, event({ id: "1" }));
    channel = applyEventCreate(channel, event({ id: "2" }));
    channel = applyEventCreate(channel, event({ id: "3", senderId: "self" }));
    channel = applyEventCreate(channel, event({ id: "4" }));
    expect(countUnreadMessages(channel, "self")).toBe(2);
  });

  it("counts 1 for an unread baseline with no loaded message", () => {
    const channel = { ...createChannelMessagesState(), lastEventId: "9", lastReadEventId: "5" };
    expect(countUnreadMessages(channel, "self")).toBe(1);
    expect(countUnreadMessages({ ...channel, lastReadEventId: "9" }, "self")).toBe(0);
  });

  it("does not count a channel whose newest message is from the user", () => {
    let channel: ChannelMessagesState = { ...createChannelMessagesState(), lastReadEventId: "5" };
    channel = applyEventCreate(channel, event({ id: "6", senderId: "self" }));
    expect(countUnreadMessages(channel, "self")).toBe(0);
  });
});

describe("aggregateGuildUnread", () => {
  it("is unread when any given channel is unread, and sums mentions across them", () => {
    let read = createChannelMessagesState();
    read = { ...read, lastEventId: "1", lastReadEventId: "1" };

    let unread = createChannelMessagesState();
    unread = { ...unread, lastEventId: "2", lastReadEventId: "1" };
    unread = withEvent(unread, event({ id: "2" }));
    unread = setPayload(unread, "2", { type: "message", body: "hey @self", mentions: ["self"], attachments: [], embeds: [] });

    const channels = { "10": read, "11": unread };
    const summary = aggregateGuildUnread(channels, ["10", "11"], "self");
    expect(summary.hasUnread).toBe(true);
    expect(summary.mentionCount).toBe(1);
  });

  it("is not unread and has no mentions when every given channel is caught up", () => {
    let read = createChannelMessagesState();
    read = { ...read, lastEventId: "1", lastReadEventId: "1" };
    const summary = aggregateGuildUnread({ "10": read }, ["10"], "self");
    expect(summary.hasUnread).toBe(false);
    expect(summary.mentionCount).toBe(0);
  });

  it("ignores a channel id that has no loaded state", () => {
    const summary = aggregateGuildUnread({}, ["never-opened"], "self");
    expect(summary.hasUnread).toBe(false);
    expect(summary.mentionCount).toBe(0);
  });
});

describe("formatBadgeCount", () => {
  it("shows the exact count up to 99", () => {
    expect(formatBadgeCount(0)).toBe("0");
    expect(formatBadgeCount(3)).toBe("3");
    expect(formatBadgeCount(99)).toBe("99");
  });

  it("caps display at 99+", () => {
    expect(formatBadgeCount(100)).toBe("99+");
    expect(formatBadgeCount(1000)).toBe("99+");
  });
});

describe("read marker", () => {
  it("advances forward", () => {
    const channel = advanceReadMarker(createChannelMessagesState(), "5");
    expect(channel.lastReadEventId).toBe("5");
  });

  it("never moves backward", () => {
    let channel = advanceReadMarker(createChannelMessagesState(), "5");
    channel = advanceReadMarker(channel, "3");
    expect(channel.lastReadEventId).toBe("5");
  });
});

describe("laterReadMarker", () => {
  it("picks the greater of two ids", () => {
    expect(laterReadMarker("3", "5")).toBe("5");
    expect(laterReadMarker("5", "3")).toBe("5");
  });

  it("treats null as earliest", () => {
    expect(laterReadMarker(null, "5")).toBe("5");
    expect(laterReadMarker("5", null)).toBe("5");
    expect(laterReadMarker(null, null)).toBeNull();
  });

  it("protects a fresh markRead from a stale openChannel argument", () => {
    // This is the exact race `openChannel` guards against: it captures
    // `lastReadEventId` before its fetch starts, so a `markRead` for the
    // same channel that lands while the fetch is in flight must not be
    // undone once the stale value is applied.
    let channel = advanceReadMarker(createChannelMessagesState(), "5"); // markRead lands first
    const staleCapturedValue = "1"; // read before the fetch started
    const next = laterReadMarker(channel.lastReadEventId, staleCapturedValue);
    channel = { ...channel, lastReadEventId: next };
    expect(channel.lastReadEventId).toBe("5");
  });
});

describe("typing", () => {
  it("shows a user for the timeout window and expires them after it passes", () => {
    let channel = setTypingStart(createChannelMessagesState(), "u1", 1_000);
    expect(channel.typing["u1"]).toBe(1_000 + 8_000);
    channel = expireTyping(channel, 1_000 + 8_000 - 1);
    expect(channel.typing["u1"]).toBeDefined();
    channel = expireTyping(channel, 1_000 + 8_000 + 1);
    expect(channel.typing["u1"]).toBeUndefined();
  });

  it("clears a typing user once a message from them arrives", () => {
    let channel = setTypingStart(createChannelMessagesState(), "u1", 1_000);
    channel = clearTypingForSender(channel, "u1");
    expect(channel.typing["u1"]).toBeUndefined();
  });

  it("throttles notifyTyping sends to once per interval", () => {
    let channel = createChannelMessagesState();
    expect(shouldSendTyping(channel, 0)).toBe(true);
    channel = markTypingSent(channel, 0);
    expect(shouldSendTyping(channel, 2_999)).toBe(false);
    expect(shouldSendTyping(channel, 3_000)).toBe(true);
  });
});

describe("channel LRU cache", () => {
  it("evicts the least recently used channel past the cap", () => {
    let state = createInitialMessagesState();
    for (let i = 1; i <= 21; i++) {
      state = touchChannel(state, String(i));
      state = { ...state, channels: { ...state.channels, [String(i)]: createChannelMessagesState() } };
    }
    expect(state.channelOrder.length).toBe(20);
    expect(state.channels["1"]?.eventIds).toEqual([]);
    expect(state.channels["21"]).toBeDefined();
  });

  it("keeps the read baseline of an evicted channel", () => {
    const first: ChannelMessagesState = {
      ...withEvent(createChannelMessagesState(), event({ id: "7" })),
      lastEventId: "7",
      lastReadEventId: "5",
    };
    let state: MessagesState = { ...createInitialMessagesState(), channels: { "1": first } };
    for (let i = 1; i <= 21; i++) {
      state = touchChannel(state, String(i));
    }
    expect(state.channels["1"]).toMatchObject({ eventIds: [], lastEventId: "7", lastReadEventId: "5" });
  });

  it("re-touching a cached channel moves it to the end without evicting it", () => {
    let state = createInitialMessagesState();
    state = touchChannel(state, "a");
    state = touchChannel(state, "b");
    state = touchChannel(state, "a");
    expect(state.channelOrder).toEqual(["b", "a"]);
  });
});

describe("events that wait for a key", () => {
  it("shows the waiting text, and decodes again when the key arrives, with no reload", async () => {
    const codec = createFakeCodec();
    codec.missing.add("s1");
    const store = createMessagesStore({ api: { request: vi.fn() } as unknown as ApiClient, codec, send: vi.fn() });
    const payload = { type: "message" as const, body: "secret", mentions: [], attachments: [], embeds: [] };
    const waitingEvent = event({
      id: "5",
      codec: "megolm-v1",
      megolmSessionId: "s1",
      ciphertext: encodeBase64Url(encodePlainPayload(payload)),
    });
    store.getState().applyDispatch("EVENT_CREATE", waitingEvent);
    await vi.waitFor(() => expect(store.getState().channels["10"]!.waiting["5"]).toBe(true));
    let channel = store.getState().channels["10"]!;
    const shown = aggregateEvent(waitingEvent, [], channel.payloads, null, channel.waiting);
    expect(shown.cannotRead).toBe(true);
    expect(shown.body).toBe(WAITING_FOR_KEY_TEXT);

    // A key for a different session changes nothing. The right key decodes the event.
    codec.deliverKey("10", "other");
    codec.deliverKey("10", "s1");
    await vi.waitFor(() => expect(store.getState().channels["10"]!.payloads["5"]).toEqual(payload));
    channel = store.getState().channels["10"]!;
    expect(channel.waiting["5"]).toBeUndefined();
    expect(aggregateEvent(waitingEvent, [], channel.payloads, null, channel.waiting).body).toBe("secret");
  });
});
describe("page loads", () => {
  it("keeps a live event that arrives while the latest page decodes", async () => {
    const base = createFakeCodec();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const codec = { ...base, decode: async (e: EventJson) => (await gate, base.decode(e)) };
    const cipher = (body: string) =>
      encodeBase64Url(encodePlainPayload({ type: "message", body, mentions: [], attachments: [], embeds: [] }));
    const pageEvent = event({ id: "5", codec: "megolm-v1", megolmSessionId: "s", ciphertext: cipher("page") });
    const request = vi.fn().mockResolvedValue({ events: [pageEvent], relations: [], hasMoreBefore: false, hasMoreAfter: false });
    const store = createMessagesStore({ api: { request } as unknown as ApiClient, codec, send: vi.fn() });

    const opening = store.getState().openChannel("10", "5", null);
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    store
      .getState()
      .applyDispatch("EVENT_CREATE", event({ id: "6", codec: "megolm-v1", megolmSessionId: "s", ciphertext: cipher("live") }));
    release();
    await opening;
    await vi.waitFor(() => expect(store.getState().channels["10"]!.payloads["6"]).toBeDefined());
    const channel = store.getState().channels["10"]!;
    expect(channel.eventIds).toEqual(["5", "6"]);
    expect(channel.payloads["5"]).toMatchObject({ body: "page" });
  });
});
describe("attachments", () => {
  it("puts the files in the encrypted payload, claims each file and thumbnail after the send, and shows them", async () => {
    const codec = createFakeCodec();
    const secrets = { key: encodeBase64Url(new Uint8Array(32)), iv: encodeBase64Url(new Uint8Array(12)), sha256: encodeBase64Url(new Uint8Array(32)) };
    const attachment = {
      id: "70",
      name: "a.png",
      mime: "image/png",
      size: 5,
      ...secrets,
      width: 10,
      height: 10,
      thumbnail: { id: "71", ...secrets, width: 10, height: 10 },
    };
    let posted: EventJson | null = null;
    const request = vi.fn(async (method: string, path: string, options?: { body?: { ciphertext: string; nonce: string } }) => {
      if (path === "/channels/10/events") {
        posted = event({ id: "9", codec: "megolm-v1", ciphertext: options!.body!.ciphertext, nonce: options!.body!.nonce });
        return posted;
      }
      return undefined;
    });
    const store = createMessagesStore({ api: { request } as unknown as ApiClient, codec, send: vi.fn() });
    await store.getState().sendMessage("10", "", [], undefined, [attachment]);

    const claims = request.mock.calls.filter(([, path]) => path.endsWith("/claim")).map(([method, path]) => `${method} ${path}`);
    expect(claims).toEqual(["POST /attachments/70/claim", "POST /attachments/71/claim"]);
    const channel = store.getState().channels["10"]!;
    expect(aggregateEvent(posted!, [], channel.payloads).attachments).toEqual([attachment]);
  });
});
describe("link embeds", () => {
  it("puts the link preview in the encrypted payload, claims its image, and shows it", async () => {
    const codec = createFakeCodec();
    const secrets = { key: encodeBase64Url(new Uint8Array(32)), iv: encodeBase64Url(new Uint8Array(12)), sha256: encodeBase64Url(new Uint8Array(32)) };
    const embed = {
      type: "link" as const,
      url: "https://example.com/",
      title: "Example",
      image: { id: "80", name: "preview.png", mime: "image/png", size: 5, ...secrets },
    };
    let posted: EventJson | null = null;
    const request = vi.fn(async (_method: string, path: string, options?: { body?: { ciphertext: string; nonce: string } }) => {
      if (path === "/channels/10/events") {
        posted = event({ id: "9", codec: "megolm-v1", ciphertext: options!.body!.ciphertext, nonce: options!.body!.nonce });
        return posted;
      }
      return undefined;
    });
    const decoded: string[] = [];
    const store = createMessagesStore({
      api: { request } as unknown as ApiClient,
      codec,
      send: vi.fn(),
      onDecoded: (items) => decoded.push(...items.map((item) => item.event.id)),
    });
    await store.getState().sendMessage("10", "see https://example.com/", [], undefined, [], [embed]);

    const claims = request.mock.calls.filter(([, path]) => path.endsWith("/claim")).map(([, path]) => path);
    expect(claims).toEqual(["/attachments/80/claim"]);
    const channel = store.getState().channels["10"]!;
    expect(aggregateEvent(posted!, [], channel.payloads).embeds).toEqual([embed]);
    expect(decoded).toEqual(["9"]);
  });
});
