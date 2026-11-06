// Regression tests for the selector-free reply fallback, run against a real
// browser (Playwright + Chromium) when Playwright happens to be installed.
//
// The bug these guard against: ChatGPT changed its reply markup, the reply
// selectors matched nothing, and the "biggest grower" fallback could not find a
// freshly mounted reply bubble (it only looked at elements that already existed
// in its sample) — so OpenCode waited forever. A previous "fix" made it worse by
// scanning backwards for the last markdown block and returning the PREVIOUS
// answer. Case (c) below is the regression test for that.
//
// Playwright is NOT a dependency of this project. CI has no browser, so the
// script skips cleanly (exit 0) when Playwright (or its browser) is missing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CONTENT = fs.readFileSync(path.join(ROOT, "extension", "chrome", "content.js"), "utf8");
const OBSERVER = fs.readFileSync(path.join(ROOT, "extension", "chrome", "sse-observer.js"), "utf8");

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.log("skipped: playwright not installed");
  process.exit(0);
}

let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) console.log("ok:", name);
  else {
    console.error("FAIL:", name, extra);
    failed++;
  }
};

// Stub of the WebExtension messaging API the content script expects. It records
// everything the script sends back so the test can assert on it, and exposes
// __noapi.autosend() to deliver a prompt the way the background would.
const STUB = `(() => {
  const api = { sent: [], partial: [], portListeners: [], runtimeListeners: [], hello: null, reply: null, error: null };
  const runtime = {
    connect(opts) {
      return {
        name: opts && opts.name,
        postMessage(m) { api.hello = m; },
        onMessage: { addListener(fn) { api.portListeners.push(fn); } },
        onDisconnect: { addListener() {} },
      };
    },
    sendMessage(m) {
      if (m && m.type === "noapi_hello") return Promise.resolve({ connected: true });
      api.sent.push(m);
      if (m && m.type === "noapi_reply") api.reply = m;
      else if (m && m.type === "noapi_error") api.error = m;
      else if (m && m.type === "noapi_partial") api.partial.push(m);
      return Promise.resolve({ ok: true });
    },
    onMessage: { addListener(fn) { api.runtimeListeners.push(fn); } },
  };
  runtime.getURL = (p) => p;
  // Feature-flag storage, seeded per case from globalThis.__FAKE_FLAGS. The
  // content script reads it at load (promise form) to toggle the fast paths.
  const store = {};
  const storage = {
    local: {
      get(keys, cb) {
        const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(store);
        const out = {};
        for (const k of list) {
          if (globalThis.__FAKE_FLAGS && k in globalThis.__FAKE_FLAGS) out[k] = globalThis.__FAKE_FLAGS[k];
          else if (k in store) out[k] = store[k];
        }
        const p = Promise.resolve(out);
        if (typeof cb === "function") { p.then(cb); return; }
        return p;
      },
      set(patch, cb) {
        Object.assign(store, patch);
        const p = Promise.resolve();
        if (typeof cb === "function") { p.then(cb); return; }
        return p;
      },
    },
  };
  globalThis.chrome = { runtime, storage };
  // Deliver a prompt exactly the way the background worker would, over the port.
  api.autosend = function (prompt, opts) {
    const msg = Object.assign({ type: "noapi_autosend", prompt: prompt, id: "req-" + Date.now() }, opts || {});
    for (const fn of api.portListeners) {
      try { fn(msg); } catch {}
    }
    return msg.id;
  };
  globalThis.__noapi = api;
})()`;

// The fake chat page. Behaviour is driven by __FAKE_CFG so each case can pick a
// different reply markup, delay and container strategy.
function fakeHtml(cfg) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; }
    main, #transcript { display: block; min-height: 40px; }
    #prompt-textarea { width: 400px; min-height: 40px; border: 1px solid #999; padding: 8px; }
    #send, #stop { width: 80px; height: 30px; }
    .bot-bubble p { margin: 4px 0; }
  </style></head><body>
  <main id="transcript">${cfg.oldAnswerHtml || ""}</main>
  <div id="composer-wrap">
    <div id="prompt-textarea" contenteditable="true"></div>
    <button id="send" data-testid="send-button">Send</button>
    <button id="stop" data-testid="stop-button" style="display:none">Stop</button>
  </div>
  <script>
    const cfg = ${JSON.stringify(cfg)};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const composer = document.getElementById("prompt-textarea");
    const send = document.getElementById("send");
    const stop = document.getElementById("stop");
    const transcript = () => document.getElementById("transcript");
    window.__fakeSent = false;
    // Phase 2 instrumentation: when the send button turns enabled / is clicked.
    window.__fakeEnabledAt = null;
    window.__fakeClickedAt = null;
    window.__fakeClicks = 0;
    window.__fakeEnableScheduled = false;

    // Optional: start disabled and enable ~N ms after the composer is typed into,
    // so the send-on-enable path can be measured.
    if (cfg.sendEnableAfterMs != null) {
      send.disabled = true;
      composer.addEventListener("input", () => {
        if (window.__fakeEnableScheduled) return;
        window.__fakeEnableScheduled = true;
        setTimeout(() => {
          send.disabled = false;
          window.__fakeEnabledAt = performance.now();
        }, cfg.sendEnableAfterMs);
      });
    }

    send.addEventListener("click", async () => {
      window.__fakeClicks++;
      if (window.__fakeClickedAt == null) window.__fakeClickedAt = performance.now();
      window.__fakeSent = true;
      composer.innerHTML = "";
      const turn = (window.__fakeTurn = (window.__fakeTurn || 0) + 1);
      // In multiTurn mode each turn answers with its own text, so returning the
      // previous reply (or the old answer) is detectable.
      const text = cfg.multiTurn ? cfg.replyText + " (turn " + turn + ")" : cfg.replyText;
      if (cfg.fetchStream) {
        // Phase 3: the page answers over its own fetch + text/event-stream. The
        // MAIN-world observer must see it without breaking this read - every
        // chunk must still arrive here.
        const bubble = document.createElement("div");
        bubble.setAttribute("data-message-author-role", "assistant");
        const p = document.createElement("p");
        bubble.appendChild(p);
        transcript().appendChild(bubble);
        window.__fakeStreamChunks = 0;
        try {
          const res = await fetch("/fake-stream");
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            window.__fakeStreamChunks++;
            p.textContent += dec.decode(value, { stream: true });
          }
          // streamLateDomMs: the final DOM paint lands some time AFTER the
          // stream closed, which must not truncate the reply.
          if (cfg.streamLateDomMs != null) {
            await sleep(cfg.streamLateDomMs);
            p.textContent = text;
            window.__fakeLatePaint = true;
          }
          window.__fakeStreamDone = true;
        } catch (e) {
          window.__fakeStreamError = String(e);
        }
        return;
      }
      if (cfg.replaceTranscriptOnSend) {
        const old = document.getElementById("transcript");
        const fresh = document.createElement("main");
        fresh.id = "transcript";
        document.body.insertBefore(fresh, old);
        old.remove();
      }
      if (cfg.showStop) stop.style.display = "inline-block";
      await sleep(cfg.replyDelayMs);
      const bubble = document.createElement(cfg.replyTag || "div");
      bubble.className = cfg.replyClass || "bot-bubble";
      for (const [k, v] of Object.entries(cfg.replyAttrs || {})) bubble.setAttribute(k, v);
      const p = document.createElement("p");
      bubble.appendChild(p);
      transcript().appendChild(bubble);
      // Stream the text in chunks so the fallback sees real growth, the way a
      // model that thinks first and then streams actually behaves.
      const chunks = cfg.chunks || 1;
      for (let i = 0; i < chunks; i++) {
        p.textContent = text.slice(0, Math.round((text.length * (i + 1)) / chunks));
        await sleep(cfg.chunkMs || 0);
      }
      p.textContent = text;
      if (cfg.showStop) stop.style.display = "none";
    });
  </script>
  </body></html>`;
}

const PROMPT = "Please answer this question for the regression test.";

async function runCase(browser, name, cfg, { maxMs = 20000, expect, flags = null } = {}) {
  const context = await browser.newContext();
  try {
    if (flags) await context.addInitScript((f) => { globalThis.__FAKE_FLAGS = f; }, flags);
    await context.addInitScript({ content: STUB });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e && e.message ? e.message : e)));
    await page.route("https://chatgpt.com/**", (route) => {
      const u = route.request().url();
      if (u.includes("/fake-stream")) {
        const full = cfg.replyText || "";
        // With streamLateDomMs the stream only carries the first half; the page
        // paints the rest after the stream closes.
        const shown = cfg.streamLateDomMs != null ? full.slice(0, Math.ceil(full.length / 2)) : full;
        const body =
          `data: ${JSON.stringify({ delta: shown.slice(0, 24) })}\n\n` +
          `data: ${JSON.stringify({ delta: shown.slice(24) })}\n\n` +
          "data: [DONE]\n\n";
        return route.fulfill({ contentType: "text/event-stream", body });
      }
      return route.fulfill({ contentType: "text/html", body: fakeHtml(cfg) });
    });
    await page.goto("https://chatgpt.com/c/regression");
    // Chrome loads sse-observer.js as a MAIN-world content script; here we inject
    // it the same way so the fetch wrapper is in place before content.js runs.
    await page.addScriptTag({ content: OBSERVER });
    await page.addScriptTag({ content: CONTENT });
    await page.waitForFunction(() => globalThis.__noapi && globalThis.__noapi.portListeners.length > 0, null, {
      timeout: 5000,
    });

    const t0 = Date.now();
    await page.evaluate((prompt) => globalThis.__noapi.autosend(prompt), PROMPT);
    let reply = null;
    try {
      reply = await page.waitForFunction(() => globalThis.__noapi.reply, null, { timeout: maxMs, polling: 100 });
      reply = await reply.jsonValue();
    } catch {
      const err = await page.evaluate(() => globalThis.__noapi.error);
      ok(name, false, `no reply within ${maxMs}ms (error=${err ? err.error : "none"} pageErrors=${pageErrors.join("; ")})`);
      return null;
    }
    const elapsed = Date.now() - t0;
    const text = reply.text || "";
    const state = await page
      .evaluate(() => ({
        enabledAt: globalThis.__fakeEnabledAt ?? null,
        clickedAt: globalThis.__fakeClickedAt ?? null,
        clicks: globalThis.__fakeClicks ?? 0,
        streamChunks: globalThis.__fakeStreamChunks ?? null,
        streamDone: globalThis.__fakeStreamDone ?? false,
        streamError: globalThis.__fakeStreamError ?? null,
        latePaint: globalThis.__fakeLatePaint ?? false,
        turn: globalThis.__fakeTurn ?? 0,
        completedBy: (globalThis.__noapi?.reply?.timings?.completedBy) ?? null,
        sseSeen: (globalThis.__noapi?.reply?.timings?.sseSeen) ?? null,
      }))
      .catch(() => ({}));
    const res = expect(text, elapsed, pageErrors, state);
    ok(name, res.pass, res.why || "");
    return { text, elapsed };
  } finally {
    await context.close().catch(() => {});
  }
}

// Three turns in the same chat, each with its own answer: the previous reply
// (or the old answer already on the page) must never come back.
async function runMultiTurn(browser) {
  const context = await browser.newContext();
  try {
    await context.addInitScript({ content: STUB });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e && e.message ? e.message : e)));
    const cfg = {
      oldAnswerHtml: '<div data-message-author-role="assistant"><p>OLD ANSWER: must never come back.</p></div>',
      multiTurn: true,
      replyDelayMs: 200,
      chunks: 4,
      chunkMs: 30,
      showStop: true,
      replyAttrs: { "data-message-author-role": "assistant" },
      replyText: "REPLY-T",
    };
    await page.route("https://chatgpt.com/**", (route) => route.fulfill({ contentType: "text/html", body: fakeHtml(cfg) }));
    await page.goto("https://chatgpt.com/c/multi");
    await page.addScriptTag({ content: OBSERVER });
    await page.addScriptTag({ content: CONTENT });
    await page.waitForFunction(() => globalThis.__noapi && globalThis.__noapi.portListeners.length > 0, null, { timeout: 5000 });
    const replies = [];
    let seen = 0;
    for (let turn = 1; turn <= 3; turn++) {
      await page.evaluate((p) => globalThis.__noapi.autosend(p), "question " + turn);
      await page.waitForFunction((n) => globalThis.__noapi.sent.filter((m) => m.type === "noapi_reply").length > n, seen, { timeout: 15000, polling: 100 });
      const all = await page.evaluate(() => globalThis.__noapi.sent.filter((m) => m.type === "noapi_reply").map((m) => m.text || ""));
      seen = all.length;
      replies.push(all[all.length - 1] || "");
    }
    const unique = new Set(replies).size === 3;
    const eachOwn = replies.every((t, i) => t.includes("turn " + (i + 1)) && !t.includes("OLD ANSWER"));
    ok(
      "(j) a second and third turn never return the previous reply",
      replies.length === 3 && unique && eachOwn,
      `replies=${JSON.stringify(replies.map((r) => r.slice(0, 44)))} pageErrors=${pageErrors.join("; ")}`
    );
  } finally {
    await context.close().catch(() => {});
  }
}

let browser;
try {
  browser = await chromium.launch();
} catch (e) {
  console.log("skipped: playwright browser not installed (" + (e && e.message ? e.message.split("\n")[0] : e) + ")");
  process.exit(0);
}

try {
  // (a) Reply markup matches NO selector, new chat, reply lands after ~1.2s.
  //     On main (no pre-send baseline) this stalls; with the fix it must reply.
  await runCase(
    browser,
    "(a) unselectable reply in a new chat is found",
    {
      replyDelayMs: 1200,
      chunks: 6,
      chunkMs: 60,
      showStop: true,
      replyText: "REPLY-A: the fallback found a reply that no selector matches.",
    },
    {
      maxMs: 12000,
      expect: (text, elapsed) => ({
        pass: text.includes("REPLY-A") && elapsed < 10000,
        why: `elapsed=${elapsed}ms text="${text.slice(0, 60)}"`,
      }),
    }
  );

  // (b) Same, but the page swaps the transcript container when the first
  //     message is sent (a new chat re-mounts it). Capturing the old node would
  //     lose the reply; currentScope() must re-resolve it.
  await runCase(
    browser,
    "(b) reply is found after the transcript container is replaced",
    {
      replyDelayMs: 1200,
      chunks: 6,
      chunkMs: 60,
      showStop: true,
      replaceTranscriptOnSend: true,
      replyText: "REPLY-B: the transcript container was replaced on send.",
    },
    {
      maxMs: 12000,
      expect: (text, elapsed) => ({
        pass: text.includes("REPLY-B") && elapsed < 10000,
        why: `elapsed=${elapsed}ms text="${text.slice(0, 60)}"`,
      }),
    }
  );

  // (c) A chat that already has an assistant answer, and a model that thinks
  //     for ~11s. The OLD answer must never be returned as the new one.
  await runCase(
    browser,
    "(c) a previous answer is never returned as the new one",
    {
      oldAnswerHtml: '<div data-message-author-role="assistant"><p>OLD ANSWER: this is the previous message and must never come back.</p></div>',
      replyDelayMs: 11000,
      chunks: 20,
      chunkMs: 120,
      showStop: true,
      replyText: "REPLY-C: brand new answer produced after a long think.",
    },
    {
      maxMs: 25000,
      expect: (text, elapsed) => ({
        pass: text.includes("REPLY-C") && !text.includes("OLD ANSWER"),
        why: `elapsed=${elapsed}ms text="${text.slice(0, 80)}"`,
      }),
    }
  );

  // (d) Markup that matches the selectors: the normal, fast path must still work.
  await runCase(
    browser,
    "(d) selector-matched reply uses the fast path",
    {
      replyDelayMs: 1200,
      chunks: 4,
      chunkMs: 40,
      showStop: true,
      replyAttrs: { "data-message-author-role": "assistant" },
      replyText: "REPLY-D: normal selector path.",
    },
    {
      maxMs: 8000,
      expect: (text, elapsed) => ({
        pass: text.includes("REPLY-D") && elapsed < 5000,
        why: `elapsed=${elapsed}ms text="${text.slice(0, 60)}"`,
      }),
    }
  );

  // (e) The send button starts disabled and enables ~300ms after typing. Phase 2
  //     must click it within ~50ms of enabling and never before.
  await runCase(
    browser,
    "(e) the send button is clicked right when it enables, never before",
    {
      sendEnableAfterMs: 300,
      replyDelayMs: 300,
      chunks: 3,
      chunkMs: 40,
      showStop: true,
      replyAttrs: { "data-message-author-role": "assistant" },
      replyText: "REPLY-E: sent the moment the button enabled.",
    },
    {
      maxMs: 8000,
      expect: (text, elapsed, _pageErrors, state) => {
        const { enabledAt, clickedAt, clicks } = state || {};
        const waited = enabledAt != null && clickedAt != null ? Math.round(clickedAt - enabledAt) : null;
        const neverBefore = enabledAt != null && clickedAt != null && clickedAt >= enabledAt;
        return {
          pass: text.includes("REPLY-E") && clicks === 1 && waited != null && waited <= 50 && neverBefore,
          why: `elapsed=${elapsed}ms clicks=${clicks} enabledAt=${enabledAt} clickedAt=${clickedAt} waited=${waited}ms`,
        };
      },
    }
  );

  // (f) The page answers over its own fetch + text/event-stream. The MAIN-world
  //     observer must see the stream (and its end) without stealing any of the
  //     bytes the page itself reads.
  await runCase(
    browser,
    "(f) the page's own SSE stream is observed and completes the turn",
    {
      fetchStream: true,
      replyText: "REPLY-F: the answer arrived over the page's own SSE stream.",
    },
    {
      maxMs: 10000,
      expect: (text, elapsed, _pageErrors, state) => {
        const s = state || {};
        return {
          pass:
            text.includes("REPLY-F") &&
            s.streamDone === true &&
            (s.streamChunks || 0) >= 1 &&
            !s.streamError &&
            s.completedBy === "sse",
          why: `elapsed=${elapsed}ms chunks=${s.streamChunks} done=${s.streamDone} err=${s.streamError} completedBy=${s.completedBy} sseSeen=${s.sseSeen} text="${text.slice(0, 60)}"`,
        };
      },
    }
  );

  // (g) The SSE stream closes BEFORE the site paints its final tokens. Finishing
  //     on the end signal must first re-read the DOM, so the reply is complete.
  await runCase(
    browser,
    "(g) a final DOM paint after the stream closes is not truncated",
    {
      fetchStream: true,
      streamLateDomMs: 60,
      replyText: "REPLY-G: the whole answer survives a late repaint.",
    },
    {
      maxMs: 10000,
      expect: (text, elapsed, _pageErrors, state) => {
        const s = state || {};
        return {
          pass: s.streamDone === true && s.latePaint === true && text.includes("REPLY-G: the whole answer survives a late repaint."),
          why: `elapsed=${elapsed}ms latePaint=${s.latePaint} done=${s.streamDone} completedBy=${s.completedBy} text="${text.slice(0, 70)}"`,
        };
      },
    }
  );

  // (h) The send button enables only after the eager gate's timeout. The gate
  //     gives up, the submit poll then finds the button: exactly ONE send.
  await runCase(
    browser,
    "(h) the eager gate timing out still sends exactly once",
    {
      sendEnableAfterMs: 1500,
      replyDelayMs: 300,
      chunks: 3,
      chunkMs: 40,
      showStop: true,
      replyAttrs: { "data-message-author-role": "assistant" },
      replyText: "REPLY-H: one send after the eager gate gave up.",
    },
    {
      maxMs: 14000,
      expect: (text, elapsed, _pageErrors, state) => {
        const s = state || {};
        return {
          pass: text.includes("REPLY-H") && s.clicks === 1,
          why: `elapsed=${elapsed}ms clicks=${s.clicks} enabledAt=${s.enabledAt} clickedAt=${s.clickedAt} completedBy=${s.completedBy}`,
        };
      },
    }
  );

  // (i) Every content-script fast path flipped off must restore the old DOM path
  //     (fixed settle before send, interval-driven loop, no SSE signal).
  await runCase(
    browser,
    "(i) flipping the fast paths off restores the old path",
    {
      sendEnableAfterMs: 0,
      replyDelayMs: 400,
      chunks: 3,
      chunkMs: 40,
      showStop: true,
      replyAttrs: { "data-message-author-role": "assistant" },
      replyText: "REPLY-I: the slow path still answers.",
    },
    {
      maxMs: 14000,
      flags: { eagerSend: false, observerDriven: false, sseObserver: false },
      expect: (text, elapsed, _pageErrors, state) => {
        const s = state || {};
        const waited = s.enabledAt != null && s.clickedAt != null ? Math.round(s.clickedAt - s.enabledAt) : null;
        return {
          pass: text.includes("REPLY-I") && s.clicks === 1 && waited != null && waited >= 120 && s.completedBy !== "sse",
          why: `elapsed=${elapsed}ms clicks=${s.clicks} waited=${waited}ms completedBy=${s.completedBy}`,
        };
      },
    }
  );

  // (j) Three turns in one chat; none may return a previous reply.
  await runMultiTurn(browser);
} finally {
  await browser.close().catch(() => {});
}

if (failed) {
  console.error(`\n${failed} fallback browser test(s) failed`);
  process.exit(1);
}
console.log("\nall fallback browser tests passed");
