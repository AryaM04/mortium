// Auth logic and database access. Routes stay thin and call these functions.
import { and, eq, gt, isNull } from "drizzle-orm";
import { hash, verify } from "@node-rs/argon2";
import type { AuthResult, RefreshResult } from "@mortium/shared";
import type { AppConfig } from "../../config.js";
import { isUniqueViolation, type DbClient } from "../../db/client.js";
import { devices, emailTokens, refreshTokens, users } from "../../db/schema.js";
import { GatewayCloseCode } from "@mortium/shared";
import { AppError } from "../../errors.js";
import { nextId } from "../../id.js";
import type { Mailer } from "../../mailer.js";
import type { GatewayService } from "../gateway/service.js";
import { announceDeviceListChange, retireDevices } from "../keys/service.js";
import { toUserJson, type UserRow } from "../users/serialize.js";
import {
  EMAIL_VERIFY_TOKEN_TTL_MS,
  RESET_PASSWORD_TOKEN_TTL_MS,
  generateDeviceId,
  generateOpaqueToken,
  generateRefreshToken,
  hashOpaqueToken,
  hashRefreshToken,
  signAccessToken,
} from "./tokens.js";

export interface AuthDeps {
  db: DbClient;
  config: AppConfig;
  mailer: Mailer;
  gateway?: GatewayService;
  log?: { warn(details: object, message: string): void };
}

// A constant hash, verified against when the user does not exist or has no
// password. This keeps the login timing path the same in every case, so an
// attacker cannot tell a missing account from a wrong password by timing.
let dummyHashPromise: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hash("a-dummy-password-used-only-for-constant-time-checks");
  }
  return dummyHashPromise;
}

/**
 * A device that loses all its refresh tokens never signs in again. Take it
 * out of every device list, so no one encrypts for it any more.
 */
async function retireDeviceKeys(deps: AuthDeps, deviceIds: string[]): Promise<void> {
  const userIds = await retireDevices(deps.db, deviceIds);
  for (const userId of userIds) {
    await announceDeviceListChange(deps, userId);
  }
}

async function findUserById(db: DbClient, id: bigint): Promise<UserRow | undefined> {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return rows[0];
}

async function findUserByEmail(db: DbClient, email: string): Promise<UserRow | undefined> {
  const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return rows[0];
}

async function loadUserOrThrow(db: DbClient, id: bigint): Promise<UserRow> {
  const user = await findUserById(db, id);
  if (!user) {
    throw new AppError(500, "INTERNAL_ERROR", "The user was not found right after it was made.");
  }
  return user;
}

/**
 * Create one device session: a device row, a refresh token row and a
 * signed access token. `deviceName` should come from the request's
 * User-Agent header, summarized with `summarizeUserAgent`.
 */
async function createSession(
  db: DbClient,
  config: AppConfig,
  userId: bigint,
  deviceName = "Unknown device",
): Promise<{ deviceId: string; accessToken: string; accessTokenExpiresAt: Date; refreshToken: string }> {
  const deviceId = generateDeviceId();
  const refreshToken = generateRefreshToken();
  const tokenHash = hashRefreshToken(refreshToken);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await db.insert(devices).values({
    id: deviceId,
    userId,
    name: deviceName,
  });

  await db.insert(refreshTokens).values({
    id: nextId(),
    userId,
    deviceId,
    tokenHash,
    expiresAt,
    revokedAt: null,
  });

  const { accessToken, accessTokenExpiresAt } = await signAccessToken(config.jwtSecret, {
    userId,
    deviceId,
  });

  return { deviceId, accessToken, accessTokenExpiresAt, refreshToken };
}

function toAuthResult(
  user: UserRow,
  session: { deviceId: string; accessToken: string; accessTokenExpiresAt: Date; refreshToken: string },
): AuthResult {
  return {
    user: toUserJson(user, { includePrivate: true }),
    deviceId: session.deviceId,
    accessToken: session.accessToken,
    accessTokenExpiresAt: session.accessTokenExpiresAt.toISOString(),
    refreshToken: session.refreshToken,
  };
}

async function sendVerificationEmail(deps: AuthDeps, userId: bigint, email: string): Promise<void> {
  const token = generateOpaqueToken();
  await deps.db.insert(emailTokens).values({
    id: nextId(),
    userId,
    purpose: "verify_email",
    tokenHash: hashOpaqueToken(token),
    expiresAt: new Date(Date.now() + EMAIL_VERIFY_TOKEN_TTL_MS),
    usedAt: null,
  });

  const link = `${deps.config.webOrigin}/verify-email#token=${token}`;
  await deps.mailer.send(
    email,
    "Confirm your email address",
    `Welcome to Mortium.\n\nUse this link to confirm your email address. The link is valid for 24 hours.\n\n${link}\n\nIf you did not make this account, ignore this mail.`,
  );
}

export interface RegisterInput {
  email: string;
  username: string;
  password: string;
  displayName?: string;
}

export async function registerUser(
  deps: AuthDeps,
  input: RegisterInput,
  deviceName?: string,
): Promise<AuthResult> {
  const { db } = deps;

  const conflicts = await db
    .select({ email: users.email, username: users.username })
    .from(users)
    .where(eq(users.email, input.email));
  if (conflicts.length > 0) {
    throw new AppError(409, "EMAIL_TAKEN", "An account with this email address already exists.");
  }
  const usernameConflicts = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, input.username));
  if (usernameConflicts.length > 0) {
    throw new AppError(409, "USERNAME_TAKEN", "This username is already in use.");
  }

  const passwordHash = await hash(input.password);
  const id = nextId();
  const displayName = input.displayName ?? input.username;

  try {
    await db.insert(users).values({
      id,
      username: input.username,
      displayName,
      email: input.email,
      passwordHash,
      emailVerified: false,
    });
  } catch (error) {
    if (isUniqueViolation(error, "email")) {
      throw new AppError(409, "EMAIL_TAKEN", "An account with this email address already exists.");
    }
    if (isUniqueViolation(error, "username")) {
      throw new AppError(409, "USERNAME_TAKEN", "This username is already in use.");
    }
    throw error;
  }

  const session = await createSession(db, deps.config, id, deviceName);
  // The account exists now. A mail fault must not make the sign-up fail:
  // the user can ask for the verification mail again later.
  try {
    await sendVerificationEmail(deps, id, input.email);
  } catch (error) {
    deps.log?.warn({ err: error }, "The verification mail was not sent after sign-up.");
  }

  const user = await loadUserOrThrow(db, id);
  return toAuthResult(user, session);
}

export interface LoginInput {
  email: string;
  password: string;
}

export async function loginUser(
  deps: AuthDeps,
  input: LoginInput,
  deviceName?: string,
): Promise<AuthResult> {
  const { db } = deps;
  const user = await findUserByEmail(db, input.email);
  const hashToCheck = user?.passwordHash ?? (await getDummyHash());
  const passwordOk = await verify(hashToCheck, input.password);

  if (!user || !user.passwordHash || !passwordOk) {
    throw new AppError(401, "INVALID_CREDENTIALS", "The email or password is not correct.");
  }

  const session = await createSession(db, deps.config, user.id, deviceName);
  return toAuthResult(user, session);
}

export async function refreshSession(deps: AuthDeps, refreshToken: string): Promise<RefreshResult> {
  const { db, config } = deps;
  const tokenHash = hashRefreshToken(refreshToken);
  const now = new Date();

  const newRefreshToken = generateRefreshToken();
  const newTokenHash = hashRefreshToken(newRefreshToken);
  const newExpiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  // A single conditional UPDATE, guarded by revoked_at IS NULL and the
  // expiry. Of two parallel calls with the same token, only one matches
  // this WHERE clause and gets a row back; the database serializes it.
  const rotated = await db
    .update(refreshTokens)
    .set({ revokedAt: now })
    .where(
      and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt), gt(refreshTokens.expiresAt, now)),
    )
    .returning({
      userId: refreshTokens.userId,
      deviceId: refreshTokens.deviceId,
    });

  const rotatedRow = rotated[0];

  if (!rotatedRow) {
    const existing = await db
      .select({ deviceId: refreshTokens.deviceId, revokedAt: refreshTokens.revokedAt })
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .limit(1);
    const existingRow = existing[0];

    if (existingRow && existingRow.revokedAt !== null) {
      // The token was already used once. It may be stolen: revoke every
      // refresh token of this device, so a copied token cannot be reused.
      await db
        .update(refreshTokens)
        .set({ revokedAt: now })
        .where(and(eq(refreshTokens.deviceId, existingRow.deviceId), isNull(refreshTokens.revokedAt)));
      await retireDeviceKeys(deps, [existingRow.deviceId]);
      throw new AppError(401, "TOKEN_REUSED", "This refresh token was already used. All sessions on this device are signed out.");
    }

    throw new AppError(401, "INVALID_REFRESH_TOKEN", "The refresh token is not valid or has expired.");
  }

  const { userId, deviceId } = rotatedRow;

  await db.insert(refreshTokens).values({
    id: nextId(),
    userId,
    deviceId,
    tokenHash: newTokenHash,
    expiresAt: newExpiresAt,
    revokedAt: null,
  });

  const { accessToken, accessTokenExpiresAt } = await signAccessToken(config.jwtSecret, {
    userId,
    deviceId,
  });

  return {
    accessToken,
    accessTokenExpiresAt: accessTokenExpiresAt.toISOString(),
    refreshToken: newRefreshToken,
  };
}

export async function logoutDevice(deps: AuthDeps, deviceId: string): Promise<void> {
  await deps.db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.deviceId, deviceId), isNull(refreshTokens.revokedAt)));
  // The device row stays, because old events name it as the sender. Its
  // keys leave every device list.
  await retireDeviceKeys(deps, [deviceId]);
  deps.gateway?.closeDevice(deviceId, GatewayCloseCode.DEVICE_REVOKED, "Signed out.");
}

export interface DeviceSummary {
  id: string;
  name: string;
  createdAt: string;
  lastSeen: string;
  current: boolean;
}

/** List a user's devices (login sessions), newest first. */
export async function listDevices(
  deps: AuthDeps,
  userId: bigint,
  currentDeviceId: string,
): Promise<DeviceSummary[]> {
  const rows = await deps.db
    .select({
      id: devices.id,
      name: devices.name,
      createdAt: devices.createdAt,
      lastSeen: devices.lastSeen,
    })
    .from(devices)
    .where(eq(devices.userId, userId))
    .orderBy(devices.createdAt);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    lastSeen: row.lastSeen.toISOString(),
    current: row.id === currentDeviceId,
  }));
}

/**
 * Revoke a device's refresh tokens, so it must sign in again. The device
 * row is deleted only when it holds no end-to-end encryption keys. A
 * device with keys stays, because old events name it as the sender, but
 * it leaves every device list.
 */
export async function deleteDevice(deps: AuthDeps, userId: bigint, deviceId: string): Promise<void> {
  const { db } = deps;
  const now = new Date();

  const rows = await db
    .select({ id: devices.id, curve25519Key: devices.curve25519Key })
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.userId, userId)))
    .limit(1);
  const device = rows[0];
  if (!device) {
    throw new AppError(404, "NOT_FOUND", "This device does not exist.");
  }

  await db
    .update(refreshTokens)
    .set({ revokedAt: now })
    .where(and(eq(refreshTokens.deviceId, deviceId), isNull(refreshTokens.revokedAt)));

  if (device.curve25519Key === null) {
    await db.delete(devices).where(eq(devices.id, deviceId));
  } else {
    await retireDeviceKeys(deps, [deviceId]);
  }

  deps.gateway?.closeDevice(deviceId, GatewayCloseCode.DEVICE_REVOKED, "This device was removed.");
}

export async function verifyEmail(deps: AuthDeps, token: string): Promise<void> {
  const { db } = deps;
  const tokenHash = hashOpaqueToken(token);
  const now = new Date();

  const rows = await db
    .update(emailTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(emailTokens.tokenHash, tokenHash),
        eq(emailTokens.purpose, "verify_email"),
        isNull(emailTokens.usedAt),
        gt(emailTokens.expiresAt, now),
      ),
    )
    .returning({ userId: emailTokens.userId });

  const row = rows[0];
  if (!row) {
    throw new AppError(400, "INVALID_VERIFY_TOKEN", "This verification link is not valid or has expired.");
  }

  await db.update(users).set({ emailVerified: true }).where(eq(users.id, row.userId));
}

export async function resendVerification(deps: AuthDeps, userId: bigint): Promise<void> {
  const user = await findUserById(deps.db, userId);
  if (!user || user.emailVerified) {
    return;
  }
  await sendVerificationEmail(deps, userId, user.email);
}

export async function forgotPassword(deps: AuthDeps, email: string): Promise<void> {
  const user = await findUserByEmail(deps.db, email);
  if (!user) {
    // Do not reveal whether the account exists.
    return;
  }

  const token = generateOpaqueToken();
  await deps.db.insert(emailTokens).values({
    id: nextId(),
    userId: user.id,
    purpose: "reset_password",
    tokenHash: hashOpaqueToken(token),
    expiresAt: new Date(Date.now() + RESET_PASSWORD_TOKEN_TTL_MS),
    usedAt: null,
  });

  const link = `${deps.config.webOrigin}/reset-password#token=${token}`;
  await deps.mailer.send(
    email,
    "Reset your password",
    `We got a request to reset the password of your account.\n\nUse this link to set a new password. The link is valid for 1 hour.\n\n${link}\n\nIf you did not ask for this, ignore this mail. Your password will stay the same.`,
  );
}

export async function resetPassword(deps: AuthDeps, token: string, newPassword: string): Promise<void> {
  const { db } = deps;
  const tokenHash = hashOpaqueToken(token);
  const now = new Date();

  const rows = await db
    .update(emailTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(emailTokens.tokenHash, tokenHash),
        eq(emailTokens.purpose, "reset_password"),
        isNull(emailTokens.usedAt),
        gt(emailTokens.expiresAt, now),
      ),
    )
    .returning({ userId: emailTokens.userId });

  const row = rows[0];
  if (!row) {
    throw new AppError(400, "INVALID_RESET_TOKEN", "This reset link is not valid or has expired.");
  }

  const userId = row.userId;
  const passwordHash = await hash(newPassword);
  await db.update(users).set({ passwordHash }).where(eq(users.id, userId));
  // Other reset links of this user stop working too. An old link in the
  // mailbox must not change the new password.
  await db
    .update(emailTokens)
    .set({ usedAt: now })
    .where(
      and(eq(emailTokens.userId, userId), eq(emailTokens.purpose, "reset_password"), isNull(emailTokens.usedAt)),
    );

  // A password reset ends every existing session, in case the old
  // password, and any refresh token taken with it, is compromised.
  await db
    .update(refreshTokens)
    .set({ revokedAt: now })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  const userDevices = await db.select({ id: devices.id }).from(devices).where(eq(devices.userId, userId));
  await retireDeviceKeys(
    deps,
    userDevices.map((row) => row.id),
  );

  deps.gateway?.closeUser(userId, GatewayCloseCode.DEVICE_REVOKED, "The password was reset.");
}

export { createSession, findUserByEmail, findUserById, toAuthResult };
