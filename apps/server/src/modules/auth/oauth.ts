// OAuth sign-in: provider set-up, profile fetching, and the account-linking
// logic in completeOAuthLogin. Route handlers stay in routes.ts.
import { and, eq } from "drizzle-orm";
import { GitHub, Google } from "arctic";
import type { OAuthProvider } from "@mortium/shared";
import type { AppConfig } from "../../config.js";
import { isUniqueViolation, type DbClient } from "../../db/client.js";
import { oauthAccounts, users } from "../../db/schema.js";
import { AppError } from "../../errors.js";
import { nextId } from "../../id.js";
import type { UserRow } from "../users/serialize.js";

export type OAuthClient = GitHub | Google;

/** Build one arctic client per provider that has credentials in config. */
export function createOAuthClients(config: AppConfig): Partial<Record<OAuthProvider, OAuthClient>> {
  const clients: Partial<Record<OAuthProvider, OAuthClient>> = {};

  if (config.oauth.github) {
    clients.github = new GitHub(
      config.oauth.github.clientId,
      config.oauth.github.clientSecret,
      `${config.publicApiUrl}/api/v1/auth/oauth/github/callback`,
    );
  }

  if (config.oauth.google) {
    clients.google = new Google(
      config.oauth.google.clientId,
      config.oauth.google.clientSecret,
      `${config.publicApiUrl}/api/v1/auth/oauth/google/callback`,
    );
  }

  return clients;
}

export interface OAuthProfile {
  providerUserId: string;
  email: string;
  emailVerified: boolean;
  usernameHint: string;
}

interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
}

interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

/** Fetch the GitHub profile and the primary, verified email of the signed-in user. */
export async function fetchGitHubProfile(accessToken: string): Promise<OAuthProfile> {
  const headers = { Authorization: `Bearer ${accessToken}`, "User-Agent": "mortium" };

  const userResponse = await fetch("https://api.github.com/user", { headers });
  if (!userResponse.ok) {
    throw new AppError(502, "OAUTH_PROVIDER_ERROR", "GitHub did not return the user profile.");
  }
  const user = (await userResponse.json()) as GitHubUser;

  const emailsResponse = await fetch("https://api.github.com/user/emails", { headers });
  if (!emailsResponse.ok) {
    throw new AppError(502, "OAUTH_PROVIDER_ERROR", "GitHub did not return the user email list.");
  }
  const emails = (await emailsResponse.json()) as GitHubEmail[];
  const primary = emails.find((entry) => entry.primary && entry.verified);
  if (!primary) {
    throw new AppError(400, "OAUTH_EMAIL_NOT_VERIFIED", "GitHub has no verified primary email for this account.");
  }

  return {
    providerUserId: String(user.id),
    email: primary.email,
    emailVerified: true,
    usernameHint: user.login || user.name || "user",
  };
}

interface GoogleUserInfo {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
}

/** Fetch the Google profile of the signed-in user. Requires a verified email. */
export async function fetchGoogleProfile(accessToken: string): Promise<OAuthProfile> {
  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new AppError(502, "OAUTH_PROVIDER_ERROR", "Google did not return the user profile.");
  }
  const info = (await response.json()) as GoogleUserInfo;
  if (!info.email_verified) {
    throw new AppError(400, "OAUTH_EMAIL_NOT_VERIFIED", "Google has no verified email for this account.");
  }

  return {
    providerUserId: info.sub,
    email: info.email,
    emailVerified: true,
    usernameHint: info.name || info.email.split("@")[0] || info.email,
  };
}

/** Keep only lowercase letters, digits, underscore and dot; give it a safe fallback. */
export function sanitizeUsernameBase(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9_.]/g, "");
  const trimmed = cleaned.slice(0, 32);
  return trimmed.length >= 2 ? trimmed : "user";
}

async function usernameExists(db: DbClient, username: string): Promise<boolean> {
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
  return rows.length > 0;
}

/** Find a free username, starting from a sanitized base, adding a number suffix if needed. */
export async function generateUniqueUsername(db: DbClient, base: string): Promise<string> {
  const cleanBase = sanitizeUsernameBase(base);
  if (!(await usernameExists(db, cleanBase))) {
    return cleanBase;
  }

  for (let attempt = 0; attempt < 25; attempt += 1) {
    const suffix = String(Math.floor(1000 + Math.random() * 9000));
    const candidate = `${cleanBase.slice(0, 32 - suffix.length)}${suffix}`;
    if (!(await usernameExists(db, candidate))) {
      return candidate;
    }
  }

  throw new AppError(500, "INTERNAL_ERROR", "Could not make a free username after many tries.");
}

async function findUserById(db: DbClient, id: bigint): Promise<UserRow | undefined> {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return rows[0];
}

async function findUserByEmail(db: DbClient, email: string): Promise<UserRow | undefined> {
  const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return rows[0];
}

/**
 * Turn a verified OAuth profile into a user row: reuse the linked account,
 * link a new provider to an account with the same verified email, or make
 * a new user.
 * This function never talks to a real OAuth provider, so tests can call it
 * directly with a made-up profile.
 */
export async function completeOAuthLogin(
  db: DbClient,
  provider: OAuthProvider,
  profile: OAuthProfile,
): Promise<UserRow> {
  const linked = await db
    .select({ userId: oauthAccounts.userId })
    .from(oauthAccounts)
    .where(and(eq(oauthAccounts.provider, provider), eq(oauthAccounts.providerUserId, profile.providerUserId)))
    .limit(1);

  const linkedRow = linked[0];
  if (linkedRow) {
    const user = await findUserById(db, linkedRow.userId);
    if (!user) {
      throw new AppError(500, "INTERNAL_ERROR", "A linked OAuth account points at a user that does not exist.");
    }
    return user;
  }

  if (profile.emailVerified) {
    const existingByEmail = await findUserByEmail(db, profile.email);
    if (existingByEmail) {
      // Another person can register this email with a password and not
      // verify it. A link would then give that person access to the
      // account of the real owner. Link only to a verified account.
      if (!existingByEmail.emailVerified) {
        throw new AppError(
          409,
          "OAUTH_ACCOUNT_NOT_VERIFIED",
          "An account with this email address exists, but its email is not verified. Sign in with the password and verify the email first.",
        );
      }
      await db
        .insert(oauthAccounts)
        .values({ provider, providerUserId: profile.providerUserId, userId: existingByEmail.id });
      return existingByEmail;
    }
  }

  const username = await generateUniqueUsername(db, profile.usernameHint);
  const id = nextId();

  try {
    await db.insert(users).values({
      id,
      username,
      displayName: username,
      email: profile.email,
      emailVerified: profile.emailVerified,
      passwordHash: null,
    });
  } catch (error) {
    if (isUniqueViolation(error, "email")) {
      // This email already belongs to another account, and the provider did
      // not vouch for it here, so linking would be a guess. Refuse instead.
      throw new AppError(
        409,
        "OAUTH_EMAIL_TAKEN",
        "An account with this email address already exists. Verify this email with the provider to link it.",
      );
    }
    throw error;
  }
  await db.insert(oauthAccounts).values({ provider, providerUserId: profile.providerUserId, userId: id });

  const created = await findUserById(db, id);
  if (!created) {
    throw new AppError(500, "INTERNAL_ERROR", "The user was not found right after it was made.");
  }
  return created;
}
