#!/usr/bin/env node
// NOAPI? bridge — bridges opencode <-> your browser <-> AI websites.
//
//   node index.js            # standalone: HTTP + WebSocket server
//   node index.js --mcp      # same, plus MCP server on stdio (for opencode)
//
// If the port is already in use (e.g. you run a standalone bridge) and this
// process is started by opencode with --mcp, it falls back to *proxy* mode:
// it connects to the running bridge and forwards MCP tool calls to it.
//
// Flags:
//   --port=8787     TCP port for HTTP/WS (default 8787)
//   --host=127.0.0.1  bind address (default 127.0.0.1 — keep it local!)
//   --mcp           also run the MCP server on stdin/stdout

import { Bridge } from "./state.js";
import { createHttpServer } from "./http.js";
import { attachWebSocketServer } from "./ws.js";
import { requestAllowed } from "./security.js";
import { runMcpStdio, ProxyGateway } from "./mcp.js";
import { tuningFromEnv, sseTextFromEnv } from "./tuning.js";

function parseArgs(argv) {
  const args = { port: 8787, host: "127.0.0.1", mcp: false, proxyOnly: process.env.NOAPI_MCP_PROXY_ONLY === "1" };
  for (const a of argv) {
    if (a === "--mcp") args.mcp = true;
    else if (a === "--proxy-only") args.proxyOnly = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a.startsWith("--port=")) args.port = Number(a.slice(7));
    else if (a.startsWith("--host=")) args.host = a.slice(7);
  }
  return args;
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
}

// Connection-flood protection. A client stuck in a reconnect loop must not be
// able to bury the log or exhaust the bridge (and, through loopback ports, the
// machine): cap the open sockets and the ones still waiting for their hello.
const MAX_WS = Number(process.env.NOAPI_MAX_WS) || 256;
const MAX_PENDING_HELLO = Number(process.env.NOAPI_MAX_PENDING_HELLO) || 32;

// Log the first event at once, then at most one summary line per window.
function burstLogger(log, label, windowMs = 3000) {
  let extra = 0;
  let timer = null;
  return () => {
    if (!timer) {
      log(label);
      timer = setTimeout(() => {
        if (extra) log(`${label} (+${extra} more in the last ${windowMs / 1000}s)`);
        extra = 0;
        timer = null;
      }, windowMs);
      timer.unref?.();
    } else extra++;
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      "NOAPI? bridge\n" +
        "usage: node bridge/index.js [--mcp] [--port=8787] [--host=127.0.0.1]\n"
    );
    return;
  }
  // 0 means "let the OS pick a free port"; anything else must be usable.
  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) {
    process.stderr.write("invalid --port\n");
    process.exit(1);
  }

  const log = (...a) => process.stderr.write("[noapi] " + a.join(" ") + "\n");
  const logProxy = burstLogger(log, "mcp proxy client connected (this process will forward to this bridge)");
  const logNoHello = burstLogger(log, "closing websocket that never sent a hello");
  const logRefused = burstLogger(log, "refusing websocket: too many open or unidentified connections (NOAPI_MAX_WS / NOAPI_MAX_PENDING_HELLO)");
  let helloPending = 0; // sockets that opened and have not said hello yet

  // ---- start the HTTP + WS server (the actual bridge) ----
  let bridge = null;
  let server = null;
  let allConns = new Set();
  try {
    if (args.mcp && args.proxyOnly) {
      // Started by OpenCode: never own the port, only forward to the standalone
      // bridge (npm start). Otherwise this process grabs 8787 whenever the
      // standalone bridge is down and `npm start` then fails with EADDRINUSE.
      const e = new Error("proxy-only");
      e.proxyOnly = true;
      throw e;
    }
    const b = new Bridge({ log, cancelAckMs: Number(process.env.NOAPI_CANCEL_ACK_MS) || 5000 });
    server = createHttpServer(b, log, { host: args.host });
    function handleProxyMessage(conn, msg) {
      if (msg.t === "proxy-status") {
        conn.send(JSON.stringify({ t: "proxy-status-response", id: msg.id, data: b.status() }));
      } else if (msg.t === "proxy-sites") {
        conn.send(JSON.stringify({ t: "proxy-sites-response", id: msg.id, data: b.sites() }));
      } else if (msg.t === "proxy-request") {
        const timeoutMs = Math.min(Math.max(Number(msg.timeout_ms) || 180_000, 10_000), 600_000);
        b
          .requestPrompt({
            prompt: String(msg.prompt || ""),
            system: msg.system || undefined,
            site: msg.site || undefined,
            timeoutMs,
            toolsEnabled: Boolean(msg.tools_enabled),
            earlyReturn: msg.early_return !== false,
            earlyReturnMs: Number(msg.early_return_ms) || 400,
            toolNames: Array.isArray(msg.tool_names) ? msg.tool_names : [],
            tuning: tuningFromEnv(),
            sseText: sseTextFromEnv(),
          })
          .then((text) => {
            conn.send(JSON.stringify({ t: "proxy-response", id: msg.id, data: text }));
          })
          .catch((err) => {
            conn.send(JSON.stringify({ t: "proxy-error", id: msg.id, error: err.message }));
          });
      }
    }

    // Every open WebSocket (browser tabs and MCP proxies), so shutdown can close
    // them: server.close() alone waits for them forever.
    allConns = new Set();
    attachWebSocketServer(server, {
      verify: (req) => {
        const ok = requestAllowed(req, args.host);
        if (!ok) log(`blocked websocket from origin "${req.headers.origin || "?"}"`);
        if (ok && (allConns.size >= MAX_WS || helloPending >= MAX_PENDING_HELLO)) {
          logRefused();
          return false;
        }
        return ok;
      },
      onOpen: (conn) => {
        allConns.add(conn);
        conn.awaitingHello = true;
        helloPending++;
        conn.helloTimer = setTimeout(() => {
          if (!b.clients.has(conn) && !conn.isProxy) {
            logNoHello();
            conn.close();
          }
        }, 10_000);
      },
      onMessage: (conn, text) => {
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        if (msg.t === "hello") {
          clearTimeout(conn.helloTimer);
          if (conn.awaitingHello) {
            conn.awaitingHello = false;
            helloPending--;
          }
          if (msg.client === "noapi-mcp-proxy") {
            conn.isProxy = true;
            logProxy();
            conn.send(JSON.stringify({ t: "welcome", bridge: "noapi-bridge", version: "0.1.0" }));
            return;
          }
          b.register(conn, { site: msg.site || null, url: msg.url || null });
          conn.send(JSON.stringify({ t: "welcome", bridge: "noapi-bridge", version: "0.1.0" }));
        } else if (msg.t === "hello-update") {
          b.register(conn, { site: msg.site || null, url: msg.url || null });
        } else if (msg.t === "heartbeat") {
          b.touch(conn);
          if (msg.site) b.register(conn, { site: msg.site, url: msg.url });
        } else if (msg.t === "response") {
          b.respond(conn, msg.id, msg.text, msg.timings);
        } else if (msg.t === "cancelled") {
          // The tab (or its background) confirms it stopped a cancelled request.
          b.ackCancelled(msg.id);
        } else if (msg.t === "site-gone") {
          // A tab closed and no tab of that site is left.
          b.removeSite(conn, msg.site);
        } else if (msg.t === "progress") {
          b.progress(msg.id, msg.status, { site: msg.site, lateGrowth: msg.lateGrowth });
        } else if (msg.t === "partial") {
          b.partial(msg.id, msg.text);
        } else if (msg.t === "error") {
          b.fail(conn, msg.id, msg.error, msg.code);
        } else if (msg.t === "ping") {
          conn.send(JSON.stringify({ t: "pong" }));
        } else if (conn.isProxy) {
          handleProxyMessage(conn, msg);
        }
      },
      onClose: (conn) => {
        allConns.delete(conn);
        clearTimeout(conn.helloTimer);
        if (conn.awaitingHello) {
          conn.awaitingHello = false;
          helloPending--;
        }
        b.unregister(conn);
      },
    });
    await listen(server, args.port, args.host);
    bridge = b; // only usable after the port is actually bound
    // --port=0 asks the OS for a free port. Report and use the real one so the
    // MCP proxy path and the tests do not keep referring to 0.
    args.port = server.address().port;
    log(`listening on http://${args.host}:${args.port}`);
    log("dashboard: http://127.0.0.1:" + args.port + "/");
  } catch (err) {
    if (err.proxyOnly) {
      log("MCP proxy-only mode: not listening, forwarding to the bridge on port " + args.port);
    } else if (err.code === "EADDRINUSE" && args.mcp) {
      log(`port ${args.port} is in use — assuming a bridge is already running; running in proxy mode`);
    } else {
      log(`failed to start: ${err.message}`);
      log("if the port is taken, try: node bridge/index.js --port=8788 (and update opencode.json)");
      process.exit(1);
    }
  }

  // ---- MCP on stdio ----
  let gateway;
  if (bridge) {
    gateway = bridge;
  } else {
    const proxy = new ProxyGateway(`ws://${args.host}:${args.port}`, { log });
    proxy._connect();
    gateway = proxy;
    log("MCP active in proxy mode (forwarding to the running bridge)");
  }
  if (args.mcp) runMcpStdio(gateway, log);

  // server.close() only stops NEW connections and its callback waits until every
  // existing one has ended. The extension's WebSocket never ends by itself, so
  // the old shutdown never reached process.exit: the process stayed alive as a
  // zombie, the extension stayed "connected" to it and never reconnected to the
  // next bridge. Close the sockets, and never wait more than 2s.
  let shuttingDown = false;
  let firstAt = 0;
  const shutdown = (sig) => {
    if (shuttingDown) {
      // A duplicate signal from the same Ctrl+C is ignored; a deliberate second
      // press later than 1s forces the exit.
      if (Date.now() - firstAt > 1000) {
        log(`${sig} again - forcing exit`);
        process.exit(0);
      }
      return;
    }
    shuttingDown = true;
    firstAt = Date.now();
    log(`shutting down (${sig})`);
    setTimeout(() => process.exit(0), 2000).unref();
    try {
      gateway?.stop?.();
    } catch {}
    for (const conn of allConns) {
      try {
        conn.close();
      } catch {}
    }
    if (server) {
      server.close(() => process.exit(0));
      server.closeAllConnections?.(); // Node 18.2+: drop idle/keep-alive HTTP sockets
    } else {
      process.exit(0);
    }
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) {
    process.on(sig, () => shutdown(sig));
  }
}

main();