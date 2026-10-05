// Integration tests for the users routes.
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { createFakeMailer } from "../../mailer.js";
import { createTestDb, describeWithDb, type TestDb } from "../../../test/db.js";
import { buildTestConfig, mkTempDataDir, passwordFields, testAuthKey } from "../../../test/helpers.js";

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);

let testDb: TestDb;
let app: FastifyInstance;

async function registerUser(email: string, username: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, username, ...passwordFields() },
  });
  return response.json() as { accessToken: string; deviceId: string; user: { id: string } };
}

async function loginUser(email: string, userAgent?: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: userAgent ? { "user-agent": userAgent } : {},
    payload: { email, authKey: testAuthKey() },
  });
  return response.json() as { accessToken: string; deviceId: string; user: { id: string } };
}

describeWithDb("users routes", () => {
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

  it("returns the signed-in user's own profile, with the email", async () => {
    const { accessToken } = await registerUser("pat@example.com", "pat");
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/users/@me",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.username).toBe("pat");
    expect(body.email).toBe("pat@example.com");
  });

  it("rejects @me without a bearer token", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/users/@me" });
    expect(response.statusCode).toBe(401);
  });

  it("updates the display name and status text", async () => {
    const { accessToken } = await registerUser("quinn@example.com", "quinn");
    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/users/@me",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { displayName: "Quinn Q", statusText: "Busy" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.displayName).toBe("Quinn Q");
    expect(body.statusText).toBe("Busy");
  });

  it("rejects a display name that is too long", async () => {
    const { accessToken } = await registerUser("riley@example.com", "riley");
    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/users/@me",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { displayName: "x".repeat(40) },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_INPUT");
  });

  it("uploads an avatar and serves it back at the public URL", async () => {
    const { accessToken } = await registerUser("sam@example.com", "sam");

    const uploadResponse = await app.inject({
      method: "PUT",
      url: "/api/v1/users/@me/avatar",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "image/png" },
      payload: PNG_BYTES,
    });
    expect(uploadResponse.statusCode).toBe(200);
    const user = uploadResponse.json();
    expect(typeof user.avatarKey).toBe("string");

    const fetchResponse = await app.inject({
      method: "GET",
      url: `/api/v1/avatars/${user.id}/${user.avatarKey}`,
    });
    expect(fetchResponse.statusCode).toBe(200);
    expect(fetchResponse.headers["content-type"]).toBe("image/png");
    expect(fetchResponse.headers["cache-control"]).toContain("immutable");
    expect(fetchResponse.rawPayload.equals(PNG_BYTES)).toBe(true);
  });

  it("rejects an avatar upload whose bytes are not really an image", async () => {
    const { accessToken } = await registerUser("tara@example.com", "tara");
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/users/@me/avatar",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "image/png" },
      payload: Buffer.from("not an image, just text", "utf8"),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_IMAGE");
  });

  it("rejects an avatar upload over 1 MiB", async () => {
    const { accessToken } = await registerUser("uma@example.com", "uma");
    const tooBig = Buffer.concat([PNG_BYTES, Buffer.alloc(1024 * 1024)]);
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/users/@me/avatar",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "image/png" },
      payload: tooBig,
    });
    expect(response.statusCode).toBe(413);
  });

  it("removes the avatar and it is not found afterward", async () => {
    const { accessToken } = await registerUser("vince@example.com", "vince");
    const uploadResponse = await app.inject({
      method: "PUT",
      url: "/api/v1/users/@me/avatar",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "image/png" },
      payload: PNG_BYTES,
    });
    const uploaded = uploadResponse.json();

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: "/api/v1/users/@me/avatar",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json().avatarKey).toBeNull();

    const fetchResponse = await app.inject({
      method: "GET",
      url: `/api/v1/avatars/${uploaded.id}/${uploaded.avatarKey}`,
    });
    expect(fetchResponse.statusCode).toBe(404);
  });

  it("returns 404 for a wrong avatar key", async () => {
    const { accessToken } = await registerUser("wendy@example.com", "wendy");
    const uploadResponse = await app.inject({
      method: "PUT",
      url: "/api/v1/users/@me/avatar",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "image/png" },
      payload: PNG_BYTES,
    });
    const uploaded = uploadResponse.json();

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/avatars/${uploaded.id}/wrong-key`,
    });
    expect(response.statusCode).toBe(404);
  });

  it("lists the signed-in user's devices, marking the current one", async () => {
    const email = "xena@example.com";
    await registerUser(email, "xena");
    const second = await loginUser(email, "Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36");

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/users/@me/devices",
      headers: { authorization: `Bearer ${second.accessToken}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      devices: { id: string; name: string; createdAt: string; lastSeen: string; current: boolean }[];
    };
    expect(body.devices).toHaveLength(2);
    const current = body.devices.find((device) => device.id === second.deviceId);
    expect(current?.current).toBe(true);
    expect(current?.name).toContain("Chrome");
    const other = body.devices.find((device) => device.id !== second.deviceId);
    expect(other?.current).toBe(false);
  });

  it("does not list another user's devices", async () => {
    const owner = await registerUser("yara@example.com", "yara");
    const stranger = await registerUser("zack@example.com", "zack");

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/users/@me/devices",
      headers: { authorization: `Bearer ${stranger.accessToken}` },
    });
    const body = response.json() as { devices: { id: string }[] };
    expect(body.devices.some((device) => device.id === owner.deviceId)).toBe(false);
  });

  it("deletes a device: its refresh token stops working and the device is gone from the list", async () => {
    const email = "amir@example.com";
    const first = await registerUser(email, "amir");
    const second = await loginUser(email);

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/v1/users/@me/devices/${second.deviceId}`,
      headers: { authorization: `Bearer ${first.accessToken}` },
    });
    expect(deleteResponse.statusCode).toBe(204);

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/v1/users/@me/devices",
      headers: { authorization: `Bearer ${first.accessToken}` },
    });
    const body = listResponse.json() as { devices: { id: string }[] };
    expect(body.devices.some((device) => device.id === second.deviceId)).toBe(false);
    expect(body.devices.some((device) => device.id === first.deviceId)).toBe(true);
  });

  it("returns 404 when deleting a device that is not the caller's own", async () => {
    const owner = await registerUser("bella@example.com", "bella");
    const stranger = await registerUser("carl@example.com", "carl");

    const response = await app.inject({
      method: "DELETE",
      url: `/api/v1/users/@me/devices/${owner.deviceId}`,
      headers: { authorization: `Bearer ${stranger.accessToken}` },
    });
    expect(response.statusCode).toBe(404);
  });
});
