// Test helpers for the friends, DM and settings tests: a running server with
// a real Postgres and a real WebSocket, plus small wrappers to register users,
// call the API, and read gateway dispatches.
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { encodeBase64Url, GatewayOpcode, type GatewayEnvelope } from "@mortium/shared";
import { buildApp } from "../src/app.js";
import { createFakeMailer } from "../src/mailer.js";
import { GatewayService } from "../src/modules/gateway/service.js";
import { CallRinger } from "../src/modules/voice/calls.js";
import { VoiceService } from "../src/modules/voice/service.js";
import { createTestDb, type TestDb } from "./db.js";
import { buildTestConfig, mkTempDataDir } from "./helpers.js";

export interface TestServer {
  app: FastifyInstance;
  baseUrl: string;
  gateway: GatewayService;
  voice: VoiceService;
  ringer: CallRinger;
  testDb: TestDb;
  close(): Promise<void>;
}

export interface StartOptions {
  callRingMs?: number;
  voiceGraceMs?: number;
  rateLimit?: boolean;
  toDeviceQueueLimit?: number;
}

export async function startTestServer(options: StartOptions = {}): Promise<TestServer> {
  const testDb = await createTestDb();
  const gateway = new GatewayService();
  const voice = new VoiceService(options.voiceGraceMs);
  const ringer = new CallRinger(gateway, options.callRingMs);
  const app = await buildApp({
    db: testDb.db,
    config: buildTestConfig({ dataDir: await mkTempDataDir() }),
    mailer: createFakeMailer(),
    rateLimit: options.rateLimit ?? false,
    gateway,
    voice,
    ringer,
    gatewayTiming: { heartbeatIntervalMs: 30_000, identifyTimeoutMs: 2_000 },
    toDeviceQueueLimit: options.toDeviceQueueLimit,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    app,
    baseUrl: `ws://127.0.0.1:${port}`,
    gateway,
    voice,
    ringer,
    testDb,
    async close() {
      await app.close();
      await testDb.close();
    },
  };
}

export interface TestUser {
  userId: string;
  username: string;
  email: string;
  accessToken: string;
  deviceId: string;
}

let userCounter = 0;

export async function registerUser(server: TestServer, prefix = "user"): Promise<TestUser> {
  userCounter += 1;
  const username = `${prefix}${userCounter}`;
  const email = `${username}@example.com`;
  const response = await server.app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, username, password: "correct-password" },
  });
  const body = response.json() as { accessToken: string; deviceId: string; user: { id: string } };
  return { userId: body.user.id, username, email, accessToken: body.accessToken, deviceId: body.deviceId };
}

/** Sign in again to get a second device for the same user. */
export async function loginNewDevice(server: TestServer, user: TestUser): Promise<TestUser> {
  const response = await server.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: user.email, password: "correct-password" },
  });
  const body = response.json() as { accessToken: string; deviceId: string };
  return { ...user, accessToken: body.accessToken, deviceId: body.deviceId };
}

export interface ApiResult {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Call the REST API as one user. */
export function apiFor(server: TestServer, user: TestUser) {
  async function call(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown): Promise<ApiResult> {
    const response = await server.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${user.accessToken}` },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
    const text = response.body;
    return { status: response.statusCode, body: text ? JSON.parse(text) : undefined };
  }
  return {
    get: (url: string) => call("GET", url),
    post: (url: string, payload?: unknown) => call("POST", url, payload ?? {}),
    put: (url: string, payload?: unknown) => call("PUT", url, payload),
    patch: (url: string, payload?: unknown) => call("PATCH", url, payload),
    del: (url: string) => call("DELETE", url),
  };
}

export type Api = ReturnType<typeof apiFor>;

/** A gateway connection that keeps every dispatch, so a test can wait for one or check that none came. */
export class GatewayClient {
  readonly queue: GatewayEnvelope[] = [];
  private waiters: Array<() => void> = [];
  ready!: GatewayEnvelope;

  constructor(readonly ws: WebSocket) {
    ws.on("message", (data: WebSocket.RawData) => {
      this.queue.push(JSON.parse(data.toString()) as GatewayEnvelope);
      for (const waiter of this.waiters.splice(0)) {
        waiter();
      }
    });
  }

  send(op: number, d: unknown = {}): void {
    this.ws.send(JSON.stringify({ op, d }));
  }

  /** Wait for a matching message and remove it from the queue. */
  async next(predicate: (env: GatewayEnvelope) => boolean, timeoutMs = 5000): Promise<GatewayEnvelope> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.queue.findIndex(predicate);
      if (index !== -1) {
        return this.queue.splice(index, 1)[0]!;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Timed out waiting for a gateway message. Queue: ${JSON.stringify(this.queue)}`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** Wait for a dispatch by name (and an optional payload check). */
  event(t: string, check: (d: any) => boolean = () => true, timeoutMs?: number): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    return this.next((env) => env.t === t && check(env.d), timeoutMs).then((env) => env.d);
  }

  /** True when no matching dispatch shows up within `withinMs`. */
  async never(t: string, check: (d: any) => boolean = () => true, withinMs = 300): Promise<boolean> { // eslint-disable-line @typescript-eslint/no-explicit-any
    await new Promise((resolve) => setTimeout(resolve, withinMs));
    return !this.queue.some((env) => env.t === t && check(env.d));
  }

  /** Remove every queued message, so a test can start from a clean point. */
  drain(): void {
    this.queue.length = 0;
  }

  close(): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
  }
}

/** Open a gateway connection for a user and wait for READY. */
export async function connectGateway(server: TestServer, user: TestUser): Promise<GatewayClient> {
  const ws = new WebSocket(`${server.baseUrl}/gateway`);
  const client = new GatewayClient(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  await client.next((env) => env.op === GatewayOpcode.HELLO);
  client.send(GatewayOpcode.IDENTIFY, { accessToken: user.accessToken, deviceId: user.deviceId });
  client.ready = await client.next((env) => env.t === "READY");
  return client;
}

/** Make two users friends over the API. */
export async function makeFriends(server: TestServer, a: TestUser, b: TestUser): Promise<void> {
  await apiFor(server, a).post("/users/@me/relationships", { username: b.username });
  await apiFor(server, b).put(`/users/@me/relationships/${a.userId}`, { action: "accept" });
}

let nonceCounter = 0;

/** Post a plain message to a channel. The server never reads the bytes. */
export function postMessage(api: Api, channelId: string, text = "hello"): Promise<ApiResult> {
  nonceCounter += 1;
  return api.post(`/channels/${channelId}/events`, {
    codec: "megolm-v1", megolmSessionId: "test-session",
    ciphertext: encodeBase64Url(new TextEncoder().encode(text)),
    nonce: `nonce-${Date.now()}-${nonceCounter}`,
  });
}
