// End-to-end test of encrypted attachments: A sends an image and a text
// file. B sees the thumbnail, opens the lightbox and downloads the file
// with the same bytes. The files on the server disk are not the plaintext.
//
// Needs a real Postgres (see auth.spec.ts): skips itself when it is not
// reachable.
import { readFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { saveRecoveryKey } from "../lib/recovery-key.js";
import { waitForCrypto } from "../lib/crypto-debug.js";
import { E2E_DATABASE_NAME } from "../lib/ensure-e2e-db.js";

const WEB_ORIGIN = "http://localhost:5173";

test.skip(
  process.env.E2E_AUTH_AVAILABLE !== "true",
  "Postgres is not reachable. Start it with docker compose (see playwright.config.ts).",
);

function uniqueUser(label: string) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
  return {
    email: `e2e-files-${stamp}-${label.toLowerCase()}@example.test`,
    username: `files${stamp}${label.toLowerCase()}`.slice(0, 32),
    password: "correct-horse-battery-staple",
    displayName: `Files ${label} ${stamp}`,
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

/** Draw a 400 x 300 PNG in the page, so the test needs no image file. */
async function makePng(page: Page): Promise<Buffer> {
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 300;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#3366ff";
    context.fillRect(0, 0, 400, 300);
    context.fillStyle = "#ffcc00";
    context.fillRect(50, 50, 200, 100);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  return Buffer.from(base64, "base64");
}

test("an encrypted image and file go from A to B, and the server stores only ciphertext", async ({ browser, request }) => {
  test.setTimeout(120_000);
  const userA = uniqueUser("A");
  const userB = uniqueUser("B");
  const a = await api(request, "/auth/register", undefined, userA);
  const b = await api(request, "/auth/register", undefined, userB);
  const guild = await api(request, "/guilds", a.accessToken, { name: "Files Guild" });
  const channel = guild.channels.find((entry: { type: string }) => entry.type === "text");
  const invite = await api(request, `/channels/${channel.id}/invites`, a.accessToken);
  await api(request, `/invites/${invite.code}`, b.accessToken);

  const pageA = await (await browser.newContext({ acceptDownloads: true })).newPage();
  const pageB = await (await browser.newContext({ acceptDownloads: true })).newPage();
  await loginThroughUi(pageA, userA);
  await loginThroughUi(pageB, userB);
  await Promise.all([waitForCrypto(pageA), waitForCrypto(pageB)]);
  const channelUrl = `${WEB_ORIGIN}/app/${guild.id}/${channel.id}`;
  await pageA.goto(channelUrl);
  await pageB.goto(channelUrl);

  // 1. A attaches an image and a text file, and sends them with a text.
  const png = await makePng(pageA);
  const text = `a secret file ${Date.now()}\n`;
  await pageA.getByLabel("Files to attach").setInputFiles([
    { name: "picture.png", mimeType: "image/png", buffer: png },
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from(text, "utf8") },
  ]);
  await expect(pageA.locator('[data-upload-state="ready"]')).toHaveCount(2, { timeout: 20_000 });
  const box = pageA.getByRole("combobox", { name: "Write a message." });
  await box.fill("two files");
  await box.press("Enter");

  // 2. B sees the thumbnail and opens the full image in the lightbox.
  const row = pageB.locator("[data-message-id]", { hasText: "two files" });
  await expect(row).toBeVisible({ timeout: 15_000 });
  const thumbnail = row.getByTestId("attachment-thumbnail");
  await expect(thumbnail).toBeVisible({ timeout: 15_000 });
  expect(await thumbnail.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(320);
  await row.getByRole("button", { name: "Open the image picture.png" }).click();
  const full = pageB.getByTestId("lightbox-image");
  await expect(full).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => full.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(400);
  await pageB.getByRole("button", { name: "Close" }).click();

  // 3. B downloads the text file, and the bytes match.
  const downloadPromise = pageB.waitForEvent("download");
  await row.getByRole("button", { name: "Download notes.txt" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("notes.txt");
  expect(await readFile((await download.path())!, "utf8")).toBe(text);

  // 4. The files on disk are ciphertext, and the message claimed them.
  const sql = postgres(
    `postgres://${process.env.POSTGRES_USER ?? "mortium"}:${encodeURIComponent(process.env.POSTGRES_PASSWORD ?? "")}@${process.env.POSTGRES_HOST ?? "localhost"}:${process.env.POSTGRES_PORT ?? "5432"}/${E2E_DATABASE_NAME}`,
    { max: 1 },
  );
  try {
    const rows = await sql<Array<{ storage_path: string; size: number; claimed_at: Date | null }>>`
      select storage_path, size, claimed_at from attachments where channel_id = ${channel.id}`;
    // The image, its thumbnail and the text file.
    expect(rows).toHaveLength(3);
    await expect.poll(async () => (await sql`select 1 from attachments where channel_id = ${channel.id} and claimed_at is null`).length).toBe(0);
    const stored = await Promise.all(rows.map((entry) => readFile(path.join(process.env.E2E_DATA_DIR!, "attachments", entry.storage_path))));
    for (const bytes of stored) {
      expect(bytes.includes(Buffer.from("a secret file", "utf8"))).toBe(false);
      expect(bytes.subarray(0, 8).equals(png.subarray(0, 8))).toBe(false);
    }
    expect(rows.map((entry) => entry.size)).toContain(Buffer.byteLength(text) + 16);
  } finally {
    await sql.end();
  }
});
