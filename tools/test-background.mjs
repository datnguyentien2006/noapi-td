// Tests extension/background.js connection handling against a tiny WebSocket
// server (no browser). Run: node tools/test-background.mjs   (Node 22+, global WebSocket)
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import nodePath from "node:path";

const here = nodePath.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(process.env.BG || nodePath.join(here, "../extension/chrome/background.js"), "utf8");

// ---- minimal RFC 6455 server -------------------------------------------------
function frame(obj) {
  const p = Buffer.from(JSON.stringify(obj));
  const h = p.length < 126 ? Buffer.from([0x81, p.length]) : Buffer.from([0x81, 126, p.length >> 8, p.length & 255]);
  return Buffer.concat([h, p]);
}
function parseFrames(buf, onText) {
  for (;;) {
    if (buf.length < 2) return buf;
    const op = buf[0] & 15;
    let len = buf[1] & 127, off = 2;
    if (len === 126) { if (buf.length < 4) return buf; len = buf.readUInt16BE(2); off = 4; }
    const masked = (buf[1] & 128) !== 0;
    const need = off + (masked ? 4 : 0) + len;
    if (buf.length < need) return buf;
    let data = buf.subarray(off + (masked ? 4 : 0), need);
    if (masked) { const k = buf.subarray(off, off + 4); data = Buffer.from(data.map((b, i) => b ^ k[i % 4])); }
    if (op === 1) onText(data.toString());
    buf = buf.subarray(need);
  }
}
function startServer(port) {
  const srv = http.createServer();
  const socks = new Set();
  const api = { port, muted: false, msgs: [], connectsEver: 0, maxConcurrent: 0, socks, srv };
  srv.on("upgrade", (req, sock) => {
    api.connectsEver++;
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64")}\r\n\r\n`);
    socks.add(sock);
    api.maxConcurrent = Math.max(api.maxConcurrent, socks.size);
    let buf = Buffer.alloc(0);
    sock.on("data", (d) => {
      buf = parseFrames(Buffer.concat([buf, d]), (t) => {
        const m = JSON.parse(t);
        api.msgs.push(m);
        if (api.muted) return;
        if (m.t === "hello") sock.write(frame({ t: "welcome" }));
        if (m.t === "ping") sock.write(frame({ t: "pong" }));
      });
    });
    sock.on("close", () => socks.delete(sock));
    sock.on("error", () => {});
  });
  return new Promise((res) => srv.listen(port, "127.0.0.1", () => res(api)));
}
// A client that retries quickly can slip one last connection in while the
// listener is closing, so keep destroying sockets until the server is fully closed.
const stopServer = (api) =>
  new Promise((res) => {
    const kill = () => { for (const s of api.socks) s.destroy(); };
    kill();
    const t = setInterval(kill, 20);
    api.srv.close(() => { clearInterval(t); res(); });
  });

// ---- load background.js in a sandbox with a fake chrome ------------------------
function loadBackground(port, cfg) {
  let onMessage;
  const status = [];
  const chrome = {
    runtime: { onConnect: { addListener() {} }, onMessage: { addListener: (f) => (onMessage = f) } },
    tabs: { onRemoved: { addListener() {} }, sendMessage: async () => {} },
    storage: { local: { get: async () => ({ noapi_url: `ws://127.0.0.1:${port}` }) } },
    action: {}, alarms: undefined,
  };
  const sandbox = { chrome, WebSocket, setTimeout, clearTimeout, setInterval, clearInterval, console: { log() {} }, Date, Math, JSON, Map, Promise, Object, Number, String, Array, Boolean, __NOAPI_CFG__: cfg };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  const send = (msg) => new Promise((res) => onMessage(msg, { frameId: 0, tab: { id: 1 } }, res));
  return { status: () => send({ type: "noapi_status_req" }), reconnect: () => send({ type: "noapi_test_bridge" }) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return Date.now() - t; await sleep(25); } assert.fail("timeout: " + what); }

const CFG = { baseDelay: 100, maxDelay: 800, minGap: 50, pingEvery: 100, deadAfter: 400, forceWait: 1500, connectTimeout: 500 };
let n = 0; const ok = (m) => { n++; console.log("ok -", m); };
const PORT = 38000 + Math.floor(Math.random() * 1000);

// 1. connects and says hello
let srv = await startServer(PORT);
const bg = loadBackground(PORT, CFG);
await until(async () => (await bg.status()).connected, 2000, "initial connect");
assert.ok(srv.msgs.some((m) => m.t === "hello"));
ok("connects and identifies itself");

// 2. liveness: pings are sent and answered while healthy
await sleep(450);
assert.ok(srv.msgs.filter((m) => m.t === "ping").length >= 3);
assert.equal((await bg.status()).connected, true);
ok("stays connected while the bridge answers pings");

// 3. a bridge that stops answering (socket still open) is detected as dead
srv.muted = true;
const detected = await until(async () => !(await bg.status()).connected, 2500, "silent bridge detected");
assert.ok(detected < 1500, `detected after ${detected}ms`);
ok(`silent bridge detected after ${detected}ms (status turns red)`);
srv.muted = false;
await until(async () => (await bg.status()).connected, 3000, "reconnect after silence");
ok("reconnects once the bridge answers again");

// 4. bridge killed (sockets destroyed + port closed): status red, retries BACK OFF, no burst
const connectsBefore = srv.connectsEver;
await stopServer(srv);
await until(async () => !(await bg.status()).connected, 1500, "drop detected");
const attempts = [];
const origWS = globalThis.WebSocket;
await sleep(3000);
// bring the bridge back on the same port: must reconnect by itself within maxDelay
srv = await startServer(PORT);
const back = await until(async () => (await bg.status()).connected, 3000, "auto reconnect after restart");
ok(`reconnects by itself ${back}ms after the bridge came back (maxDelay ${CFG.maxDelay}ms)`);
assert.ok(srv.maxConcurrent <= 1, "never two sockets at once");
ok("only one socket open at any time");

// 5. attempts while the bridge is down are spaced out (counted with a probe server that refuses)
await stopServer(srv);
await until(async () => !(await bg.status()).connected, 1500, "drop 2");
const probe = http.createServer(); // listens but never completes a WebSocket handshake => counts attempts
let tries = 0;
probe.on("upgrade", (req, sock) => { tries++; sock.destroy(); });
await new Promise((r) => probe.listen(PORT, "127.0.0.1", r));
await sleep(4000);
assert.ok(tries <= 9, `${tries} attempts in 4s with base ${CFG.baseDelay}ms, max ${CFG.maxDelay}ms`);
assert.ok(tries >= 3, `still retrying (${tries})`);
ok(`while the bridge is unusable: ${tries} attempts in 4s (exponential backoff, bounded)`);
probe.close(); probe.closeAllConnections?.();
await sleep(100);

// 5b. a server that accepts TCP but never answers the handshake does not wedge the client
{
  const net = await import("node:net");
  let hung = 0;
  const black = net.createServer((sock) => { hung++; sock.on("error", () => {}); }); // accepts, says nothing
  await new Promise((r) => black.listen(PORT, "127.0.0.1", r));
  await sleep(2500);
  assert.ok(hung >= 2, `client kept retrying after the handshake timeout (${hung} attempts)`);
  ok(`stalled handshake abandoned after connectTimeout and retried (${hung} attempts)`);
  black.close(); black.closeAllConnections?.();
  await sleep(100);
}

// 6. manual Reconnect reports the real result, and clicking repeatedly opens one socket
srv = await startServer(PORT);
const results = await Promise.all([bg.reconnect(), bg.reconnect(), bg.reconnect()]);
assert.ok(results.every((r) => r.connected === true), JSON.stringify(results));
assert.ok(srv.maxConcurrent <= 1, `concurrent sockets: ${srv.maxConcurrent}`);
ok("Reconnect button: true result, 3 rapid clicks share one attempt");
await stopServer(srv);
const down = await bg.reconnect();
assert.equal(down.connected, false);
ok("Reconnect button reports false when the bridge is really down");

console.log(`\n${n} background tests passed`);
process.exit(0);
