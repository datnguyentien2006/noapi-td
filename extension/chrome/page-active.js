// NOAPI? page-active.js - keeps an AI chat page working while its tab is hidden.
//
// A hidden tab (another tab or window in front) is told by the browser that it is
// "hidden": many chat UIs react by pausing their stream rendering, and
// requestAnimationFrame never fires, so the reply text never reaches the DOM and
// the content script, which reads the reply from the DOM, waits until you come back.
//
// This file runs in the page's MAIN world at document_start (manifest.json; Firefox:
// injected with a <script> tag by content.js). It does nothing until the content
// script sets attributes on <html>:
//
//   data-noapi-keepactive="1"  this site opted in (SITES[x].keepActive and the panel
//                              flag). Installs the requestAnimationFrame wrapper and
//                              the event guards once. They are pass-through while no
//                              request is in flight.
//   data-noapi-active="1"      a request is in flight (set when it starts, removed
//                              when it ends, fails or is cancelled). While set:
//                                - document.visibilityState reads "visible",
//                                  document.hidden reads false, document.hasFocus()
//                                  returns true;
//                                - "visibilitychange" and window "blur"/"pagehide"
//                                  events are swallowed before the page sees them;
//                                - if the tab is REALLY hidden, requestAnimationFrame
//                                  callbacks are driven by a Worker (about 16 ms) so
//                                  pages that wait for animation frames keep running.
//
// It never focuses, reloads or switches tabs, and never touches setTimeout /
// setInterval. Everything is undone when the request ends.
//
// Status for the content script (diagnostics): data-noapi-pa="<loaded|raf mode>:<frames>".
(() => {
  if (window.__noapiPageActive) return;
  window.__noapiPageActive = true;

  const KEEP_ATTR = "data-noapi-keepactive";
  const ACTIVE_ATTR = "data-noapi-active";
  const STATUS_ATTR = "data-noapi-pa";
  const MAX_ACTIVE_MS = 12 * 60 * 1000; // safety: a stuck attribute cannot spoof forever
  const FRAME_MS = 16;

  const root = () => document.documentElement;
  const attr = (name) => {
    try {
      return root().getAttribute(name);
    } catch {
      return null;
    }
  };
  const setAttr = (name, value) => {
    try {
      root().setAttribute(name, value);
    } catch {}
  };

  // The browser's own answers, taken from the prototype so they stay correct while
  // the instance properties are overridden.
  const protoGetter = (name) => {
    try {
      const d = Object.getOwnPropertyDescriptor(Document.prototype, name);
      return d && d.get ? d.get : null;
    } catch {
      return null;
    }
  };
  const getVisibility = protoGetter("visibilityState");
  const getHidden = protoGetter("hidden");
  const realHidden = () => {
    try {
      if (getVisibility) return getVisibility.call(document) === "hidden";
      if (getHidden) return Boolean(getHidden.call(document));
    } catch {}
    return false;
  };

  let keep = false; // site opted in: wrappers installed
  let active = false; // a request is in flight: spoof on
  let applied = false; // instance overrides currently installed
  let activeSince = 0;
  let guardTimer = null;

  // ---------------- visibility / focus spoof ----------------
  const define = (obj, key, descriptor) => {
    try {
      Object.defineProperty(obj, key, { configurable: true, enumerable: true, ...descriptor });
    } catch {}
  };
  function applySpoof() {
    if (applied) return;
    applied = true;
    define(document, "visibilityState", { get: () => "visible" });
    define(document, "hidden", { get: () => false });
    define(document, "hasFocus", { value: () => true, writable: true });
  }
  function restoreSpoof() {
    if (!applied) return;
    applied = false;
    // Deleting the own properties exposes the prototype's real accessors again.
    try {
      delete document.visibilityState;
      delete document.hidden;
      delete document.hasFocus;
    } catch {}
  }

  // Events: registered once, first (document_start), capture phase. Swallowed only
  // while a request is in flight.
  function onVisibility(e) {
    syncDriver(); // the real state changed: start/stop the frame driver
    if (active) {
      try {
        e.stopImmediatePropagation();
      } catch {}
    }
  }
  function onWindowEvent(e) {
    if (!active) return;
    if (e.target !== window && e.target !== document) return; // blur of a child element is not the page losing focus
    try {
      e.stopImmediatePropagation();
    } catch {}
  }
  function installGuards() {
    try {
      window.addEventListener("visibilitychange", onVisibility, true);
      document.addEventListener("visibilitychange", onVisibility, true);
      window.addEventListener("blur", onWindowEvent, true);
      window.addEventListener("pagehide", onWindowEvent, true);
    } catch {}
  }

  // ---------------- requestAnimationFrame driver ----------------
  const origRAF = typeof window.requestAnimationFrame === "function" ? window.requestAnimationFrame : null;
  const origCAF = typeof window.cancelAnimationFrame === "function" ? window.cancelAnimationFrame : null;
  const pending = new Map(); // id -> { cb, nid }  registered with the browser, not fired yet
  const queue = new Map(); // id -> cb              owned by the driver while it runs
  let seq = 0;
  let driving = false;
  let ticker = null;
  let tickerMode = "none"; // "worker" | "timer" | "none"
  let frames = 0;
  let lastReportAt = 0;
  let wrapped = false;

  const reportStatus = (force) => {
    const now = Date.now();
    if (!force && now - lastReportAt < 1000) return;
    lastReportAt = now;
    setAttr(STATUS_ATTR, (driving ? tickerMode : "native") + ":" + frames);
  };

  function nativeSchedule(id, cb) {
    const entry = { cb, nid: 0 };
    entry.nid = origRAF.call(window, (t) => {
      pending.delete(id);
      cb(t);
    });
    pending.set(id, entry);
  }
  function wrapRAF(cb) {
    if (typeof cb !== "function") return origRAF.call(window, cb); // the browser raises its own TypeError
    const id = ++seq;
    if (driving) {
      queue.set(id, cb);
      return id;
    }
    nativeSchedule(id, cb);
    return id;
  }
  function wrapCAF(id) {
    if (queue.delete(id)) return;
    const e = pending.get(id);
    if (e) {
      pending.delete(id);
      origCAF.call(window, e.nid);
      return;
    }
    return origCAF.call(window, id);
  }
  function installRaf() {
    if (wrapped || !origRAF || !origCAF) return;
    wrapped = true;
    try {
      window.requestAnimationFrame = wrapRAF;
      window.cancelAnimationFrame = wrapCAF;
    } catch {
      wrapped = false;
    }
  }

  function flush() {
    frames++;
    const t = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
    const batch = Array.from(queue.entries());
    queue.clear();
    for (const [, cb] of batch) {
      try {
        cb(t);
      } catch (err) {
        setTimeout(() => {
          throw err;
        });
      }
    }
    reportStatus(false);
  }

  function startTicker() {
    if (ticker) return;
    try {
      const src = "const h=setInterval(()=>postMessage(0)," + FRAME_MS + ");onmessage=(e)=>{if(e.data==='stop'){clearInterval(h);close();}};";
      const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
      const w = new Worker(url);
      let revoked = false;
      w.onmessage = () => {
        if (!revoked) {
          revoked = true;
          try {
            URL.revokeObjectURL(url);
          } catch {}
        }
        flush();
      };
      w.onerror = () => {
        // Blocked by the page's CSP or crashed: fall back to an ordinary timer
        // (about 1 frame/second in a hidden tab, still better than none).
        try {
          w.terminate();
        } catch {}
        if (ticker && ticker.worker === w) {
          ticker = { timer: setInterval(flush, FRAME_MS) };
          tickerMode = "timer";
        }
      };
      ticker = { worker: w };
      tickerMode = "worker";
    } catch {
      ticker = { timer: setInterval(flush, FRAME_MS) };
      tickerMode = "timer";
    }
  }
  function stopTicker() {
    const t = ticker;
    ticker = null;
    if (!t) return;
    try {
      if (t.worker) {
        t.worker.postMessage("stop");
        t.worker.terminate();
      }
      if (t.timer) clearInterval(t.timer);
    } catch {}
  }

  function startDriving() {
    if (driving || !wrapped) return;
    driving = true;
    // Callbacks already registered with the browser would never fire while hidden:
    // take them over.
    for (const [id, e] of pending) {
      try {
        origCAF.call(window, e.nid);
      } catch {}
      queue.set(id, e.cb);
    }
    pending.clear();
    startTicker();
    reportStatus(true);
  }
  function stopDriving() {
    if (!driving) return;
    driving = false;
    stopTicker();
    // Hand what is left back to the browser.
    for (const [id, cb] of queue) nativeSchedule(id, cb);
    queue.clear();
    reportStatus(true);
  }
  function syncDriver() {
    if (keep && active && realHidden()) startDriving();
    else stopDriving();
  }

  // ---------------- state sync ----------------
  function setActive(on) {
    if (on === active) return;
    active = on;
    clearTimeout(guardTimer);
    if (on) {
      activeSince = Date.now();
      applySpoof();
      // Safety net: never stay spoofed past the longest request.
      guardTimer = setTimeout(() => {
        if (active && Date.now() - activeSince >= MAX_ACTIVE_MS) setActive(false);
      }, MAX_ACTIVE_MS + 1000);
    } else {
      restoreSpoof();
    }
    syncDriver();
  }
  function sync() {
    const wantKeep = attr(KEEP_ATTR) === "1";
    if (wantKeep && !keep) {
      keep = true;
      installRaf();
    } else if (!wantKeep && keep) {
      keep = false;
      setActive(false);
    }
    setActive(keep && attr(ACTIVE_ATTR) === "1");
  }

  installGuards();
  try {
    new MutationObserver(sync).observe(root(), {
      attributes: true,
      attributeFilter: [KEEP_ATTR, ACTIVE_ATTR],
    });
  } catch {}
  setAttr(STATUS_ATTR, "loaded:0");
  sync();
})();
