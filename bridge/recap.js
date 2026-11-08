// Phase 2: chat rotation helpers (pure functions, no I/O).
//
// A website chat gets slower and less reliable as it grows, and a big project
// does not fit in one. The bridge counts the characters exchanged with each
// site's current chat; once a limit is passed it opens a NEW chat and sends the
// tool protocol plus a compact recap instead of the whole history. OpenCode
// sends the full message list with every request, so the recap is built
// directly from it (no model call needed, nothing to go wrong).

export const DEFAULT_ROTATE_CHARS = 150_000;
export const DEFAULT_RECAP_CHARS = 14_000;

// NOAPI_ROTATE_CHARS: chat size (chars sent + received) that triggers a new
// chat. Unset = 150000. 0 turns rotation off.
export function rotateLimit() {
  const raw = process.env.NOAPI_ROTATE_CHARS;
  if (raw === undefined || raw === "") return DEFAULT_ROTATE_CHARS;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : DEFAULT_ROTATE_CHARS;
}

// Rotate only in the middle of real agent work: tools on, not the tiny title
// request, and the conversation already has assistant turns (otherwise it is a
// new session and starts a fresh preamble anyway).
export function shouldRotate({ limit, usage, tools, messages, titleOnly = false } = {}) {
  if (!(limit > 0) || !(usage >= limit) || titleOnly) return false;
  if (!Array.isArray(tools) || !tools.length) return false;
  return (messages || []).some((m) => m && m.role === "assistant");
}

function msgText(m) {
  const c = m?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : p?.text || "")).join("");
  return "";
}

function oneLine(s, n) {
  s = String(s ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, Math.max(0, n - 3)) + "..." : s;
}

function clipBlock(s, n) {
  s = String(s ?? "").trim();
  return s.length > n ? s.slice(0, n) + `\n[... ${s.length - n} more chars omitted ...]` : s;
}

function parseArgs(tc) {
  try {
    const a = JSON.parse(tc?.function?.arguments || "{}");
    return a && typeof a === "object" && !Array.isArray(a) ? a : {};
  } catch {
    return {};
  }
}

// Short, readable summary of a call's arguments. Long text (file contents,
// edits) is shown as a length only, never copied into the recap.
function argSummary(args) {
  const parts = [];
  for (const [k, v] of Object.entries(args || {})) {
    let s;
    if (typeof v === "string") {
      if (v.length <= 80 && !/[\r\n]/.test(v)) s = `"${v}"`;
      else if (k === "command") s = `"${oneLine(v, 70)}" (${v.length} chars)`;
      else s = `<${v.length} chars>`;
    } else {
      s = oneLine(JSON.stringify(v), 40);
    }
    parts.push(`${k}=${s}`);
  }
  return oneLine(parts.join(", "), 170);
}

const ERROR_WORDS = /\b(error|failed|failure|traceback|exception|not found|denied|enoent|syntaxerror)\b/i;

function resultSummary(t) {
  const body = String(t ?? "").trim();
  if (!body) return "(empty output)";
  const line = body.split(/\r?\n/).find((l) => l.trim()) || "";
  const flag = ERROR_WORDS.test(body.slice(0, 400)) ? "ERROR? " : "";
  return flag + oneLine(line, 100) + (body.length > 200 ? ` [${body.length} chars]` : "");
}

const WRITES_FILES = /(write|edit|patch|replace|create|apply)/i;

// A compact handover for a brand-new chat. Covers everything up to and
// including the last assistant turn; the newest tool results / user message are
// sent separately right after it. Always bounded by roughly `maxChars`.
export function buildRecap(messages, { maxChars = DEFAULT_RECAP_CHARS } = {}) {
  const all = (messages || []).filter((m) => m && m.role !== "system");
  let lastAssistant = -1;
  all.forEach((m, i) => {
    if (m.role === "assistant") lastAssistant = i;
  });
  const past = lastAssistant >= 0 ? all.slice(0, lastAssistant + 1) : all;

  const users = past.filter((m) => m.role === "user").map((m) => msgText(m).trim()).filter(Boolean);
  const results = new Map();
  for (const m of past) if (m.role === "tool") results.set(m.tool_call_id, msgText(m));

  const steps = [];
  const files = [];
  let lastSaid = "";
  for (const m of past) {
    if (m.role !== "assistant") continue;
    const said = msgText(m).trim();
    if (said) lastSaid = said;
    for (const tc of m.tool_calls || []) {
      const name = tc?.function?.name || "tool";
      const args = parseArgs(tc);
      const res = results.has(tc.id) ? resultSummary(results.get(tc.id)) : "(result follows below)";
      steps.push(`${steps.length + 1}. ${name}(${argSummary(args)}) -> ${res}`);
      const target = args.filePath || args.path || args.file;
      if (WRITES_FILES.test(name) && typeof target === "string" && !files.includes(target)) files.push(target);
    }
  }

  const head = [
    "CONTEXT HANDOVER - this chat continues an earlier chat that had become too long. You were already working on this task and you keep the same tools and rules. Do not start over and do not repeat finished steps.",
    "",
    "ORIGINAL TASK",
    users.length ? clipBlock(users[0], 3000) : "(not available)",
  ];
  const later = users.slice(1).slice(-3);
  if (later.length) {
    head.push("", "LATER MESSAGES FROM THE USER", ...later.map((u) => `- ${oneLine(u, 500)}`));
  }
  if (files.length) {
    head.push("", "FILES CHANGED SO FAR", ...files.slice(-25).map((f) => `- ${oneLine(f, 100)}`));
  }
  const tail = [];
  if (lastSaid) tail.push("", "WHAT YOU LAST SAID", clipBlock(lastSaid, 500));
  tail.push(
    "",
    "If PLAN.md or PROGRESS.md exist in the working directory, read them now and continue from them. Keep PROGRESS.md updated after each finished milestone."
  );

  const fixedLen = head.join("\n").length + tail.join("\n").length + 60;
  const budget = Math.max(600, maxChars - fixedLen);
  const kept = [];
  let used = 0;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (used + steps[i].length + 1 > budget) break;
    kept.unshift(steps[i]);
    used += steps[i].length + 1;
  }
  const omitted = steps.length - kept.length;
  const stepBlock = steps.length
    ? [
        "",
        `STEPS DONE SO FAR (oldest first, results shortened${omitted ? `, ${omitted} older steps left out` : ""})`,
        ...kept,
      ]
    : [];
  return [...head, ...stepBlock, ...tail].join("\n");
}