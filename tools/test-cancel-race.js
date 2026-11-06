// Integration tests for the cancel / queue-release race, through a real
// WebSocket bridge and the fake browser tab (tools/fake-extension.js).
//
// The bug: a cancelled request released its per-site queue slot immediately, so
// the next request was dispatched while the tab was still unwinding the
// cancelled one. The tab answered "This tab is already handling a prompt." and
// OpenCode saw a 503. These tests drive that exact sequence and assert the next
// request is only delivered after the tab confirms it stopped.
//
// Every case starts its own bridge on an ephemeral port (tools/lib/harness.js),
// so it can never touch a real bridge or chat tab.
import { startBridge, startFake, waitForHealth, warnIfDefaultBridge, stopAll, sleep } from "./lib/harness.js";

let failed = 0;
function ok(name, cond, detail) {
  if (cond) console.log("ok:", name);
  else {
    console.error("FAIL:", name, detail === undefined ? "" : detail);
    failed++;
  }
}

const post = (base, content, signal) =>
  fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "chatgpt", messages: [{ role: "user", content }] }),
    signal,
  });

await warnIfDefaultBridge();

// ---- 1. abort defers the slot until the tab acks --------------------------
{
  let fakeOut = "";
  const bridgeLogs = [];
  const { port } = await startBridge({ env: { NOAPI_CANCEL_ACK_MS: "800" }, onStderr: (s) => bridgeLogs.push(s) });
  startFake({
    port,
    site: "chatgpt",
    env: { NOAPI_FAKE_CANCEL_ACK_MS: "400", NOAPI_FAKE_FIRST_MS: "200", NOAPI_FAKE_TYPING_MS: "80" },
    onStdout: (s) => (fakeOut += s),
  });
  await waitForHealth(port, { clients: true });
  const base = `http://127.0.0.1:${port}`;

  const ac = new AbortController();
  const aRequest = post(base, "A cancelled answer", ac.signal).catch(() => null);
  await sleep(180); // let A reach the tab and start generating
  ac.abort();
  await aRequest;
  const tAbort = Date.now();
  const bResp = await post(base, "B after cancel");
  const bBody = await bResp.text();
  const waited = Date.now() - tAbort;
  ok("B succeeds after A's cancel is acked", bResp.status === 200, `status=${bResp.status} body=${bBody.slice(0, 120)}`);
  ok("B's answer is the fake reply", /fake reply/.test(bBody), bBody.slice(0, 120));
  ok("B waited for A's cancel ack (>= 350ms)", waited >= 350, `waited=${waited}ms`);
  ok("the tab was never asked to run two responses at once (no busy)", !/busy/i.test(fakeOut), fakeOut.slice(-300));
  if (process.env.NOAPI_TEST_DEBUG) {
    console.log("DEBUG test1 fakeOut:", JSON.stringify(fakeOut));
    console.log("DEBUG test1 bridgeLogs:", JSON.stringify(bridgeLogs.join("")));
  }
}

// ---- 2. busy is retried, never surfaced -----------------------------------
{
  const { port } = await startBridge({});
  let fakeOut = "";
  startFake({
    port,
    site: "chatgpt",
    env: { NOAPI_FAKE_BUSY_TIMES: "1", NOAPI_FAKE_FIRST_MS: "150", NOAPI_FAKE_TYPING_MS: "60" },
    onStdout: (s) => (fakeOut += s),
  });
  await waitForHealth(port, { clients: true });
  const base = `http://127.0.0.1:${port}`;

  const resp = await post(base, "busy once");
  const body = await resp.text();
  ok("a busy rejection is retried until it succeeds", resp.status === 200, `status=${resp.status} body=${body.slice(0, 120)}`);
  ok("the busy text is never surfaced", !/already handling a prompt/i.test(body), body.slice(0, 120));
  ok("the retry reached the tab", /fake reply/.test(body), body.slice(0, 120));
  ok("the tab did report busy at least once", /busy/i.test(fakeOut), fakeOut.slice(-200));
}

// ---- 3. no ack at all: the safety timeout frees the slot and warns --------
{
  const logs = [];
  const { port } = await startBridge({ env: { NOAPI_CANCEL_ACK_MS: "300" }, onStderr: (s) => logs.push(s) });
  startFake({
    port,
    site: "chatgpt",
    env: { NOAPI_FAKE_IGNORE_CANCEL: "1", NOAPI_FAKE_FIRST_MS: "150", NOAPI_FAKE_TYPING_MS: "60" },
  });
  await waitForHealth(port, { clients: true });
  const base = `http://127.0.0.1:${port}`;

  const ac = new AbortController();
  const aRequest = post(base, "A ignored cancel", ac.signal).catch(() => null);
  await sleep(150);
  ac.abort();
  await aRequest;
  const tAbort = Date.now();
  const bResp = await post(base, "B after an ignored cancel");
  const bBody = await bResp.text();
  const waited = Date.now() - tAbort;
  ok("B still succeeds when the tab never acks", bResp.status === 200, `status=${bResp.status} body=${bBody.slice(0, 160)}`);
  ok("B waited past the safety timeout", waited >= 250, `waited=${waited}ms`);
  ok(
    "the bridge warned that no ack arrived",
    logs.join("").includes("no cancel acknowledgement"),
    logs.join("").slice(-300)
  );
}

stopAll();
if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nall cancel-race tests passed");
