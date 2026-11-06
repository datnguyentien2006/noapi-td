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
  globalThis.chrome = { runtime };
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

    send.addEventListener("click", async () => {
      window.__fakeSent = true;
      composer.innerHTML = "";
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
        p.textContent = cfg.replyText.slice(0, Math.round((cfg.replyText.length * (i + 1)) / chunks));
        await sleep(cfg.chunkMs || 0);
      }
      p.textContent = cfg.replyText;
      if (cfg.showStop) stop.style.display = "none";
    });
  </script>
  </body></html>`;
}

const PROMPT = "Please answer this question for the regression test.";

async function runCase(browser, name, cfg, { maxMs = 20000, expect } = {}) {
  const context = await browser.newContext();
  try {
    await context.addInitScript({ content: STUB });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e && e.message ? e.message : e)));
    await page.route("https://chatgpt.com/**", (route) =>
      route.fulfill({ contentType: "text/html", body: fakeHtml(cfg) })
    );
    await page.goto("https://chatgpt.com/c/regression");
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
    const res = expect(text, elapsed, pageErrors);
    ok(name, res.pass, res.why || "");
    return { text, elapsed };
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
} finally {
  await browser.close().catch(() => {});
}

if (failed) {
  console.error(`\n${failed} fallback browser test(s) failed`);
  process.exit(1);
}
console.log("\nall fallback browser tests passed");
