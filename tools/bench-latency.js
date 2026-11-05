// Latency benchmark for the NOAPI? bridge, using the fake browser tab and the
// per-stage timings from Phase 0 instrumentation.
//
//   npm run bench
//
// It answers "how long does one round trip cost, and how long until OpenCode
// sees the first character?" — the two numbers that matter per tool call.
//
// The fake tab simulates a model that thinks for a while, then streams tokens,
// because that is what a real site does. Knobs:
//   NOAPI_BENCH_PORT           bridge port (default 8796)
//   NOAPI_BENCH_REQUESTS       how many round trips (default 5)
//   NOAPI_BENCH_FIRST_MS       delay before the first token (default 700)
//   NOAPI_BENCH_CHUNKS         streamed partial updates (default 24)
//   NOAPI_BENCH_STEP_MS        delay between partial updates (default 40)
import { spawn } from "node:child_process";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = Number(process.env.NOAPI_BENCH_PORT || 8796);
const REQUESTS = Number(process.env.NOAPI_BENCH_REQUESTS || 5);
const FIRST_MS = Number(process.env.NOAPI_BENCH_FIRST_MS || 700);
const CHUNKS = Number(process.env.NOAPI_BENCH_CHUNKS || 24);
const STEP_MS = Number(process.env.NOAPI_BENCH_STEP_MS || 40);
const BASE = `http://127.0.0.1:${PORT}`;

const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);

async function oneRoundTrip(i) {
  const started = Date.now();
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "chatgpt",
      messages: [{ role: "user", content: `bench question ${i}` }],
      stream: true,
    }),
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let ttfb = null;
  let lastContent = null;
  let contentChars = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (!frame.startsWith("data: ")) continue;
      const payload = frame.slice(6);
      if (payload === "[DONE]") continue;
      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = parsed.choices?.[0]?.delta;
      if (delta?.content) {
        contentChars += delta.content.length;
        lastContent = Date.now() - started;
        if (ttfb == null) ttfb = Date.now() - started;
      }
    }
  }
  const total = Date.now() - started;
  return { ttfb: ttfb ?? total, total, contentChars, afterLast: lastContent == null ? total : total - lastContent };
}

async function run() {
  const children = new Set();
  const start = (args, opts = {}) => {
    const p = spawn("node", args, { cwd: process.cwd(), ...opts });
    children.add(p);
    return p;
  };
  const stopAll = () => {
    for (const p of children) {
      try {
        p.kill();
      } catch {}
    }
  };

  try {
    console.log("=== NOAPI? latency benchmark ===");
    console.log(
      `bridge :${PORT} — ${REQUESTS} requests, fake model: first token ${FIRST_MS}ms, ` +
        `${CHUNKS} partials x ${STEP_MS}ms\n`
    );

    const bridge = start(["bridge/index.js", `--port=${PORT}`], { stdio: "ignore" });
    // Bridge stderr would be noisy here; the timings we print come from /health.
    bridge.stderr?.resume?.();
    await sleep(900);

    const fake = start(["tools/fake-extension.js", "chatgpt"], {
      stdio: "ignore",
      env: {
        ...process.env,
        NOAPI_PORT: String(PORT),
        NOAPI_FAKE_FIRST_MS: String(FIRST_MS),
        NOAPI_FAKE_STREAM_CHUNKS: String(CHUNKS),
        NOAPI_FAKE_STREAM_STEP_MS: String(STEP_MS),
        NOAPI_FAKE_DEBOUNCE_MS: "0",
      },
    });
    await sleep(1200);

    const ttfbs = [];
    const totals = [];
    const tails = [];
    for (let i = 1; i <= REQUESTS; i++) {
      const r = await oneRoundTrip(i);
      ttfbs.push(r.ttfb);
      totals.push(r.total);
      tails.push(r.afterLast);
      console.log(`  #${i}  first content at ${r.ttfb}ms   done at ${r.total}ms   (${r.contentChars} chars)`);
    }

    const health = await (await fetch(`${BASE}/health`)).json();
    const stages = health.timings?.last || {};
    console.log("\n--- summary ---");
    console.log(`time to first streamed content : ${avg(ttfbs)} ms   (min ${Math.min(...ttfbs)}, max ${Math.max(...ttfbs)})`);
    console.log(`full round trip                : ${avg(totals)} ms   (min ${Math.min(...totals)}, max ${Math.max(...totals)})`);
    console.log(`overhead after last token      : ${avg(tails)} ms   (completion detection + final flush)`);
    console.log(
      `bridge stages (last request)   : composer ${stages.composer ?? "-"}ms  typed ${stages.typed ?? "-"}ms  ` +
        `sent ${stages.sent ?? "-"}ms  first text ${stages.firstText ?? "-"}ms  complete ${stages.complete ?? "-"}ms`
    );
    console.log("\nNote: the fake tab stands in for a real website. Its simulated model time");
    console.log(`(here ~${FIRST_MS + CHUNKS * STEP_MS}ms) is not something the bridge can remove; the number`);
    console.log("that improves with streaming is 'time to first streamed content'.");
    stopAll();
    process.exit(0);
  } catch (err) {
    console.error("bench failed:", err.message);
    stopAll();
    process.exit(1);
  }
}

run();
