// NOAPI? SSE observer.
//
// This file runs in the page's MAIN world so it can see the page's own
// window.fetch. It wraps fetch for two reasons:
//
//   1. (always) learn when the website starts and finishes a text/event-stream
//      (SSE) response, so the content script can treat "the site's stream ended"
//      as "the answer is complete" instead of waiting for the debounce. It never
//      changes a request or a response, never calls a site API, and never
//      hardcodes a URL - it only watches the traffic the page already makes.
//
//   2. (only when the page sets data-noapi-sse-text="1", default off) decode the
//      stream body to extract the reply text as it arrives and post it as an
//      earlier trigger for the content script. This is opt-in per request: with
//      the flag off, the body is never read, exactly as before. The content
//      script still uses the DOM text as the authoritative reply.
//
//   3. (only when the page sets data-noapi-sse-debug="1", default off) keep a
//      decoded copy of the last few SSE bodies in memory for debugging, read
//      with window.__noapiSseShow() / __noapiSseClear(). This is a separate
//      decode of the clone; nothing is stored or sent anywhere, and a capture
//      failure never changes the events posted. See tools/test-sse-observer.js.
//
// Events posted to the content script:
//   "started" - an SSE response just began.
//   "ended"   - that stream finished cleanly (its body reached the end).
//   "error"   - the stream errored, was aborted, or its end cannot be observed.
//               This is deliberately NOT "ended": an errored/aborted stream must
//               not be reported as a complete answer (it could truncate a reply).
//   "delta"   - (only with the text flag) the accumulated reply text so far.
//
// Chrome loads this as a "world": "MAIN" content script (see manifest.json).
// Firefox does not support MAIN-world content scripts on our minimum version, so
// extension/*/content.js injects this same file with a <script> tag instead. The
// __noapiSseWrapped guard makes a double load (or a re-injection) a no-op.
(() => {
  // Kill switch. Flip to false (or drop the manifest entry / the injection) to
  // stop observing entirely; the completion loop then behaves exactly as before.
  const SSE_OBSERVER_ENABLED = true;
  if (!SSE_OBSERVER_ENABLED) return;
  if (window.__noapiSseWrapped) return;
  window.__noapiSseWrapped = true;

  // Per-page token, shared with the isolated content script through the shared
  // DOM. A random value means an unrelated page script cannot guess the token
  // and spoof an event by accident; the body and URLs never cross the boundary.
  const ATTR = "data-noapi-sse-token";
  const rand = () => {
    try {
      const a = new Uint8Array(16);
      crypto.getRandomValues(a);
      return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
    } catch {
      return Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
  };
  let token = rand();
  try {
    const el = document.documentElement;
    const existing = el.getAttribute(ATTR);
    if (existing) token = existing;
    else el.setAttribute(ATTR, token);
  } catch {}

  const post = (event, extra) => {
    try {
      window.postMessage({ source: "noapi-sse", token, event, at: Date.now(), ...(extra || {}) }, location.origin);
    } catch {}
  };

  // Task 5: opt-in stream-body decoding. "1" means the content script wants
  // "delta" events for this request; anything else leaves the body untouched.
  const TEXT_ATTR = "data-noapi-sse-text";
  const textEnabled = () => {
    try {
      return document.documentElement.getAttribute(TEXT_ATTR) === "1";
    } catch {
      return false;
    }
  };

  // Task 6: opt-in stream capture for debugging (never on by default). Read at
  // the moment a stream starts, like the text flag. When set, a copy of each
  // SSE response body is decoded into memory (cap below) so it can be inspected
  // with window.__noapiSseShow(). Nothing is stored or sent anywhere with the
  // flag off, and a capture failure never changes the events posted above.
  const DEBUG_ATTR = "data-noapi-sse-debug";
  const debugEnabled = () => {
    try {
      return document.documentElement.getAttribute(DEBUG_ATTR) === "1";
    } catch {
      return false;
    }
  };

  // Z.ai stream parser. Written against a captured sample of
  // /api/v2/chat/completions: every frame is one line
  //   data: {"type":"chat:completion","data":{"delta_content":"...","phase":"thinking"|"answer"}}
  // "thinking" frames are the model's reasoning (the page keeps them out of the
  // reply, so do we), "answer" frames are the reply text, a "phase":"other" frame
  // carries token usage, and the stream ends with {"phase":"done","done":true}.
  // Returns { text, done } for a frame that matters, or null.
  function extractZaiFrame(frame) {
    let text = "";
    let done = false;
    let any = false;
    for (const line of String(frame).split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      if (payload === "[DONE]") {
        done = true;
        any = true;
        continue;
      }
      let obj;
      try {
        obj = JSON.parse(payload);
      } catch {
        continue;
      }
      const d = obj && obj.data;
      if (!d || typeof d !== "object") continue;
      if (d.phase === "answer" && typeof d.delta_content === "string") {
        text += d.delta_content;
        any = true;
      }
      if (d.done === true || d.phase === "done") {
        done = true;
        any = true;
      }
    }
    return any ? { text, done } : null;
  }
  const IS_ZAI = /(^|\.)z\.ai$/i.test(String(location.hostname || ""));

  // ChatGPT stream parser placeholder. The stream format is undocumented, so the
  // parser must be written against a captured sample
  // (tools/fixtures/chatgpt-stream.txt). That sample is not present in this
  // checkout, so this returns null and no "delta" events are posted; everything
  // else (UTF-8 decoding, SSE frame splitting, token-guarded posting, content
  // script handling) is wired and ready for the parser.
  function extractChatGptText(_frame) {
    return null;
  }

  // One decoded SSE frame -> { text, done } or null, by site.
  function parseFrame(frame) {
    if (IS_ZAI) return extractZaiFrame(frame);
    const t = extractChatGptText(frame);
    return t ? { text: t, done: false } : null;
  }

  /* @noapi-shared-start sseSummary */
  // Build the human-readable summary of one captured SSE response. Pure: it
  // reads only the entry, so tools/test-sse-observer.js lifts this block out and
  // runs it in Node. Each slice is JSON.stringify'd so \n and \r stay visible.
  function sseSummary(entry) {
    const HEAD = 3000;
    const MID = 1500;
    const TAIL = 1500;
    if (!entry || typeof entry !== "object") return "NOAPI? SSE debug: no SSE response captured yet.";
    const text = typeof entry.text === "string" ? entry.text : "";
    const len = text.length;
    // The number of blank-line-separated frames in the captured body.
    const frames = text ? text.split("\n\n").filter((f) => f.length > 0).length : 0;
    const midStart = Math.max(0, Math.floor((len - MID) / 2));
    const at = (t) => (t ? new Date(t).toISOString() : "(open)");
    return [
      "NOAPI? SSE debug",
      "path: " + (entry.path || "?"),
      "status: " + (entry.status == null ? "?" : entry.status),
      "content-type: " + (entry.contentType || "?"),
      "chars: " + len,
      "started: " + at(entry.startedAt),
      "ended: " + at(entry.endedAt),
      "frames: " + frames,
      "--- head (" + Math.min(len, HEAD) + ") ---",
      JSON.stringify(text.slice(0, HEAD)),
      "--- middle (" + Math.min(len, MID) + ") ---",
      JSON.stringify(text.slice(midStart, midStart + MID)),
      "--- tail (" + Math.min(len, TAIL) + ") ---",
      JSON.stringify(text.slice(Math.max(0, len - TAIL))),
    ].join("\n");
  }
  /* @noapi-shared-end sseSummary */

  // The captured responses, oldest first: at most the last 5. Only touched when
  // the debug flag is on. CAPTURE_MAX caps one response's kept text; past it the
  // body is still read to the end (so "ended" is unchanged) but not appended.
  const CAPTURE_MAX = 300000;
  const CAPTURE_RESPONSES = 5;
  const sseEntries = [];
  const captureEntry = (path, status, contentType) => {
    const entry = { path, status, contentType, chars: 0, startedAt: Date.now(), endedAt: null, text: "" };
    sseEntries.push(entry);
    if (sseEntries.length > CAPTURE_RESPONSES) sseEntries.shift();
    return entry;
  };
  try {
    // window.__noapiSseShow(n = 1): the summary of the n-th most recent captured
    // response (1 = the latest), returned and logged. __noapiSseClear() empties
    // the buffer.
    window.__noapiSseShow = (n = 1) => {
      const want = Math.max(1, Math.floor(Number(n) || 1));
      const idx = sseEntries.length - want;
      const text = sseSummary(idx >= 0 ? sseEntries[idx] : null);
      try {
        console.log(text);
      } catch {}
      return text;
    };
    window.__noapiSseClear = () => {
      try {
        sseEntries.length = 0;
      } catch {}
    };
  } catch {}

  let streamSeq = 0; // numbers the streams so the content script can tell this turn's from an old one
  const origFetch = window.fetch;
  if (typeof origFetch !== "function") return;
  window.fetch = function (...args) {
    const p = origFetch.apply(this, args);
    try {
      // Attach before returning the promise so our handler runs before the
      // page's own: res.clone() must happen before the page reads the body.
      Promise.resolve(p).then(
        (res) => {
          let started = false;
          let sid = 0; // hoisted so the outer catch can close the stream out under the same id
          const emit = (event, extra) => post(event, { sid, ...(extra || {}) });
          try {
            const ct = res && res.headers && typeof res.headers.get === "function" ? res.headers.get("content-type") : null;
            if (!ct || !String(ct).toLowerCase().startsWith("text/event-stream")) return;
            sid = ++streamSeq;
            let spath = "";
            try {
              const rawUrl = typeof args[0] === "string" ? args[0] : args[0] && args[0].url;
              spath = new URL(String(rawUrl || ""), location.href).pathname;
            } catch {}
            emit("started", { path: spath });
            started = true;
            // Drain a clone in the background so we can tell when the stream
            // ends. The page keeps its own body untouched, byte for byte.
            const clone = res.clone ? res.clone() : null;
            // Opt-in capture (debug flag): a separate decode of the clone, for
            // inspection only. Its failures are swallowed so the events posted
            // below never change.
            const debug = debugEnabled();
            let capture = null;
            if (debug) {
              let path = "";
              try {
                const raw = typeof args[0] === "string" ? args[0] : args[0] && args[0].url;
                path = new URL(String(raw || ""), location.href).pathname;
              } catch {
                path = String((args[0] && args[0].url) || args[0] || "").split("?")[0];
              }
              capture = captureEntry(path, res.status, ct);
            }
            const wantText = textEnabled() && typeof TextDecoder === "function";
            const decoder = wantText || (capture && typeof TextDecoder === "function") ? new TextDecoder() : null;
            const appendCapture = (chunk) => {
              if (!capture || typeof chunk !== "string") return;
              try {
                if (capture.text.length < CAPTURE_MAX) {
                  capture.text += chunk.slice(0, CAPTURE_MAX - capture.text.length);
                  capture.chars = capture.text.length;
                }
              } catch {}
            };
            const endCapture = () => {
              try {
                if (capture && !capture.endedAt) capture.endedAt = Date.now();
              } catch {}
            };
            let sseBuf = "";
            let acc = "";
            let doneSeen = false;
            let unsent = false;
            let lastDeltaAt = 0;
            const flushDelta = () => {
              if (!unsent) return;
              unsent = false;
              lastDeltaAt = Date.now();
              emit("delta", { text: acc, done: doneSeen });
            };
            if (clone && clone.body && typeof clone.body.getReader === "function") {
              const reader = clone.body.getReader();
              const pump = () =>
                reader.read().then(
                  ({ done, value }) => {
                    if (done) {
                      endCapture();
                      if (wantText) flushDelta();
                      emit("ended");
                      return;
                    }
                    if (decoder && value) {
                      let chunk = "";
                      try {
                        chunk = decoder.decode(value, { stream: true });
                      } catch {
                        // A decode failure must never turn into an "ended": fall
                        // back to the DOM path for the rest of the turn.
                        endCapture();
                        emit("error");
                        return;
                      }
                      appendCapture(chunk);
                      if (wantText) {
                        try {
                          sseBuf = (sseBuf + chunk).replace(/\r\n/g, "\n");
                          let idx;
                          while ((idx = sseBuf.indexOf("\n\n")) !== -1) {
                            const frame = sseBuf.slice(0, idx);
                            sseBuf = sseBuf.slice(idx + 2);
                            const r = parseFrame(frame);
                            if (r) {
                              if (r.text) acc += r.text;
                              if (r.done) doneSeen = true;
                              if (r.text || r.done) unsent = true;
                            }
                          }
                          // Post at most every 40 ms (the text so far is cumulative),
                          // always right away on the final frame.
                          if (unsent && (doneSeen || Date.now() - lastDeltaAt >= 40)) flushDelta();
                        } catch {
                          endCapture();
                          emit("error");
                          return;
                        }
                      }
                    }
                    pump();
                  },
                  // A rejected read means the stream errored or the user
                  // aborted it. The answer is NOT complete: report an error so
                  // the content script falls back to the DOM path instead of
                  // returning a truncated reply as "complete".
                  () => {
                    endCapture();
                    emit("error");
                  }
                );
              pump();
            } else if (clone && typeof clone.text === "function") {
              clone.text().then(
                (body) => {
                  appendCapture(String(body));
                  endCapture();
                  emit("ended");
                },
                () => {
                  endCapture();
                  emit("error");
                }
              );
            } else {
              // We cannot observe when this stream ends, so never claim it did.
              endCapture();
              emit("error");
            }
          } catch {
            // Cloning or reading failed after we announced the start: close it
            // out as an error so the live-stream count does not leak (a leaked
            // count would suppress every later "ended" for the rest of the turn).
            if (started) emit("error");
          }
        },
        () => {}
      );
    } catch {}
    return p;
  };
})();