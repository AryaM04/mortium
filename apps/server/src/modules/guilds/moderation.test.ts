// Integration tests for kick, ban, unban, voice moderation and owner
// transfer. Real Postgres, driven through app.inject (see test/db.ts).
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { encodeBase64Url, encodePlainPayload, Permission } from "@mortium/shared";
import { buildApp } from "../../app.js";
import { events } from "../../db/schema.js";
import { createFakeMailer } from "../../mailer.js";
import { createTestDb, describeWithDb, type TestDb } from "../../../test/db.js";
import { buildTestConfig, mkTempDataDir } from "../../../test/helpers.js";

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
    payload: { email: `mod-user${userCounter}@example.com`, username: `moduser${userCounter}`, password: "correct-password" },
  });
  const body = response.json() as { accessToken: string; deviceId: string; user: { id: string } };
  return { accessToken: body.accessToken, deviceId: body.deviceId, userId: body.user.id };
}

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function createGuild(token: string, name = "Mod Guild") {
  const response = await app.inject({ method: "POST", url: "/api/v1/guilds", headers: authHeader(token), payload: { name } });
  return response.json() as { id: string; channels: Array<{ id: string; type: string }> };
}

function textChannelOf(guild: { channels: Array<{ id: string; type: string }> }): string {
  return guild.channels.find((c) => c.type === "text")!.id;
}

async function joinGuild(ownerToken: string, guildId: string, textChannelId: string, token: string) {
  const invite = await app.inject({
    method: "POST",
    url: `/api/v1/channels/${textChannelId}/invites`,
    headers: authHeader(ownerToken),
    payload: {},
  });
  const code = invite.json().code;
  await app.inject({ method: "POST", url: `/api/v1/invites/${code}`, headers: authHeader(token) });
}

async function grantRole(ownerToken: string, guildId: string, userId: string, permissions: bigint) {
  const role = (
    await app.inject({
      method: "POST",
      url: `/api/v1/guilds/${guildId}/roles`,
      headers: authHeader(ownerToken),
      payload: { name: "Perm", permissions: permissions.toString() },
    })
  ).json();
  await app.inject({
    method: "PUT",
    url: `/api/v1/guilds/${guildId}/members/${userId}/roles/${role.id}`,
    headers: authHeader(ownerToken),
  });
  return role;
}

describeWithDb("kick, ban, unban, voice moderation and ownership transfer", () => {
  beforeAll(async () => {
    testDb = await createTestDb();
    const dataDir = await mkTempDataDir();
    app = await buildApp({ db: testDb.db, config: buildTestConfig({ dataDir }), mailer: createFakeMailer(), rateLimit: false });
  });

  afterAll(async () => {
    await app.close();
    await testDb.close();
  });

  it("kicks a member with KICK_MEMBERS, and rejects a lower-hierarchy kicker", async () => {
    const owner = await registerUser();
    const kicker = await registerUser();
    const target = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const textChannel = textChannelOf(guild);
    await joinGuild(owner.accessToken, guild.id, textChannel, kicker.accessToken);
    await joinGuild(owner.accessToken, guild.id, textChannel, target.accessToken);

    const withoutPermission = await app.inject({
      method: "DELETE",
      url: `/api/v1/guilds/${guild.id}/members/${target.userId}`,
      headers: authHeader(kicker.accessToken),
    });
    expect(withoutPermission.statusCode).toBe(403);

    await grantRole(owner.accessToken, guild.id, kicker.userId, Permission.KICK_MEMBERS);

    const kicked = await app.inject({
      method: "DELETE",
      url: `/api/v1/guilds/${guild.id}/members/${target.userId}`,
      headers: authHeader(kicker.accessToken),
    });
    expect(kicked.statusCode).toBe(204);

    const gone = await app.inject({
      method: "GET",
      url: `/api/v1/guilds/${guild.id}`,
      headers: authHeader(target.accessToken),
    });
    expect(gone.statusCode).toBe(404);
  });

  it("nobody can kick or ban the guild owner", async () => {
    const owner = await registerUser();
    const admin = await registerUser();
    const guild = await createGuild(owner.accessToken);
    await joinGuild(owner.accessToken, guild.id, textChannelOf(guild), admin.accessToken);
    await grantRole(owner.accessToken, guild.id, admin.userId, Permission.ADMINISTRATOR | Permission.KICK_MEMBERS | Permission.BAN_MEMBERS);

    const kick = await app.inject({
      method: "DELETE",
      url: `/api/v1/guilds/${guild.id}/members/${owner.userId}`,
      headers: authHeader(admin.accessToken),
    });
    expect(kick.statusCode).toBe(403);

    const ban = await app.inject({
      method: "PUT",
      url: `/api/v1/guilds/${guild.id}/bans/${owner.userId}`,
      headers: authHeader(admin.accessToken),
      payload: {},
    });
    expect(ban.statusCode).toBe(403);
  });

  it("bans a member with BAN_MEMBERS, redacts recent events, and blocks rejoin", async () => {
    const owner = await registerUser();
    const target = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const textChannel = textChannelOf(guild);
    await joinGuild(owner.accessToken, guild.id, textChannel, target.accessToken);

    const ciphertext = encodeBase64Url(
      encodePlainPayload({ type: "message", body: "hello", mentions: [], attachments: [], embeds: [] }),
    );
    const posted = await app.inject({
      method: "POST",
      url: `/api/v1/channels/${textChannel}/events`,
      headers: authHeader(target.accessToken),
      payload: { codec: "megolm-v1", megolmSessionId: "test-session", ciphertext, nonce: "ban-test-1" },
    });
    expect(posted.statusCode).toBe(201);
    const eventId = posted.json().id;

    const invite = (
      await app.inject({
        method: "POST",
        url: `/api/v1/channels/${textChannel}/invites`,
        headers: authHeader(owner.accessToken),
        payload: {},
      })
    ).json();

    const ban = await app.inject({
      method: "PUT",
      url: `/api/v1/guilds/${guild.id}/bans/${target.userId}`,
      headers: authHeader(owner.accessToken),
      payload: { reason: "spam", deleteMessageSeconds: 3600 },
    });
    expect(ban.statusCode).toBe(204);

    const [row] = await testDb.db.select().from(events).where(eq(events.id, BigInt(eventId)));
    expect(row?.redactedAt).not.toBeNull();
    expect(row?.ciphertext.length).toBe(0);

    const rejoin = await app.inject({ method: "POST", url: `/api/v1/invites/${invite.code}`, headers: authHeader(target.accessToken) });
    expect(rejoin.statusCode).toBe(403);
    expect(rejoin.json().error.code).toBe("BANNED");

    const listed = await app.inject({ method: "GET", url: `/api/v1/guilds/${guild.id}/bans`, headers: authHeader(owner.accessToken) });
    expect(listed.json().bans).toHaveLength(1);
    expect(listed.json().bans[0].userId).toBe(target.userId);

    const unban = await app.inject({
      method: "DELETE",
      url: `/api/v1/guilds/${guild.id}/bans/${target.userId}`,
      headers: authHeader(owner.accessToken),
    });
    expect(unban.statusCode).toBe(204);

    const rejoinAfterUnban = await app.inject({
      method: "POST",
      url: `/api/v1/invites/${invite.code}`,
      headers: authHeader(target.accessToken),
    });
    expect(rejoinAfterUnban.statusCode).toBe(200);
  });

  it("does not redact anything when deleteMessageSeconds is 0", async () => {
    const owner = await registerUser();
    const target = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const textChannel = textChannelOf(guild);
    await joinGuild(owner.accessToken, guild.id, textChannel, target.accessToken);
    const ciphertext = encodeBase64Url(
      encodePlainPayload({ type: "message", body: "keep me", mentions: [], attachments: [], embeds: [] }),
    );
    const posted = await app.inject({
      method: "POST",
      url: `/api/v1/channels/${textChannel}/events`,
      headers: authHeader(target.accessToken),
      payload: { codec: "megolm-v1", megolmSessionId: "test-session", ciphertext, nonce: "ban-test-2" },
    });
    const eventId = posted.json().id;

    await app.inject({
      method: "PUT",
      url: `/api/v1/guilds/${guild.id}/bans/${target.userId}`,
      headers: authHeader(owner.accessToken),
      payload: {},
    });

    const [row] = await testDb.db.select().from(events).where(eq(events.id, BigInt(eventId)));
    expect(row?.redactedAt).toBeNull();
  });

  it("owner transfer moves ownership and only the owner may call it", async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const guild = await createGuild(owner.accessToken);
    await joinGuild(owner.accessToken, guild.id, textChannelOf(guild), member.accessToken);

    const deniedForMember = await app.inject({
      method: "POST",
      url: `/api/v1/guilds/${guild.id}/transfer`,
      headers: authHeader(member.accessToken),
      payload: { userId: member.userId },
    });
    expect(deniedForMember.statusCode).toBe(403);

    const transfer = await app.inject({
      method: "POST",
      url: `/api/v1/guilds/${guild.id}/transfer`,
      headers: authHeader(owner.accessToken),
      payload: { userId: member.userId },
    });
    expect(transfer.statusCode).toBe(204);

    const view = await app.inject({ method: "GET", url: `/api/v1/guilds/${guild.id}`, headers: authHeader(member.accessToken) });
    expect(view.json().ownerId).toBe(member.userId);
  });
});
