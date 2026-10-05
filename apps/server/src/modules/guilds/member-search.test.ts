// Integration tests for the guild member search route. Real Postgres,
// driven through app.inject (see test/db.ts).
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { guildMembers } from "../../db/schema.js";
import { createFakeMailer } from "../../mailer.js";
import { createTestDb, describeWithDb, type TestDb } from "../../../test/db.js";
import { buildTestConfig, mkTempDataDir, passwordFields } from "../../../test/helpers.js";

let testDb: TestDb;
let app: FastifyInstance;
let userCounter = 0;

async function registerUser(username: string, displayName?: string) {
  userCounter += 1;
  const email = `${username}-${userCounter}@example.com`;
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, username, ...passwordFields(), displayName },
  });
  return response.json() as { accessToken: string; user: { id: string } };
}

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function createGuild(token: string, name = "My Guild") {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/guilds",
    headers: authHeader(token),
    payload: { name },
  });
  return response.json();
}

async function joinGuild(ownerToken: string, guildId: string, textChannelId: string, memberToken: string) {
  const invite = await app.inject({
    method: "POST",
    url: `/api/v1/channels/${textChannelId}/invites`,
    headers: authHeader(ownerToken),
    payload: {},
  });
  const code = invite.json().code;
  await app.inject({ method: "POST", url: `/api/v1/invites/${code}`, headers: authHeader(memberToken) });
}

function search(token: string, guildId: string, q: string, limit?: number) {
  const query = new URLSearchParams({ q });
  if (limit !== undefined) {
    query.set("limit", String(limit));
  }
  return app.inject({
    method: "GET",
    url: `/api/v1/guilds/${guildId}/members/search?${query.toString()}`,
    headers: authHeader(token),
  });
}

describeWithDb("guild member search route", () => {
  beforeAll(async () => {
    testDb = await createTestDb();
    const dataDir = await mkTempDataDir();
    app = await buildApp({
      db: testDb.db,
      config: buildTestConfig({ dataDir }),
      mailer: createFakeMailer(),
      rateLimit: false,
    });
  });

  afterAll(async () => {
    await app.close();
    await testDb.close();
  });

  it("matches by username prefix, case-insensitively", async () => {
    const owner = await registerUser("alice");
    const member = await registerUser("alicia");
    const guild = await createGuild(owner.accessToken);
    const textChannel = guild.channels.find((c: { type: string }) => c.type === "text");
    await joinGuild(owner.accessToken, guild.id, textChannel.id, member.accessToken);

    const response = await search(owner.accessToken, guild.id, "ALI");
    expect(response.statusCode).toBe(200);
    const { members } = response.json();
    const usernames = members.map((m: { user: { username: string } }) => m.user.username).sort();
    expect(usernames).toEqual(["alice", "alicia"]);
  });

  it("matches by display name prefix", async () => {
    const owner = await registerUser("bob", "Robert");
    const member = await registerUser("carl", "Carla");
    const guild = await createGuild(owner.accessToken);
    const textChannel = guild.channels.find((c: { type: string }) => c.type === "text");
    await joinGuild(owner.accessToken, guild.id, textChannel.id, member.accessToken);

    const response = await search(owner.accessToken, guild.id, "car");
    expect(response.statusCode).toBe(200);
    const { members } = response.json();
    expect(members).toHaveLength(1);
    expect(members[0].user.username).toBe("carl");
  });

  it("matches by nickname prefix", async () => {
    const owner = await registerUser("dave");
    const member = await registerUser("erin");
    const guild = await createGuild(owner.accessToken);
    const textChannel = guild.channels.find((c: { type: string }) => c.type === "text");
    await joinGuild(owner.accessToken, guild.id, textChannel.id, member.accessToken);

    await testDb.db
      .update(guildMembers)
      .set({ nickname: "Speedy" })
      .where(eq(guildMembers.userId, BigInt(member.user.id)));

    const response = await search(owner.accessToken, guild.id, "spe");
    expect(response.statusCode).toBe(200);
    const { members } = response.json();
    expect(members).toHaveLength(1);
    expect(members[0].userId).toBe(member.user.id);
  });

  it("escapes LIKE wildcards in the query, so % and _ are literal", async () => {
    const owner = await registerUser("frank");
    const guild = await createGuild(owner.accessToken);

    const response = await search(owner.accessToken, guild.id, "%");
    expect(response.statusCode).toBe(200);
    expect(response.json().members).toEqual([]);

    const underscoreResponse = await search(owner.accessToken, guild.id, "_rank");
    expect(underscoreResponse.statusCode).toBe(200);
    expect(underscoreResponse.json().members).toEqual([]);
  });

  it("caps the result count at the requested limit, default 10, max 10", async () => {
    const owner = await registerUser("grace");
    const guild = await createGuild(owner.accessToken);
    const textChannel = guild.channels.find((c: { type: string }) => c.type === "text");
    for (let i = 0; i < 12; i += 1) {
      const member = await registerUser(`grace_friend_${i}`);
      await joinGuild(owner.accessToken, guild.id, textChannel.id, member.accessToken);
    }

    const defaultResponse = await search(owner.accessToken, guild.id, "grace");
    expect(defaultResponse.json().members).toHaveLength(10);

    const limitedResponse = await search(owner.accessToken, guild.id, "grace", 3);
    expect(limitedResponse.json().members).toHaveLength(3);

    const tooHigh = await search(owner.accessToken, guild.id, "grace", 50);
    expect(tooHigh.statusCode).toBe(400);
  });

  it("hides a guild's existence from a non-member with a 404", async () => {
    const owner = await registerUser("henry");
    const stranger = await registerUser("iris");
    const guild = await createGuild(owner.accessToken);

    const response = await search(stranger.accessToken, guild.id, "hen");
    expect(response.statusCode).toBe(404);
  });

  it("rejects a query shorter than 1 character or longer than 32 characters", async () => {
    const owner = await registerUser("jack");
    const guild = await createGuild(owner.accessToken);

    const empty = await search(owner.accessToken, guild.id, "");
    expect(empty.statusCode).toBe(400);

    const tooLong = await search(owner.accessToken, guild.id, "x".repeat(33));
    expect(tooLong.statusCode).toBe(400);
  });
});
