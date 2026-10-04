// Auth routes. Each handler validates the body, calls a service function,
// and replies. The logic lives in service.ts and oauth.ts.
import type { FastifyInstance } from "fastify";
import {
  forgotPasswordRequestSchema,
  loginRequestSchema,
  oauthExchangeRequestSchema,
  oauthProviderSchema,
  refreshRequestSchema,
  registerRequestSchema,
  resetPasswordRequestSchema,
  verifyEmailRequestSchema,
  type OAuthProvider,
} from "@mortium/shared";
import { generateCodeVerifier, generateState, type GitHub, type Google } from "arctic";
import type { AppDeps } from "../../app.js";
import { AppError } from "../../errors.js";
import { summarizeUserAgent } from "./device-name.js";
import { createLoginFailureGuard } from "./login-guard.js";
import { consumeOAuthCode, storeOAuthCode } from "./oauth-codes.js";
import { createOAuthClients, completeOAuthLogin, fetchGitHubProfile, fetchGoogleProfile } from "./oauth.js";
import {
  forgotPassword,
  loginUser,
  logoutDevice,
  refreshSession,
  registerUser,
  resendVerification,
  resetPassword,
  toAuthResult,
  createSession,
  verifyEmail,
} from "./service.js";

const OAUTH_COOKIE_NAME = "oauth_flow";
const OAUTH_COOKIE_TTL_SECONDS = 10 * 60;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60_000;

/** The app that started the sign-in. It decides where the callback sends the browser. */
type OAuthClientApp = "web" | "desktop";

interface OAuthCookiePayload {
  provider: OAuthProvider;
  state: string;
  codeVerifier?: string;
  client?: OAuthClientApp;
}

/**
 * The page that gets the one-time code (or an error) in its URL hash. The
 * web app gets a page on its own origin. The desktop app gets a link with
 * its own URL scheme, which the operating system gives to the app.
 */
export function oauthReturnUrl(
  config: { webOrigin: string; desktopUrlScheme: string },
  client: OAuthClientApp | undefined,
): string {
  return client === "desktop" ? `${config.desktopUrlScheme}://auth/callback` : `${config.webOrigin}/auth/callback`;
}

export async function registerAuthRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const authDeps = { db: deps.db, config: deps.config, mailer: deps.mailer, gateway: deps.gateway, log: app.log };
  const oauthClients = createOAuthClients(deps.config);
  const limits = deps.config.authRateLimit;
  const loginGuard =
    deps.rateLimit === false ? null : createLoginFailureGuard(limits.loginFailuresPerAccount, LOGIN_FAILURE_WINDOW_MS);
  const emailLinkLimit = { rateLimit: { max: limits.emailLink, timeWindow: "1 minute" } };
  const oauthLimit = { rateLimit: { max: limits.oauth, timeWindow: "1 minute" } };

  app.post(
    "/register",
    { config: { rateLimit: { max: deps.config.authRateLimit.register, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const input = registerRequestSchema.parse(request.body);
      const result = await registerUser(authDeps, input, summarizeUserAgent(request.headers["user-agent"]));
      return reply.status(201).send(result);
    },
  );

  app.post(
    "/login",
    { config: { rateLimit: { max: deps.config.authRateLimit.login, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const input = loginRequestSchema.parse(request.body);
      if (loginGuard?.isLocked(input.email)) {
        throw new AppError(429, "RATE_LIMITED", "This account had too many failed sign-in attempts. Try again later.");
      }
      try {
        const result = await loginUser(authDeps, input, summarizeUserAgent(request.headers["user-agent"]));
        return reply.status(200).send(result);
      } catch (error) {
        if (error instanceof AppError && error.code === "INVALID_CREDENTIALS") {
          loginGuard?.recordFailure(input.email);
        }
        throw error;
      }
    },
  );

  app.post(
    "/refresh",
    { config: { rateLimit: { max: deps.config.authRateLimit.refresh, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const input = refreshRequestSchema.parse(request.body);
      const result = await refreshSession(authDeps, input.refreshToken);
      return reply.status(200).send(result);
    },
  );

  app.post("/logout", { preHandler: app.authenticate }, async (request, reply) => {
    await logoutDevice(authDeps, request.auth!.deviceId);
    return reply.status(204).send();
  });

  app.post("/verify-email", { config: emailLinkLimit }, async (request, reply) => {
    const input = verifyEmailRequestSchema.parse(request.body);
    await verifyEmail(authDeps, input.token);
    return reply.status(204).send();
  });

  app.post(
    "/resend-verification",
    {
      preHandler: app.authenticate,
      config: { rateLimit: { max: deps.config.authRateLimit.resendVerification, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      await resendVerification(authDeps, request.auth!.userId);
      return reply.status(202).send();
    },
  );

  app.post(
    "/forgot-password",
    { config: { rateLimit: { max: deps.config.authRateLimit.forgotPassword, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const input = forgotPasswordRequestSchema.parse(request.body);
      await forgotPassword(authDeps, input.email);
      return reply.status(202).send();
    },
  );

  app.post("/reset-password", { config: emailLinkLimit }, async (request, reply) => {
    const input = resetPasswordRequestSchema.parse(request.body);
    await resetPassword(authDeps, input.token, input.password);
    return reply.status(204).send();
  });

  app.get("/providers", async (_request, reply) => {
    return reply.send({ providers: Object.keys(oauthClients) as OAuthProvider[] });
  });

  app.get("/oauth/:provider/start", { config: oauthLimit }, async (request, reply) => {
    const provider = oauthProviderSchema.parse((request.params as { provider: string }).provider);
    const client = oauthClients[provider];
    if (!client) {
      throw new AppError(404, "OAUTH_PROVIDER_DISABLED", "This sign-in provider is not turned on.");
    }

    const state = generateState();
    const cookiePayload: OAuthCookiePayload = { provider, state };
    if ((request.query as { client?: string }).client === "desktop") {
      cookiePayload.client = "desktop";
    }

    let url: URL;
    if (provider === "google") {
      const codeVerifier = generateCodeVerifier();
      cookiePayload.codeVerifier = codeVerifier;
      url = (client as Google).createAuthorizationURL(state, codeVerifier, ["openid", "email"]);
    } else {
      url = (client as GitHub).createAuthorizationURL(state, ["read:user", "user:email"]);
    }

    reply.setCookie(OAUTH_COOKIE_NAME, JSON.stringify(cookiePayload), {
      httpOnly: true,
      sameSite: "lax",
      signed: true,
      path: "/api/v1/auth/oauth",
      maxAge: OAUTH_COOKIE_TTL_SECONDS,
    });

    return reply.redirect(url.toString(), 302);
  });

  app.get("/oauth/:provider/callback", { config: oauthLimit }, async (request, reply) => {
    const provider = oauthProviderSchema.parse((request.params as { provider: string }).provider);

    // Read the signed cookie first: it tells which app started the sign-in.
    const rawCookie = request.cookies[OAUTH_COOKIE_NAME];
    const unsigned = rawCookie ? request.unsignCookie(rawCookie) : null;
    let cookiePayload: OAuthCookiePayload | null = null;
    if (unsigned?.valid && unsigned.value) {
      try {
        cookiePayload = JSON.parse(unsigned.value) as OAuthCookiePayload;
      } catch {
        cookiePayload = null;
      }
    }
    const returnUrl = oauthReturnUrl(deps.config, cookiePayload?.client);
    const errorRedirect = (code: string) => {
      reply.clearCookie(OAUTH_COOKIE_NAME, { path: "/api/v1/auth/oauth" });
      return reply.redirect(`${returnUrl}#error=${code}`, 302);
    };

    const client = oauthClients[provider];
    if (!client) {
      return errorRedirect("OAUTH_PROVIDER_DISABLED");
    }

    const query = request.query as { code?: string; state?: string };
    if (!query.code || !query.state || !rawCookie) {
      return errorRedirect("OAUTH_STATE_MISSING");
    }
    if (!cookiePayload) {
      return errorRedirect("OAUTH_STATE_INVALID");
    }
    if (cookiePayload.provider !== provider || cookiePayload.state !== query.state) {
      return errorRedirect("OAUTH_STATE_INVALID");
    }

    try {
      const tokens =
        provider === "google"
          ? await (client as Google).validateAuthorizationCode(query.code, cookiePayload.codeVerifier ?? "")
          : await (client as GitHub).validateAuthorizationCode(query.code);

      const profile =
        provider === "google"
          ? await fetchGoogleProfile(tokens.accessToken())
          : await fetchGitHubProfile(tokens.accessToken());

      const user = await completeOAuthLogin(deps.db, provider, profile);
      const session = await createSession(
        deps.db,
        deps.config,
        user.id,
        summarizeUserAgent(request.headers["user-agent"]),
      );
      const result = toAuthResult(user, session);
      const code = storeOAuthCode(result);

      reply.clearCookie(OAUTH_COOKIE_NAME, { path: "/api/v1/auth/oauth" });
      return reply.redirect(`${returnUrl}#code=${code}`, 302);
    } catch (error) {
      request.log.warn(error, "The OAuth callback failed.");
      const code = error instanceof AppError ? error.code : "OAUTH_FAILED";
      return errorRedirect(code);
    }
  });

  app.post("/oauth/exchange", { config: oauthLimit }, async (request, reply) => {
    const input = oauthExchangeRequestSchema.parse(request.body);
    const result = consumeOAuthCode(input.code);
    if (!result) {
      throw new AppError(401, "INVALID_OAUTH_CODE", "This sign-in code is not valid, expired or already used.");
    }
    return reply.status(200).send(result);
  });
}
