// The desktop download route: GET /api/v1/desktop/latest. The server reads
// the latest GitHub release of RELEASES_REPO and keeps the result in memory
// for 10 minutes. When GitHub does not answer, the server sends the last
// good result with stale: true.
import type { FastifyInstance } from "fastify";
import {
  type DesktopAsset,
  type DesktopLatestResponse,
} from "@mortium/shared";
import type { AppDeps } from "../../app.js";
import { AppError } from "../../errors.js";

export const CACHE_TTL_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 5000;
const REQUESTS_PER_MINUTE = 30;

type FetchFunction = typeof fetch;

export interface DesktopRouteOptions {
  /** Replaces fetch. Tests use it. */
  fetch?: FetchFunction;
  /** Replaces the clock. Tests use it. */
  now?: () => number;
}

/** The kind and platform of an installer file name, or null for any other file. */
export function classifyAsset(name: string): Pick<DesktopAsset, "platform" | "kind"> | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".msi")) return { platform: "windows", kind: "msi" };
  if (lower.endsWith("-setup.exe")) return { platform: "windows", kind: "installer" };
  if (lower.endsWith(".dmg")) return { platform: "macos", kind: "dmg" };
  if (lower.endsWith(".appimage")) return { platform: "linux", kind: "appimage" };
  if (lower.endsWith(".deb")) return { platform: "linux", kind: "deb" };
  return null;
}

interface GithubRelease {
  tag_name?: unknown;
  published_at?: unknown;
  html_url?: unknown;
  assets?: unknown;
}

/** Map the GitHub release JSON to the response. Throw when it has no usable shape. */
export function parseRelease(json: unknown): DesktopLatestResponse {
  const release = json as GithubRelease;
  if (
    typeof release?.tag_name !== "string" ||
    typeof release.published_at !== "string" ||
    typeof release.html_url !== "string" ||
    !Array.isArray(release.assets)
  ) {
    throw new Error("The release data has an unexpected shape.");
  }
  const assets: DesktopAsset[] = [];
  for (const entry of release.assets as Array<Record<string, unknown>>) {
    if (typeof entry?.name !== "string" || typeof entry.size !== "number" || typeof entry.browser_download_url !== "string") {
      continue;
    }
    const kind = classifyAsset(entry.name);
    if (kind) {
      assets.push({ ...kind, name: entry.name, size: entry.size, url: entry.browser_download_url });
    }
  }
  return {
    version: release.tag_name.replace(/^v/, ""),
    publishedAt: release.published_at,
    notesUrl: release.html_url,
    assets,
  };
}

export async function registerDesktopRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  options: DesktopRouteOptions = {},
): Promise<void> {
  const repo = deps.config.releasesRepo;
  if (!repo) {
    return;
  }
  const fetchFunction = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let cached: { value: DesktopLatestResponse; fetchedAt: number } | null = null;

  async function load(): Promise<DesktopLatestResponse> {
    const response = await fetchFunction(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { "User-Agent": "mortium-server", Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`GitHub answered with status ${response.status}.`);
    }
    return parseRelease(await response.json());
  }

  app.get(
    "/desktop/latest",
    { config: { rateLimit: { max: REQUESTS_PER_MINUTE, timeWindow: "1 minute" } } },
    async (request) => {
      if (cached && now() - cached.fetchedAt < CACHE_TTL_MS) {
        return cached.value;
      }
      try {
        const value = await load();
        cached = { value, fetchedAt: now() };
        return value;
      } catch (error) {
        request.log.warn({ err: error }, "The latest desktop release could not be read.");
        if (cached) {
          return { ...cached.value, stale: true };
        }
        throw new AppError(503, "RELEASES_UNAVAILABLE", "The desktop downloads are not available now. Try again later.");
      }
    },
  );
}
