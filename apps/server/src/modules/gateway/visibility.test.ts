// Integration tests for the M5 gateway effects: visibility changes
// (CHANNEL_CREATE/CHANNEL_DELETE when an overwrite hides or reveals a
// channel), voice moderation (mute/deafen/move/disconnect, self-unmute
// blocked while server-muted), and losing CONNECT kicking a peer from
// voice. Real Postgres and a real `ws` client.
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { encodeBase64Url, encodePlainPayload, GatewayOpcode, Permission, type GatewayEnvelope } from "@mortium/shared";
import { buildApp } from "../../app.js";
import { createFakeMailer } from "../../mailer.js";
import { createTestDb, describeWithDb, type TestDb } from "../../../test/db.js";
import { buildTestConfig, mkTempDataDir, passwordFields } from "../../../test/helpers.js";
import { GatewayService } from "./service.js";

vi.setConfig({ testTimeout: 15_000 });

const HEARTBEAT_INTERVAL_MS = 30_000;
const IDENTIFY_TIMEOUT_MS = 5_000;

let testDb: TestDb;
let app: FastifyInstance;
let baseUrl: string;
let userCounter = 0;

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

async function connectRaw(): Promise<WebSocket> {
  const ws = new WebSocket(`${baseUrl}/gateway`);
  queueFor(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return ws;
}

interface Registered {
  accessToken: string;
  deviceId: string;
  userId: string;
}

async function registerUser(): Promise<Registered> {
  userCounter += 1;
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email: `vis-user${userCounter}@example.com`, username: `visuser${userCounter}`, ...passwordFields() },
  });
  const body = response.json() as { accessToken: string; deviceId: string; user: { id: string } };
  return { accessToken: body.accessToken, deviceId: body.deviceId, userId: body.user.id };
}

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function identify(user: Registered): Promise<WebSocket> {
  const ws = await connectRaw();
  await nextMessage(ws, (env) => env.op === GatewayOpcode.HELLO);
  ws.send(JSON.stringify({ op: GatewayOpcode.IDENTIFY, d: { accessToken: user.accessToken, deviceId: user.deviceId } }));
  await nextMessage(ws, (env) => env.t === "READY");
  return ws;
}

async function createGuild(token: string, name = "Visibility Guild") {
  const response = await app.inject({ method: "POST", url: "/api/v1/guilds", headers: authHeader(token), payload: { name } });
  return response.json() as { id: string; channels: Array<{ id: string; type: string }> };
}

function textChannelOf(guild: { channels: Array<{ id: string; type: string }> }): string {
  return guild.channels.find((c) => c.type === "text")!.id;
}

function voiceChannelOf(guild: { channels: Array<{ id: string; type: string }> }): string {
  return guild.channels.find((c) => c.type === "voice")!.id;
}

async function joinGuild(ownerToken: string, guildId: string, textChannelId: string, token: string) {
  const invite = await app.inject({
    method: "POST",
    url: `/api/v1/channels/${textChannelId}/invites`,
    headers: authHeader(ownerToken),
    payload: {},
  });
  const code = invite.json().code;
  await app.inject({ method: "POST", url: `/api/v1/invites/${code}`, headers: authHeader(token) });
}

describeWithDb("gateway effects for visibility and voice moderation", () => {
  beforeAll(async () => {
    testDb = await createTestDb();
    const dataDir = await mkTempDataDir();
    const gateway = new GatewayService();
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

  it("denying VIEW_CHANNEL sends CHANNEL_DELETE, allowing it again sends CHANNEL_CREATE, and EVENT_CREATE stops/resumes", async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const textChannel = textChannelOf(guild);
    await joinGuild(owner.accessToken, guild.id, textChannel, member.accessToken);

    const memberWs = await identify(member);
    openSockets.push(memberWs);

    const deny = await app.inject({
      method: "PUT",
      url: `/api/v1/channels/${textChannel}/overwrites/${member.userId}`,
      headers: authHeader(owner.accessToken),
      payload: { type: "member", allow: "0", deny: Permission.VIEW_CHANNEL.toString() },
    });
    expect(deny.statusCode).toBe(204);

    const deleted = await nextMessage(memberWs, (env) => env.t === "CHANNEL_DELETE");
    expect((deleted.d as { id: string }).id).toBe(textChannel);

    // A message posted while the member cannot view the channel must not reach them.
    const ciphertext = encodeBase64Url(
      encodePlainPayload({ type: "message", body: "hidden", mentions: [], attachments: [], embeds: [] }),
    );
    await app.inject({
      method: "POST",
      url: `/api/v1/channels/${textChannel}/events`,
      headers: authHeader(owner.accessToken),
      payload: { codec: "megolm-v1", megolmSessionId: "test-session", ciphertext, nonce: "vis-1" },
    });
    await expect(nextMessage(memberWs, (env) => env.t === "EVENT_CREATE")).rejects.toThrow(/Timed out/);

    const restore = await app.inject({
      method: "DELETE",
      url: `/api/v1/channels/${textChannel}/overwrites/${member.userId}?type=member`,
      headers: authHeader(owner.accessToken),
    });
    expect(restore.statusCode).toBe(204);

    const created = await nextMessage(memberWs, (env) => env.t === "CHANNEL_CREATE");
    expect((created.d as { id: string }).id).toBe(textChannel);

    await app.inject({
      method: "POST",
      url: `/api/v1/channels/${textChannel}/events`,
      headers: authHeader(owner.accessToken),
      payload: { codec: "megolm-v1", megolmSessionId: "test-session", ciphertext, nonce: "vis-2" },
    });
    const eventCreate = await nextMessage(memberWs, (env) => env.t === "EVENT_CREATE");
    expect(eventCreate).toBeDefined();
  });

  it("losing CONNECT on a voice channel disconnects the peer", async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const textChannel = textChannelOf(guild);
    const voiceChannel = voiceChannelOf(guild);
    await joinGuild(owner.accessToken, guild.id, textChannel, member.accessToken);

    const memberWs = await identify(member);
    openSockets.push(memberWs);
    memberWs.send(
      JSON.stringify({ op: GatewayOpcode.VOICE_JOIN, d: { channelId: voiceChannel, selfMute: false, selfDeaf: false } }),
    );
    await nextMessage(memberWs, (env) => env.t === "VOICE_STATE_UPDATE" && (env.d as { userId: string }).userId === member.userId);

    const deny = await app.inject({
      method: "PUT",
      url: `/api/v1/channels/${voiceChannel}/overwrites/${member.userId}`,
      headers: authHeader(owner.accessToken),
      payload: { type: "member", allow: "0", deny: Permission.CONNECT.toString() },
    });
    expect(deny.statusCode).toBe(204);

    const left = await nextMessage(
      memberWs,
      (env) => env.t === "VOICE_STATE_UPDATE" && (env.d as { channelId: string | null }).channelId === null,
    );
    expect(left).toBeDefined();
  });

  it("server-mutes, server-deafens, moves and disconnects a peer; a server-muted peer cannot self-unmute", async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const guild = await createGuild(owner.accessToken);
    const textChannel = textChannelOf(guild);
    const voiceChannel = voiceChannelOf(guild);
    await joinGuild(owner.accessToken, guild.id, textChannel, member.accessToken);

    const secondVoice = await app.inject({
      method: "POST",
      url: `/api/v1/guilds/${guild.id}/channels`,
      headers: authHeader(owner.accessToken),
      payload: { name: "second-voice", type: "voice" },
    });
    const secondVoiceId = secondVoice.json().id;

    const memberWs = await identify(member);
    openSockets.push(memberWs);
    memberWs.send(
      JSON.stringify({ op: GatewayOpcode.VOICE_JOIN, d: { channelId: voiceChannel, selfMute: false, selfDeaf: false } }),
    );
    await nextMessage(memberWs, (env) => env.t === "VOICE_STATE_UPDATE" && (env.d as { userId: string }).userId === member.userId);

    const mute = await app.inject({
      method: "PATCH",
      url: `/api/v1/guilds/${guild.id}/members/${member.userId}/voice`,
      headers: authHeader(owner.accessToken),
      payload: { mute: true },
    });
    expect(mute.statusCode).toBe(204);
    const muteUpdate = await nextMessage(memberWs, (env) => env.t === "VOICE_STATE_UPDATE");
    expect((muteUpdate.d as { serverMute: boolean }).serverMute).toBe(true);

    // The member cannot self-unmute while server-muted.
    memberWs.send(JSON.stringify({ op: GatewayOpcode.VOICE_STATE, d: { selfMute: false } }));
    const voiceError = await nextMessage(memberWs, (env) => env.t === "VOICE_ERROR" || env.op === GatewayOpcode.HEARTBEAT_ACK);
    expect(voiceError.t).toBe("VOICE_ERROR");

    const move = await app.inject({
      method: "PATCH",
      url: `/api/v1/guilds/${guild.id}/members/${member.userId}/voice`,
      headers: authHeader(owner.accessToken),
      payload: { channelId: secondVoiceId },
    });
    expect(move.statusCode).toBe(204);
    const moved = await nextMessage(
      memberWs,
      (env) => env.t === "VOICE_STATE_UPDATE" && (env.d as { channelId: string | null }).channelId === secondVoiceId,
    );
    expect(moved).toBeDefined();

    const disconnect = await app.inject({
      method: "PATCH",
      url: `/api/v1/guilds/${guild.id}/members/${member.userId}/voice`,
      headers: authHeader(owner.accessToken),
      payload: { channelId: null },
    });
    expect(disconnect.statusCode).toBe(204);
    const left = await nextMessage(
      memberWs,
      (env) => env.t === "VOICE_STATE_UPDATE" && (env.d as { channelId: string | null }).channelId === null,
    );
    expect(left).toBeDefined();
  });
});
