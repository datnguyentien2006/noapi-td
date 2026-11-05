// Unit tests for the small pure functions that live inside the content script.
//
// The content script only runs in a browser (it is a DOM-automation script), so
// the few decisions that must be correct are written as self-contained functions
// between `@noapi-shared` markers. This test lifts those blocks out of
// extension/*/content.js and runs them in Node, which gives real coverage for
// logic that otherwise could only be checked by hand on a live site. The blocks
// must stay identical in both browsers, so the test also verifies that.
import fs from "node:fs";

function extractShared(file, name) {
  const src = fs.readFileSync(file, "utf8");
  const re = new RegExp(
    "\\/\\* @noapi-shared-start " + name + " \\*\\/([\\s\\S]*?)\\/\\* @noapi-shared-end " + name + " \\*\\/"
  );
  const m = src.match(re);
  if (!m) throw new Error(`shared block "${name}" not found in ${file}`);
  return m[1];
}

function loadShared(name, { wrap = "", fn = name } = {}) {
  const chrome = extractShared("extension/chrome/content.js", name);
  const firefox = extractShared("extension/firefox/content.js", name);
  if (chrome !== firefox) {
    throw new Error(`shared block "${name}" differs between chrome and firefox content.js`);
  }
  const body = wrap ? wrap.replace("/* SHARED */", chrome) : chrome;
  return new Function(`${body}\nreturn ${fn};`)();
}

let failed = 0;
function ok(name, cond) {
  if (cond) console.log("ok:", name);
  else {
    console.error("FAIL:", name);
    failed++;
  }
}

// ---- completionDecision (Phase 1) -----------------------------------------
// (lastTextLength, stopVisible, stopSeen, quietMs, debounceMs, fallbackMs)
const complete = loadShared("completionDecision");

ok("no completion on an empty reply", !complete(0, false, true, 10_000, 400, 2200));
ok("no completion on a tiny reply", !complete(4, false, true, 10_000, 400, 2200));
ok("no completion while the stop button is visible", !complete(50, true, true, 10_000, 400, 2200));
ok("stop seen: completes after the per-site debounce", complete(50, false, true, 400, 400, 2200));
ok("stop seen: not before the debounce", !complete(50, false, true, 399, 400, 2200));
ok("stop never seen: waits for the long fallback", !complete(50, false, false, 2199, 400, 2200));
ok("stop never seen: completes at the long fallback", complete(50, false, false, 2200, 400, 2200));
ok("faster debounce completes sooner", complete(50, false, true, 350, 350, 2200) && !complete(50, false, true, 350, 400, 2200));

// ---- early return on a complete TOOL_CALL (Phase 4) -----------------------
const early = loadShared("toolEarlyReturn", { fn: "toolEarlyReturnDecision" });
const completeCall =
  "On it.\n```\nTOOL_CALL\n{\"name\":\"bash\",\"arguments\":{\"command\":\"mkdir x\"}}\n```";
const secondCall =
  "```\nTOOL_CALL\n{\"name\":\"read\",\"arguments\":{\"filePath\":\"a.txt\"}}\n```";

ok("plain text is not a tool call", !early(true, "just a normal answer", 10_000, 400));
ok("tool marker without a fence is not complete", !early(true, "TOOL_CALL {\"name\":\"bash\"}", 10_000, 400));
ok(
  "unclosed tool JSON is not complete",
  !early(true, "```\nTOOL_CALL\n{\"name\":\"bash\",\"arguments\":{", 10_000, 400)
);
ok(
  "brace inside a JSON string does not end the object early",
  early(true, "```\nTOOL_CALL\n{\"name\":\"bash\",\"arguments\":{\"command\":\"echo {x}\"}}\n```", 10_000, 400)
);
ok("a complete tool call is actionable", early(true, completeCall, 400, 400));
ok("but not before the quiet window", !early(true, completeCall, 399, 400));
ok("tools disabled: never early-returns", !early(false, completeCall, 10_000, 400));
ok("two complete blocks: still actionable", early(true, completeCall + "\n" + secondCall, 400, 400));
ok(
  "a second block still streaming is NOT cut off",
  !early(true, completeCall + "\n```\nTOOL_CALL\n{\"name\":\"read\",\"arg", 10_000, 400)
);
ok(
  "trailing narration after the block waits for real completion",
  !early(true, completeCall + "\nNow let me explain the change I made.", 10_000, 400)
);

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nall content-script logic tests passed");
