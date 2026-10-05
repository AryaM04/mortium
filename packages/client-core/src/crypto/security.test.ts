// Tests of the key backup, the recovery key, SAS verification and identity
// changes, with the real vodozemac WASM and the fake server.
import { beforeAll, describe, expect, it } from "vitest";
import { decodeBase64Url, encodeBase64Url, type ChannelMembersResponse, type EventJson } from "@mortium/shared";
import { WrongRecoveryKeyError } from "./key-backup.js";
import { decodeRecoveryKey, encodeRecoveryKey } from "./recovery-key.js";
import {
  FakeServer,
  TEST_AUTH_KEY,
  initWasmForTests,
  newClient,
  settleClients,
  verifyWithSas,
  type TestClient,
} from "./test/fake-server.js";

beforeAll(() => {
  initWasmForTests();
});

const CHANNEL = "300";

function dm(userIds: string[]): ChannelMembersResponse {
  return { guildId: null, ownerId: null, roles: [], overwrites: [], members: userIds.map((userId) => ({ userId, roles: [] })) };
}

let eventCounter = 5000;

async function send(client: TestClient, body: string): Promise<EventJson> {
  const encoded = await client.handle!.codec.encode(CHANNEL, { type: "message", body, mentions: [], attachments: [], embeds: [] });
  eventCounter += 1;
  return {
    id: String(eventCounter),
    channelId: CHANNEL,
    senderId: client.userId,
    senderDeviceId: client.deviceId,
    relType: null,
    relatesToId: null,
    codec: encoded.codec,
    megolmSessionId: encoded.megolmSessionId,
    ciphertext: encodeBase64Url(encoded.ciphertext),
    nonce: `n${eventCounter}`,
    createdAt: new Date().toISOString(),
    redactedAt: null,
  };
}

async function read(client: TestClient, event: EventJson): Promise<string> {
  const result = await client.handle!.codec.decode(event);
  if (result.ok) {
    return result.payload.type === "message" ? result.payload.body : result.payload.type;
  }
  return result.waiting ? "waiting" : "unreadable";
}

async function setUpBackup(client: TestClient, passphrase?: string): Promise<{ recoveryKey: string }> {
  const prepared = await client.handle!.security.setUpBackup(passphrase);
  await prepared.create();
  return prepared;
}

async function isVerified(client: TestClient): Promise<boolean> {
  return (await client.handle!.security.state()).deviceVerified;
}

const settingsText = new TextEncoder().encode(JSON.stringify({ playRingSound: false }));

describe("recovery key text", () => {
  it("round-trips, ignores spaces and finds a wrong character", () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const text = encodeRecoveryKey(key);
    expect(text).toMatch(/^([1-9A-HJ-NP-Za-km-z]{4} )+[1-9A-HJ-NP-Za-km-z]{1,4}$/);
    expect(decodeRecoveryKey(text)).toEqual(key);
    expect(decodeRecoveryKey(text.replace(/ /g, ""))).toEqual(key);
    const last = text.at(-1)!;
    expect(decodeRecoveryKey(text.slice(0, -1) + (last === "2" ? "3" : "2"))).toBeNull();
    expect(decodeRecoveryKey("not a key")).toBeNull();
    expect(decodeRecoveryKey("")).toBeNull();
  });
});

describe("key backup", () => {
  async function twoUsers() {
    const server = new FakeServer();
    server.channels.set(CHANNEL, dm(["1", "2"]));
    const a1 = newClient("1", "A1");
    const b1 = newClient("2", "B1");
    await server.start(a1);
    await server.start(b1);
    return { server, a1, b1 };
  }

  it("backs up sessions and secrets, and a new device restores the history and signs itself", async () => {
    const { server, a1, b1 } = await twoUsers();
    const sealed = await a1.handle!.settings.seal(settingsText, null);
    const { recoveryKey } = await setUpBackup(a1);
    const first = await send(a1, "first secret");
    const second = await send(b1, "second secret");
    await settleClients([a1, b1]);
    expect(await read(a1, second)).toBe("second secret");
    await settleClients([a1, b1]);

    // The server has both sessions, the master key and the settings key, and only ciphertext.
    const backup = server.backups.get("1")!;
    expect(backup.sessions.size).toBe(2);
    expect(Object.keys(backup.version.secrets).sort()).toEqual(["master", `settings:${sealed.keyId}`]);
    for (const entry of backup.sessions.values()) {
      expect(new TextDecoder().decode(decodeBase64Url(entry.data))).not.toContain("sessionKey");
    }
    expect((await a1.handle!.security.state()).backup).toMatchObject({ version: backup.version.version, trusted: true, error: null });

    // A new device: not verified, it cannot read the history, and nobody gives it keys.
    const a2 = newClient("1", "A2");
    await server.start(a2);
    expect(await isVerified(a2)).toBe(false);
    expect(await read(a2, first)).toBe("waiting");

    const progress: number[] = [];
    const result = await a2.handle!.security.restoreBackup({ recoveryKey }, (entry) => progress.push(entry.imported));
    expect(result).toEqual({ imported: 2, failed: 0, signed: true, settingsKeys: 1 });
    expect(progress.at(-1)).toBe(2);
    expect(await isVerified(a2)).toBe(true);
    expect((await a2.handle!.security.state()).holdsMasterKey).toBe(true);
    expect(await read(a2, first)).toBe("first secret");
    expect(await read(a2, second)).toBe("second secret");
    expect((await a2.handle!.settings.open(sealed.blob)).plaintext).toEqual(settingsText);

    // A1 sees A2 as signed now, so A2 gets the next key directly.
    const third = await send(a1, "third");
    await settleClients([a1, a2, b1]);
    expect(await read(a2, third)).toBe("third");
    expect((await a1.handle!.security.ownDevices()).map((device) => device.verified)).toEqual([true, true]);
  });

  it("restores with the passphrase and rejects a wrong key or passphrase", async () => {
    const { server, a1 } = await twoUsers();
    await setUpBackup(a1, "a long passphrase for tests");
    const event = await send(a1, "passphrase secret");
    await settleClients([a1]);
    expect(server.backups.get("1")!.version.authData.passphrase).toMatchObject({ algorithm: "argon2id", memoryKiB: 65536, iterations: 3 });

    const a2 = newClient("1", "A2");
    await server.start(a2);
    const wrongKey = encodeRecoveryKey(crypto.getRandomValues(new Uint8Array(32)));
    await expect(a2.handle!.security.restoreBackup({ recoveryKey: wrongKey })).rejects.toBeInstanceOf(WrongRecoveryKeyError);
    await expect(a2.handle!.security.restoreBackup({ recoveryKey: "abcd efgh" })).rejects.toBeInstanceOf(WrongRecoveryKeyError);
    await expect(a2.handle!.security.restoreBackup({ passphrase: "a wrong passphrase" })).rejects.toBeInstanceOf(WrongRecoveryKeyError);
    expect(await isVerified(a2)).toBe(false);
    expect(await read(a2, event)).toBe("waiting");

    const result = await a2.handle!.security.restoreBackup({ passphrase: "a long passphrase for tests" });
    expect(result.signed).toBe(true);
    expect(await read(a2, event)).toBe("passphrase secret");
  });

  it("does not upload to a backup version that no verified device signed", async () => {
    const { server, a1 } = await twoUsers();
    await setUpBackup(a1);
    await settleClients([a1]);
    const real = server.backups.get("1")!;
    // A malicious server puts in a version with its own public key.
    const fake = structuredClone(real);
    fake.version.version = real.version.version + 10;
    fake.version.publicKey = "Lw7uFuMSOT2uBn/4j09sb7xIfLGQ3VM0dbd59gSSYFY";
    fake.sessions.clear();
    server.backups.set("1", fake);
    const status = await (async () => {
      server.stop(a1);
      await server.start(a1);
      await settleClients([a1]);
      return (await a1.handle!.security.state()).backup;
    })();
    expect(status).toMatchObject({ version: fake.version.version, trusted: false });
    await send(a1, "must not reach the fake backup");
    await settleClients([a1]);
    expect(fake.sessions.size).toBe(0);
  });

  it("changes nothing for other users when a sender restores, and marks restored sessions as backed up", async () => {
    const { server, a1 } = await twoUsers();
    const { recoveryKey } = await setUpBackup(a1);
    await send(a1, "one");
    await settleClients([a1]);
    const before = [...server.backups.get("1")!.sessions.values()];
    const a2 = newClient("1", "A2");
    await server.start(a2);
    await a2.handle!.security.restoreBackup({ recoveryKey });
    await settleClients([a2]);
    // The restored session is not uploaded again.
    expect([...server.backups.get("1")!.sessions.values()]).toEqual(before);
  });
});

describe("SAS verification", () => {
  it("verifies a new own device, which the other device then signs", async () => {
    const server = new FakeServer();
    const a1 = newClient("1", "A1");
    const a2 = newClient("1", "A2");
    await server.start(a1);
    await server.start(a2);
    expect(await isVerified(a2)).toBe(false);
    const emojis = await verifyWithSas(a2, a1);
    expect(emojis).toHaveLength(7);
    expect(await isVerified(a2)).toBe(true);
    const views = [a1, a2].map((client) => client.handle!.verification.list()[0]!);
    expect(views.map((view) => [view.phase, view.signed])).toEqual([
      ["done", true],
      ["done", true],
    ]);
    // A SAS-verified device does not get the master key.
    expect((await a2.handle!.security.state()).holdsMasterKey).toBe(false);
  });

  it("marks the master key of a different user as verified", async () => {
    const server = new FakeServer();
    const a1 = newClient("1", "A1");
    const b1 = newClient("2", "B1");
    await server.start(a1);
    await server.start(b1);
    expect(await a1.handle!.security.userTrust("2")).toEqual({ verified: false, changed: false });
    await verifyWithSas(a1, b1);
    expect(await a1.handle!.security.userTrust("2")).toEqual({ verified: true, changed: false });
    expect(await b1.handle!.security.userTrust("1")).toEqual({ verified: true, changed: false });
  });

  it("cancels on both sides when the emojis do not match, and signs nothing", async () => {
    const server = new FakeServer();
    const a1 = newClient("1", "A1");
    const a2 = newClient("1", "A2");
    await server.start(a1);
    await server.start(a2);
    const txnId = await a2.handle!.verification.requestOwnDevices();
    await settleClients([a1, a2]);
    expect(a1.handle!.verification.list()[0]!.phase).toBe("incoming");
    await a1.handle!.verification.accept(txnId);
    await settleClients([a1, a2]);
    expect(a2.handle!.verification.list()[0]!.phase).toBe("emojis");
    await a1.handle!.verification.confirm(txnId, false);
    await settleClients([a1, a2]);
    for (const client of [a1, a2]) {
      const view = client.handle!.verification.list()[0]!;
      expect(view.phase).toBe("cancelled");
      expect(view.cancelReason).toBe("The emojis did not match. Nothing was verified.");
    }
    expect(await isVerified(a2)).toBe(false);
    // A second verification of the same pair can start after the first ended.
    await verifyWithSas(a2, a1);
    expect(await isVerified(a2)).toBe(true);
  });

  it("refuses a second verification of the same pair while one is in progress", async () => {
    const server = new FakeServer();
    const a1 = newClient("1", "A1");
    const a2 = newClient("1", "A2");
    await server.start(a1);
    await server.start(a2);
    await a2.handle!.verification.requestOwnDevices();
    await expect(a2.handle!.verification.requestOwnDevices()).rejects.toThrow("in progress");
    await settleClients([a1, a2]);
    await expect(a1.handle!.verification.requestOwnDevices(a2.deviceId)).rejects.toThrow("in progress");
  });

  it("stops a verification after the timeout", async () => {
    const server = new FakeServer();
    const a1 = newClient("1", "A1");
    const a2 = newClient("1", "A2");
    await server.start(a1);
    await server.start(a2, { verificationTimeoutMs: 30 });
    await a2.handle!.verification.requestOwnDevices();
    await new Promise((resolve) => setTimeout(resolve, 80));
    await settleClients([a1, a2]);
    expect(a2.handle!.verification.list()[0]!.cancelReason).toBe("The verification took more than 10 minutes. Start it again.");
    // The other device got the cancel too.
    expect(a1.handle!.verification.list()[0]!.phase).toBe("cancelled");
  });
});

describe("identity changes", () => {
  it("gives no keys to a user whose master key changed until the user accepts the change", async () => {
    const server = new FakeServer();
    server.channels.set(CHANNEL, dm(["1", "2"]));
    const a1 = newClient("1", "A1");
    const b1 = newClient("2", "B1");
    await server.start(a1);
    await server.start(b1);
    const before = await send(a1, "before the reset");
    await settleClients([a1, b1]);
    expect(await read(b1, before)).toBe("before the reset");

    // User 2 lost everything: a new device resets the identity with the auth key of the password.
    server.stop(b1);
    const b2 = newClient("2", "B2");
    await server.start(b2);
    await expect(b2.handle!.security.resetIdentity("wrong")).rejects.toMatchObject({ code: "INVALID_PASSWORD" });
    await b2.handle!.security.resetIdentity(TEST_AUTH_KEY);
    expect(await isVerified(b2)).toBe(true);

    const changed: string[] = [];
    a1.handle!.onMasterKeyChanged((userId) => changed.push(userId));
    const blocked = await send(a1, "blocked");
    await settleClients([a1, b2]);
    expect(changed).toEqual(["2"]);
    expect(await a1.handle!.security.userTrust("2")).toEqual({ verified: false, changed: true });
    expect(await read(b2, blocked)).toBe("waiting");

    await a1.handle!.security.acceptIdentityChange("2");
    const after = await send(a1, "after the accept");
    await settleClients([a1, b2]);
    expect(await read(b2, after)).toBe("after the accept");
    expect(await a1.handle!.security.userTrust("2")).toEqual({ verified: false, changed: false });
  });

  it("keeps the master key trusted after the device that made it is removed", async () => {
    const server = new FakeServer();
    const a1 = newClient("1", "A1");
    const a2 = newClient("1", "A2");
    await server.start(a1);
    await server.start(a2);
    await verifyWithSas(a1, a2);
    const { recoveryKey } = await setUpBackup(a1);
    await settleClients([a1, a2]);
    // A1 made the master key and vouches for it on the server. Then it signs out.
    server.stop(a1);
    server.removeDevice("1", "A1");
    expect(server.masters.get("1")!.deviceId).toBe("A1");

    // A user who sees user 1 for the first time trusts the master key, because A2 has a signature from it.
    const b1 = newClient("2", "B1");
    await server.start(b1);
    const trusted = await b1.handle!.devices.trustedDevicesOfUsers(["1"]);
    expect(trusted.get("1")!.map((device) => device.deviceId)).toEqual(["A2"]);

    // A new own device verifies with A2: the MAC of the master key matches.
    const a3 = newClient("1", "A3");
    await server.start(a3);
    await verifyWithSas(a3, a2);

    // A3 gets the master key from the backup, and vouches for it in place of A1.
    await a3.handle!.security.restoreBackup({ recoveryKey });
    expect(server.masters.get("1")!.deviceId).toBe("A3");
    expect(await isVerified(a3)).toBe(true);
  });

  it("an unsigned device of a different user gets no key", async () => {
    const server = new FakeServer();
    server.channels.set(CHANNEL, dm(["1", "2"]));
    const a1 = newClient("1", "A1");
    const b1 = newClient("2", "B1");
    const b2 = newClient("2", "B2");
    await server.start(a1);
    await server.start(b1);
    await server.start(b2);
    const event = await send(a1, "only for signed devices");
    await settleClients([a1, b1, b2]);
    expect(await read(b1, event)).toBe("only for signed devices");
    expect(b2.received.some((entry) => entry.type === "megolm.session")).toBe(false);
    expect(await read(b2, event)).toBe("waiting");
  });
});
