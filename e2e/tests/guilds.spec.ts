// End-to-end guild flow: create a server, invite a second person, watch
// membership, channels and presence update live over the gateway with no
// reload, reorder channels by drag-and-drop, and check a permission gate.
//
// Needs a real Postgres (see auth.spec.ts): skips itself when it is not
// reachable.
import { expect, test, type Page } from "@playwright/test";
import { saveRecoveryKey } from "../lib/recovery-key.js";

const WEB_ORIGIN = "http://localhost:5173";

test.skip(
  process.env.E2E_AUTH_AVAILABLE !== "true",
  "Postgres is not reachable. Start it with docker compose (see playwright.config.ts).",
);

function uniqueUser(label: string) {
  const stamp = `${Date.now()}_${Math.floor(Math.random() * 100000)}_${label}`;
  return {
    email: `e2e-${stamp}@example.test`,
    username: `e2e_${stamp}`,
    password: "correct-horse-battery-staple",
    displayName: `E2E ${label} ${stamp}`,
  };
}

async function registerThroughUi(page: Page, user: ReturnType<typeof uniqueUser>) {
  await page.goto(`${WEB_ORIGIN}/register`);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Username").fill(user.username);
  await page.getByLabel("Display name (optional)").fill(user.displayName);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(`${WEB_ORIGIN}/app`);
  await saveRecoveryKey(page);
}

test.describe("guilds", () => {
  test("create, invite, live membership, channels, presence, reorder", async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    const userA = uniqueUser("A");
    const userB = uniqueUser("B");
    await registerThroughUi(pageA, userA);
    await registerThroughUi(pageB, userB);

    // A creates a server.
    await pageA.getByRole("button", { name: "Add a server" }).click();
    await pageA.getByRole("dialog").getByLabel("Server name").fill("E2E Test Server");
    await pageA.getByRole("dialog").getByRole("button", { name: "Create", exact: true }).click();

    // Default channels are shown.
    await expect(pageA.getByRole("button", { name: /general/ })).toBeVisible();
    await expect(pageA.getByText("Text channels")).toBeVisible();
    await expect(pageA.getByText("Voice channels")).toBeVisible();

    // A creates an invite and copies the URL.
    await pageA.getByRole("button", { name: "Open server menu" }).click();
    await pageA.getByRole("menuitem", { name: "Invite people" }).click();
    await pageA.getByRole("dialog").getByRole("button", { name: "Generate invite" }).click();
    const inviteUrl = await pageA.getByRole("dialog").getByLabel("Invite link").inputValue();
    expect(inviteUrl).toContain("/invite/");
    await pageA.getByRole("dialog").getByRole("button", { name: "Done" }).click();

    // B opens the invite and accepts it.
    await pageB.goto(inviteUrl);
    await pageB.getByRole("button", { name: "Accept" }).click();
    await expect(pageB.getByRole("button", { name: /general/ })).toBeVisible();

    // A sees B appear in Online members, with no reload.
    await expect(pageA.getByText(userB.displayName)).toBeVisible({ timeout: 10_000 });
    await expect(pageA.getByText("Online (2)")).toBeVisible();

    // A creates a channel "plans" inside the Text channels category.
    await pageA.hover("text=Text channels");
    await pageA.getByRole("button", { name: "Create a channel in Text channels" }).click();
    await pageA.getByRole("dialog").getByLabel("Name", { exact: true }).fill("plans");
    await pageA.getByRole("dialog").getByRole("button", { name: "Create", exact: true }).click();
    await expect(pageA.getByRole("button", { name: /plans/ })).toBeVisible();

    // B sees #plans appear live, with no reload.
    await expect(pageB.getByRole("button", { name: /plans/ })).toBeVisible({ timeout: 10_000 });

    // A renames it; B sees the new name, with no reload.
    await pageA.locator('[data-channel-row="plans"]').hover();
    await pageA.getByRole("button", { name: "plans settings" }).click();
    await pageA.getByRole("dialog").getByLabel("Name", { exact: true }).fill("plans-renamed");
    await pageA.getByRole("dialog").getByRole("button", { name: "Save" }).click();
    await expect(pageA.getByRole("button", { name: /plans-renamed/ })).toBeVisible();
    await expect(pageB.getByRole("button", { name: /plans-renamed/ })).toBeVisible({ timeout: 10_000 });

    // A user without MANAGE_CHANNELS (B) does not see the "+" on categories.
    await expect(pageB.getByRole("button", { name: /^Create a channel in/ })).toHaveCount(0);

    // B closes the page; A sees B move to Offline within a few seconds.
    await contextB.close();
    await expect(pageA.getByText("Offline (1)")).toBeVisible({ timeout: 10_000 });

    // A reorders channels with drag-and-drop: drag "plans-renamed" above "general".
    const dragged = pageA.locator('[data-channel-row="plans-renamed"]');
    const target = pageA.locator('[data-channel-row="general"]');
    await dragged.dragTo(target);

    // The order persists after reload.
    await pageA.reload();
    await expect(pageA.getByRole("button", { name: /general/ })).toBeVisible();
    const rowNames = await pageA.locator("[data-channel-row]").evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute("data-channel-row")),
    );
    const plansIndex = rowNames.indexOf("plans-renamed");
    const generalIndex = rowNames.indexOf("general");
    expect(plansIndex).toBeGreaterThanOrEqual(0);
    expect(plansIndex).toBeLessThan(generalIndex);

    await contextA.close();
  });
});
