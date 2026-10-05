// Encrypted attachments: the server stores and serves opaque ciphertext.
// It never sees a key, a file name or a type. Each file streams to disk
// through a temp file and one rename, so memory use stays flat. See
// docs/concepts/attachments.md.
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { Permission } from "@mortium/shared";
import type { FastifyBaseLogger } from "fastify";
import type { DbClient } from "../../db/client.js";
import { attachments } from "../../db/schema.js";
import { AppError } from "../../errors.js";
import { nextId } from "../../id.js";
import { requireCanMessage } from "../dms/access.js";
import { requireChannelPermission } from "../guilds/member-context.js";
import { loadChannelAccess } from "../messages/service.js";

/** An attachment that nobody claims in this time is deleted. */
export const UNCLAIMED_TTL_MS = 24 * 60 * 60 * 1000;
/** The cleanup runs this often. */
export const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
/** A temp file older than this is from a failed upload. */
const TEMP_TTL_MS = 60 * 60 * 1000;
const TEMP_SUFFIX = ".tmp";

export interface AttachmentLimits {
  maxBytes: number;
  quotaBytes: number;
}

export function attachmentDir(dataDir: string): string {
  return path.join(dataDir, "attachments");
}

function filePath(dataDir: string, id: bigint): string {
  return path.join(attachmentDir(dataDir), id.toString());
}

/** A stream step that fails when more bytes come than the request said. */
function byteLimit(expected: number): Transform & { count(): number } {
  let total = 0;
  const transform = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      total += chunk.length;
      if (total > expected) {
        done(new AppError(400, "INVALID_INPUT", "The body is longer than its content-length."));
        return;
      }
      done(null, chunk);
    },
  });
  return Object.assign(transform, { count: () => total });
}

/**
 * Store one encrypted file for a channel. The caller must be able to send
 * messages and attach files there. The body streams to a temp file; the
 * server never holds the whole file in memory.
 */
export async function uploadAttachment(
  db: DbClient,
  dataDir: string,
  limits: AttachmentLimits,
  channelId: bigint,
  userId: bigint,
  length: number,
  body: Readable,
): Promise<{ id: string; size: number }> {
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw new AppError(411, "LENGTH_REQUIRED", "The upload needs a content-length header.");
  }
  if (length > limits.maxBytes) {
    throw new AppError(413, "ATTACHMENT_TOO_LARGE", `A file can have at most ${limits.maxBytes} bytes.`);
  }
  const access = await loadChannelAccess(db, channelId, userId);
  const permissions = await access.permissions();
  requireChannelPermission(permissions, Permission.VIEW_CHANNEL);
  requireChannelPermission(permissions, Permission.SEND_MESSAGES);
  requireChannelPermission(permissions, Permission.ATTACH_FILES);
  await requireCanMessage(db, access.channel, userId);

  const [usage] = await db
    .select({ used: sql<string>`coalesce(sum(${attachments.size}), 0)` })
    .from(attachments)
    .where(eq(attachments.uploaderId, userId));
  if (Number(usage?.used ?? 0) + length > limits.quotaBytes) {
    throw new AppError(413, "QUOTA_EXCEEDED", "You have no more space for files. Delete some files first.");
  }

  const id = nextId();
  const finalPath = filePath(dataDir, id);
  const tempPath = `${finalPath}${TEMP_SUFFIX}`;
  await mkdir(attachmentDir(dataDir), { recursive: true });
  const counter = byteLimit(length);
  try {
    await pipeline(body, counter, createWriteStream(tempPath));
    if (counter.count() !== length) {
      throw new AppError(400, "INVALID_INPUT", "The body is shorter than its content-length.");
    }
    await rename(tempPath, finalPath);
    await db.insert(attachments).values({ id, uploaderId: userId, channelId, size: length, storagePath: id.toString() });
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    await unlink(finalPath).catch(() => {});
    throw error;
  }
  return { id: id.toString(), size: length };
}

/** Find an attachment that the caller may read: it must be able to view the channel and read its history. */
export async function openAttachment(
  db: DbClient,
  dataDir: string,
  id: bigint,
  userId: bigint,
): Promise<{ size: number; stream: Readable }> {
  const [row] = await db.select().from(attachments).where(eq(attachments.id, id)).limit(1);
  if (!row) {
    throw new AppError(404, "NOT_FOUND", "This file does not exist.");
  }
  const access = await loadChannelAccess(db, row.channelId, userId).catch(() => {
    throw new AppError(404, "NOT_FOUND", "This file does not exist.");
  });
  const permissions = await access.permissions();
  requireChannelPermission(permissions, Permission.VIEW_CHANNEL);
  requireChannelPermission(permissions, Permission.READ_MESSAGE_HISTORY);
  return { size: row.size, stream: createReadStream(filePath(dataDir, row.id)) };
}

/** Mark an attachment as part of a sent message. Only the uploader can claim it. A second claim does nothing. */
export async function claimAttachment(db: DbClient, id: bigint, userId: bigint): Promise<void> {
  const rows = await db
    .update(attachments)
    .set({ claimedAt: sql`coalesce(${attachments.claimedAt}, now())` })
    .where(and(eq(attachments.id, id), eq(attachments.uploaderId, userId)))
    .returning({ id: attachments.id });
  if (rows.length === 0) {
    throw new AppError(404, "NOT_FOUND", "This file does not exist.");
  }
}

/** Delete a file and its row. Only the uploader can delete it. This frees the quota. */
export async function deleteAttachment(db: DbClient, dataDir: string, id: bigint, userId: bigint): Promise<void> {
  const rows = await db
    .delete(attachments)
    .where(and(eq(attachments.id, id), eq(attachments.uploaderId, userId)))
    .returning({ id: attachments.id });
  if (rows.length === 0) {
    throw new AppError(404, "NOT_FOUND", "This file does not exist.");
  }
  await unlink(filePath(dataDir, id)).catch(() => {});
}

/**
 * Delete the attachments that nobody claimed in 24 hours, the files of
 * deleted channels (their rows go with the channel), and old temp files.
 * Returns how many files it deleted.
 */
export async function cleanUpAttachments(db: DbClient, dataDir: string, now = Date.now()): Promise<number> {
  let deleted = 0;
  const expired = await db
    .delete(attachments)
    .where(and(isNull(attachments.claimedAt), lt(attachments.createdAt, new Date(now - UNCLAIMED_TTL_MS))))
    .returning({ id: attachments.id });
  for (const row of expired) {
    await unlink(filePath(dataDir, row.id)).catch(() => {});
    deleted += 1;
  }

  let names: string[];
  try {
    names = await readdir(attachmentDir(dataDir));
  } catch {
    return deleted;
  }
  const files = names.filter((name) => /^[0-9]+$/.test(name));
  for (let start = 0; start < files.length; start += 1000) {
    const batch = files.slice(start, start + 1000);
    const rows = await db
      .select({ id: attachments.id })
      .from(attachments)
      .where(inArray(attachments.id, batch.map((name) => BigInt(name))));
    const known = new Set(rows.map((row) => row.id.toString()));
    for (const name of batch) {
      if (!known.has(name) && (await isOlderThan(path.join(attachmentDir(dataDir), name), now, UNCLAIMED_TTL_MS))) {
        await unlink(path.join(attachmentDir(dataDir), name)).catch(() => {});
        deleted += 1;
      }
    }
  }
  for (const name of names.filter((entry) => entry.endsWith(TEMP_SUFFIX))) {
    if (await isOlderThan(path.join(attachmentDir(dataDir), name), now, TEMP_TTL_MS)) {
      await unlink(path.join(attachmentDir(dataDir), name)).catch(() => {});
    }
  }
  return deleted;
}

async function isOlderThan(file: string, now: number, ageMs: number): Promise<boolean> {
  try {
    return now - (await stat(file)).mtimeMs > ageMs;
  } catch {
    return false;
  }
}

/** Run the cleanup at start and then one time per hour, with one timer. */
export function startAttachmentCleanup(db: DbClient, dataDir: string, log: FastifyBaseLogger): () => void {
  const run = () => {
    cleanUpAttachments(db, dataDir)
      .then((count) => {
        if (count > 0) {
          log.info({ count }, "The server deleted unclaimed attachments.");
        }
      })
      .catch((error: unknown) => log.error(error, "The attachment cleanup failed."));
  };
  run();
  const timer = setInterval(run, CLEANUP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
