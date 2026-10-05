// Integration tests for guild, channel and invite routes. Real Postgres,
// driven through app.inject (see test/db.ts).
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { bans } from "../../db/schema.js";
import { createFakeMailer } from "../../mailer.js";
import { createTestDb, describeWithDb, type TestDb } from "../../../test/db.js";
import { buildTestConfig, mkTempDataDir, passwordFields } from "../../../test/helpers.js";

let testDb: TestDb;
let app: FastifyInstance;
let userCounter = 0;

async function registerUser() {
  userCounter += 1;
  const email = `user${userCounter}@example.com`;
  const username = `user${userCounter}`;
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, username, ...passwordFields() },
  });
  return response.json() as { accessToken: string; user: { id: string; username: string } };
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
  return response;
}

describeWithDb("guild, channel and invite routes", () => {
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

  it("creates a guild with an @everyone role and default channels", async () => {
    const owner = await registerUser();
    const response = await createGuild(owner.accessToken, "Test Guild");
    expect(response.statusCode).toBe(201);
    const guild = response.json();

    expect(guild.name).toBe("Test Guild");
    expect(guild.ownerId).toBe(owner.user.id);
    expect(guild.roles).toHaveLength(1);
    expect(guild.roles[0].id).toBe(guild.id);
    expect(guild.roles[0].name).toBe("@everyone");

    const channelNames = guild.channels.map((c: { name: string | null; type: string }) => [c.type, c.name]);
    expect(channelNames).toEqual(
      expect.arrayContaining([
        ["category", "Text channels"],
        ["text", "general"],
        ["category", "Voice channels"],
        ["voice", "General"],
      ]),
    );
    expect(guild.member.userId).toBe(owner.user.id);
    expect(guild.member.user.username).toBe(owner.user.username);
    // Every channel carries its permission overwrites, so a client can
    // compute permissions locally without a second request.
    for (const channel of guild.channels) {
      expect(Array.isArray(channel.permissionOverwrites)).toBe(true);
      expect(channel.permissionOverwrites).toEqual([]);
    }
  });

  it("rejects an empty or too-long guild name", async () => {
    const owner = await registerUser();
    const empty = await createGuild(owner.accessToken, "");
    expect(empty.statusCode).toBe(400);
    const tooLong = await createGuild(owner.accessToken, "x".repeat(101));
    expect(tooLong.statusCode).toBe(400);
  });

  it("hides a guild's existence from a non-member with a 404, not a 403", async () => {
    const owner = await registerUser();
    const stranger = await registerUser();
    const guild = (await createGuild(owner.accessToken)).json();

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/guilds/${guild.id}`,
      headers: authHeader(stranger.accessToken),
    });
    expect(response.statusCode).toBe(404);
  });

  it("rejects a member without MANAGE_CHANNELS from creating a channel", async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const guild = (await createGuild(owner.accessToken)).json();

    const invite = await app.inject({
      method: "POST",
      url: `/api/v1/channels/${guild.channels.find((c: { type: string }) => c.type === "text").id}/invites`,
      headers: authHeader(owner.accessToken),
      payload: {},
    });
    const code = invite.json().code;
    await app.inject({
      method: "POST",
      url: `/api/v1/invites/${code}`,
      headers: authHeader(member.accessToken),
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/guilds/${guild.id}/channels`,
      headers: authHeader(member.accessToken),
      payload: { name: "new-channel", type: "text" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("MISSING_PERMISSION");
  });

  it("normalizes a text channel name and rejects an invalid category parent", async () => {
    const owner = await registerUser();
    const guild = (await createGuild(owner.accessToken)).json();

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/guilds/${guild.id}/channels`,
      headers: authHeader(owner.accessToken),
      payload: { name: "  Hello World!! ", type: "text" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().name).toBe("hello-world");

    const textChannel = response.json();
    const badParent = await app.inject({
      method: "POST",
      url: `/api/v1/guilds/${guild.id}/channels`,
      headers: authHeader(owner.accessToken),
      payload: { name: "child", type: "text", parentId: textChannel.id },
    });
    expect(badParent.statusCode).toBe(400);

    const categoryWithParent = await app.inject({
      method: "POST",
      url: `/api/v1/guilds/${guild.id}/channels`,
      headers: authHeader(owner.accessToken),
      payload: { name: "cat", type: "category", parentId: textChannel.id },
    });
    expect(categoryWithParent.statusCode).toBe(400);
  });

  it("validates a channel reorder request", async () => {
    const owner = await registerUser();
    const guild = (await createGuild(owner.accessToken)).json();
    const textChannel = guild.channels.find((c: { type: string }) => c.type === "text");

    const badOrder = await app.inject({
      method: "PUT",
      url: `/api/v1/guilds/${guild.id}/channels/order`,
      headers: authHeader(owner.accessToken),
      payload: [{ id: "1", position: 0, parentId: null }],
    });
    expect(badOrder.statusCode).toBe(400);

    const goodOrder = await app.inject({
      method: "PUT",
      url: `/api/v1/guilds/${guild.id}/channels/order`,
      headers: authHeader(owner.accessToken),
      payload: [{ id: textChannel.id, position: 5, parentId: null }],
    });
    expect(goodOrder.statusCode).toBe(204);

    const refreshed = await app.inject({
      method: "GET",
      url: `/api/v1/guilds/${guild.id}`,
      headers: authHeader(owner.accessToken),
    });
    const refreshedChannel = refreshed
      .json()
      .channels.find((c: { id: string }) => c.id === textChannel.id);
    expect(refreshedChannel.position).toBe(5);
  });

  it("creates, previews and accepts an invite", async () => {
    const owner = await registerUser();
    const joiner = await registerUser();
    const guild = (await createGuild(owner.accessToken)).json();
    const textChannel = guild.channels.find((c: { type: string }) => c.type === "text");

    const inviteResponse = await app.inject({
      method: "POST",
      url: `/api/v1/channels/${textChannel.id}/invites`,
      headers: authHeader(owner.accessToken),
      payload: { maxAgeSeconds: 0, maxUses: 0 },
    });
    expect(inviteResponse.statusCode).toBe(201);
    const code = inviteResponse.json().code;

    const preview = await app.inject({
      method: "GET",
      url: `/api/v1/invites/${code}`,
      headers: authHeader(joiner.accessToken),
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().guild.id).toBe(guild.id);
    expect(preview.json().memberCount).toBe(1);

    const accept = await app.inject({
      method: "POST",
      url: `/api/v1/invites/${code}`,
      headers: authHeader(joiner.accessToken),
    });
    expect(accept.statusCode).toBe(200);
    expect(accept.json().guild.member.userId).toBe(joiner.user.id);

    // Accepting again is idempotent.
    const acceptAgain = await app.inject({
      method: "POST",
      url: `/api/v1/invites/${code}`,
      headers: authHeader(joiner.accessToken),
    });
    expect(acceptAgain.statusCode).toBe(200);
  });

  it("returns 404 for an expired invite", async () => {
    const owner = await registerUser();
    const joiner = await registerUser();
    const guild = (await createGuild(owner.accessToken)).json();
    const textChannel = guild.channels.find((c: { type: string }) => c.type === "text");

    const inviteResponse = await app.inject({
      method: "POST",
      url: `/api/v1/channels/${textChannel.id}/invites`,
      headers: authHeader(owner.accessToken),
      payload: { maxAgeSeconds: 1800, maxUses: 0 },
    });
    const code = inviteResponse.json().code;

    // Force it to look expired without waiting 30 minutes.
    await testDb.db.execute(sql`update invites set expires_at = now() - interval '1 second' where code = ${code}`);

    const preview = await app.inject({
      method: "GET",
      url: `/api/v1/invites/${code}`,
      headers: authHeader(joiner.accessToken),
    });
    expect(preview.statusCode).toBe(404);
    expect(preview.json().error.code).toBe("INVITE_NOT_FOUND");
  });

  it("allows exactly maxUses accepts under concurrency, no more", async () => {
    const owner = await registerUser();
    const guild = (await createGuild(owner.accessToken)).json();
    const textChannel = guild.channels.find((c: { type: string }) => c.type === "text");

    const inviteResponse = await app.inject({
      method: "POST",
      url: `/api/v1/channels/${textChannel.id}/invites`,
      headers: authHeader(owner.accessToken),
      payload: { maxAgeSeconds: 0, maxUses: 3 },
    });
    const code = inviteResponse.json().code;

    const joiners = await Promise.all(Array.from({ length: 10 }, () => registerUser()));
    const results = await Promise.all(
      joiners.map((joiner) =>
        app.inject({
          method: "POST",
          url: `/api/v1/invites/${code}`,
          headers: authHeader(joiner.accessToken),
        }),
      ),
    );

    const succeeded = results.filter((response) => response.statusCode === 200);
    const failed = results.filter((response) => response.statusCode === 404);
    expect(succeeded).toHaveLength(3);
    expect(failed).toHaveLength(7);
  });

  it("blocks a banned user from accepting an invite", async () => {
    const owner = await registerUser();
    const banned = await registerUser();
    const guild = (await createGuild(owner.accessToken)).json();
    const textChannel = guild.channels.find((c: { type: string }) => c.type === "text");

    await testDb.db.insert(bans).values({
      guildId: BigInt(guild.id),
      userId: BigInt(banned.user.id),
      by: BigInt(owner.user.id),
      reason: null,
    });

    const inviteResponse = await app.inject({
      method: "POST",
      url: `/api/v1/channels/${textChannel.id}/invites`,
      headers: authHeader(owner.accessToken),
      payload: {},
    });
    const code = inviteResponse.json().code;

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/invites/${code}`,
      headers: authHeader(banned.accessToken),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("BANNED");
  });

  it("lets a member leave, and the owner cannot leave", async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const guild = (await createGuild(owner.accessToken)).json();
    const textChannel = guild.channels.find((c: { type: string }) => c.type === "text");
    const inviteResponse = await app.inject({
      method: "POST",
      url: `/api/v1/channels/${textChannel.id}/invites`,
      headers: authHeader(owner.accessToken),
      payload: {},
    });
    const code = inviteResponse.json().code;
    await app.inject({ method: "POST", url: `/api/v1/invites/${code}`, headers: authHeader(member.accessToken) });

    const leave = await app.inject({
      method: "DELETE",
      url: `/api/v1/guilds/${guild.id}/members/@me`,
      headers: authHeader(member.accessToken),
    });
    expect(leave.statusCode).toBe(204);

    const ownerLeave = await app.inject({
      method: "DELETE",
      url: `/api/v1/guilds/${guild.id}/members/@me`,
      headers: authHeader(owner.accessToken),
    });
    expect(ownerLeave.statusCode).toBe(409);
    expect(ownerLeave.json().error.code).toBe("OWNER_CANNOT_LEAVE");
  });

  it("lists a guild's members with their user profile and roles", async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const guild = (await createGuild(owner.accessToken)).json();
    const textChannel = guild.channels.find((c: { type: string }) => c.type === "text");
    const inviteResponse = await app.inject({
      method: "POST",
      url: `/api/v1/channels/${textChannel.id}/invites`,
      headers: authHeader(owner.accessToken),
      payload: {},
    });
    const code = inviteResponse.json().code;
    await app.inject({ method: "POST", url: `/api/v1/invites/${code}`, headers: authHeader(member.accessToken) });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/guilds/${guild.id}/members`,
      headers: authHeader(owner.accessToken),
    });
    expect(response.statusCode).toBe(200);
    const { members } = response.json();
    expect(members).toHaveLength(2);
    for (const memberJson of members) {
      expect(memberJson.user).toBeDefined();
      expect(typeof memberJson.user.username).toBe("string");
      expect(Array.isArray(memberJson.roles)).toBe(true);
    }
  });

  it("only the owner can delete the guild, and the deletion cascades", async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const guild = (await createGuild(owner.accessToken)).json();
    const textChannel = guild.channels.find((c: { type: string }) => c.type === "text");
    const inviteResponse = await app.inject({
      method: "POST",
      url: `/api/v1/channels/${textChannel.id}/invites`,
      headers: authHeader(owner.accessToken),
      payload: {},
    });
    const code = inviteResponse.json().code;
    await app.inject({ method: "POST", url: `/api/v1/invites/${code}`, headers: authHeader(member.accessToken) });

    const memberDelete = await app.inject({
      method: "DELETE",
      url: `/api/v1/guilds/${guild.id}`,
      headers: authHeader(member.accessToken),
    });
    expect(memberDelete.statusCode).toBe(403);

    const ownerDelete = await app.inject({
      method: "DELETE",
      url: `/api/v1/guilds/${guild.id}`,
      headers: authHeader(owner.accessToken),
    });
    expect(ownerDelete.statusCode).toBe(204);

    const getAfterDelete = await app.inject({
      method: "GET",
      url: `/api/v1/guilds/${guild.id}`,
      headers: authHeader(owner.accessToken),
    });
    expect(getAfterDelete.statusCode).toBe(404);

    const previewAfterDelete = await app.inject({
      method: "GET",
      url: `/api/v1/invites/${code}`,
      headers: authHeader(owner.accessToken),
    });
    expect(previewAfterDelete.statusCode).toBe(404);
  });

  it("moves a category's children to no parent when the category is deleted", async () => {
    const owner = await registerUser();
    const guild = (await createGuild(owner.accessToken)).json();
    const textCategory = guild.channels.find(
      (c: { type: string; name: string }) => c.type === "category" && c.name === "Text channels",
    );
    const generalChannel = guild.channels.find((c: { name: string }) => c.name === "general");

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/v1/channels/${textCategory.id}`,
      headers: authHeader(owner.accessToken),
    });
    expect(deleteResponse.statusCode).toBe(204);

    const refreshed = await app.inject({
      method: "GET",
      url: `/api/v1/guilds/${guild.id}`,
      headers: authHeader(owner.accessToken),
    });
    const refreshedGeneral = refreshed
      .json()
      .channels.find((c: { id: string }) => c.id === generalChannel.id);
    expect(refreshedGeneral.parentId).toBeNull();
  });
});
