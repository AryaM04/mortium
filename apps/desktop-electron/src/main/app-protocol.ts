// The app:// protocol. The window loads the web build from
// "app://mortium", not from file://, so the page has a stable origin
// that the server can allow (CORS_ALLOWED_ORIGINS). Each response has the
// content security policy (CSP) of the app, with the chosen server added.
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";

/** The same policy as the Tauri app (tauri.conf.json), without the Tauri IPC sources. */
const BASE_POLICY: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["default-src", ["'self'"]],
  ["script-src", ["'self'", "'wasm-unsafe-eval'"]],
  ["style-src", ["'self'", "'unsafe-inline'"]],
  ["img-src", ["'self'", "blob:", "data:"]],
  ["media-src", ["'self'", "blob:"]],
  ["font-src", ["'self'", "data:"]],
  ["worker-src", ["'self'", "blob:"]],
  ["connect-src", ["'self'"]],
  ["object-src", ["'none'"]],
  ["base-uri", ["'self'"]],
  ["form-action", ["'none'"]],
  ["frame-src", ["'none'"]],
  ["frame-ancestors", ["'none'"]],
];

/** The WebSocket origin of a server origin: "wss://" for https, "ws://" for http. */
function websocketOrigin(origin: string): string {
  return origin.replace(/^http/, "ws");
}

/**
 * The CSP of the app. The server origin goes into connect-src (the API
 * and the gateway) and img-src (avatars and guild icons).
 */
export function contentSecurityPolicy(serverOrigin: string | null): string {
  return BASE_POLICY.map(([name, sources]) => {
    const all = [...sources];
    if (serverOrigin && name === "connect-src") {
      all.push(serverOrigin, websocketOrigin(serverOrigin));
    }
    if (serverOrigin && name === "img-src") {
      all.push(serverOrigin);
    }
    return `${name} ${all.join(" ")}`;
  }).join("; ");
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

export function contentTypeOf(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/**
 * The file for a URL path, inside `root`. A path without a file extension
 * is a page of the web app (such as "/app/1/2"), so it gets index.html.
 * Returns null for a path that goes out of `root`.
 */
export function resolveAppFile(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) {
    return null;
  }
  if (extname(decoded) === "") {
    return join(root, "index.html");
  }
  const file = normalize(join(root, decoded));
  return file.startsWith(root.endsWith(sep) ? root : root + sep) ? file : null;
}

export interface AppProtocolOptions {
  /** The folder of the web build. */
  webRoot: string;
  /** The folder of the pages of the desktop app itself (the screen picker), served under "/__desktop/". */
  desktopRoot: string;
  host: string;
  /** The server origin of this moment, or null. */
  serverOrigin(): string | null;
}

const DESKTOP_PREFIX = "/__desktop/";

/** The handler for `protocol.handle`. */
export function createAppProtocolHandler(options: AppProtocolOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (url.host !== options.host || (request.method !== "GET" && request.method !== "HEAD")) {
      return new Response("Not found", { status: 404 });
    }
    const file = url.pathname.startsWith(DESKTOP_PREFIX)
      ? resolveAppFile(options.desktopRoot, url.pathname.slice(DESKTOP_PREFIX.length - 1))
      : resolveAppFile(options.webRoot, url.pathname);
    if (!file) {
      return new Response("Not found", { status: 404 });
    }
    let body: Buffer;
    try {
      body = await readFile(file);
    } catch {
      return new Response("Not found", { status: 404 });
    }
    return new Response(request.method === "HEAD" ? null : new Uint8Array(body), {
      status: 200,
      headers: {
        "content-type": contentTypeOf(file),
        "content-security-policy": contentSecurityPolicy(options.serverOrigin()),
        "x-content-type-options": "nosniff",
        "cache-control": "no-cache",
      },
    });
  };
}
