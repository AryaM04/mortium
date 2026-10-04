// Request and response schemas for the key server and the to-device queue.
// See docs/concepts/olm-megolm.md sections 3, 4 and 6.
import { z } from "zod";
import { idSchema } from "./common.js";
import { base64UrlSchema } from "./messages.js";

/** A Curve25519 or Ed25519 public key: 32 bytes as unpadded standard base64. */
export const publicKeySchema = z.string().regex(/^[A-Za-z0-9+/]{43}$/, "This is not a valid public key.");
/** An Ed25519 signature: 64 bytes as unpadded standard base64. */
export const signatureSchema = z.string().regex(/^[A-Za-z0-9+/]{86}$/, "This is not a valid signature.");
/** A one-time key id, as vodozemac writes it. */
export const keyIdSchema = z.string().regex(/^[A-Za-z0-9+/_-]{1,32}$/, "This is not a valid key id.");
/** A device id, as the server makes it (base64url). */
export const deviceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "This is not a valid device id.");

/** The server keeps at most this many one-time keys for each device. */
export const MAX_STORED_ONE_TIME_KEYS = 100;
/** The largest to-device ciphertext, in bytes once decoded. */
export const MAX_TO_DEVICE_BYTES = 64 * 1024;
/** The most to-device messages in one request. */
export const MAX_TO_DEVICE_MESSAGES = 100;
/** The most users in one key query, and the most devices in one claim. */
export const MAX_KEY_QUERY_ITEMS = 500;

export const deviceKeysSchema = z.object({
  curve25519: publicKeySchema,
  ed25519: publicKeySchema,
  /** The device Ed25519 key signs `deviceKeysSignedText`. */
  signature: signatureSchema,
});
export type DeviceKeys = z.infer<typeof deviceKeysSchema>;

export const signedKeySchema = z.object({ key: publicKeySchema, signature: signatureSchema });

export const uploadKeysRequestSchema = z.object({
  deviceKeys: deviceKeysSchema.optional(),
  oneTimeKeys: z
    .record(keyIdSchema, signedKeySchema)
    .refine((keys) => Object.keys(keys).length <= MAX_STORED_ONE_TIME_KEYS, "Too many one-time keys.")
    .optional(),
  fallbackKey: signedKeySchema.extend({ keyId: keyIdSchema }).optional(),
  /** The master key of the user signs the device keys of this device. */
  masterSignature: signatureSchema.optional(),
});
export type UploadKeysRequest = z.infer<typeof uploadKeysRequestSchema>;

export const uploadKeysResponseSchema = z.object({
  oneTimeKeyCount: z.number().int().nonnegative(),
  /** True when the device has no fallback key, or when a claim used it. */
  needsFallbackKey: z.boolean(),
});
export type UploadKeysResponse = z.infer<typeof uploadKeysResponseSchema>;

export const putMasterKeyRequestSchema = z.object({
  publicKey: publicKeySchema,
  /** The Ed25519 key of the calling device signs `masterKeySignedText`. */
  deviceSignature: signatureSchema,
  /** The master key signs the device keys of the calling device. */
  masterSignature: signatureSchema,
});
export type PutMasterKeyRequest = z.infer<typeof putMasterKeyRequestSchema>;

export const queryKeysRequestSchema = z.object({
  userIds: z.array(idSchema).min(1).max(MAX_KEY_QUERY_ITEMS),
});
export type QueryKeysRequest = z.infer<typeof queryKeysRequestSchema>;

export const queriedDeviceSchema = deviceKeysSchema.extend({
  deviceId: deviceIdSchema,
  masterSignature: signatureSchema.nullable(),
});
export type QueriedDevice = z.infer<typeof queriedDeviceSchema>;

export const masterKeySchema = z.object({
  publicKey: publicKeySchema,
  /** The device that uploaded the master key, and its signature. */
  deviceId: deviceIdSchema,
  deviceSignature: signatureSchema,
});
export type MasterKey = z.infer<typeof masterKeySchema>;

export const queriedUserSchema = z.object({
  userId: idSchema,
  masterKey: masterKeySchema.nullable(),
  devices: z.array(queriedDeviceSchema),
});
export type QueriedUser = z.infer<typeof queriedUserSchema>;

export const queryKeysResponseSchema = z.object({ users: z.array(queriedUserSchema) });
export type QueryKeysResponse = z.infer<typeof queryKeysResponseSchema>;

export const deviceRefSchema = z.object({ userId: idSchema, deviceId: deviceIdSchema });
export type DeviceRef = z.infer<typeof deviceRefSchema>;

export const claimKeysRequestSchema = z.object({
  devices: z.array(deviceRefSchema).min(1).max(MAX_KEY_QUERY_ITEMS),
});
export type ClaimKeysRequest = z.infer<typeof claimKeysRequestSchema>;

export const claimedKeySchema = deviceRefSchema.extend({
  keyId: keyIdSchema,
  key: publicKeySchema,
  signature: signatureSchema,
  /** True when the device had no one-time key left and this is its fallback key. */
  fallback: z.boolean(),
});
export type ClaimedKey = z.infer<typeof claimedKeySchema>;

export const claimKeysResponseSchema = z.object({ keys: z.array(claimedKeySchema) });
export type ClaimKeysResponse = z.infer<typeof claimKeysResponseSchema>;

// Base64url of 64 KiB is at most this many characters.
const MAX_TO_DEVICE_CHARS = Math.ceil((MAX_TO_DEVICE_BYTES * 4) / 3);

export const toDeviceMessageSchema = deviceRefSchema.extend({
  /** The outer type the server sees. The real event type is inside the ciphertext. */
  type: z.string().regex(/^[a-z0-9.]{1,32}$/, "This is not a valid message type."),
  ciphertext: base64UrlSchema.min(1).max(MAX_TO_DEVICE_CHARS, `The ciphertext must be at most ${MAX_TO_DEVICE_BYTES} bytes.`),
});
export type ToDeviceMessage = z.infer<typeof toDeviceMessageSchema>;

export const sendToDeviceRequestSchema = z.object({
  messages: z.array(toDeviceMessageSchema).min(1).max(MAX_TO_DEVICE_MESSAGES),
});
export type SendToDeviceRequest = z.infer<typeof sendToDeviceRequestSchema>;

export const sendToDeviceResponseSchema = z.object({
  /** Devices that do not exist, were removed or have no keys. The server stored nothing for them. */
  skipped: z.array(deviceRefSchema),
});
export type SendToDeviceResponse = z.infer<typeof sendToDeviceResponseSchema>;

/** Sent by the server: one queued to-device message for this device. */
export const toDeviceDispatchPayloadSchema = z.object({
  id: idSchema,
  senderUserId: idSchema,
  senderDeviceId: deviceIdSchema,
  type: z.string(),
  ciphertext: base64UrlSchema,
  createdAt: z.string(),
});
export type ToDeviceDispatchPayload = z.infer<typeof toDeviceDispatchPayloadSchema>;

/**
 * Sent by the client: every message up to `upToId` that the client got is
 * processed, so the server can delete it. With `resync`, the server also
 * sends again every queued message.
 */
export const toDeviceAckPayloadSchema = z.object({
  upToId: idSchema,
  resync: z.boolean().optional(),
});
export type ToDeviceAckPayload = z.infer<typeof toDeviceAckPayloadSchema>;

/** Sent by the server when the devices or the master key of a user change. */
export const deviceListUpdatePayloadSchema = z.object({ userId: idSchema });
export type DeviceListUpdatePayload = z.infer<typeof deviceListUpdatePayloadSchema>;

// ---- signatures of other devices and the master key reset (section 4) ----

/** The master key of the user signs the device keys of a different device of the same user. */
export const uploadSignatureRequestSchema = z.object({
  deviceId: deviceIdSchema,
  signature: signatureSchema,
});
export type UploadSignatureRequest = z.infer<typeof uploadSignatureRequestSchema>;

/** Replace the master key of the user. The password of the account is necessary. */
export const resetMasterKeyRequestSchema = putMasterKeyRequestSchema.extend({
  password: z.string().min(1).max(256),
});
export type ResetMasterKeyRequest = z.infer<typeof resetMasterKeyRequestSchema>;

// ---- key backup (section 9) ----

/** The most sessions in one backup upload. */
export const MAX_BACKUP_SESSIONS_PER_REQUEST = 100;
/** The largest encrypted session or secret, in bytes once decoded. */
export const MAX_BACKUP_ITEM_BYTES = 8 * 1024;
/** The most secrets (master key, settings keys) in one backup. */
export const MAX_BACKUP_SECRETS = 16;
/** The most sessions in one page of the session download. */
export const MAX_BACKUP_SESSIONS_PER_PAGE = 500;

const backupItemSchema = base64UrlSchema.min(1).max(Math.ceil((MAX_BACKUP_ITEM_BYTES * 4) / 3), "The backup item is too large.");

export const backupPassphraseSchema = z.object({
  algorithm: z.literal("argon2id"),
  salt: base64UrlSchema.min(22).max(86),
  memoryKiB: z.number().int().min(8 * 1024).max(256 * 1024),
  iterations: z.number().int().min(1).max(10),
  parallelism: z.number().int().min(1).max(4),
});

export const backupAuthDataSchema = z.object({
  passphrase: backupPassphraseSchema.nullable(),
  /** The device that made the backup. Its Ed25519 key signs `backupSignedText`. */
  deviceId: deviceIdSchema,
  signature: signatureSchema,
  /** The master key signs the same text when the device that made the backup holds it. */
  masterSignature: signatureSchema.nullable(),
});
export type BackupAuthData = z.infer<typeof backupAuthDataSchema>;

export const createBackupVersionRequestSchema = z.object({
  publicKey: publicKeySchema,
  authData: backupAuthDataSchema,
});
export type CreateBackupVersionRequest = z.infer<typeof createBackupVersionRequestSchema>;

export const createBackupVersionResponseSchema = z.object({ version: z.number().int().positive() });
export type CreateBackupVersionResponse = z.infer<typeof createBackupVersionResponseSchema>;

/** A secret name: "master" or "settings:<keyId>". */
export const backupSecretNameSchema = z.string().regex(/^[a-z]+(:[A-Za-z0-9_-]{1,32})?$/, "This is not a valid secret name.");

export const backupVersionSchema = z.object({
  version: z.number().int().positive(),
  publicKey: publicKeySchema,
  authData: backupAuthDataSchema,
  /** Secret name to the encrypted secret. */
  secrets: z.record(backupSecretNameSchema, backupItemSchema),
});
export type BackupVersion = z.infer<typeof backupVersionSchema>;

export const getBackupVersionResponseSchema = z.object({ backup: backupVersionSchema.nullable() });
export type GetBackupVersionResponse = z.infer<typeof getBackupVersionResponseSchema>;

export const backupSessionSchema = z.object({
  channelId: idSchema,
  /** The Megolm session id: unpadded standard base64. */
  sessionId: publicKeySchema,
  /** The first known message index of the encrypted session. The server keeps the lower one. */
  firstIndex: z.number().int().nonnegative().max(2 ** 31),
  data: backupItemSchema,
});
export type BackupSession = z.infer<typeof backupSessionSchema>;

export const putBackupSessionsRequestSchema = z.object({
  version: z.number().int().positive(),
  sessions: z.array(backupSessionSchema).min(1).max(MAX_BACKUP_SESSIONS_PER_REQUEST),
});
export type PutBackupSessionsRequest = z.infer<typeof putBackupSessionsRequestSchema>;

export const putBackupSecretsRequestSchema = z.object({
  version: z.number().int().positive(),
  secrets: z
    .record(backupSecretNameSchema, backupItemSchema)
    .refine((secrets) => Object.keys(secrets).length >= 1 && Object.keys(secrets).length <= MAX_BACKUP_SECRETS, "Send 1 to 16 secrets."),
});
export type PutBackupSecretsRequest = z.infer<typeof putBackupSecretsRequestSchema>;

export const getBackupSessionsQuerySchema = z.object({
  version: z.coerce.number().int().positive(),
  channelId: idSchema.optional(),
  /** Give the sessions after this session id (the `next` value of the previous page). */
  after: publicKeySchema.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_BACKUP_SESSIONS_PER_PAGE).optional(),
});
export type GetBackupSessionsQuery = z.infer<typeof getBackupSessionsQuerySchema>;

export const getBackupSessionsResponseSchema = z.object({
  sessions: z.array(backupSessionSchema),
  /** The `after` value of the next page, or null on the last page. */
  next: publicKeySchema.nullable(),
});
export type GetBackupSessionsResponse = z.infer<typeof getBackupSessionsResponseSchema>;
