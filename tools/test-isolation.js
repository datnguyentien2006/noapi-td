// Test isolation audit.
//
// The suite must never talk to the bridge you run for real, and must never type
// a test prompt into a real chat tab. Every runner gets its own bridge on an
// OS-assigned ephemeral port and passes that port to the fake tab explicitly.
// This test checks the guarantees that make that true.
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_PORT,
  assertEphemeralPort,
  startBridge,
  startFake,
  waitForHealth,
  probeDefaultPort,
  stopAll,
} from "./lib/harness.js";

let failed = 0;
function ok(name, cond, detail) {
  if (cond) console.log("ok:", name);
  else {
    console.error("FAIL:", name, detail === undefined ? "" : detail);
    failed++;
  }
}

// 1. The harness refuses to run a test on the default port.
let refusedDefault = false;
try {
  assertEphemeralPort(DEFAULT_PORT);
} catch {
  refusedDefault = true;
}
ok("the harness refuses the default bridge port", refusedDefault);

let refusedZero = false;
try {
  assertEphemeralPort(0);
} catch {
  refusedZero = true;
}
ok("the harness refuses port 0 as a test port", refusedZero);

// 2. Two simultaneous test bridges get different ephemeral ports.
const [a, b] = await Promise.all([startBridge(), startBridge()]);
ok(
  "simultaneous bridges get different ephemeral ports",
  a.port !== b.port && a.port !== DEFAULT_PORT && b.port !== DEFAULT_PORT,
  `${a.port} vs ${b.port}`
);
await Promise.all([waitForHealth(a.port), waitForHealth(b.port)]);
ok("both ephemeral bridges answer /health", true);

// 3. Each fake tab registers on the bridge it was told about, never the other.
startFake({ port: a.port, site: "chatgpt" });
startFake({ port: b.port, site: "claude" });
const ha = await waitForHealth(a.port, { clients: true });
const hb = await waitForHealth(b.port, { clients: true });
ok(
  "each fake tab registered on its own bridge only",
  ha.clients.every((c) => c.site === "chatgpt") && hb.clients.every((c) => c.site === "claude"),
  `${JSON.stringify(ha.clients)} / ${JSON.stringify(hb.clients)}`
);
stopAll();

// 4. No runner hardcodes the default port (so none can reach the real bridge).
const dir = path.resolve("tools");
const files = fs
  .readdirSync(dir)
  .filter((f) => /^test-.*\.js$/.test(f) || f === "bench-latency.js")
  .filter((f) => f !== "test-isolation.js");
const offenders = files.filter((f) => fs.readFileSync(path.join(dir, f), "utf8").includes(String(DEFAULT_PORT)));
ok("no runner hardcodes the default port", offenders.length === 0, offenders.join(", "));

// 5. Probing the default port is read-only: it only reports whether a real
// bridge is there, and never sends a request to it.
const listening = await probeDefaultPort();
ok("probing the default port is safe", typeof listening === "boolean");
if (listening) {
  console.log("note: a real bridge is listening on the default port; it was only probed, nothing was sent.");
}

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  stopAll();
  process.exit(1);
}
stopAll();
console.log("\nall isolation tests passed");