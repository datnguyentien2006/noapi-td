// ab-report.js - capture and compare real-site A/B runs from the bridge /health.
//
// Plain Node, no dependencies. It never talks to a website itself: it reads the
// per-request timings the bridge already records (GET /health) and writes them
// to a local JSON file. Run one capture per configuration (all fast paths on,
// then the flags off), then compare the two labels.
//
//   node tools/ab-report.js capture <label> [--url http://127.0.0.1:8787] [--dir ab-results]
//   node tools/ab-report.js compare <label-a> <label-b> [--dir ab-results]
//
// IMPORTANT: the numbers come from a real run, but they are still a small sample.
// The bridge keeps at most 50 recent requests per site; a comparison of fewer
// than 5 requests per label is reported as "too few samples to compare".
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_URL = "http://127.0.0.1:8787";
const DEFAULT_DIR = "ab-results";
const MIN_SAMPLES = 5;

// ---- stats -----------------------------------------------------------------
export function median(xs) {
  const a = xs.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// Nearest-rank p90 (the 90th percentile request is at or below this value).
export function p90(xs) {
  const a = xs.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const idx = Math.min(a.length - 1, Math.ceil(0.9 * a.length) - 1);
  return a[idx];
}

// ---- reading /health -------------------------------------------------------
// Flatten health.timings.bySite[site].recent into one record list. Each record
// keeps only the fields the report uses, so the file stays small and stable.
export function recordsFromHealth(health) {
  const bySite = (health && health.timings && health.timings.bySite) || {};
  const out = [];
  for (const [site, info] of Object.entries(bySite)) {
    const recent = Array.isArray(info && info.recent) ? info.recent : [];
    for (const r of recent) {
      out.push({
        id: r.id != null ? String(r.id) : null,
        site: r.site || site || "any",
        at: Number(r.at) || null,
        firstText: Number.isFinite(Number(r.firstText)) ? Number(r.firstText) : null,
        complete: Number.isFinite(Number(r.complete)) ? Number(r.complete) : null,
        total: Number.isFinite(Number(r.total)) ? Number(r.total) : null,
        stopSeen: Boolean(r.stopSeen),
        sseSeen: Boolean(r.sseSeen),
        earlyReturn: Boolean(r.earlyReturn),
        newChat: Boolean(r.newChat),
        completedBy: r.completedBy || null,
      });
    }
  }
  return out;
}

// Stable identity for dedupe across repeated captures.
function recordKey(r) {
  if (r.id) return r.id;
  return `${r.site}|${r.at}|${r.total}|${r.completedBy}`;
}

// ---- capture ---------------------------------------------------------------
export function labelFile(dir, label) {
  return path.join(dir, `${String(label).replace(/[^\w.-]+/g, "_")}.json`);
}

// Merge new records into an existing label file, returning how many were added.
// Repeated captures (one per turn, say) accumulate instead of duplicating.
export function captureRecords(dir, label, records, { now = Date.now() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = labelFile(dir, label);
  let doc = { label, createdAt: now, updatedAt: now, records: [] };
  if (fs.existsSync(file)) {
    try {
      const prev = JSON.parse(fs.readFileSync(file, "utf8"));
      if (prev && Array.isArray(prev.records)) doc = { ...doc, ...prev, records: prev.records };
    } catch {}
  }
  const seen = new Set(doc.records.map(recordKey));
  let added = 0;
  for (const r of records) {
    const k = recordKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    doc.records.push(r);
    added++;
  }
  doc.updatedAt = now;
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  return { file, added, total: doc.records.length };
}

export function loadLabel(dir, label) {
  const file = labelFile(dir, label);
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  return { label, file, records: Array.isArray(doc.records) ? doc.records : [] };
}

// ---- compare ---------------------------------------------------------------
function share(values) {
  const counts = new Map();
  for (const v of values) {
    const k = v || "unknown";
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const total = values.length || 1;
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([value, count]) => ({ value, count, share: count / total }));
}

function siteStats(records, site) {
  const rs = records.filter((r) => (r.site || "any") === site);
  const nums = (field) => rs.map((r) => Number(r[field])).filter((n) => Number.isFinite(n) && n > 0);
  return {
    site,
    count: rs.length,
    fewSamples: rs.length < MIN_SAMPLES,
    firstText: { median: median(nums("firstText")), p90: p90(nums("firstText")) },
    complete: { median: median(nums("complete")), p90: p90(nums("complete")) },
    total: { median: median(nums("total")), p90: p90(nums("total")) },
    completedBy: share(rs.map((r) => r.completedBy)),
    sseSeen: share(rs.map((r) => (r.sseSeen ? "yes" : "no"))),
  };
}

// Structured comparison of two labelled runs: one entry per site seen in either.
export function compareRecords(a, b) {
  const sites = [...new Set([...a.records, ...b.records].map((r) => r.site || "any"))].sort();
  return {
    a: { label: a.label, count: a.records.length, fewSamples: a.records.length < MIN_SAMPLES },
    b: { label: b.label, count: b.records.length, fewSamples: b.records.length < MIN_SAMPLES },
    sites: sites.map((s) => ({ site: s, a: siteStats(a.records, s), b: siteStats(b.records, s) })),
  };
}

function fmt(n) {
  return n == null ? "-" : Math.round(n) + "ms";
}
function shares(list) {
  if (!list.length) return "-";
  return list.map((x) => `${x.value} ${Math.round(x.share * 100)}%`).join(", ");
}

export function formatReport(cmp) {
  const lines = [];
  lines.push(`A/B comparison of real-site runs`);
  lines.push(`  A = ${cmp.a.label}  (${cmp.a.count} request(s))`);
  lines.push(`  B = ${cmp.b.label}  (${cmp.b.count} request(s))`);
  for (const side of [cmp.a, cmp.b]) {
    if (side.fewSamples) lines.push(`  ! "${side.label}" has fewer than ${MIN_SAMPLES} requests - too few samples to compare.`);
  }
  for (const s of cmp.sites) {
    lines.push("");
    lines.push(`site: ${s.site}`);
    if (s.a.fewSamples || s.b.fewSamples) {
      lines.push(`  ! fewer than ${MIN_SAMPLES} requests on ${s.a.fewSamples ? "A" : "B"} for this site - treat with care.`);
    }
    const row = (name, av, bv) => lines.push(`  ${name.padEnd(12)} A ${String(av).padEnd(12)} B ${bv}`);
    lines.push(`  ${"metric".padEnd(12)} ${"A (median/p90)".padEnd(24)} B (median/p90)`);
    row("count", `${s.a.count}`, `${s.b.count}`);
    row("firstText", `${fmt(s.a.firstText.median)}/${fmt(s.a.firstText.p90)}`, `${fmt(s.b.firstText.median)}/${fmt(s.b.firstText.p90)}`);
    row("complete", `${fmt(s.a.complete.median)}/${fmt(s.a.complete.p90)}`, `${fmt(s.b.complete.median)}/${fmt(s.b.complete.p90)}`);
    row("total", `${fmt(s.a.total.median)}/${fmt(s.a.total.p90)}`, `${fmt(s.b.total.median)}/${fmt(s.b.total.p90)}`);
    row("completedBy", shares(s.a.completedBy), shares(s.b.completedBy));
    row("sseSeen", shares(s.a.sseSeen), shares(s.b.sseSeen));
  }
  lines.push("");
  lines.push("Note: the bridge keeps at most 50 recent requests per site, and a");
  lines.push("single run is a small sample. Do not read a difference as real below");
  lines.push(`the ${MIN_SAMPLES}-request floor, or when one completedBy share is all "fallback-2200".`);
  return lines.join("\n");
}

// ---- CLI -------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { url: DEFAULT_URL, dir: DEFAULT_DIR, _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") opts.url = argv[++i];
    else if (a.startsWith("--url=")) opts.url = a.slice(6);
    else if (a === "--dir") opts.dir = argv[++i];
    else if (a.startsWith("--dir=")) opts.dir = a.slice(6);
    else opts._.push(a);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cmd = opts._[0];
  if (cmd === "capture") {
    const label = opts._[1];
    if (!label) throw new Error("usage: ab-report.js capture <label> [--url URL] [--dir DIR]");
    const res = await fetch(`${opts.url.replace(/\/$/, "")}/health`);
    if (!res.ok) throw new Error(`GET ${opts.url}/health -> HTTP ${res.status}`);
    const health = await res.json();
    const records = recordsFromHealth(health);
    const r = captureRecords(opts.dir, label, records);
    console.log(`captured ${records.length} record(s); ${r.added} new -> ${r.file} (${r.total} total for "${label}")`);
    if (r.added === 0) console.log("hint: run the bridge through some turns first, or the label already has these requests.");
    return;
  }
  if (cmd === "compare") {
    const labelA = opts._[1];
    const labelB = opts._[2];
    if (!labelA || !labelB) throw new Error("usage: ab-report.js compare <label-a> <label-b> [--dir DIR]");
    const cmp = compareRecords(loadLabel(opts.dir, labelA), loadLabel(opts.dir, labelB));
    console.log(formatReport(cmp));
    return;
  }
  console.log("usage:");
  console.log("  node tools/ab-report.js capture <label> [--url URL] [--dir DIR]");
  console.log("  node tools/ab-report.js compare <label-a> <label-b> [--dir DIR]");
}

// Only run the CLI when invoked directly (not when imported by the test).
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((e) => {
    console.error("ab-report:", e.message);
    process.exit(1);
  });
}
