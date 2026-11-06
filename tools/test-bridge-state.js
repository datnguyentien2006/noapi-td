// Unit tests for bridge/state.js: the request queue, routing and the
// timeout / cancel / partial paths, without a browser or a real socket.
import { Bridge } from "../bridge/state.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function ok(name, cond, detail) {
  if (cond) console.log("ok:", name);
  else {
    console.error("FAIL:", name, detail === undefined ? "" : detail);
    failed++;
  }
}

function makeConn(id = "c1") {
  return {
    id,
    closed: false,
    sent: [],
    send(text) {
      this.sent.push(JSON.parse(text));
    },
  };
}

const outcome = (p) => p.then((text) => ({ text }), (err) => ({ err: err.message }));

// ---- timeout -------------------------------------------------------------
{
  const b = new Bridge();
  const conn = makeConn();
  b.register(conn, { site: "timeout-site" });
  const r = await outcome(b.requestPrompt({ prompt: "hi", site: "timeout-site", timeoutMs: 60 }));
  ok("timeout rejects with a clear message", /Timed out/.test(r.err || ""), r.err);
  ok("timeout tells the browser to cancel", conn.sent.some((m) => m.t === "cancel"));
  ok("timeout clears the pending request", b.listPending().length === 0);
}

// ---- abort (Esc) ---------------------------------------------------------
{
  const b = new Bridge();
  const conn = makeConn();
  b.register(conn, { site: "abort-site" });
  const ac = new AbortController();
  const p = outcome(b.requestPrompt({ prompt: "hi", site: "abort-site", signal: ac.signal }));
  await sleep(10);
  ac.abort();
  const r = await p;
  ok("abort rejects", /cancelled/i.test(r.err || ""), r.err);
  ok("abort tells the browser to cancel", conn.sent.some((m) => m.t === "cancel"));
  ok("abort clears the pending request", b.listPending().length === 0);

  const already = new AbortController();
  already.abort();
  const r2 = await outcome(b.requestPrompt({ prompt: "hi", site: "abort-site", signal: already.signal }));
  ok("already-aborted signal never dispatches", /cancelled/i.test(r2.err || ""), r2.err);
}

// ---- partial / progress / response --------------------------------------
{
  const b = new Bridge();
  const conn = makeConn();
  b.register(conn, { site: "flow-site" });
  const seen = [];
  const p = outcome(
    b.requestPrompt({
      prompt: "hi",
      site: "flow-site",
      timeoutMs: 5000,
      onProgress: (s) => seen.push("progress:" + s),
      onPartial: (t) => seen.push("partial:" + t),
    })
  );
  await sleep(10);
  const id = b.listPending()[0]?.id;
  ok("request is pending after dispatch", Boolean(id), JSON.stringify(b.listPending()));
  b.progress(id, "working");
  b.partial(id, "hello");
  b.respond(conn, id, "final answer", {
    composer: 1,
    typed: 2,
    sent: 3,
    firstText: 4,
    complete: 5,
    stopSeen: true,
    earlyReturn: true,
  });
  const r = await p;
  ok("response resolves the request", r.text === "final answer", JSON.stringify(r));
  ok("progress reaches the caller", seen.includes("progress:working"));
  ok("partial reaches the caller", seen.includes("partial:hello"));
  const last = b.timingsSummary().last;
  ok("timings are recorded", last && last.firstText === 4 && last.complete === 5, JSON.stringify(last));
  ok("earlyReturn is recorded", last?.earlyReturn === true);
  ok("request is no longer pending", b.listPending().length === 0);
  ok("a resolved request resolves only once", r.text === "final answer");
  ok("responding again is ignored", (b.respond(conn, id, "late"), b.listPending().length === 0));
}

// ---- empty / unknown responses ------------------------------------------
{
  const b = new Bridge();
  const conn = makeConn();
  b.register(conn, { site: "empty-site" });
  const p = outcome(b.requestPrompt({ prompt: "hi", site: "empty-site", timeoutMs: 5000 }));
  await sleep(10);
  const id = b.listPending()[0].id;
  b.respond(conn, id, "   ");
  const r = await p;
  ok("empty browser response is rejected", /empty response/i.test(r.err || ""), r.err);
  // Unknown ids must be ignored rather than throw.
  b.partial("does-not-exist", "x");
  b.progress("does-not-exist", "x");
  b.respond(conn, "does-not-exist", "x");
  ok("unknown ids are ignored", b.listPending().length === 0);
}

// ---- tools_enabled is forwarded -----------------------------------------
{
  const b = new Bridge();
  const on = makeConn("on");
  const off = makeConn("off");
  b.register(on, { site: "tools-on" });
  b.register(off, { site: "tools-off" });
  const kill = makeConn("kill");
  b.register(kill, { site: "tools-kill" });
  const sseKill = makeConn("sse-kill");
  b.register(sseKill, { site: "sse-kill" });
  const newChatConn = makeConn("new-chat");
  b.register(newChatConn, { site: "new-chat" });
  const p1 = outcome(
    b.requestPrompt({
      prompt: "hi",
      site: "tools-on",
      toolsEnabled: true,
      earlyReturn: true,
      earlyReturnMs: 650,
      toolNames: ["bash", "read"],
      timeoutMs: 5000,
    })
  );
  const p2 = outcome(b.requestPrompt({ prompt: "hi", site: "tools-off", timeoutMs: 5000 }));
  const p3 = outcome(
    b.requestPrompt({ prompt: "hi", site: "tools-kill", toolsEnabled: true, earlyReturn: false, timeoutMs: 5000 })
  );
  const p4 = outcome(b.requestPrompt({ prompt: "hi", site: "sse-kill", sse: false, timeoutMs: 5000 }));
  const p5 = outcome(b.requestPrompt({ prompt: "hi", site: "new-chat", newChat: true, timeoutMs: 5000 }));
  await sleep(30);
  const reqOn = on.sent.find((m) => m.t === "request");
  const reqOff = off.sent.find((m) => m.t === "request");
  const reqKill = kill.sent.find((m) => m.t === "request");
  const reqSse = sseKill.sent.find((m) => m.t === "request");
  const reqNewChat = newChatConn.sent.find((m) => m.t === "request");
  ok("tools_enabled=true is forwarded", reqOn?.tools_enabled === true, JSON.stringify(reqOn));
  ok("early_return defaults to true", reqOn?.early_return === true, JSON.stringify(reqOn));
  ok("early_return_ms is forwarded", reqOn?.early_return_ms === 650, JSON.stringify(reqOn));
  ok("tool_names are forwarded", JSON.stringify(reqOn?.tool_names) === JSON.stringify(["bash", "read"]), JSON.stringify(reqOn));
  ok("tools_enabled defaults to false", reqOff?.tools_enabled === false, JSON.stringify(reqOff));
  ok("the kill switch is forwarded as early_return=false", reqKill?.early_return === false, JSON.stringify(reqKill));
  ok("sse defaults to true", reqOn?.sse === true, JSON.stringify(reqOn));
  ok("the SSE kill switch is forwarded as sse=false", reqSse?.sse === false, JSON.stringify(reqSse));
  ok("new_chat defaults to false", reqOn?.new_chat === false, JSON.stringify(reqOn));
  ok("the new-chat flag is forwarded as new_chat=true", reqNewChat?.new_chat === true, JSON.stringify(reqNewChat));
  b.respond(on, reqOn.id, "ok");
  b.respond(off, reqOff.id, "ok");
  b.respond(kill, reqKill.id, "ok");
  b.respond(sseKill, reqSse.id, "ok");
  b.respond(newChatConn, reqNewChat.id, "ok");
  await Promise.all([p1, p2, p3, p4, p5]);
}

// ---- per-site debug counters (/health) -----------------------------------
{
  const b = new Bridge();
  const conn = makeConn();
  b.register(conn, { site: "stats-site" });

  const done = outcome(b.requestPrompt({ prompt: "hi", site: "stats-site", timeoutMs: 5000 }));
  await sleep(10);
  const id = b.listPending()[0].id;
  b.respond(conn, id, "answer", { completedBy: "stop-button", earlyReturn: true, resubmits: 2 });
  await done;

  const fallbackDone = outcome(b.requestPrompt({ prompt: "hi", site: "stats-site", timeoutMs: 5000 }));
  await sleep(10);
  const id2 = b.listPending()[0].id;
  b.respond(conn, id2, "answer", { completedBy: "fallback-2200", resubmits: 1 });
  await fallbackDone;

  const ac = new AbortController();
  const aborted = outcome(b.requestPrompt({ prompt: "hi", site: "stats-site", signal: ac.signal, timeoutMs: 5000 }));
  await sleep(10);
  ac.abort();
  await aborted;

  const timedOut = outcome(b.requestPrompt({ prompt: "hi", site: "stats-site", timeoutMs: 40 }));
  await timedOut;

  const sseDone = outcome(b.requestPrompt({ prompt: "hi", site: "stats-site", timeoutMs: 5000 }));
  await sleep(10);
  const id3 = b.listPending()[0].id;
  b.respond(conn, id3, "answer", { completedBy: "sse", sseSeen: true });
  await sseDone;

  const s = b.status().stats["stats-site"];
  ok("stats: dispatch count", s.requests === 5, JSON.stringify(s));
  ok("stats: stop-button completions counted", s.completedByStop === 1, JSON.stringify(s));
  ok("stats: fallback completions counted", s.completedByFallback === 1, JSON.stringify(s));
  ok("stats: sse completions counted", s.completedBySse === 1, JSON.stringify(s));
  ok("stats: sseSeen turns counted", s.sseSeen === 1, JSON.stringify(s));
  ok("stats: early returns counted", s.earlyReturn === 1, JSON.stringify(s));
  ok("stats: resubmits summed", s.resubmits === 3, JSON.stringify(s));
  ok("stats: client aborts counted", s.aborted === 1, JSON.stringify(s));
  ok("stats: timeouts counted", s.timeouts === 1, JSON.stringify(s));
  ok("stats: exposed by status() for /health", Boolean(b.status().stats["stats-site"]));
}

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nall bridge state tests passed");