// The Olm machine: it encrypts to-device envelopes for peer devices and
// decrypts the TO_DEVICE messages that reach this device. It makes,
// selects and recovers Olm sessions as docs/concepts/olm-megolm.md
// sections 5 and 6 say. All work on the sessions of one peer device runs
// in one queue.
import {
  MAX_TO_DEVICE_MESSAGES,
  decodeBase64Url,
  encodeBase64Url,
  oneTimeKeySignedText,
  type DeviceRef,
  type ToDeviceDispatchPayload,
  type ToDeviceMessage,
} from "@mortium/shared";
import { ApiError } from "../api.js";
import type { AccountHolder } from "./account.js";
import type { DeviceList } from "./device-list.js";
import { checkBinding, newEnvelopeId, parseEnvelope, type ToDeviceEnvelope } from "./envelope.js";
import type { KeyedQueue } from "./queue.js";
import type { CryptoStore, DeviceRecord, SessionRecord, StoreChanges } from "./store.js";
import type { CryptoTransport } from "./transport.js";
import type { Wasm } from "./wasm.js";

/** The outer message type that the server sees. */
export const OLM_MESSAGE_TYPE = "olm.v1";
const MAX_SESSIONS_PER_PEER = 5;
const MAX_SEEN_IDS = 1000;
const RECOVERY_INTERVAL_MS = 60 * 60 * 1000;
// The Olm message adds a header, padding and a MAC. This keeps the result under 64 KiB.
const MAX_PLAINTEXT_BYTES = 63 * 1024;
const LAST_PROCESSED_VALUE = "lastProcessedId";
const DUMMY_TYPE = "dummy";
const SEEN_IDS_VALUE = "seenIds";
const PROCESSED_IDS_VALUE = "processedIds";
/** The queue ids of the last processed messages that this device keeps, to find copies. */
const MAX_PROCESSED_IDS = 1000;

/** One to-device envelope that decrypted and passed every binding check. */
export interface DecryptedToDevice {
  /** The envelope id. The same id never reaches a handler twice. */
  id: string;
  type: string;
  content: Record<string, unknown>;
  /** The verified device that sent it. */
  sender: DeviceRecord;
}

export type ToDeviceHandler = (event: DecryptedToDevice) => void | Promise<void>;

/** True for an error that can go away on a later try: no network, a rate limit, a server fault or a storage error. */
export function isTemporaryError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status === 0 || error.status === 429 || error.status >= 500;
  }
  return typeof DOMException !== "undefined" && error instanceof DOMException;
}

export interface OlmMachineDeps {
  wasm: Wasm;
  store: CryptoStore;
  transport: CryptoTransport;
  deviceList: DeviceList;
  account: AccountHolder;
  queue: KeyedQueue;
  pickleKey: Uint8Array;
  userId: string;
  deviceId: string;
  /** Called after a pre-key message used up a one-time key. */
  onOneTimeKeyUsed?: () => void;
  now?: () => number;
  log?: (message: string) => void;
}

export interface EncryptResult {
  sent: DeviceRef[];
  failed: DeviceRef[];
}

function activity(record: SessionRecord): number {
  return Math.max(record.createdAt, record.lastReceivedAt);
}

function refOf(device: DeviceRef): DeviceRef {
  return { userId: device.userId, deviceId: device.deviceId };
}

export class OlmMachine {
  private readonly handlers = new Set<ToDeviceHandler>();
  private readonly lastRecovery = new Map<string, number>();
  private readonly background = new Set<Promise<void>>();
  private lastProcessedId: bigint | null = null;
  private processedIds: string[] = [];
  /** A decrypted message whose handlers stopped on a temporary error. The next try runs only the handlers that did not finish. */
  private pending: { queueId: string; event: DecryptedToDevice | null; done: Set<ToDeviceHandler> } | null = null;
  private seenIds: string[] = [];
  private lastTime = 0;

  constructor(private readonly deps: OlmMachineDeps) {}

  /** Watch decrypted envelopes. Returns a function that stops the watch. */
  onToDevice(handler: ToDeviceHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** The highest queue id of a TO_DEVICE message that this device processed, or "0". */
  async lastProcessed(): Promise<string> {
    await this.loadState();
    return (this.lastProcessedId ?? 0n).toString();
  }

  sessionCount(): Promise<number> {
    return this.deps.store.countSessions();
  }

  /** Wait for background work (session recovery). For tests. */
  async whenIdle(): Promise<void> {
    while (this.background.size > 0) {
      await Promise.all([...this.background]);
    }
  }

  /**
   * Encrypt one envelope for each target device and send them. Devices
   * without a session get one from a claimed one-time key. Devices that are
   * unknown, unverified or without keys are in `failed`. With `live`, the
   * messages go over the gateway op with no reply, so every encrypted
   * message counts as sent.
   */
  async encryptToDevices(
    targets: DeviceRef[],
    type: string,
    content: Record<string, unknown>,
    live = false,
  ): Promise<EncryptResult> {
    const failed: DeviceRef[] = [];
    const devices: DeviceRecord[] = [];
    const seen = new Set<string>();
    for (const target of targets) {
      const key = `${target.userId}:${target.deviceId}`;
      if (seen.has(key) || (target.userId === this.deps.userId && target.deviceId === this.deps.deviceId)) {
        continue;
      }
      seen.add(key);
      const device = await this.deps.deviceList.getDevice(target.userId, target.deviceId);
      if (device) {
        devices.push(device);
      } else {
        failed.push(refOf(target));
      }
    }
    return this.send(await this.ensureSessions(devices, false, failed), type, content, failed, live);
  }

  /**
   * Handle one TO_DEVICE dispatch. A message that fails for good is dropped.
   * On a temporary error it throws and does not move the queue position, so
   * the caller can try again. The queue position moves only after the
   * handlers finished. A copy of a processed message is ignored.
   */
  async handleToDevice(event: ToDeviceDispatchPayload): Promise<void> {
    await this.loadState();
    if (this.processedIds.includes(event.id)) {
      return;
    }
    let pending = this.pending?.queueId === event.id ? this.pending : null;
    if (!pending) {
      let decrypted: DecryptedToDevice | null = null;
      try {
        decrypted = await this.decrypt(event);
      } catch (error) {
        if (isTemporaryError(error)) {
          throw error;
        }
        this.log(`A to-device message could not be processed: ${String(error)}`);
      }
      pending = { queueId: event.id, event: decrypted, done: new Set() };
      this.pending = pending;
    }
    // A dummy only moves the peer to a new session. It has no content for handlers.
    if (pending.event && pending.event.type !== DUMMY_TYPE) {
      for (const handler of this.handlers) {
        if (pending.done.has(handler)) {
          continue;
        }
        try {
          await handler(pending.event);
        } catch (error) {
          if (isTemporaryError(error)) {
            throw error;
          }
          this.log(`A to-device handler failed: ${String(error)}`);
        }
        pending.done.add(handler);
      }
    }
    const last = BigInt(event.id) > this.lastProcessedId! ? BigInt(event.id) : this.lastProcessedId!;
    const processedIds = [...this.processedIds, event.id].slice(-MAX_PROCESSED_IDS);
    await this.deps.store.commit({
      values: { [LAST_PROCESSED_VALUE]: last.toString(), [PROCESSED_IDS_VALUE]: processedIds },
    });
    this.lastProcessedId = last;
    this.processedIds = processedIds;
    this.pending = null;
  }

  // ---- sessions -----------------------------------------------------------

  private clock(): number {
    this.lastTime = Math.max((this.deps.now ?? Date.now)(), this.lastTime + 1);
    return this.lastTime;
  }

  private log(message: string): void {
    this.deps.log?.(message);
  }

  private async loadState(): Promise<void> {
    if (this.lastProcessedId !== null) {
      return;
    }
    const stored = await this.deps.store.getValue<string>(LAST_PROCESSED_VALUE);
    this.processedIds = (await this.deps.store.getValue<string[]>(PROCESSED_IDS_VALUE)) ?? [];
    this.lastProcessedId = BigInt(stored ?? "0");
    this.seenIds = (await this.deps.store.getValue<string[]>(SEEN_IDS_VALUE)) ?? [];
  }

  /** The sessions with a peer, the most recently active first. */
  private async sessionsOf(peerKey: string): Promise<SessionRecord[]> {
    const records = await this.deps.store.getSessions(peerKey);
    return records.sort((a, b) => activity(b) - activity(a) || b.createdAt - a.createdAt);
  }

  /** Keys of the sessions to delete so that at most MAX_SESSIONS_PER_PEER stay, with `kept` among them. */
  private trim(existing: SessionRecord[], kept: SessionRecord): Array<[string, string]> {
    const others = existing.filter((record) => record.sessionId !== kept.sessionId);
    return others
      .slice(MAX_SESSIONS_PER_PEER - 1)
      .map((record): [string, string] => [record.peerKey, record.sessionId]);
  }

  /** Make an outbound session for each device that has none (or for each device, with `forceNew`). */
  private async ensureSessions(devices: DeviceRecord[], forceNew: boolean, failed: DeviceRef[]): Promise<DeviceRecord[]> {
    const need: DeviceRecord[] = [];
    for (const device of devices) {
      if (forceNew || (await this.deps.store.getSessions(device.curve25519)).length === 0) {
        need.push(device);
      }
    }
    if (need.length === 0) {
      return devices;
    }

    let claimed: Awaited<ReturnType<CryptoTransport["claimKeys"]>>["keys"] = [];
    try {
      claimed = (await this.deps.transport.claimKeys(need.map(refOf))).keys;
    } catch (error) {
      this.log(`One-time keys could not be claimed: ${String(error)}`);
    }

    const { wasm, pickleKey } = this.deps;
    const unusable = new Set<DeviceRecord>();
    for (const device of need) {
      const key = claimed.find((entry) => entry.userId === device.userId && entry.deviceId === device.deviceId);
      const text = key
        ? oneTimeKeySignedText(key.fallback ? "fallback_key" : "one_time_key", device.userId, device.deviceId, key.keyId, key.key)
        : "";
      if (!key || !wasm.verify(device.ed25519, text, key.signature)) {
        this.log(`No usable one-time key for device ${device.deviceId}.`);
        unusable.add(device);
        continue;
      }
      await this.deps.queue.run(device.curve25519, async () => {
        const existing = await this.sessionsOf(device.curve25519);
        if (!forceNew && existing.length > 0) {
          return;
        }
        const session = this.deps.account.account.create_outbound_session(device.curve25519, key.key);
        try {
          const record: SessionRecord = {
            peerKey: device.curve25519,
            sessionId: session.session_id,
            pickle: session.pickle(pickleKey),
            createdAt: this.clock(),
            lastReceivedAt: 0,
          };
          await this.deps.store.commit({ sessions: [record], deleteSessions: this.trim(existing, record) });
        } finally {
          session.free();
        }
      });
    }
    for (const device of unusable) {
      failed.push(refOf(device));
    }
    return devices.filter((device) => !unusable.has(device));
  }

  private async send(
    devices: DeviceRecord[],
    type: string,
    content: Record<string, unknown>,
    failed: DeviceRef[],
    live = false,
  ): Promise<EncryptResult> {
    const messages: ToDeviceMessage[] = [];
    const encrypted: DeviceRef[] = [];
    for (const device of devices) {
      try {
        messages.push(await this.encryptFor(device, type, content));
        encrypted.push(refOf(device));
      } catch (error) {
        this.log(`A message for device ${device.deviceId} could not be encrypted: ${String(error)}`);
        failed.push(refOf(device));
      }
    }

    const sent: DeviceRef[] = [];
    for (let start = 0; start < messages.length; start += MAX_TO_DEVICE_MESSAGES) {
      const batch = messages.slice(start, start + MAX_TO_DEVICE_MESSAGES);
      const refs = encrypted.slice(start, start + MAX_TO_DEVICE_MESSAGES);
      if (live) {
        this.deps.transport.sendToDeviceLive(batch);
        sent.push(...refs);
        continue;
      }
      try {
        const { skipped } = await this.deps.transport.sendToDevice(batch);
        for (const ref of refs) {
          const lost = skipped.some((entry) => entry.userId === ref.userId && entry.deviceId === ref.deviceId);
          (lost ? failed : sent).push(ref);
        }
      } catch (error) {
        this.log(`To-device messages could not be sent: ${String(error)}`);
        failed.push(...refs);
      }
    }
    return { sent, failed };
  }

  private encryptFor(device: DeviceRecord, type: string, content: Record<string, unknown>): Promise<ToDeviceMessage> {
    const { wasm, pickleKey, account } = this.deps;
    return this.deps.queue.run(device.curve25519, async () => {
      const [record] = await this.sessionsOf(device.curve25519);
      if (!record) {
        throw new Error("There is no session with this device.");
      }
      const envelope: ToDeviceEnvelope = {
        v: 1,
        id: newEnvelopeId(),
        type,
        content,
        sender: { userId: this.deps.userId, deviceId: this.deps.deviceId, ed25519: account.ed25519 },
        recipient: { userId: device.userId, deviceId: device.deviceId, curve25519: device.curve25519 },
        ts: Date.now(),
      };
      const plaintext = new TextEncoder().encode(JSON.stringify(envelope));
      if (plaintext.length > MAX_PLAINTEXT_BYTES) {
        throw new Error("The to-device content is too large.");
      }
      const session = wasm.Session.from_pickle(record.pickle, pickleKey);
      try {
        const message = session.encrypt(plaintext);
        const body = message.ciphertext;
        const bytes = new Uint8Array(body.length + 1);
        bytes[0] = message.message_type;
        bytes.set(body, 1);
        message.free();
        await this.deps.store.commit({ sessions: [{ ...record, pickle: session.pickle(pickleKey) }] });
        return { userId: device.userId, deviceId: device.deviceId, type: OLM_MESSAGE_TYPE, ciphertext: encodeBase64Url(bytes) };
      } finally {
        session.free();
      }
    });
  }

  // ---- receive --------------------------------------------------------------

  private async decrypt(event: ToDeviceDispatchPayload): Promise<DecryptedToDevice | null> {
    if (event.type !== OLM_MESSAGE_TYPE) {
      return null;
    }
    const sender = await this.deps.deviceList.getDevice(event.senderUserId, event.senderDeviceId);
    if (!sender) {
      this.log(`A to-device message came from an unknown device ${event.senderDeviceId}.`);
      return null;
    }
    const bytes = decodeBase64Url(event.ciphertext);
    const messageType = bytes[0];
    const body = bytes.subarray(1);
    if ((messageType !== 0 && messageType !== 1) || body.length === 0) {
      return null;
    }

    const { wasm, pickleKey, account } = this.deps;
    const outcome = await this.deps.queue.run(sender.curve25519, async () => {
      const existing = await this.sessionsOf(sender.curve25519);
      let matched = false;
      for (const record of existing) {
        const session = wasm.Session.from_pickle(record.pickle, pickleKey);
        try {
          if (messageType === 0 && !session.session_matches(0, body)) {
            continue;
          }
          matched = true;
          const plaintext = session.decrypt(messageType, body);
          const updated = { ...record, pickle: session.pickle(pickleKey), lastReceivedAt: this.clock() };
          return this.finish(event, sender, plaintext, updated, existing, {});
        } catch {
          if (messageType === 0) {
            break;
          }
        } finally {
          session.free();
        }
      }
      if (messageType === 1 || matched) {
        return null;
      }
      // A pre-key message of a new session: make the inbound session. The
      // account loses a one-time key, so its pickle goes in the same commit.
      return account.run(async (olmAccount) => {
        let result;
        try {
          result = olmAccount.create_inbound_session(sender.curve25519, 0, body);
        } catch {
          return null;
        }
        const session = result.take_session();
        try {
          const time = this.clock();
          const record: SessionRecord = {
            peerKey: sender.curve25519,
            sessionId: session.session_id,
            pickle: session.pickle(pickleKey),
            createdAt: time,
            lastReceivedAt: time,
          };
          const finished = await this.finish(event, sender, result.plaintext, record, existing, account.pickleValue());
          this.deps.onOneTimeKeyUsed?.();
          return finished;
        } finally {
          session.free();
          result.free();
        }
      });
    });

    if (outcome === null) {
      this.log(`No session could decrypt a message from device ${sender.deviceId}. The session is wedged.`);
      this.recover(sender);
      return null;
    }
    return outcome.event;
  }

  /** Check the envelope and save the Olm state and the seen id in one commit. */
  private async finish(
    event: ToDeviceDispatchPayload,
    sender: DeviceRecord,
    plaintext: Uint8Array,
    session: SessionRecord,
    existing: SessionRecord[],
    extraValues: Record<string, unknown>,
  ): Promise<{ event: DecryptedToDevice | null }> {
    const envelope = parseEnvelope(plaintext);
    let problem = envelope ? null : "the plaintext is not a version 1 envelope";
    if (envelope) {
      problem = checkBinding(envelope, {
        reportedSender: { userId: event.senderUserId, deviceId: event.senderDeviceId },
        senderDevice: sender,
        self: { userId: this.deps.userId, deviceId: this.deps.deviceId, curve25519: this.deps.account.curve25519 },
      });
      if (!problem && this.seenIds.includes(envelope.id)) {
        problem = "the envelope id was already seen";
      }
    }

    const values: Record<string, unknown> = { ...extraValues };
    const accepted = envelope !== null && problem === null;
    const seenIds = accepted ? [...this.seenIds, envelope.id].slice(-MAX_SEEN_IDS) : this.seenIds;
    if (accepted) {
      values[SEEN_IDS_VALUE] = seenIds;
    }
    const changes: StoreChanges = { values, sessions: [session], deleteSessions: this.trim(existing, session) };
    await this.deps.store.commit(changes);
    this.seenIds = seenIds;

    if (!accepted) {
      this.log(`A to-device message was dropped: ${problem}.`);
      return { event: null };
    }
    return { event: { id: envelope.id, type: envelope.type, content: envelope.content, sender } };
  }

  /** Make a new session with a peer and send a dummy envelope on it. At most one time per peer per hour. */
  private recover(device: DeviceRecord): void {
    const now = this.clock();
    const last = this.lastRecovery.get(device.curve25519);
    if (last !== undefined && now - last < RECOVERY_INTERVAL_MS) {
      return;
    }
    this.lastRecovery.set(device.curve25519, now);
    const task = (async () => {
      const failed: DeviceRef[] = [];
      const ready = await this.ensureSessions([device], true, failed);
      await this.send(ready, DUMMY_TYPE, {}, failed);
    })()
      .catch((error: unknown) => this.log(`A wedged session could not be recovered: ${String(error)}`))
      .finally(() => {
        this.background.delete(task);
      });
    this.background.add(task);
  }
}
