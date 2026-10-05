// End-to-end account flows: register, reload keeps the session, sign out
// and back in, forgot/reset password through a real email, verify email
// through a real email, and a wrong-password error. A new account shows
// its recovery key first. A new sign-in with the password unlocks the
// device by itself. After a reset by email, the recovery key is necessary.
//
// These tests need a real Postgres and a real Mailpit. playwright.config.ts
// checks both are reachable and sets E2E_AUTH_AVAILABLE; when they are not,
// every test here skips with a clear message instead of failing.
import { expect, test } from "@playwright/test";
import { createMailpitClient } from "../lib/mailpit.js";
import { enterRecoveryKey, saveRecoveryKey, waitForPasswordUnlock } from "../lib/recovery-key.js";

const WEB_ORIGIN = "http://localhost:5173";
const MAILPIT_UI_PORT = process.env.MAILPIT_UI_PORT ?? "8025";
const mailpit = createMailpitClient(`http://localhost:${MAILPIT_UI_PORT}`);

test.skip(
  process.env.E2E_AUTH_AVAILABLE !== "true",
  "Postgres or Mailpit is not reachable. Start them with docker compose (see playwright.config.ts).",
);

function uniqueUser() {
  const stamp = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  return {
    email: `e2e-${stamp}@example.test`,
    username: `e2e_${stamp}`,
    password: "correct-horse-battery-staple",
    displayName: `E2E Test ${stamp}`,
  };
}

test.describe("accounts", () => {
  test("register, reload keeps the session, sign out, sign back in", async ({ page }) => {
    const user = uniqueUser();

    await page.goto(`${WEB_ORIGIN}/register`);
    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Username").fill(user.username);
    await page.getByLabel("Display name (optional)").fill(user.displayName);
    await page.getByLabel("Password").fill(user.password);
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page).toHaveURL(`${WEB_ORIGIN}/app`);
    const recoveryKey = await saveRecoveryKey(page);
    await expect(page.getByText(user.displayName)).toBeVisible();

    // Reload: the session must survive from the stored tokens.
    await page.reload();
    await expect(page).toHaveURL(`${WEB_ORIGIN}/app`);
    await expect(page.getByText(user.displayName)).toBeVisible();

    // Sign out through the settings dialog.
    await page.getByRole("button", { name: "Open account settings" }).click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(`${WEB_ORIGIN}/login`);

    // Sign back in. This is a new device: the password unlocks it, with no recovery key step.
    expect(recoveryKey).not.toBe("");
    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Password").fill(user.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(`${WEB_ORIGIN}/app`);
    await waitForPasswordUnlock(page);
    await expect(page.getByText(user.displayName)).toBeVisible();
  });

  test("shows an error message for a wrong password", async ({ page }) => {
    const user = uniqueUser();

    await page.goto(`${WEB_ORIGIN}/register`);
    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Username").fill(user.username);
    await page.getByLabel("Password").fill(user.password);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(`${WEB_ORIGIN}/app`);
    await saveRecoveryKey(page);

    await page.getByRole("button", { name: "Open account settings" }).click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(`${WEB_ORIGIN}/login`);

    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Password").fill("not-the-right-password");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByRole("alert")).toContainText("not correct");
    await expect(page).toHaveURL(`${WEB_ORIGIN}/login`);
  });

  test("forgot password: reset through the Mailpit link, then sign in with the new password and the recovery key", async ({ page }) => {
    const user = uniqueUser();

    await page.goto(`${WEB_ORIGIN}/register`);
    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Username").fill(user.username);
    await page.getByLabel("Password").fill(user.password);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(`${WEB_ORIGIN}/app`);
    const recoveryKey = await saveRecoveryKey(page);

    await page.goto(`${WEB_ORIGIN}/forgot-password`);
    await page.getByLabel("Email").fill(user.email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByText("Check your email")).toBeVisible();

    const token = await mailpit.findHashLinkFor(user.email, "Reset your password", "token");

    const newPassword = "a-brand-new-password-123";
    await page.goto(`${WEB_ORIGIN}/reset-password#token=${token}`);
    await page.getByLabel("New password").fill(newPassword);
    await page.getByRole("button", { name: "Set new password" }).click();
    await expect(page).toHaveURL(`${WEB_ORIGIN}/login`);

    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Password").fill(newPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(`${WEB_ORIGIN}/app`);

    // The reset removed the key wrap. The recovery key verifies the device, and the app stores a new key wrap.
    await expect(page.getByRole("heading", { name: "Verify this device" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Unlock with your password" })).toHaveCount(0);
    await enterRecoveryKey(page, recoveryKey);

    // Now the new password unlocks a new device again.
    await page.getByRole("button", { name: "Open account settings" }).click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(`${WEB_ORIGIN}/login`);
    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Password").fill(newPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(`${WEB_ORIGIN}/app`);
    await waitForPasswordUnlock(page);
  });

  test("verify email through the Mailpit link", async ({ page }) => {
    const user = uniqueUser();

    await page.goto(`${WEB_ORIGIN}/register`);
    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Username").fill(user.username);
    await page.getByLabel("Password").fill(user.password);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(`${WEB_ORIGIN}/app`);
    await saveRecoveryKey(page);
    await expect(page.getByText("Your email address is not verified yet.")).toBeVisible();

    const token = await mailpit.findHashLinkFor(user.email, "Confirm your email address", "token");

    await page.goto(`${WEB_ORIGIN}/verify-email#token=${token}`);
    await expect(page.getByText("Your email address is verified.")).toBeVisible();

    await page.goto(`${WEB_ORIGIN}/app`);
    await expect(page.getByText("Your email address is not verified yet.")).not.toBeVisible();
  });
});
