// End-to-end push-to-talk: one client opens the voice settings dialog,
// switches to push to talk, sets a key, joins a voice channel, and shows
// the mic track stays disabled until the key is held. See
// docs/concepts/voice.md for the call this dialog controls.
import { expect, test, type Page } from "@playwright/test";
import { saveRecoveryKey } from "../lib/recovery-key.js";
import { loadRootEnv } from "../env.js";

loadRootEnv();

interface VoiceDebugStats {
  userId: string;
  deviceId: string;
  connectionState: string;
  selectedCandidateType: string | null;
  inboundBytesReceived: number;
  outboundBytesSent: number;
  inboundVideoBytesReceived: number;
  outboundVideoBytesSent: number;
}

declare global {
  interface Window {
    __voiceDebug?: {
      getStats(): Promise<VoiceDebugStats[]>;
      isLocalTrackEnabled(): boolean | null;
    };
  }
}

const WEB_ORIGIN = "http://localhost:5173";

test.skip(
  process.env.E2E_AUTH_AVAILABLE !== "true",
  "Postgres is not reachable. Start it with docker compose (see playwright.config.ts).",
);

function uniqueUser(label: string) {
  const stamp = `${Date.now()}_${Math.floor(Math.random() * 100000)}_${label}`;
  return {
    email: `e2e-pttset-${stamp}@example.test`,
    username: `e2e_pttset_${stamp}`,
    password: "correct-horse-battery-staple",
    displayName: `P${label}${Date.now().toString(36)}`,
  };
}

async function registerThroughUi(page: Page, user: ReturnType<typeof uniqueUser>): Promise<void> {
  await page.goto(`${WEB_ORIGIN}/register`);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Username").fill(user.username);
  await page.getByLabel("Display name (optional)").fill(user.displayName);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(`${WEB_ORIGIN}/app`);
  await saveRecoveryKey(page);
}

async function createGuild(page: Page, guildName: string): Promise<void> {
  await page.getByRole("button", { name: "Add a server" }).click();
  await page.getByRole("dialog").getByLabel("Server name").fill(guildName);
  await page.getByRole("dialog").getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("button", { name: /General/ })).toBeVisible({ timeout: 10_000 });
}

test.describe("voice settings: push to talk", () => {
  test("the mic track stays disabled until the push-to-talk key is held", async ({ page }) => {
    test.setTimeout(60_000);

    const user = uniqueUser("A");
    await registerThroughUi(page, user);
    await createGuild(page, "E2E PTT Server");

    // Open the voice settings dialog from the user panel, before joining.
    await page.getByRole("button", { name: "Open voice and video settings" }).click();
    await expect(page.getByRole("dialog", { name: "Voice and video settings" })).toBeVisible();
    await page.getByLabel("Push to talk").check();
    await page.getByRole("button", { name: "Set key" }).click();
    await page.keyboard.press("KeyF");
    await expect(page.getByRole("button", { name: /Key: F/ })).toBeVisible();
    await page.getByRole("button", { name: "Done" }).click();

    // Join voice. Push to talk starts closed: the mic track is disabled.
    await page.getByRole("button", { name: /General/ }).click();
    await expect(page.locator('[data-voice-status="connected"]')).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() => page.evaluate(() => window.__voiceDebug!.isLocalTrackEnabled()), { timeout: 10_000 })
      .toBe(false);
    await expect(page.locator('[data-voice-ptt-active="false"]')).toBeVisible();

    // Holding the key opens the mic.
    await page.keyboard.down("KeyF");
    await expect
      .poll(() => page.evaluate(() => window.__voiceDebug!.isLocalTrackEnabled()), { timeout: 5_000 })
      .toBe(true);
    await expect(page.locator('[data-voice-ptt-active="true"]')).toBeVisible();

    // Releasing closes it again (after the short release delay).
    await page.keyboard.up("KeyF");
    await expect
      .poll(() => page.evaluate(() => window.__voiceDebug!.isLocalTrackEnabled()), { timeout: 5_000 })
      .toBe(false);
  });
});
