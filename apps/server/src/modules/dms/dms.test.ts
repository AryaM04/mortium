// Integration tests for DMs and group DMs: open, list, add, remove, leave,
// rename, messages, and blocks. Real Postgres and a real `ws` client.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GatewayOpcode } from "@mortium/shared";
import { channelRecipients, channels, events } from "../../db/schema.js";
import { describeWithDb } from "../../../test/db.js";
import {
  apiFor,
  connectGateway,
  loginNewDevice,
  makeFriends,
  postMessage,
  registerUser,
  startTestServer,
  type GatewayClient,
  type TestServer,
  type TestUser,
} from "../../../test/social.js";

vi.setConfig({ testTimeout: 20_000 });

let server: TestServer;
const sockets: GatewayClient[] = [];

async function connect(user: TestUser): Promise<GatewayClient> {
  const client = await connectGateway(server, user);
  sockets.push(client);
  return client;
}

async function openDm(user: TestUser, other: TestUser) {
  return apiFor(server, user).post("/users/@me/channels", { recipientIds: [other.userId] });
}

async function createGroup(owner: TestUser, members: TestUser[]) {
  return apiFor(server, owner).post("/users/@me/channels", { recipientIds: members.map((m) => m.userId) });
}

/** Register a user who is a friend of `owner`. */
async function friendOf(owner: TestUser, prefix = "friend"): Promise<TestUser> {
  const user = await registerUser(server, prefix);
  await makeFriends(server, owner, user);
  return user;
}

describeWithDb("dms", () => {
  beforeAll(async () => {
    server = await startTestServer();
  });

  afterEach(() => {
    for (const socket of sockets.splice(0)) {
      socket.close();
    }
  });

  afterAll(async () => {
    await server.close();
  });

  describe("1:1 DMs", () => {
    it("opens a DM, and finds the same one the second time", async () => {
      const alice = await registerUser(server, "dm");
      const bob = await registerUser(server, "dm");
      const aliceSocket = await connect(alice);
      const bobSocket = await connect(bob);

      const first = await openDm(alice, bob);
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({ type: "dm", name: null, ownerId: null, lastEventId: null });
      expect(first.body.recipients.map((user: { id: string }) => user.id).sort()).toEqual([alice.userId, bob.userId].sort());

      expect((await aliceSocket.event("CHANNEL_CREATE")).id).toBe(first.body.id);
      expect((await bobSocket.event("CHANNEL_CREATE")).id).toBe(first.body.id);

      // The other user finds the same DM. A find sends no dispatch.
      aliceSocket.drain();
      bobSocket.drain();
      const second = await openDm(bob, alice);
      expect(second.status).toBe(200);
      expect(second.body.id).toBe(first.body.id);
      expect(await aliceSocket.never("CHANNEL_CREATE")).toBe(true);
      expect(await bobSocket.never("CHANNEL_CREATE")).toBe(true);
    });

    it("makes one channel when 10 requests run in parallel, from both sides", async () => {
      const alice = await registerUser(server, "race");
      const bob = await registerUser(server, "race");
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, index) => (index % 2 === 0 ? openDm(alice, bob) : openDm(bob, alice))),
      );
      expect(results.every((result) => result.status === 200 || result.status === 201)).toBe(true);
      expect(results.filter((result) => result.status === 201)).toHaveLength(1);
      expect(new Set(results.map((result) => result.body.id)).size).toBe(1);

      const rows = await server.testDb.db.select().from(channels);
      const pairKey = [alice.userId, bob.userId].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)).join(":");
      expect(rows.filter((row) => row.dmKey === pairKey)).toHaveLength(1);
      const recipients = await server.testDb.db.select().from(channelRecipients);
      expect(recipients.filter((row) => row.channelId.toString() === results[0]!.body.id)).toHaveLength(2);
    });

    it("rejects a DM with self, an unknown user, and a bad body", async () => {
      const alice = await registerUser(server, "bad");
      const self = await apiFor(server, alice).post("/users/@me/channels", { recipientIds: [alice.userId] });
      expect(self.status).toBe(400);
      expect(self.body.error.code).toBe("INVALID_RECIPIENTS");
      const unknown = await apiFor(server, alice).post("/users/@me/channels", { recipientIds: ["999999999999"] });
      expect(unknown.status).toBe(404);
      const empty = await apiFor(server, alice).post("/users/@me/channels", { recipientIds: [] });
      expect(empty.status).toBe(400);
      const many = await apiFor(server, alice).post("/users/@me/channels", {
        recipientIds: Array.from({ length: 10 }, (_, i) => String(1000 + i)),
      });
      expect(many.status).toBe(400);
    });

    it("lists the DMs of a user with recipients and lastEventId, newest first", async () => {
      const alice = await registerUser(server, "list");
      const bob = await registerUser(server, "list");
      const carol = await registerUser(server, "list");
      const first = await openDm(alice, bob);
      const second = await openDm(alice, carol);
      await postMessage(apiFor(server, alice), first.body.id);
      const posted = await postMessage(apiFor(server, alice), second.body.id);
      const latest = await postMessage(apiFor(server, alice), first.body.id);

      const list = await apiFor(server, alice).get("/users/@me/channels");
      expect(list.status).toBe(200);
      expect(list.body.channels.map((channel: { id: string }) => channel.id)).toEqual([first.body.id, second.body.id]);
      expect(list.body.channels[0].lastEventId).toBe(latest.body.id);
      expect(list.body.channels[1].lastEventId).toBe(posted.body.id);

      // Bob sees only his own DM.
      const bobList = await apiFor(server, bob).get("/users/@me/channels");
      expect(bobList.body.channels.map((channel: { id: string }) => channel.id)).toEqual([first.body.id]);
    });

    it("puts private channels in READY", async () => {
      const alice = await registerUser(server, "ready");
      const bob = await registerUser(server, "ready");
      const dm = await openDm(alice, bob);
      const socket = await connect(alice);
      const ready = socket.ready.d as { privateChannels: Array<{ id: string; recipients: unknown[] }> };
      expect(ready.privateChannels).toHaveLength(1);
      expect(ready.privateChannels[0]!.id).toBe(dm.body.id);
      expect(ready.privateChannels[0]!.recipients).toHaveLength(2);
    });
  });

  describe("group DMs", () => {
    it("creates a group DM with friends, and every member gets CHANNEL_CREATE", async () => {
      const owner = await registerUser(server, "owner");
      const one = await friendOf(owner);
      const two = await friendOf(owner);
      const sockets3 = await Promise.all([connect(owner), connect(one), connect(two)]);

      const result = await createGroup(owner, [one, two]);
      expect(result.status).toBe(201);
      expect(result.body).toMatchObject({ type: "group_dm", ownerId: owner.userId, name: null });
      expect(result.body.recipients).toHaveLength(3);
      for (const socket of sockets3) {
        expect((await socket.event("CHANNEL_CREATE")).id).toBe(result.body.id);
      }
    });

    it("rejects a group DM with a person who is not a friend", async () => {
      const owner = await registerUser(server, "nf");
      const friend = await friendOf(owner);
      const stranger = await registerUser(server, "nf");
      const result = await createGroup(owner, [friend, stranger]);
      expect(result.status).toBe(403);
      expect(result.body.error.code).toBe("NOT_FRIENDS");
      // A pending request is not a friendship.
      await apiFor(server, owner).post("/users/@me/relationships", { username: stranger.username });
      expect((await createGroup(owner, [friend, stranger])).status).toBe(403);
    });

    it("allows 9 recipients and rejects a duplicate recipient", async () => {
      const owner = await registerUser(server, "full");
      const friends: TestUser[] = [];
      for (let i = 0; i < 9; i += 1) {
        friends.push(await friendOf(owner));
      }
      const full = await createGroup(owner, friends);
      expect(full.status).toBe(201);
      expect(full.body.recipients).toHaveLength(10);

      const duplicate = await createGroup(owner, [friends[0]!, friends[0]!]);
      expect(duplicate.status).toBe(400);
      const withSelf = await createGroup(owner, [friends[0]!, owner]);
      expect(withSelf.status).toBe(400);
    });

    it("lets the owner add a friend, and refuses other callers", async () => {
      const owner = await registerUser(server, "add");
      const one = await friendOf(owner);
      const two = await friendOf(owner);
      const late = await friendOf(owner);
      const group = await createGroup(owner, [one, two]);
      const ownerSocket = await connect(owner);
      const oneSocket = await connect(one);
      const lateSocket = await connect(late);
      const path = (user: TestUser) => `/channels/${group.body.id}/recipients/${user.userId}`;

      // A member who is not the owner cannot add.
      const byMember = await apiFor(server, one).put(path(late));
      expect(byMember.status).toBe(403);
      expect(byMember.body.error.code).toBe("OWNER_ONLY");

      const added = await apiFor(server, owner).put(path(late));
      expect(added.status).toBe(204);
      const created = await lateSocket.event("CHANNEL_CREATE");
      expect(created.id).toBe(group.body.id);
      expect(created.recipients).toHaveLength(4);
      expect(await oneSocket.event("CHANNEL_RECIPIENT_ADD")).toMatchObject({ channelId: group.body.id, user: { id: late.userId } });
      expect(await ownerSocket.event("CHANNEL_RECIPIENT_ADD")).toMatchObject({ user: { id: late.userId } });
      expect(await lateSocket.never("CHANNEL_RECIPIENT_ADD")).toBe(true);

      const again = await apiFor(server, owner).put(path(late));
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe("ALREADY_RECIPIENT");
    });

    it("refuses to add a person who is not a friend of the owner, or to a full group", async () => {
      const owner = await registerUser(server, "cap");
      const friends: TestUser[] = [];
      for (let i = 0; i < 9; i += 1) {
        friends.push(await friendOf(owner));
      }
      const group = await createGroup(owner, friends);
      const extra = await friendOf(owner);
      const full = await apiFor(server, owner).put(`/channels/${group.body.id}/recipients/${extra.userId}`);
      expect(full.status).toBe(409);
      expect(full.body.error.code).toBe("GROUP_DM_FULL");

      const small = await createGroup(owner, [friends[0]!, friends[1]!]);
      const stranger = await registerUser(server, "cap");
      const notFriend = await apiFor(server, owner).put(`/channels/${small.body.id}/recipients/${stranger.userId}`);
      expect(notFriend.status).toBe(403);
      expect(notFriend.body.error.code).toBe("NOT_FRIENDS");
    });

    it("answers 400 for the group routes on a 1:1 DM, and 404 for a non-recipient", async () => {
      const alice = await registerUser(server, "one");
      const bob = await registerUser(server, "one");
      const carol = await friendOf(alice);
      const outsider = await registerUser(server, "one");
      const dm = await openDm(alice, bob);
      const add = await apiFor(server, alice).put(`/channels/${dm.body.id}/recipients/${carol.userId}`);
      expect(add.status).toBe(400);
      expect(add.body.error.code).toBe("NOT_GROUP_DM");
      const rename = await apiFor(server, alice).patch(`/channels/${dm.body.id}`, { name: "x" });
      expect(rename.status).toBe(400);

      const group = await createGroup(alice, [bob, carol]);
      expect((await apiFor(server, outsider).put(`/channels/${group.body.id}/recipients/${outsider.userId}`)).status).toBe(404);
      expect((await apiFor(server, outsider).del(`/channels/${group.body.id}/recipients/${alice.userId}`)).status).toBe(404);
      expect((await apiFor(server, outsider).patch(`/channels/${group.body.id}`, { name: "x" })).status).toBe(404);
    });

    it("lets the owner remove a member, and refuses other callers", async () => {
      const owner = await registerUser(server, "rm");
      const one = await friendOf(owner);
      const two = await friendOf(owner);
      const group = await createGroup(owner, [one, two]);
      const ownerSocket = await connect(owner);
      const oneSocket = await connect(one);
      const twoSocket = await connect(two);
      const path = (user: TestUser) => `/channels/${group.body.id}/recipients/${user.userId}`;

      const byMember = await apiFor(server, one).del(path(two));
      expect(byMember.status).toBe(403);
      expect(byMember.body.error.code).toBe("OWNER_ONLY");

      expect((await apiFor(server, owner).del(path(two))).status).toBe(204);
      expect(await twoSocket.event("CHANNEL_DELETE")).toEqual({ id: group.body.id, guildId: null });
      expect(await oneSocket.event("CHANNEL_RECIPIENT_REMOVE")).toEqual({ channelId: group.body.id, userId: two.userId });
      expect(await ownerSocket.event("CHANNEL_RECIPIENT_REMOVE")).toEqual({ channelId: group.body.id, userId: two.userId });
      expect(await twoSocket.never("CHANNEL_RECIPIENT_REMOVE")).toBe(true);

      // The removed person can no longer read the channel.
      expect((await apiFor(server, two).get(`/channels/${group.body.id}/events`)).status).toBe(404);
      const missing = await apiFor(server, owner).del(path(two));
      expect(missing.status).toBe(404);
    });

    it("lets a member leave, and sends the others CHANNEL_RECIPIENT_REMOVE", async () => {
      const owner = await registerUser(server, "leave");
      const one = await friendOf(owner);
      const two = await friendOf(owner);
      const group = await createGroup(owner, [one, two]);
      const ownerSocket = await connect(owner);
      const oneSocket = await connect(one);

      expect((await apiFor(server, two).del(`/channels/${group.body.id}/recipients/${two.userId}`)).status).toBe(204);
      expect(await ownerSocket.event("CHANNEL_RECIPIENT_REMOVE")).toEqual({ channelId: group.body.id, userId: two.userId });
      expect(await oneSocket.event("CHANNEL_RECIPIENT_REMOVE")).toEqual({ channelId: group.body.id, userId: two.userId });
      // The owner did not change, so there is no CHANNEL_UPDATE.
      expect(await ownerSocket.never("CHANNEL_UPDATE")).toBe(true);
    });

    it("gives a group to the oldest member when the owner leaves", async () => {
      // "recent" is the oldest account, but the newest member of the group.
      const owner = await registerUser(server, "own");
      const recent = await friendOf(owner, "recent");
      const first = await friendOf(owner, "first");
      const second = await friendOf(owner, "second");
      const group = await createGroup(owner, [first, second]);
      expect((await apiFor(server, owner).put(`/channels/${group.body.id}/recipients/${recent.userId}`)).status).toBe(204);
      const firstSocket = await connect(first);
      const secondSocket = await connect(second);
      const recentSocket = await connect(recent);

      expect((await apiFor(server, owner).del(`/channels/${group.body.id}/recipients/${owner.userId}`)).status).toBe(204);
      for (const socket of [firstSocket, secondSocket, recentSocket]) {
        const update = await socket.event("CHANNEL_UPDATE");
        expect(update.ownerId).toBe(first.userId);
        expect(update.recipients).toHaveLength(3);
      }

      // The new owner can now add and remove people.
      expect((await apiFor(server, first).del(`/channels/${group.body.id}/recipients/${recent.userId}`)).status).toBe(204);
      // The next oldest member takes over when the new owner leaves.
      await apiFor(server, first).del(`/channels/${group.body.id}/recipients/${first.userId}`);
      const list = await apiFor(server, second).get("/users/@me/channels");
      expect(list.body.channels[0].ownerId).toBe(second.userId);
    });

    it("ends the group DM and its history when the last member leaves", async () => {
      const owner = await registerUser(server, "last");
      const one = await friendOf(owner);
      const two = await friendOf(owner);
      const group = await createGroup(owner, [one, two]);
      await postMessage(apiFor(server, owner), group.body.id);
      const leave = (user: TestUser) => apiFor(server, user).del(`/channels/${group.body.id}/recipients/${user.userId}`);
      const groupRows = async () =>
        (await server.testDb.db.select().from(channels)).filter((row) => row.id.toString() === group.body.id);

      expect((await leave(owner)).status).toBe(204);
      expect((await leave(one)).status).toBe(204);
      expect(await groupRows()).toHaveLength(1);
      expect((await leave(two)).status).toBe(204);
      expect(await groupRows()).toHaveLength(0);
      const history = (await server.testDb.db.select().from(events)).filter((row) => row.channelId.toString() === group.body.id);
      expect(history).toHaveLength(0);
    });

    it("renames a group DM for any member, and clears the name with null", async () => {
      const owner = await registerUser(server, "name");
      const one = await friendOf(owner);
      const two = await friendOf(owner);
      const group = await createGroup(owner, [one, two]);
      const ownerSocket = await connect(owner);
      const twoSocket = await connect(two);

      const renamed = await apiFor(server, one).patch(`/channels/${group.body.id}`, { name: "  The crew  " });
      expect(renamed.status).toBe(200);
      expect(renamed.body).toMatchObject({ id: group.body.id, name: "The crew", type: "group_dm" });
      expect((await ownerSocket.event("CHANNEL_UPDATE")).name).toBe("The crew");
      expect((await twoSocket.event("CHANNEL_UPDATE")).name).toBe("The crew");

      const cleared = await apiFor(server, two).patch(`/channels/${group.body.id}`, { name: null });
      expect(cleared.body.name).toBeNull();
      const tooLong = await apiFor(server, two).patch(`/channels/${group.body.id}`, { name: "x".repeat(101) });
      expect(tooLong.status).toBe(400);
    });

    it("does not let a DM be deleted through the guild channel route", async () => {
      const alice = await registerUser(server, "del");
      const bob = await registerUser(server, "del");
      const dm = await openDm(alice, bob);
      expect((await apiFor(server, alice).del(`/channels/${dm.body.id}`)).status).toBe(404);
      const list = await apiFor(server, alice).get("/users/@me/channels");
      expect(list.body.channels).toHaveLength(1);
    });
  });

  describe("messages in a DM", () => {
    it("sends events only to the recipients, and answers 404 to a non-recipient", async () => {
      const alice = await registerUser(server, "msg");
      const bob = await registerUser(server, "msg");
      const outsider = await registerUser(server, "msg");
      const dm = await openDm(alice, bob);
      const aliceSocket = await connect(alice);
      const bobSocket = await connect(bob);
      const outsiderSocket = await connect(outsider);

      const posted = await postMessage(apiFor(server, alice), dm.body.id, "hi bob");
      expect(posted.status).toBe(201);
      expect((await aliceSocket.event("EVENT_CREATE")).id).toBe(posted.body.id);
      expect((await bobSocket.event("EVENT_CREATE")).id).toBe(posted.body.id);
      expect(await outsiderSocket.never("EVENT_CREATE")).toBe(true);

      const history = await apiFor(server, bob).get(`/channels/${dm.body.id}/events`);
      expect(history.status).toBe(200);
      expect(history.body.events.map((event: { id: string }) => event.id)).toEqual([posted.body.id]);

      const outsiderApi = apiFor(server, outsider);
      expect((await outsiderApi.get(`/channels/${dm.body.id}/events`)).status).toBe(404);
      expect((await postMessage(outsiderApi, dm.body.id)).status).toBe(404);
      expect((await outsiderApi.del(`/channels/${dm.body.id}/events/${posted.body.id}`)).status).toBe(404);
      expect((await outsiderApi.put(`/channels/${dm.body.id}/read`, { eventId: posted.body.id })).status).toBe(404);
    });

    it("lets a person delete only their own events", async () => {
      const alice = await registerUser(server, "redact");
      const bob = await registerUser(server, "redact");
      const dm = await openDm(alice, bob);
      const bobSocket = await connect(bob);
      const posted = await postMessage(apiFor(server, alice), dm.body.id);

      const byBob = await apiFor(server, bob).del(`/channels/${dm.body.id}/events/${posted.body.id}`);
      expect(byBob.status).toBe(403);
      expect(byBob.body.error.code).toBe("MISSING_PERMISSION");

      expect((await apiFor(server, alice).del(`/channels/${dm.body.id}/events/${posted.body.id}`)).status).toBe(204);
      expect((await bobSocket.event("EVENT_REDACT")).ids).toContain(posted.body.id);
    });

    it("accepts a reaction, and sends the read marker to the other device", async () => {
      const alice = await registerUser(server, "react");
      const bob = await registerUser(server, "react");
      const dm = await openDm(alice, bob);
      const posted = await postMessage(apiFor(server, alice), dm.body.id);
      const reaction = await apiFor(server, bob).post(`/channels/${dm.body.id}/events`, {
        codec: "megolm-v1", megolmSessionId: "test-session",
        ciphertext: "AAAA",
        nonce: "reaction-1",
        relType: "reaction",
        relatesToId: posted.body.id,
      });
      expect(reaction.status).toBe(201);

      const bobPhone = await loginNewDevice(server, bob);
      const phoneSocket = await connect(bobPhone);
      const read = await apiFor(server, bob).put(`/channels/${dm.body.id}/read`, { eventId: posted.body.id });
      expect(read.status).toBe(204);
      expect(await phoneSocket.event("READ_STATE_UPDATE")).toEqual({ channelId: dm.body.id, lastReadEventId: posted.body.id });
    });

    it("sends TYPING_START to the other recipients only", async () => {
      const alice = await registerUser(server, "type");
      const bob = await registerUser(server, "type");
      const outsider = await registerUser(server, "type");
      const dm = await openDm(alice, bob);
      const aliceSocket = await connect(alice);
      const bobSocket = await connect(bob);
      const outsiderSocket = await connect(outsider);

      aliceSocket.send(GatewayOpcode.TYPING, { channelId: dm.body.id });
      expect(await bobSocket.event("TYPING_START")).toEqual({ channelId: dm.body.id, userId: alice.userId });
      expect(await aliceSocket.never("TYPING_START")).toBe(true);
      expect(await outsiderSocket.never("TYPING_START")).toBe(true);

      // A non-recipient gets no typing forwarded.
      outsiderSocket.send(GatewayOpcode.TYPING, { channelId: dm.body.id });
      expect(await bobSocket.never("TYPING_START", (d) => d.userId === outsider.userId)).toBe(true);
    });

    it("sends group DM events to every member", async () => {
      const owner = await registerUser(server, "grp");
      const one = await friendOf(owner);
      const two = await friendOf(owner);
      const group = await createGroup(owner, [one, two]);
      const twoSocket = await connect(two);
      const oneSocket = await connect(one);
      const posted = await postMessage(apiFor(server, one), group.body.id);
      expect((await twoSocket.event("EVENT_CREATE")).id).toBe(posted.body.id);
      expect((await oneSocket.event("EVENT_CREATE")).id).toBe(posted.body.id);
    });
  });

  describe("blocks", () => {
    it("stops a DM in both directions", async () => {
      const alice = await registerUser(server, "block");
      const bob = await registerUser(server, "block");
      const dm = await openDm(alice, bob);
      const bobSocket = await connect(bob);
      const posted = await postMessage(apiFor(server, alice), dm.body.id);
      await bobSocket.event("EVENT_CREATE");

      await apiFor(server, alice).put(`/users/@me/relationships/${bob.userId}`, { action: "block" });

      for (const [sender, api] of [
        [alice, apiFor(server, alice)],
        [bob, apiFor(server, bob)],
      ] as const) {
        const result = await postMessage(api, dm.body.id);
        expect(result.status, sender.username).toBe(403);
        expect(result.body.error.code).toBe("CANNOT_MESSAGE_USER");
      }
      const reaction = await apiFor(server, bob).post(`/channels/${dm.body.id}/events`, {
        codec: "megolm-v1", megolmSessionId: "test-session",
        ciphertext: "AAAA",
        nonce: "blocked-reaction",
        relType: "reaction",
        relatesToId: posted.body.id,
      });
      expect(reaction.status).toBe(403);

      // Nobody can open the DM again while the block lasts. This holds for the existing DM too.
      for (const [user, other] of [
        [alice, bob],
        [bob, alice],
      ] as const) {
        const open = await openDm(user, other);
        expect(open.status).toBe(403);
        expect(open.body.error.code).toBe("CANNOT_MESSAGE_USER");
      }

      // Typing does not reach the blocker.
      const aliceSocket = await connect(alice);
      bobSocket.send(GatewayOpcode.TYPING, { channelId: dm.body.id });
      expect(await aliceSocket.never("TYPING_START")).toBe(true);

      // History stays readable, and a person can still delete their own events.
      expect((await apiFor(server, bob).get(`/channels/${dm.body.id}/events`)).status).toBe(200);
      expect((await apiFor(server, alice).del(`/channels/${dm.body.id}/events/${posted.body.id}`)).status).toBe(204);

      // The DM works again after the unblock.
      await apiFor(server, alice).del(`/users/@me/relationships/${bob.userId}`);
      expect((await postMessage(apiFor(server, bob), dm.body.id)).status).toBe(201);
    });

    it("does not stop a group DM", async () => {
      const owner = await registerUser(server, "gblock");
      const one = await friendOf(owner);
      const two = await friendOf(owner);
      const group = await createGroup(owner, [one, two]);
      await apiFor(server, one).put(`/users/@me/relationships/${two.userId}`, { action: "block" });
      expect((await postMessage(apiFor(server, two), group.body.id)).status).toBe(201);
    });
  });
});
