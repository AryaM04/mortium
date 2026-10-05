// The type of the dev-only `window.__cryptoDebug` hook of the web app
// (apps/web/src/lib/crypto.ts), and small helpers that use it.
import { expect, type Page } from "@playwright/test";

declare global {
  interface Window {
    __cryptoDebug?: {
      ready(): boolean;
      identityKeys(): { curve25519: string; ed25519: string } | null;
      sessionCount(): Promise<number>;
      sendPing(userId: string, text: string): Promise<number>;
      received(): Array<{ fromUserId: string; fromDeviceId: string; text: string }>;
      hasMegolmSession(sessionId: string): Promise<boolean>;
      seedMessages(channelId: string, bodies: string[]): Promise<void>;
      security(): { ready: boolean; deviceVerified: boolean };
    };
  }
}

/** Wait until the crypto layer of the page runs. */
export async function waitForCrypto(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.__cryptoDebug?.ready() ?? false), { timeout: 20_000 }).toBe(true);
}

/** Post encrypted messages fast through the real crypto layer of the page, for a history fixture. */
export async function seedMessages(page: Page, channelId: string, bodies: string[]): Promise<void> {
  await waitForCrypto(page);
  await page.evaluate(({ id, texts }) => window.__cryptoDebug!.seedMessages(id, texts), { id: channelId, texts: bodies });
}
