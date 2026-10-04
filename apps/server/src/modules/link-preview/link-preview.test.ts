// Tests for the link preview route: the SSRF rules (addresses, host names
// that resolve to a private address, redirects, ports), the HTML reader,
// the size and time limits, the rate limit and the cache. The pages come
// from a local HTTP server. No database is needed.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readHtmlMeta } from "@mortium/shared";
import { registerErrorHandler } from "../../errors.js";
import { authGuardPlugin } from "../../plugins/auth-guard.js";
import { buildTestConfig } from "../../../test/helpers.js";
import type { AppDeps } from "../../app.js";
import { signAccessToken } from "../auth/tokens.js";
import {
  createLinkPreviewFetcher,
  LinkPreviewError,
  MAX_HTML_BYTES,
} from "@mortium/link-preview-fetch";
import { PREVIEWS_PER_MINUTE, PreviewCache, registerLinkPreviewRoutes } from "./routes.js";

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f8b0a50000000049454e44ae426082",
  "hex",
);

const OG_PAGE = `<!doctype html><html><head>
<meta charset="utf-8">
<title>Plain title</title>
<meta property="og:title" content="The &amp; Title">
<meta property='og:description' content='A page about "things".'>
<meta property="og:site_name" content="Fixture Site">
<meta property="og:image" content="/image.png">
</head><body>Hello</body></html>`;

let pageServer: Server;
let origin: string;
const hits: string[] = [];

function route(request: IncomingMessage, response: ServerResponse): void {
  hits.push(request.url ?? "");
  switch (request.url) {
    case "/og":
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(OG_PAGE);
      return;
    case "/image.png":
      response.writeHead(200, { "content-type": "image/png" });
      response.end(PNG);
      return;
    case "/twitter":
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        `<html><head><meta name="twitter:title" content="Tweet title"><meta name="description" content="Plain description"></head></html>`,
      );
      return;
    case "/big-image-page":
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        `<meta property="og:title" content="Big"><meta property="og:image" content="/big.png">`,
      );
      return;
    case "/big.png":
      response.writeHead(200, { "content-type": "image/png" });
      response.end(Buffer.alloc(3 * 1024 * 1024));
      return;
    case "/huge-html": {
      // The title comes after 600 KiB of HTML, so the reader must not see it.
      response.writeHead(200, { "content-type": "text/html" });
      response.write(`<meta property="og:description" content="Early">`);
      response.write(" ".repeat(600 * 1024));
      response.end(`<meta property="og:title" content="Late">`);
      return;
    }
    case "/slow":
      response.writeHead(200, { "content-type": "text/html" });
      response.write("<html><head>");
      setTimeout(() => response.end(`<title>Slow</title></head></html>`), 1500);
      return;
    case "/redirect-private":
      response.writeHead(302, { location: "http://10.0.0.5/secret" });
      response.end();
      return;
    case "/redirect-metadata":
      response.writeHead(301, { location: "http://169.254.169.254/latest/meta-data/" });
      response.end();
      return;
    case "/redirect-ok":
      response.writeHead(302, { location: "/og" });
      response.end();
      return;
    case "/loop":
      response.writeHead(302, { location: "/loop" });
      response.end();
      return;
    case "/json":
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
      return;
    default:
      response.writeHead(404);
      response.end();
  }
}

beforeAll(async () => {
  pageServer = createServer(route);
  await new Promise<void>((resolve) => pageServer.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(pageServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => pageServer.close(() => resolve()));
});

async function expectCode(
  promise: Promise<unknown>,
  code: LinkPreviewError["code"],
): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(LinkPreviewError);
  expect((error as LinkPreviewError).code).toBe(code);
}

describe("the SSRF rules", () => {
  const strict = createLinkPreviewFetcher({
    resolve: async (hostname) => {
      if (hostname === "internal.example.test") return [{ address: "10.0.0.7", family: 4 }];
      if (hostname === "mixed.example.test")
        return [
          { address: "93.184.216.34", family: 4 },
          { address: "fc00::5", family: 6 },
        ];
      if (hostname === "v6-loopback.example.test") return [{ address: "::1", family: 6 }];
      throw new Error("not found");
    },
  });

  it("rejects IP literals in private ranges", async () => {
    for (const url of [
      "http://127.0.0.1/",
      "http://10.0.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://[fc00::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://0x7f.1/",
      "http://2130706433/",
    ]) {
      await expectCode(strict(url), "URL_NOT_ALLOWED");
    }
  });

  it("rejects a host name that resolves to a private address, also when only one of its addresses is private", async () => {
    await expectCode(strict("http://internal.example.test/"), "URL_NOT_ALLOWED");
    await expectCode(strict("http://mixed.example.test/"), "URL_NOT_ALLOWED");
    await expectCode(strict("http://v6-loopback.example.test/"), "URL_NOT_ALLOWED");
  });

  it("rejects other ports, other schemes and credentials", async () => {
    await expectCode(strict("http://example.com:22/"), "URL_NOT_ALLOWED");
    await expectCode(strict("https://example.com:8443/"), "URL_NOT_ALLOWED");
    await expectCode(strict("ftp://example.com/"), "URL_NOT_ALLOWED");
    await expectCode(strict("file:///etc/passwd"), "URL_NOT_ALLOWED");
    await expectCode(strict("http://user:secret@example.com/"), "URL_NOT_ALLOWED");
  });

  it("rejects a loopback page on a real server (the test mode is off)", async () => {
    await expectCode(strict(`${origin}/og`), "URL_NOT_ALLOWED");
  });

  it("rejects a redirect to a private address, even in the test mode", async () => {
    const local = createLinkPreviewFetcher({ testAllowLoopback: true });
    await expectCode(local(`${origin}/redirect-private`), "URL_NOT_ALLOWED");
    await expectCode(local(`${origin}/redirect-metadata`), "URL_NOT_ALLOWED");
  });

  it("stops after 3 redirects", async () => {
    const local = createLinkPreviewFetcher({ testAllowLoopback: true });
    hits.length = 0;
    await expectCode(local(`${origin}/loop`), "NO_PREVIEW");
    expect(hits.filter((path) => path === "/loop")).toHaveLength(4);
  });
});

describe("the page reader", () => {
  const local = createLinkPreviewFetcher({ testAllowLoopback: true });

  it("reads OpenGraph fields and fetches the image", async () => {
    const preview = await local(`${origin}/og`);
    expect(preview).toMatchObject({
      url: `${origin}/og`,
      title: "The & Title",
      description: 'A page about "things".',
      siteName: "Fixture Site",
    });
    expect(preview.image?.mime).toBe("image/png");
    expect(preview.image?.bytes.equals(PNG)).toBe(true);
  });

  it("follows a redirect to a public page, and reads Twitter and plain fields", async () => {
    expect((await local(`${origin}/redirect-ok`)).title).toBe("The & Title");
    expect(await local(`${origin}/twitter`)).toMatchObject({
      title: "Tweet title",
      description: "Plain description",
    });
  });

  it("drops an image larger than 2 MiB and keeps the rest", async () => {
    const preview = await local(`${origin}/big-image-page`);
    expect(preview.title).toBe("Big");
    expect(preview.image).toBeUndefined();
  });

  it("reads only the first 512 KiB of HTML", async () => {
    const preview = await local(`${origin}/huge-html`);
    expect(preview.description).toBe("Early");
    expect(preview.title).toBeUndefined();
    expect(MAX_HTML_BYTES).toBe(512 * 1024);
  });

  it("gives up after the time limit", async () => {
    const quick = createLinkPreviewFetcher({ testAllowLoopback: true, timeoutMs: 300 });
    const started = Date.now();
    await expectCode(quick(`${origin}/slow`), "NO_PREVIEW");
    expect(Date.now() - started).toBeLessThan(1200);
  });

  it("gives no preview for a page that is not HTML", async () => {
    await expectCode(local(`${origin}/json`), "NO_PREVIEW");
  });

  it("is tolerant of broken HTML", () => {
    expect(readHtmlMeta(`<meta property=og:title content=Bare><title>x`)).toMatchObject({
      title: "Bare",
    });
    expect(
      readHtmlMeta(
        `<!-- <meta property="og:title" content="Hidden"> --><title> A &#x26; B </title>`,
      ),
    ).toMatchObject({
      title: "A & B",
    });
    expect(readHtmlMeta("")).toEqual({});
  });
});

describe("PreviewCache", () => {
  it("forgets an entry after its time limit", () => {
    let now = 0;
    const cache = new PreviewCache(1000, 1024 * 1024, () => now);
    cache.set("a", { url: "a", title: "A" });
    expect(cache.get("a")?.title).toBe("A");
    now = 1001;
    expect(cache.get("a")).toBeUndefined();
  });

  it("drops the oldest entry when it is full", () => {
    const cache = new PreviewCache(60_000, 40);
    cache.set("a", { url: "a", title: "A" });
    cache.set("b", { url: "b", title: "B" });
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")?.title).toBe("B");
  });
});

describe("POST /api/v1/link-preview", () => {
  let app: FastifyInstance;
  let fetchCount = 0;
  const config = buildTestConfig();

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(authGuardPlugin, { jwtSecret: config.jwtSecret });
    registerErrorHandler(app);
    await app.register(
      async (instance) =>
        registerLinkPreviewRoutes(instance, { config } as AppDeps, {
          fetcher: async (url) => {
            fetchCount += 1;
            if (url.includes("private")) {
              throw new LinkPreviewError(
                "URL_NOT_ALLOWED",
                "This link goes to a private network address.",
              );
            }
            return { url, title: "Title", image: { mime: "image/png", bytes: PNG } };
          },
        }),
      { prefix: "/api/v1" },
    );
  });

  afterAll(async () => {
    await app.close();
  });

  async function token(userId: bigint): Promise<string> {
    return (await signAccessToken(config.jwtSecret, { userId, deviceId: "device" })).accessToken;
  }

  function post(accessToken: string, url: unknown) {
    return app.inject({
      method: "POST",
      url: "/api/v1/link-preview",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { url },
    });
  }

  it("needs a signed-in user", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/link-preview",
      payload: { url: "https://example.com" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("returns the preview with the image as base64url, and serves a second request from the cache", async () => {
    const accessToken = await token(1n);
    fetchCount = 0;
    const first = await post(accessToken, "https://example.com/cached");
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ title: "Title", image: { mime: "image/png" } });
    expect(Buffer.from(first.json().image.data, "base64url").equals(PNG)).toBe(true);
    await post(accessToken, "https://example.com/cached");
    expect(fetchCount).toBe(1);
  });

  it("rejects a URL that is not http or https, and does not echo it", async () => {
    const response = await post(await token(2n), "javascript:alert(1)");
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain("javascript");
  });

  it("maps a blocked URL to 400 URL_NOT_ALLOWED", async () => {
    const response = await post(await token(3n), "http://private.example.test/");
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("URL_NOT_ALLOWED");
    expect(response.body).not.toContain("private.example.test");
  });

  it("allows 20 requests a minute for each user", async () => {
    const accessToken = await token(4n);
    for (let i = 0; i < PREVIEWS_PER_MINUTE; i += 1) {
      expect((await post(accessToken, `https://example.com/rate/${i}`)).statusCode).toBe(200);
    }
    expect((await post(accessToken, "https://example.com/rate/last")).statusCode).toBe(429);
    // Another user has a separate limit.
    expect((await post(await token(5n), "https://example.com/rate/other")).statusCode).toBe(200);
  });
});
