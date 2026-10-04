// Accessibility check with axe-core. The test opens the main screens of the
// app and fails on any serious or critical violation.
//
// Needs a real Postgres (see auth.spec.ts): skips itself when it is not
// reachable.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { seedMessages, waitForCrypto } from "../lib/crypto-debug.js";
import { saveRecoveryKey } from "../lib/recovery-key.js";

const WEB_ORIGIN = "http://localhost:5173";

test.skip(
  process.env.E2E_AUTH_AVAILABLE !== "true",
  "Postgres is not reachable. Start it with docker compose (see playwright.config.ts).",
);

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

function uniqueUser(label: string) {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  return {
    email: `e2e-a11y-${stamp}-${label}@example.test`,
    username: `a11y${stamp}${label}`.slice(0, 32),
    password: "correct-horse-battery-staple",
    displayName: `Ally ${label}${stamp}`.slice(0, 32),
  };
}

/** Run axe on the page and fail on each serious or critical violation. */
async function expectNoSeriousViolations(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  const report = serious.map(
    (v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => `${n.target.join(" ")} ${n.html.slice(0, 90)}`).join(" | ")}`,
  );
  expect.soft(report, `axe violations on ${label}`).toEqual([]);
}

test("the main screens have no serious accessibility violation", async ({ page, request }) => {
  test.setTimeout(120_000);

  await page.goto(`${WEB_ORIGIN}/login`);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expectNoSeriousViolations(page, "login");

  await page.goto(`${WEB_ORIGIN}/register`);
  await expect(page.getByRole("button", { name: "Create account" })).toBeVisible();
  await expectNoSeriousViolations(page, "register");

  const user = uniqueUser("a");
  const friend = uniqueUser("b");
  const a = await api(request, "/auth/register", undefined, user);
  const b = await api(request, "/auth/register", undefined, friend);
  const guild = await api(request, "/guilds", a.accessToken, { name: "Access Guild" });
  const general = guild.channels.find((entry: { type: string }) => entry.type === "text");
  await api(request, `/guilds/${guild.id}/channels`, a.accessToken, { name: "second", type: "text" });
  await request.post(`${WEB_ORIGIN}/api/v1/users/@me/relationships`, {
    headers: { authorization: `Bearer ${a.accessToken}` },
    data: { username: friend.username },
  });
  await request.put(`${WEB_ORIGIN}/api/v1/users/@me/relationships/${a.user.id}`, {
    headers: { authorization: `Bearer ${b.accessToken}` },
    data: { action: "accept" },
  });
  const dm = await api(request, "/users/@me/channels", a.accessToken, { recipientIds: [b.user.id] });

  await page.goto(`${WEB_ORIGIN}/login`);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app(\/|$)/);
  await waitForCrypto(page);

  // The recovery key screen of a new account.
  await expect(page.getByRole("heading", { name: "Save your recovery key" })).toBeVisible({ timeout: 20_000 });
  await expectNoSeriousViolations(page, "recovery key");
  await saveRecoveryKey(page);

  // The app shell with a guild and a chat.
  await page.goto(`${WEB_ORIGIN}/app/${guild.id}/${general.id}`);
  await expect(page.getByRole("combobox", { name: "Write a message." })).toBeVisible({ timeout: 15_000 });
  await seedMessages(page, general.id, ["first message about creme", "second message"]);
  await expect(page.getByText("second message")).toBeVisible();
  await expectNoSeriousViolations(page, "app shell");

  // Search results.
  const box = page.getByRole("searchbox", { name: "Search messages" });
  await box.fill("creme");
  await box.press("Enter");
  const panel = page.getByRole("dialog", { name: "Search results" });
  await expect(panel.locator('[data-search-state="done"]')).toBeVisible({ timeout: 15_000 });
  await expectNoSeriousViolations(page, "search results");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);

  // The emoji picker.
  await page.getByRole("button", { name: "Open the emoji picker" }).click();
  await expect(page.getByRole("dialog", { name: /emoji/i }).or(page.locator("[data-emoji-picker]"))).toBeVisible();
  await expectNoSeriousViolations(page, "emoji picker");
  await page.keyboard.press("Escape");

  // The quick switcher and the shortcuts help.
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "Quick switcher" })).toBeVisible();
  await expectNoSeriousViolations(page, "quick switcher");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+/");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await expectNoSeriousViolations(page, "shortcuts help");
  await page.keyboard.press("Escape");

  // Server settings, roles tab.
  await page.getByRole("button", { name: "Open server menu" }).click();
  await page.getByRole("menuitem", { name: "Server settings" }).click();
  const settings = page.getByRole("dialog", { name: "Server settings" });
  await settings.getByRole("button", { name: "Roles", exact: true }).click();
  await expect(settings.getByRole("button", { name: /Create role/ })).toBeVisible();
  await expectNoSeriousViolations(page, "server settings roles");
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);

  // Channel settings, permissions tab.
  await page.locator('[data-channel-row="general"]').hover();
  await page.getByRole("button", { name: "general settings" }).click();
  const channelDialog = page.getByRole("dialog", { name: "Channel settings" });
  await channelDialog.getByRole("button", { name: "Permissions", exact: true }).click();
  await expect(channelDialog.getByLabel("Add a role overwrite")).toBeVisible();
  await expectNoSeriousViolations(page, "channel permissions");
  await page.keyboard.press("Escape");
  await expect(channelDialog).toHaveCount(0);

  // The voice settings dialog.
  await page.getByRole("button", { name: "Open voice and video settings" }).click();
  await expect(page.getByRole("dialog", { name: "Voice and video settings" })).toBeVisible();
  await expectNoSeriousViolations(page, "voice settings");
  await page.getByRole("button", { name: "Done" }).click();

  // Home and friends.
  await page.getByRole("link", { name: "Home" }).click();
  await expect(page).toHaveURL(`${WEB_ORIGIN}/app/@me`);
  await page.getByRole("tab", { name: "All", exact: true }).click();
  await expect(page.locator(`[data-friend-row="${friend.username}"]`)).toBeVisible({ timeout: 10_000 });
  await expectNoSeriousViolations(page, "home");

  // A DM.
  await page.goto(`${WEB_ORIGIN}/app/@me/${dm.id}`);
  await expect(page.getByRole("combobox", { name: "Write a message." })).toBeVisible({ timeout: 15_000 });
  await expectNoSeriousViolations(page, "direct message");
});

test("the download page has no serious accessibility violation", async ({ page }) => {
  await page.route("**/api/v1/desktop/latest", (route) =>
    route.fulfill({
      json: {
        version: "0.2.0",
        publishedAt: "2026-09-30T12:00:00Z",
        notesUrl: "https://github.com/AryaM04/mortium/releases/tag/v0.2.0",
        assets: [
          { platform: "windows", kind: "installer", name: "Mortium_0.2.0_x64-setup.exe", size: 5_000_000, url: "https://example.test/a.exe" },
          { platform: "macos", kind: "dmg", name: "Mortium_0.2.0_aarch64.dmg", size: 7_000_000, url: "https://example.test/a.dmg" },
          { platform: "linux", kind: "appimage", name: "mortium-0.2.0-x86_64.AppImage", size: 8_000_000, url: "https://example.test/a.AppImage" },
          { platform: "linux", kind: "deb", name: "mortium-0.2.0-amd64.deb", size: 4_000_000, url: "https://example.test/a.deb" },
        ],
      },
    }),
  );
  await page.goto(`${WEB_ORIGIN}/download`);
  await expect(page.getByRole("heading", { name: "Download Mortium" })).toBeVisible();
  await expect(page.getByText("Version 0.2.0")).toBeVisible();
  await expectNoSeriousViolations(page, "download");
});
