// Tests for the reliable outbound queue and worker-restart recovery in
// extension/chrome/background.js (the WebSocket <-> tab router).
//   - a reply/error sent while the bridge link is down is queued and delivered,
//     in order, once the socket is open again (it used to be dropped silently)
//   - only the newest partial of a request is kept; a terminal message supersedes it
//   - after a service-worker restart the known tabs, the pending ids and any queued
//     terminal message come back from chrome.storage.session
//   - a pending request whose tab vanished while the worker was asleep is reported
import fs from "node:fs";
import vm from "node:vm";

let failed = 0;
const ok = (name, cond, detail) => {
  if (cond) console.log("ok:", name);
  else {
    console.error("FAIL:", name, detail === undefined ? "" : detail);
    failed++;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await sleep(5);
  }
  return pred();
}

function makeWs() {
  return class FakeWebSocket {
    static instances = [];
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      FakeWebSocket.instances.push(this);
    }
    send(d) {
      if (this.readyState !== 1) throw new Error("not open");
      this.sent.push(JSON.parse(d));
    }
    close() {
      this.readyState = 3;
    }
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    deliver(m) {
      this.onmessage?.({ data: JSON.stringify(m) });
    }
    breakLink() {
      this.readyState = 3;
      this.onclose?.();
    }
    of(t) {
      return this.sent.filter((m) => m.t === t);
    }
  };
}

function makePort(tabId) {
  const p = {
    name: "noapi-tab",
    sender: { tab: { id: tabId }, frameId: 0 },
    sent: [],
    onMessage: { addListener() {} },
    onDisconnect: { addListener() {} },
    postMessage(m) {
      p.sent.push(m);
    },
  };
  return p;
}

// `session` is shared between "worker lives" to model chrome.storage.session.
async function boot({ session, aliveTabs = new Set() } = {}) {
  const WS = makeWs();
  const connects = [];
  const oneOff = [];
  const tabMsgs = [];
  const ext = {
    runtime: { onConnect: { addListener: (f) => connects.push(f) }, onMessage: { addListener: (f) => oneOff.push(f) } },
    tabs: {
      onRemoved: { addListener() {} },
      sendMessage: (id, m) => {
        tabMsgs.push([id, m]);
        return Promise.resolve();
      },
      get: (id) => (aliveTabs.has(id) ? Promise.resolve({ id }) : Promise.reject(new Error("No tab"))),
    },
    storage: {
      local: { get: () => Promise.resolve({}) },
      session: session && {
        get: (keys) => Promise.resolve(Object.fromEntries(keys.filter((k) => k in session.data).map((k) => [k, session.data[k]]))),
        set: (o) => {
          Object.assign(session.data, JSON.parse(JSON.stringify(o)));
          return Promise.resolve();
        },
      },
    },
    action: { onClicked: { addListener() {} }, setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
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
    __NOAPI_CFG__: { baseDelay: 10, minGap: 10, maxDelay: 20, pingEvery: 60_000 },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync("extension/chrome/background.js", "utf8"), sandbox, { filename: "chrome/background.js" });
  await until(() => WS.instances.length > 0);
  return {
    WS,
    tabMsgs,
    ws: () => WS.instances[WS.instances.length - 1],
    connect: (p) => connects.forEach((f) => f(p)),
    message: (m, tab) => oneOff.forEach((f) => f(m, { tab: { id: tab } }, () => {})),
  };
}

// ---- 1. link down: queued, coalesced, delivered in order after reconnect -----
{
  const h = await boot();
  h.ws().open();
  h.connect(makePort(1));
  h.message({ type: "noapi_hello", site: "zai", url: "https://chat.z.ai/" }, 1);
  h.ws().deliver({ t: "request", id: "q1", prompt: "hi", site: "zai" });

  h.message({ type: "noapi_partial", id: "q1", text: "up" }, 1);
  ok("link up: a partial goes out at once", h.ws().of("partial").length === 1);

  const first = h.ws();
  first.breakLink(); // bridge link lost
  h.message({ type: "noapi_partial", id: "q1", text: "up to" }, 1);
  h.message({ type: "noapi_partial", id: "q1", text: "up to here" }, 1);
  h.message({ type: "noapi_reply", id: "q1", text: "final answer", timings: { total: 5 } }, 1);
  ok("link down: nothing was sent on the dead socket", first.of("response").length === 0);

  await until(() => h.WS.instances.length > 1);
  const second = h.ws();
  second.open();
  const types = second.sent.map((m) => m.t);
  ok("after reconnect the reply is delivered", second.of("response").some((m) => m.id === "q1" && m.text === "final answer"), JSON.stringify(types));
  ok("hello is sent before the queued reply", types.indexOf("hello") < types.indexOf("response"), JSON.stringify(types));
  ok("the superseded partials are not resent", second.of("partial").length === 0, JSON.stringify(second.of("partial")));
}

// ---- 2. only the newest partial survives, and is flushed if no reply came ----
{
  const h = await boot();
  h.ws().open();
  h.connect(makePort(1));
  h.message({ type: "noapi_hello", site: "zai", url: "u" }, 1);
  h.ws().breakLink();
  h.message({ type: "noapi_partial", id: "p1", text: "a" }, 1);
  h.message({ type: "noapi_partial", id: "p1", text: "ab" }, 1);
  h.message({ type: "noapi_partial", id: "p2", text: "other" }, 1);
  await until(() => h.WS.instances.length > 1);
  h.ws().open();
  const parts = h.ws().of("partial");
  ok("one partial per request is kept", parts.length === 2, JSON.stringify(parts));
  ok("the kept partial is the newest", parts.find((m) => m.id === "p1")?.text === "ab");
}

// ---- 3. an error queued while down keeps its code ---------------------------
{
  const h = await boot();
  h.ws().open();
  h.ws().breakLink();
  h.message({ type: "noapi_error", id: "e1", error: "boom", code: "busy" }, 1);
  await until(() => h.WS.instances.length > 1);
  h.ws().open();
  const e = h.ws().of("error").find((m) => m.id === "e1");
  ok("a queued error is delivered with its code", e?.code === "busy" && e?.error === "boom", JSON.stringify(h.ws().sent));
}

// ---- 4. worker restart: tabs, pending and queued reply come back ------------
{
  const session = { data: {} };
  const a = await boot({ session, aliveTabs: new Set([7]) });
  a.ws().open();
  a.connect(makePort(7));
  a.message({ type: "noapi_hello", site: "zai", url: "https://chat.z.ai/c/1" }, 7);
  a.ws().deliver({ t: "request", id: "r1", prompt: "work", site: "zai" });
  a.ws().breakLink();
  a.message({ type: "noapi_reply", id: "r1", text: "done while down" }, 7);
  await sleep(300); // persistence is debounced
  ok("session storage holds the tab, the pending id and the queued reply",
    (session.data.noapi_tabs || []).length === 1 && (session.data.noapi_pending || []).length === 0 && (session.data.noapi_outbox || []).length === 1,
    JSON.stringify(session.data));

  // The worker is killed and restarted: a fresh instance, same session storage.
  const b = await boot({ session, aliveTabs: new Set([7]) });
  b.ws().open();
  await sleep(30);
  ok("restart: the queued reply reaches the bridge", b.ws().of("response").some((m) => m.id === "r1" && m.text === "done while down"), JSON.stringify(b.ws().sent));
  ok("restart: the tab is re-announced to the bridge", b.ws().of("hello-update").some((m) => m.site === "zai"), JSON.stringify(b.ws().sent));
  b.ws().deliver({ t: "request", id: "r2", prompt: "next", site: "zai" });
  ok("restart: a request routes to the remembered tab without waiting for its port",
    b.tabMsgs.some(([id, m]) => id === 7 && m.type === "noapi_autosend" && m.id === "r2") && !b.ws().of("error").some((m) => m.id === "r2"),
    JSON.stringify([b.tabMsgs, b.ws().sent]));
}

// ---- 5. restart: a pending request whose tab vanished is reported -----------
{
  const session = { data: { noapi_tabs: [[9, { site: "zai", url: "u" }]], noapi_pending: [["lost1", 9]] } };
  const b = await boot({ session, aliveTabs: new Set() }); // tab 9 is gone
  b.ws().open();
  await sleep(30);
  ok("restart: a request of a vanished tab gets an error", b.ws().of("error").some((m) => m.id === "lost1" && /closed/.test(m.error)), JSON.stringify(b.ws().sent));
  b.ws().deliver({ t: "request", id: "r3", prompt: "x", site: "zai" });
  ok("restart: a vanished tab is not routed to", b.ws().of("error").some((m) => m.id === "r3"), JSON.stringify(b.ws().sent));
}

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nall background outbox tests passed");
process.exit(0);
