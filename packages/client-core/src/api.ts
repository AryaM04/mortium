// The REST client. It sends requests to the server, parses responses with
// the shared zod schemas, and holds the token refresh logic described in
// docs/concepts/auth.md: refresh once on an expired access token, and keep
// the refresh single-flight both inside one tab and across tabs.
import { errorResponseSchema, type RefreshResult } from "@mortium/shared";
import type { z } from "zod";
import type { Platform } from "./platform.js";

/** The tokens client-core keeps for the signed-in device. */
export interface TokenSet {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  deviceId: string;
}

const SESSION_STORE_KEY = "session";

/** A network or API failure. `code` is the stable, machine-readable code. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues?: unknown[];

  constructor(status: number, code: string, message: string, issues?: unknown[]) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

interface RequestOptions<T> {
  body?: unknown;
  schema?: z.ZodType<T>;
  /** Skip the bearer token and the refresh logic (login, register, ...). */
  skipAuth?: boolean;
  /** Send raw bytes with this content type, instead of a JSON body. */
  rawBody?: { data: Uint8Array | Blob; contentType: string };
}

export interface ApiClientOptions {
  /** The API base URL, such as "/api/v1". A function gives the value at the time of each request. */
  baseUrl: string | (() => string);
  platform: Platform;
  /** Called once the client gives up on the session (reuse, invalid refresh token). */
  onSignedOut: () => void;
}

export interface ApiClient {
  request<T>(method: string, path: string, options?: RequestOptions<T>): Promise<T>;
  getTokens(): Promise<TokenSet | null>;
  setTokens(tokens: TokenSet | null): Promise<void>;
  /**
   * A fresh access token for the signed-in device, refreshed first when it
   * is near expiry. Used by the gateway client, which needs a token but
   * does not go through `request`. Throws when no session is stored.
   */
  getAccessToken(): Promise<string>;
}

// A refresh should happen a little before the access token truly expires,
// so that a request started just before expiry does not race the clock.
const REFRESH_SKEW_MS = 60_000;

function isExpiringSoon(expiresAt: string): boolean {
  return Date.parse(expiresAt) - Date.now() < REFRESH_SKEW_MS;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const { baseUrl, platform, onSignedOut } = options;

  async function getTokens(): Promise<TokenSet | null> {
    const raw = await platform.secureStore.get(SESSION_STORE_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as TokenSet;
    } catch {
      return null;
    }
  }

  async function setTokens(tokens: TokenSet | null): Promise<void> {
    if (tokens) {
      await platform.secureStore.set(SESSION_STORE_KEY, JSON.stringify(tokens));
    } else {
      await platform.secureStore.delete(SESSION_STORE_KEY);
    }
  }

  async function rawFetch(
    method: string,
    path: string,
    accessToken: string | null,
    body: unknown,
    rawBody?: { data: Uint8Array | Blob; contentType: string },
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`;
    }
    let requestBody: BodyInit | undefined;
    if (rawBody) {
      headers["Content-Type"] = rawBody.contentType;
      requestBody = rawBody.data as BodyInit;
    } else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      requestBody = JSON.stringify(body);
    }

    try {
      const base = typeof baseUrl === "function" ? baseUrl() : baseUrl;
      return await fetch(`${base}${path}`, { method, headers, body: requestBody });
    } catch {
      throw new ApiError(0, "NETWORK_ERROR", "The server could not be reached. Check your connection.");
    }
  }

  async function parseErrorBody(response: Response): Promise<ApiError> {
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return new ApiError(response.status, "UNKNOWN_ERROR", "The server sent a response that could not be read.");
    }
    const parsed = errorResponseSchema.safeParse(json);
    if (!parsed.success) {
      return new ApiError(response.status, "UNKNOWN_ERROR", "The server sent an unexpected error shape.");
    }
    const { code, message, issues } = parsed.data.error;
    return new ApiError(response.status, code, message, issues as unknown[] | undefined);
  }

  /**
   * Refresh the access token. Single-flight within the tab (the browser
   * lock queues concurrent callers) and across tabs (the lock is a
   * cross-tab primitive). Inside the lock, re-read the stored refresh
   * token first: another tab may already have rotated it, in which case
   * we reuse its result instead of calling the server a second time,
   * since the server treats a second use of a rotated refresh token as
   * theft (TOKEN_REUSED) and signs the device out.
   */
  async function refresh(tokensBeforeRefresh: TokenSet): Promise<TokenSet> {
    return navigator.locks.request("auth-refresh", async () => {
      const current = await getTokens();
      if (!current) {
        throw new ApiError(401, "SIGNED_OUT", "The session was signed out.");
      }
      if (current.refreshToken !== tokensBeforeRefresh.refreshToken) {
        // Another tab already refreshed. Use its result.
        return current;
      }

      const response = await rawFetch("POST", "/auth/refresh", null, {
        refreshToken: current.refreshToken,
      });
      if (!response.ok) {
        const error = await parseErrorBody(response);
        if (error.code === "TOKEN_REUSED" || error.code === "INVALID_REFRESH_TOKEN") {
          await setTokens(null);
          onSignedOut();
        }
        throw error;
      }
      const body = (await response.json()) as RefreshResult;
      const next: TokenSet = {
        accessToken: body.accessToken,
        accessTokenExpiresAt: body.accessTokenExpiresAt,
        refreshToken: body.refreshToken,
        deviceId: current.deviceId,
      };
      await setTokens(next);
      return next;
    });
  }

  async function request<T>(method: string, path: string, requestOptions: RequestOptions<T> = {}): Promise<T> {
    const { body, schema, skipAuth, rawBody } = requestOptions;

    let tokens: TokenSet | null = null;
    if (!skipAuth) {
      tokens = await getTokens();
      if (tokens && isExpiringSoon(tokens.accessTokenExpiresAt)) {
        tokens = await refresh(tokens);
      }
    }

    let response = await rawFetch(method, path, tokens?.accessToken ?? null, body, rawBody);

    if (!skipAuth && response.status === 401 && tokens) {
      const error = await parseErrorBody(response.clone());
      if (error.code === "INVALID_ACCESS_TOKEN") {
        tokens = await refresh(tokens);
        response = await rawFetch(method, path, tokens.accessToken, body, rawBody);
      }
    }

    if (!response.ok) {
      throw await parseErrorBody(response);
    }

    if (response.status === 204 || response.status === 202) {
      return undefined as T;
    }

    const isJson = (response.headers.get("content-type") ?? "").includes("application/json");
    const json = isJson ? await response.json() : await response.text();
    if (!schema) {
      return json as T;
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new ApiError(response.status, "INVALID_RESPONSE", "The server sent a response with an unexpected shape.");
    }
    return parsed.data;
  }

  async function getAccessToken(): Promise<string> {
    let tokens = await getTokens();
    if (!tokens) {
      throw new ApiError(401, "SIGNED_OUT", "There is no session to get a token for.");
    }
    if (isExpiringSoon(tokens.accessTokenExpiresAt)) {
      tokens = await refresh(tokens);
    }
    return tokens.accessToken;
  }

  return { request, getTokens, setTokens, getAccessToken };
}
