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

  // ChatGPT stream parser placeholder. The stream format is undocumented, so the
  // parser must be written against a captured sample
  // (tools/fixtures/chatgpt-stream.txt). That sample is not present in this
  // checkout, so this returns null and no "delta" events are posted; everything
  // else (UTF-8 decoding, SSE frame splitting, token-guarded posting, content
  // script handling) is wired and ready for the parser.
  function extractChatGptText(_frame) {
    return null;
  }

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
          try {
            const ct = res && res.headers && typeof res.headers.get === "function" ? res.headers.get("content-type") : null;
            if (!ct || !String(ct).toLowerCase().startsWith("text/event-stream")) return;
            post("started");
            started = true;
            // Drain a clone in the background so we can tell when the stream
            // ends. The page keeps its own body untouched, byte for byte.
            const clone = res.clone ? res.clone() : null;
            const wantText = textEnabled() && typeof TextDecoder === "function";
            const decoder = wantText ? new TextDecoder() : null;
            let sseBuf = "";
            let acc = "";
            if (clone && clone.body && typeof clone.body.getReader === "function") {
              const reader = clone.body.getReader();
              const pump = () =>
                reader.read().then(
                  ({ done, value }) => {
                    if (done) {
                      post("ended");
                      return;
                    }
                    if (decoder && value) {
                      try {
                        sseBuf += decoder.decode(value, { stream: true });
                        let idx;
                        while ((idx = sseBuf.indexOf("\n\n")) !== -1) {
                          const frame = sseBuf.slice(0, idx);
                          sseBuf = sseBuf.slice(idx + 2);
                          const t = extractChatGptText(frame);
                          if (t) {
                            acc += t;
                            post("delta", { text: acc });
                          }
                        }
                      } catch {
                        // A decode/parse failure must never turn into an "ended":
                        // fall back to the DOM path for the rest of the turn.
                        post("error");
                        return;
                      }
                    }
                    pump();
                  },
                  // A rejected read means the stream errored or the user
                  // aborted it. The answer is NOT complete: report an error so
                  // the content script falls back to the DOM path instead of
                  // returning a truncated reply as "complete".
                  () => post("error")
                );
              pump();
            } else if (clone && typeof clone.text === "function") {
              clone.text().then(() => post("ended"), () => post("error"));
            } else {
              // We cannot observe when this stream ends, so never claim it did.
              post("error");
            }
          } catch {
            // Cloning or reading failed after we announced the start: close it
            // out as an error so the live-stream count does not leak (a leaked
            // count would suppress every later "ended" for the rest of the turn).
            if (started) post("error");
          }
        },
        () => {}
      );
    } catch {}
    return p;
  };
})();
