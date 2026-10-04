// End-to-end tests of the key backup and of SAS device verification. A
// new sign-in of the same user cannot read old messages. It becomes able
// to read them after a restore with the recovery key, or after a SAS
// verification from the first device.
//
// Needs a real Postgres (see auth.spec.ts): skips itself when it is not
// reachable.
import postgres from "postgres";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { waitForCrypto } from "../lib/crypto-debug.js";
import { E2E_DATABASE_NAME } from "../lib/ensure-e2e-db.js";

const WEB_ORIGIN = "http://localhost:5173";
const WAITING_TEXT = "This message cannot be read yet. The app asks for the key.";

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

async function backupSessionCount(userId: string): Promise<number> {
  const user = process.env.POSTGRES_USER ?? "mortium";
  const password = encodeURIComponent(process.env.POSTGRES_PASSWORD ?? "");
  const host = process.env.POSTGRES_HOST ?? "localhost";
  const port = process.env.POSTGRES_PORT ?? "5432";
  const sql = postgres(`postgres://${user}:${password}@${host}:${port}/${E2E_DATABASE_NAME}`, { max: 1 });
  try {
    const [row] = await sql<Array<{ count: string }>>`select count(*)::text as count from key_backup_sessions where user_id = ${userId}`;
    return Number(row?.count ?? 0);
  } finally {
    await sql.end();
  }
}

/** One user with a guild, signed in on a first browser device that made the master key. */
async function firstDevice(browser: import("@playwright/test").Browser, request: APIRequestContext) {
  const user = uniqueUser("A");
  const registered = await api(request, "/auth/register", undefined, user);
  const guild = await api(request, "/guilds", registered.accessToken, { name: "Backup Guild" });
  const channel = guild.channels.find((entry: { type: string }) => entry.type === "text");
  const page = await (await browser.newContext()).newPage();
  await loginThroughUi(page, user);
  await waitForCrypto(page);
  const channelUrl = `${WEB_ORIGIN}/app/${guild.id}/${channel.id}`;
  await page.goto(channelUrl);
  return { user, userId: registered.user.id as string, page, channelUrl };
}

test("a new device restores the history with the recovery key", async ({ browser, request }) => {
  test.setTimeout(120_000);
  const { user, userId, page: first, channelUrl } = await firstDevice(browser, request);
  const secret = `backed up secret ${Date.now()}`;
  await sendMessage(first, secret);
  await expect(messageRow(first, secret)).toBeVisible();

  // Set up the backup in Settings > Security. The user types the last group of the key again.
  await first.getByRole("button", { name: "Open account settings" }).click();
  await first.getByRole("button", { name: "Security: devices and secure backup" }).click();
  const security = first.getByRole("dialog", { name: "Security" });
  await expect(security.getByTestId("device-trust")).toHaveText(/^Verified\./);
  await security.getByRole("button", { name: "Set up secure backup" }).click();
  await security.getByRole("button", { name: "Make the recovery key" }).click();
  const recoveryKey = (await security.getByTestId("recovery-key").textContent())!.trim();
  expect(recoveryKey).toMatch(/^([1-9A-HJ-NP-Za-km-z]{4} )+[1-9A-HJ-NP-Za-km-z]{1,4}$/);
  await security.getByLabel("Last group of the recovery key").fill("wrong");
  await security.getByRole("button", { name: "Turn on the backup" }).click();
  await expect(security.getByRole("alert")).toHaveText(/not the last group/);
  await security.getByLabel("Last group of the recovery key").fill(recoveryKey.split(" ").at(-1)!);
  await security.getByRole("button", { name: "Turn on the backup" }).click();
  await expect(security.getByText("The backup is on.").first()).toBeVisible();
  await expect.poll(() => backupSessionCount(userId), { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
  await security.getByRole("button", { name: "Close" }).click();
  await first.getByRole("dialog", { name: "Account settings" }).getByRole("button", { name: "Cancel" }).click();

  // A second browser: a new device. It is not verified, so it cannot read the old message.
  const second = await (await browser.newContext()).newPage();
  await loginThroughUi(second, user);
  await waitForCrypto(second);
  await second.goto(channelUrl);
  await expect(second.getByText("Verify this device to read old messages.", { exact: false })).toBeVisible({ timeout: 20_000 });
  await expect(messageRow(second, WAITING_TEXT)).toBeVisible({ timeout: 20_000 });

  // A wrong key is rejected. The right key restores the history and verifies the device.
  await second.getByRole("button", { name: "Use the recovery key" }).click();
  const restore = second.getByRole("dialog", { name: "Security" });
  await restore.getByLabel("Recovery key").fill("1111 2222 3333");
  await restore.getByRole("button", { name: "Restore from backup" }).click();
  await expect(restore.getByRole("alert")).toHaveText(/not a valid recovery key/);
  await restore.getByLabel("Recovery key").fill(recoveryKey);
  await restore.getByRole("button", { name: "Restore from backup" }).click();
  await expect(restore.getByRole("status")).toHaveText(/The restore is complete: 1 message keys\. This device is verified now\./, {
    timeout: 30_000,
  });
  await restore.getByRole("button", { name: "Close" }).click();
  await expect(messageRow(second, secret)).toBeVisible({ timeout: 20_000 });
  await expect(second.getByText("Verify this device to read old messages.", { exact: false })).toHaveCount(0);

  // The restored device is signed, so the first device shares new keys with it at once.
  const after = `after the restore ${Date.now()}`;
  await sendMessage(first, after);
  await expect(messageRow(second, after)).toBeVisible({ timeout: 20_000 });
});

test("the first device verifies a new device with SAS, and the new device reads the history", async ({ browser, request }) => {
  test.setTimeout(120_000);
  const { user, page: first, channelUrl } = await firstDevice(browser, request);
  const secret = `sas secret ${Date.now()}`;
  await sendMessage(first, secret);
  await expect(messageRow(first, secret)).toBeVisible();

  const second = await (await browser.newContext()).newPage();
  await loginThroughUi(second, user);
  await waitForCrypto(second);
  await second.goto(channelUrl);
  await expect(messageRow(second, WAITING_TEXT)).toBeVisible({ timeout: 20_000 });

  // The new device asks. The first device accepts. Both show the same 7 emojis.
  await second.getByRole("button", { name: "Verify with a different device" }).click();
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

  // Now verified, the new device asks again for the old key, and the first device answers.
  await expect(messageRow(second, secret)).toBeVisible({ timeout: 30_000 });
  await expect(second.getByText("Verify this device to read old messages.", { exact: false })).toHaveCount(0);
});
