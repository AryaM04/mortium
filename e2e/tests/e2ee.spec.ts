// End-to-end smoke test of the E2EE foundation: two users in one guild
// sign in, each web app starts the crypto layer in the background and
// uploads its keys, then user A sends an Olm to-device message through
// the dev-only `window.__cryptoDebug` hook and user B decrypts it.
//
// Needs a real Postgres (see auth.spec.ts): skips itself when it is not
// reachable.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { saveRecoveryKey } from "../lib/recovery-key.js";
import { waitForCrypto } from "../lib/crypto-debug.js";

const WEB_ORIGIN = "http://localhost:5173";

test.skip(
  process.env.E2E_AUTH_AVAILABLE !== "true",
  "Postgres is not reachable. Start it with docker compose (see playwright.config.ts).",
);

interface TestUser {
  email: string;
  username: string;
  password: string;
}

function uniqueUser(label: string): TestUser {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
  return {
    email: `e2e-e2ee-${stamp}-${label.toLowerCase()}@example.test`,
    username: `e2ee${stamp}${label.toLowerCase()}`.slice(0, 32),
    password: "correct-horse-battery-staple",
  };
}

async function api(request: APIRequestContext, path: string, token?: string, data: unknown = {}) {
  const response = await request.post(`${WEB_ORIGIN}/api/v1${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    data,
  });
  if (!response.ok()) {
    throw new Error(`${path} failed: ${response.status()} ${await response.text()}`);
  }
  return response.json();
}

async function loginThroughUi(page: Page, user: TestUser): Promise<void> {
  await page.goto(`${WEB_ORIGIN}/login`);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app(\/|$)/);
  await saveRecoveryKey(page);
}

test("two users exchange an Olm to-device message through the key server", async ({ browser, request }) => {
  const userA = uniqueUser("A");
  const userB = uniqueUser("B");
  const a = await api(request, "/auth/register", undefined, userA);
  const b = await api(request, "/auth/register", undefined, userB);
  const guild = await api(request, "/guilds", a.accessToken, { name: "E2EE Guild" });
  const channel = guild.channels.find((c: { type: string }) => c.type === "text");
  const invite = await api(request, `/channels/${channel.id}/invites`, a.accessToken);
  await api(request, `/invites/${invite.code}`, b.accessToken);

  const pageA = await (await browser.newContext()).newPage();
  const pageB = await (await browser.newContext()).newPage();
  await loginThroughUi(pageA, userA);
  await loginThroughUi(pageB, userB);
  await waitForCrypto(pageA);
  await waitForCrypto(pageB);

  const keysA = await pageA.evaluate(() => window.__cryptoDebug!.identityKeys());
  expect(keysA?.curve25519).toMatch(/^[A-Za-z0-9+/]{43}$/);

  // Only the signed-in browser device of B has keys, so the ping reaches one device.
  const reached = await pageA.evaluate((userId) => window.__cryptoDebug!.sendPing(userId, "hello from A"), b.user.id);
  expect(reached).toBe(1);

  await expect
    .poll(() => pageB.evaluate(() => window.__cryptoDebug!.received()), { timeout: 10_000 })
    .toEqual([{ fromUserId: a.user.id, fromDeviceId: expect.any(String), text: "hello from A" }]);
  expect(await pageA.evaluate(() => window.__cryptoDebug!.sessionCount())).toBe(1);
  expect(await pageB.evaluate(() => window.__cryptoDebug!.sessionCount())).toBe(1);

  // B answers on the session that A made. No new one-time key is needed on the A side.
  await pageB.evaluate((userId) => window.__cryptoDebug!.sendPing(userId, "hello from B"), a.user.id);
  await expect
    .poll(() => pageA.evaluate(() => window.__cryptoDebug!.received().map((entry) => entry.text)), { timeout: 10_000 })
    .toEqual(["hello from B"]);
});
