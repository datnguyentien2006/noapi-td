// "Consult mode" — send local file contents plus a question to a logged-in AI
// chat website and bring the answer back.
//
// This module is deliberately free of network/browser code so all of it can be
// unit tested on its own. It owns four things:
//   1. path rules        (allowed roots, symlink/`..` escape, secrets, sizes)
//   2. prompt building   (delimiters, optional line numbers, mode instructions)
//   3. EDIT block parsing (the patch protocol the website is asked to use)
//   4. EDIT block validation (does each SEARCH text occur exactly once on disk)
//
// It never writes to disk. Applying edits is the caller's (OpenCode's) job.
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

// A thrown ConsultError is a user-facing "this input is not allowed" error; the
// MCP layer returns its message verbatim.
export class ConsultError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConsultError";
  }
}

function envInt(name, fallback, env = process.env) {
  const v = Number(env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

// Max characters of a single file's *included* content (after any line range).
export function maxFileChars(env = process.env) {
  return envInt("NOAPI_CONSULT_MAX_FILE", 60_000, env);
}

// Max characters across all included files.
export function maxTotalChars(env = process.env) {
  return envInt("NOAPI_CONSULT_MAX_TOTAL", 80_000, env);
}

// ---------------------------------------------------------------- path rules

function pathKey(p) {
  const abs = path.resolve(p);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

export function samePath(a, b) {
  return pathKey(a) === pathKey(b);
}

// Is `target` inside `root` (or equal to it)? Case-insensitive on win32 so
// "C:\Dir" and "c:\dir" match, and a different drive never counts as inside.
export function insideRoot(root, target) {
  const r = pathKey(root);
  const t = pathKey(target);
  if (t === r) return true;
  const rel = path.relative(r, t);
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function realpathOr(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

// Resolve symlinks as far as the path exists, without requiring the leaf to
// exist (so a missing file still gets a deterministic containment check).
function resolveReal(p) {
  const abs = path.resolve(p);
  const direct = realpathOr(abs);
  if (direct) return direct;
  const dir = path.dirname(abs);
  const realDir = realpathOr(dir);
  return realDir ? path.join(realDir, path.basename(abs)) : abs;
}

// cwd is always allowed; NOAPI_CONSULT_ROOTS adds more, separated by
// path.delimiter (";" on Windows, ":" elsewhere).
export function allowedRoots({ cwd = process.cwd(), env = process.env } = {}) {
  const raw = [path.resolve(cwd), ...String(env.NOAPI_CONSULT_ROOTS || "").split(path.delimiter)];
  const out = [];
  for (const entry of raw) {
    const t = String(entry).trim();
    if (!t) continue;
    const real = resolveReal(path.resolve(cwd, t));
    if (!out.some((r) => samePath(r, real))) out.push(real);
  }
  return out;
}

// The "never send this" list. Returns a human reason, or null when the file is
// fine. Applied to the path relative to the allowed root. Matching is case
// insensitive: on Windows/macOS the filesystem is, so ".GIT/config" and
// "NODE_MODULES/x" reach the same real files as their lowercase spellings.
export function secretRule(rel) {
  const segs = String(rel)
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase());
  if (segs.includes(".git")) return "files inside a .git directory are never sent";
  if (segs.includes("node_modules")) return "files inside node_modules are never sent";
  const base = segs[segs.length - 1] || "";
  if (/^\.env/i.test(base)) return "environment files (.env*) are never sent";
  if (/\.(pem|p12|pfx)$/i.test(base)) return "*.pem/*.p12/*.pfx files are never sent";
  if (/\.key$/i.test(base)) return "*.key files are never sent";
  if (/^id_(rsa|dsa|ecdsa|ed25519)/i.test(base)) return "id_rsa*/id_ed25519* private keys are never sent";
  return null;
}

// "path", "path:10-40" (1-based, inclusive).
export function parseFileArg(arg) {
  const s = String(arg ?? "");
  const m = s.match(/^(.*?):(\d+)-(\d+)$/);
  if (m && m[1]) {
    return { path: m[1], start: Number(m[2]), end: Number(m[3]) };
  }
  return { path: s, start: null, end: null };
}

// A file whose byte size is at most this is read in one go: its character count
// can never exceed the per-file limit (a UTF-8 character is at most 4 bytes).
// Anything larger is streamed so a line range does not pull the whole file in.
function fullReadCap(env) {
  return Math.max(maxFileChars(env) * 4, 64 * 1024);
}

// Normalised lines: CRLF/CR -> LF, and a trailing newline does not create a
// phantom empty final line.
function splitLines(content) {
  const lines = String(content).replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function clampRange(start, end, total, rel) {
  let s = start ?? 1;
  let e = end ?? total;
  if (s < 1) s = 1;
  if (e > total) e = total;
  if (s > total || e < s) {
    throw new ConsultError(`Line range ${start}-${end} is outside "${rel}" (${total} lines).`);
  }
  return { s, e };
}

// Stream a large file and keep only lines [start, end]. It stops as soon as
// `end` lines are seen, so a small range on a huge file reads only its head.
// `total` is known only when EOF is reached before `end`.
function readRangeBounded(real, { start, end, maxChars, rel }) {
  const fd = fs.openSync(real, "r");
  try {
    const CHUNK = 64 * 1024;
    const buf = Buffer.allocUnsafe(CHUNK);
    const decoder = new StringDecoder("utf8");
    const selected = [];
    let pending = "";
    let lineNo = 0;
    let chars = 0;
    let eof = false;
    const keep = (line) => {
      lineNo += 1;
      if (lineNo < start || lineNo > end) return;
      chars += line.length + (selected.length ? 1 : 0);
      if (chars > maxChars) {
        throw new ConsultError(
          `"${rel}" is over the per-file limit of ${maxChars} characters. ` +
            `Use a narrower line range "<path>:START-END" or raise NOAPI_CONSULT_MAX_FILE.`
        );
      }
      selected.push(line);
    };
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, null);
      if (n <= 0) {
        eof = true;
        break;
      }
      const text = pending + decoder.write(buf.subarray(0, n));
      let from = 0;
      let idx;
      while ((idx = text.indexOf("\n", from)) !== -1) {
        keep(text.slice(from, idx).replace(/\r$/, ""));
        from = idx + 1;
        if (lineNo >= end) break;
      }
      if (lineNo >= end) break;
      pending = text.slice(from);
    }
    let total = null;
    if (eof) {
      pending += decoder.end();
      if (pending.length > 0 || lineNo === 0) keep(pending.replace(/\r$/, ""));
      total = lineNo;
    }
    return { selected, total };
  } finally {
    fs.closeSync(fd);
  }
}

// Resolve one file argument to an absolute path inside an allowed root, enforce
// the secret rules, read it, apply any line range and return the slice.
export function resolveFile({ arg, roots, cwd = process.cwd(), env = process.env }) {
  const { path: raw, start, end } = parseFileArg(arg);
  if (!String(raw).trim()) throw new ConsultError("Empty file path.");
  const real = resolveReal(path.resolve(cwd, raw));
  const root = roots.find((r) => insideRoot(r, real));
  if (!root) {
    throw new ConsultError(
      `Path "${raw}" is outside the allowed roots. Allowed roots: ${roots.join(", ")}`
    );
  }
  const rel = (path.relative(root, real) || path.basename(real)).split(path.sep).join("/");
  const reason = secretRule(rel);
  if (reason) throw new ConsultError(`Refusing to read "${rel}": ${reason}.`);
  if (start != null && end != null && end < start) {
    throw new ConsultError(`Line range ${start}-${end} is invalid (end is before start).`);
  }

  let stat;
  try {
    stat = fs.statSync(real);
  } catch (err) {
    throw new ConsultError(`Cannot read "${rel}": ${err.message}`);
  }
  if (!stat.isFile()) throw new ConsultError(`"${rel}" is not a regular file.`);

  const maxChars = maxFileChars(env);
  const ranged = start != null;

  // Small files (and any file within the read cap) are read in one go, so the
  // exact line count is known and reported as "of N".
  if (!ranged || stat.size <= fullReadCap(env)) {
    if (!ranged && stat.size > fullReadCap(env)) {
      throw new ConsultError(
        `"${rel}" is at least ${stat.size} bytes, over the per-file read limit. ` +
          `Use a line range "<path>:START-END" or raise NOAPI_CONSULT_MAX_FILE.`
      );
    }
    let content;
    try {
      content = fs.readFileSync(real, "utf8");
    } catch (err) {
      throw new ConsultError(`Cannot read "${rel}": ${err.message}`);
    }
    const lines = splitLines(content);
    const total = lines.length;
    const { s, e } = clampRange(start, end, total, rel);
    const selected = lines.slice(s - 1, e);
    return { rel, abs: real, start: s, end: e, total, selected, chars: selected.join("\n").length };
  }

  // Large file with an explicit range: read only its head.
  const { selected, total } = readRangeBounded(real, { start, end, maxChars, rel });
  const chars = selected.join("\n").length;
  if (chars > maxChars) {
    throw new ConsultError(
      `"${rel}" is ${chars} characters, over the per-file limit of ${maxChars}. ` +
        `Use a narrower line range "<path>:START-END" or raise NOAPI_CONSULT_MAX_FILE.`
    );
  }
  return { rel, abs: real, start, end, total, selected, chars };
}

// ------------------------------------------------------------- prompt building

const MODE_INSTRUCTIONS = {
  patch:
    "Reply with ONLY edit blocks, one per change, in this exact format: " +
    "===== EDIT: <path> =====  <<<<<<< SEARCH  <exact existing lines>  =======  " +
    "<replacement lines>  >>>>>>> REPLACE  ===== END EDIT =====. " +
    "SEARCH text must be copied exactly from the file above and be unique in the " +
    "file. No commentary outside blocks except a 1-3 line summary at the end.",
  explain:
    'Explain the code above and answer my request. Refer to specific lines by ' +
    'their line numbers (for example, "file.js:42"). Do not output edit blocks.',
  review:
    'Review the files above and answer my request. Point out concrete issues ' +
    'with file and line references (for example, "file.js:42"). Do not output edit blocks.',
};

export function modeInstructions(mode) {
  return MODE_INSTRUCTIONS[mode] || MODE_INSTRUCTIONS.patch;
}

export function normalizeMode(mode) {
  const m = String(mode || "patch").toLowerCase();
  return MODE_INSTRUCTIONS[m] ? m : "patch";
}

function fileBlock(f, mode) {
  const body =
    mode === "patch"
      ? f.selected.join("\n")
      : f.selected.map((line, i) => `${f.start + i}: ${line}`).join("\n");
  const span = f.total == null ? `lines ${f.start}-${f.end}` : `lines ${f.start}-${f.end} of ${f.total}`;
  return `===== FILE: ${f.rel} (${span}) =====\n${body}\n===== END FILE =====`;
}

// The prompt reads like a normal user request. It must not mention OpenCode,
// NOAPI, tools, TOOL_CALL, agents or the bridge, and must not use role-play.
export function buildPromptText({ question, mode = "patch", files }) {
  const m = normalizeMode(mode);
  return [
    "Here are files from my project.",
    files.map((f) => fileBlock(f, m)).join("\n\n"),
    `My request: ${String(question ?? "").trim()}`,
    modeInstructions(m),
  ].join("\n\n");
}

// End-to-end builder used by the MCP tool: resolve + read + size-check + build.
export function buildConsultPrompt({ question, files, mode = "patch", cwd = process.cwd(), env = process.env }) {
  const roots = allowedRoots({ cwd, env });
  const list = Array.isArray(files) ? files : [];
  if (!list.length) throw new ConsultError("At least one file is required.");
  const resolved = list.map((arg) => resolveFile({ arg, roots, cwd, env }));

  const maxFile = maxFileChars(env);
  for (const f of resolved) {
    if (f.chars > maxFile) {
      throw new ConsultError(
        `"${f.rel}" is ${f.chars} characters, over the per-file limit of ${maxFile}. ` +
          `Use a line range "<path>:START-END" or raise NOAPI_CONSULT_MAX_FILE.`
      );
    }
  }
  const total = resolved.reduce((n, f) => n + f.chars, 0);
  const maxTotal = maxTotalChars(env);
  if (total > maxTotal) {
    const sizes = resolved.map((f) => `${f.rel}=${f.chars}`).join(", ");
    throw new ConsultError(
      `The files total ${total} characters, over the limit of ${maxTotal}. Sizes: ${sizes}. ` +
        `Use line ranges "<path>:START-END" or raise NOAPI_CONSULT_MAX_TOTAL.`
    );
  }
  return { prompt: buildPromptText({ question, mode, files: resolved }), files: resolved, roots, mode: normalizeMode(mode) };
}

// --------------------------------------------------------------- EDIT parsing

const EDIT_START = /^\s*={5,}\s*EDIT:\s*(.+?)\s*={5,}\s*$/;
const EDIT_END = /^\s*={5,}\s*END EDIT\s*={5,}\s*$/;
const SEARCH_OPEN = /^\s*<{5,}\s*SEARCH\s*$/i;
const SEPARATOR = /^\s*={5,}\s*$/;
const REPLACE_CLOSE = /^\s*>{5,}\s*REPLACE\s*$/i;

// Tolerant of surrounding prose, fences and 5+ `=`/`>` runs: it only looks for
// the markers. A malformed block is dropped instead of swallowing the marker
// that follows it, so a later well-formed block is still parsed.
export function parseEditBlocks(reply) {
  const lines = String(reply ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(EDIT_START);
    if (!m) {
      i += 1;
      continue;
    }
    const filePath = m[1].trim();
    let j = i + 1;
    let search = null;
    let replace = null;
    let closed = false;
    while (j < lines.length && !EDIT_END.test(lines[j])) {
      if (SEARCH_OPEN.test(lines[j])) {
        search = [];
        j += 1;
        while (
          j < lines.length &&
          !SEPARATOR.test(lines[j]) &&
          !EDIT_END.test(lines[j]) &&
          !EDIT_START.test(lines[j])
        ) {
          search.push(lines[j]);
          j += 1;
        }
        if (j < lines.length && SEPARATOR.test(lines[j])) {
          replace = [];
          j += 1;
          while (
            j < lines.length &&
            !REPLACE_CLOSE.test(lines[j]) &&
            !EDIT_END.test(lines[j]) &&
            !EDIT_START.test(lines[j])
          ) {
            replace.push(lines[j]);
            j += 1;
          }
          if (j < lines.length && REPLACE_CLOSE.test(lines[j])) {
            closed = true;
            j += 1;
          }
        }
        break;
      }
      j += 1;
    }
    if (search && replace && closed) {
      blocks.push({ path: filePath, search: search.join("\n"), replace: replace.join("\n") });
    }
    // Resume at the marker we stopped on so a following good block still parses.
    i = closed ? j : Math.max(j, i + 1);
  }
  return blocks;
}

// ------------------------------------------------------------ EDIT validation

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  for (;;) {
    const at = haystack.indexOf(needle, idx);
    if (at === -1) break;
    count += 1;
    idx = at + needle.length;
  }
  return count;
}

// Resolve a path named by the website against cwd and every allowed root,
// preferring the first root where it actually exists.
function resolveValidationTarget(raw, { roots, cwd }) {
  const relOf = (root, real) => (path.relative(root, real) || path.basename(real)).split(path.sep).join("/");
  if (path.isAbsolute(raw)) {
    const real = resolveReal(raw);
    const root = roots.find((r) => insideRoot(r, real));
    if (!root) throw new ConsultError(`Path "${raw}" is outside the allowed roots. Allowed roots: ${roots.join(", ")}`);
    return { abs: real, rel: relOf(root, real) };
  }
  for (const root of roots) {
    const real = resolveReal(path.resolve(root, raw));
    if (insideRoot(root, real) && realpathOr(real)) {
      return { abs: real, rel: relOf(root, real) };
    }
  }
  const real = resolveReal(path.resolve(cwd, raw));
  const root = roots.find((r) => insideRoot(r, real));
  if (!root) throw new ConsultError(`Path "${raw}" is outside the allowed roots. Allowed roots: ${roots.join(", ")}`);
  return { abs: real, rel: relOf(root, real) };
}

// Check each block's SEARCH text against the file on disk. Never writes.
// `readFile` is injectable so this stays unit-testable without touching disk.
export function validateEditBlocks(
  blocks,
  { roots = allowedRoots(), cwd = process.cwd(), readFile = (p) => fs.readFileSync(p, "utf8") } = {}
) {
  return (blocks || []).map((b, idx) => {
    const entry = { index: idx + 1, path: b.path, status: "ok", occurrences: 0 };
    let target;
    try {
      target = resolveValidationTarget(b.path, { roots, cwd });
    } catch (err) {
      return { ...entry, status: "rejected", detail: err.message };
    }
    const reason = secretRule(target.rel);
    if (reason) return { ...entry, status: "rejected", detail: `refusing to read "${target.rel}": ${reason}.` };

    let content;
    try {
      content = String(readFile(target.abs));
    } catch (err) {
      return { ...entry, status: "missing-file", detail: err.message };
    }
    content = content.replace(/\r\n?/g, "\n");
    const search = String(b.search ?? "").replace(/\r\n?/g, "\n");
    if (!search) return { ...entry, status: "empty-search", occurrences: 0 };
    const occurrences = countOccurrences(content, search);
    if (occurrences === 0) return { ...entry, status: "not-found", occurrences: 0 };
    if (occurrences > 1) return { ...entry, status: "multiple", occurrences };
    return { ...entry, status: "ok", occurrences: 1 };
  });
}

export function validationReport(results) {
  if (!results || !results.length) return "";
  const lines = ["--- consult validation ---"];
  for (const r of results) {
    let s;
    switch (r.status) {
      case "ok":
        s = "ok (SEARCH occurs exactly once, safe to apply)";
        break;
      case "not-found":
        s = "SEARCH not found in the file (re-read the file and retry)";
        break;
      case "multiple":
        s = `SEARCH found ${r.occurrences} times (must be unique; add surrounding context)`;
        break;
      case "missing-file":
        s = `file not found or unreadable: ${r.detail || ""}`;
        break;
      case "empty-search":
        s = "SEARCH block is empty";
        break;
      case "rejected":
        s = `refused: ${r.detail || ""}`;
        break;
      default:
        s = r.status;
    }
    lines.push(`block ${r.index} (${r.path}): ${s}`);
  }
  return lines.join("\n");
}

// --------------------------------------------------------------- autoread flag

// Absolute paths mentioned in free text. Windows drive paths and POSIX paths;
// trailing punctuation is trimmed so "see C:\x\y.js," yields the file.
export function findAbsolutePaths(text) {
  const out = new Set();
  const re = /(?:[A-Za-z]:[\\/][^\s"'`<>|]*)|\/(?:[^\s"'`<>|/]+\/)*[^\s"'`<>|/]+/g;
  let m;
  while ((m = re.exec(String(text || "")))) {
    let p = m[0].replace(/[.,;:!?)\]}]+$/, "");
    if (p.length > 1) out.add(p);
  }
  return [...out];
}

function messageText(m) {
  const c = m?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : p?.text || "")).join("");
  return "";
}

// NOAPI_AUTOREAD=1 (off by default): the bridge appends the contents of any
// absolute file path the *user* mentioned (tool results excluded) so a model
// that cannot call read tools still sees the file. Best-effort and silent.
export function autoreadBlock(messages, { cwd = process.cwd(), env = process.env, roots = allowedRoots({ cwd, env }) } = {}) {
  const text = (messages || [])
    .filter((m) => m.role === "user")
    .map(messageText)
    .join("\n");
  if (!text) return "";
  const maxFile = maxFileChars(env);
  const maxTotal = maxTotalChars(env);
  const blocks = [];
  let total = 0;
  for (const candidate of findAbsolutePaths(text)) {
    try {
      const f = resolveFile({ arg: candidate, roots, cwd, env });
      // Same size rules as `consult`: skip an over-budget file rather than
      // quietly building a huge prompt.
      if (f.chars > maxFile) continue;
      if (total + f.chars > maxTotal) break;
      total += f.chars;
      blocks.push(fileBlock(f, "explain"));
    } catch {
      // not inside a root, a secret, or unreadable: simply skip it
    }
  }
  return blocks.join("\n\n");
}
