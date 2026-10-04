// Turn a database user row into the JSON shape the API sends.
import type { User } from "@mortium/shared";
import type { users } from "../../db/schema.js";

export type UserRow = typeof users.$inferSelect;

/**
 * Build the public user JSON. Pass `includePrivate: true` only for the
 * signed-in user's own view (`@me`), because it adds the email fields.
 */
export function toUserJson(row: UserRow, options: { includePrivate: boolean }): User {
  return {
    id: row.id.toString(),
    username: row.username,
    displayName: row.displayName,
    avatarKey: row.avatarKey,
    statusText: row.statusText,
    createdAt: row.createdAt.toISOString(),
    ...(options.includePrivate ? { email: row.email, emailVerified: row.emailVerified } : {}),
  };
}
