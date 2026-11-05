// Unit tests for bridge/streamfilter.js.
//
// The filter is what stands between a website's reply and OpenCode's visible
// content. These tests feed it the reply one character at a time (and in
// explicit split points) and check that the tool protocol never leaks, that
// ordinary code still streams, and that nothing is shown twice.
import { StreamFilter, unsafeStart, streamEnabled } from "../bridge/streamfilter.js";
import { parseToolCalls } from "../bridge/toolproto.js";

let failed = 0;
function ok(name, cond, detail) {
  if (cond) console.log("ok:", name);
  else {
    console.error("FAIL:", name, detail === undefined ? "" : detail);
    failed++;
  }
}

const tool = (name, props = {}) => ({
  type: "function",
  function: { name, description: `${name} tool`, parameters: { type: "object", properties: props } },
});
const TOOLS = [tool("bash", { command: { type: "string" } }), tool("read", { filePath: { type: "string" } })];
const NAMES = ["bash", "read"];

const BLOCK =
  "```\nTOOL_CALL\n" + '{"name":"bash","arguments":{"command":"ls"}}' + "\n```";

// Feed `reply` in `step`-sized snapshots, then finish with the parser's cleaned
// text. Returns what the client would have seen at each stage.
function run(reply, { tools = TOOLS, step = 1 } = {}) {
  const filter = new StreamFilter({ tools });
  let visible = "";
  for (let i = step; i < reply.length; i += step) visible += filter.push(reply.slice(0, i));
  visible += filter.push(reply);
  const beforeFinish = visible;
  const parsed = parseToolCalls(reply, tools);
  const tail = filter.finish(parsed.text);
  visible += tail;
  return { visible, beforeFinish, tail, parsed };
}

const leaks = (s) => /TOOL_CALL|```|\{\s*"name"/.test(s);

// ---- 1. plain text only ---------------------------------------------------
{
  const reply = "Hello there, this is a normal answer with enough words to stream.";
  const r = run(reply);
  ok("plain text: no tool calls", r.parsed.calls.length === 0);
  ok("plain text: visible matches the cleaned reply", r.visible === r.parsed.text, JSON.stringify(r.visible));
  ok("plain text: nothing shown twice", r.visible.length === reply.length, `${r.visible.length} vs ${reply.length}`);
  ok("plain text: content starts streaming before the end", r.beforeFinish.length > 0);
}

// ---- 2. prose followed by a tool block -----------------------------------
{
  const reply = `Let me check the folder first.\n${BLOCK}`;
  const r = run(reply);
  ok("prose + block: parses one call", r.parsed.calls.length === 1, JSON.stringify(r.parsed.calls));
  ok("prose + block: visible prose matches the cleaned text", r.visible.trim() === r.parsed.text.trim(), JSON.stringify(r.visible));
  ok("prose + block: no protocol leaked", !leaks(r.visible), r.visible);
  ok("prose + block: the prose is shown once", (r.visible.match(/Let me check/g) || []).length === 1);
}

// ---- 3. a tool block at the very start -----------------------------------
{
  const r = run(BLOCK);
  ok("block at start: parses one call", r.parsed.calls.length === 1);
  ok("block at start: no visible content", r.visible.trim() === "", JSON.stringify(r.visible));
  ok("block at start: no protocol leaked", !leaks(r.visible), r.visible);
}

// ---- 4 + 5. marker and fence split across updates ------------------------
{
  const filter = new StreamFilter({ tools: TOOLS });
  const snapshots = [
    "Let me check.\n",
    "Let me check.\n``",
    "Let me check.\n```",
    "Let me check.\n```\nTOOL_",
    "Let me check.\n```\nTOOL_CALL",
    'Let me check.\n```\nTOOL_CALL\n{"name":"bash"',
    `Let me check.\n${BLOCK}`,
  ];
  let streamed = "";
  let bad = "";
  for (const s of snapshots) {
    const d = filter.push(s);
    streamed += d;
    if (leaks(d)) bad += d;
  }
  const parsed = parseToolCalls(`Let me check.\n${BLOCK}`, TOOLS);
  streamed += filter.finish(parsed.text);
  ok("split fence/marker: no partial marker or fence ever streamed", bad === "", JSON.stringify(bad));
  ok("split fence/marker: no protocol in the final visible text", !leaks(streamed), streamed);
  ok("split fence/marker: prose is intact", streamed.trim() === parsed.text.trim(), JSON.stringify(streamed));
}

// ---- 6. a fenced code block that is NOT a tool call must still stream ----
{
  const reply =
    "Here is the code:\n```js\nfunction add(a, b) {\n  return a + b;\n}\nconst total = add(1, 2);\nconsole.log(total);\n```\nThat is all.";
  const r = run(reply);
  ok("normal code block: is not treated as a tool block", unsafeStart(reply, NAMES) === -1);
  ok("normal code block: parses no calls", r.parsed.calls.length === 0);
  ok("normal code block: visible matches the reply", r.visible === r.parsed.text, JSON.stringify(r.visible));
  ok("normal code block: the code itself is streamed", r.visible.includes("const total = add(1, 2);"));
  ok("normal code block: the opening fence is streamed", r.visible.includes("```js"));
  ok("normal code block: it streams before the end", r.beforeFinish.includes("function add"), JSON.stringify(r.beforeFinish));
}

// ---- 7. a tool block only at the very end -------------------------------
{
  const prose = "I will inspect the files. ".repeat(6).trim();
  const r = run(`${prose}\n${BLOCK}`);
  ok("block at the end: parses one call", r.parsed.calls.length === 1);
  ok("block at the end: prose matches the cleaned text", r.visible.trim() === r.parsed.text.trim(), JSON.stringify(r.visible));
  ok("block at the end: no protocol leaked", !leaks(r.visible), r.visible);
  ok("block at the end: the prose streamed before the end", r.beforeFinish.includes("I will inspect the files."));
}

// ---- 8. TOOL_CALL in prose without valid JSON ---------------------------
{
  const reply = "The marker you asked about is TOOL_CALL, but this sentence is not a tool call.";
  const r = run(reply);
  ok("prose marker: parses no calls", r.parsed.calls.length === 0);
  ok("prose marker: never streamed as live content", !r.beforeFinish.includes("TOOL_CALL"), JSON.stringify(r.beforeFinish));
  ok("prose marker: shown exactly once in the end", r.visible === r.parsed.text && (r.visible.match(/TOOL_CALL/g) || []).length === 1);
}

// ---- 9. tools disabled ---------------------------------------------------
{
  // With no tools, a TOOL_CALL-looking string is just text and must not be
  // held back at all.
  const immediate = new StreamFilter({ tools: [] }).push("```\nTOOL_CALL\n" + '{"name":"bash"}' + "\n```");
  ok("tools disabled: streams everything immediately", immediate.includes("TOOL_CALL") && immediate.includes("```"));

  const reply = `Plain text.\n${BLOCK}`;
  const filter = new StreamFilter({ tools: [] });
  let visible = "";
  for (let i = 1; i < reply.length; i++) visible += filter.push(reply.slice(0, i));
  visible += filter.push(reply);
  const cleaned = parseToolCalls(reply, []).text;
  visible += filter.finish(cleaned);
  ok("tools disabled: exactly the reply is shown", visible === cleaned, JSON.stringify(visible));
}

// ---- kill switch ---------------------------------------------------------
ok("NOAPI_STREAM defaults to on", streamEnabled({}) === true);
ok("NOAPI_STREAM=0 turns streaming off", streamEnabled({ NOAPI_STREAM: "0" }) === false);

// ---- unsafeStart spot checks --------------------------------------------
ok("unsafeStart ignores plain prose", unsafeStart("nothing to see here", NAMES) === -1);
ok("unsafeStart points at the opening fence", unsafeStart(`hi\n${BLOCK}`, NAMES) === 3);
ok("unsafeStart points at a bare known-tool JSON object", unsafeStart('ok\n{"name":"bash","arguments":{}}', NAMES) === 3);
ok("unsafeStart ignores JSON for an unknown tool", unsafeStart('ok\n{"name":"nope","arguments":{}}', NAMES) === -1);

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nall stream filter tests passed");