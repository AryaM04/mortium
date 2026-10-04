// Tests for the desktop download route. GitHub is a mocked fetch. No database is needed.
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { desktopLatestResponseSchema } from "@mortium/shared";
import { registerErrorHandler } from "../../errors.js";
import { buildTestConfig } from "../../../test/helpers.js";
import type { AppDeps } from "../../app.js";
import { CACHE_TTL_MS, registerDesktopRoutes } from "./routes.js";

const BASE = "https://github.com/AryaM04/mortium/releases/download/v0.2.0";
const NAMES: Array<[string, number]> = [
  ["Mortium_0.2.0_x64-setup.exe", 5000],
  ["Mortium_0.2.0_x64-setup.exe.sig", 10],
  ["Mortium_0.2.0_x64_en-US.msi", 6000],
  ["Mortium_0.2.0_aarch64.dmg", 7000],
  ["Mortium.app.tar.gz", 100],
  ["latest.json", 20],
  ["mortium-0.2.0-x86_64.AppImage", 8000],
  ["mortium-0.2.0-amd64.deb", 4000],
  ["mortium-0.2.0-x86_64.AppImage.blockmap", 30],
  ["latest-linux.yml", 40],
];

function release() {
  return {
    tag_name: "v0.2.0",
    published_at: "2026-09-30T12:00:00Z",
    html_url: "https://github.com/AryaM04/mortium/releases/tag/v0.2.0",
    assets: NAMES.map(([name, size]) => ({ name, size, browser_download_url: `${BASE}/${name}` })),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let app: FastifyInstance | undefined;

async function build(fetchMock: typeof fetch, releasesRepo = "AryaM04/mortium", clock = { now: 0 }) {
  app = Fastify();
  registerErrorHandler(app);
  const deps = { config: buildTestConfig({ releasesRepo }) } as unknown as AppDeps;
  await app.register(async (instance) => registerDesktopRoutes(instance, deps, { fetch: fetchMock, now: () => clock.now }), {
    prefix: "/api/v1",
  });
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("GET /api/v1/desktop/latest", () => {
  it("lists only the installer files, with the GitHub download URLs", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(release()));
    const server = await build(fetchMock as unknown as typeof fetch);
    const response = await server.inject({ method: "GET", url: "/api/v1/desktop/latest" });
    expect(response.statusCode).toBe(200);
    const body = desktopLatestResponseSchema.parse(response.json());
    expect(body.version).toBe("0.2.0");
    expect(body.publishedAt).toBe("2026-09-30T12:00:00Z");
    expect(body.stale).toBeUndefined();
    expect(body.assets.map((a) => [a.platform, a.kind, a.name])).toEqual([
      ["windows", "installer", "Mortium_0.2.0_x64-setup.exe"],
      ["windows", "msi", "Mortium_0.2.0_x64_en-US.msi"],
      ["macos", "dmg", "Mortium_0.2.0_aarch64.dmg"],
      ["linux", "appimage", "mortium-0.2.0-x86_64.AppImage"],
      ["linux", "deb", "mortium-0.2.0-amd64.deb"],
    ]);
    expect(body.assets[0]).toMatchObject({ size: 5000, url: `${BASE}/Mortium_0.2.0_x64-setup.exe` });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/AryaM04/mortium/releases/latest");
    expect((init.headers as Record<string, string>)["User-Agent"]).toBeTruthy();
  });

  it("keeps the result for 10 minutes", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(release()));
    const clock = { now: 0 };
    const server = await build(fetchMock as unknown as typeof fetch, "AryaM04/mortium", clock);
    await server.inject({ method: "GET", url: "/api/v1/desktop/latest" });
    clock.now = CACHE_TTL_MS - 1;
    await server.inject({ method: "GET", url: "/api/v1/desktop/latest" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clock.now = CACHE_TTL_MS;
    await server.inject({ method: "GET", url: "/api/v1/desktop/latest" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends the last good result with stale: true when GitHub fails", async () => {
    let fail = false;
    const fetchMock = vi.fn(async () => (fail ? jsonResponse({}, 500) : jsonResponse(release())));
    const clock = { now: 0 };
    const server = await build(fetchMock as unknown as typeof fetch, "AryaM04/mortium", clock);
    await server.inject({ method: "GET", url: "/api/v1/desktop/latest" });
    fail = true;
    clock.now = CACHE_TTL_MS + 1;
    const response = await server.inject({ method: "GET", url: "/api/v1/desktop/latest" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ version: "0.2.0", stale: true });
  });

  it("answers 503 RELEASES_UNAVAILABLE when GitHub fails and nothing is cached", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    const server = await build(fetchMock as unknown as typeof fetch);
    const response = await server.inject({ method: "GET", url: "/api/v1/desktop/latest" });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("RELEASES_UNAVAILABLE");
  });

  it("is off when RELEASES_REPO is empty", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(release()));
    const server = await build(fetchMock as unknown as typeof fetch, "");
    const response = await server.inject({ method: "GET", url: "/api/v1/desktop/latest" });
    expect(response.statusCode).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
