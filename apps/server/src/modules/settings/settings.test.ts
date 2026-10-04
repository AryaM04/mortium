// Integration tests for the synced user settings: the blob, the version
// check, the size limit, and USER_SETTINGS_UPDATE to the other sessions.
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { encodeBase64Url, MAX_SETTINGS_BYTES } from "@mortium/shared";
import { describeWithDb } from "../../../test/db.js";
import {
  apiFor,
  connectGateway,
  loginNewDevice,
  registerUser,
  startTestServer,
  type GatewayClient,
  type TestServer,
  type TestUser,
} from "../../../test/social.js";

vi.setConfig({ testTimeout: 15_000 });

let server: TestServer;
const sockets: GatewayClient[] = [];

async function connect(user: TestUser): Promise<GatewayClient> {
  const client = await connectGateway(server, user);
  sockets.push(client);
  return client;
}

function blob(text: string): string {
  return encodeBase64Url(new TextEncoder().encode(text));
}

describeWithDb("user settings", () => {
  beforeAll(async () => {
    server = await startTestServer();
  });

  afterEach(() => {
    for (const socket of sockets.splice(0)) {
      socket.close();
    }
  });

  afterAll(async () => {
    await server.close();
  });

  it("returns no data and version 0 before the first save", async () => {
    const user = await registerUser(server, "empty");
    const result = await apiFor(server, user).get("/users/@me/settings");
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ data: null, version: 0 });
  });

  it("saves the bytes as they are and adds 1 to the version each time", async () => {
    const user = await registerUser(server, "save");
    const api = apiFor(server, user);
    const first = await api.put("/users/@me/settings", { data: blob('{"theme":"dark"}'), version: 0 });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ data: blob('{"theme":"dark"}'), version: 1 });

    const second = await api.put("/users/@me/settings", { data: blob("second"), version: 1 });
    expect(second.body.version).toBe(2);

    const read = await api.get("/users/@me/settings");
    expect(read.body).toEqual({ data: blob("second"), version: 2 });
  });

  it("keeps binary bytes and an empty blob", async () => {
    const user = await registerUser(server, "binary");
    const api = apiFor(server, user);
    const bytes = Uint8Array.from([0, 255, 1, 254, 128]);
    await api.put("/users/@me/settings", { data: encodeBase64Url(bytes), version: 0 });
    expect((await api.get("/users/@me/settings")).body.data).toBe(encodeBase64Url(bytes));
    const empty = await api.put("/users/@me/settings", { data: "", version: 1 });
    expect(empty.status).toBe(200);
    expect((await api.get("/users/@me/settings")).body).toEqual({ data: "", version: 2 });
  });

  it("answers 409 VERSION_CONFLICT for a stale version, and keeps the stored data", async () => {
    const user = await registerUser(server, "stale");
    const api = apiFor(server, user);
    await api.put("/users/@me/settings", { data: blob("one"), version: 0 });
    await api.put("/users/@me/settings", { data: blob("two"), version: 1 });

    const stale = await api.put("/users/@me/settings", { data: blob("late"), version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("VERSION_CONFLICT");
    const firstAgain = await api.put("/users/@me/settings", { data: blob("late"), version: 0 });
    expect(firstAgain.status).toBe(409);
    const future = await api.put("/users/@me/settings", { data: blob("late"), version: 9 });
    expect(future.status).toBe(409);

    expect((await api.get("/users/@me/settings")).body).toEqual({ data: blob("two"), version: 2 });
  });

  it("lets only one of two saves at the same version win", async () => {
    const user = await registerUser(server, "race");
    const api = apiFor(server, user);
    const first = await Promise.all([
      api.put("/users/@me/settings", { data: blob("a"), version: 0 }),
      api.put("/users/@me/settings", { data: blob("b"), version: 0 }),
    ]);
    expect(first.map((result) => result.status).sort()).toEqual([200, 409]);
    const second = await Promise.all([
      api.put("/users/@me/settings", { data: blob("c"), version: 1 }),
      api.put("/users/@me/settings", { data: blob("d"), version: 1 }),
    ]);
    expect(second.map((result) => result.status).sort()).toEqual([200, 409]);
    expect((await api.get("/users/@me/settings")).body.version).toBe(2);
  });

  it("accepts 64 KiB and rejects one byte more", async () => {
    const user = await registerUser(server, "size");
    const api = apiFor(server, user);
    const big = encodeBase64Url(new Uint8Array(MAX_SETTINGS_BYTES).fill(7));
    const ok = await api.put("/users/@me/settings", { data: big, version: 0 });
    expect(ok.status).toBe(200);

    const tooBig = encodeBase64Url(new Uint8Array(MAX_SETTINGS_BYTES + 1).fill(7));
    const rejected = await api.put("/users/@me/settings", { data: tooBig, version: 1 });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe("INVALID_INPUT");
    expect((await api.get("/users/@me/settings")).body.version).toBe(1);
  });

  it("rejects text that is not base64url, and a missing version", async () => {
    const user = await registerUser(server, "invalid");
    const api = apiFor(server, user);
    expect((await api.put("/users/@me/settings", { data: "not base64!", version: 0 })).status).toBe(400);
    expect((await api.put("/users/@me/settings", { data: blob("x") })).status).toBe(400);
    expect((await api.put("/users/@me/settings", { data: blob("x"), version: -1 })).status).toBe(400);
  });

  it("keeps the settings of each user apart", async () => {
    const alice = await registerUser(server, "iso");
    const bob = await registerUser(server, "iso");
    await apiFor(server, alice).put("/users/@me/settings", { data: blob("alice"), version: 0 });
    expect((await apiFor(server, bob).get("/users/@me/settings")).body).toEqual({ data: null, version: 0 });
    const own = await apiFor(server, bob).put("/users/@me/settings", { data: blob("bob"), version: 0 });
    expect(own.status).toBe(200);
  });

  it("needs a signed-in user", async () => {
    const response = await server.app.inject({ method: "GET", url: "/api/v1/users/@me/settings" });
    expect(response.statusCode).toBe(401);
  });

  it("sends USER_SETTINGS_UPDATE to the other sessions of the user only", async () => {
    const user = await registerUser(server, "sync");
    const other = await registerUser(server, "sync");
    const phone = await loginNewDevice(server, user);
    const laptopSocket = await connect(user);
    const phoneSocket = await connect(phone);
    const otherSocket = await connect(other);

    const saved = await apiFor(server, user).put("/users/@me/settings", { data: blob("x"), version: 0 });
    expect(saved.status).toBe(200);
    expect(await phoneSocket.event("USER_SETTINGS_UPDATE")).toEqual({ version: 1 });
    // The device that saved knows the version from the response.
    expect(await laptopSocket.never("USER_SETTINGS_UPDATE")).toBe(true);
    expect(await otherSocket.never("USER_SETTINGS_UPDATE")).toBe(true);

    // A rejected save sends nothing.
    phoneSocket.drain();
    await apiFor(server, user).put("/users/@me/settings", { data: blob("y"), version: 0 });
    expect(await phoneSocket.never("USER_SETTINGS_UPDATE")).toBe(true);
  });
});
