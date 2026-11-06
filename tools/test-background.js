// Unit tests for extension/*/background.js: the WebSocket <-> tab router.
//
// The background script only runs inside a browser extension, so this loads it
// in a Node `vm` with stub `chrome`/`browser`, `WebSocket`, timers and console
// globals, then drives the listeners it registers. That gives real coverage of
// the routing rules that are otherwise only checked by hand on a live browser:
//   - an error's `code` is forwarded to the bridge
//   - a cancel is acked immediately when no tab is running that id, and only
//     after the tab's terminal message when one is
//   - a request for a site with no tab is an error, never delivered to another
//     site's tab
//   - a noapi-tab port is accepted only from the top frame
//   - closing a tab tells the bridge the site is gone
//   - hello-update is only sent when the site/url actually changed
//
// It also asserts the chrome and firefox background scripts are behaviourally
// identical by running the same cases against both.
import fs from "node:fs";
import vm from "node:vm";

let failed = 0;
function ok(name, cond, detail) {
  if (cond) console.log("ok:", name);
  else {
    console.error("FAIL:", name, detail === undefined ? "" : detail);
    failed++;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeWs() {
  return class FakeWebSocket {
    static instances = [];
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      FakeWebSocket.instances.push(this);
    }
    send(data) {
      this.sent.push(JSON.parse(data));
    }
    close() {
      this.readyState = 3;
    }
    // test helpers
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    deliver(msg) {
      this.onmessage?.({ data: JSON.stringify(msg) });
    }
    of(type) {
      return this.sent.filter((m) => m.t === type);
    }
  };
}

function makePort(tabId, frameId, name = "noapi-tab") {
  const port = {
    name,
    sender: { tab: { id: tabId }, frameId },
    sent: [],
    onMessage: { _fns: [], addListener(fn) { this._fns.push(fn); } },
    onDisconnect: { _fns: [], addListener(fn) { this._fns.push(fn); } },
    postMessage(msg) {
      this.sent.push(msg);
    },
    // test helper: drive the background's listener as the content script would
    fromContent(msg) {
      for (const fn of port.onMessage._fns) fn(msg);
    },
  };
  return port;
}

async function loadBackground(which) {
  const WS = makeWs();
  const connects = [];
  const oneOff = [];
  const removed = [];
  const ext = {
    runtime: {
      onConnect: { addListener: (fn) => connects.push(fn) },
      onMessage: { addListener: (fn) => oneOff.push(fn) },
    },
    tabs: {
      onRemoved: { addListener: (fn) => removed.push(fn) },
      sendMessage: () => Promise.resolve(),
    },
    storage: { local: { get: () => Promise.resolve({}) } },
    action: {
      onClicked: { addListener: () => {} },
      setBadgeText: () => {},
      setBadgeBackgroundColor: () => {},
      setTitle: () => {},
    },
  };
  const sandbox = {
    chrome: ext,
    browser: ext,
    WebSocket: WS,
    console: { log: () => {}, error: () => {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  vm.createContext(sandbox);
  const src = fs.readFileSync(`extension/${which}/background.js`, "utf8");
  vm.runInContext(src, sandbox, { filename: `${which}/background.js` });
  // Let init() -> connect() run.
  await sleep(5);
  const ws = WS.instances[0];
  ws.open();
  return {
    ws,
    wsClass: WS,
    ext,
    connectFirst: () => connects[0](),
    connect: (port) => connects.forEach((fn) => fn(port)),
    message: (msg, sender) => oneOff.forEach((fn) => fn(msg, sender, () => {})),
    tabRemoved: (id) => removed.forEach((fn) => fn(id)),
  };
}

for (const which of ["chrome", "firefox"]) {
  console.log(`\n--- ${which}/background.js ---`);

  // A tab is a port connection from the top frame plus a hello.
  async function withTab(h, tabId, site, url) {
    const port = makePort(tabId, 0);
    h.connect(port);
    h.message({ type: "noapi_hello", site, url }, { tab: { id: tabId } });
    await sleep(2);
    return port;
  }

  // ---- error code is forwarded -------------------------------------------
  {
    const h = await loadBackground(which);
    h.message({ type: "noapi_error", id: "r1", error: "This tab is already handling a prompt.", code: "busy" }, { tab: { id: 1 } });
    const err = h.ws.of("error").find((m) => m.id === "r1");
    ok("forwards the error code to the bridge", err?.code === "busy", JSON.stringify(err));
  }

  // ---- cancel with no tab running the id: immediate ack -------------------
  {
    const h = await loadBackground(which);
    h.ws.deliver({ t: "cancel", id: "r9" });
    ok("a cancel for an unknown id is acked immediately", h.ws.of("cancelled").some((m) => m.id === "r9"), JSON.stringify(h.ws.sent));
  }

  // ---- cancel with a running tab: cancel first, ack on terminal -----------
  {
    const h = await loadBackground(which);
    const port = await withTab(h, 1, "chatgpt", "https://chatgpt.com/");
    h.ws.deliver({ t: "request", id: "r2", prompt: "hi", site: "chatgpt" });
    ok("the request is delivered to the tab", port.sent.some((m) => m.type === "noapi_autosend" && m.id === "r2"), JSON.stringify(port.sent));
    h.ws.deliver({ t: "cancel", id: "r2" });
    ok("the tab is told to cancel", port.sent.some((m) => m.type === "noapi_cancel" && m.id === "r2"), JSON.stringify(port.sent));
    ok("the bridge is not acked before the tab confirms", !h.ws.of("cancelled").some((m) => m.id === "r2"), JSON.stringify(h.ws.sent));
    // The content script reports its terminal message.
    h.message({ type: "noapi_error", id: "r2", error: "Cancelled." }, { tab: { id: 1 } });
    ok("the bridge is acked once the tab reports terminal", h.ws.of("cancelled").some((m) => m.id === "r2"), JSON.stringify(h.ws.sent));
    ok("the cancelled error is not forwarded as an error", !h.ws.of("error").some((m) => m.id === "r2"), JSON.stringify(h.ws.sent));
  }

  // ---- a reply for a cancelling id is acked, not forwarded ---------------
  {
    const h = await loadBackground(which);
    const port = await withTab(h, 1, "chatgpt", "https://chatgpt.com/");
    h.ws.deliver({ t: "request", id: "r5", prompt: "hi", site: "chatgpt" });
    h.ws.deliver({ t: "cancel", id: "r5" });
    h.message({ type: "noapi_reply", id: "r5", text: "too late" }, { tab: { id: 1 } });
    ok("a late reply for a cancelled id is acked as cancelled", h.ws.of("cancelled").some((m) => m.id === "r5"), JSON.stringify(h.ws.sent));
    ok("a late reply for a cancelled id is not forwarded as a response", !h.ws.of("response").some((m) => m.id === "r5"), JSON.stringify(h.ws.sent));
    void port;
  }

  // ---- no cross-site fallback --------------------------------------------
  {
    const h = await loadBackground(which);
    const claude = await withTab(h, 2, "claude", "https://claude.ai/");
    h.ws.deliver({ t: "request", id: "r3", prompt: "hi", site: "chatgpt" });
    const err = h.ws.of("error").find((m) => m.id === "r3");
    ok("a site with no tab errors instead of borrowing another tab", Boolean(err) && /chatgpt/.test(err.error || ""), JSON.stringify(h.ws.sent));
    ok("the other site's tab got nothing", claude.sent.filter((m) => m.type === "noapi_autosend").length === 0, JSON.stringify(claude.sent));
  }

  // ---- iframe port is ignored --------------------------------------------
  {
    const h = await loadBackground(which);
    const frame = makePort(9, 7);
    h.connect(frame);
    h.message({ type: "noapi_hello", site: "chatgpt", url: "https://chatgpt.com/frame" }, { tab: { id: 9 }, frameId: 7 });
    h.ws.deliver({ t: "request", id: "r7", prompt: "hi", site: "chatgpt" });
    ok("a non-top-frame port is not registered", h.ws.of("error").some((m) => m.id === "r7"), JSON.stringify(h.ws.sent));
    ok("the iframe port got nothing", frame.sent.filter((m) => m.type === "noapi_autosend").length === 0, JSON.stringify(frame.sent));
  }

  // ---- tab close prunes the site -----------------------------------------
  {
    const h = await loadBackground(which);
    await withTab(h, 1, "chatgpt", "https://chatgpt.com/");
    h.tabRemoved(1);
    ok("closing a tab tells the bridge the site is gone", h.ws.of("site-gone").some((m) => m.site === "chatgpt"), JSON.stringify(h.ws.sent));
    h.ws.deliver({ t: "request", id: "r8", prompt: "hi", site: "chatgpt" });
    ok("a request for the closed site now errors", h.ws.of("error").some((m) => m.id === "r8"), JSON.stringify(h.ws.sent));
  }

  // ---- tab close with a second tab of the same site keeps it ------------
  {
    const h = await loadBackground(which);
    await withTab(h, 1, "chatgpt", "https://chatgpt.com/a");
    await withTab(h, 2, "chatgpt", "https://chatgpt.com/b");
    h.tabRemoved(1);
    ok("closing one of two tabs of a site does not prune it", !h.ws.of("site-gone").some((m) => m.site === "chatgpt"), JSON.stringify(h.ws.sent));
    h.ws.deliver({ t: "request", id: "r10", prompt: "hi", site: "chatgpt" });
    ok("the remaining tab still serves the site", !h.ws.of("error").some((m) => m.id === "r10"));
  }

  // ---- hello-update only when changed ------------------------------------
  {
    const h = await loadBackground(which);
    await withTab(h, 1, "chatgpt", "https://chatgpt.com/");
    const before = h.ws.of("hello-update").length;
    h.message({ type: "noapi_hello", site: "chatgpt", url: "https://chatgpt.com/" }, { tab: { id: 1 } });
    await sleep(2);
    ok("an unchanged hello sends no hello-update", h.ws.of("hello-update").length === before, String(h.ws.of("hello-update").length));
    h.message({ type: "noapi_hello", site: "claude", url: "https://claude.ai/" }, { tab: { id: 1 } });
    await sleep(2);
    ok("a changed hello sends hello-update", h.ws.of("hello-update").some((m) => m.site === "claude"), JSON.stringify(h.ws.of("hello-update")));
  }
}

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nall background tests passed");
// The VM sandbox runs the background's own heartbeat/reconnect timers, which
// would otherwise keep the process alive after the cases finish.
process.exit(0);
