// Unit tests for tools/ab-report.js using fixture /health JSON. No network.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  median,
  p90,
  recordsFromHealth,
  captureRecords,
  loadLabel,
  compareRecords,
  formatReport,
} from "./ab-report.js";

let failed = 0;
function ok(name, cond, extra = "") {
  if (cond) console.log("ok:", name);
  else {
    console.error("FAIL:", name, extra);
    failed++;
  }
}

// ---- stats -----------------------------------------------------------------
ok("median of an even list", median([1, 2, 3, 4]) === 2.5, String(median([1, 2, 3, 4])));
ok("median of an odd list", median([1, 2, 3]) === 2, String(median([1, 2, 3])));
ok("median ignores non-numbers", median([10, "x", 20]) === 15, String(median([10, "x", 20])));
ok("median of nothing is null", median([]) === null);
ok("p90 nearest rank", p90([...Array(10)].map((_, i) => i + 1)) === 9, String(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])));
ok("p90 of a single value", p90([42]) === 42);

// ---- fixture /health -------------------------------------------------------
const rec = (o) => ({
  stopSeen: false,
  sseSeen: false,
  earlyReturn: false,
  completedBy: "fallback-2200",
  ...o,
});
const HEALTH = {
  timings: {
    bySite: {
      chatgpt: {
        recent: [
          rec({ id: "c1", site: "chatgpt", firstText: 100, complete: 200, total: 300, sseSeen: true, completedBy: "sse" }),
          rec({ id: "c2", site: "chatgpt", firstText: 120, complete: 220, total: 320, stopSeen: true, completedBy: "stop-button" }),
          rec({ id: "c3", site: "chatgpt", firstText: 140, complete: 240, total: 340, stopSeen: true, completedBy: "stop-button" }),
          rec({ id: "c4", site: "chatgpt", firstText: 160, complete: 260, total: 360, earlyReturn: true, completedBy: "early-return" }),
          rec({ id: "c5", site: "chatgpt", firstText: 180, complete: 280, total: 380, sseSeen: true, completedBy: "sse" }),
          rec({ id: "c6", site: "chatgpt", firstText: 200, complete: 300, total: 400, completedBy: "fallback-2200" }),
        ],
      },
      claude: {
        recent: [
          rec({ id: "l1", site: "claude", firstText: 90, complete: 190, total: 290, stopSeen: true, completedBy: "stop-button" }),
          rec({ id: "l2", site: "claude", firstText: 110, complete: 210, total: 310, stopSeen: true, completedBy: "stop-button" }),
        ],
      },
    },
  },
};

const flat = recordsFromHealth(HEALTH);
ok("flattens every by-site recent record", flat.length === 8, String(flat.length));
ok("keeps only report fields", flat.every((r) => r.site && "firstText" in r && "completedBy" in r));
ok("missing fields become null, not undefined", flat.every((r) => r.total !== undefined));

// ---- capture / load / dedupe ----------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noapi-ab-"));
const first = captureRecords(dir, "on", flat, { now: 1000 });
ok("capture writes a label file", fs.existsSync(first.file) && first.added === 8 && first.total === 8, JSON.stringify(first));
const again = captureRecords(dir, "on", flat, { now: 2000 });
ok("capturing the same records again adds nothing", again.added === 0 && again.total === 8, JSON.stringify(again));
const extra = captureRecords(dir, "on", [rec({ id: "c7", site: "chatgpt", firstText: 220, complete: 320, total: 420 })], { now: 3000 });
ok("a new record is appended", extra.added === 1 && extra.total === 9);
const loaded = loadLabel(dir, "on");
ok("loadLabel round-trips", loaded.records.length === 9 && loaded.records.some((r) => r.id === "c7"));

// ---- compare / format ------------------------------------------------------
ok("loading a missing label throws", (() => {
  try {
    loadLabel(dir, "definitely-missing");
    return false;
  } catch {
    return true;
  }
})());

const A = { label: "on", records: flat };
const B = { label: "off", records: flat.filter((r) => r.site === "claude") }; // 2 records
captureRecords(dir, "off", B.records); // so the CLI can load it too
const cmp = compareRecords(A, B);
ok("compare reports both label counts", cmp.a.count === 8 && cmp.b.count === 2);
ok("B is flagged as too few samples", cmp.b.fewSamples === true && cmp.a.fewSamples === false);
const chatgpt = cmp.sites.find((s) => s.site === "chatgpt");
ok("per-site median is computed", chatgpt.a.firstText.median === 150, JSON.stringify(chatgpt.a.firstText));
ok("per-site p90 is computed", chatgpt.a.total.p90 === 400, JSON.stringify(chatgpt.a.total));
ok(
  "completedBy shares are computed",
  chatgpt.a.completedBy[0].count === 2 && chatgpt.a.completedBy.some((x) => x.value === "stop-button" && x.count === 2),
  JSON.stringify(chatgpt.a.completedBy)
);
const report = formatReport(cmp);
ok("format warns when a label has too few samples", /too few samples to compare/.test(report), report.slice(0, 200));
ok("format lists each site", /site: chatgpt/.test(report) && /site: claude/.test(report));

// ---- CLI compare against the captured files --------------------------------
const cli = spawnSync(
  process.execPath,
  [fileURLToPath(new URL("./ab-report.js", import.meta.url)), "compare", "on", "off", "--dir", dir],
  { encoding: "utf8" }
);
ok("CLI compare exits 0 for a valid label pair", cli.status === 0, `status=${cli.status} err=${cli.stderr}`);
ok("CLI compare prints the warning for a small label", /too few samples to compare/.test(cli.stdout), cli.stdout.slice(0, 200));
const usage = spawnSync(process.execPath, [fileURLToPath(new URL("./ab-report.js", import.meta.url))], { encoding: "utf8" });
ok("CLI with no command prints usage", /usage:/.test(usage.stdout));

fs.rmSync(dir, { recursive: true, force: true });

if (failed) {
  console.error(`\n${failed} ab-report test(s) failed`);
  process.exit(1);
}
console.log("\nall ab-report tests passed");
