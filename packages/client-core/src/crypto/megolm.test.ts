// Tests of Megolm channel encryption with the real vodozemac WASM and a
// fake server: three users with two devices each, key shares, rotation,
// history for new members, key requests, spoofed sessions and replays.
import { beforeAll, describe, expect, it } from "vitest";
import {
  decodeBase64Url,
  encodeBase64Url,
  megolmSessionSignedText,
  Permission,
  type ChannelMembersResponse,
  type EventJson,
} from "@mortium/shared";
import { Account, GroupSession, InboundGroupSession } from "@mortium/crypto-wasm";
import { cryptoStoreName, openCryptoStore } from "./store.js";
import { FakeServer, initWasmForTests, newClient, verifyWithSas, type TestClient } from "./test/fake-server.js";

beforeAll(() => {
  initWasmForTests();
});

const GUILD = "100";
const CHANNEL = "200";
const EVERYONE = (Permission.VIEW_CHANNEL | Permission.READ_MESSAGE_HISTORY | Permission.SEND_MESSAGES).toString();

function guildChannel(userIds: string[], overwrites: ChannelMembersResponse["overwrites"] = []): ChannelMembersResponse {
  return {
    guildId: GUILD,
    ownerId: "1",
    roles: [{ id: GUILD, permissions: EVERYONE }],
    overwrites,
    members: userIds.map((userId) => ({ userId, roles: [] })),
  };
}

let eventCounter = 1000;

async function send(client: TestClient, body: string, channelId = CHANNEL): Promise<EventJson> {
  const encoded = await client.handle!.codec.encode(channelId, {
    type: "message",
    body,
    mentions: [],
    attachments: [],
    embeds: [],
  });
  eventCounter += 1;
  return {
    id: String(eventCounter),
    channelId,
    senderId: client.userId,
    senderDeviceId: client.deviceId,
    relType: null,
    relatesToId: null,
    codec: encoded.codec,
    megolmSessionId: encoded.megolmSessionId,
    ciphertext: encodeBase64Url(encoded.ciphertext),
    nonce: `n${eventCounter}`,
    createdAt: new Date().toISOString(),
    redactedAt: null,
  };
}

/** The body, or "waiting" when the key is not here, or "unreadable". */
async function read(client: TestClient, event: EventJson): Promise<string> {
  const result = await client.handle!.codec.decode(event);
  if (result.ok) {
    return result.payload.type === "message" ? result.payload.body : result.payload.type;
  }
  return result.waiting ? "waiting" : "unreadable";
}

async function settle(clients: TestClient[]): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    for (const client of clients) {
      await client.handle?.whenIdle();
    }
  }
}

async function setup(eligible = ["1", "2", "3"], startUsers = ["1", "2", "3"]) {
  const server = new FakeServer();
  server.channels.set(CHANNEL, guildChannel(eligible));
  const clients = {
    a1: newClient("1", "A1"),
    a2: newClient("1", "A2"),
    b1: newClient("2", "B1"),
    b2: newClient("2", "B2"),
    c1: newClient("3", "C1"),
    c2: newClient("3", "C2"),
  };
  const all = Object.values(clients);
  for (const client of all.filter((entry) => startUsers.includes(entry.userId))) {
    await server.start(client);
  }
  // The first device of each user made the master key. It verifies the second device, so that one gets keys too.
  for (const [first, second] of [
    [clients.a1, clients.a2],
    [clients.b1, clients.b2],
    [clients.c1, clients.c2],
  ] as const) {
    if (startUsers.includes(first.userId)) {
      await verifyWithSas(first, second);
    }
  }
  return { server, ...clients, all };
}

function received(client: TestClient, type: string): number {
  return client.received.filter((event) => event.type === type).length;
}

describe("Megolm channel encryption", () => {
  it("shares the key with every eligible device, and each one decrypts", async () => {
    const { a1, all } = await setup();
    const event = await send(a1, "hello everyone");
    expect(event.codec).toBe("megolm-v1");
    expect(event.ciphertext).not.toContain(encodeBase64Url(new TextEncoder().encode("hello everyone")));
    await settle(all);
    for (const client of all) {
      expect(await read(client, event)).toBe("hello everyone");
    }
    // One key share for each other device, including the other device of the sender.
    expect(all.filter((client) => client !== a1).every((client) => received(client, "megolm.session") === 1)).toBe(true);

    // The next message uses the same session and needs no new share.
    const second = await send(a1, "again");
    await settle(all);
    expect(second.megolmSessionId).toBe(event.megolmSessionId);
    expect(received(all[5]!, "megolm.session")).toBe(1);
    expect(await read(all[5]!, second)).toBe("again");
  });

  it("gives no key to a user without READ_MESSAGE_HISTORY, by the client's own permission check", async () => {
    const { server, a1, c1, c2, all } = await setup();
    // The server lists user 3 (it can view the channel), but an overwrite takes history away.
    server.channels.set(
      CHANNEL,
      guildChannel(["1", "2", "3"], [
        { targetId: "3", targetType: "member", allow: "0", deny: Permission.READ_MESSAGE_HISTORY.toString() },
      ]),
    );
    const event = await send(a1, "not for user 3");
    await settle(all);
    expect(received(c1, "megolm.session") + received(c2, "megolm.session")).toBe(0);
    // A key request from user 3 gets no answer either.
    expect(await read(c1, event)).toBe("waiting");
    await new Promise((resolve) => setTimeout(resolve, 150));
    await settle(all);
    expect(received(c1, "megolm.forward")).toBe(0);
    expect(await read(c1, event)).toBe("waiting");
    expect(await c1.handle!.hasMegolmSession(event.megolmSessionId!)).toBe(false);
  });

  it("starts a new session after 100 messages", async () => {
    const { a1, b1, all } = await setup(["1", "2"], ["1", "2"]);
    const first = await send(a1, "message 0");
    let last = first;
    for (let i = 1; i < 100; i += 1) {
      last = await send(a1, `message ${i}`);
    }
    expect(last.megolmSessionId).toBe(first.megolmSessionId);
    const rotated = await send(a1, "message 100");
    expect(rotated.megolmSessionId).not.toBe(first.megolmSessionId);
    await settle(all);
    expect(await read(b1, last)).toBe("message 99");
    expect(await read(b1, rotated)).toBe("message 100");
  });

  it("rotates when a user loses VIEW_CHANNEL: the user reads old messages, not new ones", async () => {
    const { server, a1, b1, c1, all } = await setup();
    const before = await send(a1, "before the change");
    await settle(all);
    expect(await read(c1, before)).toBe("before the change");

    server.channels.set(
      CHANNEL,
      guildChannel(["1", "2"], [{ targetId: "3", targetType: "member", allow: "0", deny: Permission.VIEW_CHANNEL.toString() }]),
    );
    server.broadcast("CHANNEL_UPDATE", { id: CHANNEL, guildId: GUILD });
    const after = await send(a1, "after the change");
    expect(after.megolmSessionId).not.toBe(before.megolmSessionId);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await settle(all);

    expect(await read(b1, after)).toBe("after the change");
    expect(await read(c1, after)).toBe("waiting");
    expect(await c1.handle!.hasMegolmSession(after.megolmSessionId!)).toBe(false);
    expect(await read(c1, before)).toBe("before the change");
  });

  it("rotates when a device of a member is removed", async () => {
    const { server, a1, b1, all } = await setup(["1", "2"], ["1", "2"]);
    const before = await send(a1, "one");
    await settle(all);
    server.stop(b1);
    server.removeDevice("2", "B1");
    const after = await send(a1, "two");
    expect(after.megolmSessionId).not.toBe(before.megolmSessionId);
  });

  it("sends the history to a new member, from few devices only", async () => {
    const { server, a1, b1, c1, c2, all } = await setup(["1", "2"]);
    const old1 = await send(a1, "old one");
    const old2 = await send(b1, "old two");
    await settle(all);
    expect(await c1.handle!.hasMegolmSession(old1.megolmSessionId!)).toBe(false);

    server.channels.set(CHANNEL, guildChannel(["1", "2", "3"]));
    server.broadcast("GUILD_MEMBER_ADD", { guildId: GUILD, userId: "3" });
    await expect
      .poll(async () => {
        await settle(all);
        return (await c1.handle!.hasMegolmSession(old1.megolmSessionId!)) && (await c2.handle!.hasMegolmSession(old2.megolmSessionId!));
      })
      .toBe(true);

    // Wait for the backup senders. At most three of the four old devices send each of the two sessions.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await settle(all);
    const forwards = received(c1, "megolm.forward");
    expect(forwards).toBeGreaterThanOrEqual(2);
    expect(forwards).toBeLessThanOrEqual(2 * 3);
    expect([await read(c1, old1), await read(c2, old2)]).toEqual(["old one", "old two"]);

    // User 3 has the forwarded key of the session of A1, which A1 never shared with it.
    // When user 3 leaves, the next message of A1 must use a new session.
    server.channels.set(CHANNEL, guildChannel(["1", "2"]));
    server.broadcast("GUILD_MEMBER_REMOVE", { guildId: GUILD, userId: "3" });
    await settle(all);
    const after = await send(a1, "after the leave");
    expect(after.megolmSessionId).not.toBe(old1.megolmSessionId);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await settle(all);
    expect(await read(c1, after)).toBe("waiting");
    expect(await read(b1, after)).toBe("after the leave");
  });

  it("rotates after a role change takes a reader away, even when the reader got the key by a forward", async () => {
    const { server, a1, c1, all } = await setup(["1", "2"]);
    const old = await send(a1, "old");
    await settle(all);
    server.channels.set(CHANNEL, guildChannel(["1", "2", "3"]));
    server.broadcast("GUILD_MEMBER_UPDATE", { guildId: GUILD, userId: "3", roles: [] });
    await expect
      .poll(async () => {
        await settle(all);
        return c1.handle!.hasMegolmSession(old.megolmSessionId!);
      })
      .toBe(true);

    server.channels.set(
      CHANNEL,
      guildChannel(["1", "2", "3"], [{ targetId: "3", targetType: "member", allow: "0", deny: Permission.VIEW_CHANNEL.toString() }]),
    );
    server.broadcast("CHANNEL_UPDATE", { id: CHANNEL, guildId: GUILD });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await settle(all);
    const after = await send(a1, "new");
    expect(after.megolmSessionId).not.toBe(old.megolmSessionId);
  });

  it("asks for a missing key, and decodes again when the key arrives", async () => {
    const { server, a1, all, c1 } = await setup(["1", "2"], ["1", "2"]);
    const old = await send(a1, "history");
    await settle(all);

    // User 3 joins before its devices have keys, so the history share finds no device.
    server.channels.set(CHANNEL, guildChannel(["1", "2", "3"]));
    server.broadcast("GUILD_MEMBER_ADD", { guildId: GUILD, userId: "3" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await settle(all);
    await server.start(c1);

    const arrived: string[] = [];
    c1.handle!.codec.onKeys!((_channelId, sessionId) => arrived.push(sessionId));
    expect(await read(c1, old)).toBe("waiting");
    await expect
      .poll(async () => {
        await settle(all);
        return arrived.includes(old.megolmSessionId!);
      })
      .toBe(true);
    expect(await read(c1, old)).toBe("history");
    expect(received(c1, "megolm.forward")).toBeGreaterThanOrEqual(1);
  });

  it("rejects an event whose session does not belong to its sender, and a copied or forged session", async () => {
    const { server, a1, b1, c1, all } = await setup();
    const event = await send(a1, "from A1");
    await settle(all);

    // The server says that A2 (or user 2) sent the event of A1.
    expect(await read(c1, { ...event, senderDeviceId: "A2" })).toBe("unreadable");
    expect(await read(c1, { ...event, senderId: "2", senderDeviceId: "B1" })).toBe("unreadable");

    // An attacker device with real keys takes the key of A1 from the store of B1 (a member has it).
    const evil = newClient("4", "E1");
    await server.start(evil);
    const store = await openCryptoStore(cryptoStoreName("2", "B1"), b1.indexedDb);
    const record = (await store.getInbound(event.megolmSessionId!))!;
    store.close();
    const pickleKey = decodeBase64Url((await b1.secureStore.get("crypto-pickle-key:2:B1"))!);
    const copy = InboundGroupSession.from_pickle(record.pickle, pickleKey);
    const exported = copy.export_at(copy.first_known_index)!;
    copy.free();
    const toC1 = [{ userId: "3", deviceId: "C1" }];
    const signer = new Account();

    // 1. It forwards the session of A1 as the session of a device that it controls, with a valid
    // signature of that device. C1 already has the session from A1, so the first owner stays.
    await evil.handle!.encryptToDevices(toC1, "megolm.forward", {
      channelId: CHANNEL,
      sessionId: event.megolmSessionId!,
      sessionKey: exported,
      senderUserId: "4",
      senderDeviceId: "E9",
      senderEd25519: signer.ed25519_key,
      signature: signer.sign(megolmSessionSignedText(CHANNEL, event.megolmSessionId!, "4", "E9")),
    });
    // 2. It forwards its own new session and says that A1 made it, without a signature of A1: rejected.
    const own = new GroupSession();
    const ownInbound = new InboundGroupSession(own.session_key);
    await evil.handle!.encryptToDevices(toC1, "megolm.forward", {
      channelId: CHANNEL,
      sessionId: own.session_id,
      sessionKey: ownInbound.export_at(0)!,
      senderUserId: "1",
      senderDeviceId: "A1",
      senderEd25519: a1.handle!.identityKeys.ed25519,
      signature: signer.sign(megolmSessionSignedText(CHANNEL, own.session_id, "1", "A1")),
    });
    await settle([...all, evil]);
    expect(received(c1, "megolm.forward")).toBe(2);
    expect(await c1.handle!.hasMegolmSession(own.session_id)).toBe(false);
    expect(await read(c1, { ...event, senderId: "4", senderDeviceId: "E9" })).toBe("unreadable");
    // The real session still works.
    expect(await read(c1, event)).toBe("from A1");
    own.free();
    ownInbound.free();
    signer.free();
  });

  it("rejects a replayed message index", async () => {
    const { a1, b1, all } = await setup(["1", "2"], ["1", "2"]);
    const event = await send(a1, "only once");
    await settle(all);
    expect(await read(b1, event)).toBe("only once");
    // The same event again is fine. A different event with the same ciphertext is a replay.
    expect(await read(b1, event)).toBe("only once");
    expect(await read(b1, { ...event, id: "999999" })).toBe("unreadable");
  });

  it("gives the current key to a device that appears later, before the next send", async () => {
    const { server, a1, all } = await setup(["1", "2"], ["1", "2"]);
    const first = await send(a1, "first");
    await settle(all);

    const b3 = newClient("2", "B3");
    await server.start(b3);
    server.broadcast("DEVICE_LIST_UPDATE", { userId: "2" });
    // The owner did not verify B3 yet: it gets no key, and nobody answers its key request.
    const unsigned = await send(a1, "not for B3");
    await settle([...all, b3]);
    expect(received(b3, "megolm.session")).toBe(0);
    expect(await read(b3, unsigned)).toBe("waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await settle([...all, b3]);
    expect(received(b3, "megolm.forward")).toBe(0);

    // B1 verifies B3 with SAS and signs it. The next message shares the current key with B3.
    await verifyWithSas(b3, all[2]!);
    const second = await send(a1, "second");
    expect(second.megolmSessionId).toBe(first.megolmSessionId);
    await settle([...all, b3]);
    expect(received(b3, "megolm.session")).toBe(1);
    expect(await read(b3, second)).toBe("second");
    // Now signed, B3 asks again for the key of the older message, and gets it.
    await expect
      .poll(async () => {
        await settle([...all, b3]);
        return read(b3, unsigned);
      })
      .toBe("not for B3");
  });

  it("keeps the sessions after a restart, and never crashes on bad input", async () => {
    const { server, a1, b1, all } = await setup(["1", "2"], ["1", "2"]);
    const first = await send(a1, "before restart");
    await settle(all);
    server.stop(a1);
    await server.start(a1);
    const second = await send(a1, "after restart");
    expect(second.megolmSessionId).toBe(first.megolmSessionId);
    expect(await read(a1, first)).toBe("before restart");
    await settle(all);
    expect(await read(b1, second)).toBe("after restart");

    expect(await read(b1, { ...second, id: "5", ciphertext: "!!!" })).toBe("unreadable");
    expect(await read(b1, { ...second, id: "6", ciphertext: "" })).toBe("unreadable");
    expect(await read(b1, { ...second, megolmSessionId: null })).toBe("unreadable");
    expect(await read(b1, { ...second, redactedAt: new Date().toISOString() })).toBe("unreadable");
  });
});
