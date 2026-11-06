// Unit tests for tools/report-latency.js using fixture /health JSON. No network.
import { buildReport, formatReport, siteReport } from "./report-latency.js";

let failed = 0;
function ok(name, cond, extra = "") {
  if (cond) console.log("ok:", name);
  else {
    console.error("FAIL:", name, extra);
    failed++;
  }
}

const rec = (o) => ({
  composer: 10,
  typed: 20,
  sent: 30,
  firstText: 100,
  lastToken: 200,
  complete: 260,
  postToken: 60,
  total: 300,
  promptChars: 1000,
  replyChars: 500,
  ...o,
});

const HEALTH = {
  name: "noapi-bridge",
  clients: [{ id: "c1" }, { id: "c2" }],
  timings: {
    bySite: {
      chatgpt: {
        recent: [
          rec({ id: "c1", total: 300, complete: 260, lastToken: 200, postToken: 60 }),
          rec({ id: "c2", total: 400, complete: 360, lastToken: 200, postToken: 160 }),
          rec({ id: "c3", total: 500, complete: 460, lastToken: 200, postToken: 260 }),
        ],
      },
      claude: {
        recent: [rec({ id: "l1", total: 200, complete: 150, lastToken: null, postToken: undefined, promptChars: 800 })],
      },
    },
  },
  stats: {
    chatgpt: { lateGrowth: 0, lateGrowthChars: 0 },
    claude: { lateGrowth: 1, lateGrowthChars: 42 },
  },
};

const report = buildReport(HEALTH);
ok("report names each site once, sorted", JSON.stringify(report.sites.map((s) => s.site)) === JSON.stringify(["chatgpt", "claude"]));
ok("report counts browser clients", report.clients === 2, String(report.clients));

const chatgpt = report.sites.find((s) => s.site === "chatgpt");
ok("per-site count", chatgpt.count === 3, String(chatgpt.count));
ok("median of a stage", chatgpt.stages.total.median === 400, JSON.stringify(chatgpt.stages.total));
ok("p90 of a stage", chatgpt.stages.total.p90 === 500, JSON.stringify(chatgpt.stages.total));
ok("postToken median is reported", chatgpt.stages.postToken.median === 160, JSON.stringify(chatgpt.stages.postToken));
ok("median prompt size is reported", chatgpt.promptChars === 1000, String(chatgpt.promptChars));
ok("lateGrowth is surfaced per site", chatgpt.lateGrowth === 0, String(chatgpt.lateGrowth));

const claude = report.sites.find((s) => s.site === "claude");
ok("a stage missing from every record is null, not 0", claude.stages.postToken.median === null, JSON.stringify(claude.stages.postToken));
ok("lateGrowth chars are surfaced", claude.lateGrowth === 1 && claude.lateGrowthChars === 42, JSON.stringify(claude));

// A site with no completed records still reports (n=0) instead of disappearing.
const empty = siteReport("gemini", [], null);
ok("an empty site reports count 0 and null stages", empty.count === 0 && empty.stages.total.median === null);

const text = formatReport(report);
ok("format prints the site header with n and prompt size", /site: chatgpt/.test(text) && /n=3/.test(text) && /median prompt 1000 chars/.test(text));
ok("format prints each stage row", /total/.test(text) && /postToken/.test(text) && /firstText/.test(text));
ok("format flags real late growth", /TRUNCATION\?/.test(text), text);
ok("format explains the lateGrowth invariant", /lateGrowth must stay 0/.test(text));

const emptyText = formatReport(buildReport({}));
ok("format handles a bridge with no requests", /No completed requests recorded yet/.test(emptyText), emptyText);

if (failed) {
  console.error(`\n${failed} report-latency test(s) failed`);
  process.exit(1);
}
console.log("\nall report-latency tests passed");
