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
  const abortId = b.listPending()[0].id;
  ac.abort();
  await aborted;
  // The slot is now held until the tab acks; release it so the next request runs.
  b.ackCancelled?.(abortId);

  const timedOut = outcome(b.requestPrompt({ prompt: "hi", site: "stats-site", timeoutMs: 40 }));
  await sleep(10);
  const timeoutId = b.listPending()[0].id;
  await timedOut;
  b.ackCancelled?.(timeoutId);

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

// ---- timing retention (for the A/B report) --------------------------------
{
  const b = new Bridge();
  for (let i = 0; i < 60; i++) {
    b.recordTiming({ id: "a" + i, site: "site-a", startedAt: Date.now() - (100 + i) }, { firstText: i + 1, complete: i + 2, completedBy: "sse", sseSeen: true });
  }
  for (let i = 0; i < 10; i++) {
    b.recordTiming({ id: "b" + i, site: "site-b", startedAt: Date.now() - 50 }, { firstText: 1, complete: 2, completedBy: "stop-button" });
  }
  const sum = b.timingsSummary();
  ok(
    "keeps at least 50 recent records per site",
    sum.bySite["site-a"].recent.length === 50 && sum.bySite["site-b"].recent.length === 10,
    JSON.stringify({ a: sum.bySite["site-a"].recent.length, b: sum.bySite["site-b"].recent.length })
  );
  ok("trimming one site keeps another site's records", sum.bySite["site-b"].recent.length === 10);
  ok("the oldest record of a site is dropped first", sum.bySite["site-a"].recent[0].id === "a10", String(sum.bySite["site-a"].recent[0].id));
  ok("per-site recent records are exposed by /health", Array.isArray(sum.bySite["site-a"].recent));
  // A flood of distinct site names must not grow memory without bound.
  for (let i = 0; i < 600; i++) b.recordTiming({ id: "x" + i, site: "flood-" + i, startedAt: Date.now() }, { total: 1 });
  ok("overall record count stays bounded", b.timings.length <= 500, String(b.timings.length));
}

// ---- cancel / queue release race ------------------------------------------
// A cancelled request must reject its caller immediately, but its per-site slot
// must stay held until the browser confirms it stopped (ack / terminal message /
// socket close / safety timeout), so the next request is never delivered while
// the tab is still unwinding the cancelled one.

// abort: B and C wait for A's ack, then run one at a time.
{
  const b = new Bridge();
  const conn = makeConn();
  b.register(conn, { site: "race-ack" });
  const ac = new AbortController();
  const A = outcome(b.requestPrompt({ prompt: "A", site: "race-ack", signal: ac.signal, timeoutMs: 5000 }));
  await sleep(10);
  const idA = b.listPending()[0].id;
  const B = outcome(b.requestPrompt({ prompt: "B", site: "race-ack", timeoutMs: 5000 }));
  const C = outcome(b.requestPrompt({ prompt: "C", site: "race-ack", timeoutMs: 5000 }));
  await sleep(10);
  ok("only A is dispatched while B and C are queued", conn.sent.filter((m) => m.t === "request").length === 1);

  ac.abort();
  const rA = await A;
  ok("A rejects immediately on abort", /cancelled/i.test(rA.err || ""), rA.err);
  ok("A told the browser to cancel", conn.sent.some((m) => m.t === "cancel" && m.id === idA));

  await sleep(80);
  ok(
    "B is NOT dispatched before A's cancel is acked",
    conn.sent.filter((m) => m.t === "request").length === 1,
    String(conn.sent.filter((m) => m.t === "request").length)
  );

  b.ackCancelled?.(idA);
  await sleep(20);
  const reqs2 = conn.sent.filter((m) => m.t === "request");
  ok("B is dispatched after the ack", reqs2.length === 2 && reqs2[1].prompt === "B", JSON.stringify(reqs2.map((r) => r.prompt)));
  b.respond(conn, reqs2[1].id, "b-answer");
  const rB = await B;
  ok("B resolved with its own answer", rB.text === "b-answer", JSON.stringify(rB));
  const reqs3 = conn.sent.filter((m) => m.t === "request");
  ok("C is dispatched only after B completes", reqs3.length === 3 && reqs3[2].prompt === "C", JSON.stringify(reqs3.map((r) => r.prompt)));
  b.respond(conn, reqs3[2].id, "c-answer");
  const rC = await C;
  ok("C resolved", rC.text === "c-answer", JSON.stringify(rC));
  ok("the site queue is empty at the end", b.listPending().length === 0);
}

// timeout: same deferral on the timeout path.
{
  const b = new Bridge();
  const conn = makeConn();
  b.register(conn, { site: "race-timeout" });
  const A = outcome(b.requestPrompt({ prompt: "A", site: "race-timeout", timeoutMs: 60 }));
  await sleep(10);
  const idA = b.listPending()[0].id;
  const B = outcome(b.requestPrompt({ prompt: "B", site: "race-timeout", timeoutMs: 5000 }));
  const rA = await A;
  ok("timeout rejects A", /Timed out/.test(rA.err || ""), rA.err);
  await sleep(30);
  ok("B waits for the timeout cancel ack", conn.sent.filter((m) => m.t === "request").length === 1);
  b.ackCancelled?.(idA);
  await sleep(20);
  const reqs = conn.sent.filter((m) => m.t === "request");
  ok("B is dispatched after the timeout ack", reqs.length === 2 && reqs[1].prompt === "B", JSON.stringify(reqs.map((r) => r.prompt)));
  b.respond(conn, reqs[1].id, "b-answer");
  const rB = await B;
  ok("B resolved after the timeout cancel", rB.text === "b-answer", JSON.stringify(rB));
}

// no ack at all: the safety timeout releases the slot and warns.
{
  const logs = [];
  const b = new Bridge({ log: (m) => logs.push(m), cancelAckMs: 70 });
  const conn = makeConn();
  b.register(conn, { site: "race-noack" });
  const ac = new AbortController();
  const A = outcome(b.requestPrompt({ prompt: "A", site: "race-noack", signal: ac.signal, timeoutMs: 5000 }));
  await sleep(10);
  const B = outcome(b.requestPrompt({ prompt: "B", site: "race-noack", timeoutMs: 5000 }));
  ac.abort();
  await A;
  await sleep(30);
  ok("B is still queued before the ack timeout", conn.sent.filter((m) => m.t === "request").length === 1);
  await sleep(80);
  const reqs = conn.sent.filter((m) => m.t === "request");
  ok("B proceeds after the safety timeout", reqs.length === 2, String(reqs.length));
  ok("a warning is logged when no ack arrives", logs.some((l) => /no cancel acknowledgement/i.test(l)), JSON.stringify(logs));
  b.respond(conn, reqs[1].id, "b-answer");
  const rB = await B;
  ok("B resolved after the safety timeout", rB.text === "b-answer", JSON.stringify(rB));
}

// socket closes while A is being cancelled: the queue is released, B settles.
{
  const b = new Bridge();
  const conn = makeConn();
  b.register(conn, { site: "race-close" });
  const ac = new AbortController();
  const A = outcome(b.requestPrompt({ prompt: "A", site: "race-close", signal: ac.signal, timeoutMs: 5000 }));
  await sleep(10);
  const B = outcome(b.requestPrompt({ prompt: "B", site: "race-close", timeoutMs: 5000 }));
  ac.abort();
  await A;
  await sleep(20);
  ok("B is queued while A's cancel is unacked", conn.sent.filter((m) => m.t === "request").length === 1);
  conn.closed = true;
  b.unregister(conn);
  const rB = await B;
  ok("closing the socket releases the queue (B settles)", rB.err !== undefined, JSON.stringify(rB));
  ok("B fails because its tab is gone", /No browser tab/.test(rB.err || ""), rB.err);
}

// busy: the bridge retries instead of surfacing the busy error.
{
  const logs = [];
  const b = new Bridge({ log: (m) => logs.push(m), busyGiveUpMs: 2000 });
  const conn = makeConn();
  b.register(conn, { site: "busy-retry" });
  const p = outcome(b.requestPrompt({ prompt: "hi", site: "busy-retry", timeoutMs: 5000 }));
  await sleep(10);
  const id = b.listPending()[0].id;
  b.fail(conn, id, "This tab is already handling a prompt.", "busy");
  await sleep(150);
  const reqs = conn.sent.filter((m) => m.t === "request");
  ok("busy triggers a retry with the same id", reqs.length >= 2 && reqs.every((r) => r.id === id), JSON.stringify(reqs.map((r) => r.id)));
  b.respond(conn, id, "done");
  const r = await p;
  ok("a busy rejection is retried, never surfaced", r.text === "done", JSON.stringify(r));
  ok("busy retries are logged", logs.some((l) => /busy/i.test(l)), JSON.stringify(logs));
}

// busy forever: give up with a clear error, and free the slot.
{
  const b = new Bridge({ log: () => {}, busyGiveUpMs: 120 });
  const conn = makeConn();
  b.register(conn, { site: "busy-giveup" });
  const p = outcome(b.requestPrompt({ prompt: "hi", site: "busy-giveup", timeoutMs: 5000 }));
  await sleep(10);
  const id = b.listPending()[0].id;
  for (let i = 0; i < 6; i++) {
    b.fail(conn, id, "This tab is already handling a prompt.", "busy");
    await sleep(60);
  }
  const r = await p;
  ok("busy gives up with a clear error", /stayed busy/i.test(r.err || ""), r.err);
  ok("the give-up error is not the raw busy text", !/already handling a prompt/i.test(r.err || ""), r.err);
  ok("the site slot is free after giving up", b.listPending().length === 0);
}

// a late response/error for a cancelled id releases the slot and is never
// mistaken for the next request's answer.
{
  const b = new Bridge();
  const conn = makeConn();
  b.register(conn, { site: "late-site" });
  const ac = new AbortController();
  const A = outcome(b.requestPrompt({ prompt: "A", site: "late-site", signal: ac.signal, timeoutMs: 5000 }));
  await sleep(10);
  const idA = b.listPending()[0].id;
  const B = outcome(b.requestPrompt({ prompt: "B", site: "late-site", timeoutMs: 5000 }));
  ac.abort();
  await A;
  b.respond(conn, idA, "late answer for A");
  await sleep(20);
  const reqs = conn.sent.filter((m) => m.t === "request");
  ok("a late response releases the slot", reqs.length === 2, String(reqs.length));
  ok("the next request keeps its own identity", reqs[1].prompt === "B");
  b.respond(conn, reqs[1].id, "b-answer");
  const rB = await B;
  ok("the next request gets its own answer, not the late one", rB.text === "b-answer", JSON.stringify(rB));
  ok(
    "no timing is recorded for the cancelled late response",
    !(b.timingsSummary().bySite["late-site"]?.recent || []).some((r) => r.id === idA),
    JSON.stringify(b.timingsSummary().bySite["late-site"])
  );
}

// a late error for a cancelled id does the same.
{
  const b = new Bridge();
  const conn = makeConn();
  b.register(conn, { site: "late-error" });
  const ac = new AbortController();
  const A = outcome(b.requestPrompt({ prompt: "A", site: "late-error", signal: ac.signal, timeoutMs: 5000 }));
  await sleep(10);
  const idA = b.listPending()[0].id;
  const B = outcome(b.requestPrompt({ prompt: "B", site: "late-error", timeoutMs: 5000 }));
  ac.abort();
  await A;
  b.fail(conn, idA, "Cancelled.");
  await sleep(20);
  const reqs = conn.sent.filter((m) => m.t === "request");
  ok("a late error releases the slot", reqs.length === 2, String(reqs.length));
  b.respond(conn, reqs[1].id, "b-answer");
  const rB = await B;
  ok("B still resolves after a late error for A", rB.text === "b-answer", JSON.stringify(rB));
}

// a site with no tab is never served by another site's tab.
{
  const b = new Bridge();
  const claude = makeConn("claude");
  b.register(claude, { site: "claude" });
  const r = await outcome(b.requestPrompt({ prompt: "hi", site: "chatgpt", timeoutMs: 5000 }));
  ok("a site with no tab does not fall back to another site", /No browser tab on "chatgpt"/.test(r.err || ""), r.err);
  ok("nothing was delivered to the claude tab", claude.sent.filter((m) => m.t === "request").length === 0, JSON.stringify(claude.sent));
}

// sites() reflects the tabs that are actually connected.
{
  const b = new Bridge();
  const conn = makeConn();
  b.register(conn, { site: "chatgpt" });
  b.register(conn, { site: "claude" });
  const avail = () => b.sites().filter((s) => s.available).map((s) => s.key);
  ok("one socket can report several sites", avail().includes("chatgpt") && avail().includes("claude"), JSON.stringify(avail()));
  b.removeSite?.(conn, "claude");
  ok("removing a site stops reporting it", avail().includes("chatgpt") && !avail().includes("claude"), JSON.stringify(avail()));
  b.removeSite?.(conn, "chatgpt");
  ok("a socket with no sites reports none", avail().length === 0, JSON.stringify(avail()));
}

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nall bridge state tests passed");