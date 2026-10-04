// The Megolm machine: it encrypts channel events with one outbound Megolm
// session for each channel, shares the session key with Olm to each device
// that may read the channel, and decrypts events with the inbound sessions.
// It also sends history to new members, and asks for keys that it does not
// have. See docs/concepts/olm-megolm.md section 8.
import {
  decodeBase64Url,
  decodePlainPayload,
  encodePlainPayload,
  megolmSessionSignedText,
  type DecryptedPayload,
  type DeviceRef,
  type EventJson,
} from "@mortium/shared";
import type { AccountHolder } from "./account.js";
import type { DeviceList } from "./device-list.js";
import type { ChannelMembership, MembershipScope } from "./membership.js";
import { isTemporaryError, type DecryptedToDevice, type OlmMachine } from "./olm-machine.js";
import type { KeyedQueue } from "./queue.js";
import type { CryptoStore, DeviceRecord, InboundRecord, OutboundRecord } from "./store.js";
import type { Wasm } from "./wasm.js";

/** The to-device envelope types of Megolm. */
export const SESSION_TYPE = "megolm.session";
export const FORWARD_TYPE = "megolm.forward";
export const REQUEST_TYPE = "megolm.request";

export const WAITING_TEXT = "This message cannot be read yet. The app asks for the key.";
const CANNOT_READ_TEXT = "This message cannot be read.";

const MAX_MESSAGES_PER_SESSION = 100;
const MAX_SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Keep at most this many inbound sessions in memory. The store keeps all of them. */
export const MAX_CACHED_INBOUND = 100;
/** Do not try again to share a key with a device that failed for this time. */
const SHARE_RETRY_MS = 60_000;
/** Answer the same key request from the same device at most one time in this time. */
const ANSWER_INTERVAL_MS = 30_000;
/** Send the history of a channel to the same new member at most one time in this time. */
const FORWARD_INTERVAL_MS = 10 * 60 * 1000;
/** A key request also goes to the devices of this many other users who may read the channel. */
const REQUEST_HELPER_USERS = 3;
/** After the first device, this many more devices send history to a new member, after a random delay. */
const BACKUP_FORWARDERS = 2;
/** Keep at most this many key requests that got no answer, for a later new try. */
const MAX_UNANSWERED = 1000;

export interface MegolmTimings {
  /** The delay before each key request attempt. The number of values is the number of attempts. */
  requestDelaysMs: number[];
  /** The random delay of a backup history sender: [lowest, highest]. */
  backupForwardDelayMs: [number, number];
  /** Wait this long after a membership event before the check for new members. */
  membershipDebounceMs: number;
}

const DEFAULT_TIMINGS: MegolmTimings = {
  requestDelaysMs: [0, 5_000, 30_000, 120_000, 600_000],
  backupForwardDelayMs: [20_000, 40_000],
  membershipDebounceMs: 1_000,
};

export type MegolmDecodeResult =
  | { ok: true; payload: DecryptedPayload }
  | { ok: false; reason: string; waiting?: boolean };

export interface MegolmDeps {
  wasm: Wasm;
  store: CryptoStore;
  olm: OlmMachine;
  deviceList: DeviceList;
  membership: ChannelMembership;
  account: AccountHolder;
  queue: KeyedQueue;
  pickleKey: Uint8Array;
  userId: string;
  deviceId: string;
  /** True when the user is online. A history sender must be online. Default: every user is online. */
  isOnline?: (userId: string) => boolean;
  now?: () => number;
  random?: () => number;
  log?: (message: string) => void;
  timings?: Partial<MegolmTimings>;
}

type InboundSession = InstanceType<Wasm["InboundGroupSession"]>;

interface CachedInbound {
  record: InboundRecord;
  session: InboundSession;
}

/** A Megolm session in the form that a forward and the key backup use. */
export interface ExportedSession {
  channelId: string;
  sessionId: string;
  /** Exported at the first known index. */
  sessionKey: string;
  senderUserId: string;
  senderDeviceId: string;
  senderEd25519: string;
  signature: string;
}

interface PendingRequest {
  channelId: string;
  senderUserId: string;
  senderDeviceId: string;
  attempt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Megolm text is standard base64 without padding. The wire uses base64url. */
function wireBytes(text: string): Uint8Array {
  return decodeBase64Url(text.replace(/\+/g, "-").replace(/\//g, "_"));
}

function standardBase64(wire: string): string {
  return wire.replace(/-/g, "+").replace(/_/g, "/");
}

function deviceKey(device: DeviceRef): string {
  return `${device.userId}:${device.deviceId}`;
}

function refOf(device: DeviceRef): DeviceRef {
  return { userId: device.userId, deviceId: device.deviceId };
}

function strings(content: Record<string, unknown>, names: string[]): Record<string, string> | null {
  const result: Record<string, string> = {};
  for (const name of names) {
    const value = content[name];
    if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
      return null;
    }
    result[name] = value;
  }
  return result;
}

export class MegolmMachine {
  private readonly timings: MegolmTimings;
  private readonly cache = new Map<string, CachedInbound>();
  private readonly keyListeners = new Set<(channelId: string, sessionId: string) => void>();
  private readonly background = new Set<Promise<void>>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly pending = new Map<string, PendingRequest>();
  /** Key requests with no answer after the last try. `restartRequests` tries them again. */
  private readonly unanswered = new Map<string, PendingRequest>();
  private readonly shareFailures = new Map<string, number>();
  private readonly answered = new Map<string, number>();
  private readonly forwarded = new Map<string, number>();
  private readonly membershipChecks = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly snapshotChecks = new Set<string>();
  private stopped = false;

  constructor(private readonly deps: MegolmDeps) {
    this.timings = { ...DEFAULT_TIMINGS, ...deps.timings };
  }

  /** Watch the arrival of new or better inbound keys. Returns a function that stops the watch. */
  onKeys(listener: (channelId: string, sessionId: string) => void): () => void {
    this.keyListeners.add(listener);
    return () => {
      this.keyListeners.delete(listener);
    };
  }

  /** True when this device has an inbound key for this session. */
  async hasSession(sessionId: string): Promise<boolean> {
    return (await this.deps.store.getInbound(sessionId)) !== undefined;
  }

  /** Wait for background work (key shares, requests, history). For tests. */
  async whenIdle(): Promise<void> {
    while (this.background.size > 0) {
      await Promise.all([...this.background]);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    for (const entry of this.pending.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
    }
    this.pending.clear();
    for (const timer of this.membershipChecks.values()) {
      clearTimeout(timer);
    }
    this.membershipChecks.clear();
    for (const entry of this.cache.values()) {
      entry.session.free();
    }
    this.cache.clear();
  }

  // ---- send -------------------------------------------------------------------

  /**
   * Encrypt one payload for a channel. Before the first use of a session,
   * and each time a new device may read the channel, it shares the key.
   */
  async encrypt(channelId: string, payload: DecryptedPayload): Promise<{ sessionId: string; ciphertext: Uint8Array }> {
    const plaintext = encodePlainPayload(payload);
    return this.deps.queue.run(`megolm-out:${channelId}`, async () => {
      const { guildId, userIds } = await this.deps.membership.eligible(channelId);
      const devicesByUser = await this.deps.deviceList.trustedDevicesOfUsers(userIds);
      let record = await this.deps.store.getOutbound(channelId);
      const reason = record ? this.rotationReason(record, devicesByUser) : null;
      if (reason) {
        this.log(`A new Megolm session starts for channel ${channelId}, because ${reason}.`);
        record = undefined;
      }
      record ??= await this.newOutbound(channelId, guildId);
      record = await this.share(record, devicesByUser);

      const { wasm, pickleKey } = this.deps;
      const group = wasm.GroupSession.from_pickle(record.pickle, pickleKey);
      try {
        const text = group.encrypt(plaintext);
        await this.deps.store.putOutbound({ ...record, pickle: group.pickle(pickleKey), messageCount: record.messageCount + 1 });
        return { sessionId: record.sessionId, ciphertext: wireBytes(text) };
      } finally {
        group.free();
      }
    });
  }

  private rotationReason(record: OutboundRecord, devicesByUser: Map<string, DeviceRecord[]>): string | null {
    if (record.messageCount >= MAX_MESSAGES_PER_SESSION) {
      return "the session encrypted 100 messages";
    }
    if (this.now() - record.createdAt >= MAX_SESSION_AGE_MS) {
      return "the session is 7 days old";
    }
    if (record.rotate) {
      return "a membership event can have removed a reader";
    }
    for (const key of record.seenDevices) {
      const split = key.indexOf(":");
      const devices = devicesByUser.get(key.slice(0, split));
      if (!devices) {
        return "a user cannot read the channel now";
      }
      if (!devices.some((device) => device.deviceId === key.slice(split + 1))) {
        return "a device was removed";
      }
    }
    return null;
  }

  /** Mark the outbound sessions in the scope, so that the next send starts a new session. */
  private async markRotation(scope: MembershipScope): Promise<void> {
    for (const record of await this.deps.store.allOutbound()) {
      const hit =
        scope === "all" ||
        ("channelId" in scope ? record.channelId === scope.channelId : record.guildId === scope.guildId);
      if (!hit) {
        continue;
      }
      // In the queue of the channel: a send that is in progress can have made a new session.
      await this.deps.queue.run(`megolm-out:${record.channelId}`, async () => {
        const current = await this.deps.store.getOutbound(record.channelId);
        if (current && !current.rotate) {
          await this.deps.store.putOutbound({ ...current, rotate: true });
        }
      });
    }
  }

  private async newOutbound(channelId: string, guildId: string | null): Promise<OutboundRecord> {
    const { wasm, pickleKey, account, userId, deviceId } = this.deps;
    const group = new wasm.GroupSession();
    try {
      const sessionId = group.session_id;
      const signature = account.sign(megolmSessionSignedText(channelId, sessionId, userId, deviceId));
      const inbound = new wasm.InboundGroupSession(group.session_key);
      try {
        await this.storeInbound({
          sessionId,
          channelId,
          senderUserId: userId,
          senderDeviceId: deviceId,
          senderEd25519: account.ed25519,
          signature,
          pickle: inbound.pickle(pickleKey),
          firstKnownIndex: inbound.first_known_index,
          indexes: {},
          forwarded: false,
        });
      } finally {
        inbound.free();
      }
      const record: OutboundRecord = {
        channelId,
        sessionId,
        pickle: group.pickle(pickleKey),
        signature,
        createdAt: this.now(),
        messageCount: 0,
        sharedWith: [],
        seenDevices: [],
        ...(guildId === null ? {} : { guildId }),
      };
      await this.deps.store.putOutbound(record);
      return record;
    } finally {
      group.free();
    }
  }

  /** Share the session key, from its current index, with each device that may read the channel and has no key yet. */
  private async share(record: OutboundRecord, devicesByUser: Map<string, DeviceRecord[]>): Promise<OutboundRecord> {
    const shared = new Set(record.sharedWith);
    const seen = new Set(record.seenDevices);
    const now = this.now();
    const targets: DeviceRef[] = [];
    for (const devices of devicesByUser.values()) {
      for (const device of devices) {
        const key = deviceKey(device);
        seen.add(key);
        const failedAt = this.shareFailures.get(`${record.sessionId}:${key}`);
        if (shared.has(key) || this.isSelf(device) || (failedAt !== undefined && now - failedAt < SHARE_RETRY_MS)) {
          continue;
        }
        targets.push(refOf(device));
      }
    }
    if (seen.size !== record.seenDevices.length) {
      record = { ...record, seenDevices: [...seen] };
      await this.deps.store.putOutbound(record);
    }
    if (targets.length === 0) {
      return record;
    }
    const { wasm, pickleKey } = this.deps;
    const group = wasm.GroupSession.from_pickle(record.pickle, pickleKey);
    let sessionKey: string;
    try {
      sessionKey = group.session_key;
    } finally {
      group.free();
    }
    const result = await this.deps.olm.encryptToDevices(targets, SESSION_TYPE, {
      channelId: record.channelId,
      sessionId: record.sessionId,
      sessionKey,
      signature: record.signature,
    });
    for (const [key, time] of this.shareFailures) {
      if (now - time >= SHARE_RETRY_MS) {
        this.shareFailures.delete(key);
      }
    }
    for (const failed of result.failed) {
      this.log(`The Megolm key could not be shared with device ${failed.deviceId}.`);
      this.shareFailures.set(`${record.sessionId}:${deviceKey(failed)}`, now);
    }
    const next = { ...record, sharedWith: [...record.sharedWith, ...result.sent.map(deviceKey)] };
    await this.deps.store.putOutbound(next);
    return next;
  }

  // ---- receive -------------------------------------------------------------------

  /** Decrypt one event. It never throws. A missing key starts a key request. */
  async decrypt(event: EventJson): Promise<MegolmDecodeResult> {
    if (event.redactedAt) {
      return { ok: false, reason: "This message was deleted." };
    }
    const sessionId = event.megolmSessionId;
    if (event.codec !== "megolm-v1" || !sessionId) {
      return { ok: false, reason: CANNOT_READ_TEXT };
    }
    try {
      return await this.deps.queue.run(`megolm-in:${sessionId}`, () => this.decryptInQueue(event, sessionId));
    } catch (error) {
      this.log(`An event could not be decrypted: ${String(error)}`);
      return { ok: false, reason: CANNOT_READ_TEXT };
    }
  }

  private async decryptInQueue(event: EventJson, sessionId: string): Promise<MegolmDecodeResult> {
    const entry = await this.loadInbound(sessionId);
    if (!entry) {
      this.requestKey(event, sessionId);
      return { ok: false, reason: WAITING_TEXT, waiting: true };
    }
    const { record } = entry;
    if (
      record.channelId !== event.channelId ||
      record.senderUserId !== event.senderId ||
      record.senderDeviceId !== event.senderDeviceId
    ) {
      this.log(`Event ${event.id} names a sender or a channel that is not the owner of its Megolm session.`);
      return { ok: false, reason: CANNOT_READ_TEXT };
    }

    // Decrypt before the next await: the memory cache can free a session while this task waits.
    let plaintext: Uint8Array;
    let index: number;
    try {
      const decrypted = entry.session.decrypt(standardBase64(event.ciphertext));
      plaintext = decrypted.plaintext;
      index = decrypted.message_index;
      decrypted.free();
    } catch {
      if (record.firstKnownIndex > 0) {
        // The message can be older than the part of the session that this device has.
        this.requestKey(event, sessionId);
        return { ok: false, reason: WAITING_TEXT, waiting: true };
      }
      return { ok: false, reason: CANNOT_READ_TEXT };
    }

    // When the device is still in the device list, its key must be the key that the session came with.
    const known = (await this.deps.store.getDevices(event.senderId)).find((device) => device.deviceId === event.senderDeviceId);
    if (known && known.ed25519 !== record.senderEd25519) {
      this.log(`The sender device of event ${event.id} has different keys now.`);
      return { ok: false, reason: CANNOT_READ_TEXT };
    }

    const seen = record.indexes[String(index)];
    if (seen !== undefined && seen !== event.id) {
      this.log(`Event ${event.id} uses Megolm index ${index}, which event ${seen} used first. It is a replay.`);
      return { ok: false, reason: CANNOT_READ_TEXT };
    }
    if (seen === undefined) {
      entry.record = { ...record, indexes: { ...record.indexes, [String(index)]: event.id } };
      await this.deps.store.putInbound(entry.record);
    }
    try {
      return { ok: true, payload: decodePlainPayload(plaintext) };
    } catch {
      return { ok: false, reason: CANNOT_READ_TEXT };
    }
  }

  /** Handle one decrypted to-device envelope. It throws only a temporary error, so the caller can try again. */
  async handleToDevice(event: DecryptedToDevice): Promise<void> {
    try {
      if (event.type === SESSION_TYPE) {
        await this.receiveSession(event);
      } else if (event.type === FORWARD_TYPE) {
        await this.receiveForward(event);
      } else if (event.type === REQUEST_TYPE) {
        this.track(this.answerRequest(event));
      }
    } catch (error) {
      if (isTemporaryError(error)) {
        throw error;
      }
      this.log(`A Megolm to-device message could not be processed: ${String(error)}`);
    }
  }

  private async receiveSession(event: DecryptedToDevice): Promise<void> {
    const content = strings(event.content, ["channelId", "sessionId", "sessionKey", "signature"]);
    if (!content) {
      return;
    }
    const { sender } = event;
    const text = megolmSessionSignedText(content.channelId!, content.sessionId!, sender.userId, sender.deviceId);
    if (!this.deps.wasm.verify(sender.ed25519, text, content.signature!)) {
      this.log(`A Megolm key from device ${sender.deviceId} has a bad signature.`);
      return;
    }
    await this.importSession(content, () => new this.deps.wasm.InboundGroupSession(content.sessionKey!), {
      senderUserId: sender.userId,
      senderDeviceId: sender.deviceId,
      senderEd25519: sender.ed25519,
      forwarded: false,
    });
  }

  private async receiveForward(event: DecryptedToDevice): Promise<void> {
    await this.importExported(event.content, `device ${event.sender.deviceId}`);
  }

  /**
   * Import a session from the key backup. It gets the same checks as a
   * forward. `backupVersion` marks it as in that backup already. It never
   * throws. Returns true when the session was valid.
   */
  async importBackedUpSession(content: Record<string, unknown>, backupVersion: number): Promise<boolean> {
    try {
      return await this.importExported(content, "the key backup", backupVersion);
    } catch (error) {
      this.log(`A session from the key backup could not be imported: ${String(error)}`);
      return false;
    }
  }

  /** Check and import an exported session (a forward or a backup copy). Returns true when it is valid. */
  private async importExported(raw: Record<string, unknown>, source: string, backupVersion?: number): Promise<boolean> {
    const content = strings(raw, [
      "channelId",
      "sessionId",
      "sessionKey",
      "senderUserId",
      "senderDeviceId",
      "senderEd25519",
      "signature",
    ]);
    if (!content) {
      return false;
    }
    const original = await this.deps.deviceList.getDevice(content.senderUserId!, content.senderDeviceId!);
    // When the sender device is known, its verified key must be the key in the forward.
    if (original && original.ed25519 !== content.senderEd25519) {
      this.log(`A Megolm key from ${source} names a wrong key for device ${content.senderDeviceId}.`);
      return false;
    }
    const text = megolmSessionSignedText(content.channelId!, content.sessionId!, content.senderUserId!, content.senderDeviceId!);
    if (!this.deps.wasm.verify(content.senderEd25519!, text, content.signature!)) {
      this.log(`A Megolm key from ${source} has a bad signature.`);
      return false;
    }
    return this.importSession(
      content,
      () => this.deps.wasm.InboundGroupSession.import(content.sessionKey!),
      {
        senderUserId: content.senderUserId!,
        senderDeviceId: content.senderDeviceId!,
        senderEd25519: content.senderEd25519!,
        forwarded: true,
      },
      backupVersion,
    );
  }

  private async importSession(
    content: Record<string, string>,
    make: () => InboundSession,
    sender: Pick<InboundRecord, "senderUserId" | "senderDeviceId" | "senderEd25519" | "forwarded">,
    backupVersion?: number,
  ): Promise<boolean> {
    let session: InboundSession;
    try {
      session = make();
    } catch {
      this.log("A Megolm key is not valid.");
      return false;
    }
    try {
      if (session.session_id !== content.sessionId) {
        this.log("A Megolm key does not match its session id.");
        return false;
      }
      await this.storeInbound({
        sessionId: content.sessionId,
        channelId: content.channelId!,
        ...sender,
        signature: content.signature!,
        pickle: session.pickle(this.deps.pickleKey),
        firstKnownIndex: session.first_known_index,
        indexes: {},
        ...(backupVersion === undefined ? {} : { backupVersion }),
      });
      return true;
    } finally {
      session.free();
    }
  }

  /**
   * Save an inbound session, or improve a known one with an earlier first
   * index. The first sender that a session id arrives with owns it: a
   * different sender for the same id is rejected.
   */
  private async storeInbound(candidate: InboundRecord): Promise<void> {
    const saved = await this.deps.queue.run(`megolm-in:${candidate.sessionId}`, async () => {
      const existing = (await this.loadInbound(candidate.sessionId))?.record;
      let next = candidate;
      if (existing) {
        if (
          existing.channelId !== candidate.channelId ||
          existing.senderUserId !== candidate.senderUserId ||
          existing.senderDeviceId !== candidate.senderDeviceId ||
          existing.senderEd25519 !== candidate.senderEd25519
        ) {
          this.log(`A Megolm key names a different sender or channel for session ${candidate.sessionId}.`);
          return false;
        }
        if (existing.firstKnownIndex <= candidate.firstKnownIndex) {
          return false;
        }
        // The new copy has an earlier first index. The backup gets it again, unless it came from the backup.
        next = { ...candidate, indexes: existing.indexes, forwarded: existing.forwarded && candidate.forwarded };
      }
      await this.deps.store.putInbound(next);
      this.dropCached(next.sessionId);
      return true;
    });
    if (!saved) {
      return;
    }
    const pending = this.pending.get(candidate.sessionId);
    if (pending) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      this.pending.delete(candidate.sessionId);
    }
    this.ensureSnapshot(candidate.channelId);
    for (const listener of this.keyListeners) {
      try {
        listener(candidate.channelId, candidate.sessionId);
      } catch (error) {
        this.log(`A key listener failed: ${String(error)}`);
      }
    }
  }

  /** The inbound session from the memory cache or the store. Run it in the queue of the session. */
  private async loadInbound(sessionId: string): Promise<CachedInbound | null> {
    const cached = this.cache.get(sessionId);
    if (cached) {
      this.cache.delete(sessionId);
      this.cache.set(sessionId, cached);
      return cached;
    }
    const record = await this.deps.store.getInbound(sessionId);
    if (!record || this.stopped) {
      return null;
    }
    const entry: CachedInbound = {
      record,
      session: this.deps.wasm.InboundGroupSession.from_pickle(record.pickle, this.deps.pickleKey),
    };
    this.cache.set(sessionId, entry);
    while (this.cache.size > MAX_CACHED_INBOUND) {
      const [oldest, value] = this.cache.entries().next().value!;
      value.session.free();
      this.cache.delete(oldest);
    }
    return entry;
  }

  private dropCached(sessionId: string): void {
    const cached = this.cache.get(sessionId);
    if (cached) {
      cached.session.free();
      this.cache.delete(sessionId);
    }
  }

  /** The number of inbound sessions in memory. For tests. */
  cachedSessionCount(): number {
    return this.cache.size;
  }

  // ---- key requests ---------------------------------------------------------------

  private requestKey(event: EventJson, sessionId: string): void {
    if (this.stopped || this.pending.has(sessionId)) {
      return;
    }
    this.unanswered.delete(sessionId);
    const entry: PendingRequest = {
      channelId: event.channelId,
      senderUserId: event.senderId,
      senderDeviceId: event.senderDeviceId,
      attempt: 0,
      timer: null,
    };
    this.pending.set(sessionId, entry);
    this.scheduleRequest(sessionId, entry, this.timings.requestDelaysMs[0] ?? 0);
  }

  private scheduleRequest(sessionId: string, entry: PendingRequest, delay: number): void {
    entry.timer = setTimeout(() => {
      entry.timer = null;
      entry.attempt += 1;
      this.track(
        this.sendRequest(sessionId, entry).finally(() => {
          if (this.pending.get(sessionId) !== entry || this.stopped) {
            return;
          }
          const next = this.timings.requestDelaysMs[entry.attempt];
          if (next === undefined) {
            this.log(`No device sent the key of Megolm session ${sessionId}.`);
            this.pending.delete(sessionId);
            this.unanswered.set(sessionId, entry);
            if (this.unanswered.size > MAX_UNANSWERED) {
              this.unanswered.delete(this.unanswered.keys().next().value!);
            }
            return;
          }
          this.scheduleRequest(sessionId, entry, next);
        }),
      );
    }, delay);
  }

  /** Send the open key requests again now, for example after a new gateway connection. */
  retryRequests(): void {
    for (const [sessionId, entry] of this.pending) {
      if (entry.timer) {
        clearTimeout(entry.timer);
        this.scheduleRequest(sessionId, entry, 0);
      }
    }
  }

  /**
   * Try every key request again from the first attempt, also the ones that
   * got no answer. Call it when this device becomes verified: other devices
   * answer only verified devices.
   */
  restartRequests(): void {
    if (this.stopped) {
      return;
    }
    for (const [sessionId, entry] of this.pending) {
      // A request that is on its way now goes again when it ends (the first delay).
      entry.attempt = 0;
      if (entry.timer) {
        clearTimeout(entry.timer);
        this.scheduleRequest(sessionId, entry, 0);
      }
    }
    for (const [sessionId, entry] of this.unanswered) {
      entry.attempt = 0;
      this.pending.set(sessionId, entry);
      this.scheduleRequest(sessionId, entry, 0);
    }
    this.unanswered.clear();
  }

  /** Ask the devices of this user, the devices of the sender and some other readers of the channel. */
  private async sendRequest(sessionId: string, entry: PendingRequest): Promise<void> {
    const { userId } = this.deps;
    let helpers: string[] = [];
    try {
      const { userIds } = await this.deps.membership.eligible(entry.channelId);
      helpers = this.onlineFirst(userIds.filter((id) => id !== userId && id !== entry.senderUserId)).slice(0, REQUEST_HELPER_USERS);
    } catch {
      // Without the member list, ask only this user and the sender.
    }
    const devicesByUser = await this.deps.deviceList.getDevicesOfUsers([userId, entry.senderUserId, ...helpers]);
    const targets = [...devicesByUser.values()].flat().filter((device) => !this.isSelf(device)).map(refOf);
    if (targets.length > 0) {
      await this.deps.olm.encryptToDevices(targets, REQUEST_TYPE, { channelId: entry.channelId, sessionId });
    }
  }

  private async answerRequest(event: DecryptedToDevice): Promise<void> {
    const content = strings(event.content, ["channelId", "sessionId"]);
    if (!content) {
      return;
    }
    const requester = event.sender;
    // Only a device that the master key of its user signed gets keys.
    if (!(await this.deps.deviceList.isTrusted(requester))) {
      this.log(`Device ${requester.deviceId} asked for a key, but its owner did not verify it.`);
      return;
    }
    const key = `${deviceKey(requester)}:${content.sessionId}`;
    const now = this.now();
    if (now - (this.answered.get(key) ?? -Infinity) < ANSWER_INTERVAL_MS) {
      return;
    }
    for (const [old, time] of this.answered) {
      if (now - time >= ANSWER_INTERVAL_MS) {
        this.answered.delete(old);
      }
    }
    this.answered.set(key, now);
    const record = await this.deps.store.getInbound(content.sessionId!);
    if (!record || record.channelId !== content.channelId) {
      return;
    }
    // Answer only when the requester may read the history of the channel now.
    const { userIds } = await this.deps.membership.eligible(record.channelId);
    if (!userIds.includes(requester.userId)) {
      this.log(`Device ${requester.deviceId} asked for a key of a channel that its user cannot read.`);
      return;
    }
    await this.forwardSessions([record], [refOf(requester)]);
  }

  /** One inbound session, exported at its first known index, with that index. Null when this device does not have it. */
  async exportSession(sessionId: string): Promise<{ content: ExportedSession; firstKnownIndex: number } | null> {
    return this.deps.queue.run(`megolm-in:${sessionId}`, async () => {
      const entry = await this.loadInbound(sessionId);
      const sessionKey = entry?.session.export_at(entry.session.first_known_index);
      if (!entry || !sessionKey) {
        return null;
      }
      const { record } = entry;
      return {
        content: {
          channelId: record.channelId,
          sessionId: record.sessionId,
          sessionKey,
          senderUserId: record.senderUserId,
          senderDeviceId: record.senderDeviceId,
          senderEd25519: record.senderEd25519,
          signature: record.signature,
        },
        firstKnownIndex: record.firstKnownIndex,
      };
    });
  }

  /** Send each session, exported at its first known index, to the target devices. */
  private async forwardSessions(records: InboundRecord[], targets: DeviceRef[]): Promise<void> {
    for (const record of records) {
      const exported = await this.exportSession(record.sessionId);
      if (exported) {
        await this.deps.olm.encryptToDevices(targets, FORWARD_TYPE, { ...exported.content });
      }
    }
  }

  // ---- history for new members -----------------------------------------------------

  /**
   * Handle a gateway event that can change who may read channels. When a
   * member can have left (`memberLeft`), or when events can be lost (a new
   * gateway session), the outbound sessions in the scope rotate at once:
   * a different reader can have forwarded the key to that member.
   */
  onMembershipChange(scope: MembershipScope, memberLeft: boolean): void {
    this.deps.membership.invalidate(scope);
    if (this.stopped) {
      return;
    }
    if (memberLeft || scope === "all") {
      this.track(this.markRotation(scope));
    }
    if (scope === "all") {
      return;
    }
    const key = "channelId" in scope ? `channel:${scope.channelId}` : `guild:${scope.guildId}`;
    const existing = this.membershipChecks.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    this.membershipChecks.set(
      key,
      setTimeout(() => {
        this.membershipChecks.delete(key);
        this.track(this.checkNewMembers(scope));
      }, this.timings.membershipDebounceMs),
    );
  }

  /** Make the first snapshot of the readers of a channel, so that a later change shows the new readers. */
  private ensureSnapshot(channelId: string): void {
    if (this.snapshotChecks.has(channelId)) {
      return;
    }
    this.snapshotChecks.add(channelId);
    this.track(
      (async () => {
        try {
          if (await this.deps.store.getSnapshot(channelId)) {
            return;
          }
          const eligible = await this.deps.membership.eligible(channelId);
          await this.deps.store.putSnapshot({ channelId, guildId: eligible.guildId ?? undefined, userIds: eligible.userIds });
        } finally {
          this.snapshotChecks.delete(channelId);
        }
      })(),
    );
  }

  private async checkNewMembers(scope: { guildId: string } | { channelId: string }): Promise<void> {
    const snapshots =
      "channelId" in scope
        ? [await this.deps.store.getSnapshot(scope.channelId)].filter((entry) => entry !== undefined)
        : await this.deps.store.snapshotsForGuild(scope.guildId);
    for (const snapshot of snapshots) {
      let eligible;
      try {
        eligible = await this.deps.membership.eligible(snapshot.channelId);
      } catch {
        continue;
      }
      await this.deps.store.putSnapshot({
        channelId: snapshot.channelId,
        guildId: eligible.guildId ?? undefined,
        userIds: eligible.userIds,
      });
      const now = new Set(eligible.userIds);
      if (snapshot.userIds.some((id) => !now.has(id))) {
        await this.markRotation({ channelId: snapshot.channelId });
      }
      if (!now.has(this.deps.userId)) {
        continue;
      }
      const before = new Set(snapshot.userIds);
      const added = eligible.userIds.filter((id) => !before.has(id));
      if (added.length > 0) {
        await this.planForward(snapshot.channelId, eligible.userIds, added);
      }
    }
  }

  /**
   * Choose if this device sends the history to the new readers. The online
   * devices that could already read the channel are sorted. The first one
   * sends at once. The next BACKUP_FORWARDERS devices send after a random
   * delay, in case the first one is not really online. The others do not send.
   */
  private async planForward(channelId: string, eligibleUserIds: string[], added: string[]): Promise<void> {
    const holders = eligibleUserIds.filter((id) => !added.includes(id) && (id === this.deps.userId || this.isOnline(id)));
    const devicesByUser = await this.deps.deviceList.getDevicesOfUsers(holders);
    const order = [...devicesByUser.values()].flat().map(deviceKey).sort();
    const rank = order.indexOf(deviceKey(this.deps));
    if (rank < 0 || rank > BACKUP_FORWARDERS) {
      return;
    }
    const [lowest, highest] = this.timings.backupForwardDelayMs;
    for (const userId of added) {
      if (rank === 0) {
        this.track(this.forwardHistory(channelId, userId));
        continue;
      }
      const delay = lowest + this.random() * (highest - lowest);
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        this.track(this.forwardHistory(channelId, userId));
      }, delay);
      this.timers.add(timer);
    }
  }

  private async forwardHistory(channelId: string, userId: string): Promise<void> {
    const key = `${channelId}:${userId}`;
    const now = this.now();
    if (now - (this.forwarded.get(key) ?? -Infinity) < FORWARD_INTERVAL_MS) {
      return;
    }
    this.forwarded.set(key, now);
    // Check again at the moment of the send: the user may have lost access since.
    const { userIds } = await this.deps.membership.eligible(channelId);
    if (!userIds.includes(userId)) {
      return;
    }
    const devices = (await this.deps.deviceList.trustedDevicesOfUsers([userId])).get(userId) ?? [];
    const records = await this.deps.store.inboundForChannel(channelId);
    if (devices.length > 0 && records.length > 0) {
      await this.forwardSessions(records, devices.map(refOf));
    }
  }

  // ---- helpers ---------------------------------------------------------------------

  private isSelf(device: DeviceRef): boolean {
    return device.userId === this.deps.userId && device.deviceId === this.deps.deviceId;
  }

  private isOnline(userId: string): boolean {
    return this.deps.isOnline?.(userId) ?? true;
  }

  private onlineFirst(userIds: string[]): string[] {
    const sorted = [...userIds].sort();
    return [...sorted.filter((id) => this.isOnline(id)), ...sorted.filter((id) => !this.isOnline(id))];
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private random(): number {
    return (this.deps.random ?? Math.random)();
  }

  private log(message: string): void {
    this.deps.log?.(message);
  }

  private track(task: Promise<void>): void {
    const tracked = task
      .catch((error: unknown) => this.log(`A Megolm task failed: ${String(error)}`))
      .finally(() => {
        this.background.delete(tracked);
      });
    this.background.add(tracked);
  }
}
