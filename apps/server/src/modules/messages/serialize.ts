// Turn an `events` database row into the wire event shape.
import { encodeBase64Url, type EventCodec, type EventJson, type EventRelType } from "@mortium/shared";
import type { events } from "../../db/schema.js";

export type EventRow = typeof events.$inferSelect;

export function toEventJson(row: EventRow): EventJson {
  return {
    id: row.id.toString(),
    channelId: row.channelId.toString(),
    senderId: row.senderUserId.toString(),
    senderDeviceId: row.senderDeviceId,
    relType: (row.relType as EventRelType | null) ?? null,
    relatesToId: row.relatesToId?.toString() ?? null,
    codec: row.codec as EventCodec,
    megolmSessionId: row.megolmSessionId,
    ciphertext: encodeBase64Url(row.ciphertext),
    nonce: row.nonce,
    createdAt: row.createdAt.toISOString(),
    redactedAt: row.redactedAt?.toISOString() ?? null,
  };
}
