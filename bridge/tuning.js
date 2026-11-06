// Per-request timing knobs for the content script.
//
// A content script cannot read process.env, so the bridge reads these variables
// here and forwards the values with every request (see state.js `tuning` and
// extension/*/background.js). Every value is optional: an unset or invalid
// variable leaves the content script's shipped default in place. This is what
// lets a latency A/B run change a timing constant without editing source.
//
//   NOAPI_DEBOUNCE_MS              per-site completion debounce (350-550 default)
//   NOAPI_SSE_END_REREAD_MS        re-read after the page's SSE stream closes (120)
//   NOAPI_EARLY_RETURN_REREAD_MS   re-read after the early-return stop click (120)
//   NOAPI_EXTRACT_THROTTLE_MS      minimum gap between DOM reads (120)
//   NOAPI_FALLBACK_TICK_MS         safety-net poll interval (400)
//   NOAPI_PARTIAL_THROTTLE_MS      minimum gap between streamed partials (150)
//   NOAPI_EARLY_RETURN_HARD_CAP_MS cap on waiting for a second tool block (1500)
const KNOBS = [
  ["debounce", "NOAPI_DEBOUNCE_MS", { min: 30, max: 5000 }],
  ["sseEndReread", "NOAPI_SSE_END_REREAD_MS", { min: 0, max: 5000 }],
  ["earlyReturnReread", "NOAPI_EARLY_RETURN_REREAD_MS", { min: 0, max: 5000 }],
  ["extractThrottle", "NOAPI_EXTRACT_THROTTLE_MS", { min: 10, max: 5000 }],
  ["fallbackTick", "NOAPI_FALLBACK_TICK_MS", { min: 50, max: 10_000 }],
  ["partialThrottle", "NOAPI_PARTIAL_THROTTLE_MS", { min: 20, max: 5000 }],
  ["earlyReturnHardCap", "NOAPI_EARLY_RETURN_HARD_CAP_MS", { min: 50, max: 30_000 }],
];

// Read the bridge environment into a small, validated patch. Clamped so a typo
// cannot wedge the content script (a 0ms debounce would complete on a half
// painted reply; a giant tick would stall the timeout checks).
export function tuningFromEnv(env = process.env) {
  const out = {};
  for (const [key, name, { min, max }] of KNOBS) {
    const raw = env[name];
    if (raw === undefined || raw === "") continue;
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
    out[key] = Math.min(Math.max(v, min), max);
  }
  return out;
}

// Optional SSE-text fast path (task 5). Off unless explicitly enabled.
export function sseTextFromEnv(env = process.env) {
  return env.NOAPI_SSE_TEXT === "1";
}
