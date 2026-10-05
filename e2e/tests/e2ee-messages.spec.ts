// End-to-end test of Megolm message encryption: the database keeps only
// ciphertext, a new member reads the history, and a kicked member gets no
// key for new messages.
//
// Needs a real Postgres (see auth.spec.ts): skips itself when it is not
// reachable.
import postgres from "postgres";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { saveRecoveryKey } from "../lib/recovery-key.js";
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
  displayName: string;
}

function uniqueUser(label: string): TestUser {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
  return {
    email: `e2e-megolm-${stamp}-${label.toLowerCase()}@example.test`,
    username: `megolm${stamp}${label.toLowerCase()}`.slice(0, 32),
    password: "correct-horse-battery-staple",
    displayName: `Megolm ${label} ${stamp}`,
  };
}

async function api(request: APIRequestContext, method: "POST" | "DELETE", path: string, token?: string, data: unknown = {}) {
  const response = await request.fetch(`${WEB_ORIGIN}/api/v1${path}`, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    data: method === "POST" ? data : undefined,
  });
  if (!response.ok()) {
    throw new Error(`${path} failed: ${response.status()} ${await response.text()}`);
  }
  return response.status() === 204 ? null : response.json();
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

function database() {
  const user = process.env.POSTGRES_USER ?? "mortium";
  const password = encodeURIComponent(process.env.POSTGRES_PASSWORD ?? "");
  const host = process.env.POSTGRES_HOST ?? "localhost";
  const port = process.env.POSTGRES_PORT ?? "5432";
  return postgres(`postgres://${user}:${password}@${host}:${port}/${E2E_DATABASE_NAME}`, { max: 1 });
}

interface StoredEvent {
  id: string;
  codec: string;
  megolm_session_id: string | null;
  ciphertext: Buffer;
}

test("messages are encrypted, a new member reads the history, a kicked member gets no new key", async ({
  browser,
  request,
}) => {
  test.setTimeout(120_000);
  const userA = uniqueUser("A");
  const userB = uniqueUser("B");
  const userC = uniqueUser("C");
  const a = await api(request, "POST", "/auth/register", undefined, await registerBody(userA));
  const b = await api(request, "POST", "/auth/register", undefined, await registerBody(userB));
  const c = await api(request, "POST", "/auth/register", undefined, await registerBody(userC));
  const guild = await api(request, "POST", "/guilds", a.accessToken, { name: "Megolm Guild" });
  const channel = guild.channels.find((entry: { type: string; name: string }) => entry.type === "text");
  const invite = await api(request, "POST", `/channels/${channel.id}/invites`, a.accessToken);
  await api(request, "POST", `/invites/${invite.code}`, b.accessToken);

  const pageA = await (await browser.newContext()).newPage();
  const pageB = await (await browser.newContext()).newPage();
  const pageC = await (await browser.newContext()).newPage();
  await loginThroughUi(pageA, userA);
  await loginThroughUi(pageB, userB);
  await loginThroughUi(pageC, userC);
  await Promise.all([waitForCrypto(pageA), waitForCrypto(pageB), waitForCrypto(pageC)]);

  const channelUrl = `${WEB_ORIGIN}/app/${guild.id}/${channel.id}`;
  await pageA.goto(channelUrl);
  await pageB.goto(channelUrl);

  // 1. A sends. B reads it live.
  const secret = `first secret ${Date.now()}`;
  await sendMessage(pageA, secret);
  await expect(messageRow(pageB, secret)).toBeVisible({ timeout: 15_000 });

  // 2. The database keeps only ciphertext: no event of the channel contains the text.
  const sql = database();
  let firstSession: string;
  try {
    const rows = await sql<StoredEvent[]>`
      select id::text, codec, megolm_session_id, ciphertext from events where channel_id = ${channel.id} order by id`;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.codec).toBe("megolm-v1");
      expect(row.megolm_session_id).not.toBeNull();
      expect(Buffer.from(row.ciphertext).includes(Buffer.from(secret, "utf8"))).toBe(false);
    }
    firstSession = rows.at(-1)!.megolm_session_id!;
  } finally {
    await sql.end();
  }

  // 3. C joins after the message. An old member sends the history, and C reads it.
  await api(request, "POST", `/invites/${invite.code}`, c.accessToken);
  await pageC.goto(channelUrl);
  await expect(messageRow(pageC, secret)).toBeVisible({ timeout: 30_000 });
  await sendMessage(pageC, "hello from C");
  await expect(messageRow(pageA, "hello from C")).toBeVisible({ timeout: 15_000 });

  // 4. A kicks C. The next message of A uses a new session, and C never gets its key.
  await api(request, "DELETE", `/guilds/${guild.id}/members/${c.user.id}`, a.accessToken);
  await expect(pageC.getByText("You are no longer a member of this server.")).toBeVisible({ timeout: 15_000 });
  const afterKick = `after the kick ${Date.now()}`;
  await sendMessage(pageA, afterKick);
  await expect(messageRow(pageB, afterKick)).toBeVisible({ timeout: 15_000 });

  const sqlAfter = database();
  let newSession: string;
  try {
    const [row] = await sqlAfter<StoredEvent[]>`
      select id::text, codec, megolm_session_id, ciphertext from events
      where channel_id = ${channel.id} and sender_user_id = ${a.user.id} order by id desc limit 1`;
    newSession = row!.megolm_session_id!;
    expect(Buffer.from(row!.ciphertext).includes(Buffer.from(afterKick, "utf8"))).toBe(false);
  } finally {
    await sqlAfter.end();
  }
  expect(newSession).not.toBe(firstSession);
  // Give a late key share time to arrive, then check that none did.
  await pageC.waitForTimeout(2_000);
  expect(await pageC.evaluate((id) => window.__cryptoDebug!.hasMegolmSession(id), newSession)).toBe(false);
  // C keeps the old key: it can still read what it could read before.
  expect(await pageC.evaluate((id) => window.__cryptoDebug!.hasMegolmSession(id), firstSession)).toBe(true);
});
