// End-to-end test of the keyboard shortcuts: the quick switcher, the channel
// keys and the help dialog.
//
// Needs a real Postgres (see auth.spec.ts): skips itself when it is not
// reachable.
import { expect, test, type APIRequestContext } from "@playwright/test";
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

test("the quick switcher, the channel keys and the help dialog work", async ({ page, request }) => {
  test.setTimeout(60_000);
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const user = {
    email: `e2e-keys-${stamp}@example.test`,
    username: `keys${stamp}`.slice(0, 32),
    password: "correct-horse-battery-staple",
    displayName: `Keys ${stamp}`.slice(0, 32),
  };
  const a = await api(request, "/auth/register", undefined, user);
  const guild = await api(request, "/guilds", a.accessToken, { name: "Keys Guild" });
  const general = guild.channels.find((entry: { type: string }) => entry.type === "text");
  const random = await api(request, `/guilds/${guild.id}/channels`, a.accessToken, { name: "random", type: "text" });

  await page.goto(`${WEB_ORIGIN}/login`);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app(\/|$)/);
  await saveRecoveryKey(page);
  await page.goto(`${WEB_ORIGIN}/app/${guild.id}/${general.id}`);
  const composer = page.getByRole("combobox", { name: "Write a message." });
  await expect(composer).toBeVisible({ timeout: 15_000 });

  // The quick switcher opens from the composer, matches with a fuzzy query, and goes to the channel.
  await composer.focus();
  await page.keyboard.press("Control+k");
  const switcher = page.getByRole("dialog", { name: "Quick switcher" });
  await expect(switcher).toBeVisible();
  await page.keyboard.type("rndm");
  await expect(switcher.locator("[data-switcher-result]").first()).toHaveText(/random/);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`${WEB_ORIGIN}/app/${guild.id}/${random.id}`);
  await expect(switcher).toHaveCount(0);

  // Escape closes the switcher. The focus returns to the composer.
  await page.keyboard.press("Control+k");
  await expect(switcher).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(switcher).toHaveCount(0);
  await expect(composer).toBeFocused();

  // The channel keys do not work in a text field, and they work outside it.
  await page.keyboard.press("Alt+ArrowUp");
  await expect(page).toHaveURL(`${WEB_ORIGIN}/app/${guild.id}/${random.id}`);
  await page.getByRole("heading", { level: 1 }).click();
  await page.keyboard.press("Alt+ArrowUp");
  await expect(page).toHaveURL(`${WEB_ORIGIN}/app/${guild.id}/${general.id}`);

  // The help dialog.
  await page.keyboard.press("Control+/");
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(help).toBeVisible();
  await expect(help.getByText("Open the quick switcher.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);
});
