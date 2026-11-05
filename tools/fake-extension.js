// Fake "browser tab" for testing the NOAPI? bridge without a real browser.
// Connects to the bridge websocket, claims to be on a site, and when a prompt
// arrives it "types" nothing and just replies with a canned answer.
//
//   node tools/fake-extension.js [site]   (default site: chatgpt)
//
// Environment knobs (all optional) let the tests simulate real page timing:
//   NOAPI_PORT                  bridge port (default 8787)
//   NOAPI_FAKE_FIRST_MS         delay before anything is produced (default 1200)
//   NOAPI_FAKE_TYPING_MS        simulated composer-typing time, reported in timings
//   NOAPI_FAKE_STREAM_CHUNKS    split the reply into N "partial" messages (default 0)
//   NOAPI_FAKE_STREAM_STEP_MS   delay between partials (default 150)
//   NOAPI_FAKE_DEBOUNCE_MS      dead time after the last token before the final
//                               response, standing in for completion detection
//   NOAPI_FAKE_REPLY            exact reply text to send back
//   NOAPI_FAKE_TOOL_CALLS       number of TOOL_CALL blocks to emit in a tool reply
import net from "node:net";
import crypto from "node:crypto";

const site = process.argv[2] || "chatgpt";
const host = "127.0.0.1";
const port = Number(process.env.NOAPI_PORT || 8787);

const env = (name, dflt) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : dflt;
};
const FIRST_MS = env("NOAPI_FAKE_FIRST_MS", 1200);
const TYPING_MS = env("NOAPI_FAKE_TYPING_MS", 0);
const STREAM_CHUNKS = env("NOAPI_FAKE_STREAM_CHUNKS", 0);
const STREAM_STEP_MS = env("NOAPI_FAKE_STREAM_STEP_MS", 150);
const DEBOUNCE_MS = env("NOAPI_FAKE_DEBOUNCE_MS", 0);
const FORCED_REPLY = process.env.NOAPI_FAKE_REPLY || "";
const TOOL_CALLS = env("NOAPI_FAKE_TOOL_CALLS", 1);

const socket = net.createConnection({ host, port }, () => {
  const key = crypto.randomBytes(16).toString("base64");
  socket.write(
    `GET / HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
  );
});

let buf = Buffer.alloc(0);
let headersDone = false;
// reqId -> { timers: [], cancelled: bool }
const inFlight = new Map();

socket.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  if (!headersDone) {
    const idx = buf.indexOf("\r\n\r\n");
    if (idx === -1) return;
    headersDone = true;
    buf = buf.subarray(idx + 4);
    console.log(`[fake-ext] websocket connected, claiming site: ${site}`);
    send({ t: "hello", site, url: `https://fake.${site}.example/` });
  }
  while (buf.length >= 2) {
    const fin = buf[0] & 0x80;
    const opcode = buf[0] & 0x0f;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) return;
      len = buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (buf.length < 10) return;
      len = Number(buf.readBigUInt64BE(2));
      off = 10;
    }
    if (buf.length < off + len) return;
    const payload = buf.subarray(off, off + len);
    buf = buf.subarray(off + len);
    if (!fin) continue;
    if (opcode === 0x8) {
      console.log("[fake-ext] server closed");
      process.exit(0);
    }
    if (opcode === 0x9) continue; // ping: we ignore (server is lenient)
    if (opcode !== 0x1) continue;
    let msg;
    try {
      msg = JSON.parse(payload.toString("utf8"));
    } catch {
      continue;
    }
    if (msg.t === "request") handleRequest(msg);
    else if (msg.t === "cancel") handleCancel(msg);
    else if (msg.t === "welcome") console.log("[fake-ext] bridge says welcome");
  }
});

function handleRequest(msg) {
  console.log(`[fake-ext] request ${msg.id}: ${String(msg.prompt).slice(0, 120).replace(/\n/g, " ")}`);
  send({ t: "progress", id: msg.id, status: "Typing prompt into fake site..." });

  const record = { timers: [], cancelled: false };
  inFlight.set(msg.id, record);
  const t0 = Date.now();
  const later = (fn, ms) => {
    const t = setTimeout(() => {
      if (record.cancelled) return;
      fn();
    }, ms);
    record.timers.push(t);
    return t;
  };

  const text = replyFor(msg.prompt);
  if (FIRST_MS > 0) later(() => sendProgress(msg.id, "Generating..."), Math.max(0, FIRST_MS - STREAM_STEP_MS));

  later(() => {
    const firstTextAt = Date.now() - t0;
    if (STREAM_CHUNKS > 0 && text.length > 2) {
      for (let i = 1; i <= STREAM_CHUNKS; i++) {
        const upto = Math.max(1, Math.round((text.length * i) / STREAM_CHUNKS));
        later(() => send({ t: "partial", id: msg.id, text: text.slice(0, upto) }), (i - 1) * STREAM_STEP_MS);
      }
    }
    later(() => {
      console.log(`[fake-ext] replying to ${msg.id}`);
      const timings = {
        composer: Math.round(TYPING_MS / 3),
        typed: Math.round((TYPING_MS * 2) / 3),
        sent: TYPING_MS,
        firstText: firstTextAt,
        complete: Date.now() - t0,
        total: Date.now() - t0,
        stopSeen: true,
      };
      send({ t: "response", id: msg.id, text, timings });
      inFlight.delete(msg.id);
    }, (STREAM_CHUNKS > 0 ? STREAM_CHUNKS * STREAM_STEP_MS : 0) + DEBOUNCE_MS);
  }, FIRST_MS);
}

function handleCancel(msg) {
  const record = inFlight.get(msg.id);
  if (!record) return;
  record.cancelled = true;
  for (const t of record.timers) clearTimeout(t);
  inFlight.delete(msg.id);
  console.log(`[fake-ext] cancelled ${msg.id}`);
  send({ t: "error", id: msg.id, error: "Cancelled." });
}

function sendProgress(id, status) {
  send({ t: "progress", id, status });
}

function replyFor(prompt) {
  if (FORCED_REPLY) return FORCED_REPLY;
  const p = String(prompt);
  // Checked before the tool branch: the MCP `chat` tool prepends an
  // "AVAILABLE TOOLS:" block whenever the global OpenCode config lists MCP
  // servers, so we need a marker that is stable across machines.
  if (p.includes("MCP_TEST")) return `[fake ${site}] MCP test reply from the fake browser tab.`;
  if (p.includes("END_TOOL_RESULT")) return `[fake ${site}] Done, the folder was created.`;
  if (p.includes("AVAILABLE TOOLS") || p.includes("MULTI_TOOL")) {
    const n = Math.max(1, TOOL_CALLS);
    const blocks = [];
    for (let i = 0; i < n; i++) {
      blocks.push(`\`\`\`\nTOOL_CALL\n{"name":"bash","arguments":{"command":"mkdir chatgpt-test-${i}"}}\n\`\`\``);
    }
    return (n > 1 ? "On it, running those in parallel.\n" : "On it.\n") + blocks.join("\n");
  }
  return `[fake ${site}] This is a fake reply from tools/fake-extension.js. Real use: open ${site} in your browser with the NOAPI? extension — the website's model will answer instead.`;
}

function send(obj) {
  const payload = Buffer.from(JSON.stringify(obj), "utf8");
  const mask = crypto.randomBytes(4);
  let header;
  const len = payload.length;
  if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
  else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  socket.write(Buffer.concat([header, mask, masked]));
}

socket.on("error", (e) => {
  console.error(`[fake-ext] cannot reach bridge at ws://${host}:${port} — is it running? (${e.message})`);
  process.exit(1);
});
