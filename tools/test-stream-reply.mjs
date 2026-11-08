// Run from the folder that holds sse-observer.js and content.js:
//   node test-stream-reply.mjs [path/to/sse-observer.js] [path/to/content.js]
import fs from "node:fs";
import vm from "node:vm";
const obsPath = process.argv[2] || "./sse-observer.js";
const contentPath = process.argv[3] || "./content.js";
let fail = 0;
const ok = (n, c, x = "") => { console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + x)); if (!c) fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- a stream shaped like the captured Z.ai sample ---------------------------------
const frame = (data) => "data: " + JSON.stringify({ type: "chat:completion", data }) + "\n\n";
const thinking = ["The user is asking for", " the third time to write", " 40 words about cats", ".\n\nPrevious themes:\n1"];
const answer = ["Whiskers twitch, paws", " pounce — cats are", " born hunters \"wrapped\" in velvet.", " Mèo luôn bí ẩn 🐈", ", and love.\n\n*(", "Exactly 40 words)*"];
const expected = answer.join("");
const wire =
  thinking.map((t) => frame({ delta_content: t, phase: "thinking" })).join("") +
  answer.slice(0, 3).map((t) => frame({ delta_content: t, phase: "answer" })).join("") +
  frame({ phase: "other", usage: { prompt_tokens: 18894, completion_tokens: 884, total_tokens: 19778 } }) +
  answer.slice(3).map((t) => frame({ delta_content: t, phase: "answer" })).join("") +
  frame({ phase: "done", done: true });

function makeEnv({ hostname = "chat.z.ai", textFlag = "1", chunkBytes = 7, failRead = false, body = wire } = {}) {
  const posts = []; const attrs = { "data-noapi-sse-text": textFlag };
  const doc = { documentElement: { getAttribute: (k) => (k in attrs ? attrs[k] : null), setAttribute: (k, v) => { attrs[k] = String(v); } } };
  const origFetch = async () => {
    const bytes = Buffer.from(body, "utf8"); let i = 0;
    const stream = new ReadableStream({
      pull(c) {
        if (failRead && i > 200) { c.error(new Error("aborted")); return; }
        if (i >= bytes.length) { c.close(); return; }
        c.enqueue(new Uint8Array(bytes.subarray(i, i + chunkBytes))); i += chunkBytes;
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });
  };
  const ctx = { fetch: origFetch, document: doc, location: { hostname, origin: "https://" + hostname, href: "https://" + hostname + "/" },
    crypto: { getRandomValues: (a) => a.fill(7) }, TextDecoder, URL, console, Date, Promise, JSON, setTimeout };
  ctx.window = ctx; ctx.postMessage = (m) => posts.push(m);
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(obsPath, "utf8"), ctx);
  return { ctx, posts, attrs };
}
async function run(env, url = "https://chat.z.ai/api/v2/chat/completions?x=1") {
  const res = await env.ctx.window.fetch(url);
  const pageText = await res.text(); // the page reads ITS body
  for (let i = 0; i < 50 && !env.posts.some((p) => p.event === "ended" || p.event === "error"); i++) await sleep(10);
  return pageText;
}

// 1 the real shape, awkward 7-byte chunks (splits JSON and multi-byte characters)
{
  const env = makeEnv(); const pageText = await run(env);
  const ev = env.posts.map((p) => p.event);
  ok("events: started ... delta ... ended", ev[0] === "started" && ev.at(-1) === "ended" && ev.includes("delta"), ev.join(","));
  ok("started carries sid and path", env.posts[0].sid === 1 && env.posts[0].path === "/api/v2/chat/completions", JSON.stringify(env.posts[0]));
  const deltas = env.posts.filter((p) => p.event === "delta");
  const last = deltas.at(-1);
  ok("final text = the answer only (thinking + usage dropped)", last.text === expected, JSON.stringify(last.text));
  ok("final delta flagged done", last.done === true);
  ok("every event has the same sid", env.posts.every((p) => p.sid === 1));
  ok("deltas are cumulative", deltas.every((d, i) => i === 0 || d.text.startsWith(deltas[i - 1].text)));
  ok("the page still reads its own body untouched", pageText === wire);
  ok("delta posts are throttled below one per frame", deltas.length < 7, String(deltas.length));
}
// 2 one big chunk (all frames in one read)
{
  const env = makeEnv({ chunkBytes: 1e6 }); await run(env);
  const last = env.posts.filter((p) => p.event === "delta").at(-1);
  ok("single chunk: complete text and done", last && last.text === expected && last.done === true);
}
// 3 CRLF stream
{
  const env = makeEnv({ body: wire.replace(/\n/g, "\r\n"), chunkBytes: 13 }); await run(env);
  const last = env.posts.filter((p) => p.event === "delta").at(-1);
  ok("CRLF stream decoded", last && last.text.length > 0 && last.done === true, JSON.stringify(last));
}
// 4 text flag off -> body not decoded, completion events unchanged
{
  const env = makeEnv({ textFlag: "0" }); await run(env);
  ok("flag off: no delta, started+ended still sent", !env.posts.some((p) => p.event === "delta") && env.posts[0].event === "started" && env.posts.at(-1).event === "ended");
}
// 5 another site: no parser, events still flow
{
  const env = makeEnv({ hostname: "chatgpt.com" }); await run(env, "https://chatgpt.com/backend-api/conversation");
  ok("other site: no delta", !env.posts.some((p) => p.event === "delta") && env.posts.at(-1).event === "ended");
}
// 6 stream aborted midway -> error, never "ended"
{
  const env = makeEnv({ failRead: true }); await run(env).catch(() => {});
  for (let i = 0; i < 30 && !env.posts.some((p) => p.event === "error"); i++) await sleep(10);
  ok("aborted stream -> error event, no ended", env.posts.some((p) => p.event === "error") && !env.posts.some((p) => p.event === "ended"), env.posts.map((p) => p.event).join(","));
}
// 7 stream numbering across requests
{
  const env = makeEnv(); await run(env); env.posts.length = 0; await run(env);
  ok("second stream gets sid 2", env.posts[0].sid === 2);
}

// ---- content.js: the pure decision and the event bookkeeping -----------------------
const src = fs.readFileSync(contentPath, "utf8").replace(/\r\n/g, "\n");
const blk = (name) => { const a = src.indexOf(`/* @noapi-shared-start ${name} */`), b = src.indexOf(`/* @noapi-shared-end ${name} */`); return src.slice(a, b); };
const dec = vm.runInNewContext(blk("streamReply") + "\nstreamReplyDecision;");
const R = (o) => ({ sid: 5, text: "hi", finished: false, errored: false, ...o });
ok("decision: no reply", JSON.stringify(dec(null, 0, true, false)) === '{"use":false,"finish":false}');
ok("decision: old stream ignored", !dec(R({ sid: 3 }), 3, true, false).use);
ok("decision: hidden tab -> use, not finished yet", dec(R(), 4, true, true).use && !dec(R(), 4, true, true).finish);
ok("decision: hidden + finished -> finish", dec(R({ finished: true }), 4, true, true).finish);
ok("decision: hidden + finished but errored -> no finish", !dec(R({ finished: true, errored: true }), 4, true, true).finish);
ok("decision: visible and DOM painting -> DOM stays authority", !dec(R({ finished: true }), 4, false, true).use && !dec(R({ finished: true }), 4, false, true).finish);
ok("decision: visible but DOM empty -> stream is the fallback", dec(R({ finished: true }), 4, false, false).finish);
ok("decision: empty text never used", !dec(R({ text: "" }), 4, true, false).use);

// the message listener, lifted out of content.js
const a = src.indexOf('  const SSE_TOKEN_ATTR = "data-noapi-sse-token";'); const lm = src.indexOf('window.addEventListener("message"'); const b = src.indexOf("\n  });\n", lm) + 7;
let handler; const attrs = { "data-noapi-sse-token": "tok" };
const sandbox = { FLAGS: { sseObserver: true }, ext: { runtime: { getURL: (x) => x } }, console, Date,
  document: { documentElement: { getAttribute: (k) => attrs[k] ?? null, setAttribute: (k, v) => { attrs[k] = v; } }, createElement() { return {}; }, head: null },
  window: { addEventListener: (t, f) => { if (t === "message") handler = f; } } };
vm.createContext(sandbox); vm.runInContext(src.slice(a, b) + "\nthis.SSE = SSE; this.readSseToken = readSseToken;", sandbox);
const SSE = sandbox.SSE; sandbox.readSseToken();
const send = (event, sid, extra = {}) => handler({ data: { source: "noapi-sse", token: "tok", event, sid, ...extra } });
send("started", 1); send("delta", 1, { text: "old answer", done: true }); send("ended", 1);
const streamBefore = SSE.lastSid;
ok("old turn recorded, lastSid = 1", streamBefore === 1 && SSE.reply.sid === 1);
send("started", 2); send("delta", 2, { text: "new ans" });
ok("new stream is newer than the snapshot", SSE.reply.sid === 2 && SSE.reply.sid > streamBefore && SSE.reply.text === "new ans" && !SSE.reply.finished);
send("delta", 2, { text: "new answer", done: true });
ok("done flag finishes the reply", SSE.reply.finished && SSE.reply.text === "new answer");
send("started", 3); send("delta", 3, { text: "partial" }); send("error", 3);
ok("error marks the reply errored, not finished", SSE.reply.errored && !SSE.reply.finished);
send("ended", 9);
ok("an unrelated stream cannot finish the reply", !SSE.reply.finished);
handler({ data: { source: "noapi-sse", token: "WRONG", event: "delta", sid: 99, text: "x" } });
ok("wrong token ignored", SSE.reply.sid === 3);

console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED"); process.exit(fail ? 1 : 0);
