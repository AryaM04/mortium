// End-to-end roles, channel permissions and moderation flow: owner A,
// member B and member C in one guild.
//
// A creates a role "Mods" with MANAGE_CHANNELS and assigns it to B, who
// then sees the "+" to create channels with no reload. A creates a
// private channel (VIEW_CHANNEL denied for @everyone, allowed for
// "Mods"): B sees it, C does not. A removes the role from B: the
// channel disappears for B live. A kicks C: C returns to /app with a
// notice. A bans B with message deletion: B's messages disappear for A.
// B cannot rejoin with the invite. A unbans B: B can rejoin.
//
// Setup (register, guild, channel, invite) goes through the REST API
// directly, since it needs no visual check; each scenario itself drives
// the real UI in three real browser contexts.
//
// Needs a real Postgres (see auth.spec.ts): skips itself when it is not
// reachable.
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

interface ChannelInfo {
  id: string;
  name: string | null;
  type: string;
}

function uniqueUser(label: string): TestUser {
  const stamp = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  return {
    email: `e2e-roles-${stamp}-${label.toLowerCase()}@example.test`,
    username: `e2eroles${stamp.replace(/_/g, "")}${label.toLowerCase()}`.slice(0, 32),
    password: "correct-horse-battery-staple",
    displayName: `Roles ${label} ${stamp}`,
  };
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

async function createGuildApi(request: APIRequestContext, token: string, name: string) {
  const response = await request.post(`${WEB_ORIGIN}/api/v1/guilds`, {
    headers: { authorization: `Bearer ${token}` },
    data: { name },
  });
  if (!response.ok()) {
    throw new Error(`create guild failed: ${response.status()} ${await response.text()}`);
  }
  return (await response.json()) as { id: string; channels: ChannelInfo[] };
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

async function loginThroughUi(page: Page, user: TestUser): Promise<void> {
  await page.goto(`${WEB_ORIGIN}/login`);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app(\/|$)/);
  await saveRecoveryKey(page);
}

function composerBox(page: Page) {
  return page.getByRole("combobox", { name: "Write a message." });
}

async function sendMessage(page: Page, text: string): Promise<void> {
  const box = composerBox(page);
  await box.fill(text);
  await box.press("Enter");
}

async function openServerSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open server menu" }).click();
  await page.getByRole("menuitem", { name: "Server settings" }).click();
  await expect(page.getByRole("dialog", { name: "Server settings" })).toBeVisible();
}

test.describe("roles", () => {
  test("role creation, assignment, channel overwrites, and moderation", async ({ browser, request }) => {
    test.setTimeout(90_000);

    const userA = uniqueUser("A");
    const userB = uniqueUser("B");
    const userC = uniqueUser("C");
    const apiA = await registerApi(request, userA);
    const apiB = await registerApi(request, userB);
    const apiC = await registerApi(request, userC);

    const guild = await createGuildApi(request, apiA.accessToken, "Roles E2E Guild");
    const general = guild.channels.find((c) => c.type === "text" && c.name === "general")!;

    const inviteCode = await createInviteApi(request, apiA.accessToken, general.id);
    await acceptInviteApi(request, apiB.accessToken, inviteCode);
    await acceptInviteApi(request, apiC.accessToken, inviteCode);

    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const contextC = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const pageC = await contextC.newPage();

    await loginThroughUi(pageA, userA);
    await loginThroughUi(pageB, userB);
    await loginThroughUi(pageC, userC);

    const generalUrl = `${WEB_ORIGIN}/app/${guild.id}/${general.id}`;
    await pageA.goto(generalUrl);
    await pageB.goto(generalUrl);
    await pageC.goto(generalUrl);
    await expect(composerBox(pageA)).toBeVisible({ timeout: 15_000 });
    await expect(composerBox(pageB)).toBeVisible({ timeout: 15_000 });
    await expect(composerBox(pageC)).toBeVisible({ timeout: 15_000 });

    // Before any role, B has no "Create channel" menu item.
    await pageB.getByRole("button", { name: "Open server menu" }).click();
    await expect(pageB.getByRole("menuitem", { name: "Create channel" })).toHaveCount(0);
    await pageB.keyboard.press("Escape");

    // 1. A creates role "Mods" with MANAGE_CHANNELS.
    await openServerSettings(pageA);
    const dialogA = pageA.getByRole("dialog", { name: "Server settings" });
    await dialogA.getByRole("button", { name: "Roles", exact: true }).click();
    await dialogA.getByRole("button", { name: /Create role/ }).click();
    const roleNameInput = dialogA.getByLabel("Role name");
    await roleNameInput.fill("Mods");
    await dialogA.getByRole("checkbox", { name: /Manage Channels/ }).check();
    await dialogA.getByRole("button", { name: "Save changes" }).click();
    await expect(dialogA.getByRole("button", { name: "Save changes" })).toHaveCount(0);

    // Assign "Mods" to B, from the Members tab. The role menu is scoped
    // to B's own row (not looked up by name), since a role or nickname
    // change can update the row's displayed name.
    await dialogA.getByRole("button", { name: "Members", exact: true }).click();
    await expect(dialogA.getByText(userB.displayName)).toBeVisible({ timeout: 10_000 });
    const rowB = dialogA.locator("li", { hasText: userB.displayName });
    await rowB.getByRole("button", { name: "Roles", exact: true }).click();
    await rowB.getByRole("menu").getByLabel("Mods").click();
    await expect(rowB.getByRole("menu").getByLabel("Mods")).toBeChecked({ timeout: 10_000 });
    await pageA.keyboard.press("Escape");

    // 2. B sees the "+" to create channels without reload.
    await pageB.getByRole("button", { name: "Open server menu" }).click();
    await expect(pageB.getByRole("menuitem", { name: "Create channel" })).toBeVisible({ timeout: 10_000 });
    await pageB.keyboard.press("Escape");

    // 3. A creates a private channel "secret": deny @everyone, allow "Mods".
    await pageA.keyboard.press("Escape"); // close server settings
    await pageA.getByRole("button", { name: "Open server menu" }).click();
    await pageA.getByRole("menuitem", { name: "Create channel" }).click();
    await pageA.getByRole("dialog", { name: "Create a channel" }).getByLabel("Name", { exact: true }).fill("secret");
    await pageA.getByRole("dialog", { name: "Create a channel" }).getByRole("button", { name: "Create", exact: true }).click();
    await expect(pageA.getByRole("button", { name: /secret/ })).toBeVisible();

    await pageA.locator('[data-channel-row="secret"]').hover();
    await pageA.getByRole("button", { name: "secret settings" }).click();
    const channelDialogA = pageA.getByRole("dialog", { name: "Channel settings" });
    await channelDialogA.getByRole("button", { name: "Permissions", exact: true }).click();

    const addRoleSelect = channelDialogA.getByLabel("Add a role overwrite");
    await addRoleSelect.selectOption({ label: "@everyone" });
    await addRoleSelect.locator("xpath=following-sibling::button[1]").click();
    const viewToggle = channelDialogA.getByRole("button", { name: /View Channel/ });
    await viewToggle.click(); // neutral -> allow
    await viewToggle.click(); // allow -> deny
    await expect(channelDialogA.getByRole("button", { name: "View Channel: deny" })).toBeVisible();

    await addRoleSelect.selectOption({ label: "Mods" });
    await addRoleSelect.locator("xpath=following-sibling::button[1]").click();
    await channelDialogA.getByRole("button", { name: /View Channel/ }).click(); // neutral -> allow
    await expect(channelDialogA.getByRole("button", { name: "View Channel: allow" })).toBeVisible();
    await pageA.keyboard.press("Escape");

    // B (holds Mods) sees #secret live; C (no role) never does.
    await expect(pageB.getByRole("button", { name: /secret/ })).toBeVisible({ timeout: 10_000 });
    await expect(pageC.getByRole("button", { name: /secret/ })).toHaveCount(0);

    // 4. A removes "Mods" from B: #secret disappears for B live.
    await openServerSettings(pageA);
    await dialogA.getByRole("button", { name: "Members", exact: true }).click();
    await rowB.getByRole("button", { name: "Roles", exact: true }).click();
    await rowB.getByRole("menu").getByLabel("Mods").click();
    await expect(rowB.getByRole("menu").getByLabel("Mods")).not.toBeChecked({ timeout: 10_000 });
    await pageA.keyboard.press("Escape");
    await expect(pageB.getByRole("button", { name: /secret/ })).toHaveCount(0, { timeout: 10_000 });

    // 5. A kicks C: C returns to /app with a notice.
    await openServerSettings(pageA);
    await dialogA.getByRole("button", { name: "Members", exact: true }).click();
    const rowC = dialogA.locator("li", { hasText: userC.displayName });
    await expect(rowC).toBeVisible({ timeout: 10_000 });
    await rowC.getByRole("button", { name: "Kick", exact: true }).click();
    await expect(pageC).toHaveURL(`${WEB_ORIGIN}/app`, { timeout: 10_000 });
    await expect(pageC.getByText("You are no longer a member of this server.")).toBeVisible();

    // 6. A bans B, deleting B's recent messages.
    await sendMessage(pageB, "B message before ban");
    await expect(pageA.getByText("B message before ban")).toBeVisible({ timeout: 10_000 });

    await rowB.getByRole("button", { name: "Ban", exact: true }).click();
    const banDialog = pageA.getByRole("dialog", { name: `Ban ${userB.displayName}` });
    await banDialog.getByLabel("Delete messages from the last").selectOption({ label: "Last hour" });
    await banDialog.getByRole("button", { name: "Ban", exact: true }).click();

    // B's message disappears for A once the redaction dispatch lands.
    await expect(pageA.getByText("B message before ban")).toHaveCount(0, { timeout: 10_000 });

    // B cannot rejoin with the old invite: the preview loads, Accept errors.
    await pageB.goto(`${WEB_ORIGIN}/invite/${inviteCode}`);
    await pageB.getByRole("button", { name: "Accept" }).click();
    await expect(pageB.getByRole("alert")).toHaveText(/banned/i);

    // 7. A unbans B: B can rejoin.
    await dialogA.getByRole("button", { name: "Bans", exact: true }).click();
    await expect(dialogA.getByText(new RegExp(apiB.userId))).toBeVisible({ timeout: 10_000 });
    await dialogA.getByRole("button", { name: "Unban", exact: true }).click();
    await expect(dialogA.getByText("Nobody is banned from this server.")).toBeVisible({ timeout: 10_000 });

    await pageB.goto(`${WEB_ORIGIN}/invite/${inviteCode}`);
    await pageB.getByRole("button", { name: "Accept" }).click();
    await expect(pageB).toHaveURL(new RegExp(`/app/${guild.id}/`), { timeout: 10_000 });

    await contextA.close();
    await contextB.close();
    await contextC.close();
  });

  // Regression: the gateway event of a save can come before the HTTP reply.
  // Then the grid shows the new value, but the save still runs. An "Add" in
  // that time made two saves overlap: the first reply enabled the grid of the
  // old overwrite, and the next click changed the wrong overwrite.
  test("a new overwrite waits for the save that runs", async ({ page, request }) => {
    const user = uniqueUser("A");
    const session = await registerApi(request, user);
    const guild = await createGuildApi(request, session.accessToken, "Overwrite Guild");
    const general = guild.channels.find((c) => c.type === "text" && c.name === "general")!;
    const role = await request.post(`${WEB_ORIGIN}/api/v1/guilds/${guild.id}/roles`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
      data: { name: "Mods" },
    });
    expect(role.ok()).toBe(true);

    await loginThroughUi(page, user);
    await page.goto(`${WEB_ORIGIN}/app/${guild.id}/${general.id}`);
    await page.locator('[data-channel-row="general"]').hover();
    await page.getByRole("button", { name: "general settings" }).click();
    const dialog = page.getByRole("dialog", { name: "Channel settings" });
    await dialog.getByRole("button", { name: "Permissions", exact: true }).click();
    const addRoleSelect = dialog.getByLabel("Add a role overwrite");
    const addRoleButton = addRoleSelect.locator("xpath=following-sibling::button[1]");
    await addRoleSelect.selectOption({ label: "@everyone" });
    await addRoleButton.click();
    await dialog.getByRole("button", { name: "View Channel: neutral" }).click();
    await expect(dialog.getByRole("button", { name: "View Channel: allow" })).toBeEnabled();

    // Hold the reply of the next save until the gateway event shows its value.
    let releaseReply: () => void = () => {};
    const replyReleased = new Promise<void>((resolve) => (releaseReply = resolve));
    let held = false;
    await page.route("**/api/v1/channels/*/overwrites/*", async (route) => {
      if (held) {
        await route.continue();
        return;
      }
      held = true;
      const response = await route.fetch();
      await replyReleased;
      await route.fulfill({ response });
    });
    await dialog.getByRole("button", { name: "View Channel: allow" }).click();
    await expect(dialog.getByRole("button", { name: "View Channel: deny" })).toBeVisible();
    await addRoleSelect.selectOption({ label: "Mods" });
    await expect(addRoleButton).toBeDisabled();
    releaseReply();

    await addRoleButton.click();
    await dialog.getByRole("button", { name: /View Channel/ }).click();
    await expect(dialog.getByRole("heading", { name: "Mods" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "View Channel: allow" })).toBeVisible();
    await dialog.getByRole("button", { name: "@ @everyone" }).click();
    await expect(dialog.getByRole("button", { name: "View Channel: deny" })).toBeVisible();
  });
});
