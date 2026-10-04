// The session store: who is signed in, and every action that changes
// that. It is a vanilla zustand store, so both the web app (with the
// React binding) and a future desktop shell can use it the same way.
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  authResultSchema,
  meResultSchema,
  oauthProvidersResultSchema,
  userSchema,
  type AuthResult,
  type LoginRequest,
  type OAuthProvidersResult,
  type RegisterRequest,
  type UpdateMeRequest,
  type User,
} from "@mortium/shared";
import { createApiClient, type ApiClient, type TokenSet } from "./api.js";
import type { Platform } from "./platform.js";

export type SessionStatus = "loading" | "signedOut" | "signedIn";

export interface SessionState {
  status: SessionStatus;
  user: User | null;
  deviceId: string | null;
}

export interface SessionActions {
  init(): Promise<void>;
  register(input: RegisterRequest): Promise<void>;
  login(input: LoginRequest): Promise<void>;
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

  async function applyAuthResult(result: AuthResult, set: (partial: Partial<SessionState>) => void): Promise<void> {
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
    set({ status: "signedIn", user: result.user, deviceId: result.deviceId });
    channel?.postMessage({ type: "signed-in" } satisfies BroadcastMessage);
  }

  const store = createStore<SessionStore>((set, get) => {
    async function fetchMe(): Promise<void> {
      const user = await apiClient.request<User>("GET", "/users/@me", { schema: meResultSchema });
      set({ status: "signedIn", user });
    }

    async function clearSession(): Promise<void> {
      await apiClient.setTokens(null);
      set({ status: "signedOut", user: null, deviceId: null });
      channel?.postMessage({ type: "signed-out" } satisfies BroadcastMessage);
    }

    channel?.addEventListener("message", (event: MessageEvent<BroadcastMessage>) => {
      if (event.data.type === "signed-out" && get().status !== "signedOut") {
        set({ status: "signedOut", user: null, deviceId: null });
      } else if (event.data.type === "signed-in" && get().status !== "signedIn") {
        void fetchMe().catch(() => clearSession());
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
        set({ deviceId: tokens.deviceId });
        try {
          await fetchMe();
        } catch {
          await clearSession();
        }
      },

      async register(input) {
        const result = await apiClient.request<AuthResult>("POST", "/auth/register", {
          body: input,
          schema: authResultSchema,
          skipAuth: true,
        });
        await applyAuthResult(result, set);
      },

      async login(input) {
        const result = await apiClient.request<AuthResult>("POST", "/auth/login", {
          body: input,
          schema: authResultSchema,
          skipAuth: true,
        });
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
        await apiClient.request("POST", "/auth/reset-password", {
          body: { token, password },
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
    store.setState({ status: "signedOut", user: null, deviceId: null });
    channel?.postMessage({ type: "signed-out" } satisfies BroadcastMessage);
  };

  return { store, apiClient };
}
