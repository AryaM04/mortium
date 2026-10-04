// Helpers for the blocking security screens of the web app
// (apps/web/src/components/SecurityGate.tsx). The first device of a new
// account must save a recovery key before it shows the app.
import { expect, type Page } from "@playwright/test";

/** Make the key backup on the "Save your recovery key" screen. Returns the recovery key. */
export async function saveRecoveryKey(page: Page): Promise<string> {
  const heading = page.getByRole("heading", { name: "Save your recovery key" });
  // The screen shows when the crypto layer is ready. That can take some seconds.
  await page.getByRole("button", { name: "Make the recovery key" }).click({ timeout: 30_000 });
  const recoveryKey = (await page.getByTestId("recovery-key").textContent())!.trim();
  await page.getByLabel("Last group of the recovery key").fill(recoveryKey.split(" ").at(-1)!);
  await page.getByRole("button", { name: "Turn on the backup" }).click();
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
