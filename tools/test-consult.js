// Tests for `consult` mode (bridge/consult.js) and the MCP `consult` tool.
//
// The first half is pure unit testing (path rules, prompt building, EDIT block
// parsing/validation, autoread) with no browser and no bridge. The second half
// drives the real MCP server through the fake browser tab, in both local and
// proxy mode, exactly like tools/test-all.js does.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ConsultError,
  allowedRoots,
  parseFileArg,
  parseEditBlocks,
  validateEditBlocks,
  validationReport,
  buildConsultPrompt,
  buildPromptText,
  autoreadBlock,
} from "../bridge/consult.js";
import { startBridge, startFake, spawnProxy, stopAll, waitForHealth, sleep, warnIfDefaultBridge } from "./lib/harness.js";
import { ProxyGateway } from "../bridge/mcp.js";

let failed = 0;
function ok(name, cond, detail) {
  if (cond) console.log("ok:", name);
  else {
    console.error("FAIL:", name, detail === undefined ? "" : detail);
    failed++;
  }
}
function throwsWith(fn, substr, label) {
  try {
    fn();
    ok(label, false, "did not throw");
  } catch (err) {
    ok(label, err instanceof ConsultError && String(err.message).includes(substr), `${err.name}: ${err.message}`);
  }
}

// ---------------------------------------------------------------- fixtures
const cwd = process.cwd();
const TMP = path.join(cwd, "consult-tmp");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(path.join(TMP, "node_modules"), { recursive: true });
fs.mkdirSync(path.join(TMP, ".git"), { recursive: true });

const SAMPLE_LINES = Array.from({ length: 60 }, (_, i) => `L${i}`);
fs.writeFileSync(path.join(TMP, "sample.txt"), SAMPLE_LINES.join("\n"));
fs.writeFileSync(path.join(TMP, "big.txt"), "x".repeat(50));
fs.writeFileSync(path.join(TMP, "a.txt"), "a".repeat(30));
fs.writeFileSync(path.join(TMP, "b.txt"), "b".repeat(30));
fs.writeFileSync(path.join(TMP, "edit.txt"), "hello\nworld\n");
fs.writeFileSync(path.join(TMP, ".env"), "SECRET=1\n");
fs.writeFileSync(path.join(TMP, "key.pem"), "-----BEGIN KEY-----\n");
fs.writeFileSync(path.join(TMP, "id_rsa"), "private\n");
fs.writeFileSync(path.join(TMP, "node_modules", "mod.js"), "module.exports = 1;\n");
fs.writeFileSync(path.join(TMP, ".git", "config"), "[core]\n");

// Case variants of the protected directories. On a case-insensitive filesystem
// these are the same real directories as the lowercase spellings above.
fs.mkdirSync(path.join(TMP, ".GIT"), { recursive: true });
fs.writeFileSync(path.join(TMP, ".GIT", "secret.txt"), "git secret\n");
fs.mkdirSync(path.join(TMP, "NODE_MODULES"), { recursive: true });
fs.writeFileSync(path.join(TMP, "NODE_MODULES", "mod.js"), "module.exports = 2;\n");
fs.mkdirSync(path.join(TMP, "Node_Modules"), { recursive: true });
fs.writeFileSync(path.join(TMP, "Node_Modules", "mod.js"), "module.exports = 3;\n");

// Autoread size fixture: over a small per-file limit but within the read cap.
fs.writeFileSync(path.join(TMP, "auto-mid.txt"), "y".repeat(200));
// Larger than the in-memory read cap, so a ranged read must stream its head.
fs.writeFileSync(path.join(TMP, "huge.txt"), "head one\nhead two\n" + "z".repeat(300_000));
// A trailing newline must not become a phantom line.
fs.writeFileSync(path.join(TMP, "trail.txt"), "alpha\nbeta\n");

const ENV = {}; // no extra roots, shipped size limits
const resolve = (arg, env = ENV) => buildConsultPrompt({ question: "What does this do?", files: [arg], mode: "explain", cwd, env });

// -------------------------------------------------------------- path parsing
ok("parseFileArg reads a plain path", JSON.stringify(parseFileArg("a/b.js")) === JSON.stringify({ path: "a/b.js", start: null, end: null }));
ok("parseFileArg reads a line range", JSON.stringify(parseFileArg("a/b.js:10-40")) === JSON.stringify({ path: "a/b.js", start: 10, end: 40 }));
ok("parseFileArg keeps a Windows drive letter", JSON.stringify(parseFileArg("C:\\x\\y.js:2-3")) === JSON.stringify({ path: "C:\\x\\y.js", start: 2, end: 3 }), JSON.stringify(parseFileArg("C:\\x\\y.js:2-3")));

// -------------------------------------------------------------- secret rules
throwsWith(() => resolve("consult-tmp/.env"), "environment files", ".env is refused");
throwsWith(() => resolve("consult-tmp/key.pem"), "*.pem", "*.pem is refused");
throwsWith(() => resolve("consult-tmp/id_rsa"), "id_rsa", "id_rsa* is refused");
throwsWith(() => resolve("consult-tmp/node_modules/mod.js"), "node_modules", "node_modules is refused");
throwsWith(() => resolve("consult-tmp/.git/config"), ".git", ".git is refused");
throwsWith(() => resolve("consult-tmp/.GIT/secret.txt"), ".git", "a .GIT (case variant) directory is refused");
throwsWith(() => resolve("consult-tmp/NODE_MODULES/mod.js"), "node_modules", "a NODE_MODULES (case variant) directory is refused");
throwsWith(() => resolve("consult-tmp/Node_Modules/mod.js"), "node_modules", "a Node_Modules (case variant) directory is refused");

// -------------------------------------------------------------- containment
throwsWith(() => resolve("../outside.txt"), "outside the allowed roots", ".. traversal is refused");
throwsWith(() => resolve(path.join(cwd, "..", "outside.txt")), "outside the allowed roots", "absolute path above cwd is refused");
if (process.platform === "win32") {
  throwsWith(() => resolve("C:\\Windows\\win.ini"), "outside the allowed roots", "an unrelated absolute path is refused");
}

// A directory junction/symlink inside the root that points outside must not be a
// way out. Junctions do not need special privileges on Windows; POSIX ignores
// the type argument.
{
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "consult-outside-"));
  fs.writeFileSync(path.join(outside, "escape.txt"), "outside content\n");
  const linkDir = path.join(TMP, "escape");
  let linked = false;
  try {
    fs.symlinkSync(outside, linkDir, "junction");
    linked = true;
  } catch {}
  if (linked) {
    throwsWith(() => resolve("consult-tmp/escape/escape.txt"), "outside the allowed roots", "a symlinked-out file is refused");
    try {
      fs.unlinkSync(linkDir);
    } catch {}
  } else {
    console.log("skip: could not create a symlink in this environment");
  }
  fs.rmSync(outside, { recursive: true, force: true });
}

// -------------------------------------------------------------- extra roots
{
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "consult-root-"));
  fs.writeFileSync(path.join(outside, "allowed.txt"), "allowed\n");
  const env = { NOAPI_CONSULT_ROOTS: outside };
  const allowedAbs = path.join(outside, "allowed.txt");
  ok("a file under NOAPI_CONSULT_ROOTS is accepted", resolve(allowedAbs, env).prompt.includes("===== FILE: allowed.txt"));
  ok("allowedRoots includes cwd and the extra root", allowedRoots({ cwd, env }).length === 2, JSON.stringify(allowedRoots({ cwd, env })));
  throwsWith(() => resolve(allowedAbs, {}), "outside the allowed roots", "the same file is refused without the extra root");
  fs.rmSync(outside, { recursive: true, force: true });
}

// -------------------------------------------------------------- size limits
throwsWith(
  () => buildConsultPrompt({ question: "q", files: ["consult-tmp/big.txt"], mode: "explain", cwd, env: { NOAPI_CONSULT_MAX_FILE: "10" } }),
  "per-file limit of 10",
  "per-file limit is enforced"
);
throwsWith(
  () => buildConsultPrompt({ question: "q", files: ["consult-tmp/big.txt"], mode: "explain", cwd, env: { NOAPI_CONSULT_MAX_FILE: "10" } }),
  "50 characters",
  "per-file error names the size"
);
throwsWith(
  () =>
    buildConsultPrompt({
      question: "q",
      files: ["consult-tmp/a.txt", "consult-tmp/b.txt"],
      mode: "explain",
      cwd,
      env: { NOAPI_CONSULT_MAX_FILE: "100", NOAPI_CONSULT_MAX_TOTAL: "40" },
    }),
  "total 60 characters",
  "total budget is enforced"
);
{
  let msg = "";
  try {
    buildConsultPrompt({
      question: "q",
      files: ["consult-tmp/a.txt", "consult-tmp/b.txt"],
      mode: "explain",
      cwd,
      env: { NOAPI_CONSULT_MAX_FILE: "100", NOAPI_CONSULT_MAX_TOTAL: "40" },
    });
  } catch (err) {
    msg = err.message;
  }
  ok("total error lists each file's size", msg.includes("consult-tmp/a.txt=30") && msg.includes("consult-tmp/b.txt=30"), msg);
}

// ------------------------------------------------------- bounded ranged reads
{
  const huge = buildConsultPrompt({ question: "q", files: ["consult-tmp/huge.txt:1-2"], mode: "explain", cwd, env: ENV });
  ok(
    "a line range on a large file reads only the head",
    huge.prompt.includes("head one") && huge.prompt.includes("head two") && !huge.prompt.includes("zzzz"),
    huge.prompt.slice(0, 160)
  );
  ok("a bounded read does not fabricate a total", huge.prompt.includes("(lines 1-2)"), huge.prompt.slice(0, 140));
  throwsWith(
    () => buildConsultPrompt({ question: "q", files: ["consult-tmp/huge.txt"], mode: "explain", cwd, env: ENV }),
    "per-file read limit",
    "a huge file without a range is refused"
  );
}
{
  const trail = buildConsultPrompt({ question: "q", files: ["consult-tmp/trail.txt"], mode: "explain", cwd, env: ENV });
  ok(
    "a trailing newline does not add a phantom line",
    trail.prompt.includes("(lines 1-2 of 2)") && !/\n3: /.test(trail.prompt),
    JSON.stringify(trail.prompt.slice(0, 140))
  );
}

// -------------------------------------------------------------- prompt shape
const explain = resolve("consult-tmp/sample.txt");
ok("prompt opens with the project sentence", explain.prompt.startsWith("Here are files from my project."));
ok("prompt has the FILE delimiter", explain.prompt.includes("===== FILE: consult-tmp/sample.txt (lines 1-60 of 60) ====="));
ok("prompt has the END FILE delimiter", explain.prompt.includes("===== END FILE ====="));
ok("prompt includes the file contents", explain.prompt.includes("L59"));
ok("prompt has the request", explain.prompt.includes("My request: What does this do?"));
ok("prompt has no markdown fences", !explain.prompt.includes("```"));
ok(
  "prompt never names OpenCode/NOAPI/tools/TOOL_CALL/agent/bridge",
  !/(OpenCode|NOAPI|tool|TOOL_CALL|agent|bridge)/i.test(explain.prompt),
  explain.prompt.slice(0, 200)
);

const patch = buildConsultPrompt({ question: "rename it", files: ["consult-tmp/sample.txt"], mode: "patch", cwd, env: ENV });
ok("patch mode adds no line-number prefixes", !/\n1: L0/.test(patch.prompt) && patch.prompt.includes("\nL0\n"));
ok("explain mode adds line numbers", /\n1: L0\n/.test(explain.prompt), JSON.stringify(explain.prompt.slice(0, 120)));
ok("patch mode asks for EDIT blocks", patch.prompt.includes("===== EDIT: <path> =====") && patch.prompt.includes("SEARCH"));

const ranged = resolve("consult-tmp/sample.txt:10-12");
ok("a line range narrows the header", ranged.prompt.includes("(lines 10-12 of 60)"));
ok("a line range includes only those lines", ranged.prompt.includes("10: L9") && !ranged.prompt.includes("13: L12"));
ok("a range of lines is shorter than the whole file", ranged.files[0].chars < explain.files[0].chars);

// -------------------------------------------------------------- EDIT parsing
const reply = [
  "Here you go.",
  "===== EDIT: consult-tmp/edit.txt =====",
  "<<<<<<< SEARCH",
  "hello",
  "=======",
  "goodbye",
  ">>>>>>> REPLACE",
  "===== END EDIT =====",
].join("\n");
const parsed = parseEditBlocks(reply);
ok("parseEditBlocks finds one block", parsed.length === 1, JSON.stringify(parsed));
ok("parseEditBlocks reads the path", parsed[0].path === "consult-tmp/edit.txt");
ok("parseEditBlocks reads SEARCH", parsed[0].search === "hello");
ok("parseEditBlocks reads REPLACE", parsed[0].replace === "goodbye");

// Long delimiters, CRLF, deletion (empty replacement), and a malformed block
// that must not swallow the well-formed block after it.
{
  const sixEq = [
    "====== EDIT: consult-tmp/edit.txt ======",
    "<<<<<<< SEARCH",
    "hello",
    "=======",
    "goodbye",
    ">>>>>>> REPLACE",
    "====== END EDIT ======",
  ].join("\n");
  const p6 = parseEditBlocks(sixEq);
  ok("a 6-'=' EDIT delimiter is parsed", p6.length === 1 && p6[0].search === "hello", JSON.stringify(p6));

  const crlf =
    "===== EDIT: consult-tmp/edit.txt =====\r\n<<<<<<< SEARCH\r\nhello\r\n=======\r\ngoodbye\r\n>>>>>>> REPLACE\r\n===== END EDIT =====";
  const pc = parseEditBlocks(crlf);
  ok("a CRLF reply parses", pc.length === 1 && pc[0].replace === "goodbye", JSON.stringify(pc));

  const del = parseEditBlocks(
    ["===== EDIT: consult-tmp/edit.txt =====", "<<<<<<< SEARCH", "hello", "=======", ">>>>>>> REPLACE", "===== END EDIT ====="].join("\n")
  );
  ok("an empty replacement (deletion) parses", del.length === 1 && del[0].replace === "", JSON.stringify(del));

  const malformed = [
    "===== EDIT: consult-tmp/edit.txt =====",
    "<<<<<<< SEARCH",
    "hello",
    "=======",
    "goodbye",
    ">>>> REPLACE",
    "===== END EDIT =====",
    "===== EDIT: consult-tmp/edit.txt =====",
    "<<<<<<< SEARCH",
    "world",
    "=======",
    "earth",
    ">>>>>>> REPLACE",
    "===== END EDIT =====",
  ].join("\n");
  const pm = parseEditBlocks(malformed);
  ok("a malformed block does not swallow the next one", pm.length === 1 && pm[0].search === "world", JSON.stringify(pm));

  const two = parseEditBlocks(
    [
      "===== EDIT: consult-tmp/edit.txt =====",
      "<<<<<<< SEARCH",
      "hello",
      "=======",
      "goodbye",
      ">>>>>>> REPLACE",
      "===== END EDIT =====",
      "===== EDIT: consult-tmp/edit.txt =====",
      "<<<<<<< SEARCH",
      "world",
      "=======",
      "earth",
      ">>>>>>> REPLACE",
      "===== END EDIT =====",
    ].join("\n")
  );
  ok("two blocks parse", two.length === 2 && two[0].replace === "goodbye" && two[1].replace === "earth", JSON.stringify(two));
}

const editFile = path.join(TMP, "edit.txt");
const one = validateEditBlocks([{ path: "consult-tmp/edit.txt", search: "hello", replace: "x" }], { roots: [cwd], cwd });
ok("validator: found once -> ok", one[0].status === "ok" && one[0].occurrences === 1);
const none = validateEditBlocks([{ path: "consult-tmp/edit.txt", search: "missing", replace: "x" }], { roots: [cwd], cwd });
ok("validator: not found", none[0].status === "not-found");
const many = validateEditBlocks([{ path: "consult-tmp/edit.txt", search: "o", replace: "x" }], { roots: [cwd], cwd });
ok("validator: found multiple times", many[0].status === "multiple" && many[0].occurrences > 1, JSON.stringify(many[0]));
const missing = validateEditBlocks([{ path: "consult-tmp/nope.txt", search: "x", replace: "y" }], { roots: [cwd], cwd });
ok("validator: missing file", missing[0].status === "missing-file", JSON.stringify(missing[0]));
const rejected = validateEditBlocks([{ path: "consult-tmp/.env", search: "x", replace: "y" }], { roots: [cwd], cwd });
ok("validator: secret path is refused", rejected[0].status === "rejected", JSON.stringify(rejected[0]));
const rejGit = validateEditBlocks([{ path: "consult-tmp/.GIT/secret.txt", search: "x", replace: "y" }], { roots: [cwd], cwd });
ok("validator: a .GIT case variant is rejected", rejGit[0].status === "rejected", JSON.stringify(rejGit[0]));
const rejUp = validateEditBlocks([{ path: "../outside.txt", search: "x", replace: "y" }], { roots: [cwd], cwd });
ok("validator: a .. path is rejected", rejUp[0].status === "rejected", JSON.stringify(rejUp[0]));
const rejAbs = validateEditBlocks([{ path: path.join(cwd, "..", "outside.txt"), search: "x", replace: "y" }], { roots: [cwd], cwd });
ok("validator: an absolute out-of-root path is rejected", rejAbs[0].status === "rejected", JSON.stringify(rejAbs[0]));
ok("validation report names the block and status", validationReport(one).includes("block 1 (consult-tmp/edit.txt): ok"));
ok("validation report has no report for zero blocks", validationReport([]) === "");
ok("edit.txt still exists untouched (validator never writes)", fs.readFileSync(editFile, "utf8") === "hello\nworld\n");

// -------------------------------------------------------------- autoread
const absSample = path.join(TMP, "sample.txt");
const auto = autoreadBlock([{ role: "user", content: `please inspect ${absSample}` }], { cwd, env: ENV });
ok("autoread appends an absolute path the user mentioned", auto.includes("===== FILE: consult-tmp/sample.txt"));
ok("autoread uses the same line-numbered block as explain", auto.includes("1: L0"));
ok("autoread ignores tool results", autoreadBlock([{ role: "tool", content: absSample }], { cwd, env: ENV }) === "");
ok("autoread appends nothing when no path is mentioned", autoreadBlock([{ role: "user", content: "hello" }], { cwd, env: ENV }) === "");

// A plain relative path is not "absolute", so nothing is appended.
ok("autoread ignores relative paths", autoreadBlock([{ role: "user", content: "look at consult-tmp/sample.txt" }], { cwd, env: ENV }) === "");

// Autoread must honour the same per-file and total limits as `consult`.
{
  const autoMid = path.join(TMP, "auto-mid.txt");
  const skipped = autoreadBlock([{ role: "user", content: `inspect ${autoMid}` }], { cwd, env: { NOAPI_CONSULT_MAX_FILE: "100" } });
  ok("autoread skips a file over the per-file character limit", skipped === "", JSON.stringify(skipped.slice(0, 80)));

  const capped = autoreadBlock(
    [{ role: "user", content: `check ${path.join(TMP, "a.txt")} and ${path.join(TMP, "b.txt")}` }],
    { cwd, env: { NOAPI_CONSULT_MAX_TOTAL: "40" } }
  );
  ok(
    "autoread stops at the total limit",
    capped.includes("consult-tmp/a.txt") && !capped.includes("consult-tmp/b.txt"),
    capped.slice(0, 140)
  );
}

// The proxy gateway must forward the tool switch (bug: it was dropped).
{
  const g = new ProxyGateway("ws://127.0.0.1:1/ws");
  const sent = [];
  g._call = (payload) => {
    sent.push(payload);
    return Promise.resolve("ok");
  };
  await g.requestPrompt({ prompt: "p", toolsEnabled: false });
  ok("proxy request forwards tools_enabled=false", sent[0]?.tools_enabled === false, JSON.stringify(sent[0]));
  await g.requestPrompt({ prompt: "p", toolsEnabled: true });
  ok("proxy request forwards tools_enabled=true", sent[1]?.tools_enabled === true, JSON.stringify(sent[1]));
}

// Windows-specific: drive-relative backslash paths and case-insensitive compare.
if (process.platform === "win32") {
  const winAbs = path.join(TMP, "sample.txt");
  const upper = winAbs.toUpperCase();
  const mixed = winAbs.replace(/\\/g, "/");
  ok("a Windows path with backslashes resolves", resolve(winAbs).prompt.includes("consult-tmp/sample.txt"));
  ok("mixed slashes resolve", resolve(mixed).prompt.includes("consult-tmp/sample.txt"));
  ok("drive-letter case is ignored", resolve(upper).files[0].rel.toLowerCase() === "consult-tmp/sample.txt");
}

// ------------------------------------------------------- MCP integration
const EDIT_REPLY = [
  "Sure, here is the change.",
  "",
  "===== EDIT: consult-tmp/edit.txt =====",
  "<<<<<<< SEARCH",
  "hello",
  "=======",
  "goodbye",
  ">>>>>>> REPLACE",
  "===== END EDIT =====",
  "",
  "That renames the greeting.",
].join("\n");

function rpc(proc, obj) {
  proc.stdin.write(JSON.stringify(obj) + "\n");
}
function collect(proc) {
  const out = [];
  proc.stdout.on("data", (d) => {
    for (const line of d.toString("utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch {}
    }
  });
  return out;
}
const initMsg = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } };

await warnIfDefaultBridge();

// --- local mode: the MCP process starts its own bridge ----------------------
{
  console.log("\n7. MCP consult (local mode)...");
  const { port: LOCAL_PORT, proc: mcpLocal } = await startBridge({ mcp: true });
  const out = collect(mcpLocal);
  const fake = startFake({ port: LOCAL_PORT, site: "chatgpt", env: { NOAPI_FAKE_FIRST_MS: "120", NOAPI_FAKE_REPLY: EDIT_REPLY } });
  await waitForHealth(LOCAL_PORT, { clients: true });

  rpc(mcpLocal, initMsg);
  await sleep(300);
  rpc(mcpLocal, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  await sleep(300);
  rpc(mcpLocal, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "consult", arguments: { question: "rename hello to goodbye", files: ["consult-tmp/edit.txt"], mode: "patch", site: "chatgpt" } },
  });
  await sleep(2500);
  mcpLocal.kill();
  fake.kill();

  const list = out.find((m) => m.id === 2);
  ok("tools/list exposes consult", !!list?.result?.tools?.some((t) => t.name === "consult"), JSON.stringify(list).slice(0, 200));

  const call = out.find((m) => m.id === 3);
  const text = call?.result?.content?.[0]?.text || "";
  ok("local consult returns the website reply", text.includes("Sure, here is the change."), JSON.stringify(call).slice(0, 300));
  ok("local consult appends the validation report", text.includes("block 1 (consult-tmp/edit.txt): ok"), text.slice(-200));
  ok("edit.txt was not modified by consult", fs.readFileSync(editFile, "utf8") === "hello\nworld\n");
}

// --- proxy mode: a standalone bridge answers the MCP process ----------------
{
  console.log("8. MCP consult (proxy mode)...");
  const { port: PORT, proc: bridgeProc } = await startBridge();
  const PROXY_EDIT = [
    "PROXY_CONSULT: here is a change.",
    "===== EDIT: consult-tmp/edit.txt =====",
    "<<<<<<< SEARCH",
    "hello",
    "=======",
    "goodbye",
    ">>>>>>> REPLACE",
    "===== END EDIT =====",
  ].join("\n");
  const fake = startFake({ port: PORT, site: "claude", env: { NOAPI_FAKE_FIRST_MS: "120", NOAPI_FAKE_REPLY: PROXY_EDIT } });
  await waitForHealth(PORT, { clients: true });

  const proxy = spawnProxy(PORT);
  const out = collect(proxy);
  rpc(proxy, initMsg);
  await sleep(500);
  rpc(proxy, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "consult", arguments: { question: "review this file", files: ["consult-tmp/edit.txt"], mode: "review", site: "claude" } },
  });
  await sleep(2500);
  rpc(proxy, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "consult", arguments: { question: "rename it", files: ["consult-tmp/edit.txt"], mode: "patch", site: "claude" } },
  });
  await sleep(2500);
  proxy.kill();
  bridgeProc.kill();
  fake.kill();

  const call = out.find((m) => m.id === 3);
  const text = call?.result?.content?.[0]?.text || "";
  ok("proxy consult returns the website reply", text.includes("PROXY_CONSULT"), JSON.stringify(call).slice(0, 300));
  ok("proxy review mode does not add a validation report", !text.includes("consult validation"));

  const patched = out.find((m) => m.id === 4)?.result?.content?.[0]?.text || "";
  ok("proxy patch mode appends the validation report", patched.includes("block 1 (consult-tmp/edit.txt): ok"), patched.slice(-200));
}

// ---------------------------------------------------------------- teardown
fs.rmSync(TMP, { recursive: true, force: true });
stopAll();

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nall consult tests passed");
