# Project instructions

NOAPI? bridges OpenCode to AI chat websites running in the browser. Plain
Node.js (18+), ESM, no build step, no dependencies.

## Working in this repo

- Run `npm test` before calling a change done. It starts its own ephemeral
  bridges and a fake browser tab; it must never touch a real bridge on port
  8787 or a real chat tab.
- `bridge/` is plain Node ESM. The two content scripts
  (`extension/chrome/content.js` and `extension/firefox/content.js`) are the
  same code — change both.
- Adding or fixing a site touches `bridge/sites.js`, `bridge/mcp.js`,
  `opencode.json`, both content scripts and both manifests.
  `tools/test-site-wiring.js` guards every spot.
- Keep `README.md` and `CHANGELOG.md` in step with behaviour changes.

## For hard analysis or large refactors: use `consult`

Do not grind through a big or subtle change entirely inline. The `noapi` MCP
server exposes a `consult` tool that sends the files you name, plus a question,
to a strong web model and returns its answer. Use it, then apply the changes
yourself.

1. Call `consult` with:
   - `question` — what you want to know or fix;
   - `files` — paths relative to the workspace, each optionally with a 1-based
     range (`bridge/consult.js:1-120`);
   - `mode` — `explain` or `review` for analysis, `patch` to ask for edits.
2. Read the reply. With `mode: "patch"` it ends with a `--- consult validation ---`
   report, one line per block: `ok`, `SEARCH not found`, `SEARCH found N times`,
   `file not found or unreadable`, `SEARCH block is empty`, or `refused`.
3. Apply each `ok` block with your own `edit` tool. If a block does not match,
   re-read the file (it may have changed), adjust, or send the fresh content
   back through `consult` and try again.
4. **Never send secrets.** `.env*`, `*.pem`, `*.key`, `id_rsa*`, `.git/` and
   `node_modules/` are refused automatically, but you are responsible for what
   you choose to send — the file contents go to the website.
