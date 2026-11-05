// Tool-calling round trip through the bridge using the fake browser.
import { startBridge, startFake, stopAll, waitForHealth, warnIfDefaultBridge } from "./lib/harness.js";

await warnIfDefaultBridge();
const { port: PORT } = await startBridge();
const fake = startFake({ port: PORT, site: "chatgpt" });
await waitForHealth(PORT, { clients: true });

const tools = [{ type: "function", function: { name: "bash", description: "Run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } }];
const url = `http://127.0.0.1:${PORT}/v1/chat/completions`;
const post = (messages, stream) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "chatgpt", messages, tools, stream }) });
const fail = (m) => {
  console.error("FAIL:", m);
  stopAll();
  process.exit(1);
};

const msgs = [{ role: "system", content: "Working directory: /tmp/x" }, { role: "user", content: "make a folder named chatgpt-test" }];
const raw = await (await post(msgs, true)).text();
if (!raw.includes('"reasoning_content"')) fail("no reasoning stream\n" + raw);
if (!raw.includes('"tool_calls"') || !raw.includes("mkdir chatgpt-test")) fail("no tool call\n" + raw);
if (!raw.includes('"finish_reason":"tool_calls"')) fail("bad finish reason");
if (raw.includes("TOOL_CALL")) fail("TOOL_CALL leaked into content");
console.log("ok: reasoning + tool_calls streamed");

const call = JSON.parse(raw.split("\n").filter((l) => l.startsWith("data: {") && l.includes('"tool_calls":[')).map((l) => l.slice(6))[0]).choices[0].delta.tool_calls[0];
const msgs2 = [...msgs, { role: "assistant", content: null, tool_calls: [{ id: call.id, type: "function", function: call.function }] }, { role: "tool", tool_call_id: call.id, content: "(no output)" }];
const r2 = await (await post(msgs2, false)).json();
const out = r2.choices[0].message.content;
if (!out.includes("Done") || r2.choices[0].finish_reason !== "stop") fail(JSON.stringify(r2));
console.log("ok: tool result -> final answer:", out);
stopAll();
process.exit(0);