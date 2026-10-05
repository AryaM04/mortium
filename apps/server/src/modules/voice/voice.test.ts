// Integration tests for voice signaling: VOICE_JOIN, VOICE_LEAVE,
// VOICE_STATE, the call id, the disconnect grace period, and the
// turn-credentials route. Real Postgres and a real `ws` client, the same
// approach as modules/gateway/gateway.test.ts.
import type { FastifyInstance } from "fastify";
import { createHmac } from "node:crypto";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GatewayCloseCode, GatewayOpcode, Permission, type GatewayEnvelope } from "@mortium/shared";
import { buildApp } from "../../app.js";
import { permissionOverwrites } from "../../db/schema.js";
import { createFakeMailer } from "../../mailer.js";
import { createTestDb, describeWithDb, type TestDb } from "../../../test/db.js";
import { buildTestConfig, mkTempDataDir, passwordFields, testAuthKey } from "../../../test/helpers.js";
import { GatewayService } from "../gateway/service.js";
import { VoiceService } from "./service.js";

vi.setConfig({ testTimeout: 10_000 });

const HEARTBEAT_INTERVAL_MS = 30_000;
const IDENTIFY_TIMEOUT_MS = 2_000;
const VOICE_GRACE_MS = 400;

let testDb: TestDb;
let app: FastifyInstance;
let baseUrl: string;
let gateway: GatewayService;
let voice: VoiceService;
let userCounter = 0;

interface Session {
  ws: WebSocket;
  accessToken: string;
  deviceId: string;
  userId: string;
  email: string;
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

function onClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

function sendOp(ws: WebSocket, op: number, d: unknown = {}): void {
  ws.send(JSON.stringify({ op, d }));
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
  const email = `voice-user${userCounter}@example.com`;
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, username: `voiceuser${userCounter}`, ...passwordFields() },
  });
  const body = response.json() as { accessToken: string; deviceId: string; user: { id: string } };
  return { accessToken: body.accessToken, deviceId: body.deviceId, userId: body.user.id, email };
}

async function loginNewDevice(email: string): Promise<{ accessToken: string; deviceId: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, authKey: testAuthKey() },
  });
  const body = response.json() as { accessToken: string; deviceId: string };
  return { accessToken: body.accessToken, deviceId: body.deviceId };
}

async function identifyExisting(
  user: { accessToken: string; deviceId: string; userId: string; email: string },
): Promise<Session & { ready: GatewayEnvelope }> {
  const ws = await connectRaw();
  await nextMessage(ws, (env) => env.op === GatewayOpcode.HELLO);
  sendOp(ws, GatewayOpcode.IDENTIFY, { accessToken: user.accessToken, deviceId: user.deviceId });
  const ready = await nextMessage(ws, (env) => env.t === "READY");
  return { ws, ...user, ready };
}

async function identify(): Promise<Session> {
  const user = await registerUser();
  return identifyExisting(user);
}

async function createGuild(accessToken: string, name = "Voice Guild") {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/guilds",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name },
  });
  return response.json() as { id: string; channels: Array<{ id: string; type: string; name: string | null }> };
}

function textChannelOf(guild: { channels: Array<{ id: string; type: string }> }): string {
  return guild.channels.find((c) => c.type === "text")!.id;
}

function voiceChannelOf(guild: { channels: Array<{ id: string; type: string }> }): string {
  return guild.channels.find((c) => c.type === "voice")!.id;
}

async function createVoiceChannel(ownerToken: string, guildId: string, name = "extra-voice") {
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/guilds/${guildId}/channels`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { name, type: "voice" },
  });
  return (response.json() as { id: string }).id;
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

/**
 * Send VOICE_JOIN and wait for either the resulting VOICE_STATE_UPDATE (own
 * state) or a VOICE_ERROR. `selfUserId` is required because the joining
 * socket is itself a viewer of the channel: a VOICE_STATE_UPDATE for
 * someone else already in the channel (or a stale leave from a move) can
 * otherwise be mistaken for this join's own result.
 */
async function joinVoice(
  ws: WebSocket,
  selfUserId: string,
  channelId: string,
  opts: { selfMute?: boolean; selfDeaf?: boolean } = {},
): Promise<GatewayEnvelope> {
  const resultPromise = nextMessage(
    ws,
    (env) =>
      (env.t === "VOICE_STATE_UPDATE" &&
        (env.d as { channelId: string | null; userId: string }).channelId === channelId &&
        (env.d as { userId: string }).userId === selfUserId) ||
      env.t === "VOICE_ERROR",
  );
  sendOp(ws, GatewayOpcode.VOICE_JOIN, {
    channelId,
    selfMute: opts.selfMute ?? false,
    selfDeaf: opts.selfDeaf ?? false,
  });
  return resultPromise;
}

describeWithDb("voice", () => {
  beforeAll(async () => {
    testDb = await createTestDb();
    const dataDir = await mkTempDataDir();
    gateway = new GatewayService();
    voice = new VoiceService(VOICE_GRACE_MS);
    app = await buildApp({
      db: testDb.db,
      config: buildTestConfig({ dataDir }),
      mailer: createFakeMailer(),
      rateLimit: false,
      gateway,
      voice,
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

  it("broadcasts VOICE_STATE_UPDATE to another member, but not to a non-viewer", async () => {
    const owner = await registerUser();
    const ownerSession = await identifyExisting(owner);
    openSockets.push(ownerSession.ws);
    const guild = await createGuild(owner.accessToken);
    const voiceChannelId = voiceChannelOf(guild);
    const member = await identify();
    openSockets.push(member.ws);
    await inviteAndJoin(owner.accessToken, textChannelOf(guild), member.accessToken);

    const outsider = await identify();
    openSockets.push(outsider.ws);

    const memberPromise = nextMessage(member.ws, (env) => env.t === "VOICE_STATE_UPDATE");
    const joined = await joinVoice(ownerSession.ws, owner.userId, voiceChannelId);
    expect(joined.t).toBe("VOICE_STATE_UPDATE");

    const dispatch = await memberPromise;
    const d = dispatch.d as { channelId: string | null; userId: string; guildId: string };
    expect(d.channelId).toBe(voiceChannelId);
    expect(d.userId).toBe(owner.userId);
    expect(d.guildId).toBe(guild.id);

    const missed = await neverArrives(outsider.ws, (env) => env.t === "VOICE_STATE_UPDATE", 400);
    expect(missed).toBe(true);
  });

  it("includes voiceStates in READY and GUILD_CREATE", async () => {
    const owner = await registerUser();
    const ownerSession = await identifyExisting(owner);
    openSockets.push(ownerSession.ws);

    const readyPromise = nextMessage(ownerSession.ws, (env) => env.t === "GUILD_CREATE");
    const guild = await createGuild(owner.accessToken);
    const created = await readyPromise;
    expect((created.d as { voiceStates: unknown[] }).voiceStates).toEqual([]);

    const voiceChannelId = voiceChannelOf(guild);
    await joinVoice(ownerSession.ws, owner.userId, voiceChannelId);

    const second = await identifyExisting(owner);
    openSockets.push(second.ws);
    const ready = second.ready;
    const readyGuild = (ready.d as { guilds: Array<{ id: string; voiceStates: Array<{ channelId: string; userId: string }> }> }).guilds.find(
      (g) => g.id === guild.id,
    )!;
    expect(readyGuild.voiceStates).toHaveLength(1);
    expect(readyGuild.voiceStates[0]!.channelId).toBe(voiceChannelId);
    expect(readyGuild.voiceStates[0]!.userId).toBe(owner.userId);
  });

  it("rejects an 11th peer with CHANNEL_FULL", async () => {
    const owner = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const voiceChannelId = voiceChannelOf(guild);
    const ownerSession = await identifyExisting(owner);
    openSockets.push(ownerSession.ws);
    const ownerJoin = await joinVoice(ownerSession.ws, owner.userId, voiceChannelId);
    expect(ownerJoin.t).toBe("VOICE_STATE_UPDATE");

    const memberSessions: Session[] = [];
    for (let i = 0; i < 9; i++) {
      const member = await identify();
      openSockets.push(member.ws);
      await inviteAndJoin(owner.accessToken, textChannelOf(guild), member.accessToken);
      const result = await joinVoice(member.ws, member.userId, voiceChannelId);
      expect(result.t).toBe("VOICE_STATE_UPDATE");
      memberSessions.push(member);
    }
    // Owner + 9 members = 10 peers, the cap.

    const eleventh = await identify();
    openSockets.push(eleventh.ws);
    await inviteAndJoin(owner.accessToken, textChannelOf(guild), eleventh.accessToken);
    const rejected = await joinVoice(eleventh.ws, eleventh.userId, voiceChannelId);
    expect(rejected.t).toBe("VOICE_ERROR");
    expect((rejected.d as { code: string }).code).toBe("CHANNEL_FULL");
  });

  it("rejects VOICE_JOIN with NO_PERMISSION when the member lacks CONNECT", async () => {
    const owner = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const voiceChannelId = voiceChannelOf(guild);
    const member = await identify();
    openSockets.push(member.ws);
    await inviteAndJoin(owner.accessToken, textChannelOf(guild), member.accessToken);

    // Deny CONNECT for this member directly, the way a real overwrite
    // would (this milestone does not yet ship the overwrite-editing route).
    await testDb.db.insert(permissionOverwrites).values({
      channelId: BigInt(voiceChannelId),
      targetId: BigInt(member.userId),
      targetType: "member",
      allow: 0n,
      deny: Permission.CONNECT,
    });

    const result = await joinVoice(member.ws, member.userId, voiceChannelId);
    expect(result.t).toBe("VOICE_ERROR");
    expect((result.d as { code: string }).code).toBe("NO_PERMISSION");
  });

  it("forces mute when the member lacks SPEAK, and rejects an unmute", async () => {
    const owner = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const voiceChannelId = voiceChannelOf(guild);
    const member = await identify();
    openSockets.push(member.ws);
    await inviteAndJoin(owner.accessToken, textChannelOf(guild), member.accessToken);

    await testDb.db.insert(permissionOverwrites).values({
      channelId: BigInt(voiceChannelId),
      targetId: BigInt(member.userId),
      targetType: "member",
      allow: 0n,
      deny: Permission.SPEAK,
    });

    const joined = await joinVoice(member.ws, member.userId, voiceChannelId, { selfMute: false });
    expect(joined.t).toBe("VOICE_STATE_UPDATE");
    expect((joined.d as { selfMute: boolean }).selfMute).toBe(true);

    const errorPromise = nextMessage(member.ws, (env) => env.t === "VOICE_ERROR");
    sendOp(member.ws, GatewayOpcode.VOICE_STATE, { selfMute: false });
    const error = await errorPromise;
    expect((error.d as { code: string }).code).toBe("NO_PERMISSION");
  });

  it("replaces the first device's voice state when a second device joins", async () => {
    const owner = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const voiceChannelId = voiceChannelOf(guild);
    const first = await identifyExisting(owner);
    openSockets.push(first.ws);
    await joinVoice(first.ws, owner.userId, voiceChannelId);

    const secondDevice = await loginNewDevice(owner.email);
    const second = await identifyExisting({ ...owner, ...secondDevice });
    openSockets.push(second.ws);

    const firstLeavePromise = nextMessage(first.ws, (env) => env.t === "VOICE_STATE_UPDATE" && (env.d as { channelId: string | null }).channelId === null);
    const joined = await joinVoice(second.ws, owner.userId, voiceChannelId);
    expect(joined.t).toBe("VOICE_STATE_UPDATE");
    expect((joined.d as { deviceId: string }).deviceId).toBe(secondDevice.deviceId);

    const leftDispatch = await firstLeavePromise;
    expect((leftDispatch.d as { deviceId: string }).deviceId).toBe(owner.deviceId);
  });

  it("moves a peer between channels, leaving the old one and joining the new one", async () => {
    const owner = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const firstChannelId = voiceChannelOf(guild);
    const secondChannelId = await createVoiceChannel(owner.accessToken, guild.id);
    const session = await identifyExisting(owner);
    openSockets.push(session.ws);

    await joinVoice(session.ws, owner.userId, firstChannelId);
    const switched = await joinVoice(session.ws, owner.userId, secondChannelId);
    expect(switched.t).toBe("VOICE_STATE_UPDATE");
    expect((switched.d as { channelId: string }).channelId).toBe(secondChannelId);
  });

  it("rejects a second streamer in the same channel with STREAM_IN_USE", async () => {
    const owner = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const voiceChannelId = voiceChannelOf(guild);
    const ownerSession = await identifyExisting(owner);
    openSockets.push(ownerSession.ws);
    const member = await identify();
    openSockets.push(member.ws);
    await inviteAndJoin(owner.accessToken, textChannelOf(guild), member.accessToken);

    await joinVoice(ownerSession.ws, owner.userId, voiceChannelId);
    await joinVoice(member.ws, member.userId, voiceChannelId);

    const ownerStreamPromise = nextMessage(ownerSession.ws, (env) => env.t === "VOICE_STATE_UPDATE" && (env.d as { selfStream: boolean }).selfStream);
    sendOp(ownerSession.ws, GatewayOpcode.VOICE_STATE, { selfStream: true });
    await ownerStreamPromise;

    const errorPromise = nextMessage(member.ws, (env) => env.t === "VOICE_ERROR");
    sendOp(member.ws, GatewayOpcode.VOICE_STATE, { selfStream: true });
    const error = await errorPromise;
    expect((error.d as { code: string }).code).toBe("STREAM_IN_USE");
  });

  describe("voice signals", () => {
    it("puts the call id of a join in the voice state", async () => {
      const owner = await registerUser();
      const guild = await createGuild(owner.accessToken);
      const voiceChannelId = voiceChannelOf(guild);
      const a = await identifyExisting(owner);
      openSockets.push(a.ws);

      const updatePromise = nextMessage(a.ws, (env) => env.t === "VOICE_STATE_UPDATE");
      sendOp(a.ws, GatewayOpcode.VOICE_JOIN, { channelId: voiceChannelId, selfMute: false, selfDeaf: false, callId: "call-1" });
      const update = await updatePromise;
      expect((update.d as { callId?: string }).callId).toBe("call-1");
    });

    it("does not relay plaintext signals: op 14 closes the connection", async () => {
      const owner = await registerUser();
      const guild = await createGuild(owner.accessToken);
      const voiceChannelId = voiceChannelOf(guild);
      const a = await identifyExisting(owner);
      openSockets.push(a.ws);
      await joinVoice(a.ws, owner.userId, voiceChannelId);

      const closed = onClose(a.ws);
      sendOp(a.ws, 14, { channelId: voiceChannelId, targetUserId: owner.userId, targetDeviceId: a.deviceId, payload: {} });
      expect((await closed).code).toBe(GatewayCloseCode.UNKNOWN_OPCODE);
    });
  });

  describe("disconnect grace period", () => {
    it("keeps the voice state when the session resumes within the grace period", async () => {
      const owner = await registerUser();
      const guild = await createGuild(owner.accessToken);
      const voiceChannelId = voiceChannelOf(guild);
      const ws = await connectRaw();
      await nextMessage(ws, (env) => env.op === GatewayOpcode.HELLO);
      sendOp(ws, GatewayOpcode.IDENTIFY, { accessToken: owner.accessToken, deviceId: owner.deviceId });
      const ready = await nextMessage(ws, (env) => env.t === "READY");
      const sessionId = (ready.d as { sessionId: string }).sessionId;
      await joinVoice(ws, owner.userId, voiceChannelId);

      ws.close();
      await onClose(ws);

      const resumeWs = await connectRaw();
      openSockets.push(resumeWs);
      await nextMessage(resumeWs, (env) => env.op === GatewayOpcode.HELLO);
      sendOp(resumeWs, GatewayOpcode.RESUME, { accessToken: owner.accessToken, sessionId, lastSequence: 1 });
      await nextMessage(resumeWs, (env) => env.t === "RESUMED");

      // Wait past the grace period: the state must still be there.
      await new Promise((resolve) => setTimeout(resolve, VOICE_GRACE_MS + 200));
      expect(voice.getUserState(BigInt(owner.userId))?.channelId.toString()).toBe(voiceChannelId);
    });

    it("broadcasts a leave once the grace period passes with no resume", async () => {
      const owner = await registerUser();
      const guild = await createGuild(owner.accessToken);
      const voiceChannelId = voiceChannelOf(guild);
      const ws = await connectRaw();
      await nextMessage(ws, (env) => env.op === GatewayOpcode.HELLO);
      sendOp(ws, GatewayOpcode.IDENTIFY, { accessToken: owner.accessToken, deviceId: owner.deviceId });
      await nextMessage(ws, (env) => env.t === "READY");
      await joinVoice(ws, owner.userId, voiceChannelId);

      const watcher = await identify();
      openSockets.push(watcher.ws);
      await inviteAndJoin(owner.accessToken, textChannelOf(guild), watcher.accessToken);

      const leavePromise = nextMessage(
        watcher.ws,
        (env) => env.t === "VOICE_STATE_UPDATE" && (env.d as { userId: string; channelId: string | null }).userId === owner.userId,
      );
      ws.close();
      await onClose(ws);

      const leave = await leavePromise;
      expect((leave.d as { channelId: string | null }).channelId).toBeNull();
      expect(voice.getUserState(BigInt(owner.userId))).toBeUndefined();
    });
  });

  it("removes voice peers when their channel is deleted", async () => {
    const owner = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const voiceChannelId = voiceChannelOf(guild);
    const ownerSession = await identifyExisting(owner);
    openSockets.push(ownerSession.ws);
    await joinVoice(ownerSession.ws, owner.userId, voiceChannelId);
    expect(voice.getUserState(BigInt(owner.userId))).toBeDefined();

    const leavePromise = nextMessage(ownerSession.ws, (env) => env.t === "VOICE_STATE_UPDATE" && (env.d as { channelId: string | null }).channelId === null);
    await app.inject({
      method: "DELETE",
      url: `/api/v1/channels/${voiceChannelId}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    await leavePromise;
    expect(voice.getUserState(BigInt(owner.userId))).toBeUndefined();
  });

  describe("GET /voice/turn-credentials", () => {
    it("returns ICE servers and a valid HMAC credential", async () => {
      const owner = await registerUser();
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/voice/turn-credentials",
        headers: { authorization: `Bearer ${owner.accessToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        iceServers: Array<{ urls: string[]; username: string; credential: string }>;
        ttlSeconds: number;
        audioBitrateBps: number;
      };
      expect(body.ttlSeconds).toBe(12 * 60 * 60);
      expect(body.audioBitrateBps).toBe(128_000);
      expect(body.iceServers).toHaveLength(1);
      const server = body.iceServers[0]!;
      expect(server.urls.some((url) => url.startsWith("stun:"))).toBe(true);
      expect(server.urls.some((url) => url.startsWith("turn:") && url.includes("transport=udp"))).toBe(true);
      expect(server.urls.some((url) => url.startsWith("turn:") && url.includes("transport=tcp"))).toBe(true);

      const testConfig = buildTestConfig();
      const expected = createHmac("sha1", testConfig.turnSecret).update(server.username).digest("base64");
      expect(server.credential).toBe(expected);
      expect(server.username.endsWith(`:${owner.userId}`)).toBe(true);
    });

    it("requires authentication", async () => {
      const response = await app.inject({ method: "GET", url: "/api/v1/voice/turn-credentials" });
      expect(response.statusCode).toBe(401);
    });
  });
});
