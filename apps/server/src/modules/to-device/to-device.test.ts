// Integration tests for the to-device queue: live delivery, the offline
// queue, acknowledgements, the window, resync, the sender visibility rule,
// the limits and the queue bound. Real Postgres and a real ws.
import { eq } from "drizzle-orm";
import { GatewayOpcode, encodeBase64Url } from "@mortium/shared";
import { afterAll, beforeAll, expect, it } from "vitest";
import { toDeviceQueue } from "../../db/schema.js";
import { describeWithDb } from "../../../test/db.js";
import { TestDeviceKeys } from "../../../test/keys.js";
import {
  apiFor,
  connectGateway,
  loginNewDevice,
  makeFriends,
  registerUser,
  startTestServer,
  type GatewayClient,
  type TestServer,
  type TestUser,
} from "../../../test/social.js";

let server: TestServer;

function ciphertext(text: string): string {
  return encodeBase64Url(new TextEncoder().encode(text));
}

function message(to: TestUser, text: string) {
  return { userId: to.userId, deviceId: to.deviceId, type: "olm.v1", ciphertext: ciphertext(text) };
}

async function queuedFor(deviceId: string): Promise<number> {
  const rows = await server.testDb.db.select().from(toDeviceQueue).where(eq(toDeviceQueue.recipientDeviceId, deviceId));
  return rows.length;
}

/** Two friends with device keys. */
async function pair(prefix: string): Promise<[TestUser, TestUser]> {
  const sender = await registerUser(server, `${prefix}s`);
  const recipient = await registerUser(server, `${prefix}r`);
  await makeFriends(server, sender, recipient);
  await new TestDeviceKeys(sender).upload(server);
  await new TestDeviceKeys(recipient).upload(server);
  return [sender, recipient];
}

async function collect(client: GatewayClient, count: number): Promise<Array<Record<string, string>>> {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push(await client.event("TO_DEVICE"));
  }
  return out;
}

describeWithDb("to-device queue", () => {
  beforeAll(async () => {
    server = await startTestServer({ toDeviceQueueLimit: 200 });
  });

  afterAll(async () => {
    await server.close();
  });

  it("delivers live to the recipient device only, outside the resume buffer", async () => {
    const [sender, recipient] = await pair("live");
    const otherDevice = await loginNewDevice(server, recipient);
    await new TestDeviceKeys(otherDevice).upload(server);
    const target = await connectGateway(server, recipient);
    const other = await connectGateway(server, otherDevice);

    const result = await apiFor(server, sender).post("/to-device", { messages: [message(recipient, "hello")] });
    expect(result.status).toBe(200);
    expect(result.body.skipped).toEqual([]);

    const envelope = await target.next((env) => env.t === "TO_DEVICE");
    expect(envelope.s).toBeUndefined();
    expect(envelope.d).toMatchObject({
      senderUserId: sender.userId,
      senderDeviceId: sender.deviceId,
      type: "olm.v1",
      ciphertext: ciphertext("hello"),
    });
    expect(await other.never("TO_DEVICE")).toBe(true);

    target.send(GatewayOpcode.TO_DEVICE_ACK, { upToId: (envelope.d as { id: string }).id });
    await expect.poll(() => queuedFor(recipient.deviceId)).toBe(0);
    target.close();
    other.close();
  });

  it("keeps messages for an offline device, sends them in order on IDENTIFY and deletes them on ACK", async () => {
    const [sender, recipient] = await pair("offl");
    await apiFor(server, sender).post("/to-device", {
      messages: [message(recipient, "one"), message(recipient, "two"), message(recipient, "three")],
    });
    expect(await queuedFor(recipient.deviceId)).toBe(3);

    // Without an ACK, a new connection gets the same messages again.
    const first = await connectGateway(server, recipient);
    const firstRound = await collect(first, 3);
    expect(firstRound.map((d) => d.ciphertext)).toEqual([ciphertext("one"), ciphertext("two"), ciphertext("three")]);
    first.close();

    const second = await connectGateway(server, recipient);
    const secondRound = await collect(second, 3);
    expect(secondRound.map((d) => d.id)).toEqual(firstRound.map((d) => d.id));
    second.send(GatewayOpcode.TO_DEVICE_ACK, { upToId: secondRound[1]!.id });
    await expect.poll(() => queuedFor(recipient.deviceId)).toBe(1);

    // A resync sends every message after the id again.
    second.send(GatewayOpcode.TO_DEVICE_ACK, { upToId: secondRound[1]!.id, resync: true });
    expect((await second.event("TO_DEVICE")).id).toBe(secondRound[2]!.id);
    second.send(GatewayOpcode.TO_DEVICE_ACK, { upToId: secondRound[2]!.id });
    await expect.poll(() => queuedFor(recipient.deviceId)).toBe(0);
    second.close();

    const third = await connectGateway(server, recipient);
    expect(await third.never("TO_DEVICE")).toBe(true);
    third.close();
  });

  it("takes messages from the TO_DEVICE_SEND gateway op, with the same rules, in order", async () => {
    const [sender, recipient] = await pair("op");
    const stranger = await registerUser(server, "opx");
    await new TestDeviceKeys(stranger).upload(server);
    const from = await connectGateway(server, sender);
    const to = await connectGateway(server, recipient);

    for (let i = 0; i < 20; i += 1) {
      from.send(GatewayOpcode.TO_DEVICE_SEND, { messages: [message(recipient, `s${i}`)] });
    }
    const received = await collect(to, 20);
    expect(received.map((d) => d.ciphertext)).toEqual(Array.from({ length: 20 }, (_, i) => ciphertext(`s${i}`)));
    expect(received.every((d) => d.senderDeviceId === sender.deviceId)).toBe(true);

    // A recipient that the sender cannot see: the server stores nothing, and the connection stays open.
    from.send(GatewayOpcode.TO_DEVICE_SEND, { messages: [message(stranger, "no")] });
    from.send(GatewayOpcode.TO_DEVICE_SEND, { messages: [message(recipient, "after")] });
    expect((await to.event("TO_DEVICE")).ciphertext).toBe(ciphertext("after"));
    expect(await queuedFor(stranger.deviceId)).toBe(0);
    from.close();
    to.close();
  });

  it("sends at most 100 unacknowledged messages, and more after an ACK", async () => {
    const [sender, recipient] = await pair("wind");
    const client = await connectGateway(server, recipient);
    const messages = Array.from({ length: 100 }, (_, i) => message(recipient, `m${i}`));
    await apiFor(server, sender).post("/to-device", { messages });
    await apiFor(server, sender).post("/to-device", { messages: messages.slice(0, 30) });

    const firstWindow = await collect(client, 100);
    expect(await client.never("TO_DEVICE", () => true, 300)).toBe(true);
    client.send(GatewayOpcode.TO_DEVICE_ACK, { upToId: firstWindow[99]!.id });
    const rest = await collect(client, 30);
    expect(BigInt(rest[0]!.id!) > BigInt(firstWindow[99]!.id!)).toBe(true);
    client.close();
  });

  it("rejects a recipient the sender cannot see, and skips unknown devices", async () => {
    const [sender, recipient] = await pair("vis");
    const stranger = await registerUser(server, "visx");
    await new TestDeviceKeys(stranger).upload(server);

    const blocked = await apiFor(server, sender).post("/to-device", {
      messages: [message(recipient, "ok"), message(stranger, "no")],
    });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("CANNOT_SEND_TO_DEVICE");
    expect(await queuedFor(recipient.deviceId)).toBe(0);

    const keyless = await loginNewDevice(server, recipient);
    const result = await apiFor(server, sender).post("/to-device", {
      messages: [message(recipient, "ok"), { ...message(recipient, "x"), deviceId: "no-such-device" }, message(keyless, "y")],
    });
    expect(result.status).toBe(200);
    expect(result.body.skipped).toEqual([
      { userId: recipient.userId, deviceId: "no-such-device" },
      { userId: recipient.userId, deviceId: keyless.deviceId },
    ]);
    expect(await queuedFor(recipient.deviceId)).toBe(1);

    // A sender without keys cannot send.
    const keylessSender = await registerUser(server, "visk");
    await makeFriends(server, keylessSender, recipient);
    const noKeys = await apiFor(server, keylessSender).post("/to-device", { messages: [message(recipient, "z")] });
    expect(noKeys.body.error.code).toBe("DEVICE_KEYS_MISSING");
  });

  it("limits the count and the size of messages", async () => {
    const [sender, recipient] = await pair("lim");
    const api = apiFor(server, sender);
    const tooMany = Array.from({ length: 101 }, () => message(recipient, "x"));
    expect((await api.post("/to-device", { messages: tooMany })).status).toBe(400);

    const big = { ...message(recipient, ""), ciphertext: encodeBase64Url(new Uint8Array(64 * 1024 + 1)) };
    expect((await api.post("/to-device", { messages: [big] })).status).toBe(400);
    const max = { ...message(recipient, ""), ciphertext: encodeBase64Url(new Uint8Array(64 * 1024)) };
    expect((await api.post("/to-device", { messages: [max] })).status).toBe(200);
  });

  it("keeps only the newest messages when the queue of a device is full", async () => {
    const [sender, recipient] = await pair("full");
    const api = apiFor(server, sender);
    const batch = Array.from({ length: 100 }, (_, i) => message(recipient, `b${i}`));
    await api.post("/to-device", { messages: batch });
    await api.post("/to-device", { messages: batch });
    await api.post("/to-device", { messages: batch.slice(0, 50) });
    expect(await queuedFor(recipient.deviceId)).toBe(200);

    const client = await connectGateway(server, recipient);
    const first = await client.event("TO_DEVICE");
    // The first 50 of the first batch were dropped.
    expect(first.ciphertext).toBe(ciphertext("b50"));
    client.close();
  });

  it("deletes queued messages when the recipient device signs out", async () => {
    const [sender, recipient] = await pair("gone");
    await apiFor(server, sender).post("/to-device", { messages: [message(recipient, "late")] });
    expect(await queuedFor(recipient.deviceId)).toBe(1);
    await apiFor(server, recipient).post("/auth/logout");
    expect(await queuedFor(recipient.deviceId)).toBe(0);

    const result = await apiFor(server, sender).post("/to-device", { messages: [message(recipient, "again")] });
    expect(result.body.skipped).toEqual([{ userId: recipient.userId, deviceId: recipient.deviceId }]);
  });
});
