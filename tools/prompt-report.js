// prompt-report.js - measure the prompt the bridge sends to a website.
//
//   node tools/prompt-report.js [tools-fixture.json] [--samples tool-results.json]
//
// Defaults: tools/fixtures/opencode-tools.json and tools/fixtures/tool-results.json
//
// It reports:
//   - the length of the exact first-turn prompt (preamble + first user message)
//   - the marginal cost of each tool in the preamble, most expensive first
//   - the preamble size in "lean" description mode and with tools denied
//   - how many characters the lossless tool-result cleanup saves on samples
//
// The tools fixture is a representative OpenCode tool set; replace it with a
// captured real request body (the `tools` array) for exact numbers. See
// bridge/toolproto.js and NOAPI_DUMP_PREAMBLE.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPrompt, renderPreamble, toolList, tidyToolResult } from "../bridge/toolproto.js";

const DEFAULT_TOOLS = "tools/fixtures/opencode-tools.json";
const DEFAULT_SAMPLES = "tools/fixtures/tool-results.json";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function loadTools(file) {
  const doc = readJson(file);
  const tools = Array.isArray(doc) ? doc : doc.tools;
  if (!Array.isArray(tools)) throw new Error(`${file} does not contain a tools array`);
  return toolList(tools);
}

function loadSamples(file) {
  if (!fs.existsSync(file)) return [];
  const doc = readJson(file);
  return Array.isArray(doc) ? doc : doc.samples || [];
}

// Marginal preamble cost of one tool: the whole preamble with it, minus the
// preamble without any tool-specific lines.
export function perToolCost(tools) {
  const baseLen = renderPreamble([], []).length;
  return toolList(tools)
    .map((f) => ({ name: f.name, chars: renderPreamble([f], []).length - baseLen }))
    .sort((a, b) => b.chars - a.chars);
}

function parseArgs(argv) {
  const opts = { tools: DEFAULT_TOOLS, samples: DEFAULT_SAMPLES, deny: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--samples") opts.samples = argv[++i];
    else if (a.startsWith("--samples=")) opts.samples = a.slice(10);
    else if (a === "--deny") opts.deny = argv[++i];
    else if (a.startsWith("--deny=")) opts.deny = a.slice(7);
    else if (!a.startsWith("-")) opts.tools = a;
  }
  return opts;
}

function run() {
  const opts = parseArgs(process.argv.slice(2));
  const tools = loadTools(opts.tools);
  console.log("NOAPI? prompt report");
  console.log(`tools fixture: ${opts.tools} (${tools.length} tools)`);

  const messages = [{ role: "user", content: "hello" }];
  const full = buildPrompt(messages, tools, { includePreamble: true }).prompt;
  const preambleOnly = buildPrompt([], tools, { includePreamble: true }).prompt;
  console.log("");
  console.log(`full first-turn prompt:  ${full.length} chars  (~${Math.ceil(full.length / 4)} tokens)`);
  console.log(`preamble only:           ${preambleOnly.length} chars`);

  console.log("");
  console.log("most expensive tools (marginal preamble chars):");
  const costs = perToolCost(tools);
  const totalCost = costs.reduce((a, b) => a + b.chars, 0);
  for (const c of costs.slice(0, 8)) {
    const share = totalCost ? Math.round((c.chars / totalCost) * 100) : 0;
    console.log(`  ${c.name.padEnd(14)} ${String(c.chars).padStart(6)}  (${share}%)`);
  }

  // Lean description mode (NOAPI_DESC_MODE=lean): priority tools also get the
  // short caps. Tool semantics are unchanged.
  const prevMode = process.env.NOAPI_DESC_MODE;
  process.env.NOAPI_DESC_MODE = "lean";
  const leanLen = renderPreamble(tools, []).length;
  if (prevMode === undefined) delete process.env.NOAPI_DESC_MODE;
  else process.env.NOAPI_DESC_MODE = prevMode;
  const fullLen = renderPreamble(tools, []).length;
  console.log("");
  console.log(`preamble, full mode:     ${fullLen} chars`);
  console.log(`preamble, lean mode:     ${leanLen} chars  (${delta(fullLen, leanLen)})`);

  // NOAPI_TOOL_DENY: leave tools out of the preamble. They stay callable because
  // parseToolCalls validates against the request's tool list, not the preamble.
  const deny = opts.deny
    ? opts.deny.split(",").map((s) => s.trim()).filter(Boolean)
    : costs.slice(0, 3).map((c) => c.name);
  const denyLen = renderPreamble(tools, [], { deny }).length;
  console.log(`preamble, deny ${deny.join(",")}: ${denyLen} chars  (${delta(fullLen, denyLen)})`);
  console.log("  (denied tools stay callable: parsing validates against the request tool list)");

  // Task 3: lossless tool-result cleanup savings.
  const samples = loadSamples(opts.samples);
  if (samples.length) {
    console.log("");
    console.log(`tool-result cleanup (lossless) on ${opts.samples}:`);
    let before = 0;
    let after = 0;
    for (const s of samples) {
      const raw = String(s.text ?? "");
      const clean = tidyToolResult(raw);
      before += raw.length;
      after += clean.length;
      console.log(`  ${String(s.name || "sample").padEnd(32)} ${String(raw.length).padStart(7)} -> ${String(clean.length).padStart(7)}  (${delta(raw.length, clean.length)})`);
    }
    console.log(`  ${"total".padEnd(32)} ${String(before).padStart(7)} -> ${String(after).padStart(7)}  (${delta(before, after)})`);
  } else {
    console.log("");
    console.log(`(no samples at ${opts.samples}; skipping the cleanup measurement)`);
  }
}

export function delta(from, to) {
  const d = to - from;
  const pct = from ? Math.round((d / from) * 100) : 0;
  return `${d >= 0 ? "+" : ""}${d} chars, ${pct >= 0 ? "+" : ""}${pct}%`;
}

// Only run the CLI when invoked directly (not when imported by the test).
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) run();
