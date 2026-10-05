// Helpers for the blocking security screens of the web app
// (apps/web/src/components/SecurityGate.tsx). The first device of a new
// account makes the key backup by itself and shows the recovery key one
// time. A new sign-in with the password unlocks the device by itself.
import { expect, type Page } from "@playwright/test";

/** Read the recovery key on the "Save your recovery key" screen, and continue. Returns the recovery key. */
export async function saveRecoveryKey(page: Page): Promise<string> {
  const heading = page.getByRole("heading", { name: "Save your recovery key" });
  // The screen shows when the crypto layer is ready. That can take some seconds.
  const key = page.getByTestId("recovery-key");
  await expect(key).toBeVisible({ timeout: 30_000 });
  const recoveryKey = (await key.textContent())!.trim();
  await page.getByRole("button", { name: "Continue" }).click({ timeout: 20_000 });
  await expect(heading).toHaveCount(0, { timeout: 20_000 });
  return recoveryKey;
}

/** Verify a new device with the recovery key on the "Verify this device" screen. */
export async function enterRecoveryKey(page: Page, recoveryKey: string): Promise<void> {
  const heading = page.getByRole("heading", { name: "Verify this device" });
  await page.getByLabel("Recovery key").fill(recoveryKey, { timeout: 30_000 });
  await page.getByRole("button", { name: "Restore from backup" }).click();
  await expect(heading).toHaveCount(0, { timeout: 30_000 });
}

/** Wait until a new sign-in with the password unlocked the device by itself, with no security screen. */
export async function waitForPasswordUnlock(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const security = window.__cryptoDebug?.security();
          return Boolean(security?.ready && security.deviceVerified);
        }),
      { timeout: 40_000 },
    )
    .toBe(true);
  await expect(page.getByRole("heading", { name: "Verify this device" })).toHaveCount(0);
}
