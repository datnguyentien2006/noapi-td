// Unit tests for bridge/tuning.js: the environment knobs the bridge reads and
// forwards to the content script (a content script cannot read process.env).
//
// These lock down the safety contract: an unset, empty or invalid value keeps
// the content script's shipped default, and every accepted value is clamped so
// a typo can never wedge the client (a 0 ms debounce would complete a turn on a
// half-painted reply; a giant tick would stall the timeout checks).
import { tuningFromEnv, sseTextFromEnv } from "../bridge/tuning.js";

let failed = 0;
function ok(name, cond, extra = "") {
  if (cond) console.log("ok:", name);
  else {
    console.error("FAIL:", name, extra);
    failed++;
  }
}

// ---- defaults: nothing set means an empty patch ----------------------------
ok("no env vars -> no overrides", JSON.stringify(tuningFromEnv({})) === "{}", JSON.stringify(tuningFromEnv({})));

// ---- read + validate a representative knob from each family ----------------
{
  const t = tuningFromEnv({
    NOAPI_DEBOUNCE_MS: "220",
    NOAPI_SSE_END_REREAD_MS: "60",
    NOAPI_EARLY_RETURN_REREAD_MS: "0",
    NOAPI_EXTRACT_THROTTLE_MS: "80",
    NOAPI_FALLBACK_TICK_MS: "250",
    NOAPI_PARTIAL_THROTTLE_MS: "100",
    NOAPI_EARLY_RETURN_HARD_CAP_MS: "900",
  });
  ok(
    "valid values are read into the patch",
    t.debounce === 220 &&
      t.sseEndReread === 60 &&
      t.earlyReturnReread === 0 &&
      t.extractThrottle === 80 &&
      t.fallbackTick === 250 &&
      t.partialThrottle === 100 &&
      t.earlyReturnHardCap === 900,
    JSON.stringify(t)
  );
}

// ---- invalid values are ignored, not coerced -------------------------------
ok("a non-numeric value is ignored", tuningFromEnv({ NOAPI_DEBOUNCE_MS: "fast" }).debounce === undefined);
ok("an empty string is ignored", tuningFromEnv({ NOAPI_DEBOUNCE_MS: "" }).debounce === undefined);
ok("NaN text is ignored", tuningFromEnv({ NOAPI_FALLBACK_TICK_MS: "NaN" }).fallbackTick === undefined);

// ---- clamping keeps the client safe on a typo ------------------------------
{
  const low = tuningFromEnv({ NOAPI_DEBOUNCE_MS: "1", NOAPI_EXTRACT_THROTTLE_MS: "1", NOAPI_FALLBACK_TICK_MS: "1" });
  ok("too-small debounce is clamped up", low.debounce === 30, String(low.debounce));
  ok("too-small extract throttle is clamped up", low.extractThrottle === 10, String(low.extractThrottle));
  ok("too-small fallback tick is clamped up", low.fallbackTick === 50, String(low.fallbackTick));
}
{
  const high = tuningFromEnv({
    NOAPI_DEBOUNCE_MS: "999999",
    NOAPI_SSE_END_REREAD_MS: "999999",
    NOAPI_EARLY_RETURN_HARD_CAP_MS: "999999",
  });
  ok("an absurd debounce is clamped down", high.debounce === 5000, String(high.debounce));
  ok("an absurd SSE re-read is clamped down", high.sseEndReread === 5000, String(high.sseEndReread));
  ok("an absurd early-return cap is clamped down", high.earlyReturnHardCap === 30000, String(high.earlyReturnHardCap));
}

// ---- an explicit 0 is a real value, not "unset" ----------------------------
ok("0 is accepted for a delay that may be disabled", tuningFromEnv({ NOAPI_SSE_END_REREAD_MS: "0" }).sseEndReread === 0);

// ---- the SSE-text fast path is opt-in --------------------------------------
ok("SSE text is off by default", sseTextFromEnv({}) === false);
ok("SSE text is off for any value but 1", sseTextFromEnv({ NOAPI_SSE_TEXT: "true" }) === false);
ok("SSE text turns on only with 1", sseTextFromEnv({ NOAPI_SSE_TEXT: "1" }) === true);

if (failed) {
  console.error(`\n${failed} tuning test(s) failed`);
  process.exit(1);
}
console.log("\nall tuning tests passed");
