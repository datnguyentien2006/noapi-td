// Wiring guard for a site added to NOAPI?.
//
// Adding a site touches several places that do not import each other: the
// bridge registry, the MCP tool enum, the project OpenCode config, both content
// scripts and both manifests (host permission + content-script matches +
// web-accessible resources). Forgetting one is easy and only shows up as "the
// site never connects", so this test reads the files and asserts each spot.
import fs from "node:fs";

const read = (f) => fs.readFileSync(f, "utf8");
let failed = 0;
const ok = (name, cond) => {
  if (cond) console.log("ok:", name);
  else {
    console.error("FAIL:", name);
    failed++;
  }
};

const KEY = "zai";
const HOST = "chat.z.ai";
const ORIGIN = `https://${HOST}/*`;

// The site registry the bridge uses for /v1/models and model validation.
const sites = read("bridge/sites.js");
ok("bridge/sites.js declares the zai key", new RegExp(`key:\\s*"${KEY}"`).test(sites));
ok("bridge/sites.js registers the host", sites.includes(`"${HOST}"`));

// The MCP tool enum offered to OpenCode.
const mcp = read("bridge/mcp.js");
ok("bridge/mcp.js offers zai in the chat tool enum", new RegExp(`"${KEY}"`).test(mcp));

// The project OpenCode config.
const oc = JSON.parse(read("opencode.json"));
ok("opencode.json exposes a zai model", !!oc.provider?.noapi?.models?.[KEY]);

// Both content scripts must detect the site and carry its selectors, and both
// manifests must gate the content script (and the MAIN-world SSE observer) on
// the host.
for (const which of ["chrome", "firefox"]) {
  const src = read(`extension/${which}/content.js`);
  ok(`${which} content.js has a zai SITES entry`, new RegExp(`${KEY}:\\s*\\{`).test(src));
  ok(`${which} content.js matches the host`, src.includes(`"${HOST}"`));
  ok(`${which} content.js knows the zai send button`, src.includes("#send-message-button"));
  ok(`${which} content.js knows the zai stop control`, src.includes("span.bg-text-inverted"));

  const man = JSON.parse(read(`extension/${which}/manifest.json`));
  ok(`${which} manifest grants the host permission`, JSON.stringify(man).includes(ORIGIN));
  const matches = man.content_scripts.flatMap((cs) => cs.matches || []);
  ok(`${which} manifest runs the content script on the host`, matches.includes(ORIGIN));
  const resources = (man.web_accessible_resources || []).flatMap((w) => w.matches || []);
  ok(`${which} manifest exposes resources on the host`, resources.includes(ORIGIN));
}

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nall site-wiring tests passed");
