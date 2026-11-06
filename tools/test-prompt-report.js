// Unit tests for tools/prompt-report.js: the pure helpers and the fixtures.
// No browser, no network, no bridge.
import fs from "node:fs";
import { perToolCost, delta } from "./prompt-report.js";

let failed = 0;
function ok(name, cond, extra = "") {
  if (cond) console.log("ok:", name);
  else {
    console.error("FAIL:", name, extra);
    failed++;
  }
}

// ---- delta: the human-readable size change ----------------------------------
ok("delta reports a shrink", delta(100, 70) === "-30 chars, -30%", delta(100, 70));
ok("delta reports growth with a plus", delta(100, 130) === "+30 chars, +30%", delta(100, 130));
ok("delta of zero change", delta(50, 50) === "+0 chars, +0%", delta(50, 50));
ok("delta from zero does not divide by zero", delta(0, 10) === "+10 chars, +0%", delta(0, 10));

// ---- perToolCost: marginal preamble cost, most expensive first --------------
const fn = (name, description) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties: { x: { type: "string", description } } } },
});
const tiny = fn("t", "short");
const big = fn("b", "x".repeat(180));
const costs = perToolCost([tiny, big]);
ok("perToolCost returns one row per tool", costs.length === 2, JSON.stringify(costs));
ok("perToolCost sorts by cost, descending", costs[0].name === "b" && costs[1].name === "t", JSON.stringify(costs));
ok("a longer description costs more", costs[0].chars > costs[1].chars, JSON.stringify(costs));
ok("perToolCost never returns a negative cost", costs.every((c) => c.chars >= 0), JSON.stringify(costs));

// ---- the shipped fixtures parse and look sane ------------------------------
const toolsDoc = JSON.parse(fs.readFileSync("tools/fixtures/opencode-tools.json", "utf8"));
ok("tools fixture has a tools array with entries", Array.isArray(toolsDoc.tools) && toolsDoc.tools.length > 0);
ok("every fixture tool has a name and parameters", toolsDoc.tools.every((t) => t.function?.name && t.function?.parameters));

const samplesDoc = JSON.parse(fs.readFileSync("tools/fixtures/tool-results.json", "utf8"));
ok("tool-result fixture has samples", Array.isArray(samplesDoc.samples) && samplesDoc.samples.length > 0);
ok("every sample has a name and text", samplesDoc.samples.every((s) => s.name && typeof s.text === "string"));

if (failed) {
  console.error(`\n${failed} prompt-report test(s) failed`);
  process.exit(1);
}
console.log("\nall prompt-report tests passed");
