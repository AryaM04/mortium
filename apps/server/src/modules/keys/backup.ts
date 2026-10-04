// The key backup store. Each user has at most one backup version. The
// server keeps only ciphertext: the sessions and the secrets are encrypted
// to the backup public key, and the server never sees the recovery key.
// Only the owner can read or change a backup. See
// docs/concepts/olm-megolm.md section 9.
import { and, asc, eq, gt, lt, sql } from "drizzle-orm";
import {
  MAX_BACKUP_SECRETS,
  MAX_BACKUP_SESSIONS_PER_PAGE,
  backupSignedText,
  decodeBase64Url,
  encodeBase64Url,
  type BackupVersion,
  type CreateBackupVersionRequest,
  type GetBackupSessionsQuery,
  type GetBackupSessionsResponse,
  type PutBackupSessionsRequest,
} from "@mortium/shared";
import type { DbClient } from "../../db/client.js";
import { devices, keyBackupSecrets, keyBackupSessions, keyBackupVersions, users } from "../../db/schema.js";
import { AppError } from "../../errors.js";
import { verifyEd25519 } from "./signatures.js";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

const DEFAULT_PAGE = 200;

function notFound(): AppError {
  return new AppError(404, "BACKUP_NOT_FOUND", "This key backup version does not exist. Get the current version.");
}

/** Delete one version and all of its data. */
async function deleteVersionRows(tx: Tx, userId: bigint, version: number): Promise<boolean> {
  await tx.delete(keyBackupSessions).where(and(eq(keyBackupSessions.userId, userId), eq(keyBackupSessions.version, version)));
  await tx.delete(keyBackupSecrets).where(and(eq(keyBackupSecrets.userId, userId), eq(keyBackupSecrets.version, version)));
  const deleted = await tx
    .delete(keyBackupVersions)
    .where(and(eq(keyBackupVersions.userId, userId), eq(keyBackupVersions.version, version)))
    .returning({ version: keyBackupVersions.version });
  return deleted.length > 0;
}

/** Delete every backup version of a user, for example after a master key reset. */
export async function deleteAllBackups(tx: Tx, userId: bigint): Promise<void> {
  const versions = await tx.select({ version: keyBackupVersions.version }).from(keyBackupVersions).where(eq(keyBackupVersions.userId, userId));
  for (const { version } of versions) {
    await deleteVersionRows(tx, userId, version);
  }
}

/** Lock the version row, so an upload and a delete of the same version run one after the other. */
async function lockVersion(tx: Tx, userId: bigint, version: number): Promise<void> {
  const rows = await tx
    .select({ version: keyBackupVersions.version })
    .from(keyBackupVersions)
    .where(and(eq(keyBackupVersions.userId, userId), eq(keyBackupVersions.version, version)))
    .for("update");
  if (rows.length === 0) {
    throw notFound();
  }
}

/**
 * Make a new backup version. The device that calls must have signed the
 * auth data. The new version replaces the old one: the old sessions and
 * secrets are deleted.
 */
export async function createBackupVersion(
  db: DbClient,
  userId: bigint,
  input: CreateBackupVersionRequest,
): Promise<{ version: number }> {
  return db.transaction(async (tx) => {
    // Lock the user row, so two new versions of one user run one after the other.
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
    const [signer] = await tx
      .select({ ed25519: devices.ed25519Key, removedAt: devices.removedAt })
      .from(devices)
      .where(and(eq(devices.id, input.authData.deviceId), eq(devices.userId, userId)));
    const text = backupSignedText(userId.toString(), input.publicKey, input.authData.passphrase);
    if (!signer?.ed25519 || signer.removedAt !== null || !verifyEd25519(signer.ed25519, text, input.authData.signature)) {
      throw new AppError(400, "INVALID_SIGNATURE", "The signature of the key backup is not valid.");
    }
    const [latest] = await tx
      .select({ version: sql<number>`coalesce(max(${keyBackupVersions.version}), 0)`.mapWith(Number) })
      .from(keyBackupVersions)
      .where(eq(keyBackupVersions.userId, userId));
    const version = (latest?.version ?? 0) + 1;
    await deleteAllBackups(tx, userId);
    await tx.insert(keyBackupVersions).values({ userId, version, publicKey: input.publicKey, authData: JSON.stringify(input.authData) });
    return { version };
  });
}

/** The current backup version with its secrets, or null. */
export async function getBackupVersion(db: DbClient, userId: bigint): Promise<BackupVersion | null> {
  const [row] = await db
    .select()
    .from(keyBackupVersions)
    .where(eq(keyBackupVersions.userId, userId))
    .orderBy(sql`${keyBackupVersions.version} desc`)
    .limit(1);
  if (!row) {
    return null;
  }
  const secretRows = await db
    .select({ name: keyBackupSecrets.name, data: keyBackupSecrets.data })
    .from(keyBackupSecrets)
    .where(and(eq(keyBackupSecrets.userId, userId), eq(keyBackupSecrets.version, row.version)));
  return {
    version: row.version,
    publicKey: row.publicKey,
    authData: JSON.parse(row.authData) as BackupVersion["authData"],
    secrets: Object.fromEntries(secretRows.map((secret) => [secret.name, encodeBase64Url(secret.data)])),
  };
}

export async function deleteBackupVersion(db: DbClient, userId: bigint, version: number): Promise<void> {
  const deleted = await db.transaction(async (tx) => deleteVersionRows(tx, userId, version));
  if (!deleted) {
    throw notFound();
  }
}

/**
 * Add or improve sessions. For a session that the backup has, the server
 * keeps the copy with the lower first index: it can decrypt more messages.
 */
export async function putBackupSessions(db: DbClient, userId: bigint, input: PutBackupSessionsRequest): Promise<{ stored: number }> {
  return db.transaction(async (tx) => {
    await lockVersion(tx, userId, input.version);
    // One row for each session id: the one with the lowest first index.
    const best = new Map<string, PutBackupSessionsRequest["sessions"][number]>();
    for (const session of input.sessions) {
      const known = best.get(session.sessionId);
      if (!known || session.firstIndex < known.firstIndex) {
        best.set(session.sessionId, session);
      }
    }
    const stored = await tx
      .insert(keyBackupSessions)
      .values(
        [...best.values()].map((session) => ({
          userId,
          version: input.version,
          channelId: BigInt(session.channelId),
          sessionId: session.sessionId,
          firstIndex: session.firstIndex,
          encryptedSession: decodeBase64Url(session.data),
        })),
      )
      .onConflictDoUpdate({
        target: [keyBackupSessions.userId, keyBackupSessions.version, keyBackupSessions.sessionId],
        set: {
          channelId: sql`excluded.channel_id`,
          firstIndex: sql`excluded.first_index`,
          encryptedSession: sql`excluded.encrypted_session`,
        },
        setWhere: lt(sql`excluded.first_index`, keyBackupSessions.firstIndex),
      })
      .returning({ sessionId: keyBackupSessions.sessionId });
    return { stored: stored.length };
  });
}

export async function getBackupSessions(db: DbClient, userId: bigint, query: GetBackupSessionsQuery): Promise<GetBackupSessionsResponse> {
  const [version] = await db
    .select({ version: keyBackupVersions.version })
    .from(keyBackupVersions)
    .where(and(eq(keyBackupVersions.userId, userId), eq(keyBackupVersions.version, query.version)));
  if (!version) {
    throw notFound();
  }
  const limit = Math.min(query.limit ?? DEFAULT_PAGE, MAX_BACKUP_SESSIONS_PER_PAGE);
  const rows = await db
    .select()
    .from(keyBackupSessions)
    .where(
      and(
        eq(keyBackupSessions.userId, userId),
        eq(keyBackupSessions.version, query.version),
        query.channelId ? eq(keyBackupSessions.channelId, BigInt(query.channelId)) : undefined,
        query.after ? gt(keyBackupSessions.sessionId, query.after) : undefined,
      ),
    )
    .orderBy(asc(keyBackupSessions.sessionId))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    sessions: page.map((row) => ({
      channelId: row.channelId.toString(),
      sessionId: row.sessionId,
      firstIndex: row.firstIndex,
      data: encodeBase64Url(row.encryptedSession),
    })),
    next: rows.length > limit ? page.at(-1)!.sessionId : null,
  };
}

/** Add or replace secrets of the current version. A backup keeps at most 16 secrets. */
export async function putBackupSecrets(
  db: DbClient,
  userId: bigint,
  version: number,
  secrets: Record<string, string>,
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockVersion(tx, userId, version);
    const existing = await tx
      .select({ name: keyBackupSecrets.name })
      .from(keyBackupSecrets)
      .where(and(eq(keyBackupSecrets.userId, userId), eq(keyBackupSecrets.version, version)));
    const names = new Set([...existing.map((row) => row.name), ...Object.keys(secrets)]);
    if (names.size > MAX_BACKUP_SECRETS) {
      throw new AppError(400, "TOO_MANY_SECRETS", `A key backup can have at most ${MAX_BACKUP_SECRETS} secrets.`);
    }
    for (const [name, data] of Object.entries(secrets)) {
      await tx
        .insert(keyBackupSecrets)
        .values({ userId, version, name, data: decodeBase64Url(data) })
        .onConflictDoUpdate({
          target: [keyBackupSecrets.userId, keyBackupSecrets.version, keyBackupSecrets.name],
          set: { data: decodeBase64Url(data) },
        });
    }
  });
}

