// Integration tests for the OAuth redirect flow of the web app and of the
// desktop app. A fake `fetch` stands in for GitHub, so the tests do not use
// the network.
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { buildApp } from "../../app.js";
import { createFakeMailer } from "../../mailer.js";
import { createTestDb, describeWithDb, type TestDb } from "../../../test/db.js";
import { buildTestConfig } from "../../../test/helpers.js";
import { oauthReturnUrl } from "./routes.js";

let testDb: TestDb;
let app: FastifyInstance;
let githubUserId = 5000;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/** A fake GitHub: the token endpoint, the user profile and the email list. */
function stubGitHub(): void {
  githubUserId += 1;
  const id = githubUserId;
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://github.com/login/oauth/access_token")) {
      return jsonResponse({ access_token: "fake-token", token_type: "bearer", scope: "read:user,user:email" });
    }
    if (url === "https://api.github.com/user") {
      return jsonResponse({ id, login: `octo${id}`, name: null });
    }
    if (url === "https://api.github.com/user/emails") {
      return jsonResponse([{ email: `octo${id}@example.com`, primary: true, verified: true }]);
    }
    throw new Error("The test did not expect this request.");
  });
}

/** Start a sign-in. Return the state from the provider URL and the signed flow cookie. */
async function startFlow(query: string): Promise<{ state: string; cookie: string }> {
  const response = await app.inject({ method: "GET", url: `/api/v1/auth/oauth/github/start${query}` });
  expect(response.statusCode).toBe(302);
  const location = new URL(String(response.headers.location));
  expect(location.origin).toBe("https://github.com");
  const cookie = response.cookies.find((entry) => entry.name === "oauth_flow");
  expect(cookie).toBeDefined();
  return { state: location.searchParams.get("state") ?? "", cookie: cookie!.value };
}

async function callback(state: string, cookie: string): Promise<string> {
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/auth/oauth/github/callback?code=provider-code&state=${encodeURIComponent(state)}`,
    cookies: { oauth_flow: cookie },
  });
  expect(response.statusCode).toBe(302);
  return String(response.headers.location);
}

async function exchange(location: string): Promise<number> {
  const code = /#code=([^&]+)/.exec(location)?.[1] ?? "";
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/oauth/exchange", payload: { code } });
  return response.statusCode;
}

describeWithDb("OAuth redirect flow", () => {
  beforeAll(async () => {
    testDb = await createTestDb();
    app = await buildApp({
      db: testDb.db,
      config: buildTestConfig({ oauth: { github: { clientId: "client-id", clientSecret: "client-secret" } } }),
      mailer: createFakeMailer(),
      rateLimit: false,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await app.close();
    await testDb.close();
  });

  it("builds the return URL for each app", () => {
    const config = { webOrigin: "https://chat.example.com", desktopUrlScheme: "mortium" };
    expect(oauthReturnUrl(config, undefined)).toBe("https://chat.example.com/auth/callback");
    expect(oauthReturnUrl(config, "web")).toBe("https://chat.example.com/auth/callback");
    expect(oauthReturnUrl(config, "desktop")).toBe("mortium://auth/callback");
  });

  it("sends the web app back to its own origin with a code", async () => {
    const { state, cookie } = await startFlow("");
    stubGitHub();
    const location = await callback(state, cookie);
    expect(location).toMatch(/^http:\/\/localhost:5173\/auth\/callback#code=/);
    expect(await exchange(location)).toBe(200);
  });

  it("sends the desktop app back to its URL scheme with a code", async () => {
    const { state, cookie } = await startFlow("?client=desktop");
    stubGitHub();
    const location = await callback(state, cookie);
    expect(location).toMatch(/^mortium:\/\/auth\/callback#code=/);
    expect(await exchange(location)).toBe(200);
  });

  it("sends a desktop error to the URL scheme too", async () => {
    const { cookie } = await startFlow("?client=desktop");
    const location = await callback("wrong-state", cookie);
    expect(location).toBe("mortium://auth/callback#error=OAUTH_STATE_INVALID");
  });

  it("ignores an unknown client value and keeps the web return", async () => {
    const { cookie } = await startFlow("?client=other");
    const location = await callback("wrong-state", cookie);
    expect(location).toBe("http://localhost:5173/auth/callback#error=OAUTH_STATE_INVALID");
  });
});
