// End-to-end test of two tabs of the same device. The crypto layer runs in
// one SharedWorker for the device, so both tabs encrypt and decrypt at the
// same time. When the first tab closes, the second tab keeps working with
// no reload, and a new key share reaches it through its own gateway. A
// voice call works in the second tab while the first tab is open.
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
    email: `e2e-tab-${stamp}-${label}@example.test`,
    username: `tab${stamp}${label}`.slice(0, 32),
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
  return response.status() === 204 ? null : response.json();
}

/** Two users in one guild. */
async function setUp(request: APIRequestContext) {
  const userA = uniqueUser("a");
  const userB = uniqueUser("b");
  const a = await api(request, "/auth/register", undefined, userA);
  const b = await api(request, "/auth/register", undefined, userB);
  const guild = await api(request, "/guilds", a.accessToken, { name: "Tab Guild" });
  const channel = guild.channels.find((entry: { type: string }) => entry.type === "text");
  const invite = await api(request, `/channels/${channel.id}/invites`, a.accessToken);
  await api(request, `/invites/${invite.code}`, b.accessToken);
  return { userA, userB, a, guild, channel };
}

async function loginThroughUi(page: Page, user: TestUser): Promise<void> {
  await page.goto(`${WEB_ORIGIN}/login`);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app(\/|$)/);
  await saveRecoveryKey(page);
}

async function sendMessage(page: Page, text: string): Promise<void> {
  const box = page.getByRole("combobox", { name: "Write a message." });
  await box.fill(text);
  await box.press("Enter");
}

function messageRow(page: Page, text: string) {
  return page.locator("[data-message-id]", { hasText: text });
}

/** Open a channel with the app router, not with a page load. */
async function openChannel(page: Page, name: string): Promise<void> {
  await page.locator(`[data-channel-row="${name}"] button`).first().click();
}

test("two tabs of one device encrypt at the same time, and the second tab goes on after the first closes", async ({
  browser,
  request,
}) => {
  test.setTimeout(120_000);
  const { userA, userB, a, guild, channel } = await setUp(request);
  const channelUrl = `${WEB_ORIGIN}/app/${guild.id}/${channel.id}`;

  const context = await browser.newContext();
  const tab1 = await context.newPage();
  await loginThroughUi(tab1, userA);
  await waitForCrypto(tab1);
  await tab1.goto(channelUrl);
  const tab2 = await context.newPage();
  await tab2.goto(channelUrl);
  await waitForCrypto(tab2);
  // No tab waits for a different tab.
  await expect(tab1.locator("[data-crypto-other-tab]")).toHaveCount(0);
  await expect(tab2.locator("[data-crypto-other-tab]")).toHaveCount(0);

  const pageB = await (await browser.newContext()).newPage();
  await loginThroughUi(pageB, userB);
  await waitForCrypto(pageB);
  await pageB.goto(channelUrl);

  // 1. B sends. The key share reaches both gateway sessions of the device. The worker uses one copy, and both tabs read the message.
  const fromB = `from B ${Date.now()}`;
  await sendMessage(pageB, fromB);
  await expect(messageRow(tab1, fromB)).toBeVisible({ timeout: 15_000 });
  await expect(messageRow(tab2, fromB)).toBeVisible({ timeout: 15_000 });

  // 2. Both tabs send at the same time. Each page reads both messages.
  const fromTab1 = `from tab 1 ${Date.now()}`;
  const fromTab2 = `from tab 2 ${Date.now()}`;
  await Promise.all([sendMessage(tab1, fromTab1), sendMessage(tab2, fromTab2)]);
  for (const page of [tab1, tab2, pageB]) {
    for (const text of [fromTab1, fromTab2]) {
      await expect(messageRow(page, text)).toBeVisible({ timeout: 15_000 });
      await expect(messageRow(page, text)).not.toContainText("This message cannot be read.");
    }
  }

  // 3. The first tab closes. The second tab goes on with no reload.
  await tab1.close();
  const afterClose = `tab 2 alone ${Date.now()}`;
  await sendMessage(tab2, afterClose);
  await expect(messageRow(pageB, afterClose)).toBeVisible({ timeout: 15_000 });

  // 4. A new channel has a new Megolm session. Its key share reaches the
  // device through the gateway of the second tab, which now sends the acks.
  const second = await api(request, `/guilds/${guild.id}/channels`, a.accessToken, { name: "second", type: "text" });
  await expect(pageB.locator('[data-channel-row="second"]')).toBeVisible({ timeout: 15_000 });
  await openChannel(pageB, "second");
  await openChannel(tab2, "second");
  await expect(tab2).toHaveURL(new RegExp(`/app/${guild.id}/${second.id}$`));
  const newKey = `new key ${Date.now()}`;
  await sendMessage(pageB, newKey);
  await expect(messageRow(tab2, newKey)).toBeVisible({ timeout: 15_000 });
  await expect(messageRow(tab2, newKey)).not.toContainText("This message cannot be read.");
  await context.close();
});

test("a voice call works in the second tab while the first tab is open", async ({ browser, request }) => {
  test.setTimeout(90_000);
  const { userA, userB, guild, channel } = await setUp(request);
  const channelUrl = `${WEB_ORIGIN}/app/${guild.id}/${channel.id}`;

  const context = await browser.newContext();
  const tab1 = await context.newPage();
  await loginThroughUi(tab1, userA);
  await waitForCrypto(tab1);
  const tab2 = await context.newPage();
  await tab2.goto(channelUrl);
  await waitForCrypto(tab2);
  const pageB = await (await browser.newContext()).newPage();
  await loginThroughUi(pageB, userB);
  await waitForCrypto(pageB);
  await pageB.goto(channelUrl);

  // The voice signals are Olm messages: the worker encrypts them, and a tab gateway sends them.
  for (const page of [pageB, tab2]) {
    await openChannel(page, "General");
    await expect(page.locator('[data-voice-status="connected"]')).toBeVisible({ timeout: 15_000 });
  }
  await expect
    .poll(
      async () => {
        const stats = await Promise.all(
          [tab2, pageB].map((page) =>
            page.evaluate(() => (window as unknown as { __voiceDebug: { getStats(): Promise<Array<{ connectionState: string }>> } }).__voiceDebug.getStats()),
          ),
        );
        return stats.every((peers) => peers.length === 1 && peers[0]!.connectionState === "connected");
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  await context.close();
});
