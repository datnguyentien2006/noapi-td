// Frees the bridge port before `npm start` when an old bridge process still
// holds it (Windows keeps a port busy while a dead server's accepted sockets
// are still open, even with no LISTENING line in netstat).
// Only processes whose command line is this project's bridge/index.js are
// killed; anything else is reported and left alone.
// Hook it in package.json:  "prestart": "node tools/free-port.js"
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function parseNetstat(text, port) {
  const pids = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const c = line.trim().split(/\s+/);
    // Proto  Local  Foreign  State  PID   (UDP has no State column)
    if (c.length < 5 || !/^TCP$/i.test(c[0])) continue;
    const local = c[1];
    if (!local.endsWith(":" + port)) continue; // local side only: skip clients connected TO the port
    const pid = Number(c[c.length - 1]);
    if (pid > 0) pids.add(pid);
  }
  return [...pids];
}

export function isBridgeCmd(cmd) {
  return /bridge[\\/]+index\.js/i.test(String(cmd || ""));
}

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 });
}

function main() {
  const port = Number(process.env.NOAPI_PORT) || 8787;
  if (process.platform !== "win32") return; // elsewhere SO_REUSEADDR makes this unnecessary
  let pids = [];
  try {
    pids = parseNetstat(run("netstat", ["-ano", "-p", "tcp"]), port).filter((p) => p !== process.pid);
  } catch {
    return;
  }
  for (const pid of pids) {
    let cmd = "";
    try {
      cmd = run("powershell", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`]).trim();
    } catch {}
    if (isBridgeCmd(cmd)) {
      try {
        run("taskkill", ["/PID", String(pid), "/F"]);
        process.stderr.write(`[noapi] freed port ${port}: stopped old bridge process ${pid}\n`);
      } catch (e) {
        process.stderr.write(`[noapi] could not stop old bridge process ${pid}: ${e.message}\n`);
      }
    } else {
      process.stderr.write(`[noapi] port ${port} is held by pid ${pid} (${cmd || "unknown command"}) - not a NOAPI bridge, leaving it\n`);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
