// A smoke test of the packaged Linux app. It starts the app with a remote
// debugging port and reads the window through the Chrome DevTools
// Protocol (CDP). CI runs it under xvfb-run, with a test API server.
//
// Usage: node scripts/smoke.mjs <app executable> <server URL> [more app arguments]
//
// The steps:
// 1. The window shows the server address page (a first start).
// 2. The script types the server URL and connects. The main process checks
//    the server (health and CORS), keeps the address and loads the page again.
// 3. The window shows the sign-in page, and a fetch from the page to the
//    server passes the content security policy and CORS.
//
// Set the user data folder with XDG_CONFIG_HOME, so each run is a first start.
// With SMOKE_EXPECT_NO_KEY_RING=1, step 2 expects the page that the app
// shows when it finds no system key ring, and the test stops there.
import { spawn, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const [executable, serverUrl, ...appArguments] = process.argv.slice(2);
if (!executable || !serverUrl) {
  console.error("Usage: node scripts/smoke.mjs <app executable> <server URL> [more app arguments]");
  process.exit(2);
}

const PORT = 9333;
const NO_KEY_RING = "The app cannot keep your sign-in safely";
/** Set SMOKE_EXPECT_NO_KEY_RING=1 to check the page that the app shows without a key ring. */
const expectNoKeyRing = process.env.SMOKE_EXPECT_NO_KEY_RING === "1";
const TIMEOUT_MS = 60_000;
const started = Date.now();

const app = spawn(executable, [...appArguments, `--remote-debugging-port=${PORT}`], { stdio: ["ignore", "inherit", "inherit"] });
let exitCode = null;
app.on("exit", (code) => {
  exitCode = code ?? 1;
});

function fail(message) {
  console.error(`Smoke test failed: ${message}`);
  app.kill("SIGKILL");
  process.exit(1);
}

const timer = setTimeout(() => fail(`no result after ${TIMEOUT_MS / 1000} s`), TIMEOUT_MS);

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for the page target of the app window. */
async function findPage() {
  for (;;) {
    if (exitCode !== null) fail(`the app stopped with code ${exitCode}`);
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = targets.find((target) => target.type === "page" && target.url.startsWith("app://mortium/"));
      if (page) return page;
    } catch {
      // The debugging port is not open yet.
    }
    await pause(250);
  }
}

const page = await findPage();
console.log(`The window loaded ${page.url} after ${Date.now() - started} ms.`);
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = () => reject(new Error("The CDP connection did not open."));
});
let nextId = 0;
const waiting = new Map();
socket.onmessage = (message) => {
  const data = JSON.parse(message.data);
  if (data.id !== undefined && waiting.has(data.id)) {
    waiting.get(data.id)(data);
    waiting.delete(data.id);
  }
};

function send(method, params = {}) {
  const id = ++nextId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => waiting.set(id, resolve));
}

async function evaluate(expression) {
  const reply = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return reply.result?.result?.value;
}

/** Wait until the h1 of the page has this text. */
async function waitForHeading(text) {
  for (;;) {
    if (exitCode !== null) fail(`the app stopped with code ${exitCode}`);
    const heading = await evaluate(`document.querySelector("h1")?.textContent ?? ""`);
    if (heading === text) return;
    if (heading === NO_KEY_RING && text !== NO_KEY_RING) {
      fail("the app found no system key ring (check gnome-keyring in the CI job)");
    }
    await pause(250);
  }
}

await waitForHeading("Connect to a server");
console.log("Step 1 passed: the server address page is visible.");

await evaluate(`document.querySelector("input").focus()`);
await send("Input.insertText", { text: serverUrl });
await evaluate(`document.querySelector("form").requestSubmit()`);
if (expectNoKeyRing) {
  await waitForHeading(NO_KEY_RING);
  console.log("Step 2 passed: without a key ring, the app shows the fix and does not start.");
  finish();
}
await waitForHeading("Sign in");
console.log("Step 2 passed: the app connected to the server and shows the sign-in page.");

const status = await evaluate(
  `fetch(${JSON.stringify(`${serverUrl}/api/v1/health`)}).then((response) => response.status, (error) => String(error))`,
);
if (status !== 200) fail(`a fetch from the page to the server gave ${status}`);
const policy = await evaluate(`fetch("/").then((response) => response.headers.get("content-security-policy"))`);
if (!String(policy).includes(serverUrl)) fail(`the content security policy does not have the server: ${policy}`);
const bridge = await evaluate(`Object.keys(window.desktopBridge).length`);
if (bridge !== 16) fail(`the desktop bridge has ${bridge} functions, not 16`);
// The crypto WASM of the web build must compile under the content security policy.
const wasm = readdirSync(new URL("../../web/dist/assets", import.meta.url)).find((name) => name.endsWith(".wasm"));
const compiled = await evaluate(
  `WebAssembly.compileStreaming(fetch("/assets/${wasm}")).then(() => "compiled", (error) => String(error))`,
);
if (compiled !== "compiled") fail(`the crypto WASM did not compile: ${compiled}`);
const node = await evaluate(`typeof require === "undefined" && typeof process === "undefined"`);
if (node !== true) fail("the page can use Node.js");
console.log("Step 3 passed: CSP, CORS, WASM, the bridge and the sandbox are correct.");

const stored = await evaluate(
  `desktopBridge.secureSet("smoke-test", "value").then(() => desktopBridge.secureGet("smoke-test")).then((value) => desktopBridge.secureDelete("smoke-test").then(() => value), (error) => String(error))`,
);
if (stored !== "value") fail(`the secure store gave ${stored}`);
const preview = await evaluate(`desktopBridge.fetchLinkPreview("http://127.0.0.1/").then((value) => value, (error) => String(error))`);
if (preview !== null) fail(`a link preview of a loopback address gave ${JSON.stringify(preview)}`);
console.log("Step 4 passed: the secure store keeps a value, and a link preview refuses a private address.");

// Screen share: start getDisplayMedia (it needs a user gesture), and pick the first source in the picker
// window when there is one. With one source (a CI display), the app uses it without a picker.
await send("Runtime.evaluate", {
  expression: `window.__share = navigator.mediaDevices.getDisplayMedia({ video: true }).then(
    (stream) => { const kind = stream.getVideoTracks()[0]?.kind; stream.getTracks().forEach((track) => track.stop()); return kind; },
    (error) => String(error))`,
  userGesture: true,
});
const shareStarted = Date.now();
while (Date.now() - shareStarted < 30_000) {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const picker = targets.find((target) => target.url.includes("/__desktop/picker.html"));
  if (picker) {
    const pickerSocket = new WebSocket(picker.webSocketDebuggerUrl);
    await new Promise((resolve) => (pickerSocket.onopen = resolve));
    const click = `new Promise((resolve) => { const tryClick = () => { const button = document.querySelector("#sources button"); if (button) { button.click(); resolve(true); } else setTimeout(tryClick, 100); }; tryClick(); })`;
    pickerSocket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: click, awaitPromise: true } }));
    console.log("The screen picker window opened. The script picks the first source.");
    break;
  }
  const settled = await evaluate(`Promise.race([window.__share, new Promise((resolve) => setTimeout(() => resolve("waiting"), 250))])`);
  if (settled !== "waiting") break;
}
const shared = await evaluate(`Promise.race([window.__share, new Promise((resolve) => setTimeout(() => resolve("no answer"), 5000))])`);
if (shared !== "video") fail(`screen share gave ${shared}`);
console.log("Step 5 passed: screen share gives a video track.");

// Global push to talk: register F9, press it with xdotool (Linux, X11), and read the events.
const registered = await evaluate(`(async () => {
  window.__ptt = [];
  await desktopBridge.onEvent("push-to-talk", (pressed) => window.__ptt.push(pressed));
  return desktopBridge.setPushToTalk("F9").then(() => "registered", (error) => String(error));
})()`);
if (registered !== "registered") fail(`push to talk gave ${registered}`);
if (process.platform === "linux") {
  const xdotool = (action) => spawnSync("xdotool", [action, "F9"], { stdio: "inherit" }).status;
  if (xdotool("keydown") !== 0 || (await pause(300), xdotool("keyup")) !== 0) fail("xdotool did not press the key");
  await pause(500);
  const events = await evaluate("window.__ptt");
  if (JSON.stringify(events) !== "[true,false]") fail(`push to talk sent ${JSON.stringify(events)}, not [true,false]`);
}
await evaluate(`desktopBridge.setPushToTalk(null)`);
console.log("Step 6 passed: the global push-to-talk key works.");

finish();

function finish() {
  clearTimeout(timer);
  socket.close();
  app.kill("SIGTERM");
  console.log(`The smoke test passed in ${Date.now() - started} ms.`);
  process.exit(0);
}
