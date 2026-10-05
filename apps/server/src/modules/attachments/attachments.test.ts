// Integration tests for encrypted attachments: upload limits, the quota,
// streaming to disk, permission checks, the claim, the orphan cleanup and
// the download rules. Real Postgres, real files and a real HTTP socket.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, utimes, writeFile, readdir, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { Permission } from "@mortium/shared";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { buildApp } from "../../app.js";
import { attachments, permissionOverwrites } from "../../db/schema.js";
import { createFakeMailer } from "../../mailer.js";
import { createTestDb, describeWithDb, type TestDb } from "../../../test/db.js";
import { buildTestConfig, mkTempDataDir, passwordFields } from "../../../test/helpers.js";
import { attachmentDir, cleanUpAttachments, UNCLAIMED_TTL_MS } from "./service.js";

const MAX_BYTES = 21 * 1024 * 1024;
const QUOTA_BYTES = 22 * 1024 * 1024;

let app: FastifyInstance;
let testDb: TestDb;
let dataDir: string;
let baseUrl: string;
let userCounter = 0;

interface User {
  userId: string;
  username: string;
  token: string;
}

async function registerUser(): Promise<User> {
  userCounter += 1;
  const username = `att${userCounter}`;
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email: `${username}@example.com`, username, ...passwordFields() },
  });
  const body = response.json() as { accessToken: string; user: { id: string } };
  return { userId: body.user.id, username, token: body.accessToken };
}

function auth(user: User) {
  return { authorization: `Bearer ${user.token}` };
}

async function api(user: User, method: "GET" | "POST" | "PUT", url: string, payload?: object) {
  return app.inject({ method, url: `/api/v1${url}`, headers: auth(user), ...(payload ? { payload } : {}) });
}

async function openDm(a: User, b: User): Promise<string> {
  await api(a, "POST", "/users/@me/relationships", { username: b.username });
  await api(b, "PUT", `/users/@me/relationships/${a.userId}`, { action: "accept" });
  return (await api(a, "POST", "/users/@me/channels", { recipientIds: [b.userId] })).json().id as string;
}

async function guildWithMember(): Promise<{ owner: User; member: User; channelId: string }> {
  const owner = await registerUser();
  const member = await registerUser();
  const guild = (await api(owner, "POST", "/guilds", { name: "Files" })).json() as { channels: Array<{ id: string; type: string }> };
  const channelId = guild.channels.find((channel) => channel.type === "text")!.id;
  const invite = (await api(owner, "POST", `/channels/${channelId}/invites`, {})).json() as { code: string };
  await api(member, "POST", `/invites/${invite.code}`);
  return { owner, member, channelId };
}

/** Upload with a real HTTP request. The body is a stream when `chunks` is set. */
async function upload(user: User, channelId: string, body: Uint8Array | { chunks: number; chunkSize: number }) {
  const headers: Record<string, string> = { ...auth(user), "content-type": "application/octet-stream" };
  let requestBody: RequestInit["body"];
  if (body instanceof Uint8Array) {
    requestBody = body;
  } else {
    headers["content-length"] = String(body.chunks * body.chunkSize);
    let sent = 0;
    requestBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === body.chunks) {
          controller.close();
          return;
        }
        sent += 1;
        controller.enqueue(new Uint8Array(body.chunkSize).fill(sent % 256));
      },
    });
  }
  const response = await fetch(`${baseUrl}/api/v1/channels/${channelId}/attachments`, {
    method: "POST",
    headers,
    body: requestBody,
    duplex: "half",
  } as RequestInit);
  return { status: response.status, body: (await response.json()) as { id: string; size: number; error?: { code: string } } };
}

describeWithDb("attachments", () => {
  beforeAll(async () => {
    testDb = await createTestDb();
    dataDir = await mkTempDataDir();
    app = await buildApp({
      db: testDb.db,
      config: buildTestConfig({ dataDir, maxAttachmentBytes: MAX_BYTES, attachmentQuotaBytes: QUOTA_BYTES }),
      mailer: createFakeMailer(),
      rateLimit: false,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await app.close();
    await testDb.close();
  });

  it("stores the ciphertext on disk and serves it to a recipient only", async () => {
    const alice = await registerUser();
    const bob = await registerUser();
    const outsider = await registerUser();
    const channelId = await openDm(alice, bob);
    const bytes = randomBytes(5000);

    const result = await upload(alice, channelId, bytes);
    expect(result.status).toBe(201);
    expect(result.body.size).toBe(5000);
    expect(await readFile(path.join(attachmentDir(dataDir), result.body.id))).toEqual(bytes);

    const download = await api(bob, "GET", `/attachments/${result.body.id}`);
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload).toEqual(bytes);
    expect(download.headers["cache-control"]).toContain("private");
    expect(download.headers["content-type"]).toBe("application/octet-stream");

    expect((await api(outsider, "GET", `/attachments/${result.body.id}`)).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/v1/attachments/${result.body.id}` })).statusCode).toBe(401);
    expect((await upload(outsider, channelId, bytes)).status).toBe(404);
  });

  it("rejects a file above the size limit, a wrong content type and an upload above the quota", async () => {
    const alice = await registerUser();
    const bob = await registerUser();
    const channelId = await openDm(alice, bob);

    const tooLarge = await app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/attachments`,
      headers: { ...auth(alice), "content-type": "application/octet-stream", "content-length": String(MAX_BYTES + 1) },
      payload: Buffer.alloc(10),
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json().error.code).toBe("ATTACHMENT_TOO_LARGE");

    const wrongType = await app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/attachments`,
      headers: { ...auth(alice), "content-type": "text/plain" },
      payload: "hello",
    });
    expect(wrongType.statusCode).toBe(415);

    expect((await upload(alice, channelId, { chunks: 20, chunkSize: 1024 * 1024 })).status).toBe(201);
    const overQuota = await upload(alice, channelId, { chunks: 3, chunkSize: 1024 * 1024 });
    expect(overQuota.status).toBe(413);
    expect(overQuota.body.error?.code).toBe("QUOTA_EXCEEDED");
  });

  it("streams a 20 MiB upload to disk without a large rise in memory", async () => {
    const alice = await registerUser();
    const bob = await registerUser();
    const channelId = await openDm(alice, bob);
    // Warm up the route, so that the measure does not include the first load of code.
    await upload(alice, channelId, randomBytes(1024));
    // Collect garbage before each sample, so that the samples show live memory only.
    // Take only two samples: a full collection stops the server of this process too.
    // A sample on a timer during the upload made the upload many times slower.
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    const used = async () => {
      gc();
      await new Promise((resolve) => setImmediate(resolve));
      gc();
      const usage = process.memoryUsage();
      return usage.heapUsed + usage.arrayBuffers;
    };
    const before = await used();
    // A different process sends the body, so that only the server side counts here.
    // It sends the first half, then it stops until it gets a line on its stdin.
    const size = 20 * 1024 * 1024;
    const half = size / 2;
    const script = `
      const size = ${size};
      const half = ${half};
      let sent = 0;
      const chunk = new Uint8Array(65536).fill(7);
      const resume = new Promise((resolve) => process.stdin.once("data", resolve));
      const body = new ReadableStream({ async pull(c) {
        if (sent === half) await resume;
        if (sent >= size) { c.close(); process.stdin.destroy(); return; }
        sent += chunk.length; c.enqueue(chunk.slice()); } });
      fetch(process.argv[1], { method: "POST", duplex: "half", body, headers: {
        authorization: "Bearer ${alice.token}", "content-type": "application/octet-stream", "content-length": String(size) } })
        .then(async (r) => { process.stdout.write(r.status + " " + (await r.text())); });
    `;
    const child = spawn(process.execPath, ["-e", script, `${baseUrl}/api/v1/channels/${channelId}/attachments`]);
    const output = new Promise<string>((resolve, reject) => {
      let text = "";
      child.stdout.on("data", (data: Buffer) => (text += data.toString()));
      child.on("error", reject);
      child.on("close", () => resolve(text));
    });
    // The server must write the first half to disk before the client sends the rest.
    const dir = attachmentDir(dataDir);
    const tempSize = async () => {
      const names = (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
      return names.length === 1 ? (await stat(path.join(dir, names[0]!))).size : 0;
    };
    await vi.waitFor(async () => expect(await tempSize()).toBe(half), { timeout: 4_000, interval: 20 });
    // A buffered upload would hold the first half (10 MiB) in memory now.
    const during = await used();
    child.stdin.end("continue\n");
    const text = await output;
    expect(text.startsWith("201")).toBe(true);
    expect(JSON.parse(text.slice(4)).size).toBe(size);
    expect(during - before).toBeLessThan(4 * 1024 * 1024);
  });

  it("needs ATTACH_FILES and SEND_MESSAGES to upload, and READ_MESSAGE_HISTORY to download", async () => {
    const { owner, member, channelId } = await guildWithMember();
    const uploaded = await upload(owner, channelId, randomBytes(100));
    expect(uploaded.status).toBe(201);
    expect((await api(member, "GET", `/attachments/${uploaded.body.id}`)).statusCode).toBe(200);

    await testDb.db.insert(permissionOverwrites).values({
      channelId: BigInt(channelId),
      targetId: BigInt(member.userId),
      targetType: "member",
      allow: 0n,
      deny: Permission.ATTACH_FILES | Permission.READ_MESSAGE_HISTORY,
    });
    const denied = await upload(member, channelId, randomBytes(100));
    expect(denied.status).toBe(403);
    expect((await api(member, "GET", `/attachments/${uploaded.body.id}`)).statusCode).toBe(403);

    await testDb.db
      .update(permissionOverwrites)
      .set({ deny: Permission.SEND_MESSAGES })
      .where(eq(permissionOverwrites.targetId, BigInt(member.userId)));
    expect((await upload(member, channelId, randomBytes(100))).status).toBe(403);
  });

  it("claims only for the uploader, more than one time, and deletes unclaimed and orphan files after 24 hours", async () => {
    const alice = await registerUser();
    const bob = await registerUser();
    const channelId = await openDm(alice, bob);
    const claimed = await upload(alice, channelId, randomBytes(10));
    const unclaimed = await upload(alice, channelId, randomBytes(10));

    expect((await api(bob, "POST", `/attachments/${claimed.body.id}/claim`)).statusCode).toBe(404);
    expect((await api(alice, "POST", `/attachments/${claimed.body.id}/claim`)).statusCode).toBe(204);
    expect((await api(alice, "POST", `/attachments/${claimed.body.id}/claim`)).statusCode).toBe(204);

    // A file with no row, as after a channel delete, and an old temp file.
    const dir = attachmentDir(dataDir);
    await mkdir(dir, { recursive: true });
    const old = new Date(Date.now() - UNCLAIMED_TTL_MS - 60_000);
    await writeFile(path.join(dir, "123456789"), "orphan");
    await utimes(path.join(dir, "123456789"), old, old);
    await writeFile(path.join(dir, "987654321.tmp"), "partial");
    await utimes(path.join(dir, "987654321.tmp"), old, old);

    // A fresh unclaimed file stays.
    await cleanUpAttachments(testDb.db, dataDir);
    expect(await readdir(dir)).toContain(unclaimed.body.id);

    await testDb.db.update(attachments).set({ createdAt: old });
    await cleanUpAttachments(testDb.db, dataDir);
    const names = await readdir(dir);
    expect(names).toContain(claimed.body.id);
    expect(names).not.toContain(unclaimed.body.id);
    expect(names).not.toContain("123456789");
    expect(names).not.toContain("987654321.tmp");
    expect((await api(alice, "GET", `/attachments/${unclaimed.body.id}`)).statusCode).toBe(404);
    expect((await api(bob, "GET", `/attachments/${claimed.body.id}`)).statusCode).toBe(200);
  });
});
