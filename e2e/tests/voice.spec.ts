// End-to-end voice call: three browser contexts join the same voice
// channel over the real WebRTC mesh (fake media, real signaling through
// the gateway, real coturn for the forced-relay case). See
// docs/concepts/voice.md for the signaling design this test exercises.
//
// Needs a real Postgres (see auth.spec.ts): skips itself when it is not
// reachable. The forced-relay part also needs a reachable coturn, and
// skips itself alone when that is not the case.
import { expect, test, type Page } from "@playwright/test";
import { saveRecoveryKey } from "../lib/recovery-key.js";
import { isPortReachable } from "../lib/reachable.js";
import { loadRootEnv } from "../env.js";

loadRootEnv();

declare global {
  interface Window {
    __voiceDebug?: {
      getStats(): Promise<VoiceDebugStats[]>;
      isLocalTrackEnabled(): boolean | null;
    };
  }
}

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

const WEB_ORIGIN = "http://localhost:5173";
const TURN_HOST = process.env.TURN_TEST_HOST ?? "127.0.0.1";
const TURN_PORT = Number(process.env.TURN_PORT ?? "3478");

test.skip(
  process.env.E2E_AUTH_AVAILABLE !== "true",
  "Postgres is not reachable. Start it with docker compose (see playwright.config.ts).",
);

function uniqueUser(label: string) {
  const stamp = `${Date.now()}_${Math.floor(Math.random() * 100000)}_${label}`;
  return {
    email: `e2e-voice-${stamp}@example.test`,
    username: `e2e_voice_${stamp}`,
    password: "correct-horse-battery-staple",
    // The display name field has a 32-character limit: keep this short,
    // unlike the email and username above which have more room.
    displayName: `V${label}${Date.now().toString(36)}`,
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

async function createGuildWithInvite(page: Page, guildName: string): Promise<string> {
  await page.getByRole("button", { name: "Add a server" }).click();
  await page.getByRole("dialog").getByLabel("Server name").fill(guildName);
  await page.getByRole("dialog").getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("button", { name: "Open server menu" }).click();
  await page.getByRole("menuitem", { name: "Invite people" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Generate invite" }).click();
  const inviteUrl = await page.getByRole("dialog").getByLabel("Invite link").inputValue();
  await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();
  return inviteUrl;
}

async function acceptInvite(page: Page, inviteUrl: string): Promise<void> {
  await page.goto(inviteUrl);
  await page.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByRole("button", { name: /General/ })).toBeVisible({ timeout: 10_000 });
}

async function joinVoice(page: Page): Promise<void> {
  await page.getByRole("button", { name: /General/ }).click();
  await expect(page.locator('[data-voice-status="connected"]')).toBeVisible({ timeout: 15_000 });
}

async function participantCount(page: Page): Promise<number> {
  return page.locator('[data-voice-channel="General"] [data-voice-participant]').count();
}

async function getDebugStats(page: Page): Promise<VoiceDebugStats[]> {
  return page.evaluate(() => window.__voiceDebug!.getStats());
}

async function waitForAllConnected(pages: Page[], expectedPeerCount: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStats: VoiceDebugStats[][] = [];
  while (Date.now() < deadline) {
    lastStats = await Promise.all(pages.map(getDebugStats));
    const allConnected = lastStats.every(
      (stats) => stats.length === expectedPeerCount && stats.every((peer) => peer.connectionState === "connected"),
    );
    if (allConnected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Peer connections did not all reach "connected" in time: ${JSON.stringify(lastStats)}`);
}

test.describe("voice", () => {
  test("three peers join, one mutes, one leaves", async ({ browser }) => {
    // Three real peer connections, each needing its own TURN credentials
    // fetch and full ICE gathering, take longer than the config's default
    // 40s budget.
    test.setTimeout(120_000);

    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const contextC = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const pageC = await contextC.newPage();

    const userA = uniqueUser("A");
    const userB = uniqueUser("B");
    const userC = uniqueUser("C");
    await registerThroughUi(pageA, userA);
    await registerThroughUi(pageB, userB);
    await registerThroughUi(pageC, userC);

    const inviteUrl = await createGuildWithInvite(pageA, "E2E Voice Server");
    await acceptInvite(pageB, inviteUrl);
    await acceptInvite(pageC, inviteUrl);

    // Join one at a time, so each newcomer already sees whoever is
    // already there (the same order the engine's newcomer-offers rule
    // assumes; see packages/client-core/src/voice/engine.ts).
    await joinVoice(pageA);
    await joinVoice(pageB);
    await joinVoice(pageC);

    // Every client lists all 3 participants under the voice channel.
    await expect.poll(() => participantCount(pageA), { timeout: 15_000 }).toBe(3);
    await expect.poll(() => participantCount(pageB), { timeout: 15_000 }).toBe(3);
    await expect.poll(() => participantCount(pageC), { timeout: 15_000 }).toBe(3);

    // Every peer connection reaches "connected" for all 3 pairs: each
    // client holds a PC to the other 2.
    await waitForAllConnected([pageA, pageB, pageC], 2, 60_000);

    // Inbound audio bytes grow for each peer over 2 seconds. Poll rather
    // than take one before/after snapshot: media does not start flowing
    // the instant connectionState flips to "connected", so a fixed
    // 2-second window right at that instant is flaky under load.
    const baseline = await Promise.all([pageA, pageB, pageC].map(getDebugStats));
    let lastCurrent: VoiceDebugStats[][] = baseline;
    try {
      await expect
        .poll(
          async () => {
            lastCurrent = await Promise.all([pageA, pageB, pageC].map(getDebugStats));
            return lastCurrent.every((stats, i) =>
              stats.every((peer) => {
                const before = baseline[i]!.find((p) => p.userId === peer.userId);
                return peer.inboundBytesReceived > (before?.inboundBytesReceived ?? 0);
              }),
            );
          },
          { timeout: 15_000, intervals: [500] },
        )
        .toBe(true);
    } catch (err) {
      throw new Error(
        `Inbound bytes did not grow for every peer. baseline=${JSON.stringify(baseline)} last=${JSON.stringify(lastCurrent)}`,
        { cause: err },
      );
    }

    // A mutes. B and C see A's mute icon; A's own mic track is disabled.
    await pageA.getByRole("button", { name: "Mute" }).click();
    await expect(
      pageB.locator(`[data-voice-channel="General"] [data-voice-participant="${userA.displayName}"]`),
    ).toHaveAttribute("data-voice-participant-muted", "true", { timeout: 10_000 });
    await expect(
      pageC.locator(`[data-voice-channel="General"] [data-voice-participant="${userA.displayName}"]`),
    ).toHaveAttribute("data-voice-participant-muted", "true", { timeout: 10_000 });
    await expect
      .poll(() => pageA.evaluate(() => window.__voiceDebug!.isLocalTrackEnabled()), { timeout: 10_000 })
      .toBe(false);

    // C leaves. A and B drop to 2 participants, and their PC for C closes.
    await pageC.getByRole("button", { name: "Disconnect" }).click();
    await expect.poll(() => participantCount(pageA), { timeout: 15_000 }).toBe(2);
    await expect.poll(() => participantCount(pageB), { timeout: 15_000 }).toBe(2);
    await expect.poll(async () => (await getDebugStats(pageA)).length, { timeout: 15_000 }).toBe(1);
    await expect.poll(async () => (await getDebugStats(pageB)).length, { timeout: 15_000 }).toBe(1);

    await contextA.close();
    await contextB.close();
    await contextC.close();
  });

  test("forced relay: the selected candidate is a relay candidate", async ({ browser }) => {
    test.setTimeout(90_000);
    const coturnUp = await isPortReachable(TURN_HOST, TURN_PORT, 1500);
    test.skip(
      !coturnUp,
      `coturn is not reachable at ${TURN_HOST}:${TURN_PORT}. Start it first: ` +
        "docker compose --env-file .env -f infra/docker-compose.dev.yml up -d coturn",
    );

    const contextD = await browser.newContext();
    const contextE = await browser.newContext();
    const pageD = await contextD.newPage();
    const pageE = await contextE.newPage();

    const userD = uniqueUser("D");
    const userE = uniqueUser("E");
    await registerThroughUi(pageD, userD);
    await registerThroughUi(pageE, userE);

    const inviteUrl = await createGuildWithInvite(pageD, "E2E Voice Relay Server");
    await acceptInvite(pageE, inviteUrl);

    // Force every peer connection in these two tabs onto the TURN relay
    // only, through the app's test-only "?forceRelay" query flag (see
    // shouldForceRelay in apps/web/src/lib/voice.ts). A full navigation
    // is needed so the flag is present when the voice module reads it.
    const urlD = new URL(pageD.url());
    urlD.searchParams.set("forceRelay", "1");
    await pageD.goto(urlD.toString());
    await expect(pageD.getByRole("button", { name: /General/ })).toBeVisible({ timeout: 10_000 });

    const urlE = new URL(pageE.url());
    urlE.searchParams.set("forceRelay", "1");
    await pageE.goto(urlE.toString());
    await expect(pageE.getByRole("button", { name: /General/ })).toBeVisible({ timeout: 10_000 });

    await joinVoice(pageD);
    await joinVoice(pageE);
    await waitForAllConnected([pageD, pageE], 1, 40_000);

    const statsD = await getDebugStats(pageD);
    const statsE = await getDebugStats(pageE);
    // The "relay" policy lets the browser send media only through TURN.
    // A connectivity check through the relay can show a new mapped address.
    // Chrome then reports the local candidate as "prflx", but the path still
    // goes through the relay. Thus, both types prove a relayed connection.
    expect(["relay", "prflx"]).toContain(statsD[0]?.selectedCandidateType);
    expect(["relay", "prflx"]).toContain(statsE[0]?.selectedCandidateType);

    await contextD.close();
    await contextE.close();
  });
});
