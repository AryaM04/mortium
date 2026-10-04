// Playwright config for this repo's end-to-end tests: the WebRTC-over-TURN
// relay test, and the account e2e flows in auth.spec.ts.
//
// The auth tests need a real Postgres and a real Mailpit, which are not
// always running on a machine that only wants the TURN test. So this file
// checks both are reachable before it tries to start the API and the web
// dev server for them. When either is unreachable, it skips wiring those
// servers up, and auth.spec.ts skips itself with a clear message (it does
// the same reachability check, since it cannot see this config's result
// any other way).
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { loadRootEnv } from "./env.js";
import { ensureE2eDatabase } from "./lib/ensure-e2e-db.js";
import { isPortReachable } from "./lib/reachable.js";

loadRootEnv();

const FIXTURE_PORT = 4310;
const WEB_PORT = 5173;
const repoRoot = path.join(fileURLToPath(new URL(".", import.meta.url)), "..");
const E2E_DATA_DIR = path.join(repoRoot, "e2e", ".server-data");
process.env.E2E_DATA_DIR = E2E_DATA_DIR;
// link-preview.spec.ts reads the server log here, to check that it holds no URL.
const E2E_SERVER_LOG = path.join(E2E_DATA_DIR, "server.log");
process.env.E2E_SERVER_LOG = E2E_SERVER_LOG;
mkdirSync(E2E_DATA_DIR, { recursive: true });

const postgresPort = Number(process.env.POSTGRES_PORT ?? 5432);
const mailpitUiPort = Number(process.env.MAILPIT_UI_PORT ?? 8025);
// The e2e API server has its own port and its own database. The config never
// reuses a server that it did not start: such a server can use another database.
const apiPort = Number(process.env.E2E_API_PORT ?? 3100);

const [postgresReachable, mailpitReachable] = await Promise.all([
  isPortReachable("localhost", postgresPort),
  isPortReachable("localhost", mailpitUiPort),
]);
const authInfraAvailable = postgresReachable && mailpitReachable;

// Read by auth.spec.ts, since a spec file cannot read this config's local
// variables directly.
process.env.E2E_AUTH_AVAILABLE = authInfraAvailable ? "true" : "false";
if (!authInfraAvailable) {
  console.warn(
    "[e2e] Postgres or Mailpit is not reachable. The auth e2e tests will skip themselves. " +
      "Start them with: docker compose --env-file .env -f infra/docker-compose.dev.yml up -d postgres mailpit",
  );
} else {
  await ensureE2eDatabase({
    host: process.env.POSTGRES_HOST ?? "localhost",
    port: postgresPort,
    user: process.env.POSTGRES_USER ?? "mortium",
    password: process.env.POSTGRES_PASSWORD ?? "",
  });
}

interface WebServerEntry {
  command: string;
  url: string;
  reuseExistingServer: boolean;
  env?: Record<string, string>;
  cwd?: string;
  timeout?: number;
}

const webServers: WebServerEntry[] = [
  {
    command: `node fixtures/server.mjs`,
    url: `http://localhost:${FIXTURE_PORT}`,
    reuseExistingServer: !process.env.CI,
    env: { PORT: String(FIXTURE_PORT) },
  },
];

if (authInfraAvailable) {
  webServers.push(
    {
      command: "pnpm --filter @mortium/server dev",
      url: `http://localhost:${apiPort}/api/v1/health`,
      reuseExistingServer: false,
      cwd: repoRoot,
      // A high rate limit stops repeated local e2e runs from hitting 429s
      // on the auth routes. Production config is untouched.
      env: {
        ...process.env,
        API_PORT: String(apiPort),
        POSTGRES_DB: "mortium_e2e",
        AUTH_RATE_LIMIT_PER_MINUTE: "1000",
        // attachments.spec.ts reads the stored files here.
        DATA_DIR: E2E_DATA_DIR,
        // link-preview.spec.ts: fetch the fixture page on localhost, and read the log.
        LINK_PREVIEW_TEST_ALLOW_LOOPBACK: "true",
        LOG_FILE: E2E_SERVER_LOG,
      } as Record<string, string>,
      timeout: 30_000,
    },
    {
      command: "pnpm --filter @mortium/web dev",
      url: `http://localhost:${WEB_PORT}`,
      // A reused web server can proxy to an API server with another database.
      reuseExistingServer: false,
      cwd: repoRoot,
      // The Vite proxy reads API_PORT, so it points to the e2e API server.
      env: { ...process.env, API_PORT: String(apiPort) } as Record<string, string>,
      timeout: 30_000,
    },
  );
}

export default defineConfig({
  testDir: "./tests",
  timeout: 40_000,
  fullyParallel: false,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${FIXTURE_PORT}`,
  },
  webServer: webServers,
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: [
            "--use-fake-device-for-media-stream",
            "--use-fake-ui-for-media-stream",
            // Let getDisplayMedia() resolve without a manual screen picker,
            // for the local-only screen share part of voice-video.spec.ts.
            // Not reliable under a headless CI runner; that part skips
            // itself there. See e2e/tests/voice-video.spec.ts.
            "--auto-select-desktop-capture-source=Entire screen",
            "--auto-accept-this-tab-capture",
          ],
        },
      },
    },
  ],
});
