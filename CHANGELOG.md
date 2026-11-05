# 📜 Changelog

All notable changes to this project are written here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Per-request latency instrumentation: stage timings (composer, typed, sent, first reply text, completion) travel with each reply, appear in `/health`, on the dashboard, and as a one-line summary in the bridge log
- Live streaming to OpenCode: while a site is writing, the reply is forwarded as content deltas (throttled to 150 ms). Tool calls are never streamed as visible text
- `npm run bench` latency benchmark using the fake browser tab, running the same simulated model with the old and new client behaviour and reporting four separate numbers (first streamed content, overhead after the last token, typing + send overhead, full round trip)
- `tools/lib/harness.js`: every test starts its own bridge on an OS-assigned ephemeral port and passes that port to the fake tab explicitly; `tools/test-isolation.js` checks the guarantee
- Tests for the browser error and cancel paths (mid-stream error, Esc mid-stream) and unit tests for the bridge request queue (timeout, abort, progress, partial, timings)
- `NOAPI_EARLY_RETURN=0` disables the early return on a tool call and the stop click, falling back to normal completion detection

### Changed

- Completion is detected from the site's stop button disappearing plus a short per-site debounce (350-550 ms) instead of a fixed 2200 ms of no change; a MutationObserver wakes the watcher only when the page changes
- Typing a prompt is condition-based (poll until the composer really holds the text) instead of fixed sleeps, and the page snapshot is no longer taken on every request
- When tools are enabled, a complete `TOOL_CALL` block is returned as soon as it settles instead of waiting for the whole reply. The grace window is configurable (`NOAPI_EARLY_RETURN_MS`, default 400 ms) and the early return must name a real tool in a balanced, parses-as-JSON block; while the site is still generating, the window is extended up to a 1500 ms hard cap so a second block is not lost, and the reply node is re-read once after the stop click to avoid a truncated block
- The tool preamble asks for independent calls to be batched in one reply, prefers grep/glob over reading files one by one, and shows a concrete batching example
- Tool results are trimmed to 10,000 characters by default (`NOAPI_MAX_TOOL_RESULT`), and tool descriptions in the preamble are shorter
- The preamble is only re-sent when tool names or parameter schemas change, not when descriptions change

### Fixed

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
