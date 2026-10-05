// Integration tests for the gateway side of messages: EVENT_CREATE and
// EVENT_REDACT fan-out, TYPING_START throttling, and READ_STATE_UPDATE
// reaching only a user's other sessions. Real Postgres and a real `ws`
// client, same approach as modules/gateway/gateway.test.ts.
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { encodeBase64Url, encodePlainPayload, GatewayOpcode, Permission, type GatewayEnvelope } from "@mortium/shared";
import { buildApp } from "../../app.js";
import { permissionOverwrites } from "../../db/schema.js";
import { createFakeMailer } from "../../mailer.js";
import { createTestDb, describeWithDb, type TestDb } from "../../../test/db.js";
import { buildTestConfig, mkTempDataDir, passwordFields, testAuthKey } from "../../../test/helpers.js";
import { GatewayService } from "../gateway/service.js";

vi.setConfig({ testTimeout: 10_000 });

const HEARTBEAT_INTERVAL_MS = 30_000;
const IDENTIFY_TIMEOUT_MS = 2_000;

let testDb: TestDb;
let app: FastifyInstance;
let baseUrl: string;
let gateway: GatewayService;
let userCounter = 0;

interface Session {
  ws: WebSocket;
  accessToken: string;
  deviceId: string;
  userId: string;
}

const messageQueues = new WeakMap<WebSocket, GatewayEnvelope[]>();

function queueFor(ws: WebSocket): GatewayEnvelope[] {
  let queue = messageQueues.get(ws);
  if (!queue) {
    queue = [];
    messageQueues.set(ws, queue);
    ws.on("message", (data: WebSocket.RawData) => {
      queue!.push(JSON.parse(data.toString()) as GatewayEnvelope);
    });
  }
  return queue;
}

function nextMessage(ws: WebSocket, predicate?: (env: GatewayEnvelope) => boolean): Promise<GatewayEnvelope> {
  const queue = queueFor(ws);
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 8000;
    function tryConsume() {
      const index = queue.findIndex((env) => !predicate || predicate(env));
      if (index !== -1) {
        const env = queue.splice(index, 1)[0]!;
        resolve(env);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`Timed out waiting for a gateway message. Queue had: ${JSON.stringify(queue)}`));
        return;
      }
      setTimeout(tryConsume, 10);
    }
    tryConsume();
  });
}

/** True if no message matching `predicate` shows up within `withinMs`. */
async function neverArrives(ws: WebSocket, predicate: (env: GatewayEnvelope) => boolean, withinMs: number): Promise<boolean> {
  try {
    await new Promise<GatewayEnvelope>((resolve, reject) => {
      const queue = queueFor(ws);
      const deadline = Date.now() + withinMs;
      function tryConsume() {
        const index = queue.findIndex(predicate);
        if (index !== -1) {
          resolve(queue[index]!);
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error("timeout"));
          return;
        }
        setTimeout(tryConsume, 10);
      }
      tryConsume();
    });
    return false;
  } catch {
    return true;
  }
}

async function connectRaw(): Promise<WebSocket> {
  const ws = new WebSocket(`${baseUrl}/gateway`);
  queueFor(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return ws;
}

async function registerUser(): Promise<{ accessToken: string; deviceId: string; userId: string; email: string }> {
  userCounter += 1;
  const email = `msggw-user${userCounter}@example.com`;
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, username: `msggwuser${userCounter}`, ...passwordFields() },
  });
  const body = response.json() as { accessToken: string; deviceId: string; user: { id: string } };
  return { accessToken: body.accessToken, deviceId: body.deviceId, userId: body.user.id, email };
}

async function identify(): Promise<{ session: Session; ready: GatewayEnvelope }> {
  const user = await registerUser();
  const ws = await connectRaw();
  await nextMessage(ws, (env) => env.op === GatewayOpcode.HELLO);
  ws.send(JSON.stringify({ op: GatewayOpcode.IDENTIFY, d: { accessToken: user.accessToken, deviceId: user.deviceId } }));
  const ready = await nextMessage(ws, (env) => env.t === "READY");
  return { session: { ws, ...user }, ready };
}

/** Connect and IDENTIFY a raw socket for an already-registered user (no new registration). */
async function identifyExisting(user: { accessToken: string; deviceId: string; userId: string }): Promise<Session> {
  const ws = await connectRaw();
  await nextMessage(ws, (env) => env.op === GatewayOpcode.HELLO);
  ws.send(JSON.stringify({ op: GatewayOpcode.IDENTIFY, d: { accessToken: user.accessToken, deviceId: user.deviceId } }));
  await nextMessage(ws, (env) => env.t === "READY");
  return { ws, ...user };
}

async function createGuild(accessToken: string, name = "Message Gateway Guild") {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/guilds",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name },
  });
  return response.json() as { id: string; channels: Array<{ id: string; type: string }> };
}

function textChannelOf(guild: { channels: Array<{ id: string; type: string }> }): string {
  return guild.channels.find((c) => c.type === "text")!.id;
}

async function inviteAndJoin(ownerToken: string, channelId: string, joinerToken: string): Promise<void> {
  const invite = await app.inject({
    method: "POST",
    url: `/api/v1/channels/${channelId}/invites`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: {},
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/invites/${invite.json().code}`,
    headers: { authorization: `Bearer ${joinerToken}` },
  });
}

function messageCiphertext(body: string): string {
  return encodeBase64Url(encodePlainPayload({ type: "message", body, mentions: [], attachments: [], embeds: [] }));
}

async function postMessage(token: string, channelId: string, body: string) {
  return app.inject({
    method: "POST",
    url: `/api/v1/channels/${channelId}/events`,
    headers: { authorization: `Bearer ${token}` },
    payload: { codec: "megolm-v1", megolmSessionId: "test-session", ciphertext: messageCiphertext(body), nonce: `${Date.now()}-${Math.random()}` },
  });
}

describeWithDb("messages gateway", () => {
  beforeAll(async () => {
    testDb = await createTestDb();
    const dataDir = await mkTempDataDir();
    gateway = new GatewayService();
    app = await buildApp({
      db: testDb.db,
      config: buildTestConfig({ dataDir }),
      mailer: createFakeMailer(),
      rateLimit: false,
      gateway,
      gatewayTiming: { heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS, identifyTimeoutMs: IDENTIFY_TIMEOUT_MS },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `ws://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app.close();
    await testDb.close();
  });

  const openSockets: WebSocket[] = [];
  afterEach(() => {
    for (const ws of openSockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }
    openSockets.length = 0;
  });

  it("sends EVENT_CREATE to a channel viewer once a message posts", async () => {
    const owner = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const channelId = textChannelOf(guild);
    const { session } = await identify();
    openSockets.push(session.ws);
    await inviteAndJoin(owner.accessToken, channelId, session.accessToken);

    const eventCreatePromise = nextMessage(session.ws, (env) => env.t === "EVENT_CREATE");
    await postMessage(owner.accessToken, channelId, "hi viewer");
    const dispatch = await eventCreatePromise;
    expect((dispatch.d as { channelId: string }).channelId).toBe(channelId);
  });

  it("does not send EVENT_CREATE to a member who cannot view the channel", async () => {
    const owner = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const channelId = textChannelOf(guild);
    const { session } = await identify();
    openSockets.push(session.ws);
    await inviteAndJoin(owner.accessToken, channelId, session.accessToken);

    // Deny VIEW_CHANNEL for this member directly, the way a real overwrite
    // would (this milestone does not yet ship the overwrite-editing route).
    await testDb.db.insert(permissionOverwrites).values({
      channelId: BigInt(channelId),
      targetId: BigInt(session.userId),
      targetType: "member",
      allow: 0n,
      deny: Permission.VIEW_CHANNEL,
    });

    await postMessage(owner.accessToken, channelId, "not for you");
    const missed = await neverArrives(session.ws, (env) => env.t === "EVENT_CREATE", 500);
    expect(missed).toBe(true);
  });

  it("sends EVENT_REDACT with the target and its relations once redacted", async () => {
    const owner = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const channelId = textChannelOf(guild);
    const { session } = await identify();
    openSockets.push(session.ws);
    await inviteAndJoin(owner.accessToken, channelId, session.accessToken);

    const message = await postMessage(owner.accessToken, channelId, "will be redacted");
    const messageId = message.json().id as string;

    const redactPromise = nextMessage(session.ws, (env) => env.t === "EVENT_REDACT");
    await app.inject({
      method: "DELETE",
      url: `/api/v1/channels/${channelId}/events/${messageId}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const dispatch = await redactPromise;
    expect((dispatch.d as { ids: string[] }).ids).toContain(messageId);
  });

  it("sends TYPING_START to other viewers but never echoes it to the sender", async () => {
    const owner = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const channelId = textChannelOf(guild);
    const ownerSession = await identifyExisting(owner);
    openSockets.push(ownerSession.ws);

    const { session: viewerSession } = await identify();
    openSockets.push(viewerSession.ws);
    await inviteAndJoin(owner.accessToken, channelId, viewerSession.accessToken);

    const typingPromise = nextMessage(viewerSession.ws, (env) => env.t === "TYPING_START");
    ownerSession.ws.send(JSON.stringify({ op: GatewayOpcode.TYPING, d: { channelId } }));
    const dispatch = await typingPromise;
    expect((dispatch.d as { userId: string }).userId).toBe(owner.userId);

    const echoed = await neverArrives(ownerSession.ws, (env) => env.t === "TYPING_START", 300);
    expect(echoed).toBe(true);
  });

  it("throttles TYPING_START per user and channel", async () => {
    const owner = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const channelId = textChannelOf(guild);
    const ownerSession = await identifyExisting(owner);
    openSockets.push(ownerSession.ws);

    const { session: viewerSession } = await identify();
    openSockets.push(viewerSession.ws);
    await inviteAndJoin(owner.accessToken, channelId, viewerSession.accessToken);

    const first = nextMessage(viewerSession.ws, (env) => env.t === "TYPING_START");
    ownerSession.ws.send(JSON.stringify({ op: GatewayOpcode.TYPING, d: { channelId } }));
    await first;

    ownerSession.ws.send(JSON.stringify({ op: GatewayOpcode.TYPING, d: { channelId } }));
    const missed = await neverArrives(viewerSession.ws, (env) => env.t === "TYPING_START", 500);
    expect(missed).toBe(true);
  });

  it("lets TYPING through at once after the user sends a message", async () => {
    const owner = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const channelId = textChannelOf(guild);
    const ownerSession = await identifyExisting(owner);
    openSockets.push(ownerSession.ws);

    const { session: viewerSession } = await identify();
    openSockets.push(viewerSession.ws);
    await inviteAndJoin(owner.accessToken, channelId, viewerSession.accessToken);

    const first = nextMessage(viewerSession.ws, (env) => env.t === "TYPING_START");
    ownerSession.ws.send(JSON.stringify({ op: GatewayOpcode.TYPING, d: { channelId } }));
    await first;

    // The message ends the typing state, so the throttle must not block the next TYPING.
    const created = nextMessage(viewerSession.ws, (env) => env.t === "EVENT_CREATE");
    await postMessage(owner.accessToken, channelId, "done typing");
    await created;

    const second = nextMessage(viewerSession.ws, (env) => env.t === "TYPING_START");
    ownerSession.ws.send(JSON.stringify({ op: GatewayOpcode.TYPING, d: { channelId } }));
    await second;
  });

  it("sends READ_STATE_UPDATE only to the user's other sessions", async () => {
    const owner = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const channelId = textChannelOf(guild);

    const ws1 = await connectRaw();
    openSockets.push(ws1);
    await nextMessage(ws1, (env) => env.op === GatewayOpcode.HELLO);
    ws1.send(JSON.stringify({ op: GatewayOpcode.IDENTIFY, d: { accessToken: owner.accessToken, deviceId: owner.deviceId } }));
    await nextMessage(ws1, (env) => env.t === "READY");

    // Register a second device (a fresh login) for the same account.
    const loginResponse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: owner.email, authKey: testAuthKey() },
    });
    const secondDevice = loginResponse.json() as { accessToken: string; deviceId: string };
    const ws2 = await connectRaw();
    openSockets.push(ws2);
    await nextMessage(ws2, (env) => env.op === GatewayOpcode.HELLO);
    ws2.send(JSON.stringify({ op: GatewayOpcode.IDENTIFY, d: { accessToken: secondDevice.accessToken, deviceId: secondDevice.deviceId } }));
    await nextMessage(ws2, (env) => env.t === "READY");

    const message = await postMessage(owner.accessToken, channelId, "read me");

    const updatePromise = nextMessage(ws2, (env) => env.t === "READ_STATE_UPDATE");
    await app.inject({
      method: "PUT",
      url: `/api/v1/channels/${channelId}/read`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { eventId: message.json().id },
    });
    const dispatch = await updatePromise;
    expect((dispatch.d as { channelId: string }).channelId).toBe(channelId);

    const notEchoed = await neverArrives(ws1, (env) => env.t === "READ_STATE_UPDATE", 300);
    expect(notEchoed).toBe(true);
  });
});
