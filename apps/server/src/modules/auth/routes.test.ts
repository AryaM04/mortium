// Integration tests for the auth routes. They use a real Postgres database
// (see test/db.ts) and a fake mailer, and drive the app through app.inject.
import type { FastifyInstance } from "fastify";
import { hash } from "@node-rs/argon2";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { refreshTokens, users } from "../../db/schema.js";
import { nextId } from "../../id.js";
import { hashRefreshToken } from "./tokens.js";
import { createFakeMailer, type FakeMailer } from "../../mailer.js";
import { createTestDb, describeWithDb, type TestDb } from "../../../test/db.js";
import { TEST_KDF_SALT, buildTestConfig, passwordFields, testAuthKey } from "../../../test/helpers.js";

function extractToken(text: string): string {
  const match = /#token=([^\s]+)/.exec(text);
  const token = match?.[1];
  if (!token) {
    throw new Error(`Could not find a token in mail text: ${text}`);
  }
  return token;
}

let testDb: TestDb;
let app: FastifyInstance;
let mailer: FakeMailer;

async function register(email: string, username: string, password = "correct-password") {
  return app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, username, ...passwordFields(password) },
  });
}

/** A second salt, for a new password. */
const NEW_SALT = "bmV3LXNhbHQtZm9yLXRlcw";
/** A key wrap: 60 bytes as base64url. The server never reads it. */
const WRAP_DATA = "A".repeat(80);

function login(email: string, password: string) {
  return app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, authKey: testAuthKey(password) } });
}

function prelogin(email: string) {
  return app.inject({ method: "POST", url: "/api/v1/auth/prelogin", payload: { email } });
}

function authed(method: "GET" | "PUT" | "POST", url: string, accessToken: string, payload?: object) {
  return app.inject({ method, url, headers: { authorization: `Bearer ${accessToken}` }, payload });
}

/** An account from before the password keys: the hash is of the password itself. */
async function insertLegacyUser(email: string, username: string, password: string): Promise<void> {
  await testDb.db.insert(users).values({
    id: nextId(),
    username,
    displayName: username,
    email,
    passwordHash: await hash(password),
  });
}

describeWithDb("auth routes", () => {
  beforeAll(async () => {
    testDb = await createTestDb();
    mailer = createFakeMailer();
    app = await buildApp({ db: testDb.db, config: buildTestConfig(), mailer, rateLimit: false });
  });

  afterAll(async () => {
    await app.close();
    await testDb.close();
  });

  afterEach(() => {
    mailer.sent.length = 0;
  });

  it("registers a new user and returns tokens", async () => {
    const response = await register("alice@example.com", "alice");
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.user.username).toBe("alice");
    expect(body.user.email).toBe("alice@example.com");
    expect(body.user.emailVerified).toBe(false);
    expect(typeof body.deviceId).toBe("string");
    expect(typeof body.accessToken).toBe("string");
    expect(typeof body.refreshToken).toBe("string");
  });

  it("sends a verification email on register", async () => {
    await register("bob@example.com", "bob");
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe("bob@example.com");
    expect(mailer.sent[0]!.text).toContain("/verify-email#token=");
  });

  it("completes the sign-up when the mail server fails", async () => {
    const send = mailer.send;
    mailer.send = async () => {
      throw new Error("SMTP is not available");
    };
    try {
      const response = await register("mailfail@example.com", "mailfail");
      expect(response.statusCode).toBe(201);
      expect(response.json().user.username).toBe("mailfail");
    } finally {
      mailer.send = send;
    }
  });

  it("rejects a second registration with the same email as a conflict", async () => {
    await register("carol@example.com", "carol1");
    const response = await register("carol@example.com", "carol2");
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("EMAIL_TAKEN");
  });

  it("rejects a second registration with the same username as a conflict", async () => {
    await register("dave1@example.com", "dave");
    const response = await register("dave2@example.com", "dave");
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("USERNAME_TAKEN");
  });

  it("rejects a bad request body with INVALID_INPUT", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "not-an-email", username: "x", password: "short" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_INPUT");
  });

  it("logs a registered user in with the right password", async () => {
    await register("erin@example.com", "erin", "correct-password");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "erin@example.com", authKey: testAuthKey("correct-password") },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().user.username).toBe("erin");
  });

  it("rejects login with the wrong password", async () => {
    await register("frank@example.com", "frank", "correct-password");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "frank@example.com", authKey: testAuthKey("wrong-password") },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("INVALID_CREDENTIALS");
  });

  it("rejects login for an email that has no account, with the same error", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "nobody@example.com", authKey: testAuthKey("whatever-password") },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("INVALID_CREDENTIALS");
  });

  it("rotates the refresh token on a successful refresh", async () => {
    const registerResponse = await register("gina@example.com", "gina");
    const { refreshToken } = registerResponse.json();

    const refreshResponse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken },
    });
    expect(refreshResponse.statusCode).toBe(200);
    const body = refreshResponse.json();
    expect(body.refreshToken).not.toBe(refreshToken);
    expect(typeof body.accessToken).toBe("string");

    // A client can lose the reply and send the old token again. The old
    // token works for a short time and the device stays signed in.
    const retryResponse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken },
    });
    expect(retryResponse.statusCode).toBe(200);
    const nextResponse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: body.refreshToken },
    });
    expect(nextResponse.statusCode).toBe(200);

    // After the grace time, the old token is a theft alarm.
    await testDb.db
      .update(refreshTokens)
      .set({ revokedAt: new Date(Date.now() - 60_000) })
      .where(eq(refreshTokens.tokenHash, hashRefreshToken(refreshToken)));
    const reuseResponse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken },
    });
    expect(reuseResponse.statusCode).toBe(401);
    expect(reuseResponse.json().error.code).toBe("TOKEN_REUSED");
    const revokedResponse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: nextResponse.json().refreshToken },
    });
    expect(revokedResponse.statusCode).toBe(401);
  });

  it("lets two parallel refreshes with the same token both succeed", async () => {
    const registerResponse = await register("hank@example.com", "hank");
    const { refreshToken } = registerResponse.json();

    const [first, second] = await Promise.all([
      app.inject({ method: "POST", url: "/api/v1/auth/refresh", payload: { refreshToken } }),
      app.inject({ method: "POST", url: "/api/v1/auth/refresh", payload: { refreshToken } }),
    ]);

    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
  });

  it("rejects an unknown refresh token", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: "not-a-real-refresh-token" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("INVALID_REFRESH_TOKEN");
  });

  it("logs out and revokes the device's refresh token", async () => {
    const registerResponse = await register("iris@example.com", "iris");
    const { accessToken, refreshToken } = registerResponse.json();

    const logoutResponse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(logoutResponse.statusCode).toBe(204);

    const refreshResponse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken },
    });
    expect(refreshResponse.statusCode).toBe(401);
  });

  it("rejects logout without a bearer token", async () => {
    const response = await app.inject({ method: "POST", url: "/api/v1/auth/logout" });
    expect(response.statusCode).toBe(401);
  });

  it("verifies the email with the token from the mail, once", async () => {
    await register("jill@example.com", "jill");
    const token = extractToken(mailer.sent[0]!.text);

    const firstAttempt = await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify-email",
      payload: { token },
    });
    expect(firstAttempt.statusCode).toBe(204);

    const secondAttempt = await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify-email",
      payload: { token },
    });
    expect(secondAttempt.statusCode).toBe(400);
    expect(secondAttempt.json().error.code).toBe("INVALID_VERIFY_TOKEN");
  });

  it("rejects an unknown verification token", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify-email",
      payload: { token: "not-a-real-token" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_VERIFY_TOKEN");
  });

  it("resends a verification email for the signed-in user", async () => {
    const registerResponse = await register("kate@example.com", "kate");
    const { accessToken } = registerResponse.json();
    mailer.sent.length = 0;

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/resend-verification",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(response.statusCode).toBe(202);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe("kate@example.com");
  });

  it("always answers 202 for forgot-password, known or unknown email", async () => {
    await register("leo@example.com", "leo");

    mailer.sent.length = 0; // Registering already sent a verification mail.

    const known = await app.inject({
      method: "POST",
      url: "/api/v1/auth/forgot-password",
      payload: { email: "leo@example.com" },
    });
    const unknown = await app.inject({
      method: "POST",
      url: "/api/v1/auth/forgot-password",
      payload: { email: "no-such-user@example.com" },
    });

    expect(known.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe("leo@example.com");
  });

  it("resets the password, revokes old refresh tokens and removes the key wrap", async () => {
    const registerResponse = await register("mona@example.com", "mona", "old-password-123");
    const { refreshToken, accessToken } = registerResponse.json();
    const wrap = { version: 1, data: WRAP_DATA, kdfSalt: TEST_KDF_SALT };
    expect((await authed("PUT", "/api/v1/auth/key-wrap", accessToken, wrap)).statusCode).toBe(204);

    await app.inject({
      method: "POST",
      url: "/api/v1/auth/forgot-password",
      payload: { email: "mona@example.com" },
    });
    const resetToken = extractToken(mailer.sent.at(-1)!.text);

    const resetResponse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/reset-password",
      payload: { token: resetToken, ...passwordFields("new-password-456", NEW_SALT) },
    });
    expect(resetResponse.statusCode).toBe(204);
    expect((await prelogin("mona@example.com")).json().salt).toBe(NEW_SALT);

    // The refresh token from before the reset no longer works.
    const oldRefresh = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken },
    });
    expect(oldRefresh.statusCode).toBe(401);

    // The new password logs the user in; the old one does not.
    const loginNew = await login("mona@example.com", "new-password-456");
    expect(loginNew.statusCode).toBe(200);
    expect((await login("mona@example.com", "old-password-123")).statusCode).toBe(401);

    // The server cannot wrap the recovery key with the new password.
    const keyWrap = await authed("GET", "/api/v1/auth/key-wrap", loginNew.json().accessToken);
    expect(keyWrap.json()).toEqual({ keyWrap: null });
  });

  it("makes the other reset links of the user stop working after a reset", async () => {
    await register("olga@example.com", "olga", "old-password-123");
    const requestReset = () =>
      app.inject({ method: "POST", url: "/api/v1/auth/forgot-password", payload: { email: "olga@example.com" } });
    await requestReset();
    const firstToken = extractToken(mailer.sent.at(-1)!.text);
    await requestReset();
    const secondToken = extractToken(mailer.sent.at(-1)!.text);

    const reset = await app.inject({
      method: "POST",
      url: "/api/v1/auth/reset-password",
      payload: { token: secondToken, ...passwordFields("new-password-456") },
    });
    expect(reset.statusCode).toBe(204);

    const oldLink = await app.inject({
      method: "POST",
      url: "/api/v1/auth/reset-password",
      payload: { token: firstToken, ...passwordFields("attacker-password-789") },
    });
    expect(oldLink.statusCode).toBe(400);
    expect(oldLink.json().error.code).toBe("INVALID_RESET_TOKEN");
  });

  it("rejects reusing a reset-password token", async () => {
    await register("nate@example.com", "nate", "old-password-123");
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/forgot-password",
      payload: { email: "nate@example.com" },
    });
    const resetToken = extractToken(mailer.sent.at(-1)!.text);

    await app.inject({
      method: "POST",
      url: "/api/v1/auth/reset-password",
      payload: { token: resetToken, ...passwordFields("new-password-456") },
    });
    const secondAttempt = await app.inject({
      method: "POST",
      url: "/api/v1/auth/reset-password",
      payload: { token: resetToken, ...passwordFields("another-password-789") },
    });
    expect(secondAttempt.statusCode).toBe(400);
    expect(secondAttempt.json().error.code).toBe("INVALID_RESET_TOKEN");
  });

  it("gives the salt of an account, and a stable false salt for an unknown email", async () => {
    await register("pat@example.com", "pat");
    const real = await prelogin("pat@example.com");
    expect(real.statusCode).toBe(200);
    expect(real.json()).toEqual({ kdf: "argon2id-v1", salt: TEST_KDF_SALT, memoryKib: 65536, iterations: 3, parallelism: 1 });

    // An unknown email gets the same shape. The salt stays the same, so a second call does not show the difference.
    const unknown = (await prelogin("nobody-here@example.com")).json();
    expect(unknown).toMatchObject({ kdf: "argon2id-v1", memoryKib: 65536, iterations: 3, parallelism: 1 });
    expect(unknown.salt).toHaveLength(22);
    expect((await prelogin(" Nobody-Here@Example.com ")).json().salt).toBe(unknown.salt);
    expect((await prelogin("somebody-else@example.com")).json().salt).not.toBe(unknown.salt);
  });

  it("signs in a legacy account with the password, and changes it to the password key", async () => {
    await insertLegacyUser("quinn@example.com", "quinn", "legacy-password");
    expect((await prelogin("quinn@example.com")).json()).toEqual({ kdf: "legacy" });
    // A legacy account does not accept an auth key.
    expect((await login("quinn@example.com", "legacy-password")).statusCode).toBe(401);

    const legacyLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "quinn@example.com", password: "legacy-password" },
    });
    expect(legacyLogin.statusCode).toBe(200);
    const { accessToken } = legacyLogin.json();

    const upgrade = (password: string) =>
      authed("POST", "/api/v1/auth/password/upgrade", accessToken, { password, ...passwordFields("legacy-password", NEW_SALT) });
    expect((await upgrade("wrong-password")).json().error.code).toBe("INVALID_PASSWORD");
    expect((await upgrade("legacy-password")).statusCode).toBe(204);
    expect((await upgrade("legacy-password")).json().error.code).toBe("PASSWORD_KEY_EXISTS");

    expect((await prelogin("quinn@example.com")).json()).toMatchObject({ kdf: "argon2id-v1", salt: NEW_SALT });
    expect((await login("quinn@example.com", "legacy-password")).statusCode).toBe(200);
    // The password itself does not work any more.
    const raw = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "quinn@example.com", password: "legacy-password" },
    });
    expect(raw.statusCode).toBe(401);
  });

  it("stores the key wrap only for the salt of the current password", async () => {
    const { accessToken } = (await register("rita@example.com", "rita")).json();
    expect((await authed("GET", "/api/v1/auth/key-wrap", accessToken)).json()).toEqual({ keyWrap: null });

    const stale = await authed("PUT", "/api/v1/auth/key-wrap", accessToken, { version: 2, data: WRAP_DATA, kdfSalt: NEW_SALT });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("PASSWORD_CHANGED");

    const put = await authed("PUT", "/api/v1/auth/key-wrap", accessToken, { version: 2, data: WRAP_DATA, kdfSalt: TEST_KDF_SALT });
    expect(put.statusCode).toBe(204);
    expect((await authed("GET", "/api/v1/auth/key-wrap", accessToken)).json()).toEqual({ keyWrap: { version: 2, data: WRAP_DATA } });
  });

  it("changes the password with the current auth key, and keeps the other sessions", async () => {
    const first = (await register("sam@example.com", "sam", "old-password-123")).json();
    const second = (await login("sam@example.com", "old-password-123")).json();
    const newWrap = { version: 3, data: "B".repeat(80) };
    const change = (currentPassword: string) =>
      authed("POST", "/api/v1/auth/password/change", second.accessToken, {
        currentAuthKey: testAuthKey(currentPassword),
        ...passwordFields("new-password-456", NEW_SALT),
        keyWrap: newWrap,
      });

    const wrong = await change("not-the-password");
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe("INVALID_PASSWORD");
    expect((await change("old-password-123")).statusCode).toBe(204);

    expect((await login("sam@example.com", "old-password-123")).statusCode).toBe(401);
    expect((await login("sam@example.com", "new-password-456")).statusCode).toBe(200);
    expect((await prelogin("sam@example.com")).json().salt).toBe(NEW_SALT);
    expect((await authed("GET", "/api/v1/auth/key-wrap", second.accessToken)).json()).toEqual({ keyWrap: newWrap });

    // The first session is still signed in.
    const refresh = await app.inject({ method: "POST", url: "/api/v1/auth/refresh", payload: { refreshToken: first.refreshToken } });
    expect(refresh.statusCode).toBe(200);
  });

  it("lists no OAuth providers when none are configured", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/auth/providers" });
    expect(response.statusCode).toBe(200);
    expect(response.json().providers).toEqual([]);
  });

  it("rejects an unknown or already-used OAuth exchange code", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/oauth/exchange",
      payload: { code: "not-a-real-code" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("INVALID_OAUTH_CODE");
  });
});
