// Unit tests for the OAuth account-linking logic. These call
// completeOAuthLogin directly with a made-up profile; they never call a
// real OAuth provider.
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { oauthAccounts, users } from "../../db/schema.js";
import { createTestDb, describeWithDb, type TestDb } from "../../../test/db.js";
import { completeOAuthLogin, generateUniqueUsername, sanitizeUsernameBase } from "./oauth.js";
import { nextId } from "../../id.js";

let testDb: TestDb;

describeWithDb("sanitizeUsernameBase", () => {
  it("lowercases and strips characters outside the allowed set", () => {
    expect(sanitizeUsernameBase("Jane Doe!!")).toBe("janedoe");
  });

  it("falls back to a safe default when nothing usable is left", () => {
    expect(sanitizeUsernameBase("!!!")).toBe("user");
  });

  it("cuts a very long name down to 32 characters", () => {
    const long = "a".repeat(50);
    expect(sanitizeUsernameBase(long)).toHaveLength(32);
  });
});

describeWithDb("completeOAuthLogin", () => {
  beforeAll(async () => {
    testDb = await createTestDb();
  });

  afterAll(async () => {
    await testDb.close();
  });

  it("creates a new user for a first-time, verified profile", async () => {
    const user = await completeOAuthLogin(testDb.db, "github", {
      providerUserId: "gh-1",
      email: "newperson@example.com",
      emailVerified: true,
      usernameHint: "New Person",
    });

    expect(user.email).toBe("newperson@example.com");
    expect(user.emailVerified).toBe(true);
    expect(user.passwordHash).toBeNull();
    expect(user.username).toBe("newperson");
  });

  it("reuses the same user on a second login with the same provider account", async () => {
    const first = await completeOAuthLogin(testDb.db, "github", {
      providerUserId: "gh-2",
      email: "repeat@example.com",
      emailVerified: true,
      usernameHint: "repeat",
    });
    const second = await completeOAuthLogin(testDb.db, "github", {
      providerUserId: "gh-2",
      email: "repeat@example.com",
      emailVerified: true,
      usernameHint: "repeat",
    });

    expect(second.id).toBe(first.id);
  });

  it("links a new provider to an existing user with the same verified email", async () => {
    const emailUser = await completeOAuthLogin(testDb.db, "github", {
      providerUserId: "gh-3",
      email: "shared@example.com",
      emailVerified: true,
      usernameHint: "shared",
    });

    const linked = await completeOAuthLogin(testDb.db, "google", {
      providerUserId: "google-3",
      email: "shared@example.com",
      emailVerified: true,
      usernameHint: "shared-again",
    });

    expect(linked.id).toBe(emailUser.id);
  });

  it("makes a unique username when the sanitized name is already taken", async () => {
    const id = nextId();
    await testDb.db.insert(users).values({
      id,
      username: "taken",
      displayName: "Taken",
      email: "taken-user@example.com",
      emailVerified: true,
      passwordHash: null,
    });

    const created = await completeOAuthLogin(testDb.db, "github", {
      providerUserId: "gh-4",
      email: "newtaken@example.com",
      emailVerified: true,
      usernameHint: "taken",
    });

    expect(created.username).not.toBe("taken");
    expect(created.username.startsWith("taken")).toBe(true);
  });

  it("does not link to an existing user when the email is not verified", async () => {
    await testDb.db.insert(users).values({
      id: nextId(),
      username: "unverifiedtarget",
      displayName: "Target",
      email: "unverified-target@example.com",
      emailVerified: true,
      passwordHash: "some-hash",
    });

    // The provider did not vouch for this email, and it already belongs
    // to another account, so the server refuses instead of guessing.
    await expect(
      completeOAuthLogin(testDb.db, "github", {
        providerUserId: "gh-5",
        email: "unverified-target@example.com",
        emailVerified: false,
        usernameHint: "someone-else",
      }),
    ).rejects.toMatchObject({ code: "OAUTH_EMAIL_TAKEN" });
  });

  it("does not link a verified provider email to an account whose email is not verified", async () => {
    // An attacker registers the email of the victim with a password and does not verify it.
    await testDb.db.insert(users).values({
      id: nextId(),
      username: "squatter",
      displayName: "Squatter",
      email: "victim@example.com",
      emailVerified: false,
      passwordHash: "some-hash",
    });

    await expect(
      completeOAuthLogin(testDb.db, "google", {
        providerUserId: "google-victim",
        email: "victim@example.com",
        emailVerified: true,
        usernameHint: "victim",
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "OAUTH_ACCOUNT_NOT_VERIFIED" });

    const links = await testDb.db.select().from(oauthAccounts).where(eq(oauthAccounts.providerUserId, "google-victim"));
    expect(links).toHaveLength(0);
  });

  it("makes a new account when the email is not verified and free", async () => {
    const created = await completeOAuthLogin(testDb.db, "github", {
      providerUserId: "gh-6",
      email: "free-and-unverified@example.com",
      emailVerified: false,
      usernameHint: "freeperson",
    });

    expect(created.email).toBe("free-and-unverified@example.com");
    expect(created.emailVerified).toBe(false);
  });
});

describeWithDb("generateUniqueUsername", () => {
  beforeAll(async () => {
    testDb = await createTestDb();
  });

  afterAll(async () => {
    await testDb.close();
  });

  it("returns the sanitized base when it is free", async () => {
    const username = await generateUniqueUsername(testDb.db, "freename");
    expect(username).toBe("freename");
  });

  it("adds a numeric suffix when the base is taken", async () => {
    await testDb.db.insert(users).values({
      id: nextId(),
      username: "clash",
      displayName: "Clash",
      email: "clash@example.com",
      emailVerified: true,
      passwordHash: null,
    });

    const username = await generateUniqueUsername(testDb.db, "clash");
    expect(username).not.toBe("clash");
    expect(username.startsWith("clash")).toBe(true);
  });
});
