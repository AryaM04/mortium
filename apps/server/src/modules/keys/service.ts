// The key server: device identity keys, one-time keys, fallback keys and
// the user master key. The server checks every signature and never holds
// a private key. See docs/concepts/olm-megolm.md sections 3 and 4.
import { and, count, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { verify as verifyPassword } from "@node-rs/argon2";
import {
  DispatchEvent,
  MAX_STORED_ONE_TIME_KEYS,
  deviceKeysSignedText,
  masterKeySignedText,
  oneTimeKeySignedText,
  type ClaimedKey,
  type DeviceRef,
  type PutMasterKeyRequest,
  type QueriedUser,
  type ResetMasterKeyRequest,
  type UploadKeysRequest,
  type UploadSignatureRequest,
  type UploadKeysResponse,
} from "@mortium/shared";
import type { DbClient } from "../../db/client.js";
import { crossSigningKeys, devices, fallbackKeys, oneTimeKeys, toDeviceQueue, users } from "../../db/schema.js";
import { AppError } from "../../errors.js";
import type { GatewayService } from "../gateway/service.js";
import { deleteAllBackups } from "./backup.js";
import { verifyEd25519 } from "./signatures.js";
import { usersWhoCanSee, visibleUserIds } from "./visibility.js";

export interface KeysDeps {
  db: DbClient;
  gateway?: GatewayService;
}

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
type DeviceRow = typeof devices.$inferSelect;

function badSignature(what: string): AppError {
  return new AppError(400, "INVALID_SIGNATURE", `The signature of the ${what} is not valid.`);
}

/** Lock the device row of the caller, so two uploads of one device run one after the other. */
async function lockOwnDevice(tx: Tx, userId: bigint, deviceId: string): Promise<DeviceRow> {
  const rows = await tx
    .select()
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.userId, userId)))
    .for("update");
  const device = rows[0];
  if (!device || device.removedAt !== null) {
    throw new AppError(403, "DEVICE_REMOVED", "This device was signed out or removed.");
  }
  return device;
}

/** The one-time key count and the fallback key state of one device. */
export async function keyCounts(
  db: DbClient | Tx,
  deviceId: string,
): Promise<UploadKeysResponse> {
  const [countRow] = await db.select({ value: count() }).from(oneTimeKeys).where(eq(oneTimeKeys.deviceId, deviceId));
  const [fallback] = await db
    .select({ used: fallbackKeys.used })
    .from(fallbackKeys)
    .where(eq(fallbackKeys.deviceId, deviceId));
  return { oneTimeKeyCount: countRow?.value ?? 0, needsFallbackKey: !fallback || fallback.used };
}

/** Tell every user who can see `userId` that its device list changed. */
export async function announceDeviceListChange(deps: KeysDeps, userId: bigint): Promise<void> {
  if (!deps.gateway) {
    return;
  }
  const audience = await usersWhoCanSee(deps.db, userId);
  deps.gateway.toUsers(audience, DispatchEvent.DEVICE_LIST_UPDATE, { userId: userId.toString() });
}

export async function uploadKeys(
  deps: KeysDeps,
  userId: bigint,
  deviceId: string,
  input: UploadKeysRequest,
): Promise<UploadKeysResponse> {
  const userText = userId.toString();
  const { result, changed } = await deps.db.transaction(async (tx) => {
    const device = await lockOwnDevice(tx, userId, deviceId);
    let changed = false;
    let ed25519 = device.ed25519Key;
    let curve25519Key = device.curve25519Key;

    if (input.deviceKeys) {
      const { curve25519, ed25519: newEd25519, signature } = input.deviceKeys;
      const text = deviceKeysSignedText(userText, deviceId, curve25519, newEd25519);
      if (!verifyEd25519(newEd25519, text, signature)) {
        throw badSignature("device keys");
      }
      if (device.curve25519Key !== null || device.ed25519Key !== null) {
        if (device.curve25519Key !== curve25519 || device.ed25519Key !== newEd25519) {
          throw new AppError(409, "DEVICE_KEYS_EXIST", "This device already has different identity keys.");
        }
      } else {
        await tx
          .update(devices)
          .set({ curve25519Key: curve25519, ed25519Key: newEd25519, keySignature: signature })
          .where(eq(devices.id, deviceId));
        ed25519 = newEd25519;
        curve25519Key = curve25519;
        changed = true;
      }
    }

    const needsIdentity = input.oneTimeKeys || input.fallbackKey || input.masterSignature;
    if (needsIdentity && ed25519 === null) {
      throw new AppError(400, "DEVICE_KEYS_MISSING", "Upload the identity keys of this device first.");
    }

    if (input.oneTimeKeys && ed25519 !== null) {
      const entries = Object.entries(input.oneTimeKeys);
      for (const [keyId, { key, signature }] of entries) {
        if (!verifyEd25519(ed25519, oneTimeKeySignedText("one_time_key", userText, deviceId, keyId, key), signature)) {
          throw badSignature("one-time key");
        }
      }
      if (entries.length > 0) {
        const existing = await tx
          .select({ keyId: oneTimeKeys.keyId })
          .from(oneTimeKeys)
          .where(eq(oneTimeKeys.deviceId, deviceId));
        const known = new Set(existing.map((row) => row.keyId));
        const added = entries.filter(([keyId]) => !known.has(keyId));
        if (known.size + added.length > MAX_STORED_ONE_TIME_KEYS) {
          throw new AppError(
            400,
            "TOO_MANY_ONE_TIME_KEYS",
            `A device can have at most ${MAX_STORED_ONE_TIME_KEYS} one-time keys on the server.`,
          );
        }
        if (added.length > 0) {
          await tx
            .insert(oneTimeKeys)
            .values(added.map(([keyId, { key, signature }]) => ({ deviceId, keyId, key, signature })))
            .onConflictDoNothing();
        }
      }
    }

    if (input.fallbackKey && ed25519 !== null) {
      const { keyId, key, signature } = input.fallbackKey;
      if (!verifyEd25519(ed25519, oneTimeKeySignedText("fallback_key", userText, deviceId, keyId, key), signature)) {
        throw badSignature("fallback key");
      }
      // The same key again (a retry) keeps its "used" flag. A new key replaces the old one.
      await tx
        .insert(fallbackKeys)
        .values({ deviceId, keyId, key, signature, used: false })
        .onConflictDoUpdate({
          target: fallbackKeys.deviceId,
          set: { keyId, key, signature, used: false },
          setWhere: sql`${fallbackKeys.keyId} <> ${keyId}`,
        });
    }

    if (input.masterSignature && ed25519 !== null && curve25519Key !== null) {
      const [master] = await tx.select().from(crossSigningKeys).where(eq(crossSigningKeys.userId, userId));
      if (!master) {
        throw new AppError(400, "MASTER_KEY_MISSING", "This user has no master key.");
      }
      const text = deviceKeysSignedText(userText, deviceId, curve25519Key, ed25519);
      if (!verifyEd25519(master.masterKey, text, input.masterSignature)) {
        throw badSignature("master signature");
      }
      if (device.masterSignature !== input.masterSignature) {
        await tx.update(devices).set({ masterSignature: input.masterSignature }).where(eq(devices.id, deviceId));
        changed = true;
      }
    }

    return { result: await keyCounts(tx, deviceId), changed };
  });

  if (changed) {
    await announceDeviceListChange(deps, userId);
  }
  return result;
}

export async function putMasterKey(
  deps: KeysDeps,
  userId: bigint,
  deviceId: string,
  input: PutMasterKeyRequest,
): Promise<void> {
  const userText = userId.toString();
  const changed = await deps.db.transaction(async (tx) => {
    const device = await lockOwnDevice(tx, userId, deviceId);
    if (device.curve25519Key === null || device.ed25519Key === null) {
      throw new AppError(400, "DEVICE_KEYS_MISSING", "Upload the identity keys of this device first.");
    }
    if (!verifyEd25519(device.ed25519Key, masterKeySignedText(userText, input.publicKey), input.deviceSignature)) {
      throw badSignature("master key");
    }
    const deviceText = deviceKeysSignedText(userText, deviceId, device.curve25519Key, device.ed25519Key);
    if (!verifyEd25519(input.publicKey, deviceText, input.masterSignature)) {
      throw badSignature("master signature");
    }

    const inserted = await tx
      .insert(crossSigningKeys)
      .values({ userId, masterKey: input.publicKey, deviceId, deviceSignature: input.deviceSignature })
      .onConflictDoNothing()
      .returning({ userId: crossSigningKeys.userId });
    let vouched = false;
    if (inserted.length === 0) {
      const [existing] = await tx.select().from(crossSigningKeys).where(eq(crossSigningKeys.userId, userId));
      if (existing?.masterKey !== input.publicKey) {
        throw new AppError(409, "MASTER_KEY_EXISTS", "This user already has a different master key.");
      }
      // The master signature proves that this device holds the master key. Thus this
      // device can vouch for the key in place of a device that is possibly gone.
      if (existing.deviceId !== deviceId || existing.deviceSignature !== input.deviceSignature) {
        await tx
          .update(crossSigningKeys)
          .set({ deviceId, deviceSignature: input.deviceSignature })
          .where(eq(crossSigningKeys.userId, userId));
        vouched = true;
      }
    }
    if (inserted.length === 0 && !vouched && device.masterSignature === input.masterSignature) {
      return false;
    }
    await tx.update(devices).set({ masterSignature: input.masterSignature }).where(eq(devices.id, deviceId));
    return true;
  });

  if (changed) {
    await announceDeviceListChange(deps, userId);
  }
}

/**
 * Store the master signature of a different device of the same user. A
 * device that holds the master private key calls this after it verified
 * the other device (SAS). The signature must verify with the master key.
 */
export async function uploadSignature(deps: KeysDeps, userId: bigint, input: UploadSignatureRequest): Promise<void> {
  const changed = await deps.db.transaction(async (tx) => {
    const target = await lockOwnDevice(tx, userId, input.deviceId);
    if (target.curve25519Key === null || target.ed25519Key === null) {
      throw new AppError(400, "DEVICE_KEYS_MISSING", "This device has no identity keys.");
    }
    const [master] = await tx.select().from(crossSigningKeys).where(eq(crossSigningKeys.userId, userId));
    if (!master) {
      throw new AppError(400, "MASTER_KEY_MISSING", "This user has no master key.");
    }
    const text = deviceKeysSignedText(userId.toString(), target.id, target.curve25519Key, target.ed25519Key);
    if (!verifyEd25519(master.masterKey, text, input.signature)) {
      throw badSignature("master signature");
    }
    if (target.masterSignature === input.signature) {
      return false;
    }
    await tx.update(devices).set({ masterSignature: input.signature }).where(eq(devices.id, target.id));
    return true;
  });
  if (changed) {
    await announceDeviceListChange(deps, userId);
  }
}

/**
 * Replace the master key of a user who lost it (no signed device and no
 * recovery key). The auth key of the account password is necessary. The signatures of the
 * old key and the key backup are deleted, because the old master key made
 * them. Other users see the new key as an identity change.
 */
export async function resetMasterKey(
  deps: KeysDeps,
  userId: bigint,
  deviceId: string,
  input: ResetMasterKeyRequest,
): Promise<void> {
  const [user] = await deps.db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, userId));
  if (!user?.passwordHash) {
    throw new AppError(403, "PASSWORD_REQUIRED", "Set a password for this account first. Then reset the identity.");
  }
  if (!(await verifyPassword(user.passwordHash, input.authKey))) {
    throw new AppError(401, "INVALID_PASSWORD", "The password is not correct.");
  }
  const userText = userId.toString();
  await deps.db.transaction(async (tx) => {
    const device = await lockOwnDevice(tx, userId, deviceId);
    if (device.curve25519Key === null || device.ed25519Key === null) {
      throw new AppError(400, "DEVICE_KEYS_MISSING", "Upload the identity keys of this device first.");
    }
    if (!verifyEd25519(device.ed25519Key, masterKeySignedText(userText, input.publicKey), input.deviceSignature)) {
      throw badSignature("master key");
    }
    const deviceText = deviceKeysSignedText(userText, deviceId, device.curve25519Key, device.ed25519Key);
    if (!verifyEd25519(input.publicKey, deviceText, input.masterSignature)) {
      throw badSignature("master signature");
    }
    await tx
      .insert(crossSigningKeys)
      .values({ userId, masterKey: input.publicKey, deviceId, deviceSignature: input.deviceSignature })
      .onConflictDoUpdate({
        target: crossSigningKeys.userId,
        set: { masterKey: input.publicKey, deviceId, deviceSignature: input.deviceSignature },
      });
    await tx.update(devices).set({ masterSignature: null }).where(and(eq(devices.userId, userId), ne(devices.id, deviceId)));
    await tx.update(devices).set({ masterSignature: input.masterSignature }).where(eq(devices.id, deviceId));
    await deleteAllBackups(tx, userId);
  });
  await announceDeviceListChange(deps, userId);
}

/** The master key and the devices with keys of each visible user. Users the caller cannot see are left out. */
export async function queryKeys(db: DbClient, callerId: bigint, userIds: bigint[]): Promise<QueriedUser[]> {
  const unique = [...new Set(userIds)];
  const visible = [...(await visibleUserIds(db, callerId, unique))];
  if (visible.length === 0) {
    return [];
  }

  const masterRows = await db.select().from(crossSigningKeys).where(inArray(crossSigningKeys.userId, visible));
  const deviceRows = await db
    .select()
    .from(devices)
    .where(and(inArray(devices.userId, visible), isNotNull(devices.curve25519Key), isNull(devices.removedAt)))
    .orderBy(devices.createdAt);

  return unique
    .filter((id) => visible.includes(id))
    .map((id) => {
      const master = masterRows.find((row) => row.userId === id);
      return {
        userId: id.toString(),
        masterKey: master
          ? { publicKey: master.masterKey, deviceId: master.deviceId, deviceSignature: master.deviceSignature }
          : null,
        devices: deviceRows
          .filter((row) => row.userId === id)
          .map((row) => ({
            deviceId: row.id,
            curve25519: row.curve25519Key!,
            ed25519: row.ed25519Key!,
            signature: row.keySignature!,
            masterSignature: row.masterSignature,
          })),
      };
    });
}

/**
 * Take one one-time key of each device. A key goes to one caller only:
 * the row is locked with SKIP LOCKED and deleted in one statement. When a
 * device has no one-time key left, its fallback key is returned and
 * marked as used. Devices of users the caller cannot see are left out.
 */
export async function claimKeys(db: DbClient, callerId: bigint, targets: DeviceRef[]): Promise<ClaimedKey[]> {
  const userIds = [...new Set(targets.map((target) => BigInt(target.userId)))];
  const visible = await visibleUserIds(db, callerId, userIds);
  const wanted = targets.filter((target) => visible.has(BigInt(target.userId)));
  if (wanted.length === 0) {
    return [];
  }

  const liveDevices = await db
    .select({ id: devices.id, userId: devices.userId })
    .from(devices)
    .where(
      and(
        inArray(
          devices.id,
          wanted.map((target) => target.deviceId),
        ),
        isNotNull(devices.curve25519Key),
        isNull(devices.removedAt),
      ),
    );

  const claimed: ClaimedKey[] = [];
  const seen = new Set<string>();
  for (const target of wanted) {
    const device = liveDevices.find((row) => row.id === target.deviceId && row.userId.toString() === target.userId);
    if (!device || seen.has(device.id)) {
      continue;
    }
    seen.add(device.id);

    const [oneTime] = await db
      .delete(oneTimeKeys)
      .where(
        and(
          eq(oneTimeKeys.deviceId, device.id),
          eq(
            oneTimeKeys.keyId,
            sql`(select ${oneTimeKeys.keyId} from ${oneTimeKeys} where ${oneTimeKeys.deviceId} = ${device.id} order by ${oneTimeKeys.keyId} limit 1 for update skip locked)`,
          ),
        ),
      )
      .returning();
    if (oneTime) {
      claimed.push({ ...target, keyId: oneTime.keyId, key: oneTime.key, signature: oneTime.signature, fallback: false });
      continue;
    }

    const [fallback] = await db
      .update(fallbackKeys)
      .set({ used: true })
      .where(eq(fallbackKeys.deviceId, device.id))
      .returning();
    if (fallback) {
      claimed.push({ ...target, keyId: fallback.keyId, key: fallback.key, signature: fallback.signature, fallback: true });
    }
  }
  return claimed;
}

/**
 * Take devices out of every device list after they sign out or are
 * removed. The rows stay, because old events name them as senders. Their
 * one-time keys, fallback keys and queued messages are deleted.
 * Returns the ids of the users whose device list changed.
 */
export async function retireDevices(db: DbClient, deviceIds: string[]): Promise<bigint[]> {
  if (deviceIds.length === 0) {
    return [];
  }
  const retired = await db
    .update(devices)
    .set({ removedAt: new Date() })
    .where(and(inArray(devices.id, deviceIds), isNotNull(devices.curve25519Key), isNull(devices.removedAt)))
    .returning({ id: devices.id, userId: devices.userId });
  const ids = retired.map((row) => row.id);
  if (ids.length > 0) {
    await db.delete(oneTimeKeys).where(inArray(oneTimeKeys.deviceId, ids));
    await db.delete(fallbackKeys).where(inArray(fallbackKeys.deviceId, ids));
    await db.delete(toDeviceQueue).where(inArray(toDeviceQueue.recipientDeviceId, ids));
  }
  return [...new Set(retired.map((row) => row.userId))];
}
