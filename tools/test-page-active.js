// Tests page-active.js (MAIN-world visibility spoof + animation-frame driver) in a
// vm with a fake DOM. Run: node tools/test-page-active.js
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import nodePath from "node:path";

const here = nodePath.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(process.env.PA || nodePath.join(here, "../extension/page-active.js"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const micro = () => new Promise((r) => setTimeout(r, 0));

function makeEnv() {
  class FakeEl {
    constructor() { this.attrs = new Map(); this.obs = []; }
    getAttribute(n) { return this.attrs.has(n) ? this.attrs.get(n) : null; }
    setAttribute(n, v) { this.attrs.set(n, String(v)); this._fire(n); }
    removeAttribute(n) { this.attrs.delete(n); this._fire(n); }
    _fire(n) { for (const o of this.obs) if (!o.filter || o.filter.includes(n)) queueMicrotask(() => o.cb([{ attributeName: n }])); }
  }
  class MutationObserver {
    constructor(cb) { this.cb = cb; }
    observe(el, opts) { el.obs.push({ cb: this.cb, filter: opts.attributeFilter }); }
    disconnect() {}
  }
  // The real getters live on Document.prototype, like in a browser.
  class Document extends EventTarget {
    constructor() { super(); this._vs = "visible"; this.documentElement = new FakeEl(); }
    get visibilityState() { return this._vs; }
    get hidden() { return this._vs === "hidden"; }
    hasFocus() { return false; }
  }
  const document = new Document();
  class FakeWindow extends EventTarget {}
  const window = new FakeWindow();
  // The browser's own rAF: callbacks only fire while the tab is visible.
  let nativeQ = new Map(); let nid = 0;
  const nativeRAF = (cb) => { const id = ++nid; nativeQ.set(id, cb); return id; };
  const nativeCAF = (id) => { nativeQ.delete(id); };
  window.requestAnimationFrame = nativeRAF;
  window.cancelAnimationFrame = nativeCAF;
  const fireNativeFrame = () => { if (document._vs === "hidden") return 0; const q = nativeQ; nativeQ = new Map(); for (const [, cb] of q) cb(1234); return q.size; };
  class FakeWorker {
    constructor() { this.t = setInterval(() => this.onmessage && this.onmessage({ data: 0 }), 5); FakeWorker.count++; }
    postMessage(m) { if (m === "stop") clearInterval(this.t); }
    terminate() { clearInterval(this.t); }
  }
  FakeWorker.count = 0;
  const sandbox = { window, document, Document, MutationObserver, Worker: FakeWorker, Blob: class {}, URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    performance: { now: () => Date.now() }, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, Object, Map, Array, Date, Boolean, Error };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { window, document, nativeRAF, fireNativeFrame, FakeWorker, root: document.documentElement, nativeQ: () => nativeQ };
}
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
let n = 0; const ok = (m) => { n++; console.log("ok -", m); };

// 1. inert until opted in
{
  const e = makeEnv();
  assert.equal(e.window.requestAnimationFrame, e.nativeRAF);
  e.document._vs = "hidden";
  e.root.setAttribute("data-noapi-active", "1");
  await micro();
  assert.equal(e.document.hidden, true, "no spoof without the keepactive opt-in");
  assert.equal(e.root.getAttribute("data-noapi-pa"), "loaded:0");
  ok("inert without data-noapi-keepactive");
}
// 2. opted in but idle: pass-through, behaviour unchanged
{
  const e = makeEnv();
  e.root.setAttribute("data-noapi-keepactive", "1"); await micro();
  assert.notEqual(e.window.requestAnimationFrame, e.nativeRAF, "wrapper installed");
  let calls = 0;
  e.window.requestAnimationFrame(() => calls++);
  assert.equal(e.fireNativeFrame(), 1);
  assert.equal(calls, 1);
  assert.equal(e.document.hidden, false);
  assert.equal(hasOwn(e.document, "hidden"), false, "no instance override while idle");
  ok("opted in but idle: frames still come from the browser, no overrides");
}
// 3. active + hidden: spoof and driver
{
  const e = makeEnv();
  e.root.setAttribute("data-noapi-keepactive", "1"); await micro();
  e.document._vs = "hidden";
  let early = 0, late = 0;
  e.window.requestAnimationFrame(() => early++); // registered natively before the request
  e.root.setAttribute("data-noapi-active", "1"); await micro();
  assert.equal(e.document.visibilityState, "visible");
  assert.equal(e.document.hidden, false);
  assert.equal(e.document.hasFocus(), true);
  e.window.requestAnimationFrame(() => late++);
  await sleep(60);
  assert.equal(early, 1, "a frame callback pending in the browser is taken over");
  assert.equal(late, 1, "new frame callbacks run while hidden");
  assert.equal(e.fireNativeFrame(), 0);
  assert.ok(/^worker:\d+$/.test(e.root.getAttribute("data-noapi-pa")), e.root.getAttribute("data-noapi-pa"));
  // a self-rescheduling render loop keeps going
  let loops = 0; const loop = () => { loops++; e.window.requestAnimationFrame(loop); };
  e.window.requestAnimationFrame(loop);
  await sleep(80);
  assert.ok(loops >= 5, `render loop ran ${loops} times while hidden`);
  ok("hidden + active: reads visible/focused, frame callbacks (old and new, even loops) keep running");
  // 4. request ends: everything restored
  e.root.removeAttribute("data-noapi-active"); await micro();
  assert.equal(hasOwn(e.document, "hidden"), false);
  assert.equal(hasOwn(e.document, "visibilityState"), false);
  assert.equal(hasOwn(e.document, "hasFocus"), false);
  assert.equal(e.document.hidden, true);
  assert.equal(e.document.visibilityState, "hidden");
  assert.equal(e.document.hasFocus(), false);
  const before = loops; await sleep(60);
  assert.equal(loops, before, "driver stopped; the loop is back in the browser's hands (paused while hidden)");
  assert.equal(e.FakeWorker.count, 1);
  e.document._vs = "visible";
  assert.ok(e.fireNativeFrame() >= 1, "the loop resumes with the browser's frames once visible");
  assert.ok(loops > before);
  ok("request end: overrides deleted, driver stopped, pending frames handed back to the browser");
}
// 5. visible + active: nothing driven
{
  const e = makeEnv();
  e.root.setAttribute("data-noapi-keepactive", "1"); await micro();
  e.root.setAttribute("data-noapi-active", "1"); await micro();
  let c = 0; e.window.requestAnimationFrame(() => c++);
  await sleep(40);
  assert.equal(c, 0, "visible: no worker driving");
  assert.equal(e.FakeWorker.count, 0);
  e.fireNativeFrame();
  assert.equal(c, 1);
  ok("visible + active: frames stay with the browser, no worker");
}
// 6. the tab becomes hidden mid-request
{
  const e = makeEnv();
  e.root.setAttribute("data-noapi-keepactive", "1"); await micro();
  e.root.setAttribute("data-noapi-active", "1"); await micro();
  let c = 0; e.window.requestAnimationFrame(() => c++);
  e.document._vs = "hidden";
  e.document.dispatchEvent(new Event("visibilitychange"));
  await sleep(40);
  assert.equal(c, 1, "callback registered while visible still runs after the tab was hidden");
  ok("tab hidden mid-request: pending frames are taken over");
}
// 7. cancel
{
  const e = makeEnv();
  e.root.setAttribute("data-noapi-keepactive", "1"); await micro();
  e.document._vs = "hidden";
  let a = 0, b = 0;
  const idNative = e.window.requestAnimationFrame(() => a++);
  e.root.setAttribute("data-noapi-active", "1"); await micro();
  const idDriven = e.window.requestAnimationFrame(() => b++);
  e.window.cancelAnimationFrame(idNative); e.window.cancelAnimationFrame(idDriven);
  await sleep(40);
  assert.equal(a + b, 0);
  ok("cancelAnimationFrame works for both browser-owned and driver-owned callbacks");
}
// 8. events
{
  const e = makeEnv();
  let seen = [];
  const mark = (t) => () => seen.push(t);
  e.document.addEventListener("visibilitychange", mark("doc-vis"));
  e.window.addEventListener("blur", mark("blur"));
  e.window.addEventListener("pagehide", mark("pagehide"));
  const fire = () => { e.document.dispatchEvent(new Event("visibilitychange")); e.window.dispatchEvent(new Event("blur")); e.window.dispatchEvent(new Event("pagehide")); };
  fire();
  assert.deepEqual(seen, ["doc-vis", "blur", "pagehide"], "idle: the page sees every event");
  seen = [];
  e.root.setAttribute("data-noapi-keepactive", "1"); await micro();
  e.root.setAttribute("data-noapi-active", "1"); await micro();
  fire();
  assert.deepEqual(seen, [], "active: swallowed");
  e.root.removeAttribute("data-noapi-active"); await micro();
  fire();
  assert.deepEqual(seen, ["doc-vis", "blur", "pagehide"], "after the request: delivered again");
  ok("visibilitychange / blur / pagehide are swallowed only while a request is in flight");
}
// 9. opt-out while active
{
  const e = makeEnv();
  e.root.setAttribute("data-noapi-keepactive", "1"); await micro();
  e.document._vs = "hidden";
  e.root.setAttribute("data-noapi-active", "1"); await micro();
  assert.equal(e.document.hidden, false);
  e.root.removeAttribute("data-noapi-keepactive"); await micro();
  assert.equal(e.document.hidden, true);
  assert.equal(hasOwn(e.document, "hidden"), false);
  ok("turning the flag off restores the page at once");
}
console.log(`\n${n} page-active tests passed`);
process.exit(0);
