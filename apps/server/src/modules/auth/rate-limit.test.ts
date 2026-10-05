// Proves the rate limiters are really wired up on the auth routes. Every
// other auth test file turns the limiter off, so it can make many
// requests without tripping it.
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { createFakeMailer } from "../../mailer.js";
import { createTestDb, describeWithDb, type TestDb } from "../../../test/db.js";
import { buildTestConfig, passwordFields, testAuthKey } from "../../../test/helpers.js";

let testDb: TestDb;
let app: FastifyInstance;
let proxiedApp: FastifyInstance;

describeWithDb("auth rate limits", () => {
  beforeAll(async () => {
    testDb = await createTestDb();
    app = await buildApp({ db: testDb.db, config: buildTestConfig(), mailer: createFakeMailer() });
    proxiedApp = await buildApp({
      db: testDb.db,
      config: buildTestConfig({ trustProxy: true }),
      mailer: createFakeMailer(),
    });
  });

  afterAll(async () => {
    await app.close();
    await proxiedApp.close();
    await testDb.close();
  });

  it("answers 429 after 10 login attempts in a minute", async () => {
    const attempt = () =>
      app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: "nobody@example.com", authKey: testAuthKey("wrong-password") },
      });

    const responses = [];
    for (let i = 0; i < 11; i += 1) {
      responses.push(await attempt());
    }

    expect(responses.slice(0, 10).every((response) => response.statusCode === 401)).toBe(true);
    expect(responses[10]!.statusCode).toBe(429);
    expect(responses[10]!.json().error.code).toBe("RATE_LIMITED");
  });

  it("locks one account after 10 failed logins from different IP addresses", async () => {
    const attempt = (email: string, remoteAddress: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        remoteAddress,
        payload: { email, authKey: testAuthKey("wrong-password") },
      });

    for (let i = 1; i <= 10; i += 1) {
      expect((await attempt("target@example.com", `198.51.100.${i}`)).statusCode).toBe(401);
    }
    const locked = await attempt("target@example.com", "198.51.100.50");
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe("RATE_LIMITED");

    // The lock is for that account only.
    expect((await attempt("other@example.com", "198.51.100.51")).statusCode).toBe(401);
  });

  it("reads the client address from the last X-Forwarded-For entry only", async () => {
    // Each request puts a new false address in front. The proxy address at the end stays the same.
    const attempt = (forwardedFor: string, i: number) =>
      proxiedApp.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { "x-forwarded-for": forwardedFor },
        payload: { email: `spoof-${i}@example.com`, authKey: testAuthKey("wrong-password") },
      });

    for (let i = 1; i <= 10; i += 1) {
      expect((await attempt(`192.0.2.${i}, 203.0.113.9`, i)).statusCode).toBe(401);
    }
    expect((await attempt("192.0.2.99, 203.0.113.9", 11)).statusCode).toBe(429);
    // A different client address (the last entry) has its own limit.
    const other = await attempt("203.0.113.9, 203.0.113.10", 12);
    expect(other.statusCode).toBe(401);
  });

  it("limits the verify-email and reset-password routes", async () => {
    for (const url of ["/api/v1/auth/verify-email", "/api/v1/auth/reset-password"]) {
      const attempt = () =>
        app.inject({
          method: "POST",
          url,
          remoteAddress: "198.51.100.200",
          payload: { token: "not-a-real-token", ...passwordFields("new-password-456") },
        });
      for (let i = 0; i < 10; i += 1) {
        expect((await attempt()).statusCode).toBe(400);
      }
      expect((await attempt()).statusCode).toBe(429);
    }
  });
});
