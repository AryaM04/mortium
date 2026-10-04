// Tests for environment parsing in config.ts.
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const validEnv = {
  POSTGRES_HOST: "localhost",
  POSTGRES_DB: "mortium",
  POSTGRES_USER: "mortium",
  POSTGRES_PASSWORD: "secret",
  JWT_SECRET: "jwt-secret-value-that-is-at-least-32-chars",
  TURN_SECRET: "turn-secret-value",
  TURN_DOMAIN: "localhost",
  SMTP_HOST: "localhost",
  SMTP_FROM: "Mortium <no-reply@example.com>",
};

describe("loadConfig", () => {
  it("builds a database URL from the Postgres parts", () => {
    const config = loadConfig(validEnv);
    expect(config.databaseUrl).toBe(
      "postgres://mortium:secret@localhost:5432/mortium",
    );
  });

  it("applies the default API port when it is not set", () => {
    const config = loadConfig(validEnv);
    expect(config.apiPort).toBe(3000);
  });

  it("uses a custom API port when it is set", () => {
    const config = loadConfig({ ...validEnv, API_PORT: "4000" });
    expect(config.apiPort).toBe(4000);
  });

  it("throws a clear error when a required value is missing", () => {
    const { POSTGRES_PASSWORD: _unused, ...rest } = validEnv;
    expect(() => loadConfig(rest)).toThrow(/POSTGRES_PASSWORD/);
  });

  it("throws a clear error when JWT_SECRET is too short", () => {
    expect(() => loadConfig({ ...validEnv, JWT_SECRET: "too-short" })).toThrow(/JWT_SECRET/);
  });

  it("applies default values for WEB_ORIGIN, DATA_DIR and PUBLIC_API_URL", () => {
    const config = loadConfig(validEnv);
    expect(config.webOrigin).toBe("http://localhost:5173");
    expect(config.dataDir).toBe("./data");
    expect(config.publicApiUrl).toBe("http://localhost:5173");
  });

  it("allows no other origins and uses the default desktop scheme when they are not set", () => {
    const config = loadConfig(validEnv);
    expect(config.corsAllowedOrigins).toEqual([]);
    expect(config.desktopUrlScheme).toBe("mortium");
  });

  it("reads a comma list of origins, with a custom scheme", () => {
    const config = loadConfig({
      ...validEnv,
      CORS_ALLOWED_ORIGINS:
        " http://tauri.localhost, tauri://localhost ,app://mortium, https://chat.example.com:443/,",
    });
    expect(config.corsAllowedOrigins).toEqual([
      "http://tauri.localhost",
      "tauri://localhost",
      "app://mortium",
      "https://chat.example.com",
    ]);
  });

  it("throws when an allowed origin has a path", () => {
    expect(() => loadConfig({ ...validEnv, CORS_ALLOWED_ORIGINS: "https://example.com/app" })).toThrow(
      /CORS_ALLOWED_ORIGINS/,
    );
    expect(() => loadConfig({ ...validEnv, CORS_ALLOWED_ORIGINS: "not a url" })).toThrow(/CORS_ALLOWED_ORIGINS/);
  });

  it("throws when the desktop scheme is not a plain scheme", () => {
    expect(() => loadConfig({ ...validEnv, DESKTOP_URL_SCHEME: "bad scheme://" })).toThrow(/DESKTOP_URL_SCHEME/);
  });

  it("leaves OAuth providers off when their credentials are not set", () => {
    const config = loadConfig(validEnv);
    expect(config.oauth.github).toBeUndefined();
    expect(config.oauth.google).toBeUndefined();
  });

  it("turns on an OAuth provider once both its credentials are set", () => {
    const config = loadConfig({
      ...validEnv,
      GITHUB_CLIENT_ID: "id",
      GITHUB_CLIENT_SECRET: "secret",
    });
    expect(config.oauth.github).toEqual({ clientId: "id", clientSecret: "secret" });
    expect(config.oauth.google).toBeUndefined();
  });

  it("uses TURN_DOMAIN as the default TURN_PUBLIC_HOST", () => {
    const config = loadConfig(validEnv);
    expect(config.turnPublicHost).toBe("localhost");
    expect(config.turnTlsEnabled).toBe(false);
    expect(config.turnTlsPort).toBe(5349);
  });

  it("uses TURN_PUBLIC_HOST when it is set", () => {
    const config = loadConfig({ ...validEnv, TURN_PUBLIC_HOST: "turn.example.com" });
    expect(config.turnPublicHost).toBe("turn.example.com");
  });

  it("falls back to TURN_DOMAIN when TURN_PUBLIC_HOST is an empty string", () => {
    // A copied .env.example leaves this variable set but empty, not unset.
    const config = loadConfig({ ...validEnv, TURN_PUBLIC_HOST: "" });
    expect(config.turnPublicHost).toBe("localhost");
  });

  it("turns on TURN over TLS only when TURN_TLS_ENABLED is \"true\"", () => {
    const config = loadConfig({ ...validEnv, TURN_TLS_ENABLED: "true", TURN_TLS_PORT: "5350" });
    expect(config.turnTlsEnabled).toBe(true);
    expect(config.turnTlsPort).toBe(5350);
  });

  it("reads the voice audio bitrate in kbps and gives it in bits per second", () => {
    expect(loadConfig(validEnv).voiceAudioBitrateBps).toBe(128_000);
    expect(loadConfig({ ...validEnv, VOICE_AUDIO_BITRATE_KBPS: "64" }).voiceAudioBitrateBps).toBe(64_000);
    expect(() => loadConfig({ ...validEnv, VOICE_AUDIO_BITRATE_KBPS: "600" })).toThrow();
  });

  it("scales auth rate limits from the default AUTH_RATE_LIMIT_PER_MINUTE", () => {
    const config = loadConfig(validEnv);
    expect(config.authRateLimit).toEqual({
      register: 10,
      login: 10,
      refresh: 30,
      resendVerification: 5,
      forgotPassword: 10,
      emailLink: 10,
      oauth: 30,
      loginFailuresPerAccount: 10,
    });
  });

  it("scales auth rate limits from a custom AUTH_RATE_LIMIT_PER_MINUTE", () => {
    const config = loadConfig({ ...validEnv, AUTH_RATE_LIMIT_PER_MINUTE: "1000" });
    expect(config.authRateLimit).toEqual({
      register: 1000,
      login: 1000,
      refresh: 3000,
      resendVerification: 500,
      forgotPassword: 1000,
      emailLink: 1000,
      oauth: 3000,
      loginFailuresPerAccount: 1000,
    });
  });
});
