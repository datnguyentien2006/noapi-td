// Unit tests for extension/*/sse-observer.js, the MAIN-world fetch wrapper.
//
// The observer only runs in a page's MAIN world, so the browser regression test
// (tools/test-fallback-browser.js) exercises it end to end when Playwright is
// installed. This file gives the same behaviour real coverage in plain Node by
// running the source in a vm with a minimal window/document/crypto/fetch stub.
//
// What it locks down (the defect this test was written for): a stream that
// errors, is aborted, or cannot be drained must post "error", NEVER "ended" - a
// false "ended" lets the content script return a truncated reply as complete.
import fs from "node:fs";
import vm from "node:vm";

const CHROME = "extension/chrome/sse-observer.js";
const FIREFOX = "extension/firefox/sse-observer.js";
const chromeSrc = fs.readFileSync(CHROME, "utf8");
const firefoxSrc = fs.readFileSync(FIREFOX, "utf8");

// Lift one `@noapi-shared` block out of the observer and return the named
// function. The block must be identical in both browser copies (the shared
// convention), so a drift fails loudly here too.
function loadShared(name) {
  const re = new RegExp(
    "\\/\\* @noapi-shared-start " + name + " \\*\\/([\\s\\S]*?)\\/\\* @noapi-shared-end " + name + " \\*\\/"
  );
  const c = chromeSrc.match(re);
  const f = firefoxSrc.match(re);
  if (!c || !f) throw new Error(`shared block "${name}" not found`);
  if (c[1] !== f[1]) throw new Error(`shared block "${name}" differs between browsers`);
  return new Function(c[1] + "\nreturn " + name + ";")();
}

let failed = 0;
function ok(name, cond, extra = "") {
  if (cond) console.log("ok:", name);
  else {
    console.error("FAIL:", name, extra);
    failed++;
  }
}

// The two copies must stay byte-identical, like the content scripts.
ok("chrome and firefox sse-observer.js are byte-identical", chromeSrc === firefoxSrc);

const tick = () => new Promise((r) => setTimeout(r, 0));
async function waitFor(pred, ms = 500) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await tick();
  }
  return pred();
}

// A reader over a list of chunks that optionally rejects after N successful reads.
function chunkReader(chunks, { errorAfter = null } = {}) {
  let i = 0;
  return {
    read() {
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          if (errorAfter != null && i >= errorAfter) return reject(new Error("stream dropped"));
          if (i >= chunks.length) return resolve({ done: true, value: undefined });
          resolve({ done: false, value: chunks[i++] });
        }, 0);
      });
    },
  };
}

// Run the observer against one fake response and return the events it posted.
// `response` is either a Response-like object or a function returning one.
async function observe(response) {
  const posts = [];
  const attrs = {};
  let cloneCalls = 0;
  const documentElement = {
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    setAttribute: (k, v) => {
      attrs[k] = String(v);
    },
  };
  const window = {
    postMessage: (data) => {
      posts.push(data);
    },
    addEventListener() {},
  };
  const sandbox = {
    window,
    document: { documentElement },
    location: { origin: "https://example.test" },
    crypto: {
      getRandomValues(a) {
        for (let i = 0; i < a.length; i++) a[i] = i + 1;
        return a;
      },
    },
    console,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  // fetch must exist before the observer wraps it.
  sandbox.window.fetch = () => Promise.resolve(typeof response === "function" ? response() : response);
  vm.createContext(sandbox);
  vm.runInContext(chromeSrc, sandbox, { filename: CHROME });

  const res = typeof response === "function" ? null : response;
  if (res && typeof res.clone === "function") {
    const origClone = res.clone;
    res.clone = function () {
      cloneCalls++;
      return origClone.call(this);
    };
  }
  // Drive one page fetch through the wrapper.
  void sandbox.window.fetch("/whatever");
  await waitFor(() => posts.some((p) => p.event === "ended" || p.event === "error"));
  return { posts, attrs, cloneCalls };
}

const events = (posts) => posts.map((p) => p.event);

// ---- a clean stream ends with "ended" --------------------------------------
{
  const r = await observe({
    headers: { get: () => "text/event-stream" },
    clone: () => ({ body: { getReader: () => chunkReader(["a", "b", "c"]) } }),
  });
  ok("clean stream: started then ended", JSON.stringify(events(r.posts)) === JSON.stringify(["started", "ended"]), JSON.stringify(events(r.posts)));
  ok("no 'error' on a clean stream", !events(r.posts).includes("error"));
  ok("every event carries the page token", r.posts.every((p) => p.source === "noapi-sse" && typeof p.token === "string" && p.token.length >= 8));
  ok("the token is published on <html> for the content script", typeof r.attrs["data-noapi-sse-token"] === "string" && r.attrs["data-noapi-sse-token"].length >= 8);
}

// ---- a stream that errors mid-way posts "error", never "ended" -------------
{
  const r = await observe({
    headers: { get: () => "text/event-stream" },
    clone: () => ({ body: { getReader: () => chunkReader(["a", "b"], { errorAfter: 1 }) } }),
  });
  ok("errored stream: started then error", JSON.stringify(events(r.posts)) === JSON.stringify(["started", "error"]), JSON.stringify(events(r.posts)));
  ok("errored stream never claims ended", !events(r.posts).includes("ended"));
}

// ---- a response we cannot drain is not a completed stream ------------------
{
  const r = await observe({ headers: { get: () => "text/event-stream" } }); // no clone()
  ok("undrainable stream: started then error (never ended)", JSON.stringify(events(r.posts)) === JSON.stringify(["started", "error"]), JSON.stringify(events(r.posts)));
}

// ---- a clone with no body and no text() is not a completed stream -----------
{
  const r = await observe({
    headers: { get: () => "text/event-stream" },
    clone: () => ({}),
  });
  ok("clone without a body: error, not ended", !events(r.posts).includes("ended") && events(r.posts).includes("error"), JSON.stringify(events(r.posts)));
}

// ---- a clone that throws is not a completed stream -------------------------
{
  const r = await observe({
    headers: { get: () => "text/event-stream" },
    clone: () => {
      throw new Error("body already used");
    },
  });
  ok("clone throwing: error, not ended", !events(r.posts).includes("ended") && events(r.posts).includes("error"), JSON.stringify(events(r.posts)));
}

// ---- a non-SSE response is ignored entirely --------------------------------
{
  const r = await observe({
    headers: { get: () => "application/json" },
    clone: () => ({ body: { getReader: () => chunkReader(["x"]) } }),
  });
  ok("non-SSE response posts nothing", r.posts.length === 0, JSON.stringify(events(r.posts)));
}

// ---- the page's own body is not touched (the clone is read, not the original)
{
  let originalReads = 0;
  let cloneReads = 0;
  const original = {
    headers: { get: () => "text/event-stream" },
    clone() {
      return {
        body: {
          getReader: () => {
            cloneReads++;
            return chunkReader(["a", "b"]);
          },
        },
      };
    },
    body: {
      getReader: () => {
        originalReads++;
        return chunkReader(["a", "b"]);
      },
    },
  };
  const r = await observe(original);
  ok("observer drains only the clone, never the page's own body", cloneReads === 1 && originalReads === 0, `clone=${cloneReads} original=${originalReads}`);
  ok("clone read still reported a clean end", events(r.posts).includes("ended"), JSON.stringify(events(r.posts)));
}

// ---- sseSummary: the pure builder behind window.__noapiSseShow() -----------
const sseSummary = loadShared("sseSummary");

// empty / missing entry
{
  const s = sseSummary(null);
  ok("sseSummary: no entry reports an empty capture", /no SSE response captured yet/.test(s), s);
  ok("sseSummary: a non-object entry is treated as empty", /no SSE response captured yet/.test(sseSummary("nope")));
}

// head / middle / tail slicing (head 3000, middle 1500 from the centre, tail 1500)
{
  const text = "H".repeat(3000) + "M".repeat(4000) + "T".repeat(3000); // 10000 chars
  const s = sseSummary({
    text,
    path: "/api/chat",
    status: 200,
    contentType: "text/event-stream",
    startedAt: 1000,
    endedAt: 2000,
  });
  const json = s.split("\n").filter((l) => l.startsWith('"')).map((l) => JSON.parse(l));
  ok("sseSummary: three slices are emitted", json.length === 3, String(json.length));
  ok("sseSummary: head is the first 3000 chars", json[0].length === 3000 && /^H+$/.test(json[0]), `len=${json[0].length}`);
  ok("sseSummary: middle is 1500 chars from the centre", json[1].length === 1500 && /^M+$/.test(json[1]), `len=${json[1].length}`);
  ok("sseSummary: tail is the last 1500 chars", json[2].length === 1500 && /^T+$/.test(json[2]), `len=${json[2].length}`);
  ok(
    "sseSummary: header carries path/status/content-type/chars",
    s.includes("path: /api/chat") && s.includes("status: 200") && s.includes("content-type: text/event-stream") && s.includes("chars: 10000"),
    s
  );
}

// cap behaviour: a huge body yields capped slices but the full length is reported
{
  const s = sseSummary({ text: "x".repeat(500000) });
  const json = s.split("\n").filter((l) => l.startsWith('"')).map((l) => JSON.parse(l));
  ok("sseSummary: slices stay capped on a huge body", json[0].length === 3000 && json[1].length === 1500 && json[2].length === 1500, JSON.stringify(json.map((j) => j.length)));
  ok("sseSummary: header reports the full captured length", s.includes("chars: 500000"), s.slice(0, 120));
}

// frame count: blank-line separated frames, including the empty body
{
  ok("sseSummary: counts blank-line-separated frames", sseSummary({ text: "data: a\n\ndata: b\n\ndata: c" }).includes("frames: 3"));
  ok("sseSummary: one frame with no separator", sseSummary({ text: "oneframe" }).includes("frames: 1"));
  ok("sseSummary: an empty body has zero frames", sseSummary({ text: "" }).includes("frames: 0"));
}

// control characters stay visible (JSON-escaped, never a real newline)
{
  const s = sseSummary({ text: "line1\nline2" });
  ok("sseSummary: \\n stays visible in the slice", s.includes('"line1\\nline2"'), s);
  ok("sseSummary: an open entry shows ended as (open)", sseSummary({ text: "a" }).includes("ended: (open)"));
}

if (failed) {
  console.error(`\n${failed} sse-observer test(s) failed`);
  process.exit(1);
}
console.log("\nall sse-observer tests passed");
