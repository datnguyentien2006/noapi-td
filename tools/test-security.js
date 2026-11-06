// The bridge must refuse web pages (cross-site requests and WebSockets)
// while still serving the extension, OpenCode, the MCP proxy and the dashboard.
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { startBridge, stopAll, warnIfDefaultBridge } from "./lib/harness.js";

await warnIfDefaultBridge();
const { port: PORT } = await startBridge();
const fail = (m) => {
  console.error("FAIL:", m);
  stopAll();
  process.exit(1);
};

const get = (path, headers = {}) =>
  new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, path, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    r.on("error", reject);
    r.end();
  });

const upgrade = (headers = {}) =>
  new Promise((resolve) => {
    const s = net.createConnection({ host: "127.0.0.1", port: PORT }, () => {
      const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("");
      s.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`);
    });
    s.once("data", (d) => { resolve(String(d).split("\r\n")[0]); s.destroy(); });
    s.on("error", () => resolve("error"));
    setTimeout(() => { resolve("timeout"); s.destroy(); }, 2000);
  });

const checks = [
  ["HTTP from a web page is blocked", async () => (await get("/health", { Origin: "https://evil.example" })) === 403],
  ["HTTP with a foreign Host (DNS rebinding) is blocked", async () => (await get("/health", { Host: "evil.example" })) === 403],
  ["HTTP from the extension is allowed", async () => (await get("/health", { Origin: "chrome-extension://abcdef" })) === 200],
  ["HTTP from the dashboard (same origin) is allowed", async () => (await get("/health", { Origin: `http://127.0.0.1:${PORT}` })) === 200],
  ["HTTP without Origin (OpenCode, curl) is allowed", async () => (await get("/health")) === 200],
  ["WebSocket from a web page is blocked", async () => (await upgrade({ Origin: "https://evil.example" })).includes("403")],
  ["WebSocket from the extension is allowed", async () => (await upgrade({ Origin: "moz-extension://1234" })).includes("101")],
  ["WebSocket without Origin (MCP proxy, tests) is allowed", async () => (await upgrade()).includes("101")],
];
for (const [name, fn] of checks) {
  if (!(await fn())) fail(name);
  console.log("ok:", name);
}
stopAll();
process.exit(0);