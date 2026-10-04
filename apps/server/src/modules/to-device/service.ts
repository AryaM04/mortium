// The to-device queue: Olm messages from one device to one device. The
// table is the durable store. The gateway sends queued rows in id order,
// with a window of unacknowledged messages for each gateway session, and
// deletes the rows once the client acknowledges them. TO_DEVICE never
// goes through the resume buffer. See docs/concepts/olm-megolm.md section 6.
//
// A row with a lower id can commit after a row with a higher id, because
// each request takes its ids before its transaction. Thus the delivery
// reads every queued row that this session did not get yet, not only the
// rows after the last sent id. An ACK deletes only rows that were sent.
import { and, eq, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import { decodeBase64Url, encodeBase64Url, DispatchEvent, type DeviceRef, type ToDeviceMessage } from "@mortium/shared";
import type { FastifyBaseLogger } from "fastify";
import type { DbClient } from "../../db/client.js";
import { devices, toDeviceQueue } from "../../db/schema.js";
import { AppError } from "../../errors.js";
import { nextId } from "../../id.js";
import type { GatewayService } from "../gateway/service.js";
import { visibleUserIds } from "../keys/visibility.js";

/** The queue keeps at most this many messages for each recipient device. */
export const TO_DEVICE_QUEUE_LIMIT = 10_000;
/** The most messages that one gateway session has sent but not acknowledged. */
export const TO_DEVICE_WINDOW = 100;

export interface ToDeviceDeps {
  db: DbClient;
  delivery: ToDeviceDelivery;
  log: FastifyBaseLogger;
}

/**
 * Store messages for the recipient devices, then start a delivery to the
 * devices that are online. The whole request fails when a recipient user
 * is not visible to the sender. Unknown, removed or keyless devices are
 * skipped and returned.
 */
export async function sendToDevice(
  deps: ToDeviceDeps,
  senderUserId: bigint,
  senderDeviceId: string,
  messages: ToDeviceMessage[],
  queueLimit = TO_DEVICE_QUEUE_LIMIT,
): Promise<{ skipped: DeviceRef[] }> {
  const { db } = deps;
  const [sender] = await db
    .select({ curve25519Key: devices.curve25519Key, removedAt: devices.removedAt })
    .from(devices)
    .where(and(eq(devices.id, senderDeviceId), eq(devices.userId, senderUserId)));
  if (!sender || sender.removedAt !== null) {
    throw new AppError(403, "DEVICE_REMOVED", "This device was signed out or removed.");
  }
  if (sender.curve25519Key === null) {
    throw new AppError(400, "DEVICE_KEYS_MISSING", "Upload the identity keys of this device first.");
  }

  const userIds = [...new Set(messages.map((message) => BigInt(message.userId)))];
  const visible = await visibleUserIds(db, senderUserId, userIds);
  if (visible.size !== userIds.length) {
    throw new AppError(403, "CANNOT_SEND_TO_DEVICE", "You cannot send to a device of this user.");
  }

  const targets = await db
    .select({ id: devices.id, userId: devices.userId })
    .from(devices)
    .where(
      and(
        inArray(
          devices.id,
          messages.map((message) => message.deviceId),
        ),
        isNotNull(devices.curve25519Key),
        isNull(devices.removedAt),
      ),
    );
  const live = new Set(targets.map((row) => `${row.userId}:${row.id}`));
  const accepted = messages.filter((message) => live.has(`${message.userId}:${message.deviceId}`));
  const skipped = messages
    .filter((message) => !live.has(`${message.userId}:${message.deviceId}`))
    .map((message) => ({ userId: message.userId, deviceId: message.deviceId }));

  if (accepted.length > 0) {
    const recipients = [...new Set(accepted.map((message) => message.deviceId))];
    await db.transaction(async (tx) => {
      await tx.insert(toDeviceQueue).values(
        accepted.map((message) => ({
          id: nextId(),
          recipientDeviceId: message.deviceId,
          senderUserId,
          senderDeviceId,
          type: message.type,
          ciphertext: decodeBase64Url(message.ciphertext),
        })),
      );
      for (const deviceId of recipients) {
        const dropped = await tx.execute(sql`
          delete from ${toDeviceQueue} where ${toDeviceQueue.id} in (
            select ${toDeviceQueue.id} from ${toDeviceQueue}
            where ${toDeviceQueue.recipientDeviceId} = ${deviceId}
            order by ${toDeviceQueue.id} desc offset ${queueLimit}
          )`);
        if (dropped.count > 0) {
          deps.log.warn(
            { deviceId, dropped: dropped.count },
            "The to-device queue of a device is full. The server deleted the oldest messages.",
          );
        }
      }
    });
    deps.delivery.notifyDevices(recipients);
  }
  return { skipped };
}

interface DeliveryState {
  deviceId: string;
  /** Ids sent to this session and not acknowledged yet, in the order of the send. */
  sent: bigint[];
  running: boolean;
  again: boolean;
  /** Changes on each resync, so a pump that started before it drops its rows. */
  generation: number;
}

/** Sends queued rows to live gateway sessions. One state for each live session. */
export class ToDeviceDelivery {
  private readonly states = new Map<string, DeliveryState>();

  constructor(
    private readonly db: DbClient,
    private readonly gateway: GatewayService,
    private readonly log: FastifyBaseLogger,
    private readonly window = TO_DEVICE_WINDOW,
  ) {}

  /** Call after IDENTIFY or RESUME: send the queue from the start. */
  start(sessionId: string, deviceId: string): void {
    this.states.set(sessionId, {
      deviceId,
      sent: [],
      running: false,
      again: false,
      generation: 0,
    });
    this.pump(sessionId);
  }

  /** Call when the socket of a session closes. */
  stop(sessionId: string): void {
    this.states.delete(sessionId);
  }

  /**
   * Delete the acknowledged rows, then send more. The client processed the
   * row `upToId`. The socket keeps the order, so the client also got every
   * row that this session sent before that row. When this session did not
   * send `upToId`, every sent row up to that id counts. With `resync`, send
   * again every queued row.
   */
  async ack(sessionId: string, upToId: bigint, resync: boolean): Promise<void> {
    const state = this.states.get(sessionId);
    if (!state) {
      return;
    }
    const index = state.sent.indexOf(upToId);
    const done = (index >= 0 ? state.sent.slice(0, index + 1) : state.sent).filter((id) => id <= upToId);
    if (done.length > 0) {
      await this.db
        .delete(toDeviceQueue)
        .where(and(eq(toDeviceQueue.recipientDeviceId, state.deviceId), inArray(toDeviceQueue.id, done)));
      state.sent = state.sent.filter((id) => !done.includes(id));
    }
    if (resync) {
      state.sent = [];
      state.generation += 1;
    }
    this.pump(sessionId);
  }

  /** Call after new rows for these devices commit. */
  notifyDevices(deviceIds: string[]): void {
    for (const [sessionId, state] of this.states) {
      if (deviceIds.includes(state.deviceId)) {
        this.pump(sessionId);
      }
    }
  }

  /** How many sessions have a delivery state. For tests. */
  get size(): number {
    return this.states.size;
  }

  private pump(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (!state) {
      return;
    }
    if (state.running) {
      state.again = true;
      return;
    }
    state.running = true;
    this.run(sessionId, state)
      .catch((error: unknown) => {
        this.log.error(error, "The server could not send queued to-device messages.");
      })
      .finally(() => {
        state.running = false;
      });
  }

  private async run(sessionId: string, state: DeliveryState): Promise<void> {
    do {
      state.again = false;
      const room = this.window - state.sent.length;
      if (room <= 0) {
        return;
      }
      const generation = state.generation;
      const rows = await this.db
        .select()
        .from(toDeviceQueue)
        .where(
          and(
            eq(toDeviceQueue.recipientDeviceId, state.deviceId),
            state.sent.length > 0 ? notInArray(toDeviceQueue.id, state.sent) : undefined,
          ),
        )
        .orderBy(toDeviceQueue.id)
        .limit(room);
      if (this.states.get(sessionId) !== state) {
        return;
      }
      if (generation !== state.generation) {
        state.again = true;
        continue;
      }
      for (const row of rows) {
        const sent = this.gateway.sendToSession(sessionId, DispatchEvent.TO_DEVICE, {
          id: row.id.toString(),
          senderUserId: row.senderUserId.toString(),
          senderDeviceId: row.senderDeviceId,
          type: row.type,
          ciphertext: encodeBase64Url(row.ciphertext),
          createdAt: row.createdAt.toISOString(),
        });
        if (!sent) {
          return;
        }
        state.sent.push(row.id);
      }
    } while (state.again);
  }
}
