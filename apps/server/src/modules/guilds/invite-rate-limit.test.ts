// Proves the per-user limit on the invite lookup and join routes. The
// limit stops a search for valid invite codes.
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { createFakeMailer } from "../../mailer.js";
import { createTestDb, describeWithDb, type TestDb } from "../../../test/db.js";
import { buildTestConfig, passwordFields } from "../../../test/helpers.js";

let testDb: TestDb;
let app: FastifyInstance;

describeWithDb("invite rate limit", () => {
  beforeAll(async () => {
    testDb = await createTestDb();
    app = await buildApp({ db: testDb.db, config: buildTestConfig(), mailer: createFakeMailer(), rateLimit: false });
  });

  afterAll(async () => {
    await app.close();
    await testDb.close();
  });

  it("answers 429 after 30 invite lookups in a minute", async () => {
    const registered = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "guesser@example.com", username: "guesser", ...passwordFields("password-123") },
    });
    const headers = { authorization: `Bearer ${registered.json().accessToken}` };

    for (let i = 0; i < 30; i += 1) {
      const method = i % 2 === 0 ? "GET" : "POST";
      const response = await app.inject({ method, url: `/api/v1/invites/guess${i}`, headers });
      expect(response.statusCode).toBe(404);
    }
    const limited = await app.inject({ method: "GET", url: "/api/v1/invites/guess-last", headers });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("RATE_LIMITED");
  });
});
