// Unit tests for bridge/toolproto.js.
//
// These cover the parts that do not need a browser: the tool-set fingerprint
// (so rewording a description never re-sends the preamble), tool-result
// truncation (head+tail, configurable limit) and TOOL_CALL parsing.
import { toolsHash, maxToolResult, buildDelta, renderPreamble, parseToolCalls } from "../bridge/toolproto.js";

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
const defaultLimit = Number(process.env.NOAPI_MAX_TOOL_RESULT) || 10_000;
ok("default tool-result limit is 10000", maxToolResult() === 10000, String(maxToolResult()));

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
ok("truncated result is near the limit", delta.length < defaultLimit + 200, String(delta.length));

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

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nall toolproto tests passed");