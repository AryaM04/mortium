// End-to-end test of sender-side link previews: A writes a link to a local
// fixture page with OpenGraph tags. The composer shows the preview card.
// A sends, and B sees the card (title, description, site name, image)
// without a request to the page. The server log holds no URL.
//
// Needs a real Postgres (see auth.spec.ts): skips itself when it is not
// reachable. The e2e server runs with LINK_PREVIEW_TEST_ALLOW_LOOPBACK, so
// it can fetch the fixture page on localhost (see playwright.config.ts).
import { existsSync, readFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { saveRecoveryKey } from "../lib/recovery-key.js";
import { waitForCrypto } from "../lib/crypto-debug.js";

const WEB_ORIGIN = "http://localhost:5173";
const FIXTURE_ORIGIN = "http://localhost:4310";

test.skip(
  process.env.E2E_AUTH_AVAILABLE !== "true",
  "Postgres is not reachable. Start it with docker compose (see playwright.config.ts).",
);

function uniqueUser(label: string) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
  return {
    email: `e2e-link-${stamp}-${label.toLowerCase()}@example.test`,
    username: `link${stamp}${label.toLowerCase()}`.slice(0, 32),
    password: "correct-horse-battery-staple",
    displayName: `Link ${label} ${stamp}`,
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

async function loginThroughUi(page: Page, user: ReturnType<typeof uniqueUser>): Promise<void> {
  await page.goto(`${WEB_ORIGIN}/login`);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app(\/|$)/);
  await saveRecoveryKey(page);
}

test("A sends a link with a preview, and B sees the card without a fetch of the page", async ({
  browser,
  request,
}) => {
  test.setTimeout(90_000);
  const userA = uniqueUser("A");
  const userB = uniqueUser("B");
  const a = await api(request, "/auth/register", undefined, userA);
  const b = await api(request, "/auth/register", undefined, userB);
  const guild = await api(request, "/guilds", a.accessToken, { name: "Link Guild" });
  const channel = guild.channels.find((entry: { type: string }) => entry.type === "text");
  const invite = await api(request, `/channels/${channel.id}/invites`, a.accessToken);
  await api(request, `/invites/${invite.code}`, b.accessToken);

  const pageA = await (await browser.newContext()).newPage();
  const pageB = await (await browser.newContext()).newPage();
  const fixtureRequestsOfB: string[] = [];
  pageB.on("request", (sent) => {
    if (sent.url().startsWith(FIXTURE_ORIGIN)) {
      fixtureRequestsOfB.push(sent.url());
    }
  });
  await loginThroughUi(pageA, userA);
  await loginThroughUi(pageB, userB);
  await Promise.all([waitForCrypto(pageA), waitForCrypto(pageB)]);
  const channelUrl = `${WEB_ORIGIN}/app/${guild.id}/${channel.id}`;
  await pageA.goto(channelUrl);
  await pageB.goto(channelUrl);

  // 1. A writes the link. The composer shows the preview card.
  const marker = `m${Date.now()}`;
  const link = `${FIXTURE_ORIGIN}/og-page?marker=${marker}`;
  const box = pageA.getByRole("combobox", { name: "Write a message." });
  await box.fill(`read this ${link}`);
  const draftCard = pageA.locator('[data-link-preview-state="ready"]').getByTestId("link-embed");
  await expect(draftCard).toBeVisible({ timeout: 15_000 });
  await expect(draftCard).toContainText("The Fixture Article");
  await expect(draftCard.getByRole("button", { name: "Remove preview" })).toBeVisible();
  await box.press("Enter");

  // 2. B sees the card with the title, the description, the site name and the image.
  const row = pageB.locator("[data-message-id]", { hasText: "read this" });
  await expect(row).toBeVisible({ timeout: 15_000 });
  const card = row.getByTestId("link-embed");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.getByRole("link", { name: "The Fixture Article" })).toHaveAttribute(
    "href",
    link,
  );
  await expect(card).toContainText("A page with OpenGraph tags for the link preview test.");
  await expect(card).toContainText("Fixture News");
  const image = card.getByTestId("link-embed-image");
  await expect(image).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBe(16);

  // 3. B never fetched the page or its image.
  expect(fixtureRequestsOfB).toEqual([]);

  // 4. The server log holds no part of the URL. The log file exists only
  //    when this run started the server (a reused local server logs to
  //    its own output), so CI always checks it.
  const logPath = process.env.E2E_SERVER_LOG!;
  if (process.env.CI || existsSync(logPath)) {
    const log = readFileSync(logPath, "utf8");
    expect(log.length).toBeGreaterThan(0);
    expect(log).not.toContain(marker);
    expect(log).not.toContain("og-page");
  }
});
