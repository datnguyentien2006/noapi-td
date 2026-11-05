# Self-review: the three riskiest latency commits

This is a review of my own diffs for the three commits that change behaviour on
a real site: completion detection, the early return on `TOOL_CALL`, and live
streaming. For each one: what could go wrong, which selectors/constants it
depends on, how it fails, and what covers it. Commit hashes are from
`latency-hardening`; the original phase commits are noted too.

---

## 1. Completion detection

Commits: `d8c4be3` (original), `bb62768` (guard), `815f9a3` / `26a9fcb`
(typing and snapshot work it relies on).

### What it does

The content script waits until the site's **stop button disappears**, then waits
a short per-site debounce (350–550 ms) before declaring the reply complete. If
the stop button was never seen at all, it falls back to the old 2200 ms
"no change" rule. `completionDecision()` is a pure function so it can be
unit-tested without a browser.

### What could go wrong on a real site

- **Stop selectors change.** `SITE.stop` is a comma-separated list of CSS
  selectors. If the site renames its stop control, `isStopVisible()` never sees
  it, `stopSeen` stays false, and every reply takes the 2200 ms fallback. Slow,
  but correct.
- **The stop button is hidden but still matches.** Some UIs keep the node in the
  DOM with `display:none`. `isStopVisible()` checks computed visibility, but a
  site that changes the hiding technique could make us think generation is
  still running forever. The hard `timeoutMs` (590 s) eventually fails the
  request loudly.
- **The debounce is too short for a site that pauses mid-answer.** A model that
  stops writing for 350 ms to think would be cut off. This is the main quality
  risk. The fake models a short final render; a real site may pause longer.
  Mitigated by per-site debounce values (Gemini/Mistral 450 ms, most 400 ms,
  Claude/ChatGPT 350 ms) and by the fact that the reply text must be stable for
  the whole window.
- **The reply is shorter than 5 characters.** `completionDecision` refuses to
  complete; such a reply waits for the timeout. Deliberate (it avoids finishing
  on a blinking cursor), but a legitimate one-word answer shorter than 5 chars
  would be slow. No correctness issue.
- **Re-renders reset the text.** `lastTextAt` is updated on every changed
  extraction; a site that re-renders the same text with different whitespace
  keeps resetting the quiet timer. The 2200 ms fallback does not help because
  `stopSeen` is true. Again bounded by the request timeout.

### How it fails

Silently-slow in the selector/debounce cases (extra latency, no error), loudly
at the 590 s timeout. It never returns partial text without the user asking.

### What covers it

- Fallback to the stable-text rule when the stop button was never seen.
- The request timeout.
- `GET /health` timings expose `stopSeen` and `completedBy` per request, and the
  per-site counters show how often stop detection is actually used.

---

## 2. Early return on a complete `TOOL_CALL`

Commits: `192b288` (original), `0f93e28` (hardening).

### What it does

With tools enabled, as soon as the reply ends with a complete `TOOL_CALL` block,
click the site's stop button and return the block(s) immediately instead of
waiting for trailing narration. The grace window is `NOAPI_EARLY_RETURN_MS`
(default 400 ms), extended up to a 1500 ms hard cap while the site is still
generating. `NOAPI_EARLY_RETURN=0` disables it and the stop click.

### What could go wrong on a real site

- **A second block arrives after the grace window.** The model batches calls
  with a pause between them. We wait up to the hard cap; a block that arrives
  after 1500 ms is treated as trailing narration and dropped. This is a real
  quality trade-off: batching wins up to the cap, and a very late block is lost.
  Documented in `content.js` and the README.
- **Clicking stop truncates a block mid-write.** After clicking we re-read the
  reply node once (120 ms) and keep the longer text if it contains more complete
  blocks. If the site ignores the first click, the block may still be partial;
  then it is not parsed and the turn looks like plain text. The final completion
  path is the safety net.
- **The tool name list is wrong.** We only return early when the block names a
  tool in the request's `tools` array. If OpenCode sends a name with different
  casing, the comparison is case-insensitive. If it sends no tools (local title
  requests), early return is off.
- **The stop click also fires on a site that was already finished.** Harmless
  for the reply, but it can leave the site's UI in a "stopped" state for the
  next turn. `state.justStopped` tracks it and the next send clears it.
- **The site's stop button is also its "send" button.** A misconfigured
  selector could click send again. This is the same selector risk as completion
  detection; the site registry is the only mitigation.

### How it fails

Loudly in the "wrong tool name / invalid JSON" cases: we simply do not return
early, and normal completion handles the turn. Silently in the "block after the
hard cap" case: the call is dropped as narration. That is the documented
trade-off.

### What covers it

- `NOAPI_EARLY_RETURN=0` (validated by `tools/test-all.js`).
- `NOAPI_EARLY_RETURN_MS` to widen the grace window on a slow site.
- Invalid JSON, unknown tool names, and an incomplete second block are unit
  tests; none of them can trigger an early return.
- `/health` counts early returns per site, so a site that never early-returns
  (or always does) is visible.

---

## 3. Live streaming filter

Commits: `2832b87` (original), `bb62768` (write guard), `96c670a` (filter
module and tests).

### What it does

While the site writes, partial text is forwarded to OpenCode as content deltas.
`bridge/streamfilter.js` sends only the prefix that cannot be the start of a
tool block. It detects an opening fence followed by `TOOL_CALL`, and the
parser's bare-JSON fallback (`{"name":"<known tool>"`). It holds back a
64-character tail so a fence, marker, or tool name split across updates is not
leaked. `NOAPI_STREAM=0` emits once at the end.

### What could go wrong on a real site

- **A tool block with a long language tag or extra whitespace.** The fence
  detector allows `[A-Za-z0-9_-]*` and whitespace before `TOOL_CALL`. A tag with
  punctuation (e.g. `c++`) would not match; then the marker itself is still
  treated as the unsafe start, so the protocol is still withheld, but the
  opening fence may have been streamed. The visible text could show a bare
  ``` before the block disappears. Low impact, no tool-call text leaks.
- **A bare JSON tool object with a very long tool name.** The 64-character
  holdback covers names up to roughly 50 characters. A longer MCP tool name
  could let the first few characters of `{"name":"...` stream before the name
  closes and matches. The full object is still not shown, and the final emission
  does not duplicate text, but a fragment could appear. Increase `HOLDBACK` if
  this is observed.
- **The model writes `TOOL_CALL` in prose.** We withhold live from the marker
  and show the prose once at the end (the parser confirms it is not a call).
  Slightly less live, never duplicated.
- **A normal fenced code block.** It streams normally. The only cost is the
  64-character tail delay, which is invisible at chat speed.
- **A site re-renders the reply with different whitespace.** The final emission
  compares the cleaned text with what was already streamed using a common
  prefix. A large rewrite could re-emit a small separator, but not the whole
  answer.

### How it fails

Silently in the "unsafe fragment streamed" cases above (a fence or a JSON
prefix, never a complete tool call). Loudly if the HTTP stream is closed mid-way:
each write is guarded by `res.writableEnded`, and errors end the SSE stream with
an error frame and `[DONE]`.

### What covers it

- `NOAPI_STREAM=0` for the old behaviour (tested end to end).
- `tools/test-streamfilter.js` covers all requested cases, including split
  markers/fences, normal code, prose markers, and tools disabled.
- The final `response` is authoritative: whatever was streamed, the parsed
  `tool_calls` and cleaned text come from the full reply, and the final emission
  only appends what was not already sent.

---

## Known limits (still need a real browser)

- The per-site selectors (`SITE.stop`, `SITE.transcript`, composer/send) are
  the main untested surface; a site redesign degrades latency, not correctness.
- Selector visibility and re-render behaviour cannot be simulated faithfully;
  the fake tab models timing, not DOM quirks.
- `/health` counters are per bridge process since start; they reset on restart.