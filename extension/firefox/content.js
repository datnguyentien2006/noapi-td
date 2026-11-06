// NOAPI? content script.
// Injects a floating "NOAPI?" control panel on supported AI websites.
// Interacts with chat composers (ChatGPT, Claude, Gemini, Perplexity, Grok, Mistral)
// to send prompts and capture responses for OpenCode via the local bridge.
(() => {
  "use strict";
  if (window.__NOAPI_CONTENT_LOADED__) return;
  window.__NOAPI_CONTENT_LOADED__ = true;

  const ext = globalThis.browser || globalThis.chrome;
  if (!ext || !ext.runtime) return;

  const SITES = {
    chatgpt: {
      name: "ChatGPT",
      debounce: 350,
      hosts: ["chatgpt.com", "chat.openai.com"],
      input: [
        "#prompt-textarea",
        'div#prompt-textarea[contenteditable="true"]',
        'div[contenteditable="true"][data-placeholder]',
        'div[contenteditable="true"][role="textbox"]',
        'div.rich-editor[contenteditable="true"]',
        'textarea[data-id="root"]',
        "textarea",
      ],
      send: [
        'button[data-testid="send-button"]',
        'button[data-testid="fruitjuice-send-button"]',
        'button[aria-label="Send prompt"]',
        'button[aria-label="Send message"]',
        'button[aria-label="Send"]',
        'button[aria-label*="send" i]',
        "#composer-submit-button",
      ],
      stop: ['button[data-testid="stop-button"]', 'button[aria-label*="Stop" i]'],
      reply: [
        '[data-message-author-role="assistant"]',
        'div[data-testid="assistant-message"]',
        "div.agent-turn",
        "div[data-message-model-slug]",
        'section[data-turn="assistant"]',
        '[data-turn="assistant"]',
      ],
      transcript: '[data-testid="conversation-turns"], main',
    },
    claude: {
      name: "Claude",
      debounce: 400,
      hosts: ["claude.ai"],
      input: [
        'div[contenteditable="true"].ProseMirror',
        'div[contenteditable="true"][data-testid="cm-editor-content"]',
        'div[contenteditable="true"][role="textbox"]',
        'textarea[aria-label*="message" i]',
        "textarea",
      ],
      send: [
        'button[aria-label="Send Message"]',
        'button[aria-label="Send message"]',
        'button[data-testid="send"]',
        'button[aria-label*="Send" i]',
        'fieldset button[type="button"]',
      ],
      stop: ['button[aria-label*="Stop" i]'],
      reply: [
        '[data-testid="assistant-message"]',
        '[data-message-author-role="assistant"]',
        "div.font-claude-message",
        "div.grid-cols-1",
      ],
      transcript: "main",
    },
    gemini: {
      name: "Gemini",
      debounce: 550,
      hosts: ["gemini.google.com", "gemini.google"],
      input: [
        'div.ql-editor[contenteditable="true"]',
        'rich-textarea div[contenteditable="true"]',
        "textarea#prompt",
        "textarea.textarea",
        'div[contenteditable="true"][data-placeholder]',
        'div[contenteditable="true"][role="textbox"]',
        "textarea",
      ],
      send: [
        "button.send-button",
        'button[aria-label*="Send" i]',
        'button[mattooltip="Send message"]',
        "button.mat-mdc-icon-button",
      ],
      stop: ['button[aria-label*="Stop" i]'],
      reply: [
        "model-response-text",
        'message-content[role="presentation"]',
        '[data-message-author-role="assistant"]',
        "div.response-container",
      ],
      transcript: "main",
    },
    perplexity: {
      name: "Perplexity",
      debounce: 450,
      hosts: ["perplexity.ai"],
      input: [
        'textarea[placeholder*="Ask" i]',
        'textarea[placeholder*="Search" i]',
        'textarea[aria-label*="ask" i]',
        "textarea",
      ],
      send: [
        'button[aria-label*="Submit" i]',
        'button[aria-label*="Send" i]',
        'button[type="submit"]',
      ],
      stop: ['button[aria-label*="Stop" i]'],
      reply: ['div[class*="Answer"]', "article", "div.prose"],
      transcript: "main",
    },
    grok: {
      name: "Grok",
      debounce: 350,
      hosts: ["grok.com"],
      input: [
        'div[contenteditable="true"][role="textbox"]',
        'textarea[placeholder*="Grok" i]',
        "textarea",
      ],
      send: [
        'button[aria-label*="Grok" i]',
        'button[aria-label*="Send" i]',
        'button[type="submit"]',
      ],
      stop: ['button[aria-label*="Stop" i]'],
      reply: ["div.md", "div.message-bubble-assistant", '[class*="markdown"]'],
      transcript: "main",
    },
     mistral: {
       name: "Mistral Chat",
       debounce: 450,
       hosts: ["chat.mistral.ai"],
       input: [
         'textarea[placeholder*="message" i]',
         'div[contenteditable="true"][role="textbox"]',
         "textarea",
       ],
       send: [
         'button[aria-label*="Send" i]',
         'button[type="submit"]',
       ],
       stop: ['button[aria-label*="Stop" i]'],
       reply: ['[data-role="assistant"]', "div.prose", 'div[class*="assistant"]'],
       transcript: "main",
     },
     deepseek: {
       name: "DeepSeek",
       debounce: 450,
       hosts: ["chat.deepseek.com", "deepseek.com"],
       iconSend: true,
       input: [
         "textarea#chat-input",
         'textarea[placeholder*="Message" i]',
         'textarea[placeholder*="DeepSeek" i]',
         'div[contenteditable="true"][role="textbox"]',
         "textarea",
       ],
       send: [
         'div[role="button"][aria-disabled="false"]',
         'button[type="submit"]',
         'button[aria-label*="Send" i]',
       ],
       stop: ['div[role="button"][aria-label*="Stop" i]', 'button[aria-label*="Stop" i]'],
       reply: [
         "div.ds-markdown",
         "div[class*='ds-markdown']",
         '[data-message-author-role="assistant"]',
       ],
       transcript: "main",
     },
   };

  function detectSite() {
    const host = location.hostname.toLowerCase();
    for (const [key, cfg] of Object.entries(SITES)) {
      if (cfg.hosts.some((h) => host === h || host.endsWith("." + h))) {
        return { key, ...cfg };
      }
    }
    return null;
  }

  const SITE = detectSite();
  if (!SITE) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const normalize = (s) => String(s || "").replace(/\n{3,}/g, "\n\n").trim();

  // ---------------- TEXT EXTRACTION ----------------
  // Turn a rendered chat message into clean markdown-ish text, skipping UI
  // chrome (copy buttons, "ChatGPT said:" headings) that innerText would include.
  const SKIP_TAGS = new Set(["BUTTON", "SVG", "STYLE", "SCRIPT", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "IFRAME"]);
  const BLOCK_TAGS = new Set([
    "P", "DIV", "LI", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6", "TR", "BLOCKQUOTE",
    "SECTION", "ARTICLE", "TABLE", "HR", "MESSAGE-CONTENT", "MODEL-RESPONSE-TEXT",
  ]);

  function extractText(root) {
    let out = "";
    const nl = () => {
      if (out && !out.endsWith("\n")) out += "\n";
    };
    const walk = (n) => {
      if (n.nodeType === 3) {
        out += n.nodeValue;
        return;
      }
      if (n.nodeType !== 1) return;
      const tag = n.tagName.toUpperCase();
      if (SKIP_TAGS.has(tag)) return;
      if (n.classList && (n.classList.contains("sr-only") || n.classList.contains("visually-hidden"))) return;
      if (tag === "PRE") {
        const code = n.querySelector("code") || n;
        const lang = (code.className || "").match(/language-([\w+-]+)/)?.[1] || "";
        nl();
        out += "```" + lang + "\n" + String(code.textContent || "").replace(/\n+$/, "") + "\n```\n";
        return;
      }
      if (tag === "BR") {
        out += "\n";
        return;
      }
      if (tag === "CODE") {
        out += "`" + n.textContent + "`";
        return;
      }
      const block = BLOCK_TAGS.has(tag);
      if (block) nl();
      if (tag === "LI") out += "- ";
      for (const c of n.childNodes) walk(c);
      if (block) nl();
    };
    walk(root);
    return stripHeader(normalize(out));
  }

  function stripHeader(t) {
    return t
      .replace(/^\s*(?:ChatGPT|Claude|Gemini|DeepSeek|Perplexity|Grok|Mistral)(?: Chat)?\s+said:?\s*\n?/i, "")
      .trim();
  }

  // If a fallback capture included our own prompt echoed back, keep only what follows it.
  function dropEcho(text, prompt) {
    const tail = String(prompt || "").trim().slice(-60);
    if (tail.length < 8) return text;
    const i = text.lastIndexOf(tail);
    return i >= 0 ? text.slice(i + tail.length).trim() : text;
  }

  const state = { bridge: false, busy: false, port: null, cancel: false, reqId: null, justStopped: false };

  // ---------------- UI CREATION ----------------
  const host = document.createElement("div");
  host.id = "noapi-host";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
<style>
  :host {
    all: initial;
    display: block;
    position: fixed;
    right: 20px;
    bottom: 20px;
    z-index: 2147483647;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  * { box-sizing: border-box; }
  .fab {
    width: 50px;
    height: 50px;
    border-radius: 25px;
    background: #0f172a;
    border: 2px solid #334155;
    color: #38bdf8;
    cursor: pointer;
    position: relative;
    font-size: 20px;
    font-weight: 800;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    transition: transform 0.15s ease, border-color 0.15s ease;
    user-select: none;
  }
  .fab:hover {
    transform: scale(1.06);
    border-color: #38bdf8;
  }
  .dot {
    position: absolute;
    top: 2px;
    right: 2px;
    width: 12px;
    height: 12px;
    border-radius: 6px;
    background: #ef4444;
    border: 2px solid #0f172a;
    box-shadow: 0 0 6px #ef4444;
  }
  .dot.on {
    background: #22c55e;
    box-shadow: 0 0 8px #22c55e;
  }
  .dot.wait {
    background: #f59e0b;
    box-shadow: 0 0 8px #f59e0b;
    animation: pulse 1s infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.4; transform: scale(0.85); }
  }
  .badge {
    position: absolute;
    bottom: -2px;
    left: -2px;
    min-width: 18px;
    height: 18px;
    border-radius: 9px;
    background: #f59e0b;
    color: #000;
    font-size: 11px;
    font-weight: 800;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 4px;
    border: 2px solid #0f172a;
  }
  .panel {
    position: absolute;
    right: 0;
    bottom: 60px;
    width: 340px;
    background: #0f172a;
    border: 1px solid #334155;
    border-radius: 12px;
    padding: 14px;
    box-shadow: 0 12px 36px rgba(0,0,0,0.65);
    color: #f1f5f9;
    font-size: 13px;
    line-height: 1.4;
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }
  .title {
    font-weight: 800;
    font-size: 15px;
    color: #38bdf8;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .site-pill {
    background: #1e293b;
    color: #94a3b8;
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 6px;
    border: 1px solid #334155;
  }
  .status-bar {
    background: #1e293b;
    border-radius: 8px;
    padding: 6px 10px;
    margin-bottom: 10px;
    font-size: 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .status-text {
    display: flex;
    align-items: center;
    gap: 6px;
    color: #cbd5e1;
  }
  .status-text .mini-dot {
    width: 8px;
    height: 8px;
    border-radius: 4px;
    background: #ef4444;
  }
  .status-text .mini-dot.on { background: #22c55e; }
  .mode-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
    font-size: 12px;
    color: #94a3b8;
  }
  .mode-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
  }
  textarea {
    width: 100%;
    min-height: 70px;
    max-height: 180px;
    resize: vertical;
    background: #1e293b;
    color: #f1f5f9;
    border: 1px solid #334155;
    border-radius: 8px;
    padding: 8px 10px;
    font-size: 12.5px;
    font-family: inherit;
    margin-bottom: 8px;
    outline: none;
  }
  textarea:focus { border-color: #38bdf8; }
  .actions {
    display: flex;
    gap: 6px;
  }
  button {
    border: 1px solid #334155;
    background: #1e293b;
    color: #f1f5f9;
    border-radius: 8px;
    padding: 7px 11px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.1s, border-color 0.1s;
  }
  button:hover { background: #334155; }
  button.primary {
    background: #0284c7;
    border-color: #0284c7;
    color: #fff;
    flex: 1;
  }
  button.primary:hover { background: #0369a1; }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .log-box {
    margin-top: 10px;
    font-size: 11.5px;
    color: #94a3b8;
    background: #090d16;
    padding: 6px 8px;
    border-radius: 6px;
    min-height: 18px;
    word-break: break-word;
  }
</style>
<div class="panel" hidden>
  <div class="header">
    <div class="title">NOAPI? <span class="site-pill">${SITE.name}</span></div>
    <button class="reconnect-btn" style="padding:2px 8px;font-size:11px">Reconnect</button>
  </div>
  <div class="status-bar">
    <div class="status-text">
      <span class="mini-dot"></span>
      <span class="status-label">Bridge: checking…</span>
    </div>
    <button class="stop-btn" style="padding:2px 8px;font-size:11px" title="Abort the current request" hidden>Stop</button>
  </div>
  <div class="mode-row"><span>Automatic: OpenCode prompts are typed, sent and answered by this tab.</span></div>
  <div class="log-box">Ready. Waiting for OpenCode…</div>
</div>
<div class="fab" title="NOAPI? — Bridge AI chat to OpenCode">
  <span>?</span>
  <div class="dot"></div>
</div>
`;

  const panel = shadow.querySelector(".panel");
  const fab = shadow.querySelector(".fab");
  const dot = shadow.querySelector(".dot");
  const miniDot = shadow.querySelector(".mini-dot");
  const statusLabel = shadow.querySelector(".status-label");
  const stopBtn = shadow.querySelector(".stop-btn");
  const reconnectBtn = shadow.querySelector(".reconnect-btn");
  const logBox = shadow.querySelector(".log-box");

  function attachHost() {
    if (document.body && !document.getElementById("noapi-host")) document.body.appendChild(host);
  }
  attachHost();
  if (document.readyState !== "complete") window.addEventListener("load", attachHost);
  setInterval(attachHost, 3000); // SPAs sometimes wipe the body

  let lastProgress = "";
  let lastProgressAt = 0;
  // report: false = local log only; true = stage change (always forwarded to
  // OpenCode); "tick" = frequent counter updates (throttled, may be skipped).
  function setLog(msg, report = false) {
    logBox.textContent = msg;
    if (report && state.reqId) reportProgress(msg, report === "tick");
  }

  function reportProgress(msg, tick) {
    const now = Date.now();
    if (msg === lastProgress) return;
    if (tick && now - lastProgressAt < 2500) return;
    lastProgress = msg;
    lastProgressAt = now;
    ext.runtime.sendMessage({ type: "noapi_progress", id: state.reqId, status: msg }).catch(() => {});
  }

  function updateStatusUI() {
    dot.className = "dot" + (state.busy ? " wait" : state.bridge ? " on" : "");
    miniDot.className = "mini-dot" + (state.bridge ? " on" : "");
    if (state.busy) {
      statusLabel.textContent = SITE.name + " is working…";
      statusLabel.style.color = "#fbbf24";
    } else if (state.bridge) {
      statusLabel.textContent = "Bridge: Connected (:8787)";
      statusLabel.style.color = "#4ade80";
    } else {
      statusLabel.textContent = "Bridge: Offline (node bridge/index.js)";
      statusLabel.style.color = "#f87171";
    }
    stopBtn.hidden = !state.busy;
  }

  function initPort() {
    try {
      state.port = ext.runtime.connect({ name: "noapi-tab" });
      state.port.onMessage.addListener((msg) => handleIncomingMessage(msg));
      state.port.onDisconnect.addListener(() => {
        state.port = null;
        setTimeout(initPort, 3000);
      });
      state.port.postMessage({ type: "noapi_hello", site: SITE.key, url: location.href });
    } catch (e) {}
  }
  initPort();

  ext.runtime
    .sendMessage({ type: "noapi_hello", site: SITE.key, url: location.href })
    .then((r) => {
      if (r) {
        state.bridge = Boolean(r.connected);
        updateStatusUI();
      }
    })
    .catch(() => {});

  function handleIncomingMessage(msg) {
    if (!msg || !msg.type) return;
    if (msg.type === "noapi_bridge_status") {
      state.bridge = Boolean(msg.connected);
      updateStatusUI();
    } else if (msg.type === "noapi_autosend") {
      setLog("Prompt received from OpenCode…");
      runPipeline(msg.prompt, msg.id, Boolean(msg.toolsEnabled), {
        earlyReturn: msg.earlyReturn,
        earlyReturnMs: msg.earlyReturnMs,
        toolNames: msg.toolNames,
      }).catch(() => {});
    } else if (msg.type === "noapi_cancel") {
      if (state.busy && (!msg.id || msg.id === state.reqId)) cancelCurrent();
    } else if (msg.type === "noapi_toggle_panel") {
      panel.hidden = !panel.hidden;
    }
  }

  ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    handleIncomingMessage(msg);
    sendResponse({ ok: true });
    return true;
  });

  fab.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      ext.runtime
        .sendMessage({ type: "noapi_status_req" })
        .then((r) => {
          if (r) {
            state.bridge = Boolean(r.connected);
            updateStatusUI();
          }
        })
        .catch(() => {});
    }
  });

  reconnectBtn.addEventListener("click", () => {
    setLog("Attempting bridge reconnect…");
    ext.runtime
      .sendMessage({ type: "noapi_test_bridge" })
      .then((r) => {
        state.bridge = Boolean(r?.connected);
        updateStatusUI();
        setLog(state.bridge ? "✓ Reconnected to bridge!" : "Bridge still offline. Start it with 'npm start'.");
      })
      .catch(() => setLog("Could not reach extension background."));
  });

  stopBtn.addEventListener("click", () => cancelCurrent());

  // ---------------- SITE AUTOMATION ENGINE ----------------
  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  }

  async function findComposer() {
    for (const sel of SITE.input) {
      try {
        const el = document.querySelector(sel);
        if (el && visible(el)) return el;
      } catch {}
    }
    const all = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')).filter(
      (e) => visible(e) && !e.closest("#noapi-host")
    );
    return all[all.length - 1] || null;
  }

  // The site may re-render the composer (typically right after the first
  // message of a new chat), so always re-query instead of keeping a stale node.
  async function waitForComposer(ms = 15_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const c = await findComposer();
      if (c) return c;
      await sleep(300);
    }
    return null;
  }

  const composerText = (el) => String(el?.value ?? el?.innerText ?? el?.textContent ?? "").replace(/\s+/g, " ").trim();

  function isStopVisible() {
    for (const sel of SITE.stop || []) {
      try {
        const b = document.querySelector(sel);
        if (b && visible(b)) return true;
      } catch {}
    }
    return false;
  }

  // Condition-based typing helpers. The old code slept for a fixed 80+50+120+250ms
  // (plus 450ms in ensureTyped) "just in case"; instead we insert the text and then
  // poll until the composer really holds it, which is usually far quicker and still
  // waits as long as needed on a slow page.
  const FILL_POLL_MS = 35;
  const LONG_PROMPT_PASTE_THRESHOLD = 1500;

  async function waitUntil(fn, timeoutMs, stepMs = FILL_POLL_MS) {
    const t0 = Date.now();
    for (;;) {
      if (fn()) return true;
      if (Date.now() - t0 >= timeoutMs) return false;
      await sleep(stepMs);
    }
  }

  function selectComposerContents(el) {
    el.focus();
    const sel = window.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.addRange(range);
  }

  function pasteIntoComposer(el, text) {
    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      return true;
    } catch {
      return false;
    }
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  }

  async function typePromptIntoComposer(el, text) {
    const activeSel = window.getSelection();
    if (activeSel) activeSel.removeAllRanges();

    el.focus();

    if (!el.isContentEditable) {
      setNativeValue(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      el.innerHTML = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }

    // Make sure the clear actually landed before inserting (frameworks often
    // clear asynchronously). Returns immediately when it is already empty.
    await waitUntil(() => composerText(el).length === 0, 150);

    const want = text.replace(/\s+/g, " ").trim();
    const filled = () => {
      const got = composerText(el);
      return got.length >= want.length * 0.95 && got.length <= want.length * 1.2 + 10;
    };
    const looselyFilled = () => composerText(el).length >= want.length * 0.95;

    if (el.isContentEditable) {
      const tryPaste = () => {
        selectComposerContents(el);
        return pasteIntoComposer(el, text);
      };
      const tryInsert = () => {
        selectComposerContents(el);
        let ok = false;
        try {
          ok = document.execCommand("insertText", false, text);
        } catch {}
        return ok;
      };

      // Long prompts: execCommand("insertText") gets slow with a few thousand
      // characters, so try the synthetic paste first. Both paths are verified by
      // polling the composer, and anything that does not land falls through.
      if (text.length > LONG_PROMPT_PASTE_THRESHOLD && tryPaste() && (await waitUntil(filled, 400))) return;
      if (!(tryInsert() && (await waitUntil(filled, 400)))) {
        if (!(tryPaste() && (await waitUntil(filled, 400)))) {
          selectComposerContents(el);
          el.textContent = text;
          el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
          await waitUntil(looselyFilled, 300);
        }
      }
    } else {
      setNativeValue(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      await waitUntil(filled, 300);
    }
  }

  const wantedFilled = (el, text) => {
    const want = text.replace(/\s+/g, " ").trim();
    const got = composerText(el);
    return got.length >= want.length * 0.95;
  };

  // Type the prompt and CHECK it stayed there: frameworks like React may
  // re-render the composer right after our programmatic input and reset it to
  // empty, which leaves the send button disabled and nothing gets sent. The
  // settle delay only exists to catch that async wipe, so it is short.
  const TYPE_SETTLE_MS = 150;
  async function ensureTyped(composer, text) {
    let el = composer;
    for (let attempt = 1; attempt <= 4; attempt++) {
      await typePromptIntoComposer(el, text);
      await sleep(TYPE_SETTLE_MS);
      el = (await findComposer()) || el;
      if (wantedFilled(el, text)) return el;
      setLog(`Text did not stick in the chat box, typing again (${attempt}/4)...`, true);
    }
    return el;
  }

  const isEnabled = (b) => !b.disabled && b.getAttribute("aria-disabled") !== "true";

  // DeepSeek's send button is an icon-only <div role="button"> with no label,
  // and message actions (edit / copy / regenerate) look exactly the same. So
  // never search the whole page: look only at icon-only buttons that sit AFTER
  // the composer in the same container, and take the last one (the send
  // arrow). If it is still disabled, return null so the caller waits or falls
  // back to Enter - never click another icon (attach, edit...).
  function findIconSendButton(composer) {
    if (!composer) return null;
    // While the site is generating, the send arrow turns into a STOP square in
    // the same place. With nothing typed we must never click it.
    if (!composerText(composer)) return null;
    let root = composer;
    for (let i = 0; i < 8 && root.parentElement; i++) {
      root = root.parentElement;
      const cands = Array.from(root.querySelectorAll('div[role="button"], button')).filter(
        (b) =>
          visible(b) &&
          !b.closest("#noapi-host") &&
          !(b.textContent || "").trim() &&
          !b.querySelector('input[type="file"]') &&
          !!(composer.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
      );
      if (cands.length) {
        const last = cands[cands.length - 1];
        return isEnabled(last) ? last : null;
      }
    }
    return null;
  }

  function findSendButton(composer) {
    if (SITE.iconSend) return findIconSendButton(composer);
    for (const sel of SITE.send) {
      try {
        for (const b of document.querySelectorAll(sel)) {
          if (visible(b) && isEnabled(b) && !b.closest("#noapi-host")) {
            return b;
          }
        }
      } catch {}
    }
    return null;
  }

  async function submitComposer(composer) {
    let btn = null;
    for (let i = 0; i < 8 && !btn; i++) {
      btn = findSendButton(composer);
      if (!btn) await sleep(150);
    }
    if (btn) {
      btn.click();
      return true;
    }
    if (composer) {
      composer.focus();
      for (const ev of ["keydown", "keypress", "keyup"]) {
        composer.dispatchEvent(
          new KeyboardEvent(ev, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true })
        );
      }
      return true;
    }
    return false;
  }

  // Assistant message nodes currently on the page, innermost only.
  function replyNodes() {
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(SITE.reply.join(", "))).filter((n) => !n.closest("#noapi-host"));
    } catch {}
    return nodes.filter((n) => !nodes.some((o) => o !== n && n.contains(o)));
  }

  // Fallback for sites whose reply selectors match nothing (markup changed).
  // Sampling the page twice, a moment apart, finds whatever is actively growing
  // — but only when we are already stuck, instead of snapshotting every element
  // on the page once per request the way the old code did.
  const GROW_SAMPLE_MS = 350;
  const FALLBACK_AFTER_MS_BASELINE = 3000;

  // The transcript container can be replaced by the site (a new chat usually
  // re-mounts it on the first message), so never keep the node captured before
  // sending: look it up again each time.
  function currentScope() {
    for (const s of SITE.transcript.split(",")) {
      try {
        const el = document.querySelector(s.trim());
        if (el) return el;
      } catch {}
    }
    return document.body;
  }

  function elementLengths(scope) {
    const m = new Map();
    const t0 = Date.now();
    for (const el of scope.querySelectorAll("*")) {
      m.set(el, (el.textContent || "").length);
      if (m.size % 400 === 0 && Date.now() - t0 > 150) break; // long chats: a partial sample is enough
    }
    return m;
  }

  // Walks the CURRENT page, so elements the site created after the baseline was
  // taken (the reply bubble is a brand-new node!) count as growth from 0. The old
  // version only looked at elements that already existed in the baseline and
  // therefore could never find a freshly mounted reply.
  function biggestGrower(base, exclude) {
    let best = null;
    let bestGrow = 7;
    const scope = currentScope();
    for (const el of scope.querySelectorAll("*")) {
      if (el === exclude || el.contains?.(exclude) || exclude?.contains?.(el)) continue;
      if (host.contains(el) || el.contains(host)) continue;
      const g = (el.textContent || "").length - (base.get(el) || 0);
      if (g > bestGrow) {
        best = el;
        bestGrow = g;
      }
    }
    return best;
  }

  // Why no reply was found: counts per selector, so a broken selector is obvious
  // from the status line alone.
  function replyDiag() {
    const per = (SITE.reply || []).map((sel) => {
      try {
        return document.querySelectorAll(sel).length;
      } catch {
        return "x";
      }
    });
    return `sel=[${per.join(",")}] scope=${currentScope().tagName.toLowerCase()} url=${location.pathname.slice(0, 24)}`;
  }

  function stopGeneration() {
    for (const sel of SITE.stop || []) {
      try {
        const b = document.querySelector(sel);
        if (b && visible(b)) {
          b.click();
          return true;
        }
      } catch {}
    }
    return false;
  }

  function cancelCurrent() {
    state.cancel = true;
    stopGeneration();
    setLog("Stopped.");
  }

  // Before typing the next prompt (e.g. the bash result) make sure the site is
  // not still streaming the previous answer: typing/sending then would hit the
  // STOP button or get swallowed. Idle = no stop button and the last reply did
  // not change between two samples. Bounded, so it can never hang.
  async function waitForIdle(maxMs = 60_000) {
    // If the previous request was ended deliberately (we returned a complete
    // tool call and clicked stop ourselves), the page is already idle — skip
    // the stability poll entirely.
    if (state.justStopped) {
      state.justStopped = false;
      return;
    }
    const t0 = Date.now();
    const snap = () => {
      const n = replyNodes();
      return n.length ? extractText(n[n.length - 1]) : "";
    };
    let prev = snap();
    while (Date.now() - t0 < maxMs) {
      await sleep(700);
      if (state.cancel) throw new Error("Cancelled.");
      const cur = snap();
      if (!isStopVisible() && cur === prev) return;
      prev = cur;
      setLog(SITE.name + " is still answering the previous message, waiting…", true);
    }
  }

  // ---- completion detection -------------------------------------------------
  // The reply is complete when the site's "stop" button has been seen and has
  // now disappeared AND the reply text has not changed for a short debounce
  // (SITE.debounce). That replaces the old "unchanged for 2200ms" rule, which
  // was pure dead time after the last token. The 2200ms rule is kept only as a
  // fallback for sites/cases where the stop button was never observed at all.
  //
  // A MutationObserver wakes us as soon as the page changes, so extractText only
  // runs when something actually moved (throttled to ~8/s), with a slow safety
  // net for sites whose reply lives in a shadow root, where an observer on the
  // light DOM cannot see the mutation.
  const FALLBACK_STABLE_MS = 2200;
  const OBSERVER_TICK_MS = 250;
  const EXTRACT_THROTTLE_MS = 120;
  const UNSEEN_MUTATION_MS = 1000;
  const STALL_LOG_MS = 20_000;

  // Pure decision function, delimited so tools/test-content-logic.js can lift it
  // out of this file and unit-test it without a browser. Keep it self-contained
  // (no outer variables) — that is what makes the extraction possible.
  /* @noapi-shared-start completionDecision */
  function completionDecision(lastTextLength, stopVisible, stopSeen, quietMs, debounceMs, fallbackMs) {
    if (lastTextLength < 5 || stopVisible) return false;
    return stopSeen ? quietMs >= debounceMs : quietMs >= fallbackMs;
  }
  /* @noapi-shared-end completionDecision */

  // Tools enabled: a reply is "done enough" as soon as it ends with a complete
  // TOOL_CALL block that has settled for EARLY_RETURN_MS. A finished tool call
  // is actionable immediately; waiting for the site to also finish any trailing
  // narration just burns a full round-trip of latency. Anchoring the check to
  // the END of the reply is what makes several consecutive blocks safe: while
  // the model is still writing (the next block, or the fence) the tail is not a
  // finished block, and the quiet timer keeps resetting anyway.
  const DEFAULT_EARLY_RETURN_MS = 400;
  // If the site is still generating after a complete block, wait at most this
  // long for a possible second block before stopping. Trade-off: batching many
  // calls wins up to this point, and a very late block after it is treated as
  // trailing narration (it is dropped in exchange for not adding dead time).
  const EARLY_RETURN_HARD_CAP_MS = 1500;
  // One re-read after clicking stop, to catch a block that was mid-write.
  const EARLY_RETURN_REREAD_MS = 120;
  // How often the still-growing reply is forwarded to OpenCode while it streams.
  const PARTIAL_THROTTLE_MS = 150;

  // Pure decision functions, delimited so tools/test-content-logic.js can lift
  // them out of this file and unit-test them without a browser. Keep them
  // self-contained (no outer variables).
  /* @noapi-shared-start toolEarlyReturn */
  // The JSON object of a TOOL_CALL block that ends the reply, or null. "Valid"
  // means: a closing fence, a balanced JSON object that actually parses, and a
  // tool name (checked against the current tool list when one is provided).
  function toolBlockAtEnd(text, toolNames) {
    const s = String(text || "").replace(/\s+$/, "");
    if (!s.endsWith("```")) return null;
    const before = s.slice(0, -3);
    const marker = before.lastIndexOf("TOOL_CALL");
    if (marker === -1) return null;
    const brace = before.indexOf("{", marker + "TOOL_CALL".length);
    if (brace === -1) return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let i = brace; i < before.length; i++) {
      const ch = before[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end === -1 || before.slice(end).trim() !== "") return null;
    let obj = null;
    try {
      obj = JSON.parse(before.slice(brace, end));
    } catch {
      return null;
    }
    const name = obj && (obj.name || obj.tool || obj.tool_name || (obj.function && obj.function.name));
    if (typeof name !== "string") return null;
    if (Array.isArray(toolNames) && toolNames.length) {
      const known = toolNames.some((n) => n === name || String(n).toLowerCase() === name.toLowerCase());
      if (!known) return null;
    }
    return { name };
  }

  // How many complete, valid TOOL_CALL blocks the reply contains. Used to tell
  // whether a re-read after clicking stop captured more than the first read.
  function toolBlockCount(text, toolNames) {
    const s = String(text || "");
    let count = 0;
    let from = 0;
    for (;;) {
      const marker = s.indexOf("TOOL_CALL", from);
      if (marker === -1) break;
      const brace = s.indexOf("{", marker + "TOOL_CALL".length);
      if (brace === -1) break;
      let depth = 0;
      let inStr = false;
      let esc = false;
      let end = -1;
      for (let i = brace; i < s.length; i++) {
        const ch = s[i];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === "\\") esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            end = i + 1;
            break;
          }
        }
      }
      if (end === -1) {
        from = marker + 1;
        continue;
      }
      let obj = null;
      try {
        obj = JSON.parse(s.slice(brace, end));
      } catch {}
      const name = obj && (obj.name || obj.tool || obj.tool_name || (obj.function && obj.function.name));
      const known =
        typeof name === "string" &&
        (!Array.isArray(toolNames) ||
          !toolNames.length ||
          toolNames.some((n) => n === name || String(n).toLowerCase() === name.toLowerCase()));
      const fenced = s.slice(end).includes("```");
      if (known && fenced) count++;
      from = end;
    }
    return count;
  }

  function toolEarlyReturnDecision(opts) {
    const o = opts || {};
    if (!o.toolsEnabled || o.enabled === false) return false;
    if (!toolBlockAtEnd(o.replyText, o.toolNames)) return false;
    const grace = Number.isFinite(o.earlyReturnMs) ? o.earlyReturnMs : 400;
    if ((o.quietMs || 0) < grace) return false;
    // While the site is still generating, a pause is not proof the turn is
    // over: a second block may start just after the grace window. Wait up to a
    // hard cap before clicking stop, so that block is not silently lost.
    if (o.generating) {
      const cap = Number.isFinite(o.hardCapMs) ? o.hardCapMs : 1500;
      if ((o.sinceBlockMs || 0) < cap) return false;
    }
    return true;
  }
  /* @noapi-shared-end toolEarlyReturn */

  async function waitForResponse({ timeoutMs, composer, prompt, before, beforeLast, scope, baseline = null, typedLen, toolsEnabled = false, earlyReturn = true, earlyReturnMs = DEFAULT_EARLY_RETURN_MS, toolNames = [], pipelineT0 = null, timings = null }) {
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      let lastText = "";
      let lastTextAt = 0; // when the extracted reply text last changed
      let stopSeen = false;
      let sawActivity = false;
      let resubmits = 0;
      let lastExtractAt = 0;
      let lastStallLog = 0;
      let dirty = true;
      let ticking = false;
      let done = false;
      let observer = null;
      let timer = null;

      const cleanup = () => {
        if (timer) clearInterval(timer);
        timer = null;
        try {
          observer?.disconnect();
        } catch {}
        observer = null;
      };
      const finish = (text, completedBy) => {
        if (done) return;
        done = true;
        cleanup();
        if (timings) {
          timings.resubmits = resubmits;
          // How this turn ended: the stop button disappearing ("stop"), the
          // stable-text fallback ("fallback"), or the early tool return
          // ("early"). /health keeps a per-site counter for each.
          timings.completedBy = completedBy || (stopSeen ? "stop" : "fallback");
        }
        resolve(text);
      };
      const fail = (err) => {
        if (done) return;
        done = true;
        cleanup();
        reject(err);
      };

      // Stream the text so far while it grows (throttled). The bridge forwards
      // it to OpenCode as content deltas for plain answers and buffers it while
      // it might contain a TOOL_CALL; the final `response` stays authoritative.
      let earlyBlockAt = 0; // when the reply first ended with a complete tool block
      let lastPartialAt = 0;
      let lastPartialText = "";
      const sendPartial = (text) => {
        if (!state.reqId || !text || text === lastPartialText) return;
        const now = Date.now();
        if (now - lastPartialAt < PARTIAL_THROTTLE_MS) return;
        lastPartialAt = now;
        lastPartialText = text;
        try {
          ext.runtime.sendMessage({ type: "noapi_partial", id: state.reqId, text }).catch(() => {});
        } catch {}
      };

      try {
        observer = new MutationObserver(() => {
          dirty = true;
        });
        observer.observe(scope || document.body, { subtree: true, childList: true, characterData: true });
      } catch {}

      // The stuck-fallback: sample the page, wait, and take the biggest grower.
      // The node found is reused while it stays connected, so we do not re-sample
      // on every tick.
      let grownNode = null;
      let grownAt = 0;
      const fallbackText = async () => {
        const now = Date.now();
        if (grownNode && grownNode.isConnected && now - grownAt < 2000) {
          const t = dropEcho(extractText(grownNode), prompt);
          if (t) return t;
        }
        let base = baseline;
        if (!base) {
          base = elementLengths(currentScope());
          await sleep(GROW_SAMPLE_MS);
        }
        grownNode = biggestGrower(base, composer);
        grownAt = Date.now();
        return grownNode ? dropEcho(extractText(grownNode), prompt) : "";
      };

      const readText = async (generating) => {
        const nodes = replyNodes();
        let text = "";
        let fromSelector = false;
        if (nodes.length > before) {
          text = extractText(nodes[nodes.length - 1]);
          fromSelector = true;
        } else if (nodes.length && nodes.length === before) {
          const t = extractText(nodes[nodes.length - 1]);
          if (t && t !== beforeLast && (generating || sawActivity || SITE.iconSend)) {
            text = t;
            fromSelector = true;
          }
        }
        if (!fromSelector && Date.now() - t0 > (baseline ? FALLBACK_AFTER_MS_BASELINE : 8000)) {
          text = await fallbackText();
        }
        return text;
      };

      const tick = async () => {
        if (done || ticking) return;
        ticking = true;
        try {
          if (state.cancel) {
            fail(new Error("Cancelled."));
            return;
          }
          const now = Date.now();
          if (now - t0 >= timeoutMs) {
            if (lastText.length >= 5) finish(lastText);
            else fail(new Error("Timed out waiting for " + SITE.name + " to complete response."));
            return;
          }

          const generating = isStopVisible();
          if (generating) {
            sawActivity = true;
            stopSeen = true;
            if (timings) timings.stopSeen = true;
          }

          // If the site swallowed the send (nothing started), recover. Two cases:
          //  - the composer still holds our text  -> click send again
          //  - the composer is EMPTY (re-render wiped it) and the page did not
          //    change -> type the prompt again and send
          if (!sawActivity && now - t0 > 4000 * (resubmits + 1) && resubmits < 3) {
            const c = (await findComposer()) || composer;
            const tail = prompt.replace(/\s+/g, " ").trim().slice(-40);
            const pageHasPrompt = tail.length >= 8 && (scope?.textContent || "").replace(/\s+/g, " ").includes(tail);
            const pageGrew = scope && typedLen != null ? scope.textContent.length - typedLen > 15 : false;
            if (c && replyNodes().length <= before && !isStopVisible()) {
              if (composerText(c).length >= 4) {
                resubmits++;
                setLog(`Prompt not accepted yet, sending again (${resubmits}/3)...`, true);
                await submitComposer(c);
                return;
              }
              // Box empty and the page shows no trace of our prompt: it was never sent.
              if (!c.isContentEditable && !pageHasPrompt && !pageGrew) {
                resubmits++;
                setLog(`Chat box is empty and nothing was sent, typing the prompt again (${resubmits}/3)...`, true);
                const c2 = await ensureTyped(c, prompt);
                await submitComposer(c2);
                return;
              }
            }
          }

          // Only read the DOM when it changed (or, at most once a second, in case
          // mutations happen somewhere we cannot observe).
          if ((dirty || now - lastExtractAt >= UNSEEN_MUTATION_MS) && now - lastExtractAt >= EXTRACT_THROTTLE_MS) {
            dirty = false;
            lastExtractAt = now;
            const text = await readText(generating);
            if (!text) {
              lastText = "";
              lastTextAt = 0;
              // Make a silent stall visible in OpenCode instead of "Finding input..." forever.
              const waited = Math.round((now - t0) / 1000);
              if (waited >= 20 && waited - lastStallLog >= STALL_LOG_MS / 1000) {
                lastStallLog = waited;
                const c = (await findComposer()) || composer;
                const dbg = `nodes=${replyNodes().length}/${before} box=${composerText(c).length}ch stop=${isStopVisible()} ${replyDiag()}`;
                setLog(`Prompt sent, but no answer detected on ${SITE.name} yet (${waited}s) [${dbg}]. Still waiting...`, true);
              }
            } else if (text !== lastText) {
              lastText = text;
              lastTextAt = now;
              sawActivity = true;
              if (timings && !timings.firstText) timings.firstText = Date.now() - (pipelineT0 ?? t0);
              setLog(`${SITE.name} is answering... (${text.length} chars)`, "tick");
              sendPartial(text);
            }
          }

          // Tools on: a settled, complete TOOL_CALL block is actionable now.
          // Return it and stop the site so the chat is idle for the next prompt,
          // instead of waiting for the whole trailing narration. The block must
          // be valid JSON naming a real tool (never return early on a partial or
          // malformed block), and while the site is still generating we wait up
          // to a hard cap for a possible second block.
          if (toolsEnabled && earlyReturn) {
            if (toolBlockAtEnd(lastText, toolNames)) {
              if (!earlyBlockAt) earlyBlockAt = now;
            } else {
              earlyBlockAt = 0;
            }
          }
          if (
            toolEarlyReturnDecision({
              toolsEnabled,
              enabled: earlyReturn,
              replyText: lastText,
              quietMs: now - (lastTextAt || now),
              earlyReturnMs,
              generating,
              sinceBlockMs: earlyBlockAt ? now - earlyBlockAt : 0,
              hardCapMs: EARLY_RETURN_HARD_CAP_MS,
              toolNames,
            })
          ) {
            if (timings) timings.earlyReturn = true;
            const stopped = stopGeneration();
            state.justStopped = stopped;
            // Clicking stop is not instantaneous. Re-read once and keep the
            // longer text if it now holds more complete blocks, so a block that
            // was being written when we clicked is not cut off.
            let finalText = lastText;
            if (stopped) {
              await sleep(EARLY_RETURN_REREAD_MS);
              const nodes = replyNodes();
              const after = nodes.length ? extractText(nodes[nodes.length - 1]) : "";
              if (after && toolBlockCount(after, toolNames) > toolBlockCount(lastText, toolNames)) finalText = after;
            }
            setLog(`✓ ${SITE.name} returned a complete tool call — stopping generation.`);
            finish(finalText, "early");
            return;
          }

          // Completion. Needs a non-trivial reply and no stop button right now.
          if (completionDecision(lastText.length, generating, stopSeen, now - (lastTextAt || now), Number(SITE.debounce) || 400, FALLBACK_STABLE_MS)) {
            finish(lastText);
          }
        } catch (err) {
          fail(err);
        } finally {
          ticking = false;
        }
      };

      timer = setInterval(tick, OBSERVER_TICK_MS);
      tick();
    });
  }

  async function runPipeline(prompt, reqId, toolsEnabled = false, opts = {}) {
    // Early return on a complete tool call. The bridge reads the env vars and
    // forwards the decision, because a content script cannot read process.env.
    const earlyReturn = opts.earlyReturn !== false;
    const earlyReturnMs =
      Number.isFinite(Number(opts.earlyReturnMs)) && Number(opts.earlyReturnMs) > 0
        ? Number(opts.earlyReturnMs)
        : DEFAULT_EARLY_RETURN_MS;
    const toolNames = Array.isArray(opts.toolNames) ? opts.toolNames.filter((n) => typeof n === "string") : [];
    if (state.busy) {
      if (reqId) {
        ext.runtime.sendMessage({ type: "noapi_error", id: reqId, error: "This tab is already handling a prompt." }).catch(() => {});
      }
      return;
    }
    state.busy = true;
    state.cancel = false;
    state.reqId = reqId || null;
    lastProgress = "";
    lastProgressAt = 0;
    updateStatusUI();

    // Per-stage timings (milliseconds since the request reached this tab). Sent to
    // the bridge with the final reply so /health and the dashboard can show where
    // the time goes. Shape: false|0 for "not reached yet". See bridge/state.js.
    const t0 = Date.now();
    const timings = { composer: 0, typed: 0, sent: 0, firstText: 0, complete: 0, stopSeen: false, earlyReturn: false };

    try {
      setLog("Finding " + SITE.name + " chat input…", true);
      const composer = await waitForComposer();
      if (!composer) throw new Error("Could not find chat input on " + SITE.name + ". Is the chat page fully loaded?");
      timings.composer = Date.now() - t0;

      if (SITE.iconSend) await waitForIdle(40_000);
      const scope =
        SITE.transcript
          .split(",")
          .map((s) => {
            try {
              return document.querySelector(s.trim());
            } catch {
              return null;
            }
          })
          .find(Boolean) || document.body;
      const beforeNodes = replyNodes();
      const before = beforeNodes.length;
      const beforeLast = before ? extractText(beforeNodes[before - 1]) : "";
      // Pre-send baseline for the selector-free fallback. Only needed when no reply was on the page
      // yet (new chat, small DOM, so cheap); with replies present the selectors evidently work.
      const baseline = before === 0 ? elementLengths(scope) : null;

      let composerNow = (await findComposer()) || composer;
      setLog("Typing prompt into " + SITE.name + "…", true);
      composerNow = await ensureTyped(composerNow, prompt);
      timings.typed = Date.now() - t0;
      if (state.cancel) throw new Error("Cancelled.");

      const typedLen = scope.textContent.length;
      setLog("Sending prompt to " + SITE.name + "…", true);
      if (!(await submitComposer(composerNow))) throw new Error("Could not click Send or trigger Enter on " + SITE.name);
      timings.sent = Date.now() - t0;

      setLog("Waiting for " + SITE.name + " to answer…", true);
      const text = await waitForResponse({ timeoutMs: 590_000, composer: composerNow, prompt, before, beforeLast, scope, baseline, typedLen, toolsEnabled, earlyReturn, earlyReturnMs, toolNames, pipelineT0: t0, timings });
      timings.complete = Date.now() - t0;

      setLog(`✓ Response captured (${text.length} chars). Sent to OpenCode.`);
      if (reqId) ext.runtime.sendMessage({ type: "noapi_reply", id: reqId, text, timings: { ...timings, total: Date.now() - t0 } }).catch(() => {});
      return text;
    } catch (err) {
      setLog("Error: " + err.message);
      if (reqId) ext.runtime.sendMessage({ type: "noapi_error", id: reqId, error: err.message }).catch(() => {});
      throw err;
    } finally {
      state.busy = false;
      state.reqId = null;
      updateStatusUI();
    }
  }

  updateStatusUI();
})();
