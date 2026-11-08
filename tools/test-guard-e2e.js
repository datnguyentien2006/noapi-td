// End-to-end tests of the refusal guard, repeat guard and rotation policy
// through the real HTTP layer, with a scripted fake bridge (no browser).
// Run: node tools/test-guard-e2e.js
import assert from "node:assert/strict";
import { createHttpServer } from "../bridge/http.js";
import { effectiveRotateLimit, rotateMinTurns } from "../bridge/rotation.js";
import { Bridge } from "../bridge/state.js";

const TOOLS = ["glob", "read", "shell"].map((name) => ({
  type: "function",
  function: { name, description: name, parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, command: { type: "string" } }, required: [] } },
}));
const SYS = { role: "system", content: "Working directory: C:\\NOAPI\nPlatform: win32" };
const CALL = (name, args) => "```\nTOOL_CALL\n" + JSON.stringify({ name, arguments: args }) + "\n```";
const REFUSAL = "Mình không thể đọc trực tiếp thư mục C:\\NOAPI trên máy của bạn. Hãy upload file vào cuộc trò chuyện.";

let n = 0;
async function scenario(name, { script, messages, stream = false, partials = false, env = {}, preset = null }) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  const prompts = [];
  const logs = [];
  const bridge = {
    toolHashes: new Map(), chatUsage: new Map(),
    status: () => ({ ok: true }),
    async requestPrompt({ prompt, onPartial }) {
      prompts.push(prompt);
      const reply = script.shift();
      if (reply === undefined) throw new Error("script exhausted");
      if (partials && onPartial) for (let i = 8; i < reply.length; i += 8) onPartial(reply.slice(0, i));
      return reply;
    },
  };
  preset?.(bridge);
  const server = createHttpServer(bridge, (l) => logs.push(l));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json", Host: `127.0.0.1:${port}` },
    body: JSON.stringify({ model: "zai", stream, messages, tools: TOOLS }),
  });
  const text = await res.text();
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  server.close();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return { status: res.status, text, prompts, logs, health };
}
const ok = (name) => { n++; console.log("ok -", name); };
const USER = [SYS, { role: "user", content: "doc toan bo file code cua thu muc C:\\NOAPI" }];

// 1. refusal -> correction -> tool call
{
  const r = await scenario("refusal-recovered", { script: [REFUSAL, CALL("glob", { pattern: "**/*" })], messages: USER });
  assert.equal(r.status, 200);
  const j = JSON.parse(r.text);
  assert.equal(j.choices[0].finish_reason, "tool_calls");
  assert.equal(j.choices[0].message.tool_calls[0].function.name, "glob");
  assert.match(r.prompts[1], /Your last reply was wrong/);
  assert.match(r.prompts[1], /doc toan bo file code/);
  assert.deepEqual(r.health.guard.zai, { refusals: 1, recovered: 1, failed: 0 });
  ok("refusal is corrected and the tool call reaches OpenCode");
}
// 2. refusal that never recovers -> explicit error, not a fake answer
{
  const r = await scenario("refusal-failed", { script: [REFUSAL, REFUSAL, REFUSAL], messages: USER });
  assert.equal(r.status, 503);
  assert.match(r.text, /refused to use tools/);
  assert.equal(r.prompts.length, 3);
  assert.equal(r.health.guard.zai.failed, 1);
  ok("unrecoverable refusal becomes an error (never a final answer)");
}
// 3. streaming: the refusal text is never streamed to OpenCode
{
  const r = await scenario("refusal-stream", { script: [REFUSAL, CALL("glob", { pattern: "**/*" })], messages: USER, stream: true, partials: true });
  assert.doesNotMatch(r.text, /upload|không thể đọc/i);
  assert.match(r.text, /"tool_calls"/);
  ok("streamed refusal is withheld and replaced by the tool call");
}
// 4. a normal tool call is untouched
{
  const r = await scenario("normal", { script: [CALL("glob", { pattern: "**/*" })], messages: USER });
  assert.equal(r.prompts.length, 1);
  assert.equal(r.health.guard.zai, undefined);
  ok("normal tool call: no extra round trip");
}
// 5. repeat guard: same call right after its result
{
  const prev = [{ id: "c1", type: "function", function: { name: "glob", arguments: JSON.stringify({ pattern: "**/*" }) } }];
  const messages = [...USER, { role: "assistant", content: null, tool_calls: prev }, { role: "tool", tool_call_id: "c1", content: "a.js\nb.js" }];
  const r = await scenario("repeat", { script: [CALL("glob", { pattern: "**/*" }), CALL("read", { path: "C:/NOAPI/a.js" })], messages });
  const j = JSON.parse(r.text);
  assert.equal(j.choices[0].message.tool_calls[0].function.name, "read");
  assert.match(r.prompts[1], /exactly the same TOOL_CALL/);
  assert.equal(r.health.guard.zai.repeats, 1);
  ok("repeated call is redirected to the next step");
}
// 6. a different call after a result is not touched
{
  const prev = [{ id: "c1", type: "function", function: { name: "glob", arguments: "{}" } }];
  const messages = [...USER, { role: "assistant", content: null, tool_calls: prev }, { role: "tool", tool_call_id: "c1", content: "a.js" }];
  const r = await scenario("no-repeat", { script: [CALL("read", { path: "C:/NOAPI/a.js" })], messages });
  assert.equal(r.prompts.length, 1);
  ok("a different call passes straight through");
}
// 7. rotation: not rotated within the first turns of a chat
{
  const r = await scenario("rotate-min-turns", { script: [CALL("glob", {})], messages: USER, env: { NOAPI_ROTATE_CHARS: "10" } });
  // chatUsage is 0 on a fresh bridge so this only checks nothing crashes with a tiny limit
  assert.equal(r.status, 200);
  ok("tiny rotate limit on a fresh chat does not rotate");
}
// 8. rotation policy
{
  const e = {};
  assert.equal(effectiveRotateLimit("zai", 150000, 0, e), 300000, "zai default");
  assert.equal(effectiveRotateLimit("claude", 150000, 0, e), 150000);
  assert.equal(effectiveRotateLimit("zai", 150000, 0, { NOAPI_ROTATE_CHARS: "150000" }), 150000, "explicit env wins");
  assert.equal(effectiveRotateLimit("zai", 150000, 0, { NOAPI_ROTATE_CHARS_ZAI: "500000" }), 500000, "per-site env wins");
  assert.equal(effectiveRotateLimit("zai", 0, 0, { NOAPI_ROTATE_CHARS: "0" }), 0, "0 = off");
  assert.equal(effectiveRotateLimit("claude", 150000, 90000, e), 270000, "limit grows when the rotation prompt is big");
  assert.equal(rotateMinTurns({}), 3);
  ok("rotation policy");
}

// 9. rotation: skipped in the first turns of a chat, done later with a compact prompt
{
  const big = "x".repeat(15000);
  const prev = [{ id: "c1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "C:/NOAPI/a.js" }) } }, { id: "c2", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "C:/NOAPI/b.js" }) } }];
  const messages = [...USER, { role: "assistant", content: null, tool_calls: prev }, { role: "tool", tool_call_id: "c1", content: big }, { role: "tool", tool_call_id: "c2", content: big }];
  const env = { NOAPI_ROTATE_CHARS: "1000" };
  const early = await scenario("rotate-early", { script: [CALL("glob", {})], messages, env, preset: (b) => { b.chatUsage.set("zai", 999999); b.chatTurns = new Map([["zai", 1]]); } });
  assert.ok(early.logs.some((l) => /chat rotate skipped/.test(l)), "early rotation skipped");
  assert.ok(!early.logs.some((l) => /chat rotate:/.test(l)));
  const late = await scenario("rotate-late", { script: [CALL("glob", {})], messages, env, preset: (b) => { b.chatUsage.set("zai", 999999); b.chatTurns = new Map([["zai", 5]]); } });
  assert.ok(late.logs.some((l) => /chat rotate:/.test(l)), "later rotation happens");
  assert.match(late.prompts[0], /YOUR PREVIOUS TOOL CALLS/);
  assert.match(late.prompts[0], /C:\/NOAPI\/a\.js/);
  assert.ok(late.prompts[0].length < 20000 + 12000 + 3000, `rotation prompt compacted (${late.prompts[0].length})`);
  ok("rotation: min turns respected, pending calls named, results compacted");
}
// 10. the bridge waits for the extension to (re)connect instead of failing at once
{
  const b = new Bridge();
  process.env.NOAPI_CLIENT_WAIT_MS = "3000";
  setTimeout(() => b.clients.set({ closed: false }, { site: "zai" }), 700);
  const t0 = Date.now();
  await b._waitForClient({ site: "zai" });
  const waited = Date.now() - t0;
  assert.ok(waited >= 600 && waited < 2500, `waited ${waited}ms`);
  process.env.NOAPI_CLIENT_WAIT_MS = "0";
  const b2 = new Bridge();
  const t1 = Date.now();
  await b2._waitForClient({ site: "zai" });
  assert.ok(Date.now() - t1 < 100);
  process.env.NOAPI_CLIENT_WAIT_MS = "800";
  const t2 = Date.now();
  await assert.rejects(new Bridge().requestPrompt({ prompt: "hi", site: "zai" }), /No browser tab on "zai"/);
  assert.ok(Date.now() - t2 >= 700);
  delete process.env.NOAPI_CLIENT_WAIT_MS;
  ok("bridge waits for the extension to connect, then fails with the old message");
}
console.log(`\n${n} e2e tests passed`);