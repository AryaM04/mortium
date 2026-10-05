// End-to-end flow for friends, DMs, group DMs, blocks, DM calls and the
// synced notification level. Three real browser contexts (A, B and C)
// drive the real UI. Only the setup that needs no visual check (register,
// a guild, the A-C friendship) goes through the REST API.
//
// Needs a real Postgres (see auth.spec.ts): skips itself when it is not reachable.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { saveRecoveryKey } from "../lib/recovery-key.js";
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

interface ApiSession {
  accessToken: string;
  userId: string;
}

function uniqueUser(label: string): TestUser {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  return {
    email: `e2e-dm-${stamp}-${label.toLowerCase()}@example.test`,
    username: `e2edm${stamp}${label.toLowerCase()}`.slice(0, 32),
    password: "correct-horse-battery-staple",
    displayName: `Dm${label}${stamp}`.slice(0, 32),
  };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function registerApi(request: APIRequestContext, user: TestUser): Promise<ApiSession> {
  const response = await request.post(`${WEB_ORIGIN}/api/v1/auth/register`, {
    data: await registerBody(user),
  });
  if (!response.ok()) {
    throw new Error(`register failed: ${response.status()} ${await response.text()}`);
  }
  const body = await response.json();
  return { accessToken: body.accessToken, userId: body.user.id };
}

async function apiCall(request: APIRequestContext, method: string, path: string, token: string, data?: unknown) {
  const response = await request.fetch(`${WEB_ORIGIN}/api/v1${path}`, { method, headers: auth(token), data });
  if (!response.ok()) {
    throw new Error(`${method} ${path} failed: ${response.status()} ${await response.text()}`);
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

async function openHome(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Home" }).click();
  await expect(page).toHaveURL(`${WEB_ORIGIN}/app/@me`);
}

function composerBox(page: Page) {
  return page.getByRole("combobox", { name: "Write a message." });
}

async function sendMessage(page: Page, text: string): Promise<void> {
  await composerBox(page).fill(text);
  await composerBox(page).press("Enter");
}

function friendRow(page: Page, user: TestUser) {
  return page.locator(`[data-friend-row="${user.username}"]`);
}

function dmRow(page: Page, name: string) {
  return page.locator(`[data-dm-row="${name}"]`);
}

async function connectedPeerCount(page: Page): Promise<number> {
  // The web app puts this debug hook on window in a dev build. See apps/web/src/main.tsx.
  const stats = await page.evaluate(() => {
    const debug = (window as unknown as { __voiceDebug?: { getStats(): Promise<Array<{ connectionState: string }>> } })
      .__voiceDebug;
    return debug ? debug.getStats() : [];
  });
  return stats.filter((peer) => peer.connectionState === "connected").length;
}

test.describe("friends and DMs", () => {
  test("friend request, DM, group DM, block, DM call and notification level", async ({ browser, request }) => {
    test.setTimeout(180_000);

    const userA = uniqueUser("A");
    const userB = uniqueUser("B");
    const userC = uniqueUser("C");
    const apiA = await registerApi(request, userA);
    await registerApi(request, userB);
    const apiC = await registerApi(request, userC);

    // A and C are friends from the start, so A can add C to a group DM.
    await apiCall(request, "POST", "/users/@me/relationships", apiA.accessToken, { username: userC.username });
    await apiCall(request, "PUT", `/users/@me/relationships/${apiA.userId}`, apiC.accessToken, { action: "accept" });
    // A 1:1 DM between A and C, for the block check at the end.
    const dmAC = (await apiCall(request, "POST", "/users/@me/channels", apiA.accessToken, {
      recipientIds: [apiC.userId],
    })) as { id: string };
    const guild = (await apiCall(request, "POST", "/guilds", apiA.accessToken, { name: "DM E2E Guild" })) as {
      id: string;
    };

    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const contextC = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const pageC = await contextC.newPage();
    await loginThroughUi(pageA, userA);
    await loginThroughUi(pageB, userB);
    await loginThroughUi(pageC, userC);
    await openHome(pageA);
    await openHome(pageB);
    await openHome(pageC);

    // 1. A sends a friend request to B.
    await pageA.getByRole("tab", { name: "Add friend" }).click();
    await pageA.getByLabel("Username").fill(userB.username);
    await pageA.getByRole("button", { name: "Send friend request" }).click();
    await expect(pageA.getByRole("tabpanel").getByRole("status")).toHaveText(`You sent a friend request to ${userB.displayName}.`);

    // A second request gets a clear error.
    await pageA.getByLabel("Username").fill(userB.username);
    await pageA.getByRole("button", { name: "Send friend request" }).click();
    await expect(pageA.getByRole("tabpanel").getByRole("alert")).toHaveText("You already sent a friend request to this user.");

    // 2. B sees the request in Pending and accepts it.
    await pageB.getByRole("tab", { name: /Pending/ }).click();
    const incoming = friendRow(pageB, userA);
    await expect(incoming).toContainText("Incoming friend request", { timeout: 10_000 });
    await incoming.getByRole("button", { name: "Accept" }).click();

    // 3. Both see the other in All and Online.
    for (const [page, other] of [
      [pageA, userB],
      [pageB, userA],
    ] as const) {
      await page.getByRole("tab", { name: "All" }).click();
      await expect(friendRow(page, other)).toBeVisible({ timeout: 10_000 });
      await page.getByRole("tab", { name: "Online" }).click();
      await expect(friendRow(page, other)).toBeVisible({ timeout: 10_000 });
    }

    // 4. A opens a DM with B and sends a message.
    await friendRow(pageA, userB).getByRole("button", { name: "Message" }).click();
    await expect(pageA).toHaveURL(/\/app\/@me\/\d+$/);
    const dmAB = pageA.url().split("/").pop()!;
    await sendMessage(pageA, "Hello B from A");
    await expect(pageA.locator("[data-message-id]", { hasText: "Hello B from A" })).toBeVisible();

    // 5. B sees the DM in the list with an unread badge, and reads it.
    const rowOnB = dmRow(pageB, userA.displayName);
    await expect(rowOnB).toHaveAttribute("data-dm-unread", "true", { timeout: 10_000 });
    await expect(rowOnB.locator("[data-dm-badge]")).toHaveText(/1/);
    await rowOnB.getByRole("link").click();
    await expect(pageB).toHaveURL(`${WEB_ORIGIN}/app/@me/${dmAB}`);
    await expect(pageB.locator("[data-message-id]", { hasText: "Hello B from A" })).toBeVisible();
    await expect(rowOnB).toHaveAttribute("data-dm-unread", "false", { timeout: 10_000 });
    await expect(rowOnB.locator("[data-dm-badge]")).toHaveCount(0);

    // 6. A makes a group DM with B and C. C sees it and replies.
    await pageA.getByRole("button", { name: "New group DM" }).click();
    const picker = pageA.getByRole("dialog", { name: "New group DM" });
    await picker.getByRole("checkbox").nth(0).check();
    await picker.getByRole("checkbox").nth(1).check();
    await picker.getByRole("button", { name: "Create" }).click();
    await expect(pageA.locator("[data-group-member]")).toHaveCount(3);
    await sendMessage(pageA, "Welcome to the group");
    const groupOnC = pageC.locator("[data-dm-row]", { hasText: userA.displayName }).filter({ hasText: "3 members" });
    await expect(groupOnC).toBeVisible({ timeout: 10_000 });
    await groupOnC.getByRole("link").click();
    await expect(pageC.locator("[data-message-id]", { hasText: "Welcome to the group" })).toBeVisible();
    await sendMessage(pageC, "Hello from C");
    await expect(pageA.locator("[data-message-id]", { hasText: "Hello from C" })).toBeVisible({ timeout: 10_000 });

    // 7. A blocks C. C cannot send in the 1:1 DM and sees the reason.
    await openHome(pageA);
    await pageA.getByRole("tab", { name: "All" }).click();
    await friendRow(pageA, userC).getByRole("button", { name: "Block" }).click();
    await friendRow(pageA, userC).getByRole("button", { name: "Block" }).click();
    await pageA.getByRole("tab", { name: "Blocked" }).click();
    await expect(friendRow(pageA, userC)).toBeVisible();
    await pageC.goto(`${WEB_ORIGIN}/app/@me/${dmAC.id}`);
    await sendMessage(pageC, "Can you read this?");
    await expect(pageC.getByText("Not sent. You cannot send messages to this user.")).toBeVisible({ timeout: 10_000 });

    // 8. A starts a call in the DM with B. B sees the ringing card and accepts.
    await pageA.goto(`${WEB_ORIGIN}/app/@me/${dmAB}`);
    await pageA.getByRole("button", { name: "Start call" }).click();
    const card = pageB.getByRole("alertdialog", { name: `Incoming call from ${userA.displayName}` });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.getByRole("button", { name: "Accept" }).click();
    await expect(card).toHaveCount(0);
    await expect.poll(() => connectedPeerCount(pageA), { timeout: 20_000 }).toBe(1);
    await expect.poll(() => connectedPeerCount(pageB), { timeout: 20_000 }).toBe(1);
    await expect(pageA.locator(`[data-voice-call-view="${dmAB}"]`)).toBeVisible();
    await pageA.getByRole("button", { name: "Leave call" }).click();
    // B is still in the call, so A can join it again.
    await expect(pageA.getByRole("button", { name: "Join call" })).toBeVisible();
    await expect.poll(() => connectedPeerCount(pageB), { timeout: 20_000 }).toBe(0);

    // 9. A sets the notification level of the guild. The level is in the synced settings and stays after a reload.
    // The server has only an encrypted blob (version byte 1, then the key id), never the JSON.
    await pageA.getByRole("link", { name: "DM E2E Guild" }).click({ button: "right" });
    await pageA.getByRole("menuitemradio", { name: "All messages" }).click();
    await expect
      .poll(
        async () => {
          const settings = (await apiCall(request, "GET", "/users/@me/settings", apiA.accessToken)) as {
            data: string | null;
          };
          if (!settings.data) return null;
          const blob = Buffer.from(settings.data, "base64url");
          return blob[0] === 1 && !blob.includes(Buffer.from(guild.id)) ? "encrypted" : "plaintext";
        },
        { timeout: 10_000 },
      )
      .toBe("encrypted");
    await pageA.reload();
    await expect(pageA.getByRole("link", { name: "DM E2E Guild" })).toBeVisible({ timeout: 10_000 });
    // Wait for the settings to load after READY, then check the menu.
    await expect
      .poll(
        async () => {
          await pageA.getByRole("link", { name: "DM E2E Guild" }).click({ button: "right" });
          const checked = await pageA.getByRole("menuitemradio", { name: "All messages" }).getAttribute("aria-checked");
          await pageA.keyboard.press("Escape");
          return checked;
        },
        { timeout: 10_000 },
      )
      .toBe("true");

    await contextA.close();
    await contextB.close();
    await contextC.close();
  });
});
