// Tests for the one-time OAuth exchange code store.
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthResult } from "@mortium/shared";
import { clearOAuthCodesForTests, consumeOAuthCode, storeOAuthCode } from "./oauth-codes.js";

const sampleResult: AuthResult = {
  user: {
    id: "1",
    username: "sample",
    displayName: "Sample",
    avatarKey: null,
    statusText: null,
    createdAt: new Date().toISOString(),
  },
  deviceId: "device1",
  accessToken: "access",
  accessTokenExpiresAt: new Date().toISOString(),
  refreshToken: "refresh",
};

describe("storeOAuthCode and consumeOAuthCode", () => {
  beforeEach(() => {
    clearOAuthCodesForTests();
  });

  it("returns the stored result once", () => {
    const code = storeOAuthCode(sampleResult);
    expect(consumeOAuthCode(code)).toEqual(sampleResult);
  });

  it("returns undefined the second time the same code is used", () => {
    const code = storeOAuthCode(sampleResult);
    consumeOAuthCode(code);
    expect(consumeOAuthCode(code)).toBeUndefined();
  });

  it("returns undefined for a code that was never stored", () => {
    expect(consumeOAuthCode("no-such-code")).toBeUndefined();
  });

  it("returns undefined once the code has expired", () => {
    const code = storeOAuthCode(sampleResult);
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
      expect(consumeOAuthCode(code)).toBeUndefined();
    } finally {
      Date.now = realNow;
    }
  });
});
