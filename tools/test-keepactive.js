// Tests the keepActive controller lifted out of content.js (marker @noapi-shared-keepActive).
// Run: node tools/test-keepactive.js
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import nodePath from "node:path";

const here = nodePath.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(process.env.CONTENT || nodePath.join(here, "../extension/content.js"), "utf8");
const m = /\/\* @noapi-shared-start keepActive \*\/([\s\S]*?)\/\* @noapi-shared-end keepActive \*\//.exec(src);
assert.ok(m, "keepActive block markers present in content.js");
const createKeepActive = new Function(m[1] + "; return createKeepActive;")();

function env(over = {}) {
  const attrs = new Map();
  const doc = {
    visibilityState: "visible", body: {},
    documentElement: { setAttribute: (k, v) => attrs.set(k, String(v)), removeAttribute: (k) => attrs.delete(k), getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null) },
  };
  const timers = []; let clock = 1000; const logs = []; const lockEvents = [];
  const e = {
    doc, attrs, timers, logs, lockEvents,
    tick(ms = 1000) { clock += ms; for (const t of timers) t.fn(); },
    locks: { request: (name, cb) => { lockEvents.push("request:" + name); return Promise.resolve(cb()).then(() => lockEvents.push("released")); } },
    setInterval: (fn) => { const t = { fn }; timers.push(t); return timers.length - 1; },
    clearInterval: (i) => { if (timers[i]) timers[i].fn = () => {}; timers[i] && (timers[i].cleared = true); },
    raf: (f) => { e.rafCb = f; return 7; }, caf: () => { e.rafCancelled = true; },
    MO: class { constructor(cb) { e.moCb = cb; } observe() { e.moObserved = true; } disconnect() { e.moDisconnected = true; } },
    domChars: () => e.dom ?? 0, sseActive: () => e.sse ?? 0, log: (x) => logs.push(x), now: () => clock, dom: 0, sse: 0,
    ...over,
  };
  return e;
}
let n = 0; const ok = (msg) => { n++; console.log("ok -", msg); };
const tick = () => new Promise((r) => setTimeout(r, 5));

// (a) the marker is set for the request and ALWAYS removed: success
{
  const e = env(); const k = createKeepActive(e);
  k.setEnabled(true);
  assert.equal(e.attrs.get("data-noapi-keepactive"), "1");
  const run = k.begin({ spoof: true });
  assert.equal(e.attrs.get("data-noapi-active"), "1");
  const t = {}; run.fill(t); run.stop();
  assert.equal(e.attrs.has("data-noapi-active"), false);
  ok("success path: marker set during the request and removed after");
}
// (b) error / cancel: stop() runs from `finally` whatever happened; also twice
{
  const e = env(); const k = createKeepActive(e);
  const run = k.begin({ spoof: true });
  try { throw new Error("Cancelled."); } catch {} finally { run.stop(); run.stop(); }
  assert.equal(e.attrs.has("data-noapi-active"), false);
  ok("error and cancel paths: marker removed (stop is idempotent)");
}
// (c) stop() still removes the marker when every other piece throws
{
  const e = env({
    locks: { request: () => { throw new Error("no locks"); } },
    MO: class { constructor() { throw new Error("no MO"); } },
    raf: () => { throw new Error("no raf"); }, caf: () => { throw new Error("no caf"); },
    setInterval: () => { throw new Error("no timers"); }, clearInterval: () => { throw new Error("no clear"); },
    domChars: () => { throw new Error("x"); },
  });
  const run = createKeepActive(e).begin({ spoof: true });
  assert.equal(e.attrs.get("data-noapi-active"), "1");
  run.stop();
  assert.equal(e.attrs.has("data-noapi-active"), false);
  ok("every helper failing never leaves the marker behind");
}
// (d) Web Lock held while the request runs, released at the end (even if stop comes first)
{
  const e = env(); const run = createKeepActive(e).begin({ spoof: true });
  await tick();
  assert.ok(e.lockEvents.some((x) => x.startsWith("request:noapi-active-")));
  assert.ok(!e.lockEvents.includes("released"), "held during the request");
  run.stop(); await tick();
  assert.ok(e.lockEvents.includes("released"));
  const e2 = env(); const r2 = createKeepActive(e2).begin({ spoof: true }); r2.stop(); await tick();
  assert.ok(e2.lockEvents.includes("released"), "stop before the lock was granted still releases it");
  ok("Web Lock is held for the request and released afterwards");
}
// (e) diagnostics: hidden samples, log every 5 s, counters in the timings
{
  const e = env(); const run = createKeepActive(e).begin({ spoof: true });
  e.attrs.set("data-noapi-pa", "worker:42");
  e.doc.visibilityState = "hidden";
  e.dom = 120; e.sse = 1; e.moCb(); e.moCb(); e.rafCb();
  for (let i = 0; i < 5; i++) e.tick(1000);
  assert.equal(e.logs.length, 1);
  assert.equal(e.logs[0], "[noapi] hidden: dom=120 sse_active=1 mutations=2 raf=1 pa=worker:42");
  for (let i = 0; i < 5; i++) e.tick(1000);
  assert.equal(e.logs.length, 2, "one line per 5 s");
  const t = {}; run.fill(t);
  assert.equal(t.vis, "hidden"); assert.equal(t.hiddenMs, 10000); assert.equal(t.mut, 2); assert.equal(t.raf, 1); assert.equal(t.domMax, 120);
  assert.equal(t.pa, "worker:42"); assert.equal(t.keepActive, true);
  run.stop();
  ok("hidden-tab log line every 5 s and counters reported with the timings");
}
// (f) visible tab: no log lines, vis=visible; was-hidden when it returned
{
  const e = env(); const run = createKeepActive(e).begin({ spoof: true });
  for (let i = 0; i < 10; i++) e.tick(1000);
  assert.equal(e.logs.length, 0);
  let t = {}; run.fill(t); assert.equal(t.vis, "visible"); assert.equal(t.hiddenMs, 0);
  e.doc.visibilityState = "hidden"; e.tick(1000); e.tick(1000); e.doc.visibilityState = "visible";
  t = {}; run.fill(t); assert.equal(t.vis, "was-hidden"); assert.equal(t.hiddenMs, 2000);
  run.stop();
  ok("visible path: silent; was-hidden recorded when the tab returned");
}
// (g) spoof=false (site not opted in): samples only, never touches the page, no lock
{
  const e = env(); const run = createKeepActive(e).begin({ spoof: false });
  assert.equal(e.attrs.has("data-noapi-active"), false);
  await tick();
  assert.equal(e.lockEvents.length, 0);
  const t = {}; run.fill(t); assert.equal(t.keepActive, false);
  run.stop();
  ok("not opted in: diagnostics only, page untouched");
}
// (h) opting out removes both markers
{
  const e = env(); const k = createKeepActive(e);
  k.setEnabled(true); const run = k.begin({ spoof: true }); k.setEnabled(false);
  assert.equal(e.attrs.has("data-noapi-keepactive"), false);
  assert.equal(e.attrs.has("data-noapi-active"), false);
  run.stop();
  ok("setEnabled(false) removes both markers");
}
console.log(`\n${n} keepActive tests passed`);
