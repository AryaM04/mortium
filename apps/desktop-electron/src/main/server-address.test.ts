// Tests for the server address: the address rules, and the check of a
// real local server (health route and CORS header).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkServer, normalizeServerAddress } from "./server-address.js";

describe("normalizeServerAddress", () => {
  it("gives the origin of a simple address", () => {
    expect(normalizeServerAddress("chat.example.com")).toBe("https://chat.example.com");
    expect(normalizeServerAddress(" https://chat.example.com/ ")).toBe("https://chat.example.com");
    expect(normalizeServerAddress("https://chat.example.com:443")).toBe("https://chat.example.com");
    expect(normalizeServerAddress("https://192.168.1.5:8443")).toBe("https://192.168.1.5:8443");
    expect(normalizeServerAddress("http://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeServerAddress("http://127.0.0.1:3000/")).toBe("http://127.0.0.1:3000");
    expect(normalizeServerAddress("http://[::1]:3000")).toBe("http://[::1]:3000");
  });

  it("refuses an address with more than an origin", () => {
    for (const input of [
      "",
      "ftp://example.com",
      "https://example.com/app",
      "https://example.com/?a=1",
      "https://example.com/?",
      "https://example.com/#x",
      "https://user:pass@example.com",
      "javascript:alert(1)",
      "https://",
    ]) {
      expect(() => normalizeServerAddress(input), input).toThrow(/Type a server address/);
    }
  });

  it("refuses http for a host that is not this computer", () => {
    expect(() => normalizeServerAddress("http://192.168.1.5:3000")).toThrow(/needs an https address/);
    expect(() => normalizeServerAddress("http://chat.example.com")).toThrow(/needs an https address/);
  });
});

describe("checkServer", () => {
  const APP_ORIGIN = "app://mortium";
  let server: Server;
  let base: string;
  const seenOrigins: Array<string | undefined> = [];
  let mode: "allow" | "deny" | "error" = "allow";

  beforeAll(async () => {
    server = createServer((request, response) => {
      seenOrigins.push(request.headers.origin);
      if (request.url !== "/api/v1/health" || mode === "error") {
        response.writeHead(503).end();
        return;
      }
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (mode === "allow" && request.headers.origin === APP_ORIGIN) {
        headers["access-control-allow-origin"] = APP_ORIGIN;
      }
      response.writeHead(200, headers).end('{"status":"ok"}');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("gives the origin when the server allows the app, and sends the app origin", async () => {
    mode = "allow";
    expect(await checkServer(`${base}/`, APP_ORIGIN)).toBe(base);
    expect(seenOrigins.at(-1)).toBe(APP_ORIGIN);
  });

  it("tells the user to add the app origin when CORS does not allow it", async () => {
    mode = "deny";
    await expect(checkServer(base, APP_ORIGIN)).rejects.toThrow(
      "The server does not allow this app. Add app://mortium to CORS_ALLOWED_ORIGINS in the .env file of the server.",
    );
  });

  it("reports a server that is not ready, and a server that does not answer", async () => {
    mode = "error";
    await expect(checkServer(base, APP_ORIGIN)).rejects.toThrow(/is not ready \(HTTP status 503\)/);
    await expect(checkServer("http://127.0.0.1:1", APP_ORIGIN)).rejects.toThrow(/did not answer/);
  });
});
