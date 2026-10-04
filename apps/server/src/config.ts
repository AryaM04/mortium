// Server configuration, read from environment variables.
// This module fails fast: if a required value is missing or has the wrong
// shape, it throws at startup instead of letting the server run with bad config.
import { z } from "zod";

const envSchema = z.object({
  API_PORT: z.coerce.number().int().positive().default(3000),
  POSTGRES_HOST: z.string().min(1),
  POSTGRES_PORT: z.coerce.number().int().positive().default(5432),
  POSTGRES_DB: z.string().min(1),
  POSTGRES_USER: z.string().min(1),
  POSTGRES_PASSWORD: z.string().min(1),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must have at least 32 characters."),
  TURN_SECRET: z.string().min(1),
  TURN_DOMAIN: z.string().min(1),
  TURN_PORT: z.coerce.number().int().positive().default(3478),
  // The Opus voice bitrate in kbps that every client sends. Opus accepts 6 to 510.
  VOICE_AUDIO_BITRATE_KBPS: z.coerce.number().int().min(6).max(510).default(128),
  // The host name or address that voice clients use to reach TURN. It
  // defaults to TURN_DOMAIN, so most deployments need not set it. An
  // empty value (the common case in a copied .env.example) also falls
  // back to the default, the same as leaving the variable unset.
  TURN_PUBLIC_HOST: z.string().optional(),
  // Set to "true" to also offer a `turns:` (TURN over TLS) URL.
  TURN_TLS_ENABLED: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  TURN_TLS_PORT: z.coerce.number().int().positive().default(5349),

  // Origin of the web app. The server puts it in email links and OAuth redirects.
  WEB_ORIGIN: z.string().min(1).default("http://localhost:5173"),

  // Other origins that can call the API and open the gateway, as a comma
  // list. The desktop app uses "http://tauri.localhost" on Windows,
  // "tauri://localhost" on macOS and "app://mortium" on Linux.
  // Empty: only the web app origin.
  CORS_ALLOWED_ORIGINS: z.string().optional(),

  // The URL scheme of the desktop app. After an OAuth sign-in from the
  // desktop app, the server sends the browser to "<scheme>://auth/callback".
  DESKTOP_URL_SCHEME: z
    .string()
    .regex(/^[a-z][a-z0-9+.-]*$/, "DESKTOP_URL_SCHEME must be a lowercase URL scheme.")
    .default("mortium"),

  // Directory for files the server keeps on disk, such as avatars.
  DATA_DIR: z.string().min(1).default("./data"),

  // SMTP settings for account email (verification, password reset).
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().min(1),

  // OAuth app credentials. A provider is off when its pair is not set.
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  // Browser-visible origin of the API. The server builds OAuth redirect
  // URIs from this value, so it must match what the OAuth app registers.
  PUBLIC_API_URL: z.string().min(1).default("http://localhost:5173"),

  // Base rate limit for auth routes, in requests per minute per IP. Some
  // routes scale this value up or down; see authRateLimit in app config.
  // Raise this in a test environment to avoid 429s from repeated test runs.
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),

  // The largest encrypted attachment, in bytes. Default 25 MiB.
  MAX_ATTACHMENT_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  // The total size of the attachments of one user, in bytes. Default 2 GiB.
  ATTACHMENT_QUOTA_BYTES: z.coerce.number().int().positive().default(2 * 1024 * 1024 * 1024),

  // Set to "true" to accept new events with the plaintext codec (plain-v1).
  // The default rejects them: every client encrypts with megolm-v1. Old
  // plaintext events stay readable in both cases.
  ALLOW_PLAINTEXT_EVENTS: z
    .string()
    .optional()
    .transform((value) => value === "true"),

  // For tests only. Set to "true" to let the link preview route fetch pages
  // from loopback addresses (127.0.0.0/8, ::1) on any port. Every other
  // private address stays blocked. Never set it on a real server.
  LINK_PREVIEW_TEST_ALLOW_LOOPBACK: z
    .string()
    .optional()
    .transform((value) => value === "true"),

  // Set to "true" when one reverse proxy runs in front of the server. The
  // server then reads the client address from the last entry of the
  // X-Forwarded-For header, which the proxy adds. A client cannot change
  // that entry. Never set it when clients can reach the server directly.
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((value) => value === "true"),

  // The GitHub repository ("owner/name") whose latest release the desktop
  // download page shows. Empty: the route is off.
  RELEASES_REPO: z.string().default("AryaM04/mortium"),

  // Write the server log to this file instead of standard output. Empty or
  // unset: standard output.
  LOG_FILE: z.string().optional(),
});

export interface AppConfig {
  apiPort: number;
  databaseUrl: string;
  jwtSecret: string;
  turnSecret: string;
  turnDomain: string;
  turnPort: number;
  turnPublicHost: string;
  turnTlsEnabled: boolean;
  turnTlsPort: number;
  /** The Opus voice bitrate in bits per second. */
  voiceAudioBitrateBps: number;
  webOrigin: string;
  /** Other origins that can call the API and open the gateway, for example the desktop app. */
  corsAllowedOrigins: string[];
  /** The URL scheme of the desktop app, for the OAuth return. */
  desktopUrlScheme: string;
  dataDir: string;
  smtp: {
    host: string;
    port: number;
    user?: string;
    password?: string;
    from: string;
  };
  oauth: {
    github?: { clientId: string; clientSecret: string };
    google?: { clientId: string; clientSecret: string };
  };
  publicApiUrl: string;
  // Rate limits for auth routes, in requests per minute per IP. Each field
  // scales from AUTH_RATE_LIMIT_PER_MINUTE, so one env var tunes all of them.
  authRateLimit: {
    register: number;
    login: number;
    refresh: number;
    resendVerification: number;
    forgotPassword: number;
    /** The email link routes: verify-email and reset-password. */
    emailLink: number;
    /** The OAuth routes: start, callback and exchange. */
    oauth: number;
    /** Failed sign-in attempts for one account in 15 minutes, from all IP addresses. */
    loginFailuresPerAccount: number;
  };
  /** Accept new events with the plaintext codec. Off by default. */
  allowPlaintextEvents: boolean;
  /** The largest encrypted attachment, in bytes. */
  maxAttachmentBytes: number;
  /** The total size of the attachments of one user, in bytes. */
  attachmentQuotaBytes: number;
  /** For tests only: the link preview route can fetch from loopback addresses. */
  linkPreviewTestAllowLoopback: boolean;
  /** One reverse proxy runs in front of the server. The client address is the last X-Forwarded-For entry. */
  trustProxy?: boolean;
  /** The GitHub repository of the desktop releases. Empty: the download route is off. */
  releasesRepo: string;
  /** The server log goes to this file, or to standard output when it is undefined. */
  logFile?: string;
}

/**
 * Read a comma list of origins, such as "http://tauri.localhost,
 * tauri://localhost". Each entry has only a scheme, a host and an optional
 * port. Throw when an entry has more than that.
 */
export function parseOriginList(raw: string | undefined): string[] {
  const origins: string[] = [];
  for (const entry of (raw ?? "").split(",")) {
    const value = entry.trim();
    if (value.length === 0) {
      continue;
    }
    let url: URL | null = null;
    try {
      url = new URL(value);
    } catch {
      // The check below reports the entry.
    }
    if (!url || !url.host || (url.pathname !== "" && url.pathname !== "/") || url.search || url.hash || url.username) {
      throw new Error(`Server config is not valid. CORS_ALLOWED_ORIGINS has an entry that is not an origin: ${value}`);
    }
    // `URL.origin` is "null" for a custom scheme such as "tauri:", so build the origin from its parts.
    origins.push(`${url.protocol}//${url.host}`);
  }
  return origins;
}

/** Read and check the process environment. Throw a clear error on bad input. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Server config is not valid. Fix these values: ${issues}`);
  }

  const data = parsed.data;
  const databaseUrl = `postgres://${data.POSTGRES_USER}:${data.POSTGRES_PASSWORD}@${data.POSTGRES_HOST}:${data.POSTGRES_PORT}/${data.POSTGRES_DB}`;

  const oauth: AppConfig["oauth"] = {};
  if (data.GITHUB_CLIENT_ID && data.GITHUB_CLIENT_SECRET) {
    oauth.github = { clientId: data.GITHUB_CLIENT_ID, clientSecret: data.GITHUB_CLIENT_SECRET };
  }
  if (data.GOOGLE_CLIENT_ID && data.GOOGLE_CLIENT_SECRET) {
    oauth.google = { clientId: data.GOOGLE_CLIENT_ID, clientSecret: data.GOOGLE_CLIENT_SECRET };
  }

  return {
    apiPort: data.API_PORT,
    databaseUrl,
    jwtSecret: data.JWT_SECRET,
    turnSecret: data.TURN_SECRET,
    turnDomain: data.TURN_DOMAIN,
    turnPort: data.TURN_PORT,
    turnPublicHost: data.TURN_PUBLIC_HOST && data.TURN_PUBLIC_HOST.length > 0 ? data.TURN_PUBLIC_HOST : data.TURN_DOMAIN,
    turnTlsEnabled: data.TURN_TLS_ENABLED ?? false,
    turnTlsPort: data.TURN_TLS_PORT,
    voiceAudioBitrateBps: data.VOICE_AUDIO_BITRATE_KBPS * 1000,
    webOrigin: data.WEB_ORIGIN,
    corsAllowedOrigins: parseOriginList(data.CORS_ALLOWED_ORIGINS),
    desktopUrlScheme: data.DESKTOP_URL_SCHEME,
    dataDir: data.DATA_DIR,
    smtp: {
      host: data.SMTP_HOST,
      port: data.SMTP_PORT,
      user: data.SMTP_USER,
      password: data.SMTP_PASSWORD,
      from: data.SMTP_FROM,
    },
    oauth,
    publicApiUrl: data.PUBLIC_API_URL,
    authRateLimit: {
      register: data.AUTH_RATE_LIMIT_PER_MINUTE,
      login: data.AUTH_RATE_LIMIT_PER_MINUTE,
      refresh: data.AUTH_RATE_LIMIT_PER_MINUTE * 3,
      resendVerification: Math.max(1, Math.round(data.AUTH_RATE_LIMIT_PER_MINUTE / 2)),
      forgotPassword: data.AUTH_RATE_LIMIT_PER_MINUTE,
      emailLink: data.AUTH_RATE_LIMIT_PER_MINUTE,
      oauth: data.AUTH_RATE_LIMIT_PER_MINUTE * 3,
      loginFailuresPerAccount: data.AUTH_RATE_LIMIT_PER_MINUTE,
    },
    allowPlaintextEvents: data.ALLOW_PLAINTEXT_EVENTS,
    maxAttachmentBytes: data.MAX_ATTACHMENT_BYTES,
    attachmentQuotaBytes: data.ATTACHMENT_QUOTA_BYTES,
    linkPreviewTestAllowLoopback: data.LINK_PREVIEW_TEST_ALLOW_LOOPBACK,
    trustProxy: data.TRUST_PROXY,
    releasesRepo: data.RELEASES_REPO.trim(),
    logFile: data.LOG_FILE ? data.LOG_FILE : undefined,
  };
}
