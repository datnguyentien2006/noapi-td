// Auto-correction of malformed TOOL_CALL blocks, end to end through the bridge.
//
// The fake browser is told (NOAPI_FAKE_REPAIR) to answer the first tool prompt
// with a flattened call that has an unknown key, and to answer a repair
// follow-up with a valid block — or to keep failing, so the give-up path is
// exercised too. The bridge must repair once and never leak the broken block.
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

async function run(repair) {
  const stderr = [];
  const { port, proc } = await startBridge({ onStderr: (s) => stderr.push(s) });
  const fake = startFake({ port, site: "chatgpt", env: { NOAPI_FAKE_REPAIR: repair } });
  await waitForHealth(port, { clients: true });
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "chatgpt", messages, tools, stream: false }),
  });
  const body = await res.json();
  fake.kill();
  proc.kill();
  return { body, stderr: stderr.join("") };
}

const fail = (m) => {
  console.error("FAIL:", m);
  stopAll();
  process.exit(1);
};

// One repair recovers the turn, and the malformed block never reaches OpenCode.
const a = await run("1");
const choice = a.body.choices?.[0];
const call = choice?.message?.tool_calls?.[0];
if (choice?.finish_reason !== "tool_calls" || !call) fail("no tool_call after repair\n" + JSON.stringify(a.body));
if (!call.function.arguments.includes("mkdir repaired")) fail("wrong repaired call\n" + call.function.arguments);
if (!/tool repair: attempt 1\/2 reason=no-arguments tool=bash/.test(a.stderr)) fail("no repair log\n" + a.stderr);
if (/TOOL_CALL/.test(choice.message.content || "")) fail("broken block leaked into content\n" + choice.message.content);
console.log("ok: malformed block repaired once and executed");

// Two failed repairs fall through to OpenCode with a log line.
const b = await run("2");
const bad = b.body.choices?.[0];
if (bad?.finish_reason !== "stop" || bad?.message?.tool_calls) fail("should fall through without tools\n" + JSON.stringify(b.body));
if (!/tool repair: failed after 2\/2/.test(b.stderr)) fail("no give-up log\n" + b.stderr);
console.log("ok: two failed repairs fall through with a log line");

stopAll();
process.exit(0);