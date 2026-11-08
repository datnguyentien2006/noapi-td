# 📜 Changelog

All notable changes to this project are written here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **SSE stream capture for debugging** (`extension/chrome/sse-observer.js` + the identical firefox copy): when the page sets `<html data-noapi-sse-debug="1">` (off by default), the fetch wrapper keeps a decoded copy of the last 5 `text/event-stream` bodies in memory (capped at 300000 chars each; the body is still drained to the end, so the `ended` event is unchanged) and exposes `window.__noapiSseShow(n = 1)` (path without query, status, content-type, char count, timestamps, frame count, then the first 3000 / middle 1500 / last 1500 chars with control characters left visible) and `window.__noapiSseClear()`. It reads only the clone, never the page's own body; nothing is stored or sent anywhere, and a capture failure never changes the events posted to the content script. The summary builder is a pure `sseSummary` block unit-tested in `tools/test-sse-observer.js`
- **Consult mode**: a new MCP tool `consult` lets a model that is *not* `noapi/*` send the contents of local files plus a question to a logged-in AI chat website and get the answer back, then apply the returned edit blocks itself. Input is `question`, `files` (paths, optionally `path:START-END`), `site` and `mode` (`explain` / `review` / `patch`). `bridge/consult.js` holds the pure logic (allowed roots, symlink/`..` escape, secret and size rules, prompt building, EDIT-block parsing and validation); no new dependencies
- `consult` path rules: files must resolve inside the workspace (`cwd`) or `NOAPI_CONSULT_ROOTS`; `.env*`, `*.pem`, `*.key`, `id_rsa*`, `.git/` and `node_modules/` are refused by name; `NOAPI_CONSULT_MAX_FILE` (60000) caps one file and `NOAPI_CONSULT_MAX_TOTAL` (80000) caps the sum, and the over-budget error lists each file's size so the caller can retry with a line range. Nothing is truncated and nothing is written to disk — the `patch` validator only reports whether each `SEARCH` text occurs exactly once
- `NOAPI_AUTOREAD=1` (off by default): append the contents of the files named in the *latest* user message to a `noapi/*` request, using the same delimiters and the same secret/size rules, so a model that cannot call `read` still sees the file. Paths are detected strictly and by their own *flavour* — a Windows drive path (`C:\dir\file.py`, `C:/dir/file.py`, mixed-case drive), a UNC path, or a POSIX path with at least two segments or a file extension whose first segment exists on disk — and are containment-checked identically on Windows, Linux and macOS; prose such as `/**` or `/what` is not a path and produces no log line. `NOAPI_CONSULT_ROOTS` treats a Windows drive path as one entry instead of splitting on its `:`. A leading UTF-8 BOM is stripped. The bridge logs `autoread skip <path>: <reason>` (off, outside roots, not found, duplicate, instruction file, secret rule, too large) for each real candidate it does not attach, and one summary line per request: `[noapi] autoread: attached N file(s), M chars, prompt total P chars`
- `consult` hardening: the `.git/` and `node_modules/` rules are case-insensitive (so `.GIT/` and `NODE_MODULES/` are refused too), a line range on a large file streams only the requested lines instead of loading the whole file, autoread enforces the same per-file and total size caps, and proxy mode forwards the tools-off switch instead of relying on the default
- `tools/test-consult.js`: unit tests for the path rules, prompt shape (no markdown fences, no mention of OpenCode/NOAPI/tools/agents/bridge), line ranges, size limits, EDIT parsing and validation, and autoread; plus MCP integration tests in both local and proxy mode
- `AGENTS.md` at the project root tells a non-NOAPI primary model how to use `consult` and apply the returned edits itself
- **Z.ai** (`chat.z.ai`, model id `noapi/zai`) as a supported site. The reply is read from `.chat-assistant` / `#response-content-container` using `textarea#chat-input` and the `#send-message-button`. Because the page renders every code block with a CodeMirror editor instead of `<pre>`, `extractText` re-emits those blocks as fenced code (via the shared `codeFence` helper) so tool calls survive, and the collapsed reasoning panel (`thinking-chain-container`) is skipped. The stop control is an id-less square button (`span.bg-text-inverted`) that replaces the send button while generating; it is matched without `:has()` so Firefox 115 works
- `tools/test-site-wiring.js` guards every place a site must be registered (bridge registry, MCP tool enum, `opencode.json`, both content scripts, both manifests) and is part of `npm test`
- Per-request latency instrumentation: stage timings (composer, typed, sent, first reply text, completion) travel with each reply, appear in `/health`, on the dashboard, and as a one-line summary in the bridge log
- Live streaming to OpenCode: while a site is writing, the reply is forwarded as content deltas (throttled to 150 ms). Tool calls are never streamed as visible text
- `npm run bench` latency benchmark using the fake browser tab, running the same simulated model with the old and new client behaviour and reporting four separate numbers (first streamed content, overhead after the last token, typing + send overhead, full round trip)
- `tools/lib/harness.js`: every test starts its own bridge on an OS-assigned ephemeral port and passes that port to the fake tab explicitly; `tools/test-isolation.js` checks the guarantee
- Tests for the browser error and cancel paths (mid-stream error, Esc mid-stream) and unit tests for the bridge request queue (timeout, abort, progress, partial, timings)
- `NOAPI_EARLY_RETURN=0` disables the early return on a tool call and the stop click, falling back to normal completion detection
- `NOAPI_DESC_MAX` and `NOAPI_PARAM_DESC_MAX` override the 400-character description caps for priority tools
- `NOAPI_STREAM=0` disables live content deltas and emits the reply once at the end
- A unit test suite for the streaming safety filter: plain text, prose then a block, a block at the start, the marker and fence split across updates, ordinary fenced code, a block at the very end, `TOOL_CALL` in prose, and tools disabled
- Per-site debug counters in `/health` and on the dashboard: requests, completions by stop button vs by the 2200 ms fallback, early returns, resubmits, aborted streams and timeouts
- `docs/REVIEW-latency.md`: a self-review of the completion-detection, early-return and streaming changes (failure modes, selectors, constants, and the switch/fallback that covers each)
- `tools/report-latency.js`: reads `/health` and prints, per site, the median and p90 of every stage (`composer`, `typed`, `sent`, `firstText`, `lastToken`, `complete`, `postToken`, `total`), the median `promptChars`, and the truncation canary
- Per-request `promptChars`, `replyChars` and `postToken` in the timing records, shown in `/health` and on the dashboard, so a slow turn can be told apart from a big one
- A truncation canary: after a turn ends the content script re-reads the last reply node ~1 s later and reports any late growth; the bridge logs it and counts `lateGrowth` / `lateGrowthChars` per site (both must stay 0)
- Per-request timing knobs read from the bridge environment and forwarded to the tab (`NOAPI_DEBOUNCE_MS`, `NOAPI_SSE_END_REREAD_MS`, `NOAPI_EARLY_RETURN_REREAD_MS`, `NOAPI_EXTRACT_THROTTLE_MS`, `NOAPI_FALLBACK_TICK_MS`, `NOAPI_PARTIAL_THROTTLE_MS`, `NOAPI_EARLY_RETURN_HARD_CAP_MS`); each is clamped and an unset/invalid value keeps the shipped default
- `NOAPI_DUMP_PREAMBLE=1` writes the exact first-turn prompt sent to the site into `./noapi-preamble.txt` and logs its length; `tools/prompt-report.js` reports the prompt size, each tool's marginal preamble cost, and the savings of the new preamble controls
- `NOAPI_DESC_MODE=lean` and `NOAPI_TOOL_DENY=<comma list>` (both off by default) shrink the tool preamble for the same tool set; denied tools stay callable because a call is validated against the request's tool list
- An optional `sseText` extension flag (with `NOAPI_SSE_TEXT=1`) lets the SSE observer decode the page's own stream and post the accumulated reply text as an earlier tool-call trigger. The returned reply still comes from the DOM, and a mismatch counter records any stream-vs-DOM disagreement. The ChatGPT stream parser is a documented placeholder until a captured sample is provided, so nothing is decoded yet
- Tests for `bridge/tuning.js`, the per-request tuning resolver, the lean/deny preamble controls, the lossless tool-result cleanup and `tools/report-latency.js`
- **Malformed `TOOL_CALL` recovery** (`NOAPI_TOOL_REPAIR`, on by default): when a reply carries a `TOOL_CALL` marker but no usable block, the bridge sends one short follow-up to the same chat — the problem, a one-line correct example for that tool, and "please resend only the corrected block" — and parses the answer instead of handing the broken block to OpenCode. At most two repairs per user turn; after that the last reply is returned as before and the reason is logged (`tool repair: attempt 1/2 reason=… tool=…`). The follow-up never repeats the preamble. Flattened calls (arguments beside `name` instead of inside an `arguments` object) are accepted only when every key is a parameter of that tool's schema; invalid JSON is never repaired by guessing quotes

### Changed

- `waitForIdle` now checks the idle condition once immediately instead of always sleeping 700 ms before the first look; it returns at once when the site is already idle and still notices a cancel during the wait
- A tool result is cleaned losslessly before it is clipped: ANSI escape sequences are stripped, line endings normalised, trailing whitespace trimmed and runs of blank lines collapsed
- `tools/prompt-report.js` and `tools/report-latency.js` are documented in the README, with a manual real-site procedure (20 turns, report, re-run with tuned values, compare `postToken` / `total` / `lateGrowth`)
- The README notes that `NOAPI_MAX_TOOL_RESULT` of 6000–8000 is worth trying and what it trades off, and the privacy section explains that stream decoding is opt-in and local
- Completion is detected from the site's stop button disappearing plus a short per-site debounce (350-550 ms) instead of a fixed 2200 ms of no change; a MutationObserver wakes the watcher only when the page changes
- Typing a prompt is condition-based (poll until the composer really holds the text) instead of fixed sleeps, and the page snapshot is no longer taken on every request
- When tools are enabled, a complete `TOOL_CALL` block is returned as soon as it settles instead of waiting for the whole reply. The grace window is configurable (`NOAPI_EARLY_RETURN_MS`, default 400 ms) and the early return must name a real tool in a balanced, parses-as-JSON block; while the site is still generating, the window is extended up to a 1500 ms hard cap so a second block is not lost, and the reply node is re-read once after the stop click to avoid a truncated block
- The tool preamble asks for independent calls to be batched in one reply, prefers grep/glob over reading files one by one, and shows a concrete batching example
- Tool results are trimmed to 16,000 characters by default (`NOAPI_MAX_TOOL_RESULT`); the truncation marker reports how many characters were cut and suggests a narrower re-run (offset/limit, grep, head/tail)
- Tool descriptions are no longer clipped uniformly: tools whose semantics are subtle (edit, write, bash, read, patch-like, or anything with an `oldString`/`newString`/`replace` parameter) keep up to 400 characters, while the rest stay short
- The preamble is only re-sent when tool names or parameter schemas change, not when descriptions change
- The tool-call parser is stricter: a `TOOL_CALL` block whose `arguments` string does not parse as JSON, or whose flattened keys are not all parameters of the named tool, is refused instead of being executed with empty arguments

### Fixed

- `NOAPI_AUTOREAD` no longer re-attaches the same files on every turn: it scans only the latest real user message and attaches files only when that message is the last one in the conversation (the first turn of a task), so a `TOOL_RESULT` continuation attaches nothing. System, assistant and earlier-user messages are ignored, so an `AGENTS.md` named only by OpenCode's own instructions is not pulled in. Detection is strict (prose such as `/**`, `/what`, `/current`, `/zai` or `/containment` is not a path and logs nothing), the same file named in both slash styles attaches once, and a leading UTF-8 BOM is stripped from the content
- Cancelling a request no longer releases the site's queue slot before the browser tab has actually stopped. The caller still gets its cancellation immediately, but the next request waits for the tab's terminal message (`cancelled` ack, `response` or `error`), the socket closing, or a 5 s safety timeout (`NOAPI_CANCEL_ACK_MS`). Late messages for a cancelled id are recognised and ignored instead of being mistaken for the next request's answer
- A tab that reports `busy` ("already handling a prompt") is now retried with short backoff (100 ms growing to 500 ms, giving up after ~10 s) instead of surfacing a 503 to OpenCode
- The extension background only serves a request from a tab of the requested site (no cross-site fallback), accepts `noapi-tab` ports only from the top frame, sends `hello-update` only on a real change, and tells the bridge when a closed tab leaves a site with no tab (`site-gone`)
- The content script's busy guard reports `code: "busy"`; cancelling now wakes sleeps immediately, is checked in `waitForComposer` / `ensureTyped` / `submitComposer` / `waitForIdle`, and clears typed-but-unsent text so it cannot leak into the next request
- Tests can no longer reach a real bridge or type into a real chat tab: each runner binds an ephemeral port (`--port=0`) and hands it to the fake tab, and refuses to use the default port at all

## [0.1.0] - 2026-10-11

First public release. 🎉

### ✨ Added

- Local bridge in plain Node.js with an OpenAI compatible endpoint (`/v1/chat/completions`, `/v1/models`), a health endpoint and a status dashboard
- MCP server over stdio with the `chat`, `status` and `sites` tools, plus a proxy mode that forwards to an already running bridge
- Browser extension for Chrome based browsers (Manifest V3) and Firefox
- Support for ChatGPT, Claude, Gemini, DeepSeek, Perplexity, Grok and Mistral
- **Tool use** for chat websites: the bridge teaches the model a small `TOOL_CALL` text format and turns its replies into real tool calls for OpenCode
- Live "Thinking" status in OpenCode while the website types, sends and answers
- Per site request queue, and cancel support: pressing Esc in OpenCode also stops generation on the website
- Local handling of OpenCode's session title requests, so they do not clutter your chats
- `npm run install-global` to register NOAPI? in the global OpenCode config, so it works from any project folder
- Test suite with a fake browser tab: plain replies, streaming, MCP in both modes, a full tool call round trip and security checks
- README, contributing guide, security policy, code of conduct, issue and pull request templates, and a CI workflow

### 🔧 Changed

- The extension is now fully automatic. The manual "click to send" mode was removed
- Only the assistant's reply is sent back to OpenCode, not the whole page
- Progress updates are no longer dropped, so the status shown in OpenCode matches what the page is doing

### 🐛 Fixed

- DeepSeek entering edit mode on the previous message instead of sending a new one
- DeepSeek prompts that were never sent because the page cleared the chat box. The extension now checks that the text stayed and types it again if needed
- The send button on DeepSeek is now only looked for next to the chat box, so message icons such as edit or copy are never clicked by mistake
- The first prompt of a new chat sometimes not being sent

### 🔐 Security

- The bridge now rejects HTTP requests and WebSocket connections from web pages and from non local hosts. Before this, any website open in your browser could have reached the bridge on `127.0.0.1`. Only the extension, local tools and the dashboard are accepted
- Removed the wildcard `Access-Control-Allow-Origin` header

[Unreleased]: https://github.com/YOUR_USERNAME/noapi/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/YOUR_USERNAME/noapi/releases/tag/v0.1.0
