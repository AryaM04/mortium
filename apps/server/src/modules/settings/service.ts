// Synced user settings. The server stores one opaque blob for each user and
// never reads it. The client encrypts it with the settings key of the user.
// A save must carry the version the client last read, so two devices cannot
// overwrite each other by mistake.
import { and, eq } from "drizzle-orm";
import {
  decodeBase64Url,
  DispatchEvent,
  encodeBase64Url,
  type PutSettingsRequest,
  type SettingsResponse,
} from "@mortium/shared";
import type { DbClient } from "../../db/client.js";
import { userSettings } from "../../db/schema.js";
import { AppError } from "../../errors.js";
import type { GatewayService } from "../gateway/service.js";

export interface SettingsDeps {
  db: DbClient;
  gateway?: GatewayService;
}

export async function getSettings(db: DbClient, userId: bigint): Promise<SettingsResponse> {
  const rows = await db.select().from(userSettings).where(eq(userSettings.userId, userId)).limit(1);
  const row = rows[0];
  if (!row) {
    return { data: null, version: 0 };
  }
  return { data: encodeBase64Url(row.encryptedBlob), version: row.version };
}

function versionConflict(): AppError {
  return new AppError(409, "VERSION_CONFLICT", "The settings changed on another device. Load them again.");
}

/** Save the settings. Fails with 409 when `input.version` is not the stored version. */
export async function putSettings(
  deps: SettingsDeps,
  userId: bigint,
  deviceId: string,
  input: PutSettingsRequest,
): Promise<SettingsResponse> {
  const { db, gateway } = deps;
  const bytes = decodeBase64Url(input.data);

  let version: number;
  if (input.version === 0) {
    // No row can exist yet. The primary key lets only one first save win.
    const inserted = await db
      .insert(userSettings)
      .values({ userId, encryptedBlob: bytes, version: 1 })
      .onConflictDoNothing()
      .returning({ version: userSettings.version });
    if (!inserted[0]) {
      throw versionConflict();
    }
    version = inserted[0].version;
  } else {
    // One update checks the version and writes, so two saves cannot both win.
    const updated = await db
      .update(userSettings)
      .set({ encryptedBlob: bytes, version: input.version + 1 })
      .where(and(eq(userSettings.userId, userId), eq(userSettings.version, input.version)))
      .returning({ version: userSettings.version });
    if (!updated[0]) {
      throw versionConflict();
    }
    version = updated[0].version;
  }

  gateway?.toUserExceptDevice(userId, deviceId, DispatchEvent.USER_SETTINGS_UPDATE, { version });
  return { data: input.data, version };
}
