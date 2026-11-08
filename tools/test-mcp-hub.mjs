// Hub self-detection and recursion guard (bridge/mcp.js). Run: node tools/test-mcp-hub.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

const { isSelfEntry, loadMcpConfig } = await import(
  process.env.MCP || "../bridge/mcp.js"
);

let n = 0;

const t = (name, fn) => {
  fn();
  n++;
  console.log("ok -", name);
};

// The old rule, kept here to show what it missed.
const oldSkips = (name, e) =>
  name === "noapi" ||
  (e.command && e.command.includes("bridge/index.js"));

const WIN = ["node", "C:\\NOAPI\\bridge\\index.js", "--mcp"];

t("old rule missed a Windows array command under another name (the bug)", () => {
  assert.equal(oldSkips("noapi-claude", { command: WIN }), false);
  assert.equal(oldSkips("bridge", { command: WIN }), false);
});

t("new rule skips them", () => {
  assert.equal(isSelfEntry("bridge", { command: WIN }), true);
  assert.equal(isSelfEntry("zai-brain", { command: WIN }), true);

  assert.equal(
    isSelfEntry("zai-brain", {
      command: "node C:\\NOAPI\\bridge\\index.js --mcp",
    }),
    true
  );

  assert.equal(
    isSelfEntry("x", {
      command: ["node"],
      args: ["/home/u/NOAPI/bridge/index.js", "--mcp"],
    }),
    true
  );

  assert.equal(isSelfEntry("NOAPI", { command: ["anything"] }), true);
  assert.equal(isSelfEntry("noapi-zai", { command: ["anything"] }), true);
});

t("other servers are kept", () => {
  assert.equal(
    isSelfEntry("files", {
      command: [
        "npx",
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "C:\\work",
      ],
    }),
    false
  );

  assert.equal(
    isSelfEntry("git", {
      command: "uvx mcp-server-git",
    }),
    false
  );
});

t("loadMcpConfig: self entries dropped, children flagged so they never start a hub", () => {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "hub-"));
  const f = nodePath.join(dir, "opencode.json");

  fs.writeFileSync(
    f,
    JSON.stringify({
      mcp: {
        noapi: { type: "local", command: WIN },
        again: { type: "local", command: WIN },
        files: { type: "local", command: ["npx", "-y", "srv"] },
      },
    })
  );

  const r = loadMcpConfig(f);

  assert.deepEqual(
    r.map((e) => e.name),
    ["files"]
  );

  assert.equal(r[0].env.NOAPI_HUB_CHILD, "1");
});

t("loadMcpConfig on a real-world OpenCode config (paths with spaces, environment, enabled)", () => {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "hub-"));
  const f = nodePath.join(dir, "opencode.json");

  fs.writeFileSync(
    f,
    JSON.stringify({
      mcp: {
        "packet-tracer": {
          type: "local",
          command: [
            "C:\\Users\\USER\\Documents\\Default Project\\MCP-Packet-Tracer\\.venv\\Scripts\\python.exe",
            "-m",
            "packet_tracer_mcp",
            "--stdio",
          ],
          timeout: 60000,
        },

        rea: {
          type: "local",
          environment: {
            JAVA_HOME: "C:\\jdk",
            REA_JADX_MCP_JAR: "C:\\jadx.jar",
          },
          command: [
            "C:\\Program Files\\nodejs\\node.exe",
            "C:\\x\\rea.mjs",
            "mcp",
          ],
        },

        codegraph: {
          type: "local",
          command: ["codegraph", "serve", "--mcp"],
          enabled: true,
        },

        off: {
          type: "local",
          command: ["x"],
          enabled: false,
        },

        noapi: {
          type: "local",
          command: [
            "node",
            "C:\\NOAPI\\bridge\\index.js",
            "--mcp",
          ],
          enabled: true,
          timeout: 30000,
        },
      },
    })
  );

  const r = loadMcpConfig(f);

  assert.deepEqual(
    r.map((e) => e.name),
    ["packet-tracer", "rea", "codegraph"]
  );

  const rea = r.find((e) => e.name === "rea");

  assert.ok(rea, "REA MCP entry should be present");

  // Windows may provide these values from the existing environment.
  // Check that they exist instead of requiring machine-specific paths.
  assert.ok(
    rea.env.JAVA_HOME,
    "REA JAVA_HOME should be set"
  );

  assert.ok(
    rea.env.REA_JADX_MCP_JAR,
    "REA JADX JAR path should be set"
  );

  assert.equal(
    rea.command,
    "C:\\Program Files\\nodejs\\node.exe"
  );
});

console.log(`\n${n} hub tests passed`);