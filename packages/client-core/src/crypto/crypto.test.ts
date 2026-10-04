// Tests of the crypto layer with the real vodozemac WASM and a fake server:
// to-device messages between two users with two devices each, the offline
// queue, wedged session recovery, forged envelopes, master key changes and
// the one-time key top-up.
import { beforeAll, describe, expect, it } from "vitest";
import { deviceKeysSignedText, encodeBase64Url, masterKeySignedText, oneTimeKeySignedText } from "@mortium/shared";
import { Account, SigningKey, verify } from "@mortium/crypto-wasm";
import { cryptoStoreName, openCryptoStore } from "./store.js";
import { FakeServer, initWasmForTests, newClient, type TestClient } from "./test/fake-server.js";

beforeAll(() => {
  initWasmForTests();
});

async function settle(...clients: TestClient[]): Promise<void> {
  // Two rounds, so a reply that a first round makes is also handled.
  for (let round = 0; round < 3; round += 1) {
    for (const client of clients) {
      await client.handle?.whenIdle();
    }
  }
}

async function setupTwoUsers() {
  const server = new FakeServer();
  const a1 = newClient("1", "A1");
  const a2 = newClient("1", "A2");
  const b1 = newClient("2", "B1");
  const b2 = newClient("2", "B2");
  for (const client of [a1, a2, b1, b2]) {
    await server.start(client);
  }
  return { server, a1, a2, b1, b2 };
}

describe("crypto layer", () => {
  it("sets up device keys, 50 one-time keys, a fallback key and the master key", async () => {
    const server = new FakeServer();
    const a1 = newClient("1", "A1");
    const handle = await server.start(a1);
    const device = server.device("1", "A1");
    expect(device.keys?.curve25519).toBe(handle.identityKeys.curve25519);
    expect(device.oneTimeKeys.size).toBe(50);
    expect(device.fallback?.used).toBe(false);

    // Every uploaded key has a valid signature by the device key.
    const text = deviceKeysSignedText("1", "A1", device.keys!.curve25519, device.keys!.ed25519);
    expect(verify(device.keys!.ed25519, text, device.keys!.signature)).toBe(true);
    const [keyId, oneTime] = [...device.oneTimeKeys.entries()][0]!;
    expect(verify(device.keys!.ed25519, oneTimeKeySignedText("one_time_key", "1", "A1", keyId, oneTime.key), oneTime.signature)).toBe(true);

    // The first device made the master key and signed itself.
    const master = server.masters.get("1")!;
    expect(verify(master.publicKey, text, device.masterSignature!)).toBe(true);

    // A second device of the same user does not replace the master key.
    await server.start(newClient("1", "A2"));
    expect(server.masters.get("1")!.publicKey).toBe(master.publicKey);
    expect(server.device("1", "A2").masterSignature).toBeNull();

    // A restart keeps the same identity and uploads nothing new.
    server.stop(a1);
    const again = await server.start(a1);
    expect(again.identityKeys).toEqual(handle.identityKeys);
    expect(device.oneTimeKeys.size).toBe(50);
  });

  it("sends to-device messages between two users with two devices each, both ways", async () => {
    const { a1, a2, b1, b2 } = await setupTwoUsers();

    const toB = await a1.handle!.encryptToUsers(["2"], "test.hello", { text: "from A1" });
    expect(toB.sent).toHaveLength(2);
    expect(toB.failed).toEqual([]);
    await settle(b1, b2);
    for (const client of [b1, b2]) {
      expect(client.received).toEqual([{ type: "test.hello", content: { text: "from A1" }, from: "1:A1" }]);
    }

    // The reply uses the sessions B made from the pre-key messages.
    const reply = await b2.handle!.encryptToUsers(["1", "2"], "test.reply", { text: "from B2" });
    expect(reply.sent.map((device) => device.deviceId).sort()).toEqual(["A1", "A2", "B1"]);
    await settle(a1, a2, b1);
    expect(a1.received).toEqual([{ type: "test.reply", content: { text: "from B2" }, from: "2:B2" }]);
    expect(a2.received).toHaveLength(1);
    expect(b1.received.at(-1)).toEqual({ type: "test.reply", content: { text: "from B2" }, from: "2:B2" });

    // A second message from A1 to B2 needs no new one-time key.
    await a1.handle!.encryptToDevices([{ userId: "2", deviceId: "B2" }], "test.again", {});
    await settle(b2);
    expect(b2.received.at(-1)?.type).toBe("test.again");
    expect(await a1.handle!.sessionCount()).toBe(2);
  });

  it("keeps messages for an offline device and delivers them after a restart", async () => {
    const { server, a1, b1 } = await setupTwoUsers();
    server.stop(b1);
    await a1.handle!.encryptToDevices([{ userId: "2", deviceId: "B1" }], "test.offline", { n: 1 });
    await a1.handle!.encryptToDevices([{ userId: "2", deviceId: "B1" }], "test.offline", { n: 2 });
    expect(server.queuedFor("2", "B1")).toBe(2);
    expect(b1.received).toEqual([]);

    await server.start(b1);
    await settle(b1);
    expect(b1.received.map((event) => event.content.n)).toEqual([1, 2]);

    // The acknowledgement comes within about 2 seconds and empties the queue.
    await expect.poll(() => server.queuedFor("2", "B1"), { timeout: 4000 }).toBe(0);

    // A second delivery of the same queue ids does not reach the handler twice.
    const [first] = server.queue.length === 0 ? [] : server.queue;
    expect(first).toBeUndefined();
    server.stop(b1);
    await server.start(b1);
    await settle(b1);
    expect(b1.received).toHaveLength(2);
  });

  it("recovers a wedged session with a new session and a dummy message", async () => {
    const { server, a1, b1 } = await setupTwoUsers();
    const toB1 = [{ userId: "2", deviceId: "B1" }];
    await a1.handle!.encryptToDevices(toB1, "test.one", {});
    await settle(b1);
    await b1.handle!.encryptToDevices([{ userId: "1", deviceId: "A1" }], "test.back", {});
    await settle(a1);

    // B1 loses its Olm sessions, for example after a restore of an old backup.
    const store = await openCryptoStore(cryptoStoreName("2", "B1"), b1.indexedDb);
    const peerKey = server.device("1", "A1").keys!.curve25519;
    const sessions = await store.getSessions(peerKey);
    await store.commit({ deleteSessions: sessions.map((record): [string, string] => [record.peerKey, record.sessionId]) });
    store.close();

    // A1 sends on its old session. B1 cannot decrypt it, so it makes a new session and sends a dummy.
    await a1.handle!.encryptToDevices(toB1, "test.lost", {});
    await settle(b1, a1);
    expect(b1.received.map((event) => event.type)).toEqual(["test.one"]);
    expect(a1.received.map((event) => event.type)).toEqual(["test.back"]);

    // A1 now uses the new session, and B1 decrypts again.
    await a1.handle!.encryptToDevices(toB1, "test.after", {});
    await settle(b1);
    expect(b1.received.map((event) => event.type)).toEqual(["test.one", "test.after"]);
  });

  it("drops forged envelopes and messages that the server moved to a different sender", async () => {
    const { server, a1, b1 } = await setupTwoUsers();

    // An attacker device with real keys that the server knows.
    const evil = new Account();
    evil.generate_one_time_keys(1);
    const evilDevice = server.device("3", "EVIL");
    evilDevice.keys = {
      curve25519: evil.curve25519_key,
      ed25519: evil.ed25519_key,
      signature: evil.sign(deviceKeysSignedText("3", "EVIL", evil.curve25519_key, evil.ed25519_key)),
    };
    const transport = server.transportFor("3", "EVIL");
    const b1Keys = server.device("2", "B1").keys!;

    async function forge(envelope: Record<string, unknown>): Promise<void> {
      const [claimed] = (await transport.claimKeys([{ userId: "2", deviceId: "B1" }])).keys;
      const session = evil.create_outbound_session(b1Keys.curve25519, claimed!.key);
      const message = session.encrypt(new TextEncoder().encode(JSON.stringify(envelope)));
      const bytes = new Uint8Array([message.message_type, ...message.ciphertext]);
      server.inject({ userId: "3", deviceId: "EVIL" }, { userId: "2", deviceId: "B1" }, encodeBase64Url(bytes));
    }
    const base = {
      v: 1,
      type: "test.forged",
      content: {},
      ts: Date.now(),
      recipient: { userId: "2", deviceId: "B1", curve25519: b1Keys.curve25519 },
    };

    // The envelope says that A1 sent it, but the Olm session is with EVIL.
    await forge({ ...base, id: "f1", sender: { userId: "1", deviceId: "A1", ed25519: server.device("1", "A1").keys!.ed25519 } });
    // The envelope is for a different device.
    await forge({
      ...base,
      id: "f2",
      sender: { userId: "3", deviceId: "EVIL", ed25519: evil.ed25519_key },
      recipient: { ...base.recipient, deviceId: "B2" },
    });
    // A correct envelope from EVIL is accepted, so the checks above are the reason for the drops.
    await forge({ ...base, id: "f3", type: "test.fine", sender: { userId: "3", deviceId: "EVIL", ed25519: evil.ed25519_key } });
    await settle(b1);
    expect(b1.received.map((event) => [event.type, event.from])).toEqual([["test.fine", "3:EVIL"]]);

    // A malicious server says that a message from A1 came from A2. B1 drops it.
    server.tamper = (payload) => ({ ...payload, senderDeviceId: "A2" });
    await a1.handle!.encryptToDevices([{ userId: "2", deviceId: "B1" }], "test.moved", {});
    await settle(b1);
    expect(b1.received.map((event) => event.type)).toEqual(["test.fine"]);
  });

  it("flags a changed master key and never trusts it silently", async () => {
    const { server, b1 } = await setupTwoUsers();
    const devices = b1.handle!.devices;
    const before = await devices.getDevices("1");
    expect(before.find((device) => device.deviceId === "A1")?.ownerVerified).toBe(true);
    expect(before.find((device) => device.deviceId === "A2")?.ownerVerified).toBe(false);
    const trusted = (await devices.getUser("1"))!.masterKey;

    const flagged: string[] = [];
    b1.handle!.onMasterKeyChanged((userId) => flagged.push(userId));

    // The server now shows a new master key, vouched for by A1 (for example after a device theft).
    const a1Keys = server.device("1", "A1").keys!;
    const newMaster = new SigningKey();
    server.masters.set("1", {
      publicKey: newMaster.public_key,
      deviceId: "A1",
      deviceSignature: server.masters.get("1")!.deviceSignature,
    });
    await devices.markOutdated("1");
    await devices.getDevices("1");
    // The voucher signature does not match the new key, so it does not count.
    expect(await b1.handle!.changedMasterKeys()).toEqual([]);

    // A properly vouched new key is flagged, and the old key stays trusted.
    const signer = new Account();
    const forgedA3 = server.device("1", "A3");
    forgedA3.keys = {
      curve25519: signer.curve25519_key,
      ed25519: signer.ed25519_key,
      signature: signer.sign(deviceKeysSignedText("1", "A3", signer.curve25519_key, signer.ed25519_key)),
    };
    server.masters.set("1", {
      publicKey: newMaster.public_key,
      deviceId: "A3",
      deviceSignature: signer.sign(masterKeySignedText("1", newMaster.public_key)),
    });
    forgedA3.masterSignature = newMaster.sign(deviceKeysSignedText("1", "A3", signer.curve25519_key, signer.ed25519_key));
    await devices.markOutdated("1");
    const after = await devices.getDevices("1");
    expect(await b1.handle!.changedMasterKeys()).toEqual(["1"]);
    expect(flagged).toEqual(["1"]);
    expect((await devices.getUser("1"))!.masterKey).toBe(trusted);
    expect(after.find((device) => device.deviceId === "A3")?.ownerVerified).toBe(false);
    expect(a1Keys.curve25519).toBe(after.find((device) => device.deviceId === "A1")?.curve25519);

    // The user accepts the change. Devices signed by the new key are then verified.
    await devices.acceptMasterKeyChange("1");
    expect(await b1.handle!.changedMasterKeys()).toEqual([]);
    expect((await devices.getDevices("1")).find((device) => device.deviceId === "A3")?.ownerVerified).toBe(true);
  });

  it("drops a device whose identity keys change", async () => {
    const { server, b1 } = await setupTwoUsers();
    expect((await b1.handle!.devices.getDevices("1")).map((device) => device.deviceId).sort()).toEqual(["A1", "A2"]);
    const other = new Account();
    server.device("1", "A2").keys = {
      curve25519: other.curve25519_key,
      ed25519: other.ed25519_key,
      signature: other.sign(deviceKeysSignedText("1", "A2", other.curve25519_key, other.ed25519_key)),
    };
    await b1.handle!.devices.markOutdated("1");
    expect((await b1.handle!.devices.getDevices("1")).map((device) => device.deviceId)).toEqual(["A1"]);
  });

  it("tops up one-time keys when READY says they are low, and replaces a used fallback key", async () => {
    const server = new FakeServer();
    const a1 = newClient("1", "A1");
    const handle = await server.start(a1);
    const device = server.device("1", "A1");
    const claimer = server.transportFor("2", "B1");

    for (let i = 0; i < 30; i += 1) {
      await claimer.claimKeys([{ userId: "1", deviceId: "A1" }]);
    }
    expect(device.oneTimeKeys.size).toBe(20);
    handle.handleDispatch({ t: "READY", d: readyPayload(20, false) });
    await expect.poll(() => device.oneTimeKeys.size).toBe(50);

    // Use every key, then the fallback key.
    for (let i = 0; i < 51; i += 1) {
      await claimer.claimKeys([{ userId: "1", deviceId: "A1" }]);
    }
    const oldFallback = device.fallback!.key;
    expect(device.fallback!.used).toBe(true);
    handle.handleDispatch({ t: "READY", d: readyPayload(0, true) });
    await expect.poll(() => device.oneTimeKeys.size).toBe(50);
    await expect.poll(() => device.fallback!.key !== oldFallback && !device.fallback!.used).toBe(true);
  });

  it("checks the server count after pre-key messages use one-time keys", async () => {
    const server = new FakeServer();
    const a1 = newClient("1", "A1");
    await server.start(a1);
    const device = server.device("1", "A1");
    // Other users take 26 keys, so 24 stay: below half of 50.
    const senders = [];
    for (let i = 0; i < 26; i += 1) {
      const sender = newClient(`${10 + i}`, `S${i}`);
      await server.start(sender);
      senders.push(sender);
    }
    for (const sender of senders) {
      await sender.handle!.encryptToDevices([{ userId: "1", deviceId: "A1" }], "test.ping", {});
    }
    await settle(a1);
    expect(a1.received).toHaveLength(26);
    await expect.poll(() => device.oneTimeKeys.size).toBe(50);
  });
});

function readyPayload(oneTimeKeyCount: number, needsFallbackKey: boolean) {
  return {
    sessionId: "s",
    user: { id: "1" },
    guilds: [],
    presences: [],
    readStates: [],
    oneTimeKeyCount,
    needsFallbackKey,
  };
}
