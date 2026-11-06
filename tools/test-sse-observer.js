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

if (failed) {
  console.error(`\n${failed} sse-observer test(s) failed`);
  process.exit(1);
}
console.log("\nall sse-observer tests passed");
