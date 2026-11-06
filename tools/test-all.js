// Automated test runner for NOAPI?
// Tests the complete stack:
//  1. HTTP chat completion (non-streaming)
//  2. HTTP chat completion (streaming)
//  3. MCP in proxy mode (standalone bridge running, opencode spawns MCP proxy)
//  4. MCP in local mode (no standalone bridge, opencode spawns bridge + MCP directly)
//
// Every bridge it starts binds an EPHEMERAL port (`--port=0`) and the fake tab
// is given that exact port, so the suite can never talk to a real bridge or
// type test prompts into a real chat tab. See tools/lib/harness.js.
import {
  startBridge,
  startFake,
  spawnProxy,
  stopAll,
  waitForHealth,
  fetchJson,
  warnIfDefaultBridge,
  sleep,
} from "./lib/harness.js";

async function run() {
  await warnIfDefaultBridge();
  console.log("=== NOAPI? Test Suite ===\n");

  // Step 1: Start standalone bridge on an ephemeral port
  const { port: PORT, proc: bridgeProc } = await startBridge({
    onStderr: (s) => process.stderr.write("  [bridge] " + s),
  });
  const BASE = `http://127.0.0.1:${PORT}`;
  console.log(`1. Started standalone bridge on :${PORT}...`);

  await waitForHealth(PORT);
  console.log("   ✓ bridge is listening, health ok");

  // Step 2: Start fake browser extension (with simulated typing + streaming)
  console.log("2. Connecting fake browser extension...");
  const fakeLogs = [];
  const fakeProc = startFake({
    port: PORT,
    site: "chatgpt",
    env: {
      NOAPI_FAKE_FIRST_MS: "400",
      NOAPI_FAKE_TYPING_MS: "300",
      NOAPI_FAKE_STREAM_CHUNKS: "4",
      NOAPI_FAKE_STREAM_STEP_MS: "80",
      NOAPI_FAKE_TOOL_CALLS: "2",
      NOAPI_FAKE_TOOL_TAIL: "EXTRA_NARRATION that only arrives if nobody returned early",
    },
    onStdout: (d) => {
      fakeLogs.push(d);
      process.stderr.write("  [fake] " + d);
    },
  });

  const health2 = await waitForHealth(PORT, { clients: true });
  console.log(`   ✓ fake browser connected (clients: ${health2.clients.length})`);

  // Step 3: Test HTTP chat completions (non-stream)
  console.log("3. Testing POST /v1/chat/completions (non-stream)...");
  const comp1 = await fetchJson(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "chatgpt",
      messages: [{ role: "user", content: "What is 2+2?" }],
    }),
  });
  const text1 = comp1.data?.choices?.[0]?.message?.content || "";
  if (!text1.includes("fake chatgpt")) {
    throw new Error(`unexpected completion: ${JSON.stringify(comp1)}`);
  }
  console.log(`   ✓ got reply: "${text1.slice(0, 60)}..."`);

  // Step 3b: The bridge must expose per-stage timings in /health
  console.log("3b. Checking timings in /health...");
  const health3 = await fetchJson(`${BASE}/health`);
  const t = health3.data?.timings;
  if (!t || !t.last || typeof t.last.total !== "number") {
    throw new Error(`no timings in /health: ${JSON.stringify(t)}`);
  }
  if (!t.bySite?.chatgpt?.avg || typeof t.bySite.chatgpt.avg.total !== "number") {
    throw new Error(`no per-site timings in /health: ${JSON.stringify(t.bySite)}`);
  }
  for (const stage of ["composer", "typed", "sent", "firstText", "complete"]) {
    if (typeof t.last[stage] !== "number") throw new Error(`timing stage ${stage} missing: ${JSON.stringify(t.last)}`);
  }
  // Task 0: the report is only useful if the size fields and the post-token
  // overhead (the number every fast path is chasing) are present.
  if (typeof t.last.promptChars !== "number" || t.last.promptChars < 1) {
    throw new Error(`promptChars missing from timings: ${JSON.stringify(t.last)}`);
  }
  if (typeof t.last.replyChars !== "number" || t.last.replyChars < 1) {
    throw new Error(`replyChars missing from timings: ${JSON.stringify(t.last)}`);
  }
  if (typeof t.last.postToken !== "number" || t.last.postToken < 0) {
    throw new Error(`postToken missing from timings: ${JSON.stringify(t.last)}`);
  }
  console.log(`   ✓ timings exposed (total=${t.last.total}ms, firstText=${t.last.firstText}ms, complete=${t.last.complete}ms, postToken=${t.last.postToken}ms, prompt=${t.last.promptChars}ch, reply=${t.last.replyChars}ch)`);

  // Step 4: Test HTTP chat completions (streaming)
  console.log("4. Testing POST /v1/chat/completions (streaming)...");
  const streamResp = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "chatgpt",
      messages: [{ role: "user", content: "stream please" }],
      stream: true,
    }),
  });
  const streamText = await streamResp.text();
  if (!streamText.includes("data:") || !streamText.includes("[DONE]")) {
    throw new Error(`invalid SSE stream:\n${streamText}`);
  }
  const sseEvents = (raw) =>
    raw
      .split("\n")
      .filter((l) => l.startsWith("data: {"))
      .map((l) => JSON.parse(l.slice(6)));
  const streamEvents = sseEvents(streamText);
  const contentDeltas = streamEvents.map((e) => e.choices?.[0]?.delta?.content).filter((c) => typeof c === "string" && c);
  const streamed = contentDeltas.join("");
  if (!streamed.includes("[fake chatgpt]")) {
    throw new Error(`streamed content missing the reply:\n${streamText}`);
  }
  if (contentDeltas.length < 2) {
    throw new Error(`reply was not streamed in real deltas (${contentDeltas.length} content chunk(s))`);
  }
  if (streamed.includes("TOOL_CALL")) throw new Error("TOOL_CALL leaked into streamed content");
  console.log(`   ✓ streaming SSE received ${contentDeltas.length} content deltas + [DONE]`);

  // Step 4b: Early return on a complete TOOL_CALL (tools enabled). The fake
  // appends a narration tail that a real site would keep streaming; because the
  // content script returns as soon as the tool blocks settle, the tail must
  // never reach OpenCode, and the reply must carry the tool_calls instead.
  console.log("4b. Testing early return on tool calls (single and multiple)...");
  const TOOLS = [
    {
      type: "function",
      function: {
        name: "bash",
        description: "Run a shell command.",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      },
    },
  ];
  const toolRequest = (content) =>
    fetchJson(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt",
        messages: [{ role: "user", content }],
        tools: TOOLS,
      }),
    });

  const single = await toolRequest("SINGLE_TOOL please");
  const singleMsg = single.data?.choices?.[0]?.message || {};
  if ((singleMsg.tool_calls || []).length !== 1) {
    throw new Error(`expected 1 tool call, got: ${JSON.stringify(single)}`);
  }
  if (single.data?.choices?.[0]?.finish_reason !== "tool_calls") {
    throw new Error(`expected finish_reason tool_calls: ${JSON.stringify(single.data?.choices?.[0])}`);
  }
  if (JSON.stringify(singleMsg).includes("EXTRA_NARRATION")) {
    throw new Error(`early return did not cut the trailing narration: ${JSON.stringify(singleMsg)}`);
  }
  console.log("   ✓ single tool call returned early, no narration");

  const multi = await toolRequest("MULTI_TOOL please");
  const multiCalls = multi.data?.choices?.[0]?.message?.tool_calls || [];
  if (multiCalls.length !== 2) {
    throw new Error(`expected 2 tool calls (second block not cut off), got: ${JSON.stringify(multi)}`);
  }
  if (JSON.stringify(multi.data?.choices?.[0]?.message || {}).includes("EXTRA_NARRATION")) {
    throw new Error("early return leaked the narration on a multi-block reply");
  }
  console.log("   ✓ two consecutive tool calls returned early, neither cut off");

  // Step 4b2: NOAPI_EARLY_RETURN=0 is the kill switch. The bridge must not stop
  // the site early, so the trailing narration arrives and the tool call is still
  // parsed normally by the final completion path.
  console.log("4b2. Testing the early-return kill switch...");
  {
    const { port: killPort, proc: killBridge } = await startBridge({ env: { NOAPI_EARLY_RETURN: "0" } });
    const killFake = startFake({
      port: killPort,
      site: "chatgpt",
      env: {
        NOAPI_FAKE_FIRST_MS: "200",
        NOAPI_FAKE_STREAM_CHUNKS: "3",
        NOAPI_FAKE_STREAM_STEP_MS: "60",
        NOAPI_FAKE_TOOL_TAIL: "EXTRA_NARRATION after the block",
      },
    });
    await waitForHealth(killPort, { clients: true });
    const killed = await fetchJson(`http://127.0.0.1:${killPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "chatgpt", messages: [{ role: "user", content: "SINGLE_TOOL now" }], tools: TOOLS }),
    });
    const km = killed.data?.choices?.[0]?.message || {};
    if ((km.tool_calls || []).length !== 1) {
      throw new Error(`kill switch: expected the tool call anyway, got ${JSON.stringify(killed)}`);
    }
    if (!String(km.content || "").includes("EXTRA_NARRATION")) {
      throw new Error(`kill switch: the trailer should have arrived (no early stop), got ${JSON.stringify(km)}`);
    }
    const kh = await fetchJson(`http://127.0.0.1:${killPort}/health`);
    if (kh.data?.timings?.last?.earlyReturn === true) {
      throw new Error(`kill switch: earlyReturn was still reported: ${JSON.stringify(kh.data.timings.last)}`);
    }
    killBridge.kill();
    killFake.kill();
    await sleep(300);
  }
  console.log("   ✓ NOAPI_EARLY_RETURN=0 falls back to normal completion");

  // Step 4c: Streaming a tool reply must never show the protocol to the user.
  console.log("4c. Testing streaming tool calls...");
  const toolStreamResp = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "chatgpt",
      messages: [{ role: "user", content: "SINGLE_TOOL streamed" }],
      tools: TOOLS,
      stream: true,
    }),
  });
  const toolEvents = sseEvents(await toolStreamResp.text());
  const leakedContent = toolEvents
    .map((e) => e.choices?.[0]?.delta?.content)
    .filter((c) => typeof c === "string")
    .join("");
  if (leakedContent.includes("TOOL_CALL") || leakedContent.includes("mkdir")) {
    throw new Error(`TOOL_CALL protocol leaked into streamed content: ${JSON.stringify(leakedContent)}`);
  }
  const streamedCalls = toolEvents.flatMap((e) => e.choices?.[0]?.delta?.tool_calls || []);
  if (streamedCalls.length !== 1) {
    throw new Error(`expected exactly one streamed tool call, got ${streamedCalls.length}: ${JSON.stringify(streamedCalls)}`);
  }
  if (!JSON.stringify(streamedCalls[0]).includes("mkdir")) {
    throw new Error(`streamed tool call is wrong: ${JSON.stringify(streamedCalls[0])}`);
  }
  const toolFinishes = toolEvents.filter((e) => e.choices?.[0]?.finish_reason === "tool_calls").length;
  if (toolFinishes !== 1) throw new Error(`expected one tool_calls finish, got ${toolFinishes}`);
  console.log("   ✓ tool call streamed once, protocol text never shown");

  // Step 4d: browser errors must surface as an API error, not hang.
  console.log("4d. Testing browser error paths...");
  const errResp = await fetchJson(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "chatgpt", messages: [{ role: "user", content: "FORCE_ERROR now" }] }),
  });
  if (errResp.status !== 503 || !JSON.stringify(errResp.data).includes("fake failure")) {
    throw new Error(`browser error did not surface: ${JSON.stringify(errResp)}`);
  }
  console.log("   ✓ browser error -> HTTP 503");

  const midErrResp = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "chatgpt",
      messages: [{ role: "user", content: "FORCE_MIDSTREAM_ERROR now" }],
      stream: true,
    }),
  });
  const midErrText = await midErrResp.text();
  if (!midErrText.includes("fake mid-stream failure") || !midErrText.includes("[DONE]")) {
    throw new Error(`mid-stream error not surfaced:\n${midErrText}`);
  }
  console.log("   ✓ mid-stream browser error -> SSE error + [DONE]");

  // Step 4e: aborting mid-stream (Esc in OpenCode) must stop the site too.
  console.log("4e. Testing cancellation mid-stream...");
  const ac = new AbortController();
  const cancelled = fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: ac.signal,
    body: JSON.stringify({
      model: "chatgpt",
      messages: [{ role: "user", content: "cancel this streamed answer" }],
      stream: true,
    }),
  }).catch(() => null);
  await sleep(520);
  ac.abort();
  await cancelled;
  await sleep(800);
  if (!fakeLogs.join("").includes("cancelled")) {
    throw new Error("the fake browser was not told to cancel the request");
  }
  const healthCancel = await fetchJson(`${BASE}/health`);
  if ((healthCancel.data?.pending || []).length) {
    throw new Error(`request stayed pending after cancel: ${JSON.stringify(healthCancel.data.pending)}`);
  }
  console.log("   ✓ mid-stream cancel reached the browser and cleared the pending request");

  const health4 = await fetchJson(`${BASE}/health`);
  if (health4.data?.timings?.last?.earlyReturn !== true) {
    throw new Error(`early return not reported in /health: ${JSON.stringify(health4.data?.timings?.last)}`);
  }
  console.log("   ✓ /health reports earlyReturn for the tool request");

  const counters = health4.data?.stats?.chatgpt;
  if (!counters || counters.requests < 1) {
    throw new Error(`/health is missing per-site counters: ${JSON.stringify(health4.data?.stats)}`);
  }
  if (counters.completedByStop < 1) {
    throw new Error(`stop-button completions were not counted: ${JSON.stringify(counters)}`);
  }
  if (counters.earlyReturn < 1) {
    throw new Error(`early returns were not counted: ${JSON.stringify(counters)}`);
  }
  if (counters.sseSeen < 1) {
    throw new Error(`SSE-seen turns were not counted: ${JSON.stringify(counters)}`);
  }
  console.log(
    `   ✓ /health counters: requests=${counters.requests} sse=${counters.completedBySse} stop=${counters.completedByStop} fallback=${counters.completedByFallback} sseSeen=${counters.sseSeen} early=${counters.earlyReturn} resubmits=${counters.resubmits} aborted=${counters.aborted}`
  );

  // Step 4f: NOAPI_STREAM=0 restores the old "emit once at the end" behaviour.
  console.log("4f. Testing the streaming kill switch...");
  {
    const { port: nsPort, proc: nsBridge } = await startBridge({ env: { NOAPI_STREAM: "0" } });
    const nsFake = startFake({
      port: nsPort,
      site: "chatgpt",
      env: { NOAPI_FAKE_FIRST_MS: "200", NOAPI_FAKE_STREAM_CHUNKS: "4", NOAPI_FAKE_STREAM_STEP_MS: "40" },
    });
    await waitForHealth(nsPort, { clients: true });
    const nsResp = await fetch(`http://127.0.0.1:${nsPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "chatgpt", messages: [{ role: "user", content: "stream please" }], stream: true }),
    });
    const nsEvents = sseEvents(await nsResp.text());
    const nsDeltas = nsEvents.map((e) => e.choices?.[0]?.delta?.content).filter((c) => typeof c === "string" && c);
    if (nsDeltas.length !== 1) {
      throw new Error(`NOAPI_STREAM=0 should emit one content chunk, got ${nsDeltas.length}`);
    }
    if (!nsDeltas[0].includes("[fake chatgpt]")) {
      throw new Error(`NOAPI_STREAM=0 lost the reply: ${JSON.stringify(nsDeltas)}`);
    }
    nsBridge.kill();
    nsFake.kill();
    await sleep(300);
  }
  console.log("   ✓ NOAPI_STREAM=0 emits the reply once at the end");

  // Step 4g: NOAPI_NEW_CHAT=1 is forwarded to the tab for a fresh conversation.
  console.log("4g. Testing the new-chat flag...");
  {
    const { port: ncPort, proc: ncBridge } = await startBridge({ env: { NOAPI_NEW_CHAT: "1" } });
    const ncFake = startFake({ port: ncPort, site: "chatgpt", env: { NOAPI_FAKE_FIRST_MS: "120" } });
    await waitForHealth(ncPort, { clients: true });
    const ncResp = await fetch(`http://127.0.0.1:${ncPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "chatgpt", messages: [{ role: "user", content: "fresh chat please" }] }),
    });
    const ncJson = await ncResp.json();
    if (!String(ncJson.choices?.[0]?.message?.content || "").includes("[fake chatgpt]")) {
      throw new Error(`new-chat request failed: ${JSON.stringify(ncJson)}`);
    }
    const ncHealth = await (await fetch(`http://127.0.0.1:${ncPort}/health`)).json();
    if (ncHealth.timings?.last?.newChat !== true) {
      throw new Error(`new_chat was not requested: ${JSON.stringify(ncHealth.timings?.last)}`);
    }
    ncBridge.kill();
    ncFake.kill();
    await sleep(300);
  }
  console.log("   ✓ NOAPI_NEW_CHAT=1 asks the tab for a fresh chat");

  // Step 5: Test MCP in PROXY mode (bridge is running on the test port)
  console.log("5. Testing MCP stdio in proxy mode (forwarding to running bridge)...");
  const mcpProxy = spawnProxy(PORT);
  const proxyOut = [];
  mcpProxy.stdout.on("data", (d) => {
    for (const line of d.toString("utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed) {
        try {
          proxyOut.push(JSON.parse(trimmed));
        } catch {}
      }
    }
  });

  mcpProxy.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    }) + "\n"
  );
  await sleep(400);

  mcpProxy.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "status", arguments: {} },
    }) + "\n"
  );
  await sleep(400);

  mcpProxy.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "chat", arguments: { prompt: "MCP_TEST proxy", site: "chatgpt" } },
    }) + "\n"
  );
  await sleep(2500);

  mcpProxy.kill();
  const proxyChat = proxyOut.find((m) => m.id === 3);
  const proxyChatText = proxyChat?.result?.content?.[0]?.text || "";
  if (!proxyChatText.includes("MCP test reply")) {
    throw new Error(`MCP proxy chat failed: ${JSON.stringify(proxyChat)}`);
  }
  console.log(`   ✓ MCP proxy chat reply: "${proxyChatText.slice(0, 60)}..."`);

  // Clean up standalone bridge & fake
  bridgeProc.kill();
  fakeProc.kill();
  await sleep(1000);

  // Step 6: Test MCP in LOCAL mode (MCP process starts bridge directly)
  console.log("6. Testing MCP in LOCAL mode (no standalone bridge running)...");
  const { port: LOCAL_PORT, proc: mcpLocal } = await startBridge({ mcp: true });
  const localOut = [];
  mcpLocal.stdout.on("data", (d) => {
    for (const line of d.toString("utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed) {
        try {
          localOut.push(JSON.parse(trimmed));
        } catch {}
      }
    }
  });

  // Connect fake browser directly to the MCP process's bridge!
  const fakeProc2 = startFake({ port: LOCAL_PORT, site: "claude", env: { NOAPI_FAKE_FIRST_MS: "300" } });
  await waitForHealth(LOCAL_PORT, { clients: true });

  mcpLocal.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    }) + "\n"
  );
  await sleep(400);

  mcpLocal.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "chat", arguments: { prompt: "MCP_TEST local mode", site: "claude" } },
    }) + "\n"
  );
  await sleep(2500);

  mcpLocal.kill();
  fakeProc2.kill();

  const localChat = localOut.find((m) => m.id === 2);
  const localChatText = localChat?.result?.content?.[0]?.text || "";
  if (!localChatText.includes("MCP test reply")) {
    throw new Error(`MCP local chat failed: ${JSON.stringify(localChat)}`);
  }
  console.log(`   ✓ MCP local chat reply: "${localChatText.slice(0, 60)}..."`);

  console.log("\n=================================");
  console.log("  ALL TESTS PASSED SUCCESSFULLY!  ");
  console.log("=================================\n");
  stopAll();
  process.exit(0);
}

run().catch((err) => {
  console.error("\nTEST FAILED:", err.message);
  stopAll();
  setTimeout(() => process.exit(1), 200);
});