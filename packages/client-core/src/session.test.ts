// Tests for the session store. A sign-in must store the tokens before the
// status becomes "signedIn": the gateway and the crypto layer start on that
// status and read the tokens at once.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createSession } from "./session.js";
import type { Platform } from "./platform.js";
import { initWasmForTests } from "./crypto/test/fake-server.js";

// The sign-in derives the auth key from the password with the crypto WASM.
beforeAll(() => {
  initWasmForTests();
});

const PRELOGIN = { kdf: "argon2id-v1", salt: "c2FsdC1mb3ItYS10ZXN0IQ", memoryKib: 65536, iterations: 3, parallelism: 1 };

/** A fake server: the prelogin answer for /auth/prelogin, and `body` for every other request. */
function fakeServer(body: unknown) {
  return async (input: RequestInfo | URL) => {
    const json = String(input).endsWith("/auth/prelogin") ? PRELOGIN : body;
    return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
  };
}

const AUTH_RESULT = {
  user: {
    id: "1",
    username: "alice",
    displayName: "Alice",
    avatarKey: null,
    statusText: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  deviceId: "device-1",
  accessToken: "access",
  accessTokenExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  refreshToken: "refresh",
};

/** A secure store whose writes finish only after a delay, as a slow disk write does. */
function slowPlatform(): Platform {
  const values = new Map<string, string>();
  return {
    secureStore: {
      get: async (key) => values.get(key) ?? null,
      set: async (key, value) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        values.set(key, value);
      },
      delete: async (key) => {
        values.delete(key);
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("session sign-in", () => {
  it.each(["register", "login"] as const)("%s stores the tokens before the status becomes signedIn", async (action) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(fakeServer(AUTH_RESULT));
    const { store, apiClient, keys } = createSession({ baseUrl: "/api/v1", platform: slowPlatform() });

    let tokenAtSignIn: Promise<string> | null = null;
    store.subscribe((state, previous) => {
      if (state.status === "signedIn" && previous.status !== "signedIn") {
        tokenAtSignIn = apiClient.getAccessToken();
      }
    });

    const input = { email: "alice@example.test", username: "alice", password: "correct-horse-battery-staple" };
    await (action === "register" ? store.getState().register(input) : store.getState().login(input));

    expect(store.getState().status).toBe("signedIn");
    expect(tokenAtSignIn).not.toBeNull();
    await expect(tokenAtSignIn!).resolves.toBe("access");

    // The password never goes to the server. The tab keeps the wrap key.
    for (const [, init] of fetchMock.mock.calls) {
      expect(String(init?.body ?? "")).not.toContain(input.password);
    }
    expect(keys.hasWrapKey()).toBe(true);
  });
});

describe("session start", () => {
  it("keeps the tokens after a network error and tries again", async () => {
    const platform = slowPlatform();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(fakeServer(AUTH_RESULT));
    const first = createSession({ baseUrl: "/api/v1", platform });
    await first.store.getState().login({ email: "alice@example.test", password: "correct-horse-battery-staple" });

    // A new start of the app: the server cannot be reached at first.
    fetchMock.mockReset();
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed")).mockImplementation(
      async () =>
        new Response(JSON.stringify(AUTH_RESULT.user), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.useFakeTimers();
    try {
      const { store, apiClient } = createSession({ baseUrl: "/api/v1", platform });
      const started = store.getState().init();
      await vi.advanceTimersByTimeAsync(0);

      expect(store.getState().status).toBe("loading");
      expect((await apiClient.getTokens())?.refreshToken).toBe("refresh");

      await vi.advanceTimersByTimeAsync(1_000);
      await started;
      expect(store.getState().status).toBe("signedIn");
      expect(store.getState().deviceId).toBe("device-1");
    } finally {
      vi.useRealTimers();
    }
  });
});
