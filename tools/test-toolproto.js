// Unit tests for bridge/toolproto.js.
//
// These cover the parts that do not need a browser: the tool-set fingerprint
// (so rewording a description never re-sends the preamble), tool-result
// truncation (head+tail, configurable limit) and TOOL_CALL parsing.
import {
  toolsHash,
  maxToolResult,
  buildDelta,
  buildPrompt,
  promptBreakdown,
  renderPreamble,
  parseToolCalls,
  isPriorityTool,
  descMax,
  paramDescMax,
  terseEnabled,
  descMode,
  toolDenyList,
  tidyToolResult,
} from "../bridge/toolproto.js";

let failed = 0;
function ok(name, cond, detail) {
  if (cond) console.log("ok:", name);
  else {
    console.error("FAIL:", name, detail === undefined ? "" : detail);
    failed++;
  }
}

const tool = (overrides = {}) => ({
  type: "function",
  function: {
    name: "bash",
    description: "Run a shell command.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run." },
        timeout: { type: "integer", description: "Timeout in ms." },
      },
      required: ["command"],
    },
    ...overrides,
  },
});

// ---- toolsHash: names + parameter schemas only ----------------------------
const base = [tool()];
const reworded = [
  tool({
    description: "Completely different wording for the same tool.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Different parameter wording." },
        timeout: { type: "integer", description: "Different timeout wording." },
      },
      required: ["command"],
    },
  }),
];

ok("hash ignores tool descriptions", toolsHash(base) === toolsHash(reworded), `${toolsHash(base)} vs ${toolsHash(reworded)}`);
ok(
  "hash ignores parameter descriptions",
  toolsHash(base) ===
    toolsHash([
      tool({
        parameters: {
          type: "object",
          properties: { command: { type: "string", description: "other" }, timeout: { type: "integer", description: "other" } },
          required: ["command"],
        },
      }),
    ])
);
ok(
  "hash changes when a parameter type changes",
  toolsHash(base) !==
    toolsHash([
      tool({
        parameters: {
          type: "object",
          properties: { command: { type: "string" }, timeout: { type: "string" } },
          required: ["command"],
        },
      }),
    ])
);
ok(
  "hash changes when a tool is added",
  toolsHash(base) !== toolsHash([...base, { type: "function", function: { name: "read", parameters: { type: "object", properties: {} } } }])
);
ok(
  "hash changes when a tool is renamed",
  toolsHash(base) !== toolsHash([tool({ name: "shell" })])
);
ok(
  "hash is independent of key order in the schema",
  toolsHash([tool({ parameters: { properties: { a: { type: "string" } }, type: "object" } })]) ===
    toolsHash([tool({ parameters: { type: "object", properties: { a: { type: "string" } } } })])
);

// ---- truncated tool results ----------------------------------------------
const defaultLimit = Number(process.env.NOAPI_MAX_TOOL_RESULT) || 16_000;
ok("default tool-result limit is 16000", maxToolResult() === 16000, String(maxToolResult()));

const HEAD = "HEAD-OF-OUTPUT ";
const TAIL = " TAIL-OF-OUTPUT";
const long = HEAD + "x".repeat(50_000) + TAIL;
const toolMsg = (content) => [
  { role: "user", content: "go" },
  { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "c1", content },
];
const delta = buildDelta(toolMsg(long)).text;
ok("long tool result keeps its head", delta.includes(HEAD.trim()));
ok("long tool result keeps its tail", delta.includes(TAIL.trim()));
ok("long tool result is truncated", delta.includes("chars truncated"));
ok("truncated result is near the limit", delta.length < defaultLimit + 400, String(delta.length));
// The truncation marker must tell the model what is missing and how to see it.
ok("truncation marker says how many chars were cut", /\d+ chars truncated/.test(delta), delta.match(/\[[^\]]*\]/)?.[0]);
ok(
  "truncation marker suggests a narrower re-run",
  /narrower range/.test(delta) && /offset\/limit/.test(delta) && /grep/.test(delta) && /head\/tail/.test(delta)
);

process.env.NOAPI_MAX_TOOL_RESULT = "500";
ok("limit is configurable via NOAPI_MAX_TOOL_RESULT", maxToolResult() === 500);
const small = buildDelta(toolMsg(long)).text;
ok("custom limit is applied", small.length < 800, String(small.length));
ok("custom limit still keeps head and tail", small.includes(HEAD.trim()) && small.includes(TAIL.trim()));
delete process.env.NOAPI_MAX_TOOL_RESULT;

ok("short tool result is not touched", buildDelta(toolMsg("hi there")).text.includes("hi there"));

// ---- preamble: batching guidance ----------------------------------------
const pre = renderPreamble([tool(), { type: "function", function: { name: "read", parameters: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] } } }], []);
ok("preamble teaches batching independent calls", /batch/i.test(pre) && /ONE reply/i.test(pre));
ok("preamble includes two example blocks for two tools", (pre.match(/TOOL_CALL\n\{/g) || []).length >= 2);
ok("preamble tells the model to prefer grep/glob", /grep\/glob/i.test(pre));

// ---- preamble: per-tool description priority ----------------------------
const LONG = "L".repeat(400);
const SHORT_OK = "s".repeat(200);
const fn = (name, properties = {}, required = []) => ({
  type: "function",
  function: { name, description: LONG, parameters: { type: "object", properties, required } },
});
const openCodeTools = [
  fn("bash", { command: { type: "string", description: LONG } }, ["command"]),
  fn("read", { filePath: { type: "string", description: LONG } }, ["filePath"]),
  fn("write", { content: { type: "string", description: LONG } }, ["content"]),
  fn("edit", { oldString: { type: "string", description: LONG }, newString: { type: "string", description: LONG } }, ["oldString"]),
  fn("web_search", { query: { type: "string", description: LONG } }, ["query"]),
  fn("mystery", { replace_all: { type: "boolean", description: LONG } }),
];
ok("edit/write/bash/read are priority tools", ["edit", "write", "bash", "read"].every((n) => isPriorityTool({ name: n })));
ok("a tool with an oldString/newString/replace param is priority", isPriorityTool({ name: "mystery", parameters: { properties: { old_string: {} } } }));
ok("a plain lookup tool is not priority", !isPriorityTool({ name: "web_search" }));
ok("descMax default is 400", descMax() === 400, String(descMax()));
ok("paramDescMax default is 400", paramDescMax() === 400, String(paramDescMax()));

const preFull = renderPreamble(openCodeTools, []);
ok("bash keeps its full description", preFull.includes(`* bash: ${LONG}`));
ok("read keeps its full description", preFull.includes(`* read: ${LONG}`));
ok("write keeps its full description", preFull.includes(`* write: ${LONG}`));
ok("edit keeps its full description", preFull.includes(`* edit: ${LONG}`));
ok("edit keeps its full oldString/newString descriptions", preFull.includes(`oldString (required): string - ${LONG}`) && preFull.includes(`newString (optional): string - ${LONG}`));
ok("a non-priority tool is still clipped short", !preFull.includes(`* web_search: ${LONG}`) && preFull.includes(`* web_search: ${"L".repeat(179)}...`));
ok("a non-priority param is still clipped to 90", preFull.includes(`query (required): string - ${"L".repeat(89)}...`));

process.env.NOAPI_DESC_MAX = "50";
process.env.NOAPI_PARAM_DESC_MAX = "30";
ok("NOAPI_DESC_MAX overrides the priority cap", descMax() === 50 && paramDescMax() === 30);
const preNarrow = renderPreamble([fn("bash", { command: { type: "string", description: LONG } }, ["command"])], []);
ok("a priority description now clips at the env cap", preNarrow.includes(`* bash: ${"L".repeat(49)}...`));
ok("a priority param description now clips at the env cap", preNarrow.includes(`${"L".repeat(29)}...`));
delete process.env.NOAPI_DESC_MAX;
delete process.env.NOAPI_PARAM_DESC_MAX;
const shortTool = { type: "function", function: { name: "bash", description: SHORT_OK, parameters: { type: "object", properties: {} } } };
ok("a description under the cap is left alone", renderPreamble([shortTool], []).includes(`* bash: ${SHORT_OK}`));

// ---- Phase 4: terse mode --------------------------------------------------
ok("terse mode is on by default", terseEnabled() === true);
const tersePre = renderPreamble([tool()], []);
ok("terse: no prose around tool calls", /NOTHING but the blocks/i.test(tersePre));
ok("terse: concise final answers", /final answer terse/i.test(tersePre));

process.env.NOAPI_TERSE = "0";
ok("NOAPI_TERSE=0 disables terse mode", terseEnabled() === false);
const chattyPre = renderPreamble([tool()], []);
ok(
  "non-terse: the terse rules are gone",
  !/NOTHING but the blocks/i.test(chattyPre) && !/final answer terse/i.test(chattyPre)
);
delete process.env.NOAPI_TERSE;

// The full tool semantics must survive in BOTH modes; only the verbosity changes.
for (const [label, p] of [
  ["terse", tersePre],
  ["non-terse", chattyPre],
]) {
  ok(`${label}: still teaches the TOOL_CALL format`, p.includes("TOOL_CALL") && /FORMAT/.test(p) && /arguments as JSON/.test(p));
  ok(`${label}: still lists the tool and its required args`, p.includes("* bash:") && p.includes("command (required)"));
  ok(`${label}: still teaches batching and STOP`, /batch/i.test(p) && /ONE reply/i.test(p) && /STOP writing/.test(p));
  ok(`${label}: still ends with the AVAILABLE TOOLS section`, /AVAILABLE TOOLS:/.test(p));
}

// ---- Task 3: lossless tool-result cleanup --------------------------------
// Only whitespace/escape noise is removed; every visible character survives.
const ansi = "\u001b[32m✓\u001b[39m all good   \r\n\r\n\r\n\r\ndone   \n";
ok("cleanup strips ANSI colour codes", !tidyToolResult(ansi).includes("\u001b["));
ok("cleanup keeps the visible text and marks", tidyToolResult(ansi).includes("✓ all good"));
ok("cleanup normalises CRLF to LF", !tidyToolResult(ansi).includes("\r"));
ok("cleanup trims trailing whitespace per line", tidyToolResult("a   \nb\t\n").split("\n")[0] === "a");
ok("cleanup collapses runs of blank lines", tidyToolResult("a\n\n\n\n\nb") === "a\n\nb", JSON.stringify(tidyToolResult("a\n\n\n\n\nb")));
ok("cleanup leaves a single blank line alone", tidyToolResult("a\n\nb") === "a\n\nb");
ok("cleanup trims the ends", tidyToolResult("\n\n  hi  \n\n") === "hi");
ok("cleanup on empty/undefined is an empty string", tidyToolResult(undefined) === "" && tidyToolResult("") === "");
// A tool result is cleaned before clipping (the cleanup is always on).
ok("buildDelta applies the cleanup to tool results", buildDelta(toolMsg("\u001b[31mboom\u001b[39m   ")).text.includes("boom") && !buildDelta(toolMsg("\u001b[31mboom\u001b[39m   ")).text.includes("\u001b[31m"));

// ---- Task 2: lean description mode (default OFF) --------------------------
ok("description mode defaults to full", descMode() === "full", descMode());
ok("deny list is empty by default", toolDenyList().length === 0);
process.env.NOAPI_DESC_MODE = "lean";
ok("lean mode is reported", descMode() === "lean");
const leanPre = renderPreamble(openCodeTools, []);
ok("lean: a priority tool is clipped to the short cap", leanPre.includes(`* bash: ${"L".repeat(179)}...`) && !leanPre.includes(`* bash: ${LONG}`));
ok("lean: semantics are unchanged", leanPre.includes("* bash:") && leanPre.includes("command (required)") && /AVAILABLE TOOLS:/.test(leanPre));
delete process.env.NOAPI_DESC_MODE;
ok("description mode returns to full", descMode() === "full");

// ---- Task 2: NOAPI_TOOL_DENY leaves tools out of the preamble -------------
process.env.NOAPI_TOOL_DENY = "web_search, mystery";
ok("deny list is parsed and trimmed", JSON.stringify(toolDenyList()) === JSON.stringify(["web_search", "mystery"]), JSON.stringify(toolDenyList()));
const deniedPre = renderPreamble(openCodeTools, []);
ok("a denied tool is left out of the preamble", !deniedPre.includes("* web_search:") && !deniedPre.includes("* mystery:"));
ok("non-denied tools are still listed", deniedPre.includes("* bash:") && deniedPre.includes("* read:"));
ok("denied tools stay parseable (not the preamble that validates)", parseToolCalls('TOOL_CALL\n{"name":"web_search","arguments":{"query":"x"}}', [fn("web_search", { query: { type: "string" } })]).calls.length === 1);
delete process.env.NOAPI_TOOL_DENY;
ok("deny list is empty again", toolDenyList().length === 0);

// ---- parsing is unaffected ---------------------------------------------
const twoCalls = [
  "On it.",
  "```",
  "TOOL_CALL",
  '{"name":"bash","arguments":{"command":"mkdir a"}}',
  "```",
  "```",
  "TOOL_CALL",
  '{"name":"bash","arguments":{"command":"mkdir b"}}',
  "```",
].join("\n");
const parsed = parseToolCalls(twoCalls, [tool()]);
ok("two blocks parse into two calls", parsed.calls.length === 2, JSON.stringify(parsed.calls));
ok("block text is stripped from content", parsed.text === "On it.", JSON.stringify(parsed.text));

const plain = parseToolCalls("just a normal answer", [tool()]);
ok("plain text parses as no calls", plain.calls.length === 0 && plain.text === "just a normal answer");

// ---- prompt breakdown: the parts add up to the total ---------------------
{
  const toolDef = tool();
  const systemMsg = { role: "system", content: "S".repeat(100) };
  const userMsg = { role: "user", content: "U".repeat(50) };
  const toolResultMsg = (content) => ({ role: "tool", tool_call_id: "c1", content });
  const withCall = (content) => [
    userMsg,
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }] },
    toolResultMsg(content),
  ];

  // First turn: a system message, a user message and a tool result in the same
  // delta (no assistant turn between them), plus one autoread file block.
  const first = [systemMsg, userMsg, toolResultMsg("R".repeat(20))];
  const b = promptBreakdown(first, [toolDef], { includePreamble: true, filesChars: 40 });
  ok("breakdown: user counts only the user text", b.user === 50, JSON.stringify(b));
  ok("breakdown: system text is not forwarded verbatim", b.system === 0, JSON.stringify(b));
  ok("breakdown: tool result is counted", b.toolresults > 20, JSON.stringify(b));
  ok("breakdown: files is the autoread block length", b.files === 40, JSON.stringify(b));
  ok("breakdown: preamble and tools are non-zero", b.preamble > 0 && b.tools > 0, JSON.stringify(b));
  ok(
    "breakdown: total matches the real prompt length",
    b.total === buildPrompt(first, [toolDef], { includePreamble: true }).prompt.length + 2 + 40,
    JSON.stringify(b)
  );
  ok(
    "breakdown: parts sum to total",
    b.preamble + b.tools + b.system + b.user + b.files + b.toolresults + b.other === b.total,
    JSON.stringify(b)
  );

  // Continuation turn: only a tool result, no preamble and no files.
  const c = promptBreakdown(withCall("R".repeat(20)), [toolDef], { includePreamble: false });
  ok("continuation: preamble and tools are 0", c.preamble === 0 && c.tools === 0, JSON.stringify(c));
  ok("continuation: user text is 0", c.user === 0, JSON.stringify(c));
  ok("continuation: tool result is counted", c.toolresults > 20, JSON.stringify(c));
  ok("continuation: files is 0", c.files === 0, JSON.stringify(c));
  ok(
    "continuation: parts sum to total",
    c.preamble + c.tools + c.system + c.user + c.files + c.toolresults + c.other === c.total,
    JSON.stringify(c)
  );
  ok("continuation: other covers the continue hint", c.other >= "Continue the task".length, JSON.stringify(c));
}

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nall toolproto tests passed");