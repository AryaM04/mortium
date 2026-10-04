// Tests for the app:// protocol: the content security policy, the file
// rules (no path out of the web build) and the responses.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, contentTypeOf, createAppProtocolHandler, resolveAppFile } from "./app-protocol.js";

describe("contentSecurityPolicy", () => {
  it("has the strict base policy without a server", () => {
    const policy = contentSecurityPolicy(null);
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(policy).toContain("connect-src 'self';");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain(" 'unsafe-eval'");
    expect(policy).not.toMatch(/script-src[^;]*unsafe-inline/);
  });

  it("adds the server to connect-src (with its WebSocket origin) and img-src only", () => {
    const policy = contentSecurityPolicy("https://chat.example.com");
    expect(policy).toContain("connect-src 'self' https://chat.example.com wss://chat.example.com");
    expect(policy).toContain("img-src 'self' blob: data: https://chat.example.com");
    expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval';");
    expect(contentSecurityPolicy("http://localhost:3000")).toContain(
      "connect-src 'self' http://localhost:3000 ws://localhost:3000",
    );
  });
});

describe("resolveAppFile", () => {
  const root = join(tmpdir(), "web-root");

  it("serves files in the root and index.html for app pages", () => {
    expect(resolveAppFile(root, "/assets/index-abc.js")).toBe(join(root, "assets", "index-abc.js"));
    expect(resolveAppFile(root, "/")).toBe(join(root, "index.html"));
    expect(resolveAppFile(root, "/app/1/2")).toBe(join(root, "index.html"));
    expect(resolveAppFile(root, "/invite/abc")).toBe(join(root, "index.html"));
  });

  it("refuses a path out of the root", () => {
    expect(resolveAppFile(root, "/%2e%2e/%2e%2e/etc/passwd.txt")).toBeNull();
    expect(resolveAppFile(root, "/..%2fsecret.json")).toBeNull();
    expect(resolveAppFile(root, "/assets%5c..%5c..%5csecret.js")).toBeNull();
    expect(resolveAppFile(root, "/a%00.js")).toBeNull();
    expect(resolveAppFile(root, "/%E0%A4%A.js")).toBeNull();
  });

  it("knows the types of the web build files", () => {
    expect(contentTypeOf("a.wasm")).toBe("application/wasm");
    expect(contentTypeOf("a.js")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeOf("a.unknown")).toBe("application/octet-stream");
  });
});

describe("the protocol handler", () => {
  const webRoot = mkdtempSync(join(tmpdir(), "web-"));
  const desktopRoot = mkdtempSync(join(tmpdir(), "desktop-"));
  mkdirSync(join(webRoot, "assets"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>app</title>");
  writeFileSync(join(webRoot, "assets", "crypto.wasm"), Buffer.from([0, 97, 115, 109]));
  writeFileSync(join(desktopRoot, "picker.html"), "<!doctype html><title>picker</title>");
  let server: string | null = null;
  const handler = createAppProtocolHandler({ webRoot, desktopRoot, host: "mortium", serverOrigin: () => server });

  it("serves the page with the policy of the chosen server", async () => {
    server = "https://chat.example.com";
    const response = await handler(new Request("app://mortium/app/1/2"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toContain("wss://chat.example.com");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toContain("<title>app</title>");
  });

  it("serves WASM with its type, and the picker page from the desktop folder", async () => {
    const wasm = await handler(new Request("app://mortium/assets/crypto.wasm"));
    expect(wasm.headers.get("content-type")).toBe("application/wasm");
    const picker = await handler(new Request("app://mortium/__desktop/picker.html"));
    expect(await picker.text()).toContain("<title>picker</title>");
  });

  it("gives 404 for another host, a missing file and a write method", async () => {
    expect((await handler(new Request("app://other-host/"))).status).toBe(404);
    expect((await handler(new Request("app://mortium/assets/missing.js"))).status).toBe(404);
    expect((await handler(new Request("app://mortium/", { method: "POST", body: "x" }))).status).toBe(404);
  });
});
