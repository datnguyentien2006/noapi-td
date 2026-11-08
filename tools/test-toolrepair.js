// Auto-correction of malformed TOOL_CALL blocks, end to end through the bridge.
//
// The fake browser is told (NOAPI_FAKE_REPAIR) to answer the first tool prompt
// with a flattened call that has an unknown key, and to answer a repair
// follow-up with a valid block -- or to keep failing, so the give-up path is
// exercised too. The bridge must repair once and never leak the broken block.
//
// Two failed repairs end the turn with an HTTP 503 (NOAPI_REPAIR_FAIL=text
// restores the old "return the raw reply as plain text" behaviour). That is
// deliberate: handing a broken TOOL_CALL back as final text makes OpenCode stop.
// A request that defines NO tools never enters this path at all -- a reply that
// merely contains the word TOOL_CALL is plain text.
import { startBridge, startFake, stopAll, waitForHealth, warnIfDefaultBridge } from "./lib/harness.js";

await warnIfDefaultBridge();

const tools = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  },
];
const messages = [
  { role: "system", content: "Working directory: /tmp/x" },
  { role: "user", content: "make a folder" },
];

async function run({ repair = "", env = {}, tools: toolDefs = tools, messages: msgs = messages } = {}) {
  const stderr = [];
  const { port, proc } = await startBridge({ onStderr: (s) => stderr.push(s) });
  const fake = startFake({
    port,
    site: "chatgpt",
    env: { ...(repair ? { NOAPI_FAKE_REPAIR: repair } : {}), ...env },
  });
  await waitForHealth(port, { clients: true });
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "chatgpt", messages: msgs, tools: toolDefs, stream: false }),
  });
  const body = await res.json();
  fake.kill();
  proc.kill();
  return { status: res.status, body, stderr: stderr.join("") };
}

const fail = (m) => {
  console.error("FAIL:", m);
  stopAll();
  process.exit(1);
};

// One repair recovers the turn, and the malformed block never reaches OpenCode.
const a = await run({ repair: "1" });
const choice = a.body.choices?.[0];
const call = choice?.message?.tool_calls?.[0];
if (choice?.finish_reason !== "tool_calls" || !call) fail("no tool_call after repair\n" + JSON.stringify(a.body));
if (!call.function.arguments.includes("mkdir repaired")) fail("wrong repaired call\n" + call.function.arguments);
if (!/tool repair: attempt 1\/2 reason=no-arguments tool=bash/.test(a.stderr)) fail("no repair log\n" + a.stderr);
if (/TOOL_CALL/.test(choice.message.content || "")) fail("broken block leaked into content\n" + choice.message.content);
console.log("ok: malformed block repaired once and executed");

// Two failed repairs end the turn with an HTTP 503 (not the broken block as
// plain text), with a message that says how to retry.
const b = await run({ repair: "2" });
if (b.status !== 503) fail("unrecoverable TOOL_CALL should end the turn with a 503\n" + JSON.stringify(b.body));
if (b.body?.error?.type !== "browser_bridge_error" || b.body?.error?.code !== 503) {
  fail("503 body should be a browser_bridge_error with code 503\n" + JSON.stringify(b.body));
}
if (!/could not be parsed \(no-arguments, tool=bash\) even after auto-repair/.test(b.body?.error?.message || "")) {
  fail("503 message should name the reason and the tool\n" + JSON.stringify(b.body));
}
if (!/Send "continue" to retry/.test(b.body?.error?.message || "")) fail("503 message should tell the caller to retry\n" + JSON.stringify(b.body));
if (!/tool repair: failed after 2\/2/.test(b.stderr)) fail("no give-up log\n" + b.stderr);
console.log("ok: two failed repairs end the turn with a 503 and a retry hint");

// A request that defines NO tools is plain text: a reply that merely contains
// the word TOOL_CALL must not trigger repair or a 503.
const c = await run({
  tools: [],
  messages: [
    { role: "system", content: "Working directory: /tmp/x" },
    { role: "user", content: "just say something" },
  ],
  env: { NOAPI_FAKE_REPLY: "I fixed the TOOL_CALL parser today." },
});
if (c.status !== 200) fail("a tool-less request must not 503\n" + JSON.stringify(c.body));
const cw = c.body.choices?.[0];
if (cw?.finish_reason !== "stop" || cw?.message?.tool_calls) fail("tool-less reply must be plain text\n" + JSON.stringify(c.body));
if (!/TOOL_CALL/.test(cw?.message?.content || "")) fail("tool-less reply text was altered\n" + JSON.stringify(c.body));
if (/tool repair:|refusal guard:/.test(c.stderr)) fail("tool-less request must not repair\n" + c.stderr);
console.log("ok: a tool-less request keeps TOOL_CALL as plain text (no repair, no 503)");

stopAll();
process.exit(0);
