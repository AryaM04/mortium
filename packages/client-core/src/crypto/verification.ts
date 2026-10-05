// SAS verification between two devices: of the same user (a new sign-in),
// or of two users. The messages go as Olm to-device envelopes. Both
// devices show the same 7 emojis only when no one changed the keys on the
// way. Then each device sends a MAC of its device key and of the master
// key of its user. See docs/concepts/olm-megolm.md section 10.
import { encodeBase64Url, type DeviceRef } from "@mortium/shared";
import type { DeviceList } from "./device-list.js";
import type { DeviceManager } from "./device-manager.js";
import type { DecryptedToDevice, EncryptResult } from "./olm-machine.js";
import type { DeviceRecord } from "./store.js";
import type { Wasm } from "./wasm.js";

export const VERIFICATION_REQUEST = "verification.request";
export const VERIFICATION_READY = "verification.ready";
export const VERIFICATION_START = "verification.start";
export const VERIFICATION_KEY = "verification.key";
export const VERIFICATION_MAC = "verification.mac";
export const VERIFICATION_DONE = "verification.done";
export const VERIFICATION_CANCEL = "verification.cancel";

const SAS_METHOD = "sas.v1";
export const VERIFICATION_TIMEOUT_MS = 10 * 60 * 1000;
const TXN_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const MASTER_KEY_ID = "master";
const KEY_LIST_ID = "KEY_IDS";

/** The Matrix SAS emoji table: index 0 to 63. */
export const SAS_EMOJIS: ReadonlyArray<readonly [emoji: string, name: string]> = [
  ["🐶", "Dog"], ["🐱", "Cat"], ["🦁", "Lion"], ["🐎", "Horse"], ["🦄", "Unicorn"], ["🐷", "Pig"],
  ["🐘", "Elephant"], ["🐰", "Rabbit"], ["🐼", "Panda"], ["🐓", "Rooster"], ["🐧", "Penguin"], ["🐢", "Turtle"],
  ["🐟", "Fish"], ["🐙", "Octopus"], ["🦋", "Butterfly"], ["🌷", "Flower"], ["🌳", "Tree"], ["🌵", "Cactus"],
  ["🍄", "Mushroom"], ["🌏", "Globe"], ["🌙", "Moon"], ["☁️", "Cloud"], ["🔥", "Fire"], ["🍌", "Banana"],
  ["🍎", "Apple"], ["🍓", "Strawberry"], ["🌽", "Corn"], ["🍕", "Pizza"], ["🎂", "Cake"], ["❤️", "Heart"],
  ["😀", "Smiley"], ["🤖", "Robot"], ["🎩", "Hat"], ["👓", "Glasses"], ["🔧", "Spanner"], ["🎅", "Santa"],
  ["👍", "Thumbs Up"], ["☂️", "Umbrella"], ["⌛", "Hourglass"], ["⏰", "Clock"], ["🎁", "Gift"], ["💡", "Light Bulb"],
  ["📕", "Book"], ["✏️", "Pencil"], ["📎", "Paperclip"], ["✂️", "Scissors"], ["🔒", "Lock"], ["🔑", "Key"],
  ["🔨", "Hammer"], ["☎️", "Telephone"], ["🏁", "Flag"], ["🚂", "Train"], ["🚲", "Bicycle"], ["✈️", "Aeroplane"],
  ["🚀", "Rocket"], ["🏆", "Trophy"], ["⚽", "Ball"], ["🎸", "Guitar"], ["🎺", "Trumpet"], ["🔔", "Bell"],
  ["⚓", "Anchor"], ["🎧", "Headphones"], ["📁", "Folder"], ["📌", "Pin"],
];

/**
 * - `incoming`: a different device asks. The user must accept.
 * - `waiting`: this device waits for the other device.
 * - `emojis`: the user must compare the emojis.
 * - `confirmed`: the user said that they match. This device waits for the other device.
 * - `done` and `cancelled`: the end.
 */
export type VerificationPhase = "incoming" | "waiting" | "emojis" | "confirmed" | "done" | "cancelled";

export interface VerificationView {
  txnId: string;
  otherUserId: string;
  /** Null until a device of the other user accepts. */
  otherDeviceId: string | null;
  /** True for a verification between two devices of this user. */
  ownUser: boolean;
  initiatedByMe: boolean;
  phase: VerificationPhase;
  emojis: Array<{ emoji: string; name: string }> | null;
  /** Why the verification stopped, for the UI. */
  cancelReason: string | null;
  /**
   * For two devices of this user: true when the master key signed the
   * device that was not signed, false when no device could sign it, null
   * until then.
   */
  signed: boolean | null;
}

const CANCEL_TEXT: Record<string, string> = {
  user: "The verification was cancelled.",
  mismatch: "The emojis did not match. Nothing was verified.",
  mac_mismatch: "The keys did not match. Nothing was verified.",
  commitment: "The keys did not match. Nothing was verified.",
  timeout: "The verification took more than 10 minutes. Start it again.",
  busy: "The other device has a different verification in progress.",
  accepted: "A different device accepted the verification.",
  unexpected: "The verification got a message that it did not expect.",
  error: "An error stopped the verification. Start it again.",
  no_master_key: "The other user has no identity key. Nothing was verified.",
};

type SasObject = InstanceType<Wasm["Sas"]>;
type Established = ReturnType<SasObject["diffie_hellman"]>;

interface Flow {
  view: VerificationView;
  /** The devices that got the request. The initiator cancels the others when one accepts. */
  requested: DeviceRef[];
  sas: SasObject | null;
  established: Established | null;
  ourKey: string | null;
  theirKey: string | null;
  /** The commitment of the initiator to its key, as the responder got it. */
  commitment: string | null;
  theirMac: { keys: Record<string, string>; keyIds: string } | null;
  macSent: boolean;
  macChecked: boolean;
  /** True after this device checked the MAC of the other device and did its part. */
  finished: boolean;
  /** True after the other device sent `verification.done`. */
  theirDone: boolean;
  timer: ReturnType<typeof setTimeout>;
}

export interface VerificationDeps {
  wasm: Wasm;
  deviceList: DeviceList;
  manager: DeviceManager;
  encryptToDevices(targets: DeviceRef[], type: string, content: Record<string, unknown>): Promise<EncryptResult>;
  userId: string;
  deviceId: string;
  ed25519: string;
  log?: (message: string) => void;
  timeoutMs?: number;
}

function str(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return encodeBase64Url(new Uint8Array(digest));
}

export class VerificationMachine {
  private readonly flows = new Map<string, Flow>();
  private readonly listeners = new Set<() => void>();
  private stopped = false;

  constructor(private readonly deps: VerificationDeps) {}

  list(): VerificationView[] {
    return [...this.flows.values()].map((flow) => ({ ...flow.view }));
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  stop(): void {
    this.stopped = true;
    for (const flow of this.flows.values()) {
      this.release(flow);
    }
    this.flows.clear();
  }

  /** Remove a finished verification from the list. */
  dismiss(txnId: string): void {
    const flow = this.flows.get(txnId);
    if (flow && (flow.view.phase === "done" || flow.view.phase === "cancelled")) {
      this.release(flow);
      this.flows.delete(txnId);
      this.changed();
    }
  }

  // ---- start -------------------------------------------------------------------

  /** Ask the other devices of this user (or one of them) to verify this device. Returns the transaction id. */
  async requestOwnDevices(deviceId?: string): Promise<string> {
    const devices = (await this.deps.deviceList.getDevices(this.deps.userId)).filter(
      (device) => device.deviceId !== this.deps.deviceId && (deviceId === undefined || device.deviceId === deviceId),
    );
    if (devices.length === 0) {
      throw new Error("There is no other device to verify with.");
    }
    return this.request(this.deps.userId, devices);
  }

  /** Ask the devices of a different user to verify their identity with this device. */
  async requestUser(userId: string): Promise<string> {
    if (userId === this.deps.userId) {
      return this.requestOwnDevices();
    }
    const devices = await this.deps.deviceList.getDevices(userId);
    if (devices.length === 0) {
      throw new Error("This user has no device with encryption keys.");
    }
    return this.request(userId, devices);
  }

  private async request(otherUserId: string, devices: DeviceRecord[]): Promise<string> {
    if (this.activeWith(otherUserId, devices.length === 1 ? devices[0]!.deviceId : null)) {
      throw new Error("A verification with this user is in progress. Finish or cancel it first.");
    }
    const txnId = encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)));
    const requested = devices.map((device) => ({ userId: device.userId, deviceId: device.deviceId }));
    this.add(txnId, {
      otherUserId,
      otherDeviceId: null,
      initiatedByMe: true,
      phase: "waiting",
      requested,
    });
    const result = await this.deps.encryptToDevices(requested, VERIFICATION_REQUEST, { txnId, methods: [SAS_METHOD] });
    if (result.sent.length === 0) {
      this.cancelLocal(txnId, "The request could not reach any device.");
    }
    return txnId;
  }

  /** Accept an incoming request. */
  async accept(txnId: string): Promise<void> {
    const flow = this.flows.get(txnId);
    if (!flow || flow.view.phase !== "incoming") {
      return;
    }
    this.setPhase(flow, "waiting");
    await this.send(flow, VERIFICATION_READY, {});
  }

  /** The user compared the emojis. `match` false cancels the verification. */
  async confirm(txnId: string, match: boolean): Promise<void> {
    const flow = this.flows.get(txnId);
    if (!flow || flow.view.phase !== "emojis") {
      return;
    }
    if (!match) {
      await this.cancel(txnId, "mismatch");
      return;
    }
    this.setPhase(flow, "confirmed");
    try {
      await this.sendMac(flow);
      await this.checkMac(flow);
    } catch (error) {
      // A new try is not possible, because the MAC is sent or checked one time only.
      this.log(`The verification could not be confirmed: ${String(error)}`);
      await this.cancel(txnId, "error");
    }
  }

  /** Stop a verification and tell the other device. */
  async cancel(txnId: string, code = "user"): Promise<void> {
    const flow = this.flows.get(txnId);
    if (!flow || flow.view.phase === "done" || flow.view.phase === "cancelled") {
      return;
    }
    const targets = flow.view.otherDeviceId ? [this.other(flow)!] : flow.requested;
    this.cancelLocal(txnId, CANCEL_TEXT[code] ?? CANCEL_TEXT.user!);
    await this.deps.encryptToDevices(targets, VERIFICATION_CANCEL, { txnId, code }).catch(() => undefined);
  }

  // ---- receive -----------------------------------------------------------------

  /** Handle one to-device envelope. It never throws. */
  async handleToDevice(event: DecryptedToDevice): Promise<void> {
    if (!event.type.startsWith("verification.") || this.stopped) {
      return;
    }
    const txnId = event.content.txnId;
    if (typeof txnId !== "string" || !TXN_ID_PATTERN.test(txnId)) {
      return;
    }
    try {
      if (event.type === VERIFICATION_REQUEST) {
        await this.onRequest(txnId, event);
        return;
      }
      const flow = this.flows.get(txnId);
      if (!flow || !this.fromOther(flow, event.sender)) {
        return;
      }
      switch (event.type) {
        case VERIFICATION_READY:
          await this.onReady(flow, event.sender);
          break;
        case VERIFICATION_START:
          await this.onStart(flow, event.content);
          break;
        case VERIFICATION_KEY:
          await this.onKey(flow, event.content);
          break;
        case VERIFICATION_MAC:
          await this.onMac(flow, event.content);
          break;
        case VERIFICATION_DONE:
          await this.onDone(flow);
          break;
        case VERIFICATION_CANCEL:
          this.onCancel(flow, event.sender, event.content);
          break;
        default:
          break;
      }
    } catch (error) {
      this.log(`A verification message could not be processed: ${String(error)}`);
      await this.cancel(txnId, "error");
    }
  }

  private async onRequest(txnId: string, event: DecryptedToDevice): Promise<void> {
    const sender = event.sender;
    const methods = event.content.methods;
    if (this.flows.has(txnId) || !Array.isArray(methods) || !methods.includes(SAS_METHOD)) {
      return;
    }
    if (this.activeWith(sender.userId, sender.deviceId)) {
      await this.deps.encryptToDevices([sender], VERIFICATION_CANCEL, { txnId, code: "busy" }).catch(() => undefined);
      return;
    }
    this.add(txnId, {
      otherUserId: sender.userId,
      otherDeviceId: sender.deviceId,
      initiatedByMe: false,
      phase: "incoming",
      requested: [{ userId: sender.userId, deviceId: sender.deviceId }],
    });
  }

  private async onReady(flow: Flow, sender: DeviceRecord): Promise<void> {
    if (!flow.view.initiatedByMe || flow.view.phase !== "waiting") {
      return;
    }
    if (flow.view.otherDeviceId !== null) {
      if (flow.view.otherDeviceId !== sender.deviceId) {
        await this.deps.encryptToDevices([sender], VERIFICATION_CANCEL, { txnId: flow.view.txnId, code: "accepted" });
      }
      return;
    }
    flow.view.otherDeviceId = sender.deviceId;
    this.changed();
    const others = flow.requested.filter((device) => device.deviceId !== sender.deviceId || device.userId !== sender.userId);
    if (others.length > 0) {
      await this.deps.encryptToDevices(others, VERIFICATION_CANCEL, { txnId: flow.view.txnId, code: "accepted" });
    }
    flow.sas = new this.deps.wasm.Sas();
    flow.ourKey = flow.sas.public_key;
    await this.send(flow, VERIFICATION_START, { method: SAS_METHOD, commitment: await sha256(`${flow.ourKey}|${flow.view.txnId}`) });
  }

  private async onStart(flow: Flow, content: Record<string, unknown>): Promise<void> {
    if (flow.view.initiatedByMe || flow.view.phase !== "waiting" || flow.sas || !str(content.commitment)) {
      return;
    }
    flow.commitment = content.commitment;
    flow.sas = new this.deps.wasm.Sas();
    flow.ourKey = flow.sas.public_key;
    await this.send(flow, VERIFICATION_KEY, { key: flow.ourKey });
  }

  private async onKey(flow: Flow, content: Record<string, unknown>): Promise<void> {
    if (!flow.sas || flow.theirKey !== null || !str(content.key)) {
      return;
    }
    flow.theirKey = content.key;
    if (flow.view.initiatedByMe) {
      // The responder showed its key. Now the initiator shows its key, which it committed to before.
      await this.send(flow, VERIFICATION_KEY, { key: flow.ourKey });
    } else if ((await sha256(`${flow.theirKey}|${flow.view.txnId}`)) !== flow.commitment) {
      await this.cancel(flow.view.txnId, "commitment");
      return;
    }
    flow.established = flow.sas.diffie_hellman(flow.theirKey);
    flow.sas.free();
    flow.sas = null;
    const indexes = flow.established.emoji_indices(this.emojiInfo(flow));
    flow.view.emojis = Array.from(indexes, (index) => {
      const [emoji, name] = SAS_EMOJIS[index]!;
      return { emoji, name };
    });
    this.setPhase(flow, "emojis");
  }

  private async onMac(flow: Flow, content: Record<string, unknown>): Promise<void> {
    const keys = content.keys;
    if (!flow.established || flow.theirMac || !str(content.keyIds) || typeof keys !== "object" || keys === null) {
      return;
    }
    const entries = Object.entries(keys as Record<string, unknown>);
    if (entries.length === 0 || entries.length > 4 || !entries.every(([, value]) => str(value))) {
      await this.cancel(flow.view.txnId, "mac_mismatch");
      return;
    }
    flow.theirMac = { keys: Object.fromEntries(entries) as Record<string, string>, keyIds: content.keyIds };
    await this.checkMac(flow);
  }

  private async onDone(flow: Flow): Promise<void> {
    flow.theirDone = true;
    await this.updateSigned(flow);
  }

  private onCancel(flow: Flow, sender: DeviceRecord, content: Record<string, unknown>): void {
    // Before a device accepts, a cancel from one of the requested devices only removes that device.
    if (flow.view.initiatedByMe && flow.view.otherDeviceId === null) {
      flow.requested = flow.requested.filter((device) => device.deviceId !== sender.deviceId);
      if (flow.requested.length > 0) {
        return;
      }
    }
    const code = typeof content.code === "string" ? content.code : "user";
    this.cancelLocal(flow.view.txnId, CANCEL_TEXT[code] ?? CANCEL_TEXT.user!);
  }

  // ---- MAC ---------------------------------------------------------------------

  private async sendMac(flow: Flow): Promise<void> {
    if (flow.macSent || !flow.established) {
      return;
    }
    flow.macSent = true;
    const own = await this.deps.deviceList.getUser(this.deps.userId);
    const keys: Record<string, string> = {};
    const values: Record<string, string> = { [`ed25519:${this.deps.deviceId}`]: this.deps.ed25519 };
    if (own?.masterKey && own.changedMasterKey === null) {
      values[MASTER_KEY_ID] = own.masterKey;
    }
    for (const [keyId, value] of Object.entries(values)) {
      keys[keyId] = flow.established.calculate_mac(value, this.macInfo(flow, true, keyId));
    }
    const keyIds = flow.established.calculate_mac(Object.keys(values).sort().join(","), this.macInfo(flow, true, KEY_LIST_ID));
    await this.send(flow, VERIFICATION_MAC, { keys, keyIds });
  }

  /** When both sides sent their MAC and the user confirmed, check the MAC of the other device and finish. */
  private async checkMac(flow: Flow): Promise<void> {
    if (flow.view.phase !== "confirmed" || !flow.theirMac || !flow.established || flow.macChecked) {
      return;
    }
    // Check one time only: `confirm` and the MAC of the other device can both call this.
    flow.macChecked = true;
    const established = flow.established;
    const { keys, keyIds } = flow.theirMac;
    const other = this.other(flow)!;
    const device = await this.deps.deviceList.getDevice(other.userId, other.deviceId);
    const user = await this.deps.deviceList.getUser(other.userId);
    const ids = Object.keys(keys).sort();
    const deviceKeyId = `ed25519:${other.deviceId}`;
    const listOk = established.verify_mac(ids.join(","), this.macInfo(flow, false, KEY_LIST_ID), keyIds);
    const deviceOk =
      device !== undefined &&
      keys[deviceKeyId] !== undefined &&
      established.verify_mac(device.ed25519, this.macInfo(flow, false, deviceKeyId), keys[deviceKeyId]!);
    const unknownIds = ids.filter((id) => id !== deviceKeyId && id !== MASTER_KEY_ID);
    let master: string | null = null;
    if (keys[MASTER_KEY_ID]) {
      for (const candidate of [user?.masterKey, user?.changedMasterKey]) {
        if (candidate && established.verify_mac(candidate, this.macInfo(flow, false, MASTER_KEY_ID), keys[MASTER_KEY_ID])) {
          master = candidate;
        }
      }
      if (master === null) {
        await this.cancel(flow.view.txnId, "mac_mismatch");
        return;
      }
    }
    if (!listOk || !deviceOk || unknownIds.length > 0) {
      await this.cancel(flow.view.txnId, "mac_mismatch");
      return;
    }
    if (!flow.view.ownUser && master === null) {
      await this.cancel(flow.view.txnId, "no_master_key");
      return;
    }
    await this.finish(flow, master);
  }

  private async finish(flow: Flow, master: string | null): Promise<void> {
    const { deviceList, manager, userId } = this.deps;
    const other = this.other(flow)!;
    if (master !== null) {
      await deviceList.markMasterKeyVerified(other.userId, master);
    }
    let otherSigned: boolean | null = null;
    if (flow.view.ownUser) {
      const device = (await deviceList.getDevices(userId)).find((entry) => entry.deviceId === other.deviceId);
      // The device that holds the master key signs the other device when it is not signed.
      otherSigned = Boolean(device?.ownerVerified) || (await manager.signOwnDevice(other.deviceId));
    }
    flow.finished = true;
    this.setPhase(flow, "done");
    await this.send(flow, VERIFICATION_DONE, flow.view.ownUser ? { signed: otherSigned } : {});
    this.release(flow);
    await this.updateSigned(flow);
  }

  /**
   * For two devices of this user: set `signed` when the result is final.
   * It is final when this device did its part, and when this device is
   * signed or the other device sent its `done` (it signs before it sends it).
   */
  private async updateSigned(flow: Flow): Promise<void> {
    if (!flow.view.ownUser || !flow.finished || flow.view.signed !== null) {
      return;
    }
    const { deviceList, userId, deviceId } = this.deps;
    await deviceList.refresh([userId]);
    const devices = await deviceList.getDevices(userId);
    const selfSigned = devices.some((device) => device.deviceId === deviceId && device.ownerVerified);
    if (!selfSigned && !flow.theirDone) {
      return;
    }
    const otherSigned = devices.some((device) => device.deviceId === flow.view.otherDeviceId && device.ownerVerified);
    flow.view.signed = selfSigned && otherSigned;
    this.changed();
  }

  // ---- helpers -----------------------------------------------------------------

  private add(
    txnId: string,
    init: Pick<VerificationView, "otherUserId" | "otherDeviceId" | "initiatedByMe" | "phase"> & { requested: DeviceRef[] },
  ): void {
    const timer = setTimeout(() => {
      void this.cancel(txnId, "timeout");
    }, this.deps.timeoutMs ?? VERIFICATION_TIMEOUT_MS);
    this.flows.set(txnId, {
      view: {
        txnId,
        otherUserId: init.otherUserId,
        otherDeviceId: init.otherDeviceId,
        ownUser: init.otherUserId === this.deps.userId,
        initiatedByMe: init.initiatedByMe,
        phase: init.phase,
        emojis: null,
        cancelReason: null,
        signed: null,
      },
      requested: init.requested,
      sas: null,
      established: null,
      ourKey: null,
      theirKey: null,
      commitment: null,
      theirMac: null,
      macSent: false,
      macChecked: false,
      finished: false,
      theirDone: false,
      timer,
    });
    this.changed();
  }

  /** True when a verification with this device (or with this user, for a null device) is in progress. */
  private activeWith(userId: string, deviceId: string | null): boolean {
    for (const flow of this.flows.values()) {
      const { view } = flow;
      if (view.otherUserId !== userId || view.phase === "done" || view.phase === "cancelled") {
        continue;
      }
      if (deviceId === null || view.otherDeviceId === null || view.otherDeviceId === deviceId) {
        return true;
      }
    }
    return false;
  }

  private fromOther(flow: Flow, sender: DeviceRecord): boolean {
    if (flow.view.otherDeviceId !== null) {
      return sender.userId === flow.view.otherUserId && sender.deviceId === flow.view.otherDeviceId;
    }
    return flow.requested.some((device) => device.userId === sender.userId && device.deviceId === sender.deviceId);
  }

  private other(flow: Flow): DeviceRef | null {
    return flow.view.otherDeviceId ? { userId: flow.view.otherUserId, deviceId: flow.view.otherDeviceId } : null;
  }

  private async send(flow: Flow, type: string, content: Record<string, unknown>): Promise<void> {
    const other = this.other(flow);
    if (!other) {
      return;
    }
    const result = await this.deps.encryptToDevices([other], type, { txnId: flow.view.txnId, ...content });
    if (result.sent.length === 0 && type !== VERIFICATION_DONE) {
      this.cancelLocal(flow.view.txnId, "The other device could not be reached.");
    }
  }

  private emojiInfo(flow: Flow): string {
    const me = `${this.deps.userId}|${this.deps.deviceId}|${flow.ourKey}`;
    const them = `${flow.view.otherUserId}|${flow.view.otherDeviceId}|${flow.theirKey}`;
    const [first, second] = flow.view.initiatedByMe ? [me, them] : [them, me];
    return `MORTIUM_SAS_EMOJI_V1|${first}|${second}|${flow.view.txnId}`;
  }

  /** The MAC info. `outgoing` is true for the MAC that this device sends. */
  private macInfo(flow: Flow, outgoing: boolean, keyId: string): string {
    const me = `${this.deps.userId}|${this.deps.deviceId}`;
    const them = `${flow.view.otherUserId}|${flow.view.otherDeviceId}`;
    const [sender, receiver] = outgoing ? [me, them] : [them, me];
    return `MORTIUM_SAS_MAC_V1|${sender}|${receiver}|${flow.view.txnId}|${keyId}`;
  }

  private setPhase(flow: Flow, phase: VerificationPhase): void {
    flow.view.phase = phase;
    this.changed();
  }

  private cancelLocal(txnId: string, reason: string): void {
    const flow = this.flows.get(txnId);
    if (!flow || flow.view.phase === "done" || flow.view.phase === "cancelled") {
      return;
    }
    flow.view.phase = "cancelled";
    flow.view.cancelReason = reason;
    flow.view.emojis = null;
    this.release(flow);
    this.changed();
  }

  /** Free the WASM objects and the timer of a flow that ended. */
  private release(flow: Flow): void {
    clearTimeout(flow.timer);
    flow.sas?.free();
    flow.sas = null;
    flow.established?.free();
    flow.established = null;
  }

  private changed(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private log(message: string): void {
    this.deps.log?.(message);
  }
}
