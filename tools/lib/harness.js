// Shared harness for the test scripts and the benchmark.
//
// Every test starts its OWN bridge on an ephemeral port (`--port=0`, the OS
// picks a free one) and passes that exact port to the fake browser tab. This
// makes it impossible for a test to talk to a bridge you run for real, or to
// type a test prompt into a real chat tab that happens to be connected.
//
// Nothing in here connects to 8787. `warnIfDefaultBridge()` only probes whether
// something is listening there, so the output can say the real bridge was left
// alone.
import { spawn } from "node:child_process";
import net from "node:net";

export const DEFAULT_PORT = 8787;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const children = new Set();

function track(proc) {
  children.add(proc);
  proc.once("exit", () => children.delete(proc));
  return proc;
}

export function stopAll() {
  for (const p of children) {
    try {
      p.kill();
    } catch {}
  }
  children.clear();
}

// An ephemeral port is one the OS assigned: never 0 in practice and never the
// default bridge port. Refuse loudly rather than risk a real conversation.
export function assertEphemeralPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid test port: ${port}`);
  }
  if (port === DEFAULT_PORT) {
    throw new Error(
      `refusing to use the default bridge port ${DEFAULT_PORT}: tests must use an ephemeral port so they can never reach a real bridge or chat tab`
    );
  }
}

// Is something (probably your real bridge) listening on 8787? We only look, we
// never send anything. Used for a friendly note and by test-isolation.js.
export function probeDefaultPort(timeoutMs = 400) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: "127.0.0.1", port: DEFAULT_PORT });
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      try {
        s.destroy();
      } catch {}
      resolve(v);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    setTimeout(() => done(false), timeoutMs);
  });
}

export async function warnIfDefaultBridge() {
  if (await probeDefaultPort()) {
    console.log(
      `note: something is listening on the default port ${DEFAULT_PORT} (likely your real bridge). ` +
        "Tests use their own ephemeral ports and will not touch it."
    );
  }
}

// Start a bridge on an ephemeral port and wait until it reports the port it
// actually bound. Returns { proc, port }.
export async function startBridge({ mcp = false, port = 0, extraArgs = [], env = {}, onStderr = null } = {}) {
  if (port !== 0) assertEphemeralPort(port);
  const args = ["bridge/index.js"];
  if (mcp) args.push("--mcp");
  args.push(`--port=${port}`, ...extraArgs);
  const proc = track(
    spawn("node", args, { cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] })
  );

  let buf = "";
  const actual = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("bridge did not report its listening port")), 15_000);
    proc.stderr.on("data", (d) => {
      const s = d.toString();
      buf += s;
      onStderr?.(s);
      const m = buf.match(/listening on http:\/\/[^:]+:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    proc.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`bridge exited before listening (code ${code})`));
    });
  });
  assertEphemeralPort(actual);
  return { proc, port: actual };
}

// A bridge that is already running elsewhere: start `--mcp` in proxy mode
// against the given (ephemeral) port. It will not bind anything.
export function spawnProxy(port) {
  assertEphemeralPort(port);
  return track(
    spawn("node", ["bridge/index.js", "--mcp", `--port=${port}`], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    })
  );
}

// Start the fake browser tab and point it at the test's own bridge. The port is
// passed explicitly, so the fake can never fall back to the default.
export function startFake({ port, site = "chatgpt", env = {}, onStdout = null, onStderr = null } = {}) {
  assertEphemeralPort(port);
  const proc = track(
    spawn("node", ["tools/fake-extension.js", site], {
      cwd: process.cwd(),
      env: { ...process.env, NOAPI_PORT: String(port), ...env },
      stdio: ["ignore", "pipe", "pipe"],
    })
  );
  if (onStdout) proc.stdout.on("data", (d) => onStdout(d.toString()));
  if (onStderr) proc.stderr.on("data", (d) => onStderr(d.toString()));
  return proc;
}

export async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  const text = await r.text();
  try {
    return { status: r.status, data: JSON.parse(text) };
  } catch {
    return { status: r.status, raw: text };
  }
}

// Wait until /health answers (and, optionally, until a browser client is
// registered) on the given ephemeral port.
export async function waitForHealth(port, { clients = false, timeoutMs = 15_000 } = {}) {
  assertEphemeralPort(port);
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  for (;;) {
    try {
      const h = await (await fetch(`${base}/health`)).json();
      if (h?.ok && (!clients || h.clients?.length)) return h;
    } catch {}
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for the test bridge on :${port}`);
    await sleep(100);
  }
}