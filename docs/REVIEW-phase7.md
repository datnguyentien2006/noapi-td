# Self-review: the Phase 7 latency commits

This is a review of my own diffs, for the six Phase 7 commits that change
behaviour on a real site, plus the one defect fix found while doing the review.
For each: what could go wrong on a real site, which selectors/constants it
depends on, how it fails (silently or loudly), and which kill switch or fallback
covers it. Commit hashes are from `latency-verify` (all local; nothing pushed).

**None of this was tested on a real ChatGPT/Claude page.** Every "it works" claim
below is backed by either a Node unit test or the Playwright harness against the
local stub (`tools/fake-extension.js` / `tools/test-fallback-browser.js`), which
is a simulation of the DOM and of an SSE stream — not the real sites.

| # | Commit | Phase | Reviewed in |
|---|---|---|---|
| — | `e893b5c` | defect fix | [Defect fix](#defect-fix-e893b5c) (read this first) |
| 1 | `c7a7263` | 3 — SSE observer | [§1](#1-sse-observer-c7a7263) |
| 2 | `b41083f` + `1bc86e2` | 1 — event-driven tick | [§2](#2-event-driven-completion-loop-b41083f--1bc86e2) |
| 3 | `cbb90c1` | 2 — eager send | [§3](#3-eager-send-cbb90c1) |
| 4 | `903016e` | 4 — terse preamble | [§4](#4-terse-preamble-903016e) |
| 5 | `addbe6e` | 5 — new chat | [§5](#5-new-chat-per-session-addbe6e) |

Line numbers are for `extension/chrome/content.js` unless named otherwise.
`extension/firefox/content.js` and `extension/firefox/sse-observer.js` are kept
byte-identical to their Chrome counterparts, so every reference applies to both.

---

## Defect fix: `e893b5c`

This is the one real defect this audit found, so it is listed first.

**Symptom.** The SSE observer treated *any* end of the clone read as a clean end
of the stream. A rejected read (stream error, or the user pressing Stop /
navigating away, which aborts the fetch) and a clone that could not be drained
both fell into `post("ended")`. The content script's completion path then took
`finished="sse"` and returned whatever partial text was in the DOM as the final
answer — a **truncated reply reported as complete**. That is a correctness bug,
not a latency bug.

**Fix** (`extension/chrome/sse-observer.js`, mirrored in Firefox):

- A rejected clone read now posts `"error"`, never `"ended"` (`sse-observer.js`
  80–85), and a clone with no readable body posts `"error"` too (89–92).
- The clean path (`done === true`) is the *only* place that posts `"ended"`
  (78–79).
- If cloning throws *after* `"started"` was announced, it posts `"error"` so the
  live-stream count does not leak (93–98). A leaked `active` count would suppress
  every later `"ended"` for the rest of the turn.
- The content script counts `"error"` as activity but never completes on it
  (`content.js` 385–389), and the SSE completion branch now also requires the
  site to have visibly stopped generating: `if (sseState === "ended" && !generating)`
  (`content.js` 1738).

**Test.** `tools/test-sse-observer.js` runs the observer in a `vm` with stub
`fetch` and asserts: clean end → `ended`; mid-stream error → `error`;
undrainable response → `error`; throwing clone → `error`; a non-SSE response is
passed through untouched; and **only the clone, never the page's own body, is
read**. Registered in `npm test`.

**Residual risk.** See §1, "Can a page script spoof `ended`?".

---

## 1. SSE observer (`c7a7263`)

**What it does.** `extension/chrome/sse-observer.js` wraps `window.fetch` in the
page's MAIN world and, for `text/event-stream` responses only, posts
`started`/`ended`/`error` to the content script. The content script counts those
events and lets a cleanly-ended stream finish the turn early (one extra DOM read,
`content.js` 1729–1762) instead of waiting out the per-site debounce.

### It only observes; it never modifies the page

Evidence from `extension/chrome/sse-observer.js`:

- It reads the response **clone only**: `const clone = res.clone ? res.clone() : null;`
  (74), then reads `clone.body.getReader()` (76) or `clone.text()` (88). The
  original `res` is never read, delayed, replaced, or cancelled here.
- The chunks are discarded, not stored: the read callback takes `({ done })` and
  ignores `value` (78). Nothing is accumulated, so a very long stream does not
  grow memory on our side.
- It posts only `{ source, token, event, at }` (`post`, 51–55). **No response
  body, URL, headers, or timing of individual tokens cross the boundary.** The
  content script stores only counters (`content.js` 379–393: `started/ended/
  errored/active/lastAt`), and `/health` records only `sseSeen` and
  `completedBy` (`bridge/state.js` 372, 396).
- It never calls a site API and hardcodes no URL. `test-sse-observer.js` asserts
  the non-SSE case is byte-for-byte passthrough.

### Can a page script spoof `ended`?

Partly, and this is worth being precise about.

- The token is 16 random bytes (`sse-observer.js` 34–42) stored in a DOM
  attribute on `<html>`, `data-noapi-sse-token` (33, 44–49). The content script
  validates `d.token !== SSE.token` before counting any event (`content.js`
  375–378), and the observer posts to `location.origin` (53). This stops
  *accidental* collisions and messages from other windows/origins.
- **But the attribute is in the shared DOM, so a same-document script (i.e. the
  page's own JS) can read the token and post a forged event.** There is no way to
  keep a secret in an attribute the MAIN world owns. So "unguessable" is true for
  other origins/accidents, not for the page itself.
- **What stops a forged `ended` from truncating a reply** is the guard added in
  `e893b5c`: the completion branch requires `!generating` (`content.js` 1738),
  and `isStopVisible()` (`856–864`) is true while the site is streaming. A
  forged `ended` while the stop button is up is ignored. The DOM text is also
  read once more after a grace window (`SSE_END_REREAD_MS`, 1282, 1748–1757), so
  a forged end between tokens still yields the final paint if the turn continues.

**Honest limit:** a page that has *stopped* generating but whose reply text is
not yet in the DOM could be ended early by a forged event. This is an accepted
residual risk — the observer is a latency optimisation, and the reply text always
comes from the DOM, so the worst case is an early read of text the site had
already painted. If this ever matters, the robust fix is a `MessageChannel` port
kept in the injected script's closure (not a DOM attribute), which is a larger
change than this audit.

### Reading the clone cannot stall the page

- `clone()` tees the body; the page keeps reading its own branch unchanged. Our
  clone is drained as data arrives (`pump`, 77–86), so we do not add
  back-pressure to the page's read and we do not buffer the page's branch.
- If the page's body was already consumed before we could clone, `res.clone()`
  returns a response whose body is unusable; the read rejects and we post
  `"error"` (85) — we never touch the page's own read.
- Abort/cancel: an `AbortController` rejection on the clone read becomes
  `"error"` (84); the content script never completes on `"error"`, and its
  `AbortController`/`state.cancel` path is independent (`content.js` 1598–1601,
  1749–1752).

### Response errors / aborts / dropped connections

`"error"` is counted as activity (so the swallowed-send recovery at
`content.js` 1630 does not misfire) but is **not** completion. The turn then
finishes through the normal DOM path. The request cannot hang on the observer:
the observer has no timers, and if it is missing or silent, `sseDecision`
returns `"none"` (`content.js` 1246–1251) and everything behaves as before. A
never-resolving clone read simply means no event — never a stuck request.

### Firefox CSP fallback

Firefox on our minimum version has no MAIN-world content scripts, so the content
script injects `sse-observer.js` with a `<script src=ext.runtime.getURL(...)>`
tag (`content.js` 348–363). If CSP blocks it, `s.onerror` removes the tag
(360) and there is no token attribute, so `readSseToken()` returns `null`, no
event ever matches (`375–378`), and the DOM path runs unchanged. **Silent
fallback, no page break.** `injectSseObserver()` also no-ops unless the
`sseObserver` flag is on (349).

### Selectors / constants / kill switches

- No site selectors: it keys off the `content-type: text/event-stream` header
  (`sse-observer.js` 68–69). A site that streams over WebSocket or XHR instead of
  `fetch` is simply not observed → silent, the DOM path covers it.
- Constants: `SSE_END_REREAD_MS = 120` (`content.js` 1282), `FALLBACK_TICK_MS =
  400` (1233, wakes the loop so `SSE.wake` is not the only driver).
- Kill switches: `NOAPI_SSE=0` in the bridge (`bridge/http.js` 200, forwarded as
  `sse:false`, read at `content.js` 1795, 1491) **and** the `sseObserver` panel
  flag (`content.js` 349, 1491) — the two are ANDed. `SSE_OBSERVER_ENABLED`
  (`sse-observer.js` 25) disables the observer script entirely.

### Failure mode

Silent and safe. If the stream type changes or the observer is blocked, turns
just take the DOM path again — the same latency as before Phase 7, no error.

---

## 2. Event-driven completion loop (`b41083f` + `1bc86e2`)

**What it does.** The loop used `setInterval(tick, 250)`; now the
`MutationObserver` schedules a tick through a coalescing scheduler (`content.js`
1435–1469, wired at 1546–1550), and the fixed interval is demoted to a 400 ms
safety net (`FALLBACK_TICK_MS`, 1233; `setInterval(...scheduler?.schedule(), 400)`,
1779). A follow-up tick is armed at the per-site debounce so completion does not
wait for the safety net (1680–1681).

### What could go wrong on a real site

- **A hidden/hostile mutation storm.** A page that mutates continuously would
  schedule ticks continuously. The scheduler never runs two at once and coalesces
  a burst into one run, with at most one extra run queued (`again`, 1440–1463).
  So this is bounded work, not a spin loop.
- **`tick` awaits that never resolve.** Every scheduled callback runs through the
  same single in-flight slot; if `run()` hangs on an await, the fallback interval
  is swallowed into `again` too and the loop stalls until it resolves. `tick`'s
  awaits are all bounded (`sleep`, DOM reads), and the old interval code shared
  the same `ticking` guard (`1595`), so this is not a regression — but it is the
  one place where "coalesced" could mean "stalled".
- **Shadow DOM.** The observer cannot see into shadow roots; those sites rely on
  the 400 ms interval and `UNSEEN_MUTATION_MS = 1000` (1238) forcing a read at
  least once a second (1655). Slower, still correct.

### Selectors / constants / kill switches

- Constants: `FALLBACK_TICK_MS = 400`, `EXTRACT_THROTTLE_MS = 120`,
  `UNSEEN_MUTATION_MS = 1000` (1237–1239), `FALLBACK_STABLE_MS = 2200` (1232).
- Kill switch: the `observerDriven` panel flag (`content.js` 1548). Off, the
  observer only sets `dirty` and the 400 ms interval drives every tick exactly as
  the pre-Phase-1 loop did. `1bc86e2` added this switch; before it, the observer
  was unconditional.
- Unit test: `createTickScheduler` is a `@noapi-shared` block (1434–1470)
  exercised in `tools/test-content-logic.js` (one run per burst, no overlap,
  stop is honoured).

### Failure mode

Silent. Worst case is extra latency, never an incorrect reply; the request
timeout (`content.js` 1603–1607) still bounds a genuine stall, and `/health`
`completedBy` shows whether turns are finishing via stop/fallback/sse.

---

## 3. Eager send (`cbb90c1`)

**What it does.** Typing no longer sleeps a fixed 150 ms then polls the send
control on a 150 ms grid. It waits on the page's own signal — the send control
turning **enabled** — polled every 30 ms with a 1200 ms cap, then clicks
immediately (`content.js` 990–1011, `createSendGate` 1421–1432,
`submitComposer` 1059–1099).

### What could go wrong on a real site

- **Clicking the wrong control.** On icon-send sites (DeepSeek),
  `findIconSendButton` (`1021–1043`) deliberately walks up from the composer and
  takes *only* icon-only buttons that sit after it in DOM order, and returns
  `null` while `composerText(composer)` is empty — so it never clicks the stop
  square or an attach/edit icon. On selector sites it uses `SITE.send`
  (`1045–1057`). A site that puts a *new* icon-only button after the send arrow
  would be mis-clicked; this is the sharpest edge and is site-specific.
- **Clicking too early.** The gate clicks the instant `probe()` is true. Some
  sites enable the button a tick before their own submit handler is attached; a
  very early click then does nothing. The swallowed-send recovery re-sends (up to
  3×, `content.js` 1630–1651), and the Enter fallback still fires if no control
  ever enables (`1083–1097`).
- **The composer is wiped between enable and click.** `submitComposer` runs the
  `wantedFilled` check once right after the click (`1078–1080`) as a diagnostic;
  the recovery loop re-types if nothing starts.

### Selectors / constants / kill switches

- Selectors: `SITE.send` / `SITE.iconSend`; the enabled check is `isEnabled`
  (`1013`).
- Constants: `TYPE_SETTLE_MS = 150` (fallback only), `SUBMIT_POLL_MS = 30`,
  `SEND_READY_TIMEOUT_MS = 1200` (`983–985`).
- Kill switch: `eagerSend` panel flag (`content.js` 994, 1003, 1065) — off
  restores the fixed 150 ms settle and the old 150 ms poll.
- Unit test: `createSendGate` in `test-content-logic.js`. Browser test (e) in
  `test-fallback-browser.js` asserts the click lands within 50 ms of enabling and
  **never before** it enables.

### Failure mode

Loud when it matters: a mis-click that starts nothing is caught by the recovery
loop (visible status), and the Enter fallback covers a never-enabling control.
Silent only in the rare "clicked a wrong-but-harmless icon" case.

---

## 4. Terse preamble (`903016e`)

**What it does.** With tools enabled, the preamble gains two rules: output
nothing but `TOOL_CALL` blocks between/around them, and keep final answers terse
(`bridge/toolproto.js` 177–200, `terseEnabled()` 181, `renderPreamble` 185).
Generated text is token-by-token, so shorter output is most of the remaining
wall-clock time.

### What could go wrong on a real site

- **The model ignores the rules.** Then there is no speedup — but also no
  functional change. The format, batching guidance, STOP rule and full tool list
  are unchanged in both modes; `tools/test-toolproto.js` asserts the additive
  contract.
- **Terseness hurts answer quality.** Possible on a real site (a terse answer
  may omit reasoning a user wanted). Not observable in the simulation; it is a
  trade-off the user opts into.

### Selectors / constants / kill switches

- No selectors, no timing constants — it is prompt text only.
- Kill switch: `NOAPI_TERSE=0` (`bridge/toolproto.js` 181).
- **Known limitation:** the preamble is only (re)sent when the tool set changes
  (`bridge/http.js` 203–212), so toggling `NOAPI_TERSE` mid-session does not
  affect an already-primed chat. Start a fresh session (or set the env var before
  `npm start`) to A/B it.

### Failure mode

Silent by design — worst case, no speedup.

---

## 5. New chat per session (`addbe6e`)

**What it does.** With `NOAPI_NEW_CHAT=1` (default **off**), a request that
starts a new conversation (`fresh = !messages.some(m => m.role === "assistant")`,
`bridge/http.js` 205) asks the tab to click the site's own new-chat control
before typing (`content.js` 1817–1832, `startNewChat` 840–852), so the blank chat
has a tiny DOM and no old context. The bridge also drops that site's tool hash so
the preamble is re-sent (`bridge/http.js` 211).

### What could go wrong on a real site

- **The selector matches the wrong element.** `SITE.newChat` lists (81, 121, 149,
  178, 198, 217, 235) include broad fallbacks like `a[href="/"]`. On a site where
  `/` is not "new chat", clicking it navigates the SPA somewhere unexpected and
  the turn continues on the wrong page. `startNewChat` checks `visible`, skips
  `#noapi-host`, and skips `disabled` (`844`) — but an `<a>` has no `disabled`,
  so a visible wrong link would be clicked.
- **The SPA navigation tears down the composer mid-request.** Clicking is an
  in-page navigation on these sites, so the request survives; `runPipeline` then
  sleeps 400 ms to let the composer re-mount (1824) and `waitForComposer`
  re-finds it (1833–1834).
- **No control found.** Logged and the turn continues in the current chat
  (1827) — never a hard failure.
- **Trade-off:** the current tab moves off the chat you were reading. This is
  why it is off by default and documented in `README.md` 315–324.

### Selectors / constants / kill switches

- Selectors: `SITE.newChat` per site.
- Constant: the 400 ms re-mount sleep (`content.js` 1824).
- Kill switch: `NOAPI_NEW_CHAT` (default off; `bridge/http.js` 210, forwarded
  `245`, read `content.js` 1817).

### Failure mode

Mostly loud: a vanished composer throws "Could not find chat input…" from
`waitForComposer`; a wrong-but-valid navigation continues in the wrong chat
(loud in the status panel). Off by default, so the blast radius is opt-in.

---

## Cross-cutting notes

- **Everything defaults to the shipped behaviour.** Every flag in the README
  table (`README.md` 291–306) defaults to on/off such that flipping it changes
  nothing from the user's point of view except latency. The only default-off
  behaviour change is `NOAPI_NEW_CHAT`.
- **Every fast path is reversible without editing source.** Content-script flags
  (`observerDriven`, `eagerSend`, `sseObserver`) are extension-storage values
  toggled from the `?` panel → *Fast paths (A/B)* (`content.js` 23–72); the SSE
  listener stays registered so a flip needs no reload. Bridge flags
  (`NOAPI_SSE`, `NOAPI_EARLY_RETURN[_MS]`, `NOAPI_TERSE`, `NOAPI_NEW_CHAT`) are
  env vars read per request (`bridge/http.js` 196–211).
- **Measurement.** `GET /health` keeps ≥50 recent timings per site (cap 500
  total, `bridge/state.js` 6–7, 383) and exposes them; `tools/ab-report.js`
  captures two labelled runs and prints median/p90 and the `completedBy` mix per
  site, warning below 5 samples. See `README.md` for the A/B workflow.
- **What is *not* proven:** real-site selector drift, real model behaviour under
  the terse preamble, and whether a real SSE stream ends at the same instant as
  the DOM's final paint. All three need the manual pass in the A/B runbook.
