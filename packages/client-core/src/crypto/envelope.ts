// The to-device envelope: the versioned JSON inside each Olm message. It
// binds the sender and the recipient into the plaintext, so the server
// cannot send a message to a different device or say that it comes from a
// different device. See docs/concepts/olm-megolm.md section 6.
import { encodeBase64Url } from "@mortium/shared";

export interface EnvelopeParty {
  userId: string;
  deviceId: string;
}

export interface ToDeviceEnvelope {
  v: 1;
  id: string;
  type: string;
  content: Record<string, unknown>;
  sender: EnvelopeParty & { ed25519: string };
  recipient: EnvelopeParty & { curve25519: string };
  ts: number;
}

export function newEnvelopeId(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Parse the plaintext of an Olm message. Returns null when the shape is not a version 1 envelope. */
export function parseEnvelope(plaintext: Uint8Array): ToDeviceEnvelope | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return null;
  }
  if (!isRecord(value) || value.v !== 1 || !isString(value.id) || !isString(value.type) || !isRecord(value.content)) {
    return null;
  }
  const { sender, recipient } = value;
  if (
    !isRecord(sender) ||
    !isString(sender.userId) ||
    !isString(sender.deviceId) ||
    !isString(sender.ed25519) ||
    !isRecord(recipient) ||
    !isString(recipient.userId) ||
    !isString(recipient.deviceId) ||
    !isString(recipient.curve25519) ||
    typeof value.ts !== "number"
  ) {
    return null;
  }
  return value as unknown as ToDeviceEnvelope;
}

export interface BindingCheck {
  /** The sender that the server reported in the TO_DEVICE dispatch. */
  reportedSender: EnvelopeParty;
  /** The verified device whose Curve25519 key made the Olm session. */
  senderDevice: EnvelopeParty & { ed25519: string };
  /** This device. */
  self: EnvelopeParty & { curve25519: string };
}

/** Returns null when the envelope binding holds, or a short reason when it does not. */
export function checkBinding(envelope: ToDeviceEnvelope, check: BindingCheck): string | null {
  const { sender, recipient } = envelope;
  if (sender.userId !== check.reportedSender.userId || sender.deviceId !== check.reportedSender.deviceId) {
    return "the sender in the envelope is not the sender that the server reported";
  }
  if (
    sender.userId !== check.senderDevice.userId ||
    sender.deviceId !== check.senderDevice.deviceId ||
    sender.ed25519 !== check.senderDevice.ed25519
  ) {
    return "the sender keys in the envelope are not the keys of the session device";
  }
  if (
    recipient.userId !== check.self.userId ||
    recipient.deviceId !== check.self.deviceId ||
    recipient.curve25519 !== check.self.curve25519
  ) {
    return "the envelope is for a different device";
  }
  return null;
}
