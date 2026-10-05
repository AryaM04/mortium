// End-to-end tests of the key backup and of SAS device verification. The
// first device of a new account makes the key backup and shows the
// recovery key. A new sign-in with the password unlocks itself with the key
// wrap and reads the old messages. Without the key wrap, a new sign-in sees
// the "Verify this device" screen in place of the app. It reads the old
// messages after a restore with the recovery key, after a SAS verification
// from the first device, or (after a reload) with the password.
//
// Needs a real Postgres (see auth.spec.ts): skips itself when it is not
// reachable.
import postgres from "postgres";
import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { saveRecoveryKey, waitForPasswordUnlock } from "../lib/recovery-key.js";
import { waitForCrypto } from "../lib/crypto-debug.js";
import { E2E_DATABASE_NAME } from "../lib/ensure-e2e-db.js";
import { registerBody } from "../lib/accounts.js";

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
    email: `e2e-backup-${stamp}-${label.toLowerCase()}@example.test`,
    username: `backup${stamp}${label.toLowerCase()}`.slice(0, 32),
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
}

async function sendMessage(page: Page, text: string): Promise<void> {
  const box = page.getByRole("combobox", { name: "Write a message." });
  await box.fill(text);
  await box.press("Enter");
}

function messageRow(page: Page, text: string) {
  return page.locator("[data-message-id]", { hasText: text });
}

/** Run one function with a connection to the e2e database. */
async function withDb<T>(action: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const user = process.env.POSTGRES_USER ?? "mortium";
  const password = encodeURIComponent(process.env.POSTGRES_PASSWORD ?? "");
  const host = process.env.POSTGRES_HOST ?? "localhost";
  const port = process.env.POSTGRES_PORT ?? "5432";
  const sql = postgres(`postgres://${user}:${password}@${host}:${port}/${E2E_DATABASE_NAME}`, { max: 1 });
  try {
    return await action(sql);
  } finally {
    await sql.end();
  }
}

async function backupSessionCount(userId: string): Promise<number> {
  return withDb(async (sql) => {
    const [row] = await sql<Array<{ count: string }>>`select count(*)::text as count from key_backup_sessions where user_id = ${userId}`;
    return Number(row?.count ?? 0);
  });
}

interface StoredKeyWrap {
  key_wrap: string | null;
  key_wrap_version: number | null;
}

async function readKeyWrap(userId: string): Promise<StoredKeyWrap> {
  return withDb(async (sql) => {
    const [row] = await sql<StoredKeyWrap[]>`select key_wrap, key_wrap_version from users where id = ${userId}`;
    return row!;
  });
}

/** Read the key wrap of a user, and remove it. Then a new sign-in cannot unlock itself with the password. */
async function takeKeyWrap(userId: string): Promise<StoredKeyWrap> {
  const wrap = await readKeyWrap(userId);
  await withDb((sql) => sql`update users set key_wrap = null, key_wrap_version = null where id = ${userId}`);
  return wrap;
}

async function putKeyWrap(userId: string, wrap: StoredKeyWrap): Promise<void> {
  await withDb((sql) => sql`update users set key_wrap = ${wrap.key_wrap}, key_wrap_version = ${wrap.key_wrap_version} where id = ${userId}`);
}

/**
 * One user with a guild, signed in on a first browser device that made the
 * master key. The device makes the backup and shows the recovery key before
 * it shows the app.
 */
async function firstDevice(browser: Browser, request: APIRequestContext) {
  const user = uniqueUser("A");
  const registered = await api(request, "/auth/register", undefined, await registerBody(user));
  const guild = await api(request, "/guilds", registered.accessToken, { name: "Backup Guild" });
  const channel = guild.channels.find((entry: { type: string }) => entry.type === "text");
  const page = await (await browser.newContext()).newPage();
  await loginThroughUi(page, user);
  await waitForCrypto(page);
  const recoveryKey = await saveRecoveryKey(page);
  expect(recoveryKey).toMatch(/^([1-9A-HJ-NP-Za-km-z]{4} )+[1-9A-HJ-NP-Za-km-z]{1,4}$/);
  const channelUrl = `${WEB_ORIGIN}/app/${guild.id}/${channel.id}`;
  await page.goto(channelUrl);
  const userId = registered.user.id as string;
  // The backup has a key wrap, so the password can unlock a new device.
  expect((await readKeyWrap(userId)).key_wrap).not.toBeNull();
  return { user, userId, page, channelUrl, recoveryKey };
}

/** One message from the first device, and the wait until the key backup has its key. */
async function sendBackedUp(first: Page, userId: string, text: string): Promise<void> {
  await sendMessage(first, text);
  await expect(messageRow(first, text)).toBeVisible();
  await expect.poll(() => backupSessionCount(userId), { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
}

/**
 * A second sign-in of the same user without the key wrap. It shows the
 * "Verify this device" screen in place of the app.
 */
async function newDevice(browser: Browser, user: TestUser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await loginThroughUi(page, user);
  await waitForCrypto(page);
  await expect(page.getByRole("heading", { name: "Verify this device" })).toBeVisible({ timeout: 20_000 });
  return page;
}

test("a new device that signs in with the password reads the history with no recovery key step", async ({ browser, request }) => {
  test.setTimeout(120_000);
  const { user, userId, page: first, channelUrl } = await firstDevice(browser, request);
  const secret = `password secret ${Date.now()}`;
  await sendBackedUp(first, userId, secret);

  const second = await (await browser.newContext()).newPage();
  await loginThroughUi(second, user);
  await waitForPasswordUnlock(second);
  await second.goto(channelUrl);
  await expect(messageRow(second, secret)).toBeVisible({ timeout: 20_000 });

  // The unlocked device is signed, so the first device shares new keys with it at once.
  const after = `after the unlock ${Date.now()}`;
  await sendMessage(first, after);
  await expect(messageRow(second, after)).toBeVisible({ timeout: 20_000 });
});

test("a new device restores the history with the recovery key, and the app stores the key wrap again", async ({ browser, request }) => {
  test.setTimeout(120_000);
  const { user, userId, page: first, channelUrl, recoveryKey } = await firstDevice(browser, request);
  const secret = `backed up secret ${Date.now()}`;
  // The backup from the sign-up gets the new key in the background.
  await sendBackedUp(first, userId, secret);
  await takeKeyWrap(userId);

  // A second browser: a new device. A wrong key is rejected. The right key restores the history and verifies the device.
  const second = await newDevice(browser, user);
  await second.getByLabel("Recovery key").fill("1111 2222 3333");
  await second.getByRole("button", { name: "Restore from backup" }).click();
  await expect(second.getByRole("alert")).toHaveText(/not a valid recovery key/);
  await second.getByLabel("Recovery key").fill(recoveryKey);
  await second.getByRole("button", { name: "Restore from backup" }).click();
  await expect(second.getByRole("heading", { name: "Verify this device" })).toHaveCount(0, { timeout: 30_000 });
  await second.goto(channelUrl);
  await expect(messageRow(second, secret)).toBeVisible({ timeout: 20_000 });
  // This device held the recovery key and the wrap key, so it stored a new key wrap.
  await expect.poll(async () => (await readKeyWrap(userId)).key_wrap !== null, { timeout: 10_000 }).toBe(true);

  // The restored device is signed, so the first device shares new keys with it at once.
  const after = `after the restore ${Date.now()}`;
  await sendMessage(first, after);
  await expect(messageRow(second, after)).toBeVisible({ timeout: 20_000 });
});

test("the first device verifies a new device with SAS, and the new device reads the history", async ({ browser, request }) => {
  test.setTimeout(120_000);
  const { user, userId, page: first, channelUrl } = await firstDevice(browser, request);
  // Without the key wrap, the new device cannot unlock itself with the password.
  await takeKeyWrap(userId);
  const secret = `sas secret ${Date.now()}`;
  await sendMessage(first, secret);
  await expect(messageRow(first, secret)).toBeVisible();

  // The new device asks. The first device accepts. Both show the same 7 emojis.
  const second = await newDevice(browser, user);
  await second.getByRole("button", { name: "Verify with another device" }).click();
  const firstDialog = first.getByRole("dialog", { name: "Verification" });
  await firstDialog.getByRole("button", { name: "Accept" }).click();
  const secondDialog = second.getByRole("dialog", { name: "Verification" });
  const emojisOf = (dialog: typeof firstDialog) =>
    dialog.locator("[data-emoji-name]").evaluateAll((items) => items.map((item) => item.getAttribute("data-emoji-name")));
  await expect(firstDialog.locator("[data-emoji-name]")).toHaveCount(7, { timeout: 20_000 });
  await expect(secondDialog.locator("[data-emoji-name]")).toHaveCount(7, { timeout: 20_000 });
  const emojis = await emojisOf(firstDialog);
  expect(await emojisOf(secondDialog)).toEqual(emojis);

  await firstDialog.getByRole("button", { name: "They match" }).click();
  await secondDialog.getByRole("button", { name: "They match" }).click();
  const done = "The devices are verified. This account now trusts both devices, and they share keys.";
  await expect(firstDialog.getByRole("status")).toHaveText(done, { timeout: 20_000 });
  await expect(secondDialog.getByRole("status")).toHaveText(done, { timeout: 20_000 });
  await secondDialog.getByRole("button", { name: "Close" }).click();
  await firstDialog.getByRole("button", { name: "Close" }).click();

  // Now verified, the new device shows the app. It asks again for the old key, and the first device answers.
  await expect(second.getByRole("heading", { name: "Verify this device" })).toHaveCount(0);
  await second.goto(channelUrl);
  await expect(messageRow(second, secret)).toBeVisible({ timeout: 30_000 });
});

test("after a reload, the password unlocks a new device", async ({ browser, request }) => {
  test.setTimeout(120_000);
  const { user, userId, page: first, channelUrl } = await firstDevice(browser, request);
  const secret = `reload secret ${Date.now()}`;
  await sendBackedUp(first, userId, secret);
  const wrap = await takeKeyWrap(userId);

  // The sign-in finds no key wrap. Then the key wrap comes back, but a reload removed the wrap key from memory.
  const second = await newDevice(browser, user);
  await putKeyWrap(userId, wrap);
  await second.reload();
  await second.getByLabel("Your password").fill("not-the-right-password", { timeout: 30_000 });
  await second.getByRole("button", { name: "Unlock with your password" }).click();
  await expect(second.getByRole("alert")).toHaveText("This password does not unlock your encryption keys.", { timeout: 20_000 });
  await second.getByLabel("Your password").fill(user.password);
  await second.getByRole("button", { name: "Unlock with your password" }).click();
  await expect(second.getByRole("heading", { name: "Verify this device" })).toHaveCount(0, { timeout: 30_000 });
  await second.goto(channelUrl);
  await expect(messageRow(second, secret)).toBeVisible({ timeout: 20_000 });
});
