// Fake "browser tab" for testing and benchmarking the NOAPI? bridge without a
// real browser. Connects to the bridge websocket, claims to be on a site, and
// when a prompt arrives it simulates a real chat page: it "types" (with a delay
// that grows with the prompt), streams a reply token by token, and finishes the
// way the content script would.
//
//   node tools/fake-extension.js [site]   (default site: chatgpt)
//
// It can model two client behaviours so the benchmark can compare them with the
// SAME simulated model timings (NOAPI_FAKE_MODE):
//   new  (default) - condition-based typing, live streaming, and completion
//                    detected from the stop button disappearing + a debounce.
//   old            - fixed typing sleeps, no streaming at all, and the old
//                    "reply text unchanged for 2200ms" stability rule.
//
// Environment knobs (all optional) let the tests simulate real page timing:
//   NOAPI_PORT                  bridge port (default 8787)
//   NOAPI_FAKE_MODE             "new" | "old" (default new)
//   NOAPI_FAKE_FIRST_MS         delay after sending before the first token (1200)
//   NOAPI_FAKE_STREAM_CHUNKS    split the reply into N partial updates (default 0)
//   NOAPI_FAKE_STREAM_STEP_MS   delay between partial updates (default 150)
//   NOAPI_FAKE_TYPE_BASE_MS     fixed part of the typing time (default 120)
//   NOAPI_FAKE_TYPE_PER_CHAR_MS typing time per prompt character (default 0.6)
//   NOAPI_FAKE_TYPING_CAP_MS    cap on the prompt-length typing time (1200)
//   NOAPI_FAKE_TYPING_MS        fixed typing time, overrides the length model
//   NOAPI_FAKE_FIXED_TYPING_MS  old mode's total typing+sending time (950)
//   NOAPI_FAKE_FIXED_TYPED_MS   old mode's typed stage (500)
//   NOAPI_FAKE_STOP_LEAD_MS     stop button vanishes this long after the last
//                               token; negative = before it (default 180)
//   NOAPI_FAKE_FINAL_RENDER_MS  final DOM update lands this long after the last
//                               token, i.e. after the stop button is gone (260)
//   NOAPI_FAKE_COMPLETION_DEBOUNCE_MS  new mode: quiet time after the last change
//                               before completion (default 400; aliases
//                               NOAPI_FAKE_DEBOUNCE_MS for compatibility)
//   NOAPI_FAKE_STABLE_MS        old mode's "no change" rule (default 2200)
//   NOAPI_FAKE_REPLY            exact reply text to send back
//   NOAPI_FAKE_TOOL_CALLS       number of TOOL_CALL blocks to emit in a tool reply
//   NOAPI_FAKE_TOOL_TAIL        narration appended after the tool blocks; a real
//                               site would keep streaming it, but the content
//                               script returns as soon as the tool blocks settle,
//                               so this fake drops it when tools are enabled
//   NOAPI_FAKE_CANCEL_ACK_MS    delay before the tab confirms a cancel (default 0).
//                               The tab stays "busy" during the delay, like the
//                               real content script while it unwinds.
//   NOAPI_FAKE_CANCEL_ACK       "cancelled" (default) or "error": the ack a real
//                               tab sends once it has stopped.
//   NOAPI_FAKE_IGNORE_CANCEL    "1" = never ack a cancel (tests the bridge's
//                               safety timeout).
//   NOAPI_FAKE_BUSY_TIMES       reply "busy" to the first N requests, like the
//                               content script's busy guard, to test retry.
import net from "node:net";
import crypto from "node:crypto";

const site = process.argv[2] || "chatgpt";
const host = "127.0.0.1";
const port = Number(process.env.NOAPI_PORT || 8787);

const env = (name, dflt) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : dflt;
};
const has = (name) => process.env[name] !== undefined && process.env[name] !== "";

const MODE = String(process.env.NOAPI_FAKE_MODE || "new").toLowerCase() === "old" ? "old" : "new";
const FIRST_MS = env("NOAPI_FAKE_FIRST_MS", 1200);
const STREAM_CHUNKS = env("NOAPI_FAKE_STREAM_CHUNKS", 0);
const STREAM_STEP_MS = env("NOAPI_FAKE_STREAM_STEP_MS", 150);
const FORCED_REPLY = process.env.NOAPI_FAKE_REPLY || "";
const TOOL_CALLS = env("NOAPI_FAKE_TOOL_CALLS", 1);
const TOOL_TAIL = process.env.NOAPI_FAKE_TOOL_TAIL || "";
// The content script returns ~400ms after a complete tool block settles.
const EARLY_RETURN_MS = env("NOAPI_FAKE_EARLY_RETURN_MS", 400);

// Typing model. New: condition-based, time grows with prompt length but is
// bounded. Old: fixed sleeps (80+50+120+250ms typing + 450ms settle).
const TYPE_BASE_MS = env("NOAPI_FAKE_TYPE_BASE_MS", 120);
const TYPE_PER_CHAR_MS = env("NOAPI_FAKE_TYPE_PER_CHAR_MS", 0.6);
const TYPING_CAP_MS = env("NOAPI_FAKE_TYPING_CAP_MS", 1200);
const TYPING_OVERRIDE = has("NOAPI_FAKE_TYPING_MS") ? env("NOAPI_FAKE_TYPING_MS", 0) : null;
const FIXED_TYPING_MS = env("NOAPI_FAKE_FIXED_TYPING_MS", 950);
const FIXED_TYPED_MS = env("NOAPI_FAKE_FIXED_TYPED_MS", 500);

// Completion model. The site's stop button disappears around the last token,
// and the final render can land after it.
const STOP_LEAD_MS = env("NOAPI_FAKE_STOP_LEAD_MS", 180);
const FINAL_RENDER_MS = env("NOAPI_FAKE_FINAL_RENDER_MS", 260);
const COMPLETION_DEBOUNCE_MS = env("NOAPI_FAKE_COMPLETION_DEBOUNCE_MS", env("NOAPI_FAKE_DEBOUNCE_MS", 400));
const STABLE_MS = env("NOAPI_FAKE_STABLE_MS", 2200);
const FINAL_RENDER_SUFFIX = process.env.NOAPI_FAKE_FINAL_RENDER_SUFFIX ?? "\n";
// Cancel / busy behaviour (see the header). The tab keeps the request in
// `inFlight` for CANCEL_ACK_MS after a cancel, so a second request that arrives
// in that window hits the busy guard exactly like the real content script.
const CANCEL_ACK_MS = env("NOAPI_FAKE_CANCEL_ACK_MS", 0);
const CANCEL_ACK = String(process.env.NOAPI_FAKE_CANCEL_ACK || "cancelled").toLowerCase();
const IGNORE_CANCEL = process.env.NOAPI_FAKE_IGNORE_CANCEL === "1";
let busyRemaining = env("NOAPI_FAKE_BUSY_TIMES", 0);

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

  // Emulate the content script's busy guard: one request per tab at a time.
  // Used to model the cancel/queue race (a request arriving before the previous
  // one has finished unwinding) and the bridge's busy-retry path.
  if (busyRemaining > 0) {
    busyRemaining -= 1;
    console.log(`[fake-ext] busy (forced) for ${msg.id}`);
    send({ t: "error", id: msg.id, error: "This tab is already handling a prompt.", code: "busy" });
    return;
  }
  if (inFlight.size > 0) {
    console.log(`[fake-ext] busy for ${msg.id} (still handling another request)`);
    send({ t: "error", id: msg.id, error: "This tab is already handling a prompt.", code: "busy" });
    return;
  }

  send({ t: "progress", id: msg.id, status: "Typing prompt into fake site..." });

  const record = { timers: [], cancelled: false };
  inFlight.set(msg.id, record);
  const t0 = Date.now();
  const at = (fn, ms) => {
    const t = setTimeout(() => {
      if (record.cancelled) return;
      fn();
    }, Math.max(0, ms));
    record.timers.push(t);
    return t;
  };

  const promptText = String(msg.prompt);
  if (promptText.includes("FORCE_ERROR")) {
    at(() => {
      send({ t: "error", id: msg.id, error: "fake failure requested by test" });
      inFlight.delete(msg.id);
    }, 100);
    return;
  }
  if (promptText.includes("FORCE_MIDSTREAM_ERROR")) {
    at(() => send({ t: "partial", id: msg.id, text: "partial before the failure" }), 40);
    at(() => {
      send({ t: "error", id: msg.id, error: "fake mid-stream failure" });
      inFlight.delete(msg.id);
    }, 140);
    return;
  }

  const full = replyFor(msg.prompt);
  // When tools are enabled and the reply calls tools, the content script hands
  // the block over as soon as it settles and stops the site — it never waits
  // for (or receives) the trailing narration.
  const isTool = full.includes("TOOL_CALL");
  // Honor the bridge's kill switch (NOAPI_EARLY_RETURN=0), which it forwards as
  // early_return=false: then the fake keeps the trailing narration instead of
  // dropping it, and finishes through normal completion.
  const earlyReturn = Boolean(msg.tools_enabled && msg.early_return !== false && isTool && TOOL_TAIL);
  const text = earlyReturn ? full.slice(0, full.indexOf("\n\n" + TOOL_TAIL)) : full;
  // The final render usually applies formatting after the stop button is gone.
  const finalText = earlyReturn ? text : text + FINAL_RENDER_SUFFIX;

  // Typing stages, measured from when the request reached this tab.
  const typingMs =
    TYPING_OVERRIDE != null
      ? TYPING_OVERRIDE
      : Math.min(TYPING_CAP_MS, TYPE_BASE_MS + Math.round(promptText.length * TYPE_PER_CHAR_MS));
  const stages =
    MODE === "old"
      ? { composer: 0, typed: FIXED_TYPED_MS, sent: FIXED_TYPING_MS }
      : { composer: 0, typed: Math.round(typingMs / 2), sent: typingMs };

  // Model timeline, all relative to t0. Both modes produce the tokens at the
  // same moments; only the client-side behaviour around them differs.
  const chunks = Math.max(0, STREAM_CHUNKS);
  const firstTokenAt = stages.sent + FIRST_MS;
  const lastTokenAt = firstTokenAt + Math.max(0, chunks - 1) * STREAM_STEP_MS;
  const finalRenderAt = lastTokenAt + FINAL_RENDER_MS;
  const stopGoneAt = lastTokenAt + STOP_LEAD_MS;
  const completeAt = earlyReturn
    ? lastTokenAt + EARLY_RETURN_MS
    : MODE === "old"
      ? finalRenderAt + STABLE_MS
      : Math.max(finalRenderAt, stopGoneAt) + COMPLETION_DEBOUNCE_MS;

  if (FIRST_MS > 0) at(() => sendProgress(msg.id, "Generating..."), firstTokenAt - STREAM_STEP_MS);

  // Old mode streams nothing until it is finished; new mode forwards the reply
  // as it is written, including the final render after the stop button vanished.
  if (MODE !== "old") {
    if (chunks > 0 && text.length > 2) {
      for (let i = 1; i <= chunks; i++) {
        const upto = Math.max(1, Math.round((text.length * i) / chunks));
        at(() => send({ t: "partial", id: msg.id, text: text.slice(0, upto) }), firstTokenAt + (i - 1) * STREAM_STEP_MS);
      }
    } else if (text.length) {
      at(() => send({ t: "partial", id: msg.id, text }), firstTokenAt);
    }
    if (FINAL_RENDER_MS > 0 && !earlyReturn && finalText !== text) {
      at(() => send({ t: "partial", id: msg.id, text: finalText }), finalRenderAt);
    }
  }

  at(() => {
    console.log(`[fake-ext] replying to ${msg.id}`);
    const timings = {
      composer: stages.composer,
      typed: stages.typed,
      sent: stages.sent,
      firstText: MODE === "old" ? completeAt : firstTokenAt,
      lastToken: lastTokenAt,
      complete: completeAt,
      total: completeAt,
      stopSeen: earlyReturn ? true : MODE !== "old",
      earlyReturn,
      completedBy: earlyReturn ? "early-return" : MODE === "old" ? "fallback-2200" : "stop-button",
      // Simulate the page-SSE signal being observed in the "new" mode.
      sseSeen: MODE !== "old",
      // Phase 5: echo whether the bridge asked for a fresh chat.
      newChat: Boolean(msg.new_chat),
      resubmits: 0,
    };
    send({ t: "response", id: msg.id, text: finalText, timings });
    inFlight.delete(msg.id);
  }, completeAt);
}

function handleCancel(msg) {
  if (IGNORE_CANCEL) {
    // The tab never saw (or ignored) the cancel: it keeps generating and will
    // reply normally. Tests the bridge's safety timeout + late-response release.
    console.log(`[fake-ext] ignoring cancel ${msg.id}`);
    return;
  }
  const record = inFlight.get(msg.id);
  if (!record) {
    // Nothing running for this id. A real tab would have the background ack
    // immediately; if we got here it is a duplicate cancel, so ack anyway.
    sendCancelAck(msg.id);
    return;
  }
  record.cancelled = true;
  for (const t of record.timers) clearTimeout(t);
  record.timers = [];
  console.log(`[fake-ext] cancelled ${msg.id}`);
  // Keep the id "in flight" while the tab unwinds so a request arriving now hits
  // the busy guard, exactly like the real content script during cancel.
  record.timers.push(setTimeout(() => {
    inFlight.delete(msg.id);
    sendCancelAck(msg.id);
  }, Math.max(0, CANCEL_ACK_MS)));
}

function sendCancelAck(id) {
  if (CANCEL_ACK === "error") send({ t: "error", id, error: "Cancelled." });
  else send({ t: "cancelled", id });
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
  if (p.includes("AVAILABLE TOOLS") || p.includes("MULTI_TOOL") || p.includes("SINGLE_TOOL")) {
    const n = p.includes("SINGLE_TOOL") ? 1 : Math.max(1, TOOL_CALLS);
    const blocks = [];
    for (let i = 0; i < n; i++) {
      blocks.push(`\`\`\`\nTOOL_CALL\n{"name":"bash","arguments":{"command":"mkdir chatgpt-test-${i}"}}\n\`\`\``);
    }
    const head = n > 1 ? "On it, running those in parallel.\n" : "On it.\n";
    return head + blocks.join("\n") + (TOOL_TAIL ? "\n\n" + TOOL_TAIL : "");
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
