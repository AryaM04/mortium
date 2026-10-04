// End-to-end test of the local search: the tab indexes the messages that
// it decrypts. A search finds a message, the from:, in: and has: filters
// work, and a click on an old result loads its page and shows it.
//
// Needs a real Postgres (see auth.spec.ts): skips itself when it is not
// reachable.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { seedMessages, waitForCrypto } from "../lib/crypto-debug.js";
import { saveRecoveryKey } from "../lib/recovery-key.js";

const WEB_ORIGIN = "http://localhost:5173";

test.skip(
  process.env.E2E_AUTH_AVAILABLE !== "true",
  "Postgres is not reachable. Start it with docker compose (see playwright.config.ts).",
);

function uniqueUser(label: string) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
  return {
    email: `e2e-search-${stamp}-${label.toLowerCase()}@example.test`,
    username: `search${stamp}${label.toLowerCase()}`.slice(0, 32),
    password: "correct-horse-battery-staple",
    displayName: `Search ${label} ${stamp}`,
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

async function search(page: Page, query: string) {
  const box = page.getByRole("searchbox", { name: "Search messages" });
  await box.fill(query);
  await box.press("Enter");
  const panel = page.getByRole("dialog", { name: "Search results" });
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-search-state="done"]')).toBeVisible({ timeout: 15_000 });
  return panel;
}

test("search finds a message, the filters work, and a click shows the message", async ({ page, request }) => {
  test.setTimeout(180_000);
  const user = uniqueUser("A");
  const a = await api(request, "/auth/register", undefined, user);
  const guild = await api(request, "/guilds", a.accessToken, { name: "Search Guild" });
  const general = guild.channels.find((entry: { type: string }) => entry.type === "text");
  const random = await api(request, `/guilds/${guild.id}/channels`, a.accessToken, { name: "random", type: "text" });

  await page.goto(`${WEB_ORIGIN}/login`);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app(\/|$)/);
  await waitForCrypto(page);
  await saveRecoveryKey(page);
  await page.goto(`${WEB_ORIGIN}/app/${guild.id}/${random.id}`);

  // The oldest message of #general is far above the first page (50 events).
  const fillers = Array.from({ length: 55 }, (_, i) => `filler number ${i}`);
  await seedMessages(page, general.id, ["The Crème brûlée recipe is here", ...fillers]);
  await seedMessages(page, random.id, ["a creme link https://example.test/page", "nothing to see"]);

  // Diacritics and case fold: "creme" finds both messages, newest first.
  let panel = await search(page, "CREME");
  await expect(panel.locator("[data-search-result]")).toHaveCount(2);
  await expect(panel.getByText("Search shows only messages this device has seen.")).toBeVisible();
  await expect(panel.locator("[data-search-result]").first()).toContainText("#random");

  // Filters.
  panel = await search(page, "creme in:#general");
  await expect(panel.locator("[data-search-result]")).toHaveCount(1);
  panel = await search(page, "has:link");
  await expect(panel.locator("[data-search-result]")).toHaveCount(1);
  await expect(panel.locator("[data-search-result]")).toContainText("example.test");
  panel = await search(page, `creme from:@${user.username}`);
  await expect(panel.locator("[data-search-result]")).toHaveCount(2);
  panel = await search(page, "creme from:@nobody");
  await expect(panel.getByText("No message matches.")).toBeVisible();

  // A click on the old #general message opens the channel and shows it.
  panel = await search(page, "recipe");
  const result = panel.locator("[data-search-result]");
  await expect(result).toHaveCount(1);
  const eventId = await result.getAttribute("data-search-result");
  await result.click();
  await expect(page).toHaveURL(new RegExp(`/app/${guild.id}/${general.id}$`));
  const row = page.locator(`[data-message-id="${eventId}"]`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).toContainText("Crème brûlée");
  await expect(row).toBeInViewport();
});

// Regression: the page around the message fits on a tall screen, so the list
// is at the bottom. The list then loads the next page. It must not follow the
// new rows to the bottom: the message must stay on the screen.
test("a jump keeps the message on the screen when the next page loads", async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 1100 });
  const user = uniqueUser("B");
  const a = await api(request, "/auth/register", undefined, user);
  const guild = await api(request, "/guilds", a.accessToken, { name: "Jump Guild" });
  const general = guild.channels.find((entry: { type: string }) => entry.type === "text");
  const random = await api(request, `/guilds/${guild.id}/channels`, a.accessToken, { name: "random", type: "text" });

  await page.goto(`${WEB_ORIGIN}/login`);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app(\/|$)/);
  await waitForCrypto(page);
  await saveRecoveryKey(page);
  await page.goto(`${WEB_ORIGIN}/app/${guild.id}/${random.id}`);
  const fillers = Array.from({ length: 55 }, (_, i) => `filler number ${i}`);
  await seedMessages(page, general.id, ["The pancake recipe is here", ...fillers]);

  const panel = await search(page, "pancake");
  const result = panel.locator("[data-search-result]");
  await expect(result).toHaveCount(1);
  const eventId = await result.getAttribute("data-search-result");
  await result.click();
  // The next page makes the list longer than the screen, so the list is not at the bottom.
  await expect(page.getByRole("button", { name: "Jump to present" })).toBeVisible();
  const row = page.locator(`[data-message-id="${eventId}"]`);
  await expect(row).toBeVisible();
  await expect(row).toBeInViewport();
});
