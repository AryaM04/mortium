// Ringing for DM calls. When the first person joins the call of a DM, the
// other recipients get CALL_RING. The ring stops when someone else joins,
// when the caller leaves, or after a timeout. There is one timer for each
// ringing call, and every path that ends a ring clears it.
import { DispatchEvent } from "@mortium/shared";
import type { GatewayService } from "../gateway/service.js";

/** How long a call rings before it stops. Default 30 s. */
export const DEFAULT_CALL_RING_MS = 30_000;

interface Ring {
  timer: ReturnType<typeof setTimeout>;
  /** The user who started the call. */
  callerId: bigint;
  /** The people who got CALL_RING. They all get CALL_RING_STOP. */
  recipientIds: bigint[];
}

export class CallRinger {
  private readonly rings = new Map<string, Ring>();

  constructor(
    private readonly gateway: GatewayService,
    private readonly ringMs: number = DEFAULT_CALL_RING_MS,
  ) {}

  /** Start to ring the recipients other than the caller. Does nothing when the call already rings. */
  start(channelId: bigint, callerId: bigint, recipientIds: bigint[]): void {
    const key = channelId.toString();
    const targets = recipientIds.filter((id) => id !== callerId);
    if (this.rings.has(key) || targets.length === 0) {
      return;
    }
    const timer = setTimeout(() => this.stop(channelId), this.ringMs);
    timer.unref?.();
    this.rings.set(key, { timer, callerId, recipientIds: targets });
    this.gateway.toUsers(targets, DispatchEvent.CALL_RING, { channelId: key, userId: callerId.toString() });
  }

  /** Stop the ring, if the call rings. Clears the timer and tells the recipients. */
  stop(channelId: bigint): void {
    const key = channelId.toString();
    const ring = this.rings.get(key);
    if (!ring) {
      return;
    }
    clearTimeout(ring.timer);
    this.rings.delete(key);
    this.gateway.toUsers(ring.recipientIds, DispatchEvent.CALL_RING_STOP, { channelId: key });
  }

  /** Each call that rings for `userId` now, in the shape of a CALL_RING payload. */
  ringsFor(userId: bigint): Array<{ channelId: string; userId: string }> {
    const result: Array<{ channelId: string; userId: string }> = [];
    for (const [channelId, ring] of this.rings) {
      if (ring.recipientIds.includes(userId)) {
        result.push({ channelId, userId: ring.callerId.toString() });
      }
    }
    return result;
  }

  isRinging(channelId: bigint): boolean {
    return this.rings.has(channelId.toString());
  }

  /** Clear every timer, without a dispatch. Call it when the server closes. */
  dispose(): void {
    for (const ring of this.rings.values()) {
      clearTimeout(ring.timer);
    }
    this.rings.clear();
  }
}
