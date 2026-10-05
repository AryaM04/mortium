// Integration tests for the key backup routes, the master signature of a
// different device and the master key reset. Real Postgres.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { backupSignedText, deviceKeysSignedText, encodeBase64Url } from "@mortium/shared";
import { describeWithDb } from "../../../test/db.js";
import { randomCurveKey, TestDeviceKeys, TestSigner } from "../../../test/keys.js";
import {
  apiFor,
  connectGateway,
  loginNewDevice,
  makeFriends,
  registerUser,
  startTestServer,
  type TestServer,
  type TestUser,
} from "../../../test/social.js";
import { testAuthKey } from "../../../test/helpers.js";

let server: TestServer;

function backupBody(user: TestUser, keys: TestDeviceKeys, publicKey = randomCurveKey()) {
  const passphrase = { algorithm: "argon2id" as const, salt: encodeBase64Url(randomBytes(16)), memoryKiB: 65536, iterations: 3, parallelism: 1 };
  return {
    publicKey,
    authData: {
      passphrase,
      deviceId: user.deviceId,
      signature: keys.signer.sign(backupSignedText(user.userId, publicKey, passphrase)),
      masterSignature: null,
    },
  };
}

function session(channelId: string, firstIndex: number, data = randomBytes(40)) {
  return { channelId, sessionId: randomCurveKey(), firstIndex, data: encodeBase64Url(data) };
}

describeWithDb("key backup and master key routes", () => {
  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it("makes one backup version, checks its signature, and keeps the session with the lower first index", async () => {
    const alice = await registerUser(server, "backupa");
    const api = apiFor(server, alice);
    const keys = await new TestDeviceKeys(alice).upload(server);
    expect((await api.get("/keys/backup/version")).body).toEqual({ backup: null });

    const forged = backupBody(alice, keys);
    forged.authData.signature = new TestSigner().sign("x");
    expect((await api.post("/keys/backup/version", forged)).body.error.code).toBe("INVALID_SIGNATURE");

    const body = backupBody(alice, keys);
    const created = await api.post("/keys/backup/version", body);
    expect(created.status).toBe(201);
    const version = created.body.version as number;
    expect((await api.get("/keys/backup/version")).body.backup).toEqual({ version, ...body, secrets: {} });

    const first = session("111", 5);
    const other = session("222", 0);
    expect((await api.put("/keys/backup/sessions", { version, sessions: [first, other] })).body).toEqual({ stored: 2 });
    // A copy with a higher first index changes nothing. A lower one replaces the stored copy.
    const worse = { ...first, firstIndex: 9, data: encodeBase64Url(randomBytes(40)) };
    expect((await api.put("/keys/backup/sessions", { version, sessions: [worse] })).body).toEqual({ stored: 0 });
    const better = { ...first, firstIndex: 1, data: encodeBase64Url(randomBytes(40)) };
    expect((await api.put("/keys/backup/sessions", { version, sessions: [better] })).body).toEqual({ stored: 1 });

    const all = (await api.get(`/keys/backup/sessions?version=${version}`)).body;
    expect(all.next).toBeNull();
    expect(all.sessions).toHaveLength(2);
    expect(all.sessions.find((entry: { sessionId: string }) => entry.sessionId === first.sessionId)).toEqual(better);
    const byChannel = (await api.get(`/keys/backup/sessions?version=${version}&channelId=222`)).body;
    expect(byChannel.sessions).toEqual([other]);

    const tooMany = Array.from({ length: 101 }, () => session("111", 0));
    expect((await api.put("/keys/backup/sessions", { version, sessions: tooMany })).status).toBe(400);
    const tooLarge = session("111", 0, randomBytes(9000));
    expect((await api.put("/keys/backup/sessions", { version, sessions: [tooLarge] })).status).toBe(400);
  });

  it("gives the sessions in pages", async () => {
    const bob = await registerUser(server, "backupp");
    const api = apiFor(server, bob);
    const keys = await new TestDeviceKeys(bob).upload(server);
    const { version } = (await api.post("/keys/backup/version", backupBody(bob, keys))).body;
    const sessions = Array.from({ length: 25 }, (_, i) => session("333", i));
    await api.put("/keys/backup/sessions", { version, sessions });

    const seen: string[] = [];
    let after: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const query: string = `/keys/backup/sessions?version=${version}&limit=10${after ? `&after=${encodeURIComponent(after)}` : ""}`;
      const result = (await api.get(query)).body;
      seen.push(...result.sessions.map((entry: { sessionId: string }) => entry.sessionId));
      after = result.next;
      if (!after) {
        break;
      }
    }
    expect(seen).toHaveLength(25);
    expect(new Set(seen)).toEqual(new Set(sessions.map((entry) => entry.sessionId)));
  });

  it("keeps secrets, replaces an old version with a new one, and deletes a version", async () => {
    const carol = await registerUser(server, "backups");
    const api = apiFor(server, carol);
    const keys = await new TestDeviceKeys(carol).upload(server);
    const { version } = (await api.post("/keys/backup/version", backupBody(carol, keys))).body;
    await api.put("/keys/backup/sessions", { version, sessions: [session("444", 0)] });
    const master = encodeBase64Url(randomBytes(80));
    expect((await api.put("/keys/backup/secrets", { version, secrets: { master, "settings:AAAAAAAAAAA": "AAAA" } })).status).toBe(204);
    expect((await api.get("/keys/backup/version")).body.backup.secrets).toEqual({ master, "settings:AAAAAAAAAAA": "AAAA" });
    const secrets = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`settings:k${i}`, "AAAA"]));
    expect((await api.put("/keys/backup/secrets", { version, secrets })).body.error.code).toBe("TOO_MANY_SECRETS");
    expect((await api.put("/keys/backup/secrets", { version, secrets: { "Bad Name": "AAAA" } })).status).toBe(400);

    const next = (await api.post("/keys/backup/version", backupBody(carol, keys))).body.version;
    expect(next).toBe(version + 1);
    const current = (await api.get("/keys/backup/version")).body.backup;
    expect(current.version).toBe(next);
    expect(current.secrets).toEqual({});
    // The old version is gone with its data.
    expect((await api.put("/keys/backup/sessions", { version, sessions: [session("444", 0)] })).body.error.code).toBe("BACKUP_NOT_FOUND");
    expect((await api.get(`/keys/backup/sessions?version=${version}`)).status).toBe(404);

    expect((await api.del(`/keys/backup/version/${next}`)).status).toBe(204);
    expect((await api.get("/keys/backup/version")).body).toEqual({ backup: null });
    expect((await api.del(`/keys/backup/version/${next}`)).status).toBe(404);
  });

  it("lets only the owner reach a backup", async () => {
    const owner = await registerUser(server, "backupo");
    const other = await registerUser(server, "backupx");
    await makeFriends(server, owner, other);
    const ownerKeys = await new TestDeviceKeys(owner).upload(server);
    const { version } = (await apiFor(server, owner).post("/keys/backup/version", backupBody(owner, ownerKeys))).body;
    await apiFor(server, owner).put("/keys/backup/sessions", { version, sessions: [session("555", 0)] });

    const otherApi = apiFor(server, other);
    expect((await otherApi.get("/keys/backup/version")).body).toEqual({ backup: null });
    expect((await otherApi.get(`/keys/backup/sessions?version=${version}`)).status).toBe(404);
    expect((await otherApi.put("/keys/backup/sessions", { version, sessions: [session("555", 0)] })).status).toBe(404);
    expect((await otherApi.put("/keys/backup/secrets", { version, secrets: { master: "AAAA" } })).status).toBe(404);
    expect((await otherApi.del(`/keys/backup/version/${version}`)).status).toBe(404);
    // A backup signed by a device of a different user is rejected.
    const otherKeys = await new TestDeviceKeys(other).upload(server);
    const stolen = backupBody(owner, ownerKeys);
    expect((await otherApi.post("/keys/backup/version", stolen)).body.error.code).toBe("INVALID_SIGNATURE");
    expect((await otherApi.post("/keys/backup/version", backupBody(other, otherKeys))).status).toBe(201);
    expect((await apiFor(server, owner).get("/keys/backup/version")).body.backup.version).toBe(version);
    expect((await server.app.inject({ method: "GET", url: "/api/v1/keys/backup/version" })).statusCode).toBe(401);
  });

  it("stores the master signature of a different device only when the master key made it", async () => {
    const dana = await registerUser(server, "signd");
    const first = await new TestDeviceKeys(dana).upload(server);
    const master = new TestSigner();
    await apiFor(server, dana).put("/keys/master", first.masterBody(master));
    const second = await loginNewDevice(server, dana);
    const secondKeys = await new TestDeviceKeys(second).upload(server);
    const watcher = await connectGateway(server, dana);

    const text = deviceKeysSignedText(dana.userId, second.deviceId, secondKeys.curve25519, secondKeys.signer.publicKey);
    const api = apiFor(server, dana);
    const forged = await api.post("/keys/signatures", { deviceId: second.deviceId, signature: new TestSigner().sign(text) });
    expect(forged.body.error.code).toBe("INVALID_SIGNATURE");
    const wrongText = await api.post("/keys/signatures", { deviceId: second.deviceId, signature: master.sign("x") });
    expect(wrongText.body.error.code).toBe("INVALID_SIGNATURE");

    const signature = master.sign(text);
    expect((await api.post("/keys/signatures", { deviceId: second.deviceId, signature })).status).toBe(204);
    await watcher.event("DEVICE_LIST_UPDATE", (d) => d.userId === dana.userId);
    const [entry] = (await api.post("/keys/query", { userIds: [dana.userId] })).body.users;
    expect(entry.devices.find((device: { deviceId: string }) => device.deviceId === second.deviceId).masterSignature).toBe(signature);

    // A device of a different user cannot be signed.
    const eve = await registerUser(server, "signe");
    await new TestDeviceKeys(eve).upload(server);
    expect((await api.post("/keys/signatures", { deviceId: eve.deviceId, signature })).status).toBe(403);
    watcher.close();
  });

  it("resets the master key only with the auth key of the password, and clears the old signatures and the backup", async () => {
    const erin = await registerUser(server, "reset");
    const first = await new TestDeviceKeys(erin).upload(server);
    const oldMaster = new TestSigner();
    await apiFor(server, erin).put("/keys/master", first.masterBody(oldMaster));
    const { version } = (await apiFor(server, erin).post("/keys/backup/version", backupBody(erin, first))).body;
    expect(version).toBeGreaterThan(0);

    const second = await loginNewDevice(server, erin);
    const secondKeys = await new TestDeviceKeys(second).upload(server);
    const newMaster = new TestSigner();
    const api = apiFor(server, second);
    const wrong = await api.post("/keys/master/reset", { ...secondKeys.masterBody(newMaster), authKey: testAuthKey("wrong-password") });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe("INVALID_PASSWORD");
    const badSignature = { ...secondKeys.masterBody(newMaster), masterSignature: oldMaster.sign("x"), authKey: testAuthKey() };
    expect((await api.post("/keys/master/reset", badSignature)).body.error.code).toBe("INVALID_SIGNATURE");
    // PUT /keys/master never replaces a key.
    expect((await api.put("/keys/master", secondKeys.masterBody(newMaster))).body.error.code).toBe("MASTER_KEY_EXISTS");

    const reset = await api.post("/keys/master/reset", { ...secondKeys.masterBody(newMaster), authKey: testAuthKey() });
    expect(reset.status).toBe(204);
    const [entry] = (await api.post("/keys/query", { userIds: [erin.userId] })).body.users;
    expect(entry.masterKey.publicKey).toBe(newMaster.publicKey);
    expect(entry.masterKey.deviceId).toBe(second.deviceId);
    const signatures = Object.fromEntries(
      entry.devices.map((device: { deviceId: string; masterSignature: string | null }) => [device.deviceId, device.masterSignature]),
    );
    expect(signatures[erin.deviceId]).toBeNull();
    expect(signatures[second.deviceId]).toBe(secondKeys.masterBody(newMaster).masterSignature);
    expect((await api.get("/keys/backup/version")).body).toEqual({ backup: null });
  });
});
