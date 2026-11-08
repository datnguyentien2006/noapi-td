// Chat-rotation policy (pure functions; http.js applies them).
//
// Observed failure: with 50-70k chars of tool results per turn and a 150k-char
// limit, the chat was rotated every 2-3 turns. A rotation prompt carries the
// protocol, the recap and the pending tool results, so the NEW chat started
// almost half full and rotated again right away.
//
//   1. a per-site default limit (NOAPI_ROTATE_CHARS / NOAPI_ROTATE_CHARS_<SITE> win)
//   2. the limit is raised when the rotation prompt itself is a large share of it
//   3. never rotate twice within NOAPI_ROTATE_MIN_TURNS turns of the same chat
//   4. the pending tool results in a rotation prompt are compacted (recap has the history)

// Chars. Only sites where a bigger chat is known to be fine belong here.
export const SITE_ROTATE_DEFAULT = { zai: 300_000 };

const num = (v) => (v === undefined || v === "" ? NaN : Number(v));

// baseLimit: what recap.js rotateLimit() returned (honours NOAPI_ROTATE_CHARS, 0 = off).
export function siteRotateLimit(site, baseLimit, env = process.env) {
  const perSite = num(env[`NOAPI_ROTATE_CHARS_${String(site).toUpperCase()}`]);
  if (Number.isFinite(perSite) && perSite >= 0) return perSite;
  if (env.NOAPI_ROTATE_CHARS !== undefined && env.NOAPI_ROTATE_CHARS !== "") return baseLimit;
  return SITE_ROTATE_DEFAULT[site] ?? baseLimit;
}

export function effectiveRotateLimit(site, baseLimit, lastRotatePromptChars = 0, env = process.env) {
  const limit = siteRotateLimit(site, baseLimit, env);
  if (!limit) return 0; // 0 = rotation off
  if (lastRotatePromptChars * 2 > limit) return Math.max(limit, lastRotatePromptChars * 3);
  return limit;
}

export function rotateMinTurns(env = process.env) {
  const n = num(env.NOAPI_ROTATE_MIN_TURNS);
  return Number.isFinite(n) ? Math.max(0, n) : 3;
}

// Total chars of tool results allowed in a rotation prompt (0 = no compaction).
export function rotateResultBudget(env = process.env) {
  const n = num(env.NOAPI_ROTATE_RESULT_BUDGET);
  return Number.isFinite(n) ? Math.max(0, n) : 24_000;
}
