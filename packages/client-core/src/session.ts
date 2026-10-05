// The session store: who is signed in, and every action that changes
// that. It is a vanilla zustand store, so both the web app (with the
// React binding) and a future desktop shell can use it the same way.
// The password never goes to the server: the client sends an auth key
// that it derives from the password (see docs/concepts/password-keys.md).
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  authResultSchema,
  meResultSchema,
  oauthProvidersResultSchema,
  userSchema,
  type AuthResult,
  type LoginForm,
  type OAuthProvidersResult,
  type RegisterForm,
  type UpdateMeRequest,
  type User,
} from "@mortium/shared";
import {
  createAccountKeys,
  derivePasswordKeys,
  newPasswordKeys,
  prelogin,
  upgradeLegacyPassword,
  type AccountKeys,
} from "./account-keys.js";
import { ApiError, createApiClient, type ApiClient, type TokenSet } from "./api.js";
import type { Platform } from "./platform.js";

export type SessionStatus = "loading" | "signedOut" | "signedIn";

export interface SessionState {
  status: SessionStatus;
  user: User | null;
  deviceId: string | null;
}

export interface SessionActions {
  init(): Promise<void>;
  register(input: RegisterForm): Promise<void>;
  login(input: LoginForm): Promise<void>;
  logout(): Promise<void>;
  completeOAuth(code: string): Promise<void>;
  updateProfile(input: UpdateMeRequest): Promise<void>;
  uploadAvatar(file: Blob): Promise<void>;
  removeAvatar(): Promise<void>;
  verifyEmail(token: string): Promise<void>;
  resendVerification(): Promise<void>;
  forgotPassword(email: string): Promise<void>;
  resetPassword(token: string, password: string): Promise<void>;
  getProviders(): Promise<OAuthProvidersResult>;
}

export type SessionStore = SessionState & SessionActions;

// A cross-tab signal, so a sign-in or sign-out in one tab updates the
// others straight away, with no polling and no "storage" event hacks.
type BroadcastMessage = { type: "signed-in" } | { type: "signed-out" };

export interface CreateSessionOptions {
  baseUrl: string | (() => string);
  platform: Platform;
}

export interface Session {
  store: StoreApi<SessionStore>;
  apiClient: ApiClient;
  /** The keys of the account password in this tab. */
  keys: AccountKeys;
}

/** Build the session store and the API client it uses, wired together. */
export function createSession(options: CreateSessionOptions): Session {
  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("session") : null;

  // `onSignedOut` fires from inside the API client's refresh logic (a
  // rotated or reused refresh token). It is set below, once the store
  // exists, so the two pieces can reference each other.
  let handleSignedOut: () => void = () => {};
  const apiClient = createApiClient({
    baseUrl: options.baseUrl,
    platform: options.platform,
    onSignedOut: () => handleSignedOut(),
  });

  /**
   * Store the tokens and sign in. `prepare` runs after the tokens are stored
   * and before the status becomes "signedIn": a call that needs the new
   * session can go there.
   */
  async function applyAuthResult(
    result: AuthResult,
    set: (partial: Partial<SessionState>) => void,
    prepare?: () => Promise<void>,
  ): Promise<void> {
    const tokens: TokenSet = {
      accessToken: result.accessToken,
      accessTokenExpiresAt: result.accessTokenExpiresAt,
      refreshToken: result.refreshToken,
      deviceId: result.deviceId,
    };
    // Store the tokens first. The gateway and the crypto layer start on
    // "signedIn" and read the tokens at once. Another tab reads them on
    // "signed-in".
    await apiClient.setTokens(tokens);
    await prepare?.();
    set({ status: "signedIn", user: result.user, deviceId: result.deviceId });
    channel?.postMessage({ type: "signed-in" } satisfies BroadcastMessage);
  }

  // The wait times, in ms, between the tries to load the user.
  // The last time repeats.
  const RETRY_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000];

  // The store exists only after this call, so the keys read the user through a function.
  const keys = createAccountKeys(apiClient, () => store.getState().user);

  const store = createStore<SessionStore>((set, get) => {
    // The number of the latest restore. A newer restore stops the older one.
    let restoreCount = 0;

    async function fetchMe(): Promise<void> {
      const user = await apiClient.request<User>("GET", "/users/@me", { schema: meResultSchema });
      set({ status: "signedIn", user });
    }

    async function clearSession(): Promise<void> {
      restoreCount++;
      keys.hold(null);
      await apiClient.setTokens(null);
      set({ status: "signedOut", user: null, deviceId: null });
      channel?.postMessage({ type: "signed-out" } satisfies BroadcastMessage);
    }

    // Load the user of the stored tokens. Clear the session only when the
    // server rejects the tokens. After a network error or a server error,
    // keep the tokens and try again, because the tokens are still good.
    async function restore(deviceId: string): Promise<void> {
      const id = ++restoreCount;
      set({ deviceId });
      for (let attempt = 0; id === restoreCount; attempt++) {
        try {
          await fetchMe();
          return;
        } catch (error) {
          if (error instanceof ApiError && error.status === 401) {
            await clearSession();
            return;
          }
        }
        const delay = RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)];
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    channel?.addEventListener("message", (event: MessageEvent<BroadcastMessage>) => {
      if (event.data.type === "signed-out" && get().status !== "signedOut") {
        restoreCount++;
        keys.hold(null);
        set({ status: "signedOut", user: null, deviceId: null });
      } else if (event.data.type === "signed-in" && get().status !== "signedIn") {
        void apiClient.getTokens().then((tokens) => tokens && restore(tokens.deviceId));
      }
    });

    return {
      status: "loading",
      user: null,
      deviceId: null,

      async init() {
        const tokens = await apiClient.getTokens();
        if (!tokens) {
          set({ status: "signedOut", user: null, deviceId: null });
          return;
        }
        await restore(tokens.deviceId);
      },

      async register({ password, ...input }) {
        const passwordKeys = await newPasswordKeys(password);
        const result = await apiClient.request<AuthResult>("POST", "/auth/register", {
          body: { ...input, authKey: passwordKeys.authKey, kdfSalt: passwordKeys.kdfSalt, kdfVersion: 1 },
          schema: authResultSchema,
          skipAuth: true,
        });
        keys.hold(passwordKeys);
        await applyAuthResult(result, set);
      },

      async login({ email, password }) {
        const answer = await prelogin(apiClient, email);
        if (answer.kdf === "legacy") {
          // An account from before the password keys: send the password one
          // time, then give the account a password key.
          const result = await apiClient.request<AuthResult>("POST", "/auth/login", {
            body: { email, password },
            schema: authResultSchema,
            skipAuth: true,
          });
          await applyAuthResult(result, set, async () => {
            try {
              keys.hold(await upgradeLegacyPassword(apiClient, password));
            } catch {
              // The sign-in is complete. The next sign-in tries the change again.
            }
          });
          return;
        }
        const passwordKeys = await derivePasswordKeys(password, answer.salt);
        const result = await apiClient.request<AuthResult>("POST", "/auth/login", {
          body: { email, authKey: passwordKeys.authKey },
          schema: authResultSchema,
          skipAuth: true,
        });
        keys.hold(passwordKeys);
        await applyAuthResult(result, set);
      },

      async logout() {
        try {
          await apiClient.request("POST", "/auth/logout", {});
        } catch {
          // Best effort: the server call can fail, but the device must
          // still forget its local session.
        }
        await clearSession();
      },

      async completeOAuth(code) {
        const result = await apiClient.request<AuthResult>("POST", "/auth/oauth/exchange", {
          body: { code },
          schema: authResultSchema,
          skipAuth: true,
        });
        await applyAuthResult(result, set);
      },

      async updateProfile(input) {
        const user = await apiClient.request<User>("PATCH", "/users/@me", {
          body: input,
          schema: userSchema,
        });
        set({ user });
      },

      async uploadAvatar(file) {
        const contentType = file.type || "application/octet-stream";
        const data = new Uint8Array(await file.arrayBuffer());
        const user = await apiClient.request<User>("PUT", "/users/@me/avatar", {
          rawBody: { data, contentType },
          schema: userSchema,
        });
        set({ user });
      },

      async removeAvatar() {
        const user = await apiClient.request<User>("DELETE", "/users/@me/avatar", {
          schema: userSchema,
        });
        set({ user });
      },

      async verifyEmail(token) {
        await apiClient.request("POST", "/auth/verify-email", { body: { token }, skipAuth: true });
        const current = get().user;
        if (current) {
          set({ user: { ...current, emailVerified: true } });
        }
      },

      async resendVerification() {
        await apiClient.request("POST", "/auth/resend-verification", {});
      },

      async forgotPassword(email) {
        await apiClient.request("POST", "/auth/forgot-password", { body: { email }, skipAuth: true });
      },

      async resetPassword(token, password) {
        const passwordKeys = await newPasswordKeys(password);
        await apiClient.request("POST", "/auth/reset-password", {
          body: { token, authKey: passwordKeys.authKey, kdfSalt: passwordKeys.kdfSalt, kdfVersion: 1 },
          skipAuth: true,
        });
      },

      async getProviders() {
        return apiClient.request<OAuthProvidersResult>("GET", "/auth/providers", {
          schema: oauthProvidersResultSchema,
          skipAuth: true,
        });
      },
    };
  });

  handleSignedOut = () => {
    keys.hold(null);
    store.setState({ status: "signedOut", user: null, deviceId: null });
    channel?.postMessage({ type: "signed-out" } satisfies BroadcastMessage);
  };

  return { store, apiClient, keys };
}
