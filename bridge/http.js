// HTTP server:
//  - /v1/models            OpenAI-compatible model list (one entry per site)
//  - /v1/chat/completions  OpenAI-compatible chat endpoint (what opencode's
//                          "@ai-sdk/openai-compatible" provider calls)
//  - /health               JSON status
//  - /                     human status dashboard
import http from "node:http";
import fs from "node:fs";
import nodePath from "node:path";
import { SITES, SITE_KEYS } from "./sites.js";
import { requestAllowed } from "./security.js";
import { buildPrompt, buildDelta, parseToolCalls, toolList, toolsHash, isTitleRequest, localTitle, repairToolCall } from "./toolproto.js";
import { guardEnabled, detectRefusal, refusalPrompt, seedTree, seedTreeEnabled, GUARD_MAX, isRepeat, repeatGuardEnabled, REPEAT_PROMPT } from "./guard.js";
import { effectiveRotateLimit, rotateMinTurns, rotateResultBudget } from "./rotation.js";
import { rotateLimit, shouldRotate, buildRecap } from "./recap.js";
import { autoreadReport } from "./consult.js";
import { StreamFilter, streamEnabled } from "./streamfilter.js";
import { tuningFromEnv, sseTextFromEnv } from "./tuning.js";

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json",
  });
  res.end(body);
}

function errorJson(res, code, message, type = "invalid_request_error") {
  sendJson(res, code, { error: { message, type, code } });
}

function estimateTokens(s) {
  return Math.ceil(String(s || "").length / 4);
}

function completionResponse(model, text, calls = []) {
  const message = { role: "assistant", content: text || (calls.length ? null : "") };
  if (calls.length) message.tool_calls = calls;
  return {
    id: `chatcmpl-noapi-${Date.now().toString(36)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: calls.length ? "tool_calls" : "stop" }],
    usage: {
      prompt_tokens: 0,
      completion_tokens: estimateTokens(text),
      total_tokens: estimateTokens(text),
    },
  };
}

function dashboardHtml() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>NOAPI? bridge</title>
<style>
  :root { color-scheme: dark; }
  body { font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; background: #0b0d12; color: #e5e7eb; margin: 0; padding: 32px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #9ca3af; margin-bottom: 24px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: #9ca3af; margin: 24px 0 8px; }
  table { border-collapse: collapse; width: 100%; }
  td, th { text-align: left; padding: 6px 10px; border-bottom: 1px solid #1f2430; }
  th { color: #9ca3af; font-weight: 600; }
  .ok { color: #4ade80; } .warn { color: #fbbf24; } .bad { color: #f87171; }
  code { background: #1f2430; padding: 1px 5px; border-radius: 4px; }
</style>
</head>
<body>
  <h1>NOAPI? bridge</h1>
  <div class="sub">Use AI websites in your browser as models for opencode — no API keys.</div>
  <div id="content">loading…</div>
<script>
async function render() {
  const el = document.getElementById("content");
  try {
    const r = await fetch("/health");
    const s = await r.json();
    const clientRows = s.clients.map(c =>
      \`<tr><td>\${c.id}</td><td class="\${c.site ? "ok" : "warn"}">\${c.site || "no site"}</td><td>\${c.url || ""}</td></tr>\`
    ).join("") || '<tr><td colspan="3" class="bad">no browser connected — load the NOAPI? extension and open a supported AI site</td></tr>';
    const pendingRows = s.pending.map(p =>
      \`<tr><td>\${p.id}</td><td>\${p.site || "any"}</td><td>\${p.chars}</td><td>\${Math.round(p.waitingMs / 1000)}s</td></tr>\`
    ).join("") || '<tr><td colspan="4">none</td></tr>';
    const siteRows = s.sites.map(x =>
      \`<tr><td><code>\${x.key}</code></td><td>\${x.name}</td><td class="\${x.available ? "ok" : "bad"}">\${x.available ? "available" : "not connected"}</td></tr>\`
    ).join("");
    const t = s.timings || {};
    const fmt = v => (v == null ? "" : Math.round(v) + " ms");
    const timingRows = Object.entries(t.bySite || {}).map(([site, v]) =>
      \`<tr><td>\${site}</td><td>\${v.avg.count}</td><td>\${fmt(v.last.total)}</td><td>\${fmt(v.last.composer)}</td><td>\${fmt(v.last.typed)}</td><td>\${fmt(v.last.sent)}</td><td>\${fmt(v.last.firstText)}</td><td>\${fmt(v.last.complete)}</td><td>\${fmt(v.last.postToken)}</td><td>\${v.last.replyChars ?? ""}</td><td>\${fmt(v.avg.total)}</td></tr>\`
    ).join("") || '<tr><td colspan="11">no completed requests yet</td></tr>';
    const statRows = Object.entries(s.stats || {}).map(([site, v]) =>
      \`<tr><td>\${site}</td><td>\${v.requests}</td><td>\${v.completedBySse}</td><td>\${v.completedByStop}</td><td>\${v.completedByFallback}</td><td>\${v.sseSeen}</td><td>\${v.earlyReturn}</td><td>\${v.resubmits}</td><td>\${v.aborted}</td><td>\${v.timeouts}</td><td class="\${v.lateGrowth ? "bad" : ""}">\${v.lateGrowth || 0}</td></tr>\`
    ).join("") || '<tr><td colspan="11">no requests yet</td></tr>';
    el.innerHTML = \`
      <h2>browser clients</h2>
      <table><tr><th>id</th><th>site</th><th>url</th></tr>\${clientRows}</table>
      <h2>pending requests</h2>
      <table><tr><th>id</th><th>site</th><th>chars</th><th>waiting</th></tr>\${pendingRows}</table>
      <h2>timings (last request per site, and average)</h2>
      <table><tr><th>site</th><th>n</th><th>total</th><th>composer</th><th>typed</th><th>sent</th><th>first&nbsp;text</th><th>complete</th><th>post&nbsp;tok</th><th>reply&nbsp;chars</th><th>avg&nbsp;total</th></tr>\${timingRows}</table>
      <h2>debug counters (per site, since start)</h2>
      <table><tr><th>site</th><th>requests</th><th>by sse</th><th>by stop</th><th>by fallback</th><th>sse seen</th><th>early</th><th>resubmits</th><th>aborted</th><th>timeouts</th><th>late growth</th></tr>\${statRows}</table>
      <h2>models</h2>
      <table><tr><th>id</th><th>name</th><th>status</th></tr>\${siteRows}</table>\`;
  } catch (e) {
    el.innerHTML = '<div class="bad">failed to load status</div>';
  }
}
render();
setInterval(render, 2000);
</script>
</body>
</html>`;
}

export function createHttpServer(bridge, log, { host: bindHost = "127.0.0.1" } = {}) {
  // Refusal-guard counters, per site, since start. Shown under "guard" in /health.
  const guardStats = {};
  const gstat = (site) => (guardStats[site] ||= { refusals: 0, recovered: 0, failed: 0 });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname;
    try {
      if (!requestAllowed(req, bindHost)) {
        log(`blocked request from origin "${req.headers.origin || "?"}" host "${req.headers.host || "?"}"`);
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Forbidden: this bridge only accepts local clients.", type: "forbidden" } }));
        return;
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": req.headers.origin || "null",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        });
        res.end();
        return;
      }
      if (path === "/" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(dashboardHtml());
        return;
      }
      if (path === "/health" && req.method === "GET") {
        sendJson(res, 200, { ...bridge.status(), guard: guardStats });
        return;
      }
      if (path === "/v1/models" && req.method === "GET") {
        sendJson(res, 200, {
          object: "list",
          data: SITES.map((s) => ({
            id: s.key,
            object: "model",
            created: 0,
            owned_by: "noapi-browser",
            site: s.name,
          })),
        });
        return;
      }
      if (path === "/v1/chat/completions" && req.method === "POST") {
        const raw = await readBody(req);
        let body;
        try {
          body = JSON.parse(raw || "{}");
        } catch {
          errorJson(res, 400, "Invalid JSON body.");
          return;
        }
        const model = String(body.model || "chatgpt").split("/").pop();
        if (!SITE_KEYS.includes(model)) {
          errorJson(res, 400, `Unknown model "${model}". Supported: ${SITE_KEYS.join(", ")}`);
          return;
        }
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const tools = body.tool_choice === "none" ? [] : toolList(body.tools);
        const stream = Boolean(body.stream);
        // Early return on a complete TOOL_CALL block. A content script cannot
        // read process.env, so the bridge reads the knobs here and forwards
        // them with the request. NOAPI_EARLY_RETURN=0 is the kill switch: it
        // disables both the early return and the stop click, falling back to
        // normal completion detection.
        const earlyReturn = process.env.NOAPI_EARLY_RETURN !== "0";
        const earlyReturnMs = Math.min(Math.max(Number(process.env.NOAPI_EARLY_RETURN_MS) || 400, 50), 5000);
        // Phase 3: observe the page's own SSE stream as a completion signal.
        // NOAPI_SSE=0 disables it (forwarded as sse:false).
        const sse = process.env.NOAPI_SSE !== "0";
        // Task 1: timing knobs for the content script (read here, forwarded per
        // request; a content script cannot read process.env). Task 5: optional
        // SSE-text fast path, default off.
        const tuning = tuningFromEnv();
        const sseText = sseTextFromEnv();
        const toolNames = tools.map((t) => t.name);

        // Re-send the tool protocol for new conversations or when the tool set changed.
        const hash = toolsHash(tools);
        const fresh = !messages.some((m) => m.role === "assistant");
        // Phase 5: NOAPI_NEW_CHAT=1 opens a fresh chat for a new OpenCode session
        // (no assistant message yet). Default OFF. Opening a new chat also means
        // the site forgets the tool preamble, so drop the hash (the preamble is
        // re-sent because the conversation is fresh anyway).
        const titleOnly = isTitleRequest(messages, tools);
        // Phase 2: chat rotation. Once the site's current chat has carried
        // NOAPI_ROTATE_CHARS characters (default 150000, 0 = off) in the middle
        // of agent work, open a new chat and send the protocol plus a recap built
        // from OpenCode's own message list, then carry on there.
        bridge.chatTurns ||= new Map(); // site -> turns sent to the site's CURRENT chat
        bridge.rotatePrompt ||= new Map(); // site -> size of the last rotation prompt
        const rotateAt = effectiveRotateLimit(model, rotateLimit(), bridge.rotatePrompt.get(model) || 0);
        const chatUsed = bridge.chatUsage.get(model) || 0;
        const chatTurns = bridge.chatTurns.get(model) || 0;
        let rotate = shouldRotate({ limit: rotateAt, usage: chatUsed, tools, messages, titleOnly });
        if (rotate && chatTurns < rotateMinTurns()) {
          log(`chat rotate skipped: ${model} chat has only ${chatTurns} turn(s) since it was opened (min ${rotateMinTurns()})`);
          rotate = false;
        }
        const newChat = (process.env.NOAPI_NEW_CHAT === "1" && fresh) || rotate;
        if (newChat) {
          bridge.toolHashes.delete(model);
          bridge.chatUsage.set(model, 0);
          bridge.chatTurns.set(model, 0);
        }
        const recap = rotate ? buildRecap(messages) : "";
        if (rotate) {
          log(`chat rotate: ${model} chat reached ${chatUsed} chars (limit ${rotateAt}); opening a new chat with a ${recap.length}-char recap`);
        }
        const includePreamble = tools.length > 0 && (fresh || rotate || bridge.toolHashes.get(model) !== hash);
        let { prompt, parts: promptParts } = buildPrompt(messages, tools, { includePreamble, recap, resultBudget: rotate ? rotateResultBudget() : 0 });
        if (rotate) bridge.rotatePrompt.set(model, prompt.length);
        // Task 2: dump the exact prompt (preamble + first turn) sent to the site
        // so its size and per-tool cost can be measured without a live change.
        if (process.env.NOAPI_DUMP_PREAMBLE === "1") {
          try {
            fs.writeFileSync("noapi-preamble.txt", prompt);
            log(`dumped preamble (${prompt.length} chars) to noapi-preamble.txt`);
          } catch (err) {
            log(`could not dump preamble: ${err.message}`);
          }
        }
        // Opt-in (NOAPI_SEED_TREE=1): list the working directory in the first
        // prompt so the model sees real paths instead of assuming it is blind.
        if (includePreamble && !titleOnly && seedTreeEnabled()) {
          try {
            const sysText = messages.filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
            const wd = (sysText.match(/Working directory:\s*(.+)/i) || [])[1];
            const tree = wd ? seedTree(wd.trim()) : "";
            if (tree) prompt = `${prompt}\n\n${tree}`;
          } catch (err) {
            log(`seed tree skipped: ${err.message}`);
          }
        }
        let filesChars = 0;
        // NOAPI_AUTOREAD=1 (off by default, fully inert when off): attach the
        // files named in the latest real user message only — never system or
        // earlier turns, and never again on a TOOL_RESULT continuation, since
        // the site already holds those turns. One summary line per request, plus
        // a line per real candidate that was skipped, with the reason.
        if (!titleOnly && process.env.NOAPI_AUTOREAD === "1") {
          try {
            const { block, notes, attached, chars } = autoreadReport(messages);
            if (block) {
              prompt = `${prompt}\n\n${block}`;
              filesChars = block.length;
            }
            for (const n of notes) {
              if (n.action === "skip") log(`autoread skip ${n.path}: ${n.reason}`);
            }
            log(`autoread: attached ${attached} file(s), ${chars} chars, prompt total ${prompt.length} chars`);
          } catch (err) {
            log(`autoread skipped: ${err.message}`);
          }
        }
        if (!prompt && !titleOnly) {
          errorJson(res, 400, "No user message found in request.");
          return;
        }

        // Diagnostic only, never sent anywhere: one line per request describing
        // what the prompt is made of. The pieces are the text actually sent to
        // the web AI; `other` is the remainder (separators, the AVAILABLE TOOLS
        // header's surrounding lines and the "Continue the task" hint), so the
        // parts always add up to `total`. Never logs the text itself.
        if (!titleOnly) {
          try {
            const p = promptParts;
            const total = prompt.length;
            const other = total - (p.preamble + p.tools + p.system + p.user + p.toolresults + filesChars);
            log(
              `prompt breakdown: preamble=${p.preamble} tools=${p.tools} system=${p.system} user=${p.user} files=${filesChars} toolresults=${p.toolresults} other=${other} total=${total}`
            );
          } catch (err) {
            log(`prompt breakdown skipped: ${err.message}`);
          }
        }

        // Cancel the browser request if OpenCode aborts (Esc / closed).
        const abort = new AbortController();
        res.on("close", () => {
          if (!res.writableEnded) abort.abort();
        });

        const finish = (reply) => {
          const { calls, text } = parseToolCalls(reply, tools);
          if (tools.length) bridge.toolHashes.set(model, hash);
          return { calls, text };
        };
        // Characters exchanged with the site's current chat (prompt + reply).
        const track = (sent, reply) => {
          bridge.chatUsage.set(model, (bridge.chatUsage.get(model) || 0) + String(sent || "").length + String(reply || "").length);
          bridge.chatTurns.set(model, (bridge.chatTurns.get(model) || 0) + 1);
          return reply;
        };
        const ask = (onProgress, onPartial) =>
          titleOnly
            ? Promise.resolve(localTitle(messages))
            : bridge.requestPrompt({
                prompt,
                site: model,
                onProgress,
                onPartial,
                signal: abort.signal,
                toolsEnabled: tools.length > 0,
                earlyReturn,
                earlyReturnMs,
                toolNames,
                sse,
                newChat,
                tuning,
                sseText,
              }).then((reply) => track(prompt, reply));
        // NOAPI_TOOL_REPAIR (default ON): when a reply carries a TOOL_CALL marker
        // but no valid block, send a short follow-up to the same chat and try
        // again (max 2 per user turn) instead of handing the broken block to
        // OpenCode. The follow-up is plain text: it must not repeat the preamble.
        const repairEnabled = process.env.NOAPI_TOOL_REPAIR !== "0";
        const askRepair = (repairPrompt) =>
          bridge.requestPrompt({
            prompt: repairPrompt,
            site: model,
            signal: abort.signal,
            toolsEnabled: tools.length > 0,
            earlyReturn,
            earlyReturnMs,
            toolNames,
            sse,
            newChat: false,
            tuning,
            sseText,
          }).then((reply) => track(repairPrompt, reply));
        // Save the raw reply of a failed tool call to ./noapi-debug so the real
        // text (length, where it is cut, escaping) can be inspected afterwards.
        const dumpReply = (tag, reply, issue) => {
          try {
            const dir = nodePath.join(process.cwd(), "noapi-debug");
            fs.mkdirSync(dir, { recursive: true });
            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            const file = nodePath.join(dir, `${stamp}_${tag}_${issue.reason}.txt`);
            fs.writeFileSync(file, String(reply), "utf8");
            log(`debug: saved ${String(reply).length} chars of the ${tag} reply -> ${file}`);
          } catch {}
        };
        // Refusal guard: a reply with no TOOL_CALL at all that says "I cannot
        // access your files / upload them" is off-protocol. Correct it in the
        // same chat (max GUARD_MAX times) and, if the model still refuses, fail
        // loudly instead of handing the refusal to OpenCode as a final answer.
        const guardOn = guardEnabled() && tools.length > 0 && !titleOnly;
        const delta = buildDelta(messages);
        const sysTextAll = messages.filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
        const wdHint = ((sysTextAll.match(/Working directory:\s*(.+)/i) || [])[1] || "").trim();
        const platHint = ((sysTextAll.match(/Platform:\s*(.+)/i) || [])[1] || "").trim();
        const recoverRefusal = async (first) => {
          let current = first;
          for (let attempt = 0; ; attempt++) {
            const p = parseToolCalls(current, tools);
            if (p.calls.length || p.issue) return { reply: current, refused: false };
            const det = detectRefusal(current, { strict: delta.sawTool });
            if (!det.refused) return { reply: current, refused: false };
            if (attempt === 0) gstat(model).refusals++;
            if (attempt >= GUARD_MAX) return { reply: current, refused: true, det };
            log(`refusal guard: ${model} refused the protocol (${det.reason}: "${det.match}"); correction ${attempt + 1}/${GUARD_MAX}`);
            current = await askRepair(refusalPrompt({ task: delta.sawTool ? "" : delta.text, tools, wd: wdHint, platform: platHint }));
          }
        };
        const askAndRepair = async (onProgress, onPartial) => {
          let reply = await ask(onProgress, onPartial);
          if (titleOnly) return reply;
          if (guardOn) {
            const g = await recoverRefusal(reply);
            if (g.refused) {
              gstat(model).failed++;
              dumpReply("refusal", g.reply, { reason: "refusal" });
              // The next turn must re-teach the protocol.
              bridge.toolHashes.delete(model);
              throw new Error(
                `${model} refused to use tools (it claimed it cannot access your files) even after ${GUARD_MAX} corrections. Raw reply saved in ./noapi-debug. Open a NEW chat on the site, turn off its built-in tools (code execution / uploads), then send "continue".`
              );
            }
            if (g.reply !== reply) {
              gstat(model).recovered++;
              log(`refusal guard: ${model} recovered`);
              reply = g.reply;
            }
          }
          const first = parseToolCalls(reply, tools);
          if (first.issue) dumpReply("first", reply, first.issue);
          const repaired = await repairToolCall({ reply, tools, ask: askRepair, log, enabled: repairEnabled });
          if (repaired.issue && !repaired.calls.length) {
            dumpReply("final", repaired.reply, repaired.issue);
            // Handing a broken TOOL_CALL back as plain text ends the turn in
            // OpenCode (it looks like a final answer), so the agent just stops.
            // Report an error instead. NOAPI_REPAIR_FAIL=text restores the old way.
            if (repairEnabled && process.env.NOAPI_REPAIR_FAIL !== "text") {
              throw new Error(
                `The model produced a TOOL_CALL that could not be parsed (${repaired.issue.reason}, tool=${repaired.issue.tool || "?"}) even after auto-repair. Send "continue" to retry; raw reply saved in ./noapi-debug.`
              );
            }
          }
          // Repeat guard: the very same call(s) as the previous step, right after
          // their results were delivered, means the model lost the thread (typical
          // right after a chat rotation). Ask once for the NEXT step instead.
          if (repeatGuardEnabled() && delta.sawTool && !repaired.issue && repaired.calls.length && isRepeat(repaired.calls, delta.lastCalls)) {
            gstat(model).repeats = (gstat(model).repeats || 0) + 1;
            log(`repeat guard: ${model} re-issued the previous tool call(s); asking for the next step`);
            try {
              const again = await askRepair(REPEAT_PROMPT);
              const p2 = parseToolCalls(again, tools);
              if (p2.calls.length || !p2.issue) return again;
            } catch (err) {
              log(`repeat guard: follow-up failed (${err.message}); keeping the original reply`);
            }
          }
          return repaired.reply;
        };

        if (!stream) {
          try {
            const { calls, text } = finish(await askAndRepair());
            sendJson(res, 200, completionResponse(model, text, calls));
          } catch (err) {
            log(`chat completion failed: ${err.message}`);
            errorJson(res, 503, err.message, "browser_bridge_error");
          }
          return;
        }

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const id = `chatcmpl-noapi-${Date.now().toString(36)}`;
        const created = Math.floor(Date.now() / 1000);
        const chunk = (delta, finish_reason = null, extra = {}) =>
          res.write(
            `data: ${JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta, finish_reason }],
              ...extra,
            })}\n\n`
          );
        chunk({ role: "assistant", content: "" });

        // OpenCode shows reasoning deltas as "Thinking". Stream live status
        // lines while the website works so the UI shows it is busy.
        let lastStatus = "";
        const think = (line) => {
          if (res.writableEnded || line === lastStatus) return;
          lastStatus = line;
          chunk({ reasoning_content: line + "\n" });
        };
        think("Thinking…");
        const keepalive = setInterval(() => {
          if (!res.writableEnded) res.write(": keepalive\n\n");
        }, 10_000);

        // Stream the growing reply as content deltas, but never the tool
        // protocol: StreamFilter holds back anything that could still become a
        // TOOL_CALL block (or the parser's bare-JSON fallback) and streams
        // everything else, including ordinary fenced code. NOAPI_STREAM=0
        // restores the old "emit once at the end" behaviour.
        const filter = streamEnabled() ? new StreamFilter({ tools, guard: guardOn && !delta.sawTool }) : null;
        const emit = (part) => {
          if (!part || res.writableEnded) return;
          chunk({ content: part });
        };
        const onPartial = (full) => {
          if (res.writableEnded || !filter) return;
          emit(filter.push(full));
        };

        try {
          const reply = await askAndRepair((status) => think(status), onPartial);
          if (res.writableEnded) return;
          const { calls, text } = finish(reply);
          // `text` is the cleaned reply (tool blocks removed). send only what
          // was not already streamed, so nothing is shown twice.
          emit(filter ? filter.finish(text) : text);
          if (calls.length) {
            chunk({
              tool_calls: calls.map((c, index) => ({
                index,
                id: c.id,
                type: "function",
                function: { name: c.function.name, arguments: c.function.arguments },
              })),
            });
          }
          const completion = estimateTokens(reply);
          chunk({}, calls.length ? "tool_calls" : "stop", {
            usage: {
              prompt_tokens: estimateTokens(prompt),
              completion_tokens: completion,
              total_tokens: estimateTokens(prompt) + completion,
            },
          });
          res.write("data: [DONE]\n\n");
        } catch (err) {
          log(`chat completion failed: ${err.message}`);
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ error: { message: err.message, type: "browser_bridge_error" } })}\n\n`);
            res.write("data: [DONE]\n\n");
          }
        } finally {
          clearInterval(keepalive);
          res.end();
        }
        return;
      }
      errorJson(res, 404, `Unknown route: ${req.method} ${path}`);
    } catch (err) {
      log(`http error: ${err.message}`);
      if (!res.headersSent) errorJson(res, 500, err.message);
      else res.end();
    }
  });
  return server;
}