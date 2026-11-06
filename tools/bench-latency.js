// Latency benchmark for the NOAPI? bridge, using the fake browser tab and the
// per-stage timings from Phase 0 instrumentation.
//
//   npm run bench
//
// It runs the SAME simulated model twice, changing only the client behaviour:
//   old - fixed typing sleeps, no streaming, 2200ms "no change" completion rule
//   new - condition-based typing, live streaming, stop-button completion
// and reports four numbers side by side:
//   (a) time to first streamed content
//   (b) overhead after the last token (completion detection + final flush)
//   (c) typing + send overhead per turn
//   (d) full round trip
//
// The fake tab is a SIMULATION. Only the timings /health reports on a real site
// are ground truth; these numbers are for comparing changes, not for predicting
// a specific website.
//
// Each scenario gets its own bridge on an ephemeral port (see lib/harness.js),
// so the benchmark can never touch a real bridge on the default port.
//
// Knobs:
//   NOAPI_BENCH_REQUESTS       how many round trips per scenario (default 5)
//   NOAPI_BENCH_FIRST_MS       model delay before the first token (default 700)
//   NOAPI_BENCH_CHUNKS         streamed model updates (default 24)
//   NOAPI_BENCH_STEP_MS        delay between model updates (default 40)
import {
  startBridge,
  startFake,
  waitForHealth,
  stopAll,
  warnIfDefaultBridge,
  sleep,
} from "./lib/harness.js";

const REQUESTS = Number(process.env.NOAPI_BENCH_REQUESTS || 5);
const FIRST_MS = Number(process.env.NOAPI_BENCH_FIRST_MS || 700);
const CHUNKS = Number(process.env.NOAPI_BENCH_CHUNKS || 24);
const STEP_MS = Number(process.env.NOAPI_BENCH_STEP_MS || 40);

const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);

async function oneRoundTrip(base, i) {
  const started = Date.now();
  const res = await fetch(`${base}/v1/chat/completions`, {
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
        if (ttfb == null) ttfb = Date.now() - started;
      }
    }
  }
  const total = Date.now() - started;
  return { ttfb: ttfb ?? total, total, contentChars };
}

async function runScenario(mode) {
  try {
    const { port } = await startBridge({ port: 0 });
    const base = `http://127.0.0.1:${port}`;

    startFake({
      port,
      site: "chatgpt",
      env: {
        NOAPI_FAKE_MODE: mode,
        NOAPI_FAKE_FIRST_MS: String(FIRST_MS),
        NOAPI_FAKE_STREAM_CHUNKS: String(CHUNKS),
        NOAPI_FAKE_STREAM_STEP_MS: String(STEP_MS),
      },
    });
    await waitForHealth(port, { clients: true });

    const ttfb = [];
    const total = [];
    for (let i = 1; i <= REQUESTS; i++) {
      const r = await oneRoundTrip(base, i);
      ttfb.push(r.ttfb);
      total.push(r.total);
    }

    const health = await (await fetch(`${base}/health`)).json();
    const recent = health.timings?.recent || [];
    const overhead = recent
      .filter((r) => Number.isFinite(r.complete) && Number.isFinite(r.lastToken))
      .map((r) => r.complete - r.lastToken);
    const typing = recent.map((r) => r.sent).filter((v) => Number.isFinite(v));

    return {
      mode,
      port,
      ttfb: avg(ttfb),
      total: avg(total),
      overhead: avg(overhead),
      typing: avg(typing),
      runs: REQUESTS,
      last: health.timings?.last || null,
    };
  } finally {
    stopAll();
    await sleep(300);
  }
}

function table(oldR, newR) {
  const rows = [
    ["(a) first streamed content", oldR.ttfb, newR.ttfb],
    ["(b) overhead after last token", oldR.overhead, newR.overhead],
    ["(c) typing + send overhead", oldR.typing, newR.typing],
    ["(d) full round trip", oldR.total, newR.total],
  ];
  const label = 30;
  const cell = 20;
  const head = "metric".padEnd(label) + "old (2200ms rule)".padStart(cell) + "new (stop button)".padStart(cell);
  console.log(head);
  console.log("-".repeat(head.length));
  for (const [name, o, n] of rows) {
    console.log(name.padEnd(label) + `${o} ms`.padStart(cell) + `${n} ms`.padStart(cell));
  }
}

async function run() {
  try {
    await warnIfDefaultBridge();
    console.log("=== NOAPI? latency benchmark ===\n");
    console.log(
      `Same simulated model for both scenarios: first token ${FIRST_MS}ms, ` +
        `${CHUNKS} updates x ${STEP_MS}ms. ${REQUESTS} round trips each.\n`
    );

    const oldR = await runScenario("old");
    const newR = await runScenario("new");

    console.log("");
    table(oldR, newR);

    console.log("\n--- detail ---");
    for (const r of [oldR, newR]) {
      console.log(
        `${r.mode.padEnd(3)} : :${r.port}  first ${r.ttfb}ms  after-last-token ${r.overhead}ms  ` +
          `typing ${r.typing}ms  total ${r.total}ms` +
          (r.last?.completedBy ? `  completedBy=${r.last.completedBy}` : "")
      );
    }

    console.log("\nNOTE: these numbers come from a simulation (tools/fake-extension.js).");
    console.log("Only the per-stage timings that /health reports on a real site are ground truth.");

    process.exit(0);
  } catch (err) {
    console.error("bench failed:", err.message);
    stopAll();
    process.exit(1);
  }
}

run();