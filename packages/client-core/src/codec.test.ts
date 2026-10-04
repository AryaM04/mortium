import { describe, expect, it } from "vitest";
import { encodeBase64Url, encodePlainPayload, type EventJson } from "@mortium/shared";
import { decodePlainEvent } from "./codec.js";

function baseEvent(overrides: Partial<EventJson> = {}): EventJson {
  return {
    id: "1",
    channelId: "10",
    senderId: "20",
    senderDeviceId: "device-1",
    relType: null,
    relatesToId: null,
    codec: "plain-v1",
    megolmSessionId: null,
    ciphertext: "",
    nonce: "n1",
    createdAt: new Date().toISOString(),
    redactedAt: null,
    ...overrides,
  };
}

describe("decodePlainEvent", () => {
  it("reads an old plaintext message", () => {
    const payload = { type: "message" as const, body: "hi", mentions: [], attachments: [], embeds: [] };
    const event = baseEvent({ ciphertext: encodeBase64Url(encodePlainPayload(payload)) });
    expect(decodePlainEvent(event)).toEqual({ ok: true, payload });
  });

  it("reports the message was deleted for a redacted event", () => {
    const event = baseEvent({ ciphertext: "", redactedAt: new Date().toISOString() });
    expect(decodePlainEvent(event)).toEqual({ ok: false, reason: "This message was deleted." });
  });

  it("never throws on garbage ciphertext, and reports it cannot be read", () => {
    expect(decodePlainEvent(baseEvent({ ciphertext: "not-json-once-decoded" }))).toEqual({
      ok: false,
      reason: "This message cannot be read.",
    });
  });

  it("never throws on ciphertext that is not valid base64url", () => {
    expect(decodePlainEvent(baseEvent({ ciphertext: "!!!not-base64!!!" }))).toEqual({
      ok: false,
      reason: "This message cannot be read.",
    });
  });

  it("refuses a different codec, without throwing", () => {
    expect(decodePlainEvent(baseEvent({ codec: "megolm-v1" })).ok).toBe(false);
  });
});
