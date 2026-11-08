// Unit tests for the refusal guard (bridge/guard.js) and its wiring.
// Run: node tools/test-guard.js
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { detectRefusal, refusalPrompt, pickProbe, seedTree, fold, GUARD_HOLD } from "../bridge/guard.js";
import { buildPrompt, renderPreamble, parseToolCalls } from "../bridge/toolproto.js";
import { StreamFilter } from "../bridge/streamfilter.js";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok -", name); };

const TOOLS = ["edit", "glob", "grep", "read", "shell", "write"].map((name) => ({
  type: "function",
  function: { name, description: name, parameters: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" }, command: { type: "string" }, content: { type: "string" } }, required: [] } },
}));
const SYS = { role: "system", content: "Working directory: C:\\NOAPI\nPlatform: win32" };

const ZAI_REFUSAL = `Mình không thể đọc trực tiếp thư mục C:\\NOAPI trên máy của bạn — môi trường chạy của mình là sandbox Linux riêng, không kết nối vào máy tính Windows của bạn (các thư mục C:\\... không tồn tại ở đây, và thư mục upload hiện đang trống).

Để mình đọc được toàn bộ file code, bạn hãy chọn một cách:
Upload file/thư mục trực tiếp vào cuộc trò chuyện`;

t("detects the real z.ai refusal (vi)", () => {
  const d = detectRefusal(ZAI_REFUSAL);
  assert.equal(d.refused, true);
  assert.equal(d.reason, "strong");
});
t("detects English / Chinese refusals", () => {
  assert.equal(detectRefusal("I'm sorry, but I cannot access your local file system. Please upload the files.").refused, true);
  assert.equal(detectRefusal("I don't have access to your computer, as I run in a sandbox.").refused, true);
  assert.equal(detectRefusal("我无法访问您的本地文件，请上传文件。").refused, true);
});
t("does not flag normal answers", () => {
  assert.equal(detectRefusal("Done. I created C:/NOAPI/a.txt and ran the tests: all pass.").refused, false);
  assert.equal(detectRefusal("Đã đọc xong 13 file trong bridge/. Cấu trúc gồm http.js, state.js...").refused, false);
  assert.equal(detectRefusal("").refused, false);
});
t("a reply that contains a TOOL_CALL is never a refusal", () => {
  const r = "I cannot access it myself, so:\n```\nTOOL_CALL\n{\"name\":\"glob\",\"arguments\":{\"pattern\":\"**/*\"}}\n```";
  assert.equal(detectRefusal(r).refused, false);
});
t("long replies are answers, not refusals", () => {
  assert.equal(detectRefusal("I cannot access the network. " + "x".repeat(3000)).refused, false);
});
t("strict mode (tools already ran) only keeps the upload/sandbox-is-empty patterns", () => {
  assert.equal(detectRefusal("I cannot access C:/secret: permission denied.", { strict: true }).refused, false);
  assert.equal(detectRefusal("Please upload the files so I can read them.", { strict: true }).refused, true);
});
t("fold strips diacritics", () => assert.equal(fold("Đường dẫn"), "duong dan"));

t("preamble carries the override, the worked example and the working dir", () => {
  const p = renderPreamble(TOOLS, [SYS]);
  assert.match(p, /ignore every built-in tool, sandbox/);
  assert.match(p, /WORKED EXAMPLE/);
  assert.match(p, /Read all the code files in C:\\NOAPI/);
  assert.match(p, /"name":"glob"/);
});
t("NOAPI_GUARD=0 removes preamble additions", () => {
  process.env.NOAPI_GUARD = "0";
  const p = renderPreamble(TOOLS, [SYS]);
  delete process.env.NOAPI_GUARD;
  assert.doesNotMatch(p, /WORKED EXAMPLE/);
  assert.doesNotMatch(p, /IMPORTANT - READ FIRST/);
});
t("every real user turn ends with the reminder; tool-result turns do not", () => {
  const user = buildPrompt([SYS, { role: "user", content: "doc toan bo file" }], TOOLS, { includePreamble: false }).prompt;
  assert.match(user, /\[Reminder: you reach the user's files/);
  const withTool = buildPrompt(
    [SYS, { role: "user", content: "x" }, { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "glob", arguments: "{}" } }] }, { role: "tool", tool_call_id: "c1", content: "a.js" }],
    TOOLS,
    { includePreamble: false }
  ).prompt;
  assert.doesNotMatch(withTool, /\[Reminder:/);
  process.env.NOAPI_REMIND = "0";
  const off = buildPrompt([SYS, { role: "user", content: "hi" }], TOOLS, { includePreamble: false }).prompt;
  delete process.env.NOAPI_REMIND;
  assert.doesNotMatch(off, /\[Reminder:/);
});
t("the probe/correction prompt contains a call the parser accepts", () => {
  const names = ["edit", "glob", "read"];
  const probe = pickProbe(names, "C:\\NOAPI", "win32");
  assert.equal(probe.name, "glob");
  const prompt = refusalPrompt({ task: "doc toan bo file code", tools: TOOLS.map((x) => x.function), wd: "C:\\NOAPI", platform: "win32" });
  assert.match(prompt, /doc toan bo file code/);
  const { calls } = parseToolCalls(prompt, TOOLS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, "glob");
});
t("probe falls back to shell, then read", () => {
  assert.deepEqual(pickProbe(["shell"], "C:\\x", "win32").arguments, { command: "dir" });
  assert.equal(pickProbe(["read"], "/w", "linux").arguments.path, "/w");
});

t("StreamFilter guard: holds a refusal, releases normal text after GUARD_HOLD", () => {
  const f = new StreamFilter({ tools: TOOLS, guard: true });
  let out = "";
  for (let i = 10; i <= ZAI_REFUSAL.length; i += 10) out += f.push(ZAI_REFUSAL.slice(0, i));
  assert.equal(out, "", "refusal must not be streamed");
  const g = new StreamFilter({ tools: TOOLS, guard: true });
  const ok = "Cấu trúc dự án rất rõ ràng. ".repeat(40);
  let got = "";
  for (let i = 50; i <= ok.length; i += 50) got += g.push(ok.slice(0, i));
  assert.ok(got.length > 0 && ok.startsWith(got));
  assert.ok(ok.length > GUARD_HOLD);
});
t("StreamFilter guard: a short answer is delivered by finish()", () => {
  const f = new StreamFilter({ tools: TOOLS, guard: true });
  assert.equal(f.push("Done."), "");
  assert.equal(f.finish("Done."), "Done.");
});
t("StreamFilter without guard behaves as before", () => {
  const f = new StreamFilter({ tools: TOOLS });
  assert.ok(f.push("A".repeat(200)).length > 0);
});

t("seedTree lists files, skips secrets/node_modules/.git", () => {
  const d = fs.mkdtempSync(nodePath.join(os.tmpdir(), "seed-"));
  fs.mkdirSync(nodePath.join(d, "src"));
  fs.mkdirSync(nodePath.join(d, "node_modules"));
  fs.mkdirSync(nodePath.join(d, ".git"));
  fs.writeFileSync(nodePath.join(d, "a.js"), "");
  fs.writeFileSync(nodePath.join(d, ".env"), "KEY=1");
  fs.writeFileSync(nodePath.join(d, "server.pem"), "");
  fs.writeFileSync(nodePath.join(d, "src", "b.js"), "");
  const s = seedTree(d);
  assert.match(s, /src\//); assert.match(s, /src\/b\.js/); assert.match(s, /a\.js/);
  assert.doesNotMatch(s, /\.env|\.pem|node_modules|\.git/);
  assert.equal(seedTree(nodePath.join(d, "nope")), "");
});

console.log(`\n${n} tests passed`);