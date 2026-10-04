// The fetch of a link preview. The server uses it for the web client, and
// the Linux desktop app (Electron) uses it in its main process. The fetch
// gets a page that a user names, so this code must not let a user reach a
// private network (SSRF). The rules:
//
// - Only http and https, only ports 80 and 443, no user name or password.
// - Each host name is resolved here, and the connection uses the checked
//   address. A name with one private, loopback, link-local, multicast or
//   other special address is refused. This also stops DNS rebinding.
// - At most 3 redirects. Each redirect target goes through the same checks.
// - One 3 s time limit for the page and the image, 512 KiB of HTML (the
//   rest is not read), and a 2 MiB image (a larger image is dropped).
//
// This module never logs, and its errors never hold the URL. See
// docs/concepts/link-previews.md.
import { lookup as dnsLookup } from "node:dns/promises";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { decodeHtml, LINK_PREVIEW_IMAGE_TYPES, readHtmlMeta } from "@mortium/shared";
import { checkUrl, isBlockedAddress, LinkPreviewError } from "./address-check.js";

export const LINK_PREVIEW_TIMEOUT_MS = 3000;
export const MAX_HTML_BYTES = 512 * 1024;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_REDIRECTS = 3;

export type LinkPreviewImageType = (typeof LINK_PREVIEW_IMAGE_TYPES)[number];

export interface FetchedLinkPreview {
  /** The URL of the page after redirects. */
  url: string;
  title?: string;
  description?: string;
  siteName?: string;
  image?: { mime: LinkPreviewImageType; bytes: Buffer };
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

export interface LinkPreviewFetcherOptions {
  /** Resolves a host name to its addresses. Tests replace it. Defaults to the system resolver. */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  /**
   * For tests only: let the fetcher reach loopback addresses on any port,
   * so a test can serve pages from this machine. Every other private
   * address stays blocked. Never set this on a real server.
   */
  testAllowLoopback?: boolean;
  timeoutMs?: number;
  maxHtmlBytes?: number;
  maxImageBytes?: number;
}

const systemResolve = async (hostname: string): Promise<ResolvedAddress[]> =>
  dnsLookup(hostname, { all: true, verbatim: true });

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function createLinkPreviewFetcher(options: LinkPreviewFetcherOptions = {}) {
  const resolve = options.resolve ?? systemResolve;
  const allowLoopback = options.testAllowLoopback === true;
  const timeoutMs = options.timeoutMs ?? LINK_PREVIEW_TIMEOUT_MS;
  const maxHtmlBytes = options.maxHtmlBytes ?? MAX_HTML_BYTES;
  const maxImageBytes = options.maxImageBytes ?? MAX_IMAGE_BYTES;

  /** The `lookup` of each request: it resolves, checks every address, and connects only to a checked one. */
  const safeLookup: LookupFunction = (hostname, lookupOptions, callback) => {
    resolve(hostname).then(
      (addresses) => {
        if (
          addresses.length === 0 ||
          addresses.some((entry) => isBlockedAddress(entry.address, allowLoopback))
        ) {
          callback(
            new LinkPreviewError("URL_NOT_ALLOWED", "This link goes to a private network address."),
            "",
            0,
          );
          return;
        }
        if (lookupOptions.all) {
          (callback as unknown as (error: null, addresses: ResolvedAddress[]) => void)(
            null,
            addresses,
          );
        } else {
          callback(null, addresses[0]!.address, addresses[0]!.family);
        }
      },
      () =>
        callback(
          new LinkPreviewError("NO_PREVIEW", "The host name of the link was not found."),
          "",
          0,
        ),
    );
  };

  function requestOnce(url: URL, accept: string, signal: AbortSignal): Promise<IncomingMessage> {
    const client = url.protocol === "https:" ? https : http;
    return new Promise((resolveResponse, reject) => {
      const request = client.request(
        url,
        {
          method: "GET",
          agent: false,
          lookup: safeLookup,
          signal,
          headers: {
            accept,
            "user-agent": "MortiumLinkPreview/1.0",
            "accept-encoding": "identity",
          },
        },
        resolveResponse,
      );
      request.on("error", reject);
      request.end();
    });
  }

  /** GET with the checks on each hop. Returns the final response and URL. */
  async function safeGet(
    start: URL,
    accept: string,
    signal: AbortSignal,
  ): Promise<{ response: IncomingMessage; url: URL }> {
    let url = start;
    for (let hop = 0; ; hop += 1) {
      checkUrl(url, allowLoopback);
      const response = await requestOnce(url, accept, signal);
      const location = response.headers.location;
      if (!REDIRECT_STATUSES.has(response.statusCode ?? 0) || !location) {
        return { response, url };
      }
      response.destroy();
      if (hop >= MAX_REDIRECTS) {
        throw new LinkPreviewError("NO_PREVIEW", "The link has too many redirects.");
      }
      try {
        url = new URL(location, url);
      } catch {
        throw new LinkPreviewError(
          "NO_PREVIEW",
          "The link redirects to an address that is not valid.",
        );
      }
    }
  }

  /** Read at most `max` bytes. `cut` true keeps the first `max` bytes of a longer body; false gives null. */
  async function readBody(
    response: IncomingMessage,
    max: number,
    cut: boolean,
  ): Promise<Buffer | null> {
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of response as AsyncIterable<Buffer>) {
        total += chunk.length;
        if (total > max) {
          if (!cut) {
            return null;
          }
          chunks.push(chunk.subarray(0, chunk.length - (total - max)));
          break;
        }
        chunks.push(chunk);
      }
    } finally {
      response.destroy();
    }
    return Buffer.concat(chunks);
  }

  async function fetchImage(
    pageUrl: URL,
    source: string,
    signal: AbortSignal,
  ): Promise<FetchedLinkPreview["image"]> {
    try {
      const { response } = await safeGet(
        new URL(source, pageUrl),
        LINK_PREVIEW_IMAGE_TYPES.join(","),
        signal,
      );
      const mime = (response.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
      const length = Number(response.headers["content-length"] ?? 0);
      if (
        response.statusCode !== 200 ||
        !(LINK_PREVIEW_IMAGE_TYPES as readonly string[]).includes(mime) ||
        length > maxImageBytes
      ) {
        response.destroy();
        return undefined;
      }
      const bytes = await readBody(response, maxImageBytes, false);
      return bytes && bytes.length > 0 ? { mime: mime as LinkPreviewImageType, bytes } : undefined;
    } catch {
      // A preview without its image is still a preview.
      return undefined;
    }
  }

  /** Fetch a page and read its preview. Throws `LinkPreviewError` only. */
  return async function fetchLinkPreview(rawUrl: string): Promise<FetchedLinkPreview> {
    let start: URL;
    try {
      start = new URL(rawUrl);
    } catch {
      throw new LinkPreviewError("URL_NOT_ALLOWED", "The link is not a valid URL.");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const { response, url } = await safeGet(
        start,
        "text/html,application/xhtml+xml",
        controller.signal,
      );
      const contentType = String(response.headers["content-type"] ?? "");
      if (
        response.statusCode !== 200 ||
        !/^(text\/html|application\/xhtml\+xml)\b/i.test(contentType)
      ) {
        response.destroy();
        throw new LinkPreviewError("NO_PREVIEW", "The link does not go to a web page.");
      }
      const html = await readBody(response, maxHtmlBytes, true);
      const meta = readHtmlMeta(decodeHtml(html ?? Buffer.alloc(0), contentType));
      const image = meta.image ? await fetchImage(url, meta.image, controller.signal) : undefined;
      if (!meta.title && !meta.description && !image) {
        throw new LinkPreviewError("NO_PREVIEW", "The page has no preview data.");
      }
      return {
        url: url.href,
        title: meta.title,
        description: meta.description,
        siteName: meta.siteName,
        image,
      };
    } catch (error) {
      if (error instanceof LinkPreviewError) {
        throw error;
      }
      // A time-out, a TLS error or a closed connection. The cause can hold the host name, so it is not kept.
      throw new LinkPreviewError("NO_PREVIEW", "The page could not be fetched.");
    } finally {
      clearTimeout(timer);
    }
  };
}

export type LinkPreviewFetcher = ReturnType<typeof createLinkPreviewFetcher>;
