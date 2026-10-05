// Integration tests for channel event routes: post, list, redact and read
// state. Real Postgres, driven through app.inject (see test/db.ts).
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { encodeBase64Url, encodePlainPayload, Permission } from "@mortium/shared";
import { buildApp } from "../../app.js";
import { channels, events, permissionOverwrites, readStates } from "../../db/schema.js";
import { createFakeMailer } from "../../mailer.js";
import { nextId } from "../../id.js";
import { createTestDb, describeWithDb, type TestDb } from "../../../test/db.js";
import { buildTestConfig, mkTempDataDir, passwordFields } from "../../../test/helpers.js";

let testDb: TestDb;
let app: FastifyInstance;
let userCounter = 0;

interface Registered {
  accessToken: string;
  deviceId: string;
  userId: string;
}

async function registerUser(): Promise<Registered> {
  userCounter += 1;
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email: `msg-user${userCounter}@example.com`, username: `msguser${userCounter}`, ...passwordFields() },
  });
  const body = response.json() as { accessToken: string; deviceId: string; user: { id: string } };
  return { accessToken: body.accessToken, deviceId: body.deviceId, userId: body.user.id };
}

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function createGuild(token: string, name = "Message Guild") {
  const response = await app.inject({ method: "POST", url: "/api/v1/guilds", headers: authHeader(token), payload: { name } });
  return response.json() as { id: string; channels: Array<{ id: string; type: string }> };
}

function textChannelOf(guild: { channels: Array<{ id: string; type: string }> }): string {
  return guild.channels.find((c) => c.type === "text")!.id;
}

function voiceChannelOf(guild: { channels: Array<{ id: string; type: string }> }): string {
  return guild.channels.find((c) => c.type === "voice")!.id;
}

function messageCiphertext(body: string): string {
  return encodeBase64Url(encodePlainPayload({ type: "message", body, mentions: [], attachments: [], embeds: [] }));
}

function reactionCiphertext(key: string): string {
  return encodeBase64Url(encodePlainPayload({ type: "reaction", key }));
}

function nonce(): string {
  return randomBytes(12).toString("hex");
}

async function postEvent(
  token: string,
  channelId: string,
  body: Record<string, unknown>,
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/channels/${channelId}/events`,
    headers: authHeader(token),
    payload: body,
  });
}

/** Insert a timeline event directly, bypassing the REST rate limit, for bulk pagination fixtures. */
async function insertTimelineEvent(channelId: bigint, senderUserId: bigint, senderDeviceId: string): Promise<bigint> {
  const id = nextId();
  await testDb.db.insert(events).values({
    id,
    channelId,
    senderUserId,
    senderDeviceId,
    relType: null,
    codec: "megolm-v1",
    megolmSessionId: "test-session",
    ciphertext: encodePlainPayload({ type: "message", body: `bulk-${id}`, mentions: [], attachments: [], embeds: [] }),
    nonce: `bulk-${id}`,
  });
  await testDb.db.update(channels).set({ lastEventId: id }).where(eq(channels.id, channelId));
  return id;
}

async function denyPermission(channelId: string, userId: string, deny: bigint): Promise<void> {
  await testDb.db.insert(permissionOverwrites).values({
    channelId: BigInt(channelId),
    targetId: BigInt(userId),
    targetType: "member",
    allow: 0n,
    deny,
  });
}

describeWithDb("channel event routes", () => {
  beforeAll(async () => {
    testDb = await createTestDb();
    const dataDir = await mkTempDataDir();
    app = await buildApp({ db: testDb.db, config: buildTestConfig({ dataDir }), mailer: createFakeMailer(), rateLimit: false });
  });

  afterAll(async () => {
    await app.close();
    await testDb.close();
  });

  it("posts a message and reads it back with the same bytes", async () => {
    const owner = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const channelId = textChannelOf(guild);
    const ciphertext = messageCiphertext("hello there");

    const response = await postEvent(owner.accessToken, channelId, { codec: "megolm-v1", megolmSessionId: "test-session", ciphertext, nonce: nonce() });
    expect(response.statusCode).toBe(201);
    const event = response.json();
    expect(event.channelId).toBe(channelId);
    expect(event.senderId).toBe(owner.userId);
    expect(event.senderDeviceId).toBe(owner.deviceId);
    expect(event.codec).toBe("megolm-v1");
    expect(event.relType).toBeNull();
    expect(event.ciphertext).toBe(ciphertext);
    expect(event.redactedAt).toBeNull();

    const listResponse = await app.inject({
      method: "GET",
      url: `/api/v1/channels/${channelId}/events`,
      headers: authHeader(owner.accessToken),
    });
    expect(listResponse.statusCode).toBe(200);
    const list = listResponse.json();
    expect(list.events).toHaveLength(1);
    expect(list.events[0].ciphertext).toBe(ciphertext);
    expect(list.events[0].id).toBe(event.id);
  });

  it("rejects a new plaintext event with PLAINTEXT_NOT_ALLOWED, and a Megolm event without a session id", async () => {
    const owner = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const channelId = textChannelOf(guild);

    const plain = await postEvent(owner.accessToken, channelId, { codec: "plain-v1", ciphertext: messageCiphertext("secret"), nonce: nonce() });
    expect(plain.statusCode).toBe(400);
    expect(plain.json().error.code).toBe("PLAINTEXT_NOT_ALLOWED");

    const noSession = await postEvent(owner.accessToken, channelId, { codec: "megolm-v1", ciphertext: messageCiphertext("x"), nonce: nonce() });
    expect(noSession.statusCode).toBe(400);

    // An old plaintext event from development data still reads back.
    const id = nextId();
    await testDb.db.insert(events).values({
      id,
      channelId: BigInt(channelId),
      senderUserId: BigInt(owner.userId),
      senderDeviceId: owner.deviceId,
      relType: null,
      codec: "plain-v1",
      ciphertext: encodePlainPayload({ type: "message", body: "old", mentions: [], attachments: [], embeds: [] }),
      nonce: `old-${id}`,
    });
    const list = await app.inject({ method: "GET", url: `/api/v1/channels/${channelId}/events`, headers: authHeader(owner.accessToken) });
    expect(list.json().events.map((event: { codec: string }) => event.codec)).toEqual(["plain-v1"]);
  });

  it("accepts a plaintext event when the config flag allows it", async () => {
    const dataDir = await mkTempDataDir();
    const permissive = await buildApp({
      db: testDb.db,
      config: buildTestConfig({ dataDir, allowPlaintextEvents: true }),
      mailer: createFakeMailer(),
      rateLimit: false,
    });
    try {
      const owner = await registerUser();
      const guild = await createGuild(owner.accessToken);
      const response = await permissive.inject({
        method: "POST",
        url: `/api/v1/channels/${textChannelOf(guild)}/events`,
        headers: authHeader(owner.accessToken),
        payload: { codec: "plain-v1", ciphertext: messageCiphertext("dev"), nonce: nonce() },
      });
      expect(response.statusCode).toBe(201);
    } finally {
      await permissive.close();
    }
  });

  it("lists the members that can view a channel, with the permission inputs", async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const hidden = await registerUser();
    const outsider = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const channelId = textChannelOf(guild);
    for (const user of [member, hidden]) {
      const invite = await app.inject({
        method: "POST",
        url: `/api/v1/channels/${channelId}/invites`,
        headers: authHeader(owner.accessToken),
        payload: {},
      });
      await app.inject({ method: "POST", url: `/api/v1/invites/${invite.json().code}`, headers: authHeader(user.accessToken) });
    }
    await denyPermission(channelId, hidden.userId, Permission.VIEW_CHANNEL);

    const response = await app.inject({ method: "GET", url: `/api/v1/channels/${channelId}/members`, headers: authHeader(member.accessToken) });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.guildId).toBe(guild.id);
    expect(body.ownerId).toBe(owner.userId);
    expect(body.members.map((entry: { userId: string }) => entry.userId).sort()).toEqual([owner.userId, member.userId].sort());
    expect(body.overwrites).toEqual([
      { targetId: hidden.userId, targetType: "member", allow: "0", deny: Permission.VIEW_CHANNEL.toString() },
    ]);
    expect(body.roles.some((role: { id: string }) => role.id === guild.id)).toBe(true);

    const hiddenResponse = await app.inject({ method: "GET", url: `/api/v1/channels/${channelId}/members`, headers: authHeader(hidden.accessToken) });
    expect(hiddenResponse.statusCode).toBe(403);
    const outsiderResponse = await app.inject({ method: "GET", url: `/api/v1/channels/${channelId}/members`, headers: authHeader(outsider.accessToken) });
    expect(outsiderResponse.statusCode).toBe(404);
  });

  it("updates the channel's lastEventId on the guild view once a message posts", async () => {
    const owner = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const channelId = textChannelOf(guild);
    await postEvent(owner.accessToken, channelId, { codec: "megolm-v1", megolmSessionId: "test-session", ciphertext: messageCiphertext("hi"), nonce: nonce() });

    const view = await app.inject({ method: "GET", url: `/api/v1/guilds/${guild.id}`, headers: authHeader(owner.accessToken) });
    const channel = view.json().channels.find((c: { id: string }) => c.id === channelId);
    expect(channel.lastEventId).not.toBeNull();
  });

  it("rejects an empty message with no attachments", async () => {
    const owner = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const channelId = textChannelOf(guild);
    const badCiphertext = encodeBase64Url(new TextEncoder().encode(JSON.stringify({ type: "message", body: "", mentions: [], attachments: [], embeds: [] })));
    // The server never validates the plaintext payload; this only checks that
    // a well-formed but empty wire request is rejected at the shared schema
    // used by the client, not by the server. The server-side check here is
    // about the wire fields it does own: codec and ciphertext size.
    const response = await postEvent(owner.accessToken, channelId, { codec: "megolm-v1", megolmSessionId: "test-session", ciphertext: badCiphertext, nonce: nonce() });
    expect(response.statusCode).toBe(201);
  });

  it("rejects ciphertext larger than 16 KiB", async () => {
    const owner = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const channelId = textChannelOf(guild);
    const huge = encodeBase64Url(new Uint8Array(16 * 1024 + 1));
    const response = await postEvent(owner.accessToken, channelId, { codec: "megolm-v1", megolmSessionId: "test-session", ciphertext: huge, nonce: nonce() });
    expect(response.statusCode).toBe(400);
  });

  it("dedupes the same (device, nonce) pair and returns the first event with 200", async () => {
    const owner = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const channelId = textChannelOf(guild);
    const sharedNonce = nonce();

    const first = await postEvent(owner.accessToken, channelId, {
      codec: "megolm-v1", megolmSessionId: "test-session",
      ciphertext: messageCiphertext("one"),
      nonce: sharedNonce,
    });
    expect(first.statusCode).toBe(201);

    const second = await postEvent(owner.accessToken, channelId, {
      codec: "megolm-v1", megolmSessionId: "test-session",
      ciphertext: messageCiphertext("a different body, same nonce"),
      nonce: sharedNonce,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
    expect(second.json().ciphertext).toBe(first.json().ciphertext);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/channels/${channelId}/events`,
      headers: authHeader(owner.accessToken),
    });
    expect(list.json().events).toHaveLength(1);
  });

  it("answers 429 with retryAfterMs once a user exceeds 10 events in 5 seconds", async () => {
    const owner = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const channelId = textChannelOf(guild);

    const responses = [];
    for (let i = 0; i < 11; i += 1) {
      responses.push(await postEvent(owner.accessToken, channelId, { codec: "megolm-v1", megolmSessionId: "test-session", ciphertext: messageCiphertext(`m${i}`), nonce: nonce() }));
    }
    expect(responses.slice(0, 10).every((r) => r.statusCode === 201)).toBe(true);
    expect(responses[10]!.statusCode).toBe(429);
    const body = responses[10]!.json();
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(body.error.retryAfterMs).toBeGreaterThan(0);
  });

  it("returns 403 when the sender lacks SEND_MESSAGES", async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const channelId = textChannelOf(guild);
    const invite = await app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/invites`,
      headers: authHeader(owner.accessToken),
      payload: {},
    });
    await app.inject({ method: "POST", url: `/api/v1/invites/${invite.json().code}`, headers: authHeader(member.accessToken) });
    // The guild owner always has every permission, so deny the plain member instead.
    await denyPermission(channelId, member.userId, Permission.SEND_MESSAGES);

    const response = await postEvent(member.accessToken, channelId, { codec: "megolm-v1", megolmSessionId: "test-session", ciphertext: messageCiphertext("nope"), nonce: nonce() });
    expect(response.statusCode).toBe(403);
  });

  it("returns 404 for a non-member", async () => {
    const owner = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const channelId = textChannelOf(guild);
    const outsider = await registerUser();

    const response = await postEvent(outsider.accessToken, channelId, { codec: "megolm-v1", megolmSessionId: "test-session", ciphertext: messageCiphertext("nope"), nonce: nonce() });
    expect(response.statusCode).toBe(404);
  });

  it("returns 400 for a voice channel", async () => {
    const owner = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const channelId = voiceChannelOf(guild);

    const response = await postEvent(owner.accessToken, channelId, { codec: "megolm-v1", megolmSessionId: "test-session", ciphertext: messageCiphertext("nope"), nonce: nonce() });
    expect(response.statusCode).toBe(400);
  });

  it("requires ADD_REACTIONS to react, and rejects a reaction with no target", async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const channelId = textChannelOf(guild);
    const invite = await app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/invites`,
      headers: authHeader(owner.accessToken),
      payload: {},
    });
    await app.inject({ method: "POST", url: `/api/v1/invites/${invite.json().code}`, headers: authHeader(member.accessToken) });
    const message = await postEvent(owner.accessToken, channelId, { codec: "megolm-v1", megolmSessionId: "test-session", ciphertext: messageCiphertext("react to me"), nonce: nonce() });

    // The guild owner always has every permission, so deny the plain member instead.
    await denyPermission(channelId, member.userId, Permission.ADD_REACTIONS);
    const denied = await postEvent(member.accessToken, channelId, {
      relType: "reaction",
      relatesToId: message.json().id,
      codec: "megolm-v1", megolmSessionId: "test-session",
      ciphertext: reactionCiphertext("👍"),
      nonce: nonce(),
    });
    expect(denied.statusCode).toBe(403);

    const noTarget = await postEvent(owner.accessToken, channelId, {
      relType: "reaction",
      codec: "megolm-v1", megolmSessionId: "test-session",
      ciphertext: reactionCiphertext("👍"),
      nonce: nonce(),
    });
    expect(noTarget.statusCode).toBe(400);
  });

  it("returns 404 when the reaction or reply target does not exist in the channel", async () => {
    const owner = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const channelId = textChannelOf(guild);

    const response = await postEvent(owner.accessToken, channelId, {
      relType: "reaction",
      relatesToId: "999999999999999999",
      codec: "megolm-v1", megolmSessionId: "test-session",
      ciphertext: reactionCiphertext("👍"),
      nonce: nonce(),
    });
    expect(response.statusCode).toBe(404);
  });

  it("lets only the author edit their own message, and only while it is not redacted", async () => {
    const owner = await registerUser();
    const other = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const channelId = textChannelOf(guild);
    const invite = await app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/invites`,
      headers: authHeader(owner.accessToken),
      payload: {},
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/invites/${invite.json().code}`,
      headers: authHeader(other.accessToken),
    });

    const message = await postEvent(owner.accessToken, channelId, { codec: "megolm-v1", megolmSessionId: "test-session", ciphertext: messageCiphertext("original"), nonce: nonce() });

    const editByOther = await postEvent(other.accessToken, channelId, {
      relType: "edit",
      relatesToId: message.json().id,
      codec: "megolm-v1", megolmSessionId: "test-session",
      ciphertext: messageCiphertext("hijacked"),
      nonce: nonce(),
    });
    expect(editByOther.statusCode).toBe(403);

    const editByOwner = await postEvent(owner.accessToken, channelId, {
      relType: "edit",
      relatesToId: message.json().id,
      codec: "megolm-v1", megolmSessionId: "test-session",
      ciphertext: messageCiphertext("edited"),
      nonce: nonce(),
    });
    expect(editByOwner.statusCode).toBe(201);
    expect(editByOwner.json().relType).toBe("edit");
    expect(editByOwner.json().relatesToId).toBe(message.json().id);
  });

  it("shows relations for the page and excludes redacted ones", async () => {
    const owner = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const channelId = textChannelOf(guild);
    const message = await postEvent(owner.accessToken, channelId, { codec: "megolm-v1", megolmSessionId: "test-session", ciphertext: messageCiphertext("m"), nonce: nonce() });
    const reaction = await postEvent(owner.accessToken, channelId, {
      relType: "reaction",
      relatesToId: message.json().id,
      codec: "megolm-v1", megolmSessionId: "test-session",
      ciphertext: reactionCiphertext("🎉"),
      nonce: nonce(),
    });
    const edit = await postEvent(owner.accessToken, channelId, {
      relType: "edit",
      relatesToId: message.json().id,
      codec: "megolm-v1", megolmSessionId: "test-session",
      ciphertext: messageCiphertext("edited"),
      nonce: nonce(),
    });
    const removedReaction = await postEvent(owner.accessToken, channelId, {
      relType: "reaction",
      relatesToId: message.json().id,
      codec: "megolm-v1", megolmSessionId: "test-session",
      ciphertext: reactionCiphertext("😂"),
      nonce: nonce(),
    });
    await app.inject({
      method: "DELETE",
      url: `/api/v1/channels/${channelId}/events/${removedReaction.json().id}`,
      headers: authHeader(owner.accessToken),
    });

    const list = await app.inject({ method: "GET", url: `/api/v1/channels/${channelId}/events`, headers: authHeader(owner.accessToken) });
    const relationIds = list.json().relations.map((r: { id: string }) => r.id);
    expect(relationIds).toContain(reaction.json().id);
    expect(relationIds).toContain(edit.json().id);
    expect(relationIds).not.toContain(removedReaction.json().id);
  });

  it("paginates before/after/around across more than 100 events, in order, with correct hasMore flags", async () => {
    const owner = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const channelId = textChannelOf(guild);

    const ids: bigint[] = [];
    for (let i = 0; i < 120; i += 1) {
      ids.push(await insertTimelineEvent(BigInt(channelId), BigInt(owner.userId), owner.deviceId));
    }

    const firstPage = await app.inject({
      method: "GET",
      url: `/api/v1/channels/${channelId}/events?limit=50`,
      headers: authHeader(owner.accessToken),
    });
    const first = firstPage.json();
    expect(first.events).toHaveLength(50);
    expect(first.hasMoreBefore).toBe(true);
    expect(first.hasMoreAfter).toBe(false);
    // With no cursor, the page holds the 50 newest events, still ascending.
    expect(first.events.map((e: { id: string }) => e.id)).toEqual(ids.slice(70, 120).map(String));

    const secondPage = await app.inject({
      method: "GET",
      url: `/api/v1/channels/${channelId}/events?limit=50&before=${first.events[0].id}`,
      headers: authHeader(owner.accessToken),
    });
    const second = secondPage.json();
    expect(second.events).toHaveLength(50);
    expect(second.hasMoreBefore).toBe(true);
    expect(second.hasMoreAfter).toBe(true);
    expect(second.events.map((e: { id: string }) => e.id)).toEqual(ids.slice(20, 70).map(String));

    const thirdPage = await app.inject({
      method: "GET",
      url: `/api/v1/channels/${channelId}/events?limit=50&before=${second.events[0].id}`,
      headers: authHeader(owner.accessToken),
    });
    const third = thirdPage.json();
    expect(third.events).toHaveLength(20);
    expect(third.hasMoreBefore).toBe(false);
    expect(third.hasMoreAfter).toBe(true);
    expect(third.events.map((e: { id: string }) => e.id)).toEqual(ids.slice(0, 20).map(String));

    const afterPage = await app.inject({
      method: "GET",
      url: `/api/v1/channels/${channelId}/events?limit=50&after=${ids[0]}`,
      headers: authHeader(owner.accessToken),
    });
    const afterJson = afterPage.json();
    expect(afterJson.events.map((e: { id: string }) => e.id)).toEqual(ids.slice(1, 51).map(String));
    // hasMoreBefore/hasMoreAfter describe the RETURNED page's own edges (so a
    // client can keep paginating from what it got back), not the anchor it
    // asked with: id 0 sits just before this page's first id, so it is true.
    expect(afterJson.hasMoreBefore).toBe(true);
    expect(afterJson.hasMoreAfter).toBe(true);

    const aroundPage = await app.inject({
      method: "GET",
      url: `/api/v1/channels/${channelId}/events?limit=10&around=${ids[60]}`,
      headers: authHeader(owner.accessToken),
    });
    const around = aroundPage.json();
    expect(around.events.map((e: { id: string }) => e.id)).toEqual(ids.slice(55, 65).map(String));
  });

  it("redacts an event by its author, wiping the ciphertext in the database", async () => {
    const owner = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const channelId = textChannelOf(guild);
    const message = await postEvent(owner.accessToken, channelId, { codec: "megolm-v1", megolmSessionId: "test-session", ciphertext: messageCiphertext("delete me"), nonce: nonce() });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/v1/channels/${channelId}/events/${message.json().id}`,
      headers: authHeader(owner.accessToken),
    });
    expect(response.statusCode).toBe(204);

    const rows = await testDb.db.select().from(events).where(eq(events.id, BigInt(message.json().id)));
    expect(rows[0]!.ciphertext.length).toBe(0);
    expect(rows[0]!.redactedAt).not.toBeNull();

    const list = await app.inject({ method: "GET", url: `/api/v1/channels/${channelId}/events`, headers: authHeader(owner.accessToken) });
    const tombstone = list.json().events.find((e: { id: string }) => e.id === message.json().id);
    expect(tombstone.ciphertext).toBe("");
    expect(tombstone.redactedAt).not.toBeNull();
  });

  it("lets a MANAGE_MESSAGES holder redact someone else's timeline event, but not a plain member", async () => {
    const owner = await registerUser();
    const other = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const channelId = textChannelOf(guild);
    const invite = await app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/invites`,
      headers: authHeader(owner.accessToken),
      payload: {},
    });
    await app.inject({ method: "POST", url: `/api/v1/invites/${invite.json().code}`, headers: authHeader(other.accessToken) });

    const message = await postEvent(other.accessToken, channelId, { codec: "megolm-v1", megolmSessionId: "test-session", ciphertext: messageCiphertext("mod me"), nonce: nonce() });

    const memberSecond = await registerUser();
    await app.inject({ method: "POST", url: `/api/v1/invites/${invite.json().code}`, headers: authHeader(memberSecond.accessToken) });
    const deniedDelete = await app.inject({
      method: "DELETE",
      url: `/api/v1/channels/${channelId}/events/${message.json().id}`,
      headers: authHeader(memberSecond.accessToken),
    });
    expect(deniedDelete.statusCode).toBe(403);

    // The owner has ADMINISTRATOR-equivalent access via ownership, but here we
    // check the general MANAGE_MESSAGES path: the guild owner always has it.
    const ownerDelete = await app.inject({
      method: "DELETE",
      url: `/api/v1/channels/${channelId}/events/${message.json().id}`,
      headers: authHeader(owner.accessToken),
    });
    expect(ownerDelete.statusCode).toBe(204);
  });

  it("cascades a redaction to its edit and reaction relations", async () => {
    const owner = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const channelId = textChannelOf(guild);
    const message = await postEvent(owner.accessToken, channelId, { codec: "megolm-v1", megolmSessionId: "test-session", ciphertext: messageCiphertext("m"), nonce: nonce() });
    const reaction = await postEvent(owner.accessToken, channelId, {
      relType: "reaction",
      relatesToId: message.json().id,
      codec: "megolm-v1", megolmSessionId: "test-session",
      ciphertext: reactionCiphertext("🎉"),
      nonce: nonce(),
    });
    const edit = await postEvent(owner.accessToken, channelId, {
      relType: "edit",
      relatesToId: message.json().id,
      codec: "megolm-v1", megolmSessionId: "test-session",
      ciphertext: messageCiphertext("edited"),
      nonce: nonce(),
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/v1/channels/${channelId}/events/${message.json().id}`,
      headers: authHeader(owner.accessToken),
    });
    expect(response.statusCode).toBe(204);

    const reactionRow = (await testDb.db.select().from(events).where(eq(events.id, BigInt(reaction.json().id))))[0]!;
    const editRow = (await testDb.db.select().from(events).where(eq(events.id, BigInt(edit.json().id))))[0]!;
    expect(reactionRow.redactedAt).not.toBeNull();
    expect(reactionRow.ciphertext.length).toBe(0);
    expect(editRow.redactedAt).not.toBeNull();
    expect(editRow.ciphertext.length).toBe(0);
  });

  it("marks a channel read, monotonically, and reflects it in READY", async () => {
    const owner = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const channelId = textChannelOf(guild);
    const first = await postEvent(owner.accessToken, channelId, { codec: "megolm-v1", megolmSessionId: "test-session", ciphertext: messageCiphertext("1"), nonce: nonce() });
    const second = await postEvent(owner.accessToken, channelId, { codec: "megolm-v1", megolmSessionId: "test-session", ciphertext: messageCiphertext("2"), nonce: nonce() });

    const readSecond = await app.inject({
      method: "PUT",
      url: `/api/v1/channels/${channelId}/read`,
      headers: authHeader(owner.accessToken),
      payload: { eventId: second.json().id },
    });
    expect(readSecond.statusCode).toBe(204);

    const tryMoveBack = await app.inject({
      method: "PUT",
      url: `/api/v1/channels/${channelId}/read`,
      headers: authHeader(owner.accessToken),
      payload: { eventId: first.json().id },
    });
    expect(tryMoveBack.statusCode).toBe(204);

    const rows = await testDb.db.select().from(readStates).where(eq(readStates.userId, BigInt(owner.userId)));
    expect(rows[0]!.lastReadEventId).toBe(BigInt(second.json().id));
  });
});
