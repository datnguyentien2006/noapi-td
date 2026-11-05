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
const countBlocks = loadShared("toolEarlyReturn", { fn: "toolBlockCount" });
const completeCall =
  "On it.\n```\nTOOL_CALL\n{\"name\":\"bash\",\"arguments\":{\"command\":\"mkdir x\"}}\n```";
const secondCall =
  "```\nTOOL_CALL\n{\"name\":\"read\",\"arguments\":{\"filePath\":\"a.txt\"}}\n```";
const TOOL_NAMES = ["bash", "read"];
const decision = (over = {}) =>
  early({ toolsEnabled: true, enabled: true, quietMs: 10_000, earlyReturnMs: 400, toolNames: TOOL_NAMES, ...over });

ok("plain text is not a tool call", !decision({ replyText: "just a normal answer" }));
ok("tool marker without a fence is not complete", !decision({ replyText: "TOOL_CALL {\"name\":\"bash\"}" }));
ok(
  "unclosed tool JSON is not complete",
  !decision({ replyText: "```\nTOOL_CALL\n{\"name\":\"bash\",\"arguments\":{" })
);
ok(
  "invalid JSON is not complete",
  !decision({ replyText: "```\nTOOL_CALL\n{\"name\":\"bash\",\"arguments\":{oops}}\n```" })
);
ok(
  "a block for an unknown tool is not actionable",
  !decision({ replyText: "```\nTOOL_CALL\n{\"name\":\"nope\",\"arguments\":{}}\n```" })
);
ok(
  "brace inside a JSON string does not end the object early",
  decision({ replyText: "```\nTOOL_CALL\n{\"name\":\"bash\",\"arguments\":{\"command\":\"echo {x}\"}}\n```" })
);
ok("a complete tool call is actionable", decision({ replyText: completeCall }));
ok("but not before the quiet window", !decision({ replyText: completeCall, quietMs: 399 }));
ok("tools disabled: never early-returns", !decision({ replyText: completeCall, toolsEnabled: false }));
ok("kill switch: never early-returns or stops", !decision({ replyText: completeCall, enabled: false }));
ok("two complete blocks: still actionable", decision({ replyText: completeCall + "\n" + secondCall }));
ok(
  "a second block still streaming is NOT cut off",
  !decision({ replyText: completeCall + "\n```\nTOOL_CALL\n{\"name\":\"read\",\"arg" })
);
ok(
  "trailing narration after the block waits for real completion",
  !decision({ replyText: completeCall + "\nNow let me explain the change I made." })
);

// A gap shorter than the grace window: both blocks land before it expires, so
// the reply ends with the second complete block and is actionable.
ok(
  "two blocks with a gap shorter than the window are returned together",
  decision({ replyText: completeCall + "\n" + secondCall, quietMs: 400 })
);
// A gap longer than the window while the site keeps generating: the first block
// is complete and quiet, but the site is still writing, so we must not stop yet.
ok(
  "a gap longer than the window is extended while the site is still generating",
  !decision({ replyText: completeCall, quietMs: 400, generating: true, sinceBlockMs: 400 })
);
ok(
  "...and it stops at the hard cap",
  decision({ replyText: completeCall, quietMs: 400, generating: true, sinceBlockMs: 1500 })
);
ok(
  "...but not if the site is already idle",
  decision({ replyText: completeCall, quietMs: 400, generating: false })
);

// The re-read after clicking stop compares complete-block counts.
ok("toolBlockCount counts complete blocks", countBlocks(completeCall + "\n" + secondCall, TOOL_NAMES) === 2);
ok("toolBlockCount ignores invalid JSON", countBlocks("```\nTOOL_CALL\n{oops}\n```", TOOL_NAMES) === 0);
ok("toolBlockCount ignores unknown tools", countBlocks("```\nTOOL_CALL\n{\"name\":\"nope\",\"arguments\":{}}\n```", TOOL_NAMES) === 0);

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nall content-script logic tests passed");
