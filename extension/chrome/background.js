// Phase 3: keeps AI tabs from being discarded, the computer awake and this worker
// alive (see keepalive.js). Guarded so Firefox event pages, which have no
// importScripts, simply skip it.
if (typeof importScripts === "function") importScripts("keepalive.js");

// NOAPI? background (service worker / event page).
// Maintains WebSocket connection to ws://127.0.0.1:8787, keeps service worker
// alive via heartbeats and port connections, and routes requests to active AI tabs.
(() => {
  "use strict";
  const ext = globalThis.browser || globalThis.chrome;

  // Connection timings (ms). Overridable for tests only.
  const CFG = Object.assign(
    {
      baseDelay: 1000, // first retry delay; doubles per failed attempt
      maxDelay: 30_000, // retry delay ceiling
      minGap: 1000, // never open two sockets less than this apart
      pingEvery: 10_000, // heartbeat + ping period
      deadAfter: 30_000, // no message from the bridge for this long = connection dead
      forceWait: 4000, // how long the Reconnect button waits for the result
      connectTimeout: 8000, // a socket still CONNECTING after this long is abandoned
    },
    globalThis.__NOAPI_CFG__ || {}
  );

  const state = {
    ws: null,
    gen: 0, // id of the current socket; events of older sockets are ignored
    url: "ws://127.0.0.1:8787",
    connected: false,
    attempt: 0, // failed attempts since the last good connection
    reconnectTimer: null, // the ONE pending retry timer (never more than one)
    lastAttemptAt: 0,
    lastRx: 0, // when the bridge last sent us anything
    forcing: null, // in-flight manual reconnect
    tabs: new Map(), // tabId -> { site, url, port }
    pending: new Map(), // reqId -> tabId
    cancelling: new Map(), // reqId -> tabId (cancel sent, waiting for the tab's terminal message)
    heartbeatTimer: null,
  };

  const log = (...a) => {
    try {
      console.log("[noapi-bg]", ...a);
    } catch {}
  };

  function sendWs(obj) {
    if (state.ws && state.ws.readyState === 1) {
      try {
        state.ws.send(JSON.stringify(obj));
        return true;
      } catch (e) {
        log("ws send failed", e);
      }
    }
    return false;
  }

  function broadcastToTabs(msg) {
    for (const [tabId, info] of state.tabs) {
      try {
        if (info.port) {
          info.port.postMessage(msg);
        } else {
          ext.tabs.sendMessage(tabId, msg).catch(() => {});
        }
      } catch {}
    }
  }

  // ---- connection management --------------------------------------------
  // Rules this section enforces (each one was a bug):
  //  * at most one socket and one retry timer exist at any time;
  //  * a late event of an OLD socket never touches the current one (gen check);
  //  * "connected" means the bridge answered recently (ping/pong), not merely
  //    that the socket object says OPEN, so a dead or stale link is noticed;
  //  * retries back off exponentially with jitter and never burst.
  const isLive = () => state.connected && state.ws?.readyState === 1 && Date.now() - state.lastRx < CFG.deadAfter;

  function stopLiveness() {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }

  function discardSocket() {
    const ws = state.ws;
    state.ws = null;
    state.gen++; // invalidates every handler of that socket
    stopLiveness();
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {}
    }
  }

  function markDisconnected(why) {
    const was = state.connected;
    state.connected = false;
    if (was) {
      log(`bridge connection lost (${why})`);
      updateAction();
      broadcastToTabs({ type: "noapi_bridge_status", connected: false });
    }
  }

  function scheduleReconnect(delay) {
    if (state.reconnectTimer) return; // one timer only
    if (delay === undefined) {
      const base = Math.min(CFG.maxDelay, CFG.baseDelay * 2 ** state.attempt);
      delay = Math.round(base * (0.8 + Math.random() * 0.4)); // jitter
      state.attempt++;
    }
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      connect();
    }, Math.max(0, delay));
  }

  function connect() {
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    if (state.ws) {
      if (state.ws.readyState === 0 || state.ws.readyState === 1) return; // already connecting/open
      discardSocket();
    }
    const wait = state.lastAttemptAt + CFG.minGap - Date.now();
    if (wait > 0) {
      scheduleReconnect(wait);
      return;
    }
    state.lastAttemptAt = Date.now();

    log("connecting to", state.url);
    let ws;
    try {
      ws = new WebSocket(state.url);
    } catch (e) {
      log("ws construct error", e);
      scheduleReconnect();
      return;
    }
    const gen = ++state.gen;
    state.ws = ws;

    ws.onopen = () => {
      if (gen !== state.gen) return;
      state.connected = true;
      state.attempt = 0;
      state.lastRx = Date.now();
      log("✓ connected to bridge at", state.url);

      // Identify this extension client
      sendWs({
        t: "hello",
        client: "noapi-extension",
        version: "0.1.0",
      });

      // Send all currently active tab sites to bridge
      for (const info of state.tabs.values()) {
        if (info.site) {
          sendWs({ t: "hello-update", site: info.site, url: info.url });
        }
      }

      updateAction();
      broadcastToTabs({ type: "noapi_bridge_status", connected: true });

      // Heartbeat + ping: keeps the MV3 worker alive AND proves the bridge is
      // still there (it answers ping with pong; see livenessTick).
      stopLiveness();
      state.heartbeatTimer = setInterval(livenessTick, CFG.pingEvery);
    };

    ws.onmessage = (e) => {
      if (gen !== state.gen) return;
      state.lastRx = Date.now();
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      handleBridgeMessage(m);
    };

    // Browsers fire error and then close; some engines fire only error. drop()
    // ignores whichever arrives second (the generation has changed by then).
    ws.onclose = () => drop(gen, "socket closed");
    ws.onerror = () => {
      if (gen === state.gen) log("ws error");
      drop(gen, "socket error");
    };
    // A server that accepts the TCP connection but never completes the
    // handshake would leave the socket CONNECTING forever, with no retry.
    setTimeout(() => {
      if (gen === state.gen && ws.readyState === 0) drop(gen, "connect timeout");
    }, CFG.connectTimeout);
  }

  // The socket for generation `gen` ended (or was found dead).
  function drop(gen, why) {
    if (gen !== state.gen) return; // stale event of an older socket
    discardSocket();
    markDisconnected(why);
    scheduleReconnect();
  }

  function livenessTick() {
    const ws = state.ws;
    if (!ws || ws.readyState !== 1) return;
    if (Date.now() - state.lastRx > CFG.deadAfter) {
      drop(state.gen, "bridge stopped answering");
      return;
    }
    sendWs({ t: "heartbeat" });
    sendWs({ t: "ping" });
  }

  // Manual "Reconnect" (the panel button). Tears down the current socket,
  // resets the backoff, connects at once and reports the REAL outcome.
  function forceReconnect() {
    if (state.forcing) return state.forcing;
    state.forcing = (async () => {
      if (isLive() && state.pending.size) return true; // do not cut a request in flight
      if (state.reconnectTimer) {
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = null;
      }
      if (state.ws) {
        discardSocket();
        markDisconnected("manual reconnect");
      }
      state.attempt = 0;
      state.lastAttemptAt = 0;
      connect();
      const until = Date.now() + CFG.forceWait;
      while (Date.now() < until && !isLive()) await new Promise((r) => setTimeout(r, 100));
      return isLive();
    })().finally(() => {
      state.forcing = null;
    });
    return state.forcing;
  }

  // Watchdog: a suspended MV3 worker loses its timers, an alarm wakes it. Check
  // the link and make sure a retry is scheduled when it is down.
  function watchdog() {
    livenessTick();
    if (!isLive() && !state.reconnectTimer && state.ws?.readyState !== 0) scheduleReconnect(0);
  }
  try {
    ext.alarms?.create?.("noapi-bg-watch", { periodInMinutes: 0.5 });
    ext.alarms?.onAlarm?.addListener?.((a) => {
      if (a.name === "noapi-bg-watch" || a.name === "noapi-keepalive") watchdog();
    });
  } catch {}

  function handleBridgeMessage(m) {
    if (m.t === "welcome") {
      log("bridge welcomed extension");
      return;
    }
    if (m.t === "pong") return;

    if (m.t === "cancel") {
      const tid = state.pending.get(m.id);
      state.pending.delete(m.id);
      updateAction();
      const info = tid !== undefined ? state.tabs.get(tid) : null;
      if (tid !== undefined && info) {
        // The tab is (or may be) still running this id. Forward the cancel and
        // ack the bridge only once the tab reports its terminal message, so the
        // next request is not delivered while the tab is still unwinding.
        state.cancelling.set(m.id, tid);
        const cmsg = { type: "noapi_cancel", id: m.id };
        try {
          if (info.port) info.port.postMessage(cmsg);
          else ext.tabs.sendMessage(tid, cmsg).catch(() => {});
        } catch {}
      } else {
        // No tab is running it: ack immediately.
        sendWs({ t: "cancelled", id: m.id });
      }
      return;
    }

    if (m.t === "request") {
      const { id, prompt, site } = m;
      log(`received bridge request ${id} for site: ${site || "any"}`);

      // Find matching tab
      let targetTabId = null;
      let targetInfo = null;

      if (site) {
        for (const [tid, info] of state.tabs) {
          if (info.site === site) {
            targetTabId = tid;
            targetInfo = info;
            break;
          }
        }
      } else {
        // No site requested: any active tab will do.
        for (const [tid, info] of state.tabs) {
          targetTabId = tid;
          targetInfo = info;
          break;
        }
      }

      if (targetTabId === null) {
        sendWs({
          t: "error",
          id,
          error: `No open tab found for "${site || "any supported AI site"}". Please open the website in your browser.`,
        });
        return;
      }

      state.pending.set(id, targetTabId);
      updateAction();

      const payload = {
        type: "noapi_autosend",
        id,
        prompt,
        system: m.system || null,
        site: targetInfo.site,
        // Tools are enabled for this request: the content script may return a
        // complete TOOL_CALL block as soon as it settles instead of waiting for
        // the whole (often long) trailing narration.
        toolsEnabled: Boolean(m.tools_enabled),
        // Early return on a complete tool call: the bridge decides via its
        // environment and passes the knobs down (a content script cannot read
        // process.env). NOAPI_EARLY_RETURN=0 disables it and the stop click.
        earlyReturn: m.early_return !== false,
        earlyReturnMs: Number(m.early_return_ms) || 400,
        toolNames: Array.isArray(m.tool_names) ? m.tool_names : [],
        // Phase 3: NOAPI_SSE=0 disables the page-SSE completion signal.
        sse: m.sse !== false,
        // Phase 5: NOAPI_NEW_CHAT=1 asks the tab to open a fresh chat first.
        newChat: m.new_chat === true,
        // Task 1: timing knobs the bridge read from its environment and forwarded
        // because a content script cannot read process.env.
        tuning: m.tuning && typeof m.tuning === "object" ? m.tuning : null,
        // Task 5: optional SSE-text fast path (default off).
        sseText: m.sse_text === true,
      };

      try {
        if (targetInfo.port) {
          targetInfo.port.postMessage(payload);
        } else {
          ext.tabs.sendMessage(targetTabId, payload).catch((err) => {
            state.pending.delete(id);
            updateAction();
            sendWs({
              t: "error",
              id,
              error: `Could not reach tab ${targetTabId} (${err.message}). Try refreshing the AI website page.`,
            });
          });
        }
      } catch (err) {
        state.pending.delete(id);
        updateAction();
        sendWs({ t: "error", id, error: String(err.message || err) });
      }
    }
  }

  // Handle port connections from content scripts (MV3 persistent channel)
  ext.runtime.onConnect.addListener((port) => {
    if (port.name === "noapi-tab") {
      // Only the top frame may own the tab's port; an iframe must not be able to
      // overwrite it (and claim to be the site). Firefox may omit frameId, in
      // which case only the top frame gets a port anyway.
      const frameId = port.sender?.frameId;
      if (frameId !== undefined && frameId !== 0) return;
      const tabId = port.sender?.tab?.id;
      if (tabId !== undefined) {
        const existing = state.tabs.get(tabId) || {};
        existing.port = port;
        state.tabs.set(tabId, existing);

        port.onMessage.addListener((msg) => {
          handleContentMessage(msg, tabId);
        });

        port.onDisconnect.addListener(() => {
          const info = state.tabs.get(tabId);
          if (info) info.port = null;
        });

        port.postMessage({
          type: "noapi_bridge_status",
          connected: isLive(),
        });
      }
    }
  });

  // Handle one-off messages
  ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Only the top frame may drive the tab; an iframe must not impersonate it.
    const frameId = sender?.frameId;
    if (frameId !== undefined && frameId !== 0) return;
    const tabId = sender?.tab?.id;
    handleContentMessage(msg, tabId, sendResponse);
    return true; // async
  });

  function handleContentMessage(msg, tabId, sendResponse) {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case "noapi_hello": {
        if (tabId !== undefined && msg.site) {
          const entry = state.tabs.get(tabId) || {};
          const changed = entry.site !== msg.site || entry.url !== msg.url;
          entry.site = msg.site;
          entry.url = msg.url;
          state.tabs.set(tabId, entry);

          if (state.connected && changed) {
            sendWs({ t: "hello-update", site: msg.site, url: msg.url });
          }
          log(`tab ${tabId} registered on ${msg.site}`);
        }
        sendResponse?.({ connected: isLive(), url: state.url });
        break;
      }

      case "noapi_status_req": {
        sendResponse?.({ connected: isLive(), url: state.url });
        break;
      }

      case "noapi_progress": {
        // A late-growth report can arrive with no request in flight (the
        // truncation canary fires ~1s after a turn ended), so forward it even
        // without an id and let the bridge count it per site.
        if (msg.id || Number(msg.lateGrowth) > 0) {
          sendWs({
            t: "progress",
            id: msg.id,
            status: msg.status,
            site: msg.site,
            lateGrowth: Number(msg.lateGrowth) || 0,
          });
        }
        sendResponse?.({ ok: true });
        break;
      }

      case "noapi_partial": {
        if (msg.id && typeof msg.text === "string") sendWs({ t: "partial", id: msg.id, text: msg.text });
        sendResponse?.({ ok: true });
        break;
      }

      case "noapi_reply": {
        if (msg.id) {
          state.pending.delete(msg.id);
          if (state.cancelling.has(msg.id)) {
            // The tab finished a cancelled request anyway; acknowledge the stop
            // instead of forwarding a reply the caller already gave up on.
            state.cancelling.delete(msg.id);
            sendWs({ t: "cancelled", id: msg.id });
            updateAction();
            break;
          }
          sendWs({ t: "response", id: msg.id, text: msg.text, timings: msg.timings || null });
          log(`replied to bridge for request ${msg.id}`);
          updateAction();
        }
        sendResponse?.({ ok: true });
        break;
      }

      case "noapi_error": {
        if (msg.id) {
          state.pending.delete(msg.id);
          if (state.cancelling.has(msg.id)) {
            state.cancelling.delete(msg.id);
            sendWs({ t: "cancelled", id: msg.id });
            log(`request ${msg.id} confirmed cancelled by the tab`);
            updateAction();
            break;
          }
          sendWs({ t: "error", id: msg.id, error: msg.error, code: msg.code });
          log(`error for request ${msg.id}: ${msg.error}`);
          updateAction();
        }
        sendResponse?.({ ok: true });
        break;
      }

      case "noapi_test_bridge": {
        forceReconnect().then((connected) => sendResponse?.({ connected }));
        break;
      }
    }
  }

  ext.tabs.onRemoved.addListener((tabId) => {
    const info = state.tabs.get(tabId);
    state.tabs.delete(tabId);
    // Any cancel this tab still owed: it can never arrive now.
    for (const [id, tid] of state.cancelling) {
      if (tid === tabId) {
        state.cancelling.delete(id);
        sendWs({ t: "cancelled", id });
      }
    }
    for (const [id, tid] of state.pending) {
      if (tid === tabId) {
        state.pending.delete(id);
        sendWs({ t: "error", id, error: "The AI site tab was closed by the user." });
      }
    }
    // If no tab serves that site any more, tell the bridge so it stops
    // advertising it.
    if (info?.site && ![...state.tabs.values()].some((t) => t.site === info.site)) {
      sendWs({ t: "site-gone", site: info.site });
    }
    updateAction();
  });

  try {
    ext.action?.onClicked?.addListener((tab) => {
      if (tab?.id !== undefined) {
        ext.tabs.sendMessage(tab.id, { type: "noapi_toggle_panel" }).catch(() => {});
      }
    });
  } catch {}

  function updateAction() {
    try {
      const n = state.pending.size;
      ext.action?.setBadgeText?.({ text: n ? String(n) : "" });
      ext.action?.setBadgeBackgroundColor?.({ color: "#f59e0b" });
      ext.action?.setTitle?.({
        title: isLive()
          ? "NOAPI? — Bridge Connected (127.0.0.1:8787)"
          : "NOAPI? — Bridge Offline (run: node bridge/index.js)",
      });
    } catch {}
  }

  (async function init() {
    try {
      const stored = await ext.storage.local.get(["noapi_url"]);
      if (stored.noapi_url) state.url = String(stored.noapi_url);
    } catch {}
    connect();
  })();
})();