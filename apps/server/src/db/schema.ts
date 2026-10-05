// Drizzle ORM schema for the whole data model.
// Every ID is a snowflake, stored as a Postgres bigint and read back as a
// JavaScript bigint. Encrypted content is stored as bytea (raw ciphertext
// bytes); the server never reads or writes plaintext for these columns.
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

/** Raw ciphertext bytes. The server stores and moves these bytes, and never reads them. */
const bytea = customType<{ data: Uint8Array }>({
  dataType() {
    return "bytea";
  },
});

function snowflake(name?: string) {
  return name === undefined ? bigint({ mode: "bigint" }) : bigint(name, { mode: "bigint" });
}

export const users = pgTable(
  "users",
  {
    id: snowflake().primaryKey(),
    username: text("username").notNull().unique(),
    displayName: text("display_name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    /** The argon2id hash of the auth key, or of the password itself when kdf_version is null. */
    passwordHash: text("password_hash"),
    /** The salt of the password key (base64url). The client derives the auth key with it. */
    kdfSalt: text("kdf_salt"),
    /** The version of the password key derivation. Null: a legacy account, the hash is of the password. */
    kdfVersion: integer("kdf_version"),
    /** The recovery key, encrypted with the wrap key of the password (base64url). The server cannot open it. */
    keyWrap: text("key_wrap"),
    /** The key backup version that the recovery key in key_wrap opens. */
    keyWrapVersion: integer("key_wrap_version"),
    avatarKey: text("avatar_key"),
    statusText: text("status_text"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Speeds up the case-insensitive prefix match of member search.
    index("users_username_lower_idx").using("btree", sql`lower(${table.username}) text_pattern_ops`),
    index("users_display_name_lower_idx").using("btree", sql`lower(${table.displayName}) text_pattern_ops`),
  ],
);

/** A one-use token sent by email, for email verification or password reset. */
export const emailTokens = pgTable(
  "email_tokens",
  {
    id: snowflake().primaryKey(),
    userId: snowflake("user_id")
      .notNull()
      .references(() => users.id),
    purpose: text("purpose", { enum: ["verify_email", "reset_password"] }).notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (table) => [
    index("email_tokens_user_purpose_idx").on(table.userId, table.purpose),
    unique("email_tokens_token_hash_key").on(table.tokenHash),
  ],
);

export const oauthAccounts = pgTable(
  "oauth_accounts",
  {
    provider: text("provider").notNull(),
    providerUserId: text("provider_user_id").notNull(),
    userId: snowflake("user_id")
      .notNull()
      .references(() => users.id),
  },
  (table) => [primaryKey({ columns: [table.provider, table.providerUserId] })],
);

export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: snowflake().primaryKey(),
    userId: snowflake("user_id")
      .notNull()
      .references(() => users.id),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    unique("refresh_tokens_token_hash_key").on(table.tokenHash),
    index("refresh_tokens_device_id_idx").on(table.deviceId),
  ],
);

/**
 * One device is one login session (a browser tab or an app install). The
 * E2EE keys start empty and are filled in by the device once it sets up
 * end-to-end encryption. See docs/concepts/olm-megolm.md.
 */
export const devices = pgTable("devices", {
  id: text("id").primaryKey(),
  userId: snowflake("user_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  curve25519Key: text("curve25519_key"),
  ed25519Key: text("ed25519_key"),
  /** The device Ed25519 key signs its own identity keys. */
  keySignature: text("key_signature"),
  /** The user master key signs the identity keys of this device. */
  masterSignature: text("master_signature"),
  /**
   * Set when the device signs out or is removed while it has keys. The
   * row stays for old events, but the device is out of every device list.
   */
  removedAt: timestamp("removed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
});

export const oneTimeKeys = pgTable(
  "one_time_keys",
  {
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    keyId: text("key_id").notNull(),
    key: text("key").notNull(),
    /** The device Ed25519 key signs this key. */
    signature: text("signature").notNull(),
  },
  (table) => [primaryKey({ columns: [table.deviceId, table.keyId] })],
);

export const fallbackKeys = pgTable("fallback_keys", {
  deviceId: text("device_id")
    .primaryKey()
    .references(() => devices.id, { onDelete: "cascade" }),
  keyId: text("key_id").notNull(),
  key: text("key").notNull(),
  signature: text("signature").notNull(),
  /** Set when a claim returned this key. The device then uploads a new one. */
  used: boolean("used").notNull().default(false),
});

/** The master key of a user. It signs the device keys of the user. */
export const crossSigningKeys = pgTable("cross_signing_keys", {
  userId: snowflake("user_id")
    .primaryKey()
    .references(() => users.id),
  masterKey: text("master_key").notNull(),
  /** The device that vouches for the master key: its Ed25519 key signed it. A device that holds the key can take this place. */
  deviceId: text("device_id").notNull(),
  deviceSignature: text("device_signature").notNull(),
});

export const toDeviceQueue = pgTable(
  "to_device_queue",
  {
    id: snowflake().primaryKey(),
    recipientDeviceId: text("recipient_device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    senderUserId: snowflake("sender_user_id")
      .notNull()
      .references(() => users.id),
    senderDeviceId: text("sender_device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("to_device_queue_recipient_id_idx").on(table.recipientDeviceId, table.id)],
);

export const keyBackupVersions = pgTable(
  "key_backup_versions",
  {
    userId: snowflake("user_id")
      .notNull()
      .references(() => users.id),
    version: integer("version").notNull(),
    publicKey: text("public_key").notNull(),
    authData: text("auth_data").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.version] })],
);

export const keyBackupSessions = pgTable(
  "key_backup_sessions",
  {
    userId: snowflake("user_id").notNull(),
    version: integer("version").notNull(),
    channelId: snowflake("channel_id").notNull(),
    sessionId: text("session_id").notNull(),
    firstIndex: integer("first_index").notNull(),
    encryptedSession: bytea("encrypted_session").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.version, table.sessionId] })],
);

/** Secrets in the key backup: the master private key and the settings keys, encrypted to the backup key. */
export const keyBackupSecrets = pgTable(
  "key_backup_secrets",
  {
    userId: snowflake("user_id").notNull(),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    data: bytea("data").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.version, table.name] })],
);

export const guilds = pgTable("guilds", {
  id: snowflake().primaryKey(),
  name: text("name").notNull(),
  iconKey: text("icon_key"),
  ownerId: snowflake("owner_id")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const guildMembers = pgTable(
  "guild_members",
  {
    guildId: snowflake("guild_id")
      .notNull()
      .references(() => guilds.id, { onDelete: "cascade" }),
    userId: snowflake("user_id")
      .notNull()
      .references(() => users.id),
    nickname: text("nickname"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.userId] }),
    // Speeds up the case-insensitive prefix match of member search.
    index("guild_members_nickname_lower_idx").using("btree", sql`lower(${table.nickname}) text_pattern_ops`),
  ],
);

export const roles = pgTable("roles", {
  id: snowflake().primaryKey(),
  guildId: snowflake("guild_id")
    .notNull()
    .references(() => guilds.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  color: integer("color").notNull().default(0),
  position: integer("position").notNull().default(0),
  permissions: bigint("permissions", { mode: "bigint" }).notNull().default(sql`0`),
  mentionable: boolean("mentionable").notNull().default(true),
  hoist: boolean("hoist").notNull().default(false),
});

export const memberRoles = pgTable(
  "member_roles",
  {
    guildId: snowflake("guild_id")
      .notNull()
      .references(() => guilds.id, { onDelete: "cascade" }),
    userId: snowflake("user_id").notNull(),
    roleId: snowflake("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.userId, table.roleId] }),
    index("member_roles_guild_user_idx").on(table.guildId, table.userId),
  ],
);

export const bans = pgTable(
  "bans",
  {
    guildId: snowflake("guild_id")
      .notNull()
      .references(() => guilds.id, { onDelete: "cascade" }),
    userId: snowflake("user_id")
      .notNull()
      .references(() => users.id),
    reason: text("reason"),
    by: snowflake("by")
      .notNull()
      .references(() => users.id),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.userId] })],
);

export const channels = pgTable(
  "channels",
  {
    id: snowflake().primaryKey(),
    guildId: snowflake("guild_id").references(() => guilds.id, { onDelete: "cascade" }),
    type: text("type", { enum: ["text", "voice", "category", "dm", "group_dm"] }).notNull(),
    name: text("name"),
    topic: text("topic"),
    position: integer("position").notNull().default(0),
    parentId: snowflake("parent_id"),
    nsfw: boolean("nsfw").notNull().default(false),
    ownerId: snowflake("owner_id").references(() => users.id),
    /** The newest timeline event (a message or a reply, not an edit or a reaction) in this channel. */
    lastEventId: snowflake("last_event_id"),
    /**
     * Set only on a 1:1 DM: the two user ids, smaller first, joined with a colon.
     * The unique constraint makes "one DM per pair" hold even for parallel requests.
     */
    dmKey: text("dm_key"),
  },
  (table) => [unique("channels_dm_key_key").on(table.dmKey)],
);

export const channelRecipients = pgTable(
  "channel_recipients",
  {
    channelId: snowflake("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    userId: snowflake("user_id")
      .notNull()
      .references(() => users.id),
    /** Decides who becomes the owner of a group DM when the owner leaves: the oldest member. */
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.channelId, table.userId] }),
    // Speeds up "which DMs is this user in".
    index("channel_recipients_user_idx").on(table.userId),
  ],
);

export const permissionOverwrites = pgTable(
  "permission_overwrites",
  {
    channelId: snowflake("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    targetId: snowflake("target_id").notNull(),
    targetType: text("target_type", { enum: ["role", "member"] }).notNull(),
    allow: bigint("allow", { mode: "bigint" }).notNull().default(sql`0`),
    deny: bigint("deny", { mode: "bigint" }).notNull().default(sql`0`),
  },
  (table) => [primaryKey({ columns: [table.channelId, table.targetId, table.targetType] })],
);

export const events = pgTable(
  "events",
  {
    id: snowflake().primaryKey(),
    channelId: snowflake("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    senderUserId: snowflake("sender_user_id")
      .notNull()
      .references(() => users.id),
    senderDeviceId: text("sender_device_id")
      .notNull()
      .references(() => devices.id),
    type: text("type").notNull().default("m.encrypted"),
    relatesToId: snowflake("relates_to_id"),
    relType: text("rel_type", { enum: ["edit", "reaction", "reply"] }),
    /** The payload codec: `plain-v1` (milestone M3) or `megolm-v1` (milestone M6). The server never reads through it. */
    codec: text("codec").notNull().default("plain-v1"),
    megolmSessionId: text("megolm_session_id"),
    ciphertext: bytea("ciphertext").notNull(),
    /** A client-generated dedupe key. The same (device, nonce) pair within 10 minutes returns the first event. */
    nonce: text("nonce").notNull(),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("events_channel_created_idx").on(table.channelId, table.createdAt),
    index("events_channel_id_idx").on(table.channelId, table.id),
    index("events_relates_to_idx").on(table.relatesToId),
    unique("events_sender_device_nonce_key").on(table.senderDeviceId, table.nonce),
  ],
);

/**
 * One encrypted file. The server keeps only the ciphertext on disk, under
 * `${DATA_DIR}/attachments/<id>`. See docs/concepts/attachments.md.
 */
export const attachments = pgTable(
  "attachments",
  {
    id: snowflake().primaryKey(),
    uploaderId: snowflake("uploader_id")
      .notNull()
      .references(() => users.id),
    channelId: snowflake("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    size: integer("size").notNull(),
    storagePath: text("storage_path").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set when the client sent the message that holds the file. The cleanup deletes files that stay unclaimed. */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
  },
  (table) => [index("attachments_uploader_idx").on(table.uploaderId), index("attachments_created_idx").on(table.createdAt)],
);

export const invites = pgTable("invites", {
  code: text("code").primaryKey(),
  guildId: snowflake("guild_id")
    .notNull()
    .references(() => guilds.id, { onDelete: "cascade" }),
  channelId: snowflake("channel_id")
    .notNull()
    .references(() => channels.id, { onDelete: "cascade" }),
  inviterId: snowflake("inviter_id")
    .notNull()
    .references(() => users.id),
  maxUses: integer("max_uses"),
  uses: integer("uses").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});

export const friendships = pgTable(
  "friendships",
  {
    userId: snowflake("user_id")
      .notNull()
      .references(() => users.id),
    otherId: snowflake("other_id")
      .notNull()
      .references(() => users.id),
    /**
     * One row per direction. A friend request makes `pending_outgoing` for the sender
     * and `pending_incoming` for the receiver. A block makes one `blocked` row, for the
     * user who blocked, and removes the other direction.
     */
    status: text("status", { enum: ["pending_outgoing", "pending_incoming", "accepted", "blocked"] }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.otherId] })],
);

export const readStates = pgTable(
  "read_states",
  {
    userId: snowflake("user_id")
      .notNull()
      .references(() => users.id),
    channelId: snowflake("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    lastReadEventId: snowflake("last_read_event_id"),
  },
  (table) => [primaryKey({ columns: [table.userId, table.channelId] })],
);

export const userSettings = pgTable("user_settings", {
  userId: snowflake("user_id")
    .primaryKey()
    .references(() => users.id),
  encryptedBlob: bytea("encrypted_blob").notNull(),
  /** Starts at 1 with the first save. Each save adds 1. A save with an old version fails. */
  version: integer("version").notNull().default(1),
});
