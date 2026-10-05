// Small shared helpers for integration tests: a full AppConfig with safe
// test defaults, and a fresh temp directory for file storage (avatars).
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/config.js";

export function buildTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    apiPort: 0,
    databaseUrl: "unused-in-tests",
    jwtSecret: "a-test-secret-that-is-at-least-32-characters",
    turnSecret: "test-turn-secret",
    turnDomain: "localhost",
    turnPort: 3478,
    turnPublicHost: "localhost",
    turnTlsEnabled: false,
    turnTlsPort: 5349,
    voiceAudioBitrateBps: 128_000,
    webOrigin: "http://localhost:5173",
    corsAllowedOrigins: [],
    desktopUrlScheme: "mortium",
    dataDir: "./data-test",
    smtp: { host: "localhost", port: 1025, from: "Test <no-reply@example.com>" },
    oauth: {},
    publicApiUrl: "http://localhost:5173",
    authRateLimit: {
      register: 10,
      login: 10,
      refresh: 30,
      resendVerification: 5,
      forgotPassword: 10,
      emailLink: 10,
      oauth: 30,
      loginFailuresPerAccount: 10,
    },
    allowPlaintextEvents: false,
    maxAttachmentBytes: 25 * 1024 * 1024,
    attachmentQuotaBytes: 2 * 1024 * 1024 * 1024,
    linkPreviewTestAllowLoopback: false,
    releasesRepo: "AryaM04/mortium",
    ...overrides,
  };
}

/**
 * A stand-in auth key for a test password. A real client derives the auth
 * key with Argon2id and HKDF. The server treats the auth key as a password,
 * so a SHA-256 hash of the test password is sufficient here.
 */
export function testAuthKey(password = "correct-password"): string {
  return createHash("sha256").update(password).digest("base64url");
}

/** A fixed salt of 16 bytes as base64url. */
export const TEST_KDF_SALT = "c2FsdC1mb3ItYS10ZXN0IQ";

/** The fields of a sign-up or a new password, for a test password. */
export function passwordFields(password = "correct-password", kdfSalt = TEST_KDF_SALT) {
  return { authKey: testAuthKey(password), kdfSalt, kdfVersion: 1 as const };
}

export async function mkTempDataDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "mortium-test-"));
}
