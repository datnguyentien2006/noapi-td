// report-latency.js - per-stage latency report from the bridge's /health.
//
//   node tools/report-latency.js [url] [--json]
//
// Default url: http://127.0.0.1:8787
//
// It reads the per-request timings the bridge already records (GET /health) and
// prints, per site, the median and p90 of each stage:
//
//   composer   time to find the chat box
//   typed      time to type the prompt
//   sent       time to click send
//   firstText  time to the first reply text
//   lastToken  time to the model's last token
//   complete   time the turn was declared complete
//   postToken  client overhead after the last token (complete - lastToken)
//   total      full round trip
//
// plus the median prompt size (chars) and the truncation-canary counter
// (lateGrowth) that must stay 0 for the fast paths to be trustworthy.
//
// Plain Node, no dependencies. It never talks to a website; it only reads the
// bridge's own counters. The bridge keeps at most 50 recent requests per site.
import { median, p90 } from "./ab-report.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_URL = "http://127.0.0.1:8787";

const STAGES = ["composer", "typed", "sent", "firstText", "lastToken", "complete", "postToken", "total"];

function fmt(n) {
  if (n == null || !Number.isFinite(n)) return "-";
  return Math.round(n) + "ms";
}

function nums(records, field) {
  return records.map((r) => Number(r[field])).filter((n) => Number.isFinite(n));
}

// Per-site report object, also used by --json.
export function siteReport(site, records, stats) {
  const out = { site, count: records.length, stages: {}, promptChars: null, lateGrowth: null, lateGrowthChars: null };
  for (const k of STAGES) out.stages[k] = { median: median(nums(records, k)), p90: p90(nums(records, k)) };
  out.promptChars = median(nums(records, "promptChars"));
  if (stats) {
    out.lateGrowth = Number(stats.lateGrowth) || 0;
    out.lateGrowthChars = Number(stats.lateGrowthChars) || 0;
  }
  return out;
}

export function buildReport(health) {
  const bySite = (health && health.timings && health.timings.bySite) || {};
  const stats = (health && health.stats) || {};
  const sites = Object.keys(bySite).sort();
  return {
    name: health?.name || "noapi-bridge",
    clients: Array.isArray(health?.clients) ? health.clients.length : 0,
    sites: sites.map((s) => siteReport(s, Array.isArray(bySite[s].recent) ? bySite[s].recent : [], stats[s] || stats.any)),
  };
}

export function formatReport(report) {
  const lines = [];
  lines.push(`NOAPI? latency report - ${report.name} (${report.clients} browser client(s))`);
  if (!report.sites.length) {
    lines.push("");
    lines.push("No completed requests recorded yet. Run some turns, then re-run this tool.");
    return lines.join("\n");
  }
  for (const s of report.sites) {
    lines.push("");
    lines.push(`site: ${s.site}   (n=${s.count}${s.promptChars != null ? `, median prompt ${Math.round(s.promptChars)} chars` : ""})`);
    lines.push(`  ${"metric".padEnd(12)} ${"median".padStart(10)} ${"p90".padStart(10)}`);
    for (const k of STAGES) {
      lines.push(`  ${k.padEnd(12)} ${fmt(s.stages[k].median).padStart(10)} ${fmt(s.stages[k].p90).padStart(10)}`);
    }
    if (s.lateGrowth != null) {
      const flag = s.lateGrowth ? "  <-- TRUNCATION?" : "";
      lines.push(`  ${"lateGrowth".padEnd(12)} ${String(s.lateGrowth).padStart(10)}${s.lateGrowth ? ` (${s.lateGrowthChars} chars)` : ""}${flag}`);
    }
  }
  lines.push("");
  lines.push("lateGrowth must stay 0: any other value means a completion fast path");
  lines.push("returned a reply that the page kept painting afterwards (truncation).");
  return lines.join("\n");
}

function parseArgs(argv) {
  const opts = { url: DEFAULT_URL, json: false };
  for (const a of argv) {
    if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (!a.startsWith("-")) opts.url = a;
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("usage: node tools/report-latency.js [url] [--json]");
    return;
  }
  const url = opts.url.replace(/\/$/, "");
  let health;
  try {
    const res = await fetch(`${url}/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    health = await res.json();
  } catch (err) {
    console.error(`could not read ${url}/health: ${err.message}`);
    console.error("is the bridge running? (npm start)");
    process.exit(1);
    return;
  }
  const report = buildReport(health);
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatReport(report));
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error("report-latency:", err.message);
    process.exit(1);
  });
}
