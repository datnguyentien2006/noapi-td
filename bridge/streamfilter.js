// Streaming safety filter for website replies.
//
// The website reply can contain `TOOL_CALL` blocks. Those blocks must never be
// shown to OpenCode as visible content: the bridge turns them into real
// `tool_calls` instead. While the reply is still growing we therefore send only
// the longest prefix that cannot turn out to be the beginning of a tool block:
//
//   - a code fence that opens a `TOOL_CALL` block, and
//   - a JSON object naming a real tool (the parser's fallback).
//
// Everything else streams normally, including a fenced code block that is just
// code. We always hold back a small tail so a fence, the marker, or a tool name
// split across two updates is not emitted before we can recognise it.
import { toolList } from "./toolproto.js";
import { detectRefusal, GUARD_HOLD } from "./guard.js";

const MARKER = "TOOL_CALL";
// Enough to cover "```" + a short language tag + newline + the marker, and the
// opening `{"name":"<a long tool name>"` of the JSON fallback.
const HOLDBACK = 64;

// Does the text between an opening fence and `idx` contain only an optional
// language tag and whitespace? Then that fence is the one opening the block.
function fenceOpensAt(text, fence, idx) {
  if (fence === -1) return false;
  return /^[A-Za-z0-9_-]*[ \t]*\r?\n?[ \t]*$/.test(text.slice(fence + 3, idx));
}

// Index where something that must not be shown starts, or -1 when the text so
// far is safe to stream. `names` are the tools the model is allowed to call.
export function unsafeStart(text, names = []) {
  const s = String(text || "");
  let best = -1;
  const lower = names.map((n) => String(n).toLowerCase());

  // 1) An explicit TOOL_CALL block, fenced or not.
  let from = 0;
  for (;;) {
    const idx = s.indexOf(MARKER, from);
    if (idx === -1) break;
    const fence = s.lastIndexOf("```", idx);
    const at = fenceOpensAt(s, fence, idx) ? fence : idx;
    if (best === -1 || at < best) best = at;
    from = idx + MARKER.length;
  }

  // 2) The parser's fallback: a bare JSON object with a known tool name.
  const re = /\{\s*"(?:name|tool|tool_name)"\s*:\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(s))) {
    if (!lower.includes(m[1].toLowerCase())) continue;
    const fence = s.lastIndexOf("```", m.index);
    const at = fenceOpensAt(s, fence, m.index) ? fence : m.index;
    if (best === -1 || at < best) best = at;
  }
  return best;
}

export class StreamFilter {
  // guard: on a first turn (no tool result yet) withhold the first GUARD_HOLD
  // chars, and keep withholding while the text reads like a refusal, so a
  // "I cannot access your files" reply never reaches OpenCode before the bridge
  // has had the chance to correct it. Short final answers are released by finish().
  constructor({ tools = [], enabled = true, guard = false } = {}) {
    this.guard = Boolean(guard);
    this.released = false;
    this.names = toolList(tools).map((f) => f.name);
    // With tools disabled nothing can be a tool call: stream everything so the
    // model can talk about the protocol without being censored.
    this.enabled = Boolean(enabled) && this.names.length > 0;
    this.emitted = "";
  }

  // New visible text for the accumulated reply `full`. Monotonic: it never
  // revises text it already returned.
  push(full) {
    const s = typeof full === "string" ? full : "";
    if (!this.enabled) return this._take(s);
    if (this.guard && !this.released) {
      if (s.length < GUARD_HOLD || detectRefusal(s).refused) return "";
      this.released = true;
    }
    const start = unsafeStart(s, this.names);
    const end = start === -1 ? Math.max(0, s.length - HOLDBACK) : start;
    return this._take(s.slice(0, end));
  }

  _take(safe) {
    if (safe.length <= this.emitted.length) return "";
    const delta = safe.slice(this.emitted.length);
    this.emitted = safe;
    return delta;
  }

  // Remaining visible text once the reply is final. `text` is the cleaned reply
  // (tool blocks already removed), so comparing against what was streamed keeps
  // the client from seeing anything twice.
  finish(text) {
    const t = String(text || "");
    if (!t) return "";
    if (t === this.emitted) return "";
    let i = 0;
    const max = Math.min(t.length, this.emitted.length);
    while (i < max && t[i] === this.emitted[i]) i++;
    return t.slice(i);
  }
}

export function streamEnabled(env = process.env) {
  return env.NOAPI_STREAM !== "0";
}