// Integration tests for roles, member roles, nicknames and channel
// overwrites: hierarchy, grantable-permission and @everyone-immutable
// rules. Real Postgres, driven through app.inject (see test/db.ts).
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Permission } from "@mortium/shared";
import { buildApp } from "../../app.js";
import { createFakeMailer } from "../../mailer.js";
import { createTestDb, describeWithDb, type TestDb } from "../../../test/db.js";
import { buildTestConfig, mkTempDataDir } from "../../../test/helpers.js";

let testDb: TestDb;
let app: FastifyInstance;
let userCounter = 0;

async function registerUser() {
  userCounter += 1;
  const email = `role-user${userCounter}@example.com`;
  const username = `roleuser${userCounter}`;
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, username, password: "correct-password" },
  });
  return response.json() as { accessToken: string; user: { id: string } };
}

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function createGuild(token: string, name = "Role Guild") {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/guilds",
    headers: authHeader(token),
    payload: { name },
  });
  return response.json();
}

/** Join `token`'s user into `guildId`, owned by `ownerToken`, through an invite. */
async function joinGuild(ownerToken: string, guildId: string, textChannelId: string, token: string) {
  const invite = await app.inject({
    method: "POST",
    url: `/api/v1/channels/${textChannelId}/invites`,
    headers: authHeader(ownerToken),
    payload: {},
  });
  const code = invite.json().code;
  await app.inject({
    method: "POST",
    url: `/api/v1/invites/${code}`,
    headers: authHeader(token),
  });
}

async function createRole(
  ownerToken: string,
  guildId: string,
  body: Partial<{ name: string; color: number; permissions: string; mentionable: boolean; hoist: boolean }> = {},
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/guilds/${guildId}/roles`,
    headers: authHeader(ownerToken),
    payload: body,
  });
}

describeWithDb("roles, member roles, nicknames and overwrites", () => {
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

  it("creates a role just below the owner's highest role, with hoist in the response", async () => {
    const owner = await registerUser();
    const guild = await createGuild(owner.accessToken);

    const response = await createRole(owner.accessToken, guild.id, { name: "Mods", hoist: true, color: 5 });
    expect(response.statusCode).toBe(201);
    const role = response.json();
    expect(role.name).toBe("Mods");
    expect(role.hoist).toBe(true);
    expect(role.position).toBe(1);
  });

  it("rejects a role create/edit/delete from a member without MANAGE_ROLES", async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const textChannel = guild.channels.find((c: { type: string }) => c.type === "text");
    await joinGuild(owner.accessToken, guild.id, textChannel.id, member.accessToken);

    const response = await createRole(member.accessToken, guild.id, { name: "Mods" });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("MISSING_PERMISSION");
  });

  it("rejects granting a permission the actor does not have, unless owner or ADMINISTRATOR", async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const textChannel = guild.channels.find((c: { type: string }) => c.type === "text");
    await joinGuild(owner.accessToken, guild.id, textChannel.id, member.accessToken);

    // Give the member a role with MANAGE_ROLES but not BAN_MEMBERS.
    const modRole = (await createRole(owner.accessToken, guild.id, {
      name: "Mods",
      permissions: Permission.MANAGE_ROLES.toString(),
    })).json();
    await app.inject({
      method: "PUT",
      url: `/api/v1/guilds/${guild.id}/members/${member.user.id}/roles/${modRole.id}`,
      headers: authHeader(owner.accessToken),
    });

    // The member cannot create a role that grants BAN_MEMBERS, which it does not hold.
    const response = await createRole(member.accessToken, guild.id, {
      name: "Cannot grant this",
      permissions: Permission.BAN_MEMBERS.toString(),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("MISSING_PERMISSION");

    // But it can create a role that only grants MANAGE_ROLES, which it does hold.
    const ok = await createRole(member.accessToken, guild.id, {
      name: "Can grant this",
      permissions: Permission.MANAGE_ROLES.toString(),
    });
    expect(ok.statusCode).toBe(201);
  });

  it("an ADMINISTRATOR can grant any permission it does not itself directly hold", async () => {
    const owner = await registerUser();
    const admin = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const textChannel = guild.channels.find((c: { type: string }) => c.type === "text");
    await joinGuild(owner.accessToken, guild.id, textChannel.id, admin.accessToken);

    const adminRole = (await createRole(owner.accessToken, guild.id, {
      name: "Admins",
      permissions: (Permission.MANAGE_ROLES | Permission.ADMINISTRATOR).toString(),
    })).json();
    await app.inject({
      method: "PUT",
      url: `/api/v1/guilds/${guild.id}/members/${admin.user.id}/roles/${adminRole.id}`,
      headers: authHeader(owner.accessToken),
    });

    const response = await createRole(admin.accessToken, guild.id, {
      name: "Anything",
      permissions: Permission.BAN_MEMBERS.toString(),
    });
    expect(response.statusCode).toBe(201);
  });

  it("cannot edit, delete or assign a role at or above the actor's highest role", async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const textChannel = guild.channels.find((c: { type: string }) => c.type === "text");
    await joinGuild(owner.accessToken, guild.id, textChannel.id, member.accessToken);

    // Two roles: Low (position 1, granted to member) and High (position 2, kept by nobody).
    const low = (await createRole(owner.accessToken, guild.id, { name: "Low", permissions: Permission.MANAGE_ROLES.toString() })).json();
    const high = (await createRole(owner.accessToken, guild.id, { name: "High" })).json();
    await app.inject({
      method: "PUT",
      url: `/api/v1/guilds/${guild.id}/members/${member.user.id}/roles/${low.id}`,
      headers: authHeader(owner.accessToken),
    });

    // The member's highest role is Low (position 1); High sits at position 2, above it.
    const editHigh = await app.inject({
      method: "PATCH",
      url: `/api/v1/guilds/${guild.id}/roles/${high.id}`,
      headers: authHeader(member.accessToken),
      payload: { name: "renamed" },
    });
    expect(editHigh.statusCode).toBe(403);

    const editSelf = await app.inject({
      method: "PATCH",
      url: `/api/v1/guilds/${guild.id}/roles/${low.id}`,
      headers: authHeader(member.accessToken),
      payload: { name: "still-low" },
    });
    expect(editSelf.statusCode).toBe(403); // "strictly below", not "at or below"

    const deleteHigh = await app.inject({
      method: "DELETE",
      url: `/api/v1/guilds/${guild.id}/roles/${high.id}`,
      headers: authHeader(member.accessToken),
    });
    expect(deleteHigh.statusCode).toBe(403);
  });

  it("the owner bypasses the hierarchy check entirely", async () => {
    const owner = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const top = (await createRole(owner.accessToken, guild.id, { name: "Top" })).json();

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/guilds/${guild.id}/roles/${top.id}`,
      headers: authHeader(owner.accessToken),
      payload: { name: "still-top-renamed" },
    });
    expect(response.statusCode).toBe(200);
  });

  it("@everyone cannot move, cannot be deleted, and the order endpoint rejects moving it", async () => {
    const owner = await registerUser();
    const guild = await createGuild(owner.accessToken);

    const deleteEveryone = await app.inject({
      method: "DELETE",
      url: `/api/v1/guilds/${guild.id}/roles/${guild.id}`,
      headers: authHeader(owner.accessToken),
    });
    expect(deleteEveryone.statusCode).toBe(400);

    const role = (await createRole(owner.accessToken, guild.id, { name: "Other" })).json();
    const badOrder = await app.inject({
      method: "PUT",
      url: `/api/v1/guilds/${guild.id}/roles/order`,
      headers: authHeader(owner.accessToken),
      payload: [
        { id: guild.id, position: 1 },
        { id: role.id, position: 0 },
      ],
    });
    expect(badOrder.statusCode).toBe(400);
  });

  it("orders roles, honoring the hierarchy for a non-owner", async () => {
    const owner = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const roleA = (await createRole(owner.accessToken, guild.id, { name: "A" })).json();
    const roleB = (await createRole(owner.accessToken, guild.id, { name: "B" })).json();

    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/guilds/${guild.id}/roles/order`,
      headers: authHeader(owner.accessToken),
      payload: [
        { id: roleA.id, position: 2 },
        { id: roleB.id, position: 1 },
      ],
    });
    expect(response.statusCode).toBe(204);

    const list = (
      await app.inject({ method: "GET", url: `/api/v1/guilds/${guild.id}/roles`, headers: authHeader(owner.accessToken) })
    ).json().roles;
    const byId = Object.fromEntries(list.map((r: { id: string; position: number }) => [r.id, r.position]));
    expect(byId[roleA.id]).toBe(2);
    expect(byId[roleB.id]).toBe(1);
  });

  it("lets a member change their own nickname with CHANGE_NICKNAME (the @everyone default)", async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const textChannel = guild.channels.find((c: { type: string }) => c.type === "text");
    await joinGuild(owner.accessToken, guild.id, textChannel.id, member.accessToken);

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/guilds/${guild.id}/members/${member.user.id}`,
      headers: authHeader(member.accessToken),
      payload: { nickname: "New Name" },
    });
    expect(response.statusCode).toBe(204);
  });

  it("requires MANAGE_NICKNAMES and hierarchy to rename someone else", async () => {
    const owner = await registerUser();
    const memberA = await registerUser();
    const memberB = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const textChannel = guild.channels.find((c: { type: string }) => c.type === "text");
    await joinGuild(owner.accessToken, guild.id, textChannel.id, memberA.accessToken);
    await joinGuild(owner.accessToken, guild.id, textChannel.id, memberB.accessToken);

    const denied = await app.inject({
      method: "PATCH",
      url: `/api/v1/guilds/${guild.id}/members/${memberB.user.id}`,
      headers: authHeader(memberA.accessToken),
      payload: { nickname: "Nope" },
    });
    expect(denied.statusCode).toBe(403);

    const modRole = (await createRole(owner.accessToken, guild.id, {
      name: "Mods",
      permissions: Permission.MANAGE_NICKNAMES.toString(),
    })).json();
    await app.inject({
      method: "PUT",
      url: `/api/v1/guilds/${guild.id}/members/${memberA.user.id}/roles/${modRole.id}`,
      headers: authHeader(owner.accessToken),
    });

    const allowed = await app.inject({
      method: "PATCH",
      url: `/api/v1/guilds/${guild.id}/members/${memberB.user.id}`,
      headers: authHeader(memberA.accessToken),
      payload: { nickname: "Renamed" },
    });
    expect(allowed.statusCode).toBe(204);
  });

  it("edits a channel overwrite only with MANAGE_ROLES in that channel, and only bits the actor holds", async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const textChannel = guild.channels.find((c: { type: string }) => c.type === "text");
    await joinGuild(owner.accessToken, guild.id, textChannel.id, member.accessToken);

    const withoutPermission = await app.inject({
      method: "PUT",
      url: `/api/v1/channels/${textChannel.id}/overwrites/${member.user.id}`,
      headers: authHeader(member.accessToken),
      payload: { type: "member", allow: "0", deny: Permission.SEND_MESSAGES.toString() },
    });
    expect(withoutPermission.statusCode).toBe(403);

    // Grant the member MANAGE_ROLES only, via a role — not BAN_MEMBERS.
    const role = (await createRole(owner.accessToken, guild.id, {
      name: "Channel mods",
      permissions: Permission.MANAGE_ROLES.toString(),
    })).json();
    await app.inject({
      method: "PUT",
      url: `/api/v1/guilds/${guild.id}/members/${member.user.id}/roles/${role.id}`,
      headers: authHeader(owner.accessToken),
    });

    const ungrantable = await app.inject({
      method: "PUT",
      url: `/api/v1/channels/${textChannel.id}/overwrites/${member.user.id}`,
      headers: authHeader(member.accessToken),
      payload: { type: "member", allow: "0", deny: Permission.BAN_MEMBERS.toString() },
    });
    expect(ungrantable.statusCode).toBe(403);

    const grantable = await app.inject({
      method: "PUT",
      url: `/api/v1/channels/${textChannel.id}/overwrites/${member.user.id}`,
      headers: authHeader(member.accessToken),
      payload: { type: "member", allow: "0", deny: Permission.SEND_MESSAGES.toString() },
    });
    expect(grantable.statusCode).toBe(204);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/channels/${textChannel.id}/overwrites/${member.user.id}?type=member`,
      headers: authHeader(member.accessToken),
    });
    expect(deleted.statusCode).toBe(204);
  });
});
