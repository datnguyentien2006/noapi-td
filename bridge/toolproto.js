// Prompt-based tool calling for web chat UIs.
//
// Websites like ChatGPT/Claude have no OpenAI-style `tools` channel, so we
// teach the model a tiny text protocol instead:
//
//   ```
//   TOOL_CALL
//   {"name":"bash","arguments":{"command":"mkdir chatgpt-test"}}
//   ```
//
// The bridge (1) injects the tool list + protocol into the first prompt of a
// conversation, (2) renders tool results / new user messages as the next
// prompt, and (3) parses TOOL_CALL blocks out of the reply and converts them
// into real OpenAI `tool_calls` so OpenCode executes them.
import crypto from "node:crypto";
import { guardEnabled, remindEnabled, overrideLines, workedExample, REMINDER } from "./guard.js";

const DEFAULT_MAX_TOOL_RESULT = 16_000;
// Descriptions are clipped, but not uniformly: tools whose semantics are subtle
// keep a long description (so the model is not guessing at an edit/write/bash
// contract), while the rest get a short one to keep the preamble small.
const LONG_DESC = 400;
const LONG_PARAM_DESC = 400;
const SHORT_DESC = 180;
const SHORT_PARAM_DESC = 90;

// How much of a tool result is sent back to the website chat. 16k characters
// (head+tail, see clipMiddle) is enough for the model to act on while keeping
// the prompt small; override with NOAPI_MAX_TOOL_RESULT when needed.
export function maxToolResult() {
  const v = Number(process.env.NOAPI_MAX_TOOL_RESULT);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_MAX_TOOL_RESULT;
}

function envInt(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

// Description caps for a priority tool; NOAPI_DESC_MAX and
// NOAPI_PARAM_DESC_MAX override the 400-character defaults.
export function descMax() {
  return envInt("NOAPI_DESC_MAX", LONG_DESC);
}
export function paramDescMax() {
  return envInt("NOAPI_PARAM_DESC_MAX", LONG_PARAM_DESC);
}

// A tool is "priority" when its contract is easy to get wrong. That covers the
// file/command tools by name and, more robustly, any tool that takes an
// oldString/newString/replace style argument.
const PRIORITY_NAME = /(edit|write|patch|bash|read|shell|replace|apply|rename|move|create|delete|notebook)/i;
const PRIORITY_PARAM = /(oldstring|newstring|replace|old_string|new_string)/i;

export function isPriorityTool(f) {
  if (!f) return false;
  if (PRIORITY_NAME.test(String(f.name || ""))) return true;
  const props = f.parameters?.properties || {};
  return Object.keys(props).some((k) => PRIORITY_PARAM.test(k));
}

function descLimit(f) {
  return !leanDescMode() && isPriorityTool(f) ? descMax() : SHORT_DESC;
}
function paramDescLimit(f) {
  return !leanDescMode() && isPriorityTool(f) ? paramDescMax() : SHORT_PARAM_DESC;
}

// Task 2: optional lower-cost description mode (default OFF). "lean" gives even
// the priority tools the short caps, shrinking the preamble for the same tool
// set. Tool semantics are unchanged; only description verbosity drops.
export function descMode() {
  return String(process.env.NOAPI_DESC_MODE || "full").toLowerCase();
}
function leanDescMode() {
  return descMode() === "lean";
}

// Task 2: tools left out of the preamble (default OFF). They are still fully
// callable: parseToolCalls/normalizeCall validate against the request's tool
// list, not the rendered preamble.
export function toolDenyList() {
  return String(process.env.NOAPI_TOOL_DENY || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function msgText(m) {
  const c = m?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : p?.text || "")).join("");
  return "";
}

function clip(s, n) {
  s = String(s || "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "..." : s;
}

function clipMiddle(s, n) {
  s = String(s || "");
  if (s.length <= n) return s;
  const half = Math.floor(n / 2);
  const cut = s.length - n;
  return `${s.slice(0, half)}\n[... ${cut} chars truncated; re-run the tool with a narrower range (offset/limit, grep, or head/tail) to see the missing part ...]\n${s.slice(-half)}`;
}

// Task 3: cheap, lossless cleanup applied to a tool result before clipping.
// Strips ANSI escape sequences (colour codes a command emitted), normalises line
// endings, trims trailing whitespace per line and collapses runs of blank lines.
// None of this removes information the model needs, so it is always on and saves
// prompt characters for free.
export function tidyToolResult(s) {
  return String(s ?? "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "") // OSC sequences
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI sequences (colours, cursor)
    .replace(/\u001b[@-Z\\-_]/g, "") // other single-char escapes
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function describeType(schema, depth = 0) {
  if (!schema || typeof schema !== "object") return "any";
  if (Array.isArray(schema.enum)) return schema.enum.map((v) => JSON.stringify(v)).join("|");
  let t = schema.type;
  if (Array.isArray(t)) t = t.filter((x) => x !== "null").join("|") || "any";
  if (t === "array") return `array<${describeType(schema.items, depth + 1)}>`;
  if (t === "object" || schema.properties) {
    if (depth >= 2 || !schema.properties) return "object";
    const req = new Set(schema.required || []);
    const inner = Object.entries(schema.properties)
      .map(([k, v]) => `${k}${req.has(k) ? "" : "?"}: ${describeType(v, depth + 1)}`)
      .join(", ");
    return `{${inner}}`;
  }
  return t || "any";
}

export function toolList(tools) {
  return (tools || [])
    .map((t) => (t?.type === "function" || t?.function ? t.function : t))
    .filter((f) => f && typeof f.name === "string");
}

// A stable fingerprint of the tool set the website has already been taught.
// Descriptions are deliberately excluded (and keys sorted): rewording a
// description must not force the whole preamble to be re-sent, while adding,
// removing or changing a tool's parameters still does.
function schemaShape(v) {
  if (Array.isArray(v)) return v.map(schemaShape);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (k === "description") continue;
      out[k] = schemaShape(v[k]);
    }
    return out;
  }
  return v;
}

export function toolsHash(tools) {
  const fns = toolList(tools).map((f) => [f.name, schemaShape(f.parameters)]);
  return crypto.createHash("sha1").update(JSON.stringify(fns)).digest("hex").slice(0, 12);
}

function renderTool(f) {
  const props = f.parameters?.properties || {};
  const req = new Set(f.parameters?.required || []);
  const cap = paramDescLimit(f);
  const params = Object.entries(props)
    .map(([k, v]) => {
      const d = v?.description ? ` - ${clip(v.description, cap)}` : "";
      return `    - ${k}${req.has(k) ? " (required)" : " (optional)"}: ${describeType(v)}${d}`;
    })
    .join("\n");
  return `* ${f.name}: ${clip(f.description, descLimit(f))}\n${params || "    (no parameters)"}`;
}

// A minimal but real call for the format example: only required arguments,
// with a placeholder value of the right JSON type.
function exampleArgs(f) {
  const props = f.parameters?.properties || {};
  const req = f.parameters?.required || [];
  const out = {};
  for (const k of req.slice(0, 3)) {
    const t = props[k]?.type;
    if (t === "number" || t === "integer") out[k] = 0;
    else if (t === "boolean") out[k] = false;
    else if (t === "array") out[k] = [];
    else if (t === "object") out[k] = {};
    else out[k] = `<${k}>`;
  }
  return out;
}

// Phase 1: a call whose big text argument travels in a RAW BLOCK instead of
// being escaped inside the JSON. Prefers a `write`-like tool.
const RAW_ARG_HINT = ["content", "contents", "text", "newString", "new_string", "command", "code"];
function rawExample(fns) {
  const ordered = [...fns].sort((a, b) => Number(/^write$/i.test(b.name)) - Number(/^write$/i.test(a.name)));
  for (const f of ordered) {
    const props = f.parameters?.properties || {};
    const req = f.parameters?.required || [];
    const key = RAW_ARG_HINT.find((k) => props[k] && props[k].type === "string" && req.includes(k));
    if (!key) continue;
    const args = {};
    for (const k of req.filter((x) => x !== key).slice(0, 2)) args[k] = `<${k}>`;
    const block =
      "```\nTOOL_CALL\n" +
      JSON.stringify({ name: f.name, arguments: args }) +
      `\n<<<${key}\n<the text exactly as it must appear>\n${key}>>>\n` +
      "```";
    return { tool: f.name, key, block };
  }
  return null;
}

function exampleBlock(f) {
  return "```\nTOOL_CALL\n" + JSON.stringify({ name: f.name, arguments: exampleArgs(f) }) + "\n```";
}

function envHints(messages) {
  const sys = (messages || []).filter((m) => m.role === "system").map(msgText).join("\n");
  const out = [];
  const wd = sys.match(/Working directory:\s*(.+)/i);
  const plat = sys.match(/Platform:\s*(.+)/i);
  if (wd) out.push(`Working directory: ${wd[1].trim()}`);
  if (plat) out.push(`Platform: ${plat[1].trim()}`);
  return out;
}

// Terse mode (Phase 4) asks the model for shorter output: no prose between tool
// calls and concise final answers. It is most of the remaining wall-clock time
// on a real site, because the answer is generated token by token. NOAPI_TERSE=0
// restores the original wording; the tool semantics are identical either way.
export function terseEnabled() {
  return process.env.NOAPI_TERSE !== "0";
}

export function renderPreambleParts(tools, messages, { terse = terseEnabled(), deny = toolDenyList() } = {}) {
  const denied = new Set(deny || []);
  const fns = toolList(tools).filter((f) => !denied.has(f.name));
  const hints = envHints(messages);
  const examples = fns.slice(0, 3).map(exampleBlock);
  const rules = [
    "1. Batch every independent call into the same reply: several TOOL_CALL blocks back to back, with no text between them.",
    "2. Prefer grep/glob to locate things and read only the files you need, instead of reading files one by one across many turns.",
    "3. Use only the tools listed below and give every required argument.",
    "4. After the TOOL_CALL block(s) STOP writing. Do not guess the result. The agent runs the tools and replies with TOOL_RESULT messages.",
    "5. When the task is finished, or no tool is needed, answer normally in plain text WITHOUT any TOOL_CALL block.",
    "6. Keep text outside TOOL_CALL blocks short. Do not narrate between tool calls and do not repeat these instructions.",
  ];
  if (terse) {
    rules.push(
      "7. Between and around TOOL_CALL blocks output NOTHING but the blocks themselves - no prose, no headings, no commentary before or after them.",
      "8. Keep the final answer terse: state the result and stop. No preamble, no restating the request, no offers of further help."
    );
  }
  // Phase 1: raw blocks for large text, small calls, edit instead of rewrite.
  const hasEdit = fns.some((f) => /^(edit|patch|replace)/i.test(f.name));
  const rawEx = rawExample(fns);
  const addRule = (t) => rules.push(`${rules.length + 1}. ${t}`);
  if (rawEx) {
    addRule("Never put multi-line text (file content, edit text, a long command) inside the JSON. Use a RAW BLOCK right after the JSON line, as shown under LARGE TEXT.");
    addRule(
      hasEdit
        ? "Keep every call small: at most about 150 lines of raw text. For a bigger file, write the first part ending with a line like '# CONTINUE HERE', then add each next part with a separate edit call that replaces that marker line with the next part plus the marker."
        : "Keep every call small: at most about 150 lines of raw text. For a bigger file, split it into several smaller files or several calls."
    );
  }
  if (hasEdit) {
    addRule("To change an existing file use the edit tool with a small, unique old text and the new text. Do not rewrite a whole existing file with write.");
  }
  if (hints.some((h) => /^Platform:.*win/i.test(h))) {
    addRule("The platform is Windows: inside the JSON write paths with forward slashes (C:/dir/file.py) or doubled backslashes (C:\\\\dir\\\\file.py), never single backslashes.");
  }
  const beforeTools = [
    "You are being used as the brain of OpenCode, a coding agent that runs on the user's computer.",
    "You cannot run anything yourself in this chat, BUT the agent can run tools for you: when you need to act (create files or folders, run commands, read or edit files, search...), request a tool call using the exact format below. Never say that you are unable to access the computer or the file system - request the tool instead.",
    "",
    ...(guardEnabled() ? overrideLines() : []),
    "FORMAT - to call a tool, output a fenced code block whose first line is TOOL_CALL, followed by one JSON object:",
    "```",
    "TOOL_CALL",
    '{"name": "<tool name>", "arguments": {<arguments as JSON>}}',
    "```",
    "",
    "EXAMPLE - independent calls belong in ONE reply. Here are " +
      (examples.length > 1 ? `${examples.length} calls batched together:` : "one call:"),
    ...examples,
    "",
    ...(guardEnabled()
      ? workedExample(
          fns.map((f) => f.name),
          (hints.find((h) => /^Working directory:/i.test(h)) || "").replace(/^Working directory:\s*/i, ""),
          (hints.find((h) => /^Platform:/i.test(h)) || "").replace(/^Platform:\s*/i, "")
        )
      : []),
    ...(rawEx
      ? [
          "LARGE TEXT - the JSON line carries only short arguments. Any argument that holds multi-line text goes in a RAW BLOCK straight after the JSON: a line `<<<argname`, the text exactly as it must appear (no escaping, no JSON quotes), then a line `argname>>>`. Example:",
          rawEx.block,
          "If the raw text itself contains three backticks, wrap the whole call in a fence of four backticks instead.",
          "",
        ]
      : []),
    "RULES:",
    ...rules,
    ...(hints.length ? ["", ...hints] : []),
    "",
  ];
  const toolLines = ["AVAILABLE TOOLS:", ...fns.map(renderTool)];
  const afterTools = ["", "---"];
  return {
    preamble: [...beforeTools, ...toolLines, ...afterTools].join("\n"),
    // The AVAILABLE TOOLS section is a contiguous slice of the preamble, so the
    // fixed instruction text is exactly the remainder.
    tools: toolLines.join("\n"),
  };
}

export function renderPreamble(tools, messages, opts = {}) {
  return renderPreambleParts(tools, messages, opts).preamble;
}

// Everything the website has not seen yet: messages after the last assistant
// turn (user text and tool results), rendered as plain text.
export function buildDelta(messages, { resultBudget = 0 } = {}) {
  const msgs = (messages || []).filter((m) => m.role !== "system");
  let lastAssistant = -1;
  msgs.forEach((m, i) => {
    if (m.role === "assistant") lastAssistant = i;
  });
  const fresh = msgs.slice(lastAssistant + 1);
  // A rotation prompt may cap the total size of the pending tool results.
  const toolCount = fresh.filter((m) => m.role === "tool").length;
  const perResult =
    resultBudget > 0 && toolCount ? Math.min(maxToolResult(), Math.max(1500, Math.floor(resultBudget / toolCount))) : maxToolResult();

  const callNames = new Map();
  for (const m of msgs) {
    for (const tc of m.tool_calls || []) callNames.set(tc.id, tc.function?.name || "tool");
  }

  const parts = [];
  let sawUser = false;
  let sawTool = false;
  let userChars = 0;
  let toolChars = 0;
  for (const m of fresh) {
    if (m.role === "user") {
      const t = msgText(m).trim();
      if (t) {
        parts.push(t);
        userChars += t.length;
        sawUser = true;
      }
    } else if (m.role === "tool") {
      sawTool = true;
      const name = callNames.get(m.tool_call_id) || m.name || "tool";
      const block = `TOOL_RESULT ${name} (id ${m.tool_call_id})\n${clipMiddle(tidyToolResult(msgText(m).trim() || "(empty output)"), perResult)}\nEND_TOOL_RESULT`;
      parts.push(block);
      toolChars += block.length;
    }
  }
  return {
    text: parts.join("\n\n"),
    isNew: lastAssistant === -1,
    sawTool,
    sawUser,
    userChars,
    toolChars,
    // The tool calls the agent ran after the model's last turn: their results
    // are in `text`. Needed to tell a brand-new chat what the results answer.
    lastCalls: lastAssistant >= 0 ? msgs[lastAssistant].tool_calls || [] : [],
  };
}

export function buildPrompt(messages, tools, { includePreamble, recap = "", resultBudget = 0 }) {
  const d = buildDelta(messages, { resultBudget });
  const hasTools = toolList(tools).length > 0;
  let text = d.text;
  if (hasTools && d.sawTool) {
    text +=
      "\n\nContinue the task. If you need more tools, output TOOL_CALL block(s) and stop; if the task is finished, give the final answer in plain text.";
  } else if (hasTools && d.sawUser && text && remindEnabled()) {
    // A real user turn (no tool result): remind the model of the protocol even
    // when the preamble is not re-sent, e.g. after the user opened a new chat.
    text += `\n\n${REMINDER}`;
  }
  // Phase 2: a brand-new chat continuing earlier work gets a recap (see
  // recap.js) between the protocol and the newest input.
  if (recap && d.sawTool && d.lastCalls.length) {
    const lines = d.lastCalls.map((tc) => `- ${tc.function?.name || "tool"} ${clip(String(tc.function?.arguments || ""), 300)}`);
    text = `YOUR PREVIOUS TOOL CALLS (already executed; their results are below - do NOT run them again, continue with the next step):\n${lines.join("\n")}\n\n${text}`;
  }
  if (recap) text = `${recap}\n\n---\nNEW INPUT FOR YOU NOW:\n${text}`;
  let preambleChars = 0;
  let toolListChars = 0;
  if (hasTools && includePreamble) {
    const pre = renderPreambleParts(tools, messages);
    preambleChars = pre.preamble.length - pre.tools.length;
    toolListChars = pre.tools.length;
    text = `${pre.preamble}\n\n${text}`;
  }
  return {
    prompt: text,
    isNew: d.isNew,
    parts: {
      // Character counts of the pieces that make up the prompt. `system` is 0
      // because system/developer text is never forwarded verbatim; only the
      // Working directory/Platform hints derived from it appear, inside the
      // preamble. The caller adds `files` (autoread) and derives `other`.
      preamble: preambleChars,
      tools: toolListChars,
      system: 0,
      user: d.userChars,
      toolresults: d.toolChars,
    },
  };
}

// Character breakdown of a prompt plus the autoread block appended after it.
// Pure, used by the diagnostics log and by the unit tests; never logs text.
export function promptBreakdown(messages, tools, { includePreamble = false, filesChars = 0 } = {}) {
  const { prompt, parts } = buildPrompt(messages, tools, { includePreamble });
  const total = prompt.length + (filesChars > 0 ? 2 + filesChars : 0);
  const sum = parts.preamble + parts.tools + parts.system + parts.user + parts.toolresults + filesChars;
  return {
    preamble: parts.preamble,
    tools: parts.tools,
    system: parts.system,
    user: parts.user,
    files: filesChars,
    toolresults: parts.toolresults,
    other: total - sum,
    total,
  };
}

// ---------------------------------------------------------------- parsing

function extractJsonObject(text, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
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
      if (depth === 0) return { raw: text.slice(start, i + 1), end: i + 1 };
    }
  }
  return null;
}

// Phase 1: RAW BLOCKS. After the JSON of a TOOL_CALL the model may add
//   <<<argname
//   text exactly as it must appear (no escaping)
//   argname>>>
// Each block becomes the string argument `argname`. Returns the blocks found,
// where they end, and `incomplete` (the block name) when a block never closed.
function readRawBlocks(text, from) {
  const blocks = {};
  let count = 0;
  let pos = from;
  for (;;) {
    const rest = text.slice(pos);
    const m = /^\s*<<<([A-Za-z_][\w-]*)[ \t]*\r?\n/.exec(rest);
    if (!m) break;
    const name = m[1];
    const bodyStart = m[0].length;
    const closeRe = new RegExp("^[ \\t]*" + name + ">>>[ \\t]*$", "gm");
    closeRe.lastIndex = bodyStart;
    const c = closeRe.exec(rest);
    if (!c) return { blocks, count, end: pos, incomplete: name };
    blocks[name] = rest.slice(bodyStart, c.index).replace(/\r?\n$/, "");
    count += 1;
    pos += c.index + c[0].length;
  }
  return { blocks, count, end: pos, incomplete: null };
}

// Folds raw blocks into the call's arguments. Returns the offending block name
// when it is not a string argument of the tool, otherwise null.
function mergeRawBlocks(obj, blocks, specs) {
  const rawName = obj.name || obj.tool || obj.tool_name || obj.function?.name;
  const spec = typeof rawName === "string" ? specs.get(rawName.toLowerCase()) : null;
  const ARG_KEYS = ["arguments", "parameters", "args", "input"];
  const key = ARG_KEYS.find((k) => obj[k] !== undefined && obj[k] !== null);
  let args;
  if (key) {
    if (typeof obj[key] === "string") obj[key] = tryParse(obj[key]);
    args = obj[key];
    if (!args || typeof args !== "object" || Array.isArray(args)) return "arguments";
  } else {
    args = {};
    for (const k of Object.keys(obj)) {
      if (NAME_KEYS.has(k) || k === "function") continue;
      args[k] = obj[k];
      delete obj[k];
    }
    obj.arguments = args;
  }
  for (const [k, v] of Object.entries(blocks)) {
    if (spec?.props && !spec.props.has(k)) return k;
    const t = spec?.def?.parameters?.properties?.[k]?.type;
    if (t && !(t === "string" || (Array.isArray(t) && t.includes("string")))) return k;
    args[k] = v;
  }
  return null;
}

// A complete reply ends with the closing code fence; one that stops anywhere
// else was most likely cut off.
function endsWithFence(text) {
  return /`{3,}\s*$/.test(String(text || ""));
}

// Repairs the two most common defects of long JSON strings written by a model:
// raw control characters (a real newline/tab inside a string) and invalid
// escapes such as \s \w \. (typical in regexes inside a file being written).
// Only text INSIDE strings is touched; the structure is left alone.
function lenientJsonFix(raw) {
  let out = "";
  let inStr = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (!inStr) {
      out += ch;
      if (ch === '"') inStr = true;
      continue;
    }
    if (ch === "\\") {
      const n = raw[i + 1];
      if (n !== undefined && '"\\/bfnrt'.includes(n)) {
        out += ch + n;
        i++;
      } else if (n === "u" && /^[0-9a-fA-F]{4}$/.test(raw.slice(i + 2, i + 6))) {
        out += raw.slice(i, i + 6);
        i += 5;
      } else {
        out += "\\\\"; // invalid escape: keep the backslash literally
      }
      continue;
    }
    if (ch === '"') {
      out += ch;
      inStr = false;
    } else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch < " ") out += "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0");
    else out += ch;
  }
  return out;
}

function tryParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {}
  try {
    // tolerate smart quotes and trailing commas
    const fixed = raw.replace(/[“”]/g, '"').replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(fixed);
  } catch {}
  try {
    // tolerate raw newlines/tabs and invalid escapes inside strings
    return JSON.parse(lenientJsonFix(raw));
  } catch {}
  return null;
}

// Object keys that name the tool rather than carry arguments. A flattened call
// puts the arguments next to the name, so these are not arguments themselves.
const NAME_KEYS = new Set(["name", "tool", "tool_name"]);

// Per-tool schema the lenient parser validates against: the set of accepted
// parameter names, or null when the tool declares no object schema.
function toolSpecs(tools) {
  const specs = new Map();
  for (const f of toolList(tools)) {
    const props = f.parameters?.properties;
    specs.set(f.name.toLowerCase(), {
      name: f.name,
      props: props && typeof props === "object" ? new Set(Object.keys(props)) : null,
      def: f,
    });
  }
  return specs;
}

function findTool(tools, name) {
  if (typeof name !== "string") return null;
  const want = name.toLowerCase();
  return toolList(tools).find((f) => f.name.toLowerCase() === want) || null;
}

// A Windows path typed with single backslashes inside JSON ("C:\test\new.py")
// parses WITHOUT error: \t becomes a TAB and \n a newline, so the tool silently
// gets a different file name. No real path holds those control characters, so
// for path-like arguments turn them back into backslash + letter.
function fixPathArgs(args) {
  if (!args || typeof args !== "object") return;
  for (const [k, v] of Object.entries(args)) {
    if (typeof v !== "string" || !/path|file|dir|cwd/i.test(k)) continue;
    if (!/[\t\n\r\f\x08]/.test(v)) continue;
    args[k] = v
      .replace(/\t/g, "\\t")
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n")
      .replace(/\f/g, "\\f")
      .replace(/\x08/g, "\\b");
  }
}

function normalizeCall(obj, specs) {
  if (!obj || typeof obj !== "object") return null;
  const rawName = obj.name || obj.tool || obj.tool_name || obj.function?.name;
  if (typeof rawName !== "string") return null;
  const spec = specs.get(rawName.toLowerCase());
  if (!spec) return null;

  const explicit = [obj.arguments, obj.parameters, obj.args, obj.input, obj.function?.arguments].find(
    (v) => v !== undefined && v !== null
  );
  let args;
  if (explicit !== undefined) {
    if (typeof explicit === "string") {
      // An arguments string that will not parse is broken JSON, not an empty
      // call: never guess (STEP 2b).
      const parsed = tryParse(explicit);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      args = parsed;
    } else if (typeof explicit === "object" && !Array.isArray(explicit)) {
      args = explicit;
    } else {
      return null;
    }
  } else {
    // No "arguments". Accept a flattened call ONLY when every extra key is a
    // parameter of this tool's schema; otherwise do not guess.
    const extra = Object.keys(obj).filter((k) => !NAME_KEYS.has(k) && k !== "function");
    if (!extra.length) {
      args = {};
    } else if (spec.props && extra.every((k) => spec.props.has(k))) {
      args = {};
      for (const k of extra) args[k] = obj[k];
    } else {
      return null;
    }
  }
  fixPathArgs(args);
  return {
    id: `call_${crypto.randomBytes(8).toString("hex")}`,
    type: "function",
    function: { name: spec.name, arguments: JSON.stringify(args) },
  };
}

// Returns { calls: [...openai tool_calls], text: reply without the call blocks,
// issue: null | { reason, tool } }. `issue` is set only when the reply contains
// a TOOL_CALL marker that produced no valid block, and drives auto-repair.
export function parseToolCalls(reply, tools) {
  const specs = toolSpecs(tools);
  const text = String(reply || "");
  if (!specs.size) return { calls: [], text: text.trim(), issue: null };

  const spans = [];
  const calls = [];
  let issue = null;
  let stopScan = false; // an unterminated block swallows the rest of the reply
  const noteIssue = (reason, tool) => {
    if (!issue) issue = { reason, tool: typeof tool === "string" ? tool : null };
  };
  // Best-effort tool name for a block, even when its JSON does not parse.
  const nameNear = (s) => {
    const m = /"(?:name|tool|tool_name)"\s*:\s*"([^"\\]+)"/.exec(String(s));
    return m ? m[1] : null;
  };

  const tryAt = (markerStart, searchFrom) => {
    const brace = text.indexOf("{", searchFrom);
    if (brace === -1 || brace - searchFrom > 80) {
      noteIssue("no-json", null);
      return;
    }
    const ext = extractJsonObject(text, brace);
    if (!ext) {
      noteIssue(endsWithFence(text) ? "invalid-json" : "truncated", nameNear(text.slice(markerStart)));
      stopScan = true;
      return;
    }
    const obj = tryParse(ext.raw);
    if (!obj || typeof obj !== "object") {
      noteIssue("invalid-json", nameNear(ext.raw));
      return;
    }
    const rawBlocks = readRawBlocks(text, ext.end);
    if (rawBlocks.incomplete) {
      noteIssue(endsWithFence(text) ? "bad-block" : "truncated", nameNear(ext.raw));
      stopScan = true; // whatever follows is raw text, never another call
      return;
    }
    if (rawBlocks.count && mergeRawBlocks(obj, rawBlocks.blocks, specs)) {
      noteIssue("bad-block", nameNear(ext.raw));
      return;
    }
    const rawName = obj.name || obj.tool || obj.tool_name || obj.function?.name;
    const call = normalizeCall(obj, specs);
    if (!call) {
      if (typeof rawName !== "string") noteIssue("no-name", null);
      else if (specs.has(rawName.toLowerCase())) noteIssue("no-arguments", rawName);
      else noteIssue("unknown-tool", rawName);
      return;
    }
    calls.push(call);
    spans.push([markerStart, rawBlocks.end]);
  };

  // 1) explicit sentinel
  const re = /TOOL_CALL\b/g;
  let m;
  while ((m = re.exec(text))) {
    if (stopScan) break;
    if (spans.some(([a, b]) => m.index >= a && m.index < b)) continue;
    // A call starts a line (optionally right after its opening fence). The word in
    // the middle of a sentence ("I fixed the TOOL_CALL parser") is prose, not a
    // broken call: it must not start the repair loop or fail the turn.
    const lineStart = text.lastIndexOf("\n", m.index - 1) + 1;
    if (!/^[ \t]*(?:`{3,}[\w-]*[ \t]*)?$/.test(text.slice(lineStart, m.index))) continue;
    tryAt(m.index, m.index + m[0].length);
  }

  // 2) fallback: a bare JSON object with a known tool name
  if (!calls.length && !stopScan) {
    const reObj = /\{\s*"(?:name|tool)"\s*:\s*"/g;
    while ((m = reObj.exec(text))) {
      if (spans.some(([a, b]) => m.index >= a && m.index < b)) continue;
      const ext = extractJsonObject(text, m.index);
      if (!ext) continue;
      // A JSON object followed by a raw block belongs to a TOOL_CALL whose text
      // arguments would be lost here; never turn it into a call without them.
      if (/^\s*<<<[A-Za-z_]/.test(text.slice(ext.end, ext.end + 80))) continue;
      const call = normalizeCall(tryParse(ext.raw), specs);
      if (!call) continue;
      calls.push(call);
      spans.push([m.index, ext.end]);
    }
  }

  if (!calls.length) return { calls: [], text: text.trim(), issue };

  spans.sort((a, b) => a[0] - b[0]);
  let out = "";
  let cursor = 0;
  for (const [a, b] of spans) {
    out += text.slice(cursor, a).replace(/`{3,}[\w-]*[ \t]*\n?[ \t]*$/, "");
    cursor = b;
    const rest = text.slice(cursor);
    const fence = rest.match(/^[ \t]*\n?[ \t]*`{3,}/);
    if (fence) cursor += fence[0].length;
  }
  out += text.slice(cursor);
  out = out.replace(/`{3,}[\w-]*\s*`{3,}/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return { calls, text: out, issue: null };
}

// ------------------------------------------------------- auto-correction

export const TOOL_REPAIR_MAX = 2;
// Extra budget used only when a reply was cut off in the middle of a call: ask
// the site to continue and stitch the pieces together (NOAPI_CONTINUE=0 turns
// it off). A reply that is already this long is not continued but re-asked.
export const TOOL_CONTINUE_MAX = 3;
const CONTINUE_LIMIT = 30_000;

export function continueEnabled() {
  return process.env.NOAPI_CONTINUE !== "0";
}

const REPAIR_PROBLEM = {
  "invalid-json": "the JSON in your TOOL_CALL block could not be parsed as valid JSON (every quote, backslash and newline inside a JSON string must be escaped; better: keep the JSON short and put any multi-line text in a RAW BLOCK <<<argname ... argname>>> after it)",
  "truncated": "your reply was cut off before the TOOL_CALL block was complete. Resend it as a COMPLETE and much shorter call: at most about 150 lines of raw text per call; for a bigger file write the first part now and add the rest with later calls",
  "bad-block": "a RAW BLOCK was not valid: it must start with <<<argname on its own line, end with argname>>> on its own line, and argname must be a text argument of that tool",
  "no-json": "there was no JSON object after the TOOL_CALL marker",
  "no-arguments": "the arguments must be inside an \"arguments\" object, not spread next to the tool name",
  "unknown-tool": "the tool name in the block is not a tool that is available here",
  "no-name": "the block has no tool name",
};

// One short follow-up: the problem in a sentence, one correct one-line example
// for the tool, and a request to resend only the corrected block. No preamble.
export function toolRepairPrompt({ reason, tool, toolDef } = {}) {
  const problem = REPAIR_PROBLEM[reason] || "the TOOL_CALL block was not in the expected format";
  const def = toolDef ? toolList([toolDef])[0] : null;
  const exampleObj = def
    ? { name: def.name, arguments: exampleArgs(def) }
    : { name: tool || "<tool name>", arguments: {} };
  return [
    `Your last reply contained a TOOL_CALL block that could not be used: ${problem}.`,
    `A correct call looks like this: TOOL_CALL ${JSON.stringify(exampleObj)}`,
    "Please resend only the corrected block.",
  ].join("\n");
}

export function toolContinuePrompt() {
  return [
    "Your last reply was cut off before the TOOL_CALL block was complete.",
    "Continue EXACTLY where it stopped: output only the missing remainder, starting right after the last character you wrote.",
    "Do not repeat anything and do not start a new TOOL_CALL or a new code fence. Finish the raw block (argname>>>) and close the code fence.",
  ].join("\n");
}

// Joins a cut-off reply and its continuation. A continuation that restarts the
// call from TOOL_CALL replaces the old reply; otherwise a new opening fence is
// dropped and any text the model repeated from the end of the old reply (up to
// 400 chars) is trimmed.
export function stitchReplies(prev, cont) {
  prev = String(prev || "");
  let c = String(cont || "");
  if (/^\s*(?:`{3,}[\w-]*[ \t]*\r?\n\s*)?TOOL_CALL\b/.test(c)) return c;
  c = c.replace(/^\s*`{3,}[\w-]*[ \t]*\r?\n/, "");
  const max = Math.min(400, prev.length, c.length);
  for (let k = max; k >= 24; k--) {
    if (prev.endsWith(c.slice(0, k))) {
      c = c.slice(k);
      break;
    }
  }
  return prev + c;
}

// Auto-correction round trip. `ask(prompt, attempt)` sends a short follow-up to
// the same chat and returns the next raw reply. At most `maxRepairs` correction
// prompts per user turn, plus up to `maxContinues` continuations when the reply
// was cut off; if the reply is still unusable the last parse is returned as-is
// so the caller can decide. `enabled=false` is a no-op.
export async function repairToolCall({
  reply,
  tools,
  ask,
  log = () => {},
  enabled = true,
  maxRepairs = TOOL_REPAIR_MAX,
  maxContinues = TOOL_CONTINUE_MAX,
} = {}) {
  let parsed = parseToolCalls(reply, tools);
  let lastReply = reply;
  let attempt = 0;
  let continues = 0;
  while (enabled && !parsed.calls.length && parsed.issue) {
    const { reason, tool } = parsed.issue;
    const canContinue =
      reason === "truncated" && continueEnabled() && continues < maxContinues && String(lastReply).length < CONTINUE_LIMIT;
    if (!canContinue && attempt >= maxRepairs) break;
    const prevReply = lastReply;
    try {
      if (canContinue) {
        continues += 1;
        log(`tool repair: continue ${continues}/${maxContinues} reason=truncated tool=${tool || "?"} (${String(lastReply).length} chars so far)`);
        const cont = await ask(toolContinuePrompt(), continues);
        if (cont === prevReply) {
          log(`tool repair: continue ${continues} returned the SAME reply as before (stale read, the model was not asked again)`);
        } else {
          lastReply = stitchReplies(prevReply, cont);
        }
      } else {
        attempt += 1;
        log(`tool repair: attempt ${attempt}/${maxRepairs} reason=${reason} tool=${tool || "?"}`);
        lastReply = await ask(toolRepairPrompt({ reason, tool, toolDef: findTool(tools, tool) }), attempt);
        if (lastReply === prevReply) {
          log(`tool repair: attempt ${attempt} returned the SAME reply as before (stale read, the model was not asked again)`);
        }
      }
    } catch (err) {
      log(`tool repair: failed after ${attempt}/${maxRepairs} reason=${reason} tool=${tool || "?"}`);
      return { ...parsed, reply: lastReply };
    }
    parsed = parseToolCalls(lastReply, tools);
  }
  if (enabled && parsed.issue && !parsed.calls.length && (attempt > 0 || continues > 0)) {
    log(`tool repair: failed after ${attempt}/${maxRepairs} reason=${parsed.issue.reason} tool=${parsed.issue.tool || "?"}`);
  }
  return { ...parsed, reply: lastReply };
}

// OpenCode asks the model for a session title with a tiny tool-less request.
// Typing that into the user's real chat would pollute it, so answer locally.
export function isTitleRequest(messages, tools) {
  if (toolList(tools).length) return false;
  const sys = (messages || []).filter((m) => m.role === "system").map(msgText).join("\n");
  return /title generator|generate a (short |brief )?title|thread title|conversation title/i.test(sys);
}

export function localTitle(messages) {
  const users = (messages || []).filter((m) => m.role === "user");
  const t = msgText(users[0]).replace(/\s+/g, " ").trim();
  return clip(t, 50) || "New session";
}