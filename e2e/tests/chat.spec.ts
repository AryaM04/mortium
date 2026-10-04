// End-to-end chat flow: two browser contexts (A and B) in one guild,
// covering live send, reply, edit, reactions, delete, the typing
// indicator, markdown and XSS safety, unread and mention badges, paging
// through history, and the re-login regression from Task 1 of this
// change (see messages-store.ts and ChatPane.tsx).
//
// Setup (register, guild, channel, invite) goes through the REST API
// directly, since it needs no visual check and API calls are far faster
// and less flaky than driving the create-guild and invite dialogs. Each
// scenario itself drives the real UI in two real browser contexts, so it
// proves the live gateway path, not just the store.
//
// Needs a real Postgres (see auth.spec.ts): skips itself when it is not
// reachable.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { enterRecoveryKey, saveRecoveryKey } from "../lib/recovery-key.js";
import { seedMessages } from "../lib/crypto-debug.js";

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

interface ChannelInfo {
  id: string;
  name: string | null;
  type: string;
}

function uniqueUser(label: string): TestUser {
  const stamp = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  return {
    email: `e2e-chat-${stamp}-${label.toLowerCase()}@example.test`,
    // The username schema lowercases and length-caps at 32 characters,
    // so build a short, already-lowercase one instead of relying on it.
    username: `e2echat${stamp.replace(/_/g, "")}${label.toLowerCase()}`.slice(0, 32),
    password: "correct-horse-battery-staple",
    displayName: `Chat ${label} ${stamp}`,
  };
}

async function registerApi(request: APIRequestContext, user: TestUser): Promise<ApiSession> {
  const response = await request.post(`${WEB_ORIGIN}/api/v1/auth/register`, {
    data: { email: user.email, username: user.username, password: user.password, displayName: user.displayName },
  });
  if (!response.ok()) {
    throw new Error(`register failed: ${response.status()} ${await response.text()}`);
  }
  const body = await response.json();
  return { accessToken: body.accessToken, userId: body.user.id };
}

async function createGuildApi(request: APIRequestContext, token: string, name: string) {
  const response = await request.post(`${WEB_ORIGIN}/api/v1/guilds`, {
    headers: { authorization: `Bearer ${token}` },
    data: { name },
  });
  if (!response.ok()) {
    throw new Error(`create guild failed: ${response.status()} ${await response.text()}`);
  }
  const body = (await response.json()) as { id: string; channels: ChannelInfo[] };
  return body;
}

async function createChannelApi(
  request: APIRequestContext,
  token: string,
  guildId: string,
  name: string,
): Promise<ChannelInfo> {
  const response = await request.post(`${WEB_ORIGIN}/api/v1/guilds/${guildId}/channels`, {
    headers: { authorization: `Bearer ${token}` },
    data: { name, type: "text" },
  });
  if (!response.ok()) {
    throw new Error(`create channel failed: ${response.status()} ${await response.text()}`);
  }
  return (await response.json()) as ChannelInfo;
}

async function createInviteApi(request: APIRequestContext, token: string, channelId: string): Promise<string> {
  const response = await request.post(`${WEB_ORIGIN}/api/v1/channels/${channelId}/invites`, {
    headers: { authorization: `Bearer ${token}` },
    data: {},
  });
  if (!response.ok()) {
    throw new Error(`create invite failed: ${response.status()} ${await response.text()}`);
  }
  const body = (await response.json()) as { code: string };
  return body.code;
}

async function acceptInviteApi(request: APIRequestContext, token: string, code: string): Promise<void> {
  const response = await request.post(`${WEB_ORIGIN}/api/v1/invites/${code}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok()) {
    throw new Error(`accept invite failed: ${response.status()} ${await response.text()}`);
  }
}


/** Sign in the first device of a new user. Returns the recovery key. */
async function loginThroughUi(page: Page, user: TestUser): Promise<string> {
  await page.goto(`${WEB_ORIGIN}/login`);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app(\/|$)/);
  return saveRecoveryKey(page);
}

function composerBox(page: Page) {
  return page.getByRole("combobox", { name: "Write a message." });
}

// `excludeText` disambiguates a message from a *reply preview* line that
// happens to quote the same text (the preview is a live, re-aggregated
// copy of the original body, so it tracks edits too).
function messageRow(page: Page, text: string, excludeText?: string) {
  const row = page.locator("[data-message-id]", { hasText: text });
  return excludeText ? row.filter({ hasNotText: excludeText }) : row;
}

async function sendMessage(page: Page, text: string): Promise<void> {
  const box = composerBox(page);
  await box.fill(text);
  await box.press("Enter");
}

test.describe("chat", () => {
  test("send, reply, edit, react, delete, typing, markdown, unread, history, re-login", async ({ browser, request }) => {
    // The history scenario seeds 150 messages against a 10-per-5s rate
    // limit, which alone takes well over a minute.
    test.setTimeout(240_000);

    const userA = uniqueUser("A");
    const userB = uniqueUser("B");
    const apiA = await registerApi(request, userA);
    const apiB = await registerApi(request, userB);

    const guild = await createGuildApi(request, apiA.accessToken, "Chat E2E Guild");
    const general = guild.channels.find((c) => c.type === "text" && c.name === "general")!;
    const second = await createChannelApi(request, apiA.accessToken, guild.id, "second");
    const history = await createChannelApi(request, apiA.accessToken, guild.id, "history");

    const inviteCode = await createInviteApi(request, apiA.accessToken, general.id);
    await acceptInviteApi(request, apiB.accessToken, inviteCode);

    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    // Fail loudly if a script payload ever manages to pop a dialog.
    pageA.on("dialog", (dialog) => {
      throw new Error(`Unexpected dialog on page A: ${dialog.message()}`);
    });
    pageB.on("dialog", (dialog) => {
      throw new Error(`Unexpected dialog on page B: ${dialog.message()}`);
    });

    const recoveryKeyA = await loginThroughUi(pageA, userA);
    await loginThroughUi(pageB, userB);

    const generalUrl = `${WEB_ORIGIN}/app/${guild.id}/${general.id}`;
    await pageA.goto(generalUrl);
    await pageB.goto(generalUrl);
    await expect(composerBox(pageA)).toBeVisible();
    await expect(composerBox(pageB)).toBeVisible();

    // 1. A sends, B sees it live.
    await sendMessage(pageA, "Hello from A");
    await expect(pageB.getByText("Hello from A")).toBeVisible({ timeout: 10_000 });

    // 2. B replies, A sees the reply preview; clicking it highlights the original.
    await messageRow(pageB, "Hello from A").hover();
    await messageRow(pageB, "Hello from A").getByRole("button", { name: "Reply" }).click();
    await sendMessage(pageB, "Reply from B");
    await expect(pageA.getByText("Reply from B")).toBeVisible({ timeout: 10_000 });

    const replyRowOnA = messageRow(pageA, "Reply from B");
    await replyRowOnA.getByRole("button", { name: /Hello from A/ }).click();
    const originalRowOnA = messageRow(pageA, "Hello from A", "Reply from B");
    await expect(originalRowOnA).toHaveCSS("background-color", "rgba(91, 108, 255, 0.15)");

    // 3. A edits its message; B sees the new text and "(edited)".
    await messageRow(pageA, "Hello from A", "Reply from B").hover();
    await messageRow(pageA, "Hello from A", "Reply from B").getByRole("button", { name: "Edit" }).click();
    const editBox = composerBox(pageA);
    await editBox.fill("Hello from A, edited");
    await editBox.press("Enter");
    const editedRowOnB = messageRow(pageB, "Hello from A, edited", "Reply from B");
    await expect(editedRowOnB).toBeVisible({ timeout: 10_000 });
    await expect(editedRowOnB).toContainText("(edited)");

    // 4. B reacts with a quick-pick 👍; A sees count 1. B reacts again to remove it.
    const replyRowOnB = messageRow(pageB, "Reply from B");
    await replyRowOnB.hover();
    await replyRowOnB.getByRole("button", { name: "React" }).click();
    await replyRowOnB.getByRole("button", { name: "👍", exact: true }).click();
    const replyRowOnA2 = messageRow(pageA, "Reply from B");
    await expect(replyRowOnA2.getByText("👍 1")).toBeVisible({ timeout: 10_000 });

    await replyRowOnB.getByRole("button", { name: "👍 1", exact: true }).click();
    await expect(replyRowOnA2.getByText("👍 1")).not.toBeVisible({ timeout: 10_000 });

    // 5. A deletes a message; it disappears for B. Shift-click skips the confirm dialog.
    await sendMessage(pageA, "Message to delete");
    await expect(pageB.getByText("Message to delete")).toBeVisible({ timeout: 10_000 });
    const deleteRow = messageRow(pageA, "Message to delete");
    await deleteRow.hover();
    await deleteRow.getByRole("button", { name: "Delete" }).click({ modifiers: ["Shift"] });
    await expect(pageB.getByText("Message to delete")).not.toBeVisible({ timeout: 10_000 });

    // 6. While A types, B sees the typing indicator. A sent message resets
    // the typing throttle on the client and on the server, so the first
    // keystroke after a send must reach B at once. Do not wait or retry here.
    await composerBox(pageA).pressSequentially("typing but not sending", { delay: 20 });
    // Bring B to front: a background page can draw later than its store changes.
    await pageB.bringToFront();
    await expect(pageB.getByText(`${userA.displayName} is typing…`)).toBeVisible({ timeout: 5_000 });
    await composerBox(pageA).fill("");

    // 7. Markdown renders; a script payload shows as plain text and never runs.
    await sendMessage(pageA, "**bold**");
    await expect(pageB.locator("strong", { hasText: "bold" })).toBeVisible({ timeout: 10_000 });

    const scriptPayload = "<script>alert(1)</script>";
    await sendMessage(pageA, scriptPayload);
    await expect(pageB.getByText(scriptPayload)).toBeVisible({ timeout: 10_000 });
    await expect(pageB.locator("script", { hasText: "alert" })).toHaveCount(0);

    // 8. Unread and mentions: B opens a second channel, A mentions B in
    // #general through the autocomplete, B sees badges, opening the
    // channel clears them.
    await pageB.bringToFront();
    await pageB.getByRole("button", { name: /second/ }).click();
    await expect(pageB).toHaveURL(new RegExp(second.id));

    const composerA = composerBox(pageA);
    await composerA.fill(`Hey @${userB.username}`);
    const mentionOption = pageA.getByRole("option", { name: new RegExp(userB.username) });
    await expect(mentionOption).toBeVisible({ timeout: 10_000 });
    await mentionOption.click();
    await composerA.pressSequentially("please look at this");
    await composerA.press("Enter");

    const generalRowOnB = pageB.locator('[data-channel-row="general"]');
    const generalButtonOnB = pageB.getByRole("button", { name: /general/ });
    await expect(generalButtonOnB).toHaveCSS("font-weight", "600", { timeout: 10_000 });
    await expect(generalRowOnB.getByText("1", { exact: true })).toBeVisible();
    await expect(generalRowOnB.getByText("1 mention")).toBeVisible();
    const guildIconOnB = pageB.locator('a[aria-label="Chat E2E Guild"]').locator("..");
    await expect(guildIconOnB.getByText("1 mention")).toBeVisible();

    // The store only marks a channel read while its tab has real focus
    // (so switching tabs without looking never silently marks it read),
    // so bring B's page to front and click into it before opening the
    // channel, as a real user switching tabs and looking at it would.
    await pageB.bringToFront();
    await generalButtonOnB.click();
    await expect(pageB).toHaveURL(new RegExp(general.id));
    await composerBox(pageB).click();
    await expect(generalRowOnB.getByText("1", { exact: true })).not.toBeVisible({ timeout: 15_000 });

    // 9. History: seed 150 messages in a dedicated channel, scroll to the
    // top until the earliest message loads, and check the viewport did
    // not jump back to the bottom. The seed encrypts each message with the
    // real crypto layer of page A, and posts it directly (the server
    // allows 10 events per 5 seconds, so this takes more than a minute).
    await seedMessages(
      pageA,
      history.id,
      Array.from({ length: 150 }, (_, i) => `history message ${i}`),
    );
    const historyUrl = `${WEB_ORIGIN}/app/${guild.id}/${history.id}`;
    await pageA.goto(historyUrl);
    await expect(pageA.getByText("history message 149")).toBeVisible({ timeout: 20_000 });

    const scroller = pageA.locator('[data-testid="virtuoso-scroller"]');
    await expect(scroller).toBeVisible();
    await scroller.hover();
    let earliestVisible = false;
    for (let i = 0; i < 80 && !earliestVisible; i += 1) {
      await pageA.mouse.wheel(0, -3000);
      await pageA.waitForTimeout(250);
      earliestVisible = await pageA
        .getByText("history message 0", { exact: true })
        .isVisible()
        .catch(() => false);
    }
    expect(earliestVisible).toBe(true);
    // Still scrolled away from the bottom: paging in older messages did
    // not snap the viewport back down to the newest message.
    await expect(pageA.getByRole("button", { name: "Jump to present" })).toBeVisible();

    // 10. Regression for Task 1: sign out, sign back in, the channel
    // shows its messages again (it must not render empty on first paint).
    // The new sign-in is a new device that the owner did not verify. The
    // security gate blocks the app until the recovery key verifies it
    // (docs/concepts/olm-megolm.md section 4).
    await pageA.goto(generalUrl);
    await pageA.getByRole("button", { name: "Open account settings" }).click();
    await pageA.getByRole("button", { name: "Sign out" }).click();
    await expect(pageA).toHaveURL(`${WEB_ORIGIN}/login`);

    await pageA.getByLabel("Email").fill(userA.email);
    await pageA.getByLabel("Password").fill(userA.password);
    await pageA.getByRole("button", { name: "Sign in" }).click();
    await expect(pageA).toHaveURL(/\/app(\/|$)/);
    await expect(pageA.getByRole("heading", { name: "Verify this device" })).toBeVisible({ timeout: 20_000 });
    await enterRecoveryKey(pageA, recoveryKeyA);

    await pageA.goto(generalUrl);
    await expect(pageA.locator("[data-message-id]").first()).toBeVisible({ timeout: 10_000 });

    await contextA.close();
    await contextB.close();
  });
});
