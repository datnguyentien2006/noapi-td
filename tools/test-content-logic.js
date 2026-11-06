// Unit tests for the small pure functions that live inside the content script.
//
// The content script only runs in a browser (it is a DOM-automation script), so
// the few decisions that must be correct are written as self-contained functions
// between `@noapi-shared` markers. This test lifts those blocks out of
// extension/*/content.js and runs them in Node, which gives real coverage for
// logic that otherwise could only be checked by hand on a live site. The blocks
// must stay identical in both browsers, so the test also verifies that.
import fs from "node:fs";

function extractShared(file, name) {
  const src = fs.readFileSync(file, "utf8");
  const re = new RegExp(
    "\\/\\* @noapi-shared-start " + name + " \\*\\/([\\s\\S]*?)\\/\\* @noapi-shared-end " + name + " \\*\\/"
  );
  const m = src.match(re);
  if (!m) throw new Error(`shared block "${name}" not found in ${file}`);
  return m[1];
}

function loadShared(name, { wrap = "", fn = name } = {}) {
  const chrome = extractShared("extension/chrome/content.js", name);
  const firefox = extractShared("extension/firefox/content.js", name);
  if (chrome !== firefox) {
    throw new Error(`shared block "${name}" differs between chrome and firefox content.js`);
  }
  const body = wrap ? wrap.replace("/* SHARED */", chrome) : chrome;
  return new Function(`${body}\nreturn ${fn};`)();
}

let failed = 0;
function ok(name, cond) {
  if (cond) console.log("ok:", name);
  else {
    console.error("FAIL:", name);
    failed++;
  }
}

// ---- completionDecision (Phase 1) -----------------------------------------
// (lastTextLength, stopVisible, stopSeen, quietMs, debounceMs, fallbackMs)
const complete = loadShared("completionDecision");

ok("no completion on an empty reply", !complete(0, false, true, 10_000, 400, 2200));
ok("no completion on a tiny reply", !complete(4, false, true, 10_000, 400, 2200));
ok("no completion while the stop button is visible", !complete(50, true, true, 10_000, 400, 2200));
ok("stop seen: completes after the per-site debounce", complete(50, false, true, 400, 400, 2200));
ok("stop seen: not before the debounce", !complete(50, false, true, 399, 400, 2200));
ok("stop never seen: waits for the long fallback", !complete(50, false, false, 2199, 400, 2200));
ok("stop never seen: completes at the long fallback", complete(50, false, false, 2200, 400, 2200));
ok("faster debounce completes sooner", complete(50, false, true, 350, 350, 2200) && !complete(50, false, true, 350, 400, 2200));

// ---- tick scheduling (Phase 1) --------------------------------------------
// The completion loop's coalescing scheduler: a burst of mutations must wake
// exactly one tick, and two ticks must never run at the same time.
const makeScheduler = loadShared("tickScheduler", { fn: "createTickScheduler" });
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

{
  const q = [];
  let runs = 0;
  const s = makeScheduler(() => {
    runs++;
  }, (fn) => q.push(fn));
  s.schedule();
  s.schedule();
  s.schedule();
  ok("a burst of schedules coalesces into one pending run", q.length === 1, String(q.length));
  q.shift()();
  await flush();
  ok("the coalesced run executed exactly once", runs === 1, String(runs));
  ok("nothing extra was queued", q.length === 0, String(q.length));
}

{
  const q = [];
  let runs = 0;
  let active = 0;
  let maxActive = 0;
  let release = () => {};
  const s = makeScheduler(() => {
    runs++;
    active++;
    maxActive = Math.max(maxActive, active);
    return new Promise((r) => {
      release = () => {
        active--;
        r();
      };
    });
  }, (fn) => q.push(fn));
  s.schedule();
  q.shift()();
  await flush();
  ok("the first tick started", runs === 1 && active === 1, `runs=${runs} active=${active}`);
  s.schedule();
  s.schedule();
  ok("a schedule during a running tick does not start a second one", q.length === 0 && runs === 1, `q=${q.length} runs=${runs}`);
  release();
  await flush();
  ok("a follow-up tick is queued once the running tick finishes", q.length === 1 && runs === 1, `q=${q.length} runs=${runs}`);
  q.shift()();
  await flush();
  ok("the follow-up tick ran", runs === 2, String(runs));
  ok("ticks never overlapped", maxActive === 1, String(maxActive));
  release();
  await flush();
  ok("no extra ticks afterwards", runs === 2 && q.length === 0, `runs=${runs} q=${q.length}`);
}

{
  const q = [];
  let runs = 0;
  const s = makeScheduler(() => {
    runs++;
  }, (fn) => q.push(fn));
  s.stop();
  s.schedule();
  ok("stop() makes schedule a no-op", q.length === 0 && runs === 0);
}

{
  const q = [];
  let runs = 0;
  const s = makeScheduler(() => {
    runs++;
    if (runs === 1) throw new Error("boom");
  }, (fn) => q.push(fn));
  s.schedule();
  q.shift()();
  await flush();
  s.schedule();
  ok("a throwing tick is caught and does not wedge the scheduler", q.length === 1, String(q.length));
  q.shift()();
  await flush();
  ok("the scheduler runs again after a throw", runs === 2, String(runs));
}

// ---- send gate (Phase 2) ---------------------------------------------------
// The submit poll: wait for the page's send control to enable, checking every
// pollMs and giving up at timeoutMs. A fake clock makes the timing exact.
const makeSendGate = loadShared("sendGate", { fn: "createSendGate" });

{
  let t = 0;
  const sleeps = [];
  const sleep = (ms) => {
    t += ms;
    sleeps.push(ms);
    return Promise.resolve();
  };
  const gate = makeSendGate({ probe: () => t >= 90, now: () => t, sleep, timeoutMs: 1200, pollMs: 30 });
  const ready = await gate();
  ok("the send gate reports ready once the control enables", ready === true);
  ok("it wakes on the 30ms grid and clicks right when it enables (never before)", t === 90, String(t));
  ok("every wait was one poll step", sleeps.every((s) => s === 30), sleeps.join(","));
}

{
  let t = 0;
  let probes = 0;
  const sleep = (ms) => {
    t += ms;
    return Promise.resolve();
  };
  const gate = makeSendGate({
    probe: () => {
      probes++;
      return probes >= 3; // enables on the third look, i.e. after 2 sleeps
    },
    now: () => t,
    sleep,
    timeoutMs: 1200,
    pollMs: 30,
  });
  const ready = await gate();
  ok("a control that enables after a delay is still caught", ready === true && t === 60, `ready=${ready} t=${t}`);
}

{
  let t = 0;
  const sleep = (ms) => {
    t += ms;
    return Promise.resolve();
  };
  const gate = makeSendGate({ probe: () => false, now: () => t, sleep, timeoutMs: 100, pollMs: 30 });
  const ready = await gate();
  ok("the send gate gives up once the timeout passes", ready === false);
  ok("it stops at the cap and does not poll forever", t <= 130, String(t));
}

{
  let t = 0;
  const gate = makeSendGate({ probe: () => true, now: () => t, sleep: () => Promise.resolve(), timeoutMs: 1200, pollMs: 30 });
  const ready = await gate();
  ok("an already-enabled control returns immediately with no wait", ready === true && t === 0, String(t));
}

// ---- SSE completion signal (Phase 3) --------------------------------------
// sseDecision(turn, live): "ended" once a stream that started after the turn
// snapshot closes, "started" while one is live, "none" otherwise.
const sseDecision = loadShared("sseDecision");

ok(
  "no SSE decision before any stream is seen",
  sseDecision({ started: 0, ended: 0 }, { started: 0, ended: 0, active: 0 }) === "none"
);
ok(
  "a live stream counts as activity",
  sseDecision({ started: 0, ended: 0 }, { started: 1, ended: 0, active: 1 }) === "started"
);
ok(
  "an already-ended stream from before the turn is ignored",
  sseDecision({ started: 2, ended: 2 }, { started: 2, ended: 2, active: 0 }) === "none"
);
ok(
  "a stream that ends after the turn completes",
  sseDecision({ started: 1, ended: 0 }, { started: 1, ended: 1, active: 1 }) === "started" &&
    sseDecision({ started: 1, ended: 0 }, { started: 1, ended: 1, active: 0 }) === "ended"
);
ok(
  "a stream that starts and ends between two ticks is still seen as ended",
  sseDecision({ started: 0, ended: 0 }, { started: 1, ended: 1, active: 0 }) === "ended"
);
ok(
  "while another stream is still open, it stays started",
  sseDecision({ started: 0, ended: 0 }, { started: 2, ended: 1, active: 1 }) === "started"
);
ok("a missing snapshot is safe", sseDecision(null, { started: 1, ended: 1, active: 0 }) === "none");
ok(
  "an errored stream is activity but never a completion",
  sseDecision({ started: 0, ended: 0, errored: 0 }, { started: 1, ended: 0, errored: 1, active: 0 }) === "started" &&
    sseDecision({ started: 0, ended: 0, errored: 0 }, { started: 1, ended: 0, errored: 1, active: 0 }) !== "ended"
);

// ---- early return on a complete TOOL_CALL (Phase 4) -----------------------
const early = loadShared("toolEarlyReturn", { fn: "toolEarlyReturnDecision" });
const countBlocks = loadShared("toolEarlyReturn", { fn: "toolBlockCount" });
const completeCall =
  "On it.\n```\nTOOL_CALL\n{\"name\":\"bash\",\"arguments\":{\"command\":\"mkdir x\"}}\n```";
const secondCall =
  "```\nTOOL_CALL\n{\"name\":\"read\",\"arguments\":{\"filePath\":\"a.txt\"}}\n```";
const TOOL_NAMES = ["bash", "read"];
const decision = (over = {}) =>
  early({ toolsEnabled: true, enabled: true, quietMs: 10_000, earlyReturnMs: 400, toolNames: TOOL_NAMES, ...over });

ok("plain text is not a tool call", !decision({ replyText: "just a normal answer" }));
ok("tool marker without a fence is not complete", !decision({ replyText: "TOOL_CALL {\"name\":\"bash\"}" }));
ok(
  "unclosed tool JSON is not complete",
  !decision({ replyText: "```\nTOOL_CALL\n{\"name\":\"bash\",\"arguments\":{" })
);
ok(
  "invalid JSON is not complete",
  !decision({ replyText: "```\nTOOL_CALL\n{\"name\":\"bash\",\"arguments\":{oops}}\n```" })
);
ok(
  "a block for an unknown tool is not actionable",
  !decision({ replyText: "```\nTOOL_CALL\n{\"name\":\"nope\",\"arguments\":{}}\n```" })
);
ok(
  "brace inside a JSON string does not end the object early",
  decision({ replyText: "```\nTOOL_CALL\n{\"name\":\"bash\",\"arguments\":{\"command\":\"echo {x}\"}}\n```" })
);
ok("a complete tool call is actionable", decision({ replyText: completeCall }));
ok("but not before the quiet window", !decision({ replyText: completeCall, quietMs: 399 }));
ok("tools disabled: never early-returns", !decision({ replyText: completeCall, toolsEnabled: false }));
ok("kill switch: never early-returns or stops", !decision({ replyText: completeCall, enabled: false }));
ok("two complete blocks: still actionable", decision({ replyText: completeCall + "\n" + secondCall }));
ok(
  "a second block still streaming is NOT cut off",
  !decision({ replyText: completeCall + "\n```\nTOOL_CALL\n{\"name\":\"read\",\"arg" })
);
ok(
  "trailing narration after the block waits for real completion",
  !decision({ replyText: completeCall + "\nNow let me explain the change I made." })
);

// A gap shorter than the grace window: both blocks land before it expires, so
// the reply ends with the second complete block and is actionable.
ok(
  "two blocks with a gap shorter than the window are returned together",
  decision({ replyText: completeCall + "\n" + secondCall, quietMs: 400 })
);
// A gap longer than the window while the site keeps generating: the first block
// is complete and quiet, but the site is still writing, so we must not stop yet.
ok(
  "a gap longer than the window is extended while the site is still generating",
  !decision({ replyText: completeCall, quietMs: 400, generating: true, sinceBlockMs: 400 })
);
ok(
  "...and it stops at the hard cap",
  decision({ replyText: completeCall, quietMs: 400, generating: true, sinceBlockMs: 1500 })
);
ok(
  "...but not if the site is already idle",
  decision({ replyText: completeCall, quietMs: 400, generating: false })
);

// The re-read after clicking stop compares complete-block counts.
ok("toolBlockCount counts complete blocks", countBlocks(completeCall + "\n" + secondCall, TOOL_NAMES) === 2);
ok("toolBlockCount ignores invalid JSON", countBlocks("```\nTOOL_CALL\n{oops}\n```", TOOL_NAMES) === 0);
ok("toolBlockCount ignores unknown tools", countBlocks("```\nTOOL_CALL\n{\"name\":\"nope\",\"arguments\":{}}\n```", TOOL_NAMES) === 0);

// ---- waitForIdle's busy check (Phase 8) ------------------------------------
// The first probe passes prev=null; if the stop control is gone the site is
// considered idle without the old 700ms sleep. Later probes need text stability.
const stillBusy = loadShared("idleCheck", { fn: "stillBusy" });
ok("idle: no stop control, first probe -> not busy", !stillBusy(false, "some text", null));
ok("busy: stop control visible, first probe", stillBusy(true, "some text", null));
ok("busy: reply still changing", stillBusy(false, "growing", "grow"));
ok("idle: stop gone and text stable", !stillBusy(false, "stable", "stable"));

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nall content-script logic tests passed");
