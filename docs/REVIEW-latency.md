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

---

# Part A — diff review of the three riskiest commits

Date: 2026-11-05. Branch `latency-hardening` at `d69ea83`. Scope: `git show` for
`d8c4be3` (completion), `0f93e28` (early return), `96c670a` (stream filter), read
against the source as it stands. Tags: **[bug]** a concrete defect,
**[race]** a timing window, **[selector]** a DOM/selector assumption.

## A.1 `d8c4be3` — completion from the stop button

**[bug] A reply shorter than 5 characters can never complete.**
`completionDecision` (`extension/chrome/content.js:964`) returns `false` for
`lastTextLength < 5` regardless of any other signal, so a legitimate one-word
answer ("Done", "OK", a 3-character shell command, a bare `yes`) is not returned
until the 590 s request timeout — 10 minutes of dead time for a valid turn. The
comment says this avoids finishing on a blinking cursor, but it also blocks
genuine short answers. Fix: when `stopSeen && !stopVisible` and the quiet window
has elapsed, allow completion at any length (the stop-button signal is already
proof the turn finished); keep the 5-char floor only for the text-stability
fallback.

**[selector] The stop selectors are narrow and easily missed.**
Claude's `SITE.stop` is only `button[aria-label*="Stop" i]`; ChatGPT adds
`button[data-testid="stop-button"]`. Several sites (e.g. DeepSeek) render the
control as `div[role="button"]`. If a site renames the label (e.g. "Stop
response" still matches `*Stop*`, but "Cancel" or an icon-only button does not),
`isStopVisible()` never fires, `stopSeen` stays false, and every turn pays the
2200 ms fallback. Correct, but slower — and it fails **silently** (no log).

**[selector] `visible()` ignores `opacity` and `aria-hidden`.**
`visible()` (`content.js:616`) checks `getBoundingClientRect` size, `display`,
and `visibility`, but not `opacity` or `aria-hidden`. A site that fades its stop
button out with `opacity:0` (a common transition) keeps returning `true` from
`isStopVisible()`, which makes `generating` permanently true and
`completionDecision` never complete → the turn hangs to the 590 s timeout. This
is the single most likely "completes via fallback / hangs" cause on a real site
and is the first thing to inspect in Part C.

**[race] A very short generation can be missed entirely.**
`tick()` polls every 250 ms (`OBSERVER_TICK_MS`); `stopSeen` is set only if a
tick observes the stop button visible. If the site shows and hides the stop
button entirely between two ticks, `stopSeen` stays false and the turn takes the
2200 ms fallback. Correct, only slower.

**[race] Whitespace-only re-renders keep resetting the quiet timer.**
`lastTextAt` is updated whenever `text !== lastText`. A site that re-renders the
same reply with different whitespace (or updates a streaming caret inside the
extracted node) resets the quiet window each time. With `stopSeen` true this
bypasses the 2200 ms fallback and only the request timeout ends the turn.

## A.2 `0f93e28` — early return on a complete `TOOL_CALL`

**[bug] `state.justStopped` is set but effectively never cleared.**
`content.js:1322` sets `state.justStopped = stopped` on an early return. The only
clear is in `waitForIdle` (`content.js:923`), which the pipeline calls only when
`SITE.iconSend` is true (`content.js:1388`, DeepSeek today). So on Claude/ChatGPT
the flag stays `true` after the first early return. It is currently harmless
because `waitForIdle` is not called there, but the comment at the early-return
block ("the next send clears it") is false, and a future caller of `waitForIdle`
on any other site would silently skip one idle wait. Fix: reset `state.justStopped
= false` at the top of `runPipeline` (next to `state.cancel = false`).

**[race] The hard cap can fire against a stale `lastText`.**
`lastTextAt` and `lastText` only advance inside the throttled extraction block
(≥120 ms, and at worst once per second via `UNSEEN_MUTATION_MS`). The early-return
decision computes `quietMs`/`sinceBlockMs` from those possibly-stale values. A
second block that has started writing but has not yet been read can leave
`toolBlockAtEnd(lastText)` true for up to ~1 s while `earlyBlockAt` keeps
counting; if that straddles the 1500 ms cap, the early return clicks stop and the
half-written second block is dropped. Narrow (requires the second block's first
` ``` ` to land in the last ~1 s of the cap and the read to lag), but real. The
existing test "a gap longer than the window is extended while the site is still
generating" covers the intent, not this staleness.

**[selector] `toolBlockAtEnd` assumes the reply ends exactly with the closing
fence.** It trims trailing whitespace and requires the text to end in ` ``` `.
`extractText` skips `BUTTON`/`SVG`, but a site that appends anything textual
after the fence inside the reply node (a "Copy" label not wrapped in a button, a
footer) defeats the early return. Safe (falls back to normal completion), slower.

**[selector] The stop click reuses the same selectors as completion.** If
`SITE.stop` overlaps `SITE.send` on some future site, `stopGeneration()` could
click send again. Today the two lists are disjoint on every site; the registry is
the only guard.

**[bug, latent] `toolBlockAtEnd` trusts the last `TOOL_CALL` marker, not the last
block.** It takes `lastIndexOf("TOOL_CALL")` and the first `{` after it. Prose
that mentions `TOOL_CALL` after the real block makes the parse start in the
wrong place and usually returns `null` (no early return) — conservative, no
wrong call, but a missed fast path on chatty models.

## A.3 `96c670a` — streaming filter (`bridge/streamfilter.js`)

**[bug] A tool name longer than ~50 characters can leak a prefix.**
`unsafeStart`'s fallback matches `{"name":"<known>"` only after the closing
quote; until then the text is "safe". `HOLDBACK` is 64 characters, which covers
```` ``` ```` + tag + newline + `{"name":"` (roughly 20) plus a ~40-char name. An
MCP tool name over ~50 characters lets the first characters of the JSON object
stream before the name closes and matches. The full object is still withheld and
never duplicated, so no tool call leaks, but a fragment can appear. Fix if
observed: raise `HOLDBACK` or also withhold on a bare `{"name":"` prefix.

**[bug] A fence with a punctuated language tag can be streamed.**
`fenceOpensAt` allows `[A-Za-z0-9_-]*`; a tag like `c++` or `objective-c`
(with `.`) does not match, so the relationship between the fence and the marker
is missed and `unsafeStart` withholds from the marker instead of the fence. The
opening ` ``` ` (already past the 64-char holdback by then) can show as a stray
fence before the block disappears. Low impact; documented.

**[race] `finish()` re-emits from the first differing character.** If the final
cleaned text diverges from what was streamed before the divergence point (an
emoji, a form of whitespace normalization, a re-render), the tail is re-emitted.
It cannot duplicate a tool block (the final text has blocks removed) but a short
separator can repeat.

**[selector] None.** The filter is string-only; it does not touch the DOM.

**[assessment] The final `response` is authoritative.** Whatever `push` emitted,
`parseToolCalls` runs on the full reply and `finish` only appends the missing
suffix. Tests in `tools/test-streamfilter.js` cover plain text, prose+block,
block-at-start, block-at-end, split fence/marker, a *normal* fenced code block,
prose `TOOL_CALL`, tools disabled, and the `NOAPI_STREAM=0` kill switch.

## A.4 Port discovery / could a test bridge attract a real tab?

**No discovery, no scanning.** `extension/chrome/background.js:10` hardcodes
`url: "ws://127.0.0.1:8787"`; the only override is `ext.storage.local` key
`noapi_url` (`background.js:375`), i.e. the user's own setting. There is no port
scan, no broadcast, no mDNS. A real content script reaches the network only
through the background worker, which dials that single URL.

Consequence: a test bridge on a non-8787 port **cannot** be reached by a real
browser tab. The residual risk is the opposite direction — a test bridge started
on **8787** would be dialled by the user's real extension and could receive a
real tab's `hello` and be asked to drive a real chat. Commit `2292f27` removed
that by giving every test its own ephemeral port and by refusing to talk to
anything already listening on 8787 (see the harness safety check).

## A.5 Is the tool-description priority list keyed only by name?

No. `isPriorityTool` (`bridge/toolproto.js:54`) is true when **either** the tool
name matches `PRIORITY_NAME = /(edit|write|patch|bash|read|shell|replace|apply|rename|move|create|delete|notebook)/i`
**or** any parameter key matches `PRIORITY_PARAM = /(oldstring|newstring|replace|old_string|new_string)/i`.
So a custom tool with a bland name but an `oldString` parameter is still treated
as priority and keeps the long description.

MCP and custom tool classification therefore depends on the words inside the
tool name: `mcp__filesystem__read_file` → priority, `mcp__github__get_issue` →
**short** (no keyword; "get" is not in the list). A custom tool with subtle
semantics and a bland name/params (e.g. `mcp__db__query` with no
`replace`-style key) gets the 180/90-character clip, which is where a model can
mis-call it. Over-classification (e.g. `mcp__slack__create_channel`) only costs
preamble size, never correctness — safe direction. This is a heuristic, not a
contract; the parameter test is the robust half.

## A.6 Test coverage confirmed (`git show --stat` per requested case)

| Requested case | Test | File:line |
|---|---|---|
| two blocks, short gap | "two blocks with a gap shorter than the window are returned together" | `tools/test-content-logic.js:99` |
| two blocks, long gap | "a gap longer than the window is extended while the site is still generating" + "…it stops at the hard cap" | `tools/test-content-logic.js:104`, `:109` |
| invalid JSON | "invalid JSON is not complete"; "toolBlockCount ignores invalid JSON" | `tools/test-content-logic.js:71`, `:119` |
| unknown tool name | "a block for an unknown tool is not actionable"; "toolBlockCount ignores unknown tools" | `tools/test-content-logic.js:75`, `:120` |
| early-return kill switch | "kill switch: never early-returns or stops" + end-to-end `NOAPI_EARLY_RETURN=0` in `test-all.js` | `tools/test-content-logic.js:85`; `tools/test-all.js` |
| description limits | priority vs short caps, env overrides, non-priority clip | `tools/test-toolproto.js:154`–`174` |
| truncation hint | head+tail kept, `chars truncated` marker, `N chars truncated`, custom limit | `tools/test-toolproto.js:113`–`128` |

Commit stats: `d8c4be3` adds `tools/test-content-logic.js` (+57); `0f93e28`
touches `tools/test-content-logic.js` (+59/-?), `tools/test-all.js` (+39),
`tools/test-bridge-state.js` (+27); `96c670a` adds
`tools/test-streamfilter.js` (+162) and `tools/test-all.js` (+29).

## A.7 Nothing pushed

- `git branch -r` → only `origin/HEAD -> origin/main` and `origin/main`.
- `git reflog -14` → all entries are local commits and the checkout from `main`
  to `latency-hardening`; no `push` entry.
- `git status -sb` → `## latency-hardening` (no upstream, no "ahead").
- `origin/main` is still `d29b84b` ("Add CI badge to README"); `git log
  origin/main..HEAD` lists all 15 local commits (the entire latency series,
  phases 0-6 plus the hardening round). Nothing reached origin.