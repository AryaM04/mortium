// The link preview route of the web client: POST /api/v1/link-preview.
// A browser cannot fetch other sites (CORS), so the web client asks this
// server. The server sees the URL. It does not log the URL, and it keeps
// a result only in memory, for 10 minutes. See docs/concepts/link-previews.md.
import type { FastifyInstance } from "fastify";
import {
  encodeBase64Url,
  linkPreviewRequestSchema,
  type LinkPreviewResponse,
} from "@mortium/shared";
import type { AppDeps } from "../../app.js";
import { AppError } from "../../errors.js";
import { checkRate } from "../keys/routes.js";
import { createEventRateLimiter } from "../messages/service.js";
import { createLinkPreviewFetcher, LinkPreviewError, type LinkPreviewFetcher } from "@mortium/link-preview-fetch";

export const PREVIEWS_PER_MINUTE = 20;
export const CACHE_TTL_MS = 10 * 60_000;
/** The cache keeps at most this many bytes of preview data. */
const CACHE_MAX_BYTES = 8 * 1024 * 1024;

/** A small least recently used cache with a time limit and a size limit. */
export class PreviewCache {
  private readonly entries = new Map<
    string,
    { value: LinkPreviewResponse; size: number; expiresAt: number }
  >();
  private total = 0;

  constructor(
    private readonly ttlMs = CACHE_TTL_MS,
    private readonly maxBytes = CACHE_MAX_BYTES,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): LinkPreviewResponse | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    this.remove(key);
    if (entry.expiresAt <= this.now()) {
      return undefined;
    }
    this.entries.set(key, entry);
    this.total += entry.size;
    return entry.value;
  }

  set(key: string, value: LinkPreviewResponse): void {
    this.remove(key);
    const size = JSON.stringify(value).length;
    if (size > this.maxBytes) {
      return;
    }
    this.entries.set(key, { value, size, expiresAt: this.now() + this.ttlMs });
    this.total += size;
    for (const [oldKey, entry] of this.entries) {
      if (this.total <= this.maxBytes && entry.expiresAt > this.now()) {
        break;
      }
      this.remove(oldKey);
    }
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.total -= entry.size;
    }
  }
}

export interface LinkPreviewRouteOptions {
  /** Replaces the fetcher. Tests use it. */
  fetcher?: LinkPreviewFetcher;
}

export async function registerLinkPreviewRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  options: LinkPreviewRouteOptions = {},
): Promise<void> {
  const fetchPreview =
    options.fetcher ??
    createLinkPreviewFetcher({ testAllowLoopback: deps.config.linkPreviewTestAllowLoopback });
  const limiter = createEventRateLimiter(PREVIEWS_PER_MINUTE, 60_000);
  const cache = new PreviewCache();

  app.post("/link-preview", { preHandler: app.authenticate }, async (request) => {
    checkRate(limiter, request.auth!.userId);
    const parsed = linkPreviewRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      // The issues are not sent back: they can hold parts of the URL.
      throw new AppError(400, "INVALID_INPUT", "The request needs one http or https URL.");
    }
    const key = new URL(parsed.data.url).href;
    const cached = cache.get(key);
    if (cached) {
      return cached;
    }
    try {
      const preview = await fetchPreview(key);
      const response: LinkPreviewResponse = {
        url: preview.url,
        title: preview.title,
        description: preview.description,
        siteName: preview.siteName,
        image: preview.image
          ? { mime: preview.image.mime, data: encodeBase64Url(preview.image.bytes) }
          : undefined,
      };
      cache.set(key, response);
      return response;
    } catch (error) {
      if (error instanceof LinkPreviewError) {
        throw new AppError(error.code === "URL_NOT_ALLOWED" ? 400 : 422, error.code, error.message);
      }
      throw new AppError(422, "NO_PREVIEW", "The page could not be fetched.");
    }
  });
}
