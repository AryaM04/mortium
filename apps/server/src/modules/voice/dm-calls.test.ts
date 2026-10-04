// Integration tests for DM calls: joining the call of a DM or a group DM,
// CALL_RING to the other recipients, and every way the ring stops. Real
// Postgres and a real `ws` client. The ring timeout is short here.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GatewayOpcode } from "@mortium/shared";
import { describeWithDb } from "../../../test/db.js";
import {
  apiFor,
  connectGateway,
  loginNewDevice,
  makeFriends,
  registerUser,
  startTestServer,
  type GatewayClient,
  type TestServer,
  type TestUser,
} from "../../../test/social.js";

vi.setConfig({ testTimeout: 20_000 });

const RING_MS = 700;
const GRACE_MS = 300;

let server: TestServer;
const sockets: GatewayClient[] = [];

async function connect(user: TestUser): Promise<GatewayClient> {
  const client = await connectGateway(server, user);
  sockets.push(client);
  return client;
}

async function openDm(user: TestUser, other: TestUser): Promise<string> {
  const result = await apiFor(server, user).post("/users/@me/channels", { recipientIds: [other.userId] });
  return result.body.id as string;
}

async function friendOf(owner: TestUser): Promise<TestUser> {
  const user = await registerUser(server, "callfriend");
  await makeFriends(server, owner, user);
  return user;
}

function join(client: GatewayClient, channelId: string): void {
  client.send(GatewayOpcode.VOICE_JOIN, { channelId, selfMute: false, selfDeaf: false });
}

function isRing(channelId: string) {
  return (d: { channelId: string }) => d.channelId === channelId;
}

describeWithDb("dm calls", () => {
  beforeAll(async () => {
    server = await startTestServer({ callRingMs: RING_MS, voiceGraceMs: GRACE_MS });
  });

  afterEach(() => {
    for (const socket of sockets.splice(0)) {
      socket.close();
    }
  });

  afterAll(async () => {
    await server.close();
  });

  it("lets a recipient join the call of a DM, with a null guild id, and rings the other person", async () => {
    const alice = await registerUser(server, "call");
    const bob = await registerUser(server, "call");
    const channelId = await openDm(alice, bob);
    const aliceSocket = await connect(alice);
    const bobSocket = await connect(bob);

    join(aliceSocket, channelId);
    const own = await aliceSocket.event("VOICE_STATE_UPDATE", (d) => d.userId === alice.userId);
    expect(own).toMatchObject({ guildId: null, channelId, userId: alice.userId, selfMute: false });
    expect(await bobSocket.event("VOICE_STATE_UPDATE", (d) => d.userId === alice.userId)).toMatchObject({ guildId: null, channelId });
    expect(await bobSocket.event("CALL_RING")).toEqual({ channelId, userId: alice.userId });
    expect(await aliceSocket.never("CALL_RING")).toBe(true);
    expect(server.ringer.isRinging(BigInt(channelId))).toBe(true);
  });

  it("stops the ring when the other person answers", async () => {
    const alice = await registerUser(server, "answer");
    const bob = await registerUser(server, "answer");
    const channelId = await openDm(alice, bob);
    const aliceSocket = await connect(alice);
    const bobSocket = await connect(bob);

    join(aliceSocket, channelId);
    await bobSocket.event("CALL_RING");
    join(bobSocket, channelId);
    expect(await bobSocket.event("CALL_RING_STOP")).toEqual({ channelId });
    expect(server.ringer.isRinging(BigInt(channelId))).toBe(false);

    // The timer is gone: no second stop comes when the timeout would have passed.
    bobSocket.drain();
    await new Promise((resolve) => setTimeout(resolve, RING_MS + 200));
    expect(await bobSocket.never("CALL_RING_STOP", () => true, 50)).toBe(true);
    expect(server.voice.channelStates(BigInt(channelId))).toHaveLength(2);
  });

  it("stops the ring after the timeout, once", async () => {
    const alice = await registerUser(server, "timeout");
    const bob = await registerUser(server, "timeout");
    const channelId = await openDm(alice, bob);
    const aliceSocket = await connect(alice);
    const bobSocket = await connect(bob);

    join(aliceSocket, channelId);
    await bobSocket.event("CALL_RING");
    const started = Date.now();
    expect(await bobSocket.event("CALL_RING_STOP", isRing(channelId), RING_MS * 4)).toEqual({ channelId });
    expect(Date.now() - started).toBeGreaterThanOrEqual(RING_MS - 100);
    expect(server.ringer.isRinging(BigInt(channelId))).toBe(false);
    // The caller stays in the call after the ring stops.
    expect(server.voice.channelStates(BigInt(channelId))).toHaveLength(1);
    expect(await bobSocket.never("CALL_RING_STOP", () => true, RING_MS + 200)).toBe(true);
  });

  it("stops the ring at once when the caller leaves", async () => {
    const alice = await registerUser(server, "hangup");
    const bob = await registerUser(server, "hangup");
    const channelId = await openDm(alice, bob);
    const aliceSocket = await connect(alice);
    const bobSocket = await connect(bob);

    join(aliceSocket, channelId);
    await bobSocket.event("CALL_RING");
    aliceSocket.send(GatewayOpcode.VOICE_LEAVE);
    const started = Date.now();
    expect(await bobSocket.event("CALL_RING_STOP")).toEqual({ channelId });
    expect(Date.now() - started).toBeLessThan(RING_MS);
    expect(server.ringer.isRinging(BigInt(channelId))).toBe(false);
    expect(await bobSocket.event("VOICE_STATE_UPDATE", (d) => d.channelId === null)).toMatchObject({ guildId: null, userId: alice.userId });
  });

  it("stops the ring when the caller disconnects and the grace period ends", async () => {
    const alice = await registerUser(server, "drop");
    const bob = await registerUser(server, "drop");
    const channelId = await openDm(alice, bob);
    const aliceSocket = await connect(alice);
    const bobSocket = await connect(bob);

    join(aliceSocket, channelId);
    await bobSocket.event("CALL_RING");
    aliceSocket.close();
    expect(await bobSocket.event("CALL_RING_STOP", isRing(channelId), RING_MS * 4)).toEqual({ channelId });
    expect(server.ringer.isRinging(BigInt(channelId))).toBe(false);
    expect(server.voice.channelStates(BigInt(channelId))).toHaveLength(0);
  });

  it("rings every other member of a group DM, and stops for all when one answers", async () => {
    const owner = await registerUser(server, "gcall");
    const one = await friendOf(owner);
    const two = await friendOf(owner);
    const group = await apiFor(server, owner).post("/users/@me/channels", { recipientIds: [one.userId, two.userId] });
    const channelId = group.body.id as string;
    const [ownerSocket, oneSocket, twoSocket] = await Promise.all([connect(owner), connect(one), connect(two)]);

    join(ownerSocket, channelId);
    expect(await oneSocket.event("CALL_RING")).toEqual({ channelId, userId: owner.userId });
    expect(await twoSocket.event("CALL_RING")).toEqual({ channelId, userId: owner.userId });
    expect(await ownerSocket.never("CALL_RING")).toBe(true);

    join(twoSocket, channelId);
    expect(await oneSocket.event("CALL_RING_STOP")).toEqual({ channelId });
    expect(await twoSocket.event("CALL_RING_STOP")).toEqual({ channelId });
    // The voice states reach every member, including the ones outside the call.
    expect(await oneSocket.event("VOICE_STATE_UPDATE", (d) => d.userId === two.userId)).toMatchObject({ guildId: null });
  });

  it("rings again for a new call after the first call ended", async () => {
    const alice = await registerUser(server, "again");
    const bob = await registerUser(server, "again");
    const channelId = await openDm(alice, bob);
    const aliceSocket = await connect(alice);
    const bobSocket = await connect(bob);

    join(aliceSocket, channelId);
    await bobSocket.event("CALL_RING");
    aliceSocket.send(GatewayOpcode.VOICE_LEAVE);
    await bobSocket.event("CALL_RING_STOP");
    join(aliceSocket, channelId);
    expect(await bobSocket.event("CALL_RING")).toEqual({ channelId, userId: alice.userId });
  });

  it("does not ring again when the caller moves to another device", async () => {
    const alice = await registerUser(server, "device");
    const bob = await registerUser(server, "device");
    const channelId = await openDm(alice, bob);
    const aliceSocket = await connect(alice);
    const bobSocket = await connect(bob);
    join(aliceSocket, channelId);
    await bobSocket.event("CALL_RING");
    bobSocket.drain();

    const phone = await connect(await loginNewDevice(server, alice));
    join(phone, channelId);
    await phone.event("VOICE_STATE_UPDATE", (d) => d.userId === alice.userId && d.channelId === channelId);
    expect(await bobSocket.never("CALL_RING")).toBe(true);
    expect(server.ringer.isRinging(BigInt(channelId))).toBe(true);
  });

  it("refuses a call from a person who is not in the DM", async () => {
    const alice = await registerUser(server, "out");
    const bob = await registerUser(server, "out");
    const outsider = await registerUser(server, "out");
    const channelId = await openDm(alice, bob);
    const outsiderSocket = await connect(outsider);
    const bobSocket = await connect(bob);

    join(outsiderSocket, channelId);
    expect(await outsiderSocket.event("VOICE_ERROR")).toMatchObject({ code: "NO_PERMISSION" });
    expect(await bobSocket.never("CALL_RING")).toBe(true);
    expect(server.voice.channelStates(BigInt(channelId))).toHaveLength(0);
  });

  it("refuses a call in a blocked DM", async () => {
    const alice = await registerUser(server, "blockcall");
    const bob = await registerUser(server, "blockcall");
    const channelId = await openDm(alice, bob);
    await apiFor(server, bob).put(`/users/@me/relationships/${alice.userId}`, { action: "block" });
    const aliceSocket = await connect(alice);
    const bobSocket = await connect(bob);

    join(aliceSocket, channelId);
    expect(await aliceSocket.event("VOICE_ERROR")).toMatchObject({ code: "NO_PERMISSION" });
    join(bobSocket, channelId);
    expect(await bobSocket.event("VOICE_ERROR")).toMatchObject({ code: "NO_PERMISSION" });
    expect(server.ringer.isRinging(BigInt(channelId))).toBe(false);
  });

  it("lets two people join a DM call, and allows unmute", async () => {
    const alice = await registerUser(server, "signal");
    const bob = await registerUser(server, "signal");
    const channelId = await openDm(alice, bob);
    const aliceSocket = await connect(alice);
    const bobSocket = await connect(bob);

    aliceSocket.send(GatewayOpcode.VOICE_JOIN, { channelId, selfMute: true, selfDeaf: false });
    await aliceSocket.event("VOICE_STATE_UPDATE", (d) => d.userId === alice.userId);
    join(bobSocket, channelId);
    await bobSocket.event("VOICE_STATE_UPDATE", (d) => d.userId === bob.userId);

    aliceSocket.send(GatewayOpcode.VOICE_STATE, { selfMute: false, selfVideo: true });
    const update = await bobSocket.event("VOICE_STATE_UPDATE", (d) => d.userId === alice.userId && d.selfVideo === true);
    expect(update).toMatchObject({ guildId: null, selfMute: false });
  });

  it("shows a running DM call in READY of a person who connects later", async () => {
    const alice = await registerUser(server, "late");
    const bob = await registerUser(server, "late");
    const channelId = await openDm(alice, bob);
    const aliceSocket = await connect(alice);
    join(aliceSocket, channelId);
    await aliceSocket.event("VOICE_STATE_UPDATE", (d) => d.userId === alice.userId);

    const bobSocket = await connect(bob);
    const ready = bobSocket.ready.d as { privateVoiceStates: Array<{ userId: string; channelId: string; guildId: string | null }> };
    expect(ready.privateVoiceStates).toEqual([expect.objectContaining({ userId: alice.userId, channelId, guildId: null })]);
  });

  it("removes a person from the call when the owner removes that person from the group", async () => {
    const owner = await registerUser(server, "kick");
    const one = await friendOf(owner);
    const two = await friendOf(owner);
    const group = await apiFor(server, owner).post("/users/@me/channels", { recipientIds: [one.userId, two.userId] });
    const channelId = group.body.id as string;
    const ownerSocket = await connect(owner);
    const oneSocket = await connect(one);
    const twoSocket = await connect(two);

    join(oneSocket, channelId);
    await oneSocket.event("VOICE_STATE_UPDATE", (d) => d.userId === one.userId);
    await apiFor(server, owner).del(`/channels/${channelId}/recipients/${one.userId}`);

    expect(await oneSocket.event("VOICE_STATE_UPDATE", (d) => d.userId === one.userId && d.channelId === null)).toMatchObject({ guildId: null });
    expect(await ownerSocket.event("VOICE_STATE_UPDATE", (d) => d.userId === one.userId && d.channelId === null)).toBeTruthy();
    expect(server.voice.channelStates(BigInt(channelId))).toHaveLength(0);
    // The call is empty now, so its ring stops for the people who were ringing.
    expect(await twoSocket.event("CALL_RING_STOP")).toEqual({ channelId });
    expect(server.ringer.isRinging(BigInt(channelId))).toBe(false);
  });

  describe("a guild voice channel", () => {
    it("still has a guild id, and never rings", async () => {
      const alice = await registerUser(server, "guild");
      const bob = await registerUser(server, "guild");
      const created = await apiFor(server, alice).post("/guilds", { name: "Call Guild" });
      const voiceChannel = created.body.channels.find((c: { type: string }) => c.type === "voice").id as string;
      const textChannel = created.body.channels.find((c: { type: string }) => c.type === "text").id as string;
      const invite = await apiFor(server, alice).post(`/channels/${textChannel}/invites`, {});
      await apiFor(server, bob).post(`/invites/${invite.body.code}`);
      const aliceSocket = await connect(alice);
      const bobSocket = await connect(bob);

      join(aliceSocket, voiceChannel);
      expect(await bobSocket.event("VOICE_STATE_UPDATE", (d) => d.userId === alice.userId)).toMatchObject({
        guildId: created.body.id,
      });
      expect(await bobSocket.never("CALL_RING")).toBe(true);

      // A text channel is not a voice channel.
      join(aliceSocket, textChannel);
      expect(await aliceSocket.event("VOICE_ERROR")).toMatchObject({ code: "NOT_A_VOICE_CHANNEL" });
    });
  });
});
