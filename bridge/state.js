import { SITES, siteUrl } from "./sites.js";

// Recent per-request timings kept for /health and the A/B report. Keep at least
// 50 per site so a real-site A/B run has enough samples, with a hard total cap
// so memory cannot grow without bound (sites x 50, plus slack).
const MAX_TIMING_RECORDS_PER_SITE = 50;
const MAX_TIMING_RECORDS_TOTAL = 500;
// Keys that make up one timing record, in the order they happen. Kept here so
// the bridge log, /health and the dashboard all agree on the same stage names.
const TIMING_STAGES = ["composer", "typed", "sent", "firstText", "complete"];

function averageTimings(records) {
  const out = { count: records.length, total: 0 };
  for (const k of TIMING_STAGES) out[k] = 0;
  if (!records.length) return out;
  for (const r of records) {
    out.total += Number(r.total) || 0;
    for (const k of TIMING_STAGES) out[k] += Number(r[k]) || 0;
  }
  for (const k of [...TIMING_STAGES, "total"]) out[k] = Math.round(out[k] / records.length);
  return out;
}

export class Bridge {
  constructor({
    log = () => {},
    // How long to wait for the browser to confirm it stopped a cancelled
    // request before releasing the site queue anyway (and warning).
    cancelAckMs = 5000,
    // Give up retrying a request the tab kept answering "busy", after this long.
    busyGiveUpMs = 10_000,
    busyBaseMs = 100,
    busyMaxMs = 500,
  } = {}) {
    this.log = log;
    this.clients = new Map(); // wsConn -> { site, sites, url, joinedAt, lastSeen }
    this.pending = new Map(); // id -> record
    this.cancelling = new Map(); // id -> record cancelled but not yet acked by the tab
    this.seq = 0;
    this.locks = new Map(); // site -> promise chain (one in-flight prompt per site)
    this.busy = new Map(); // site -> queued + running count
    this.toolHashes = new Map(); // site -> hash of the tool set the website chat already knows
    this.chatUsage = new Map(); // site -> chars sent + received in the site's CURRENT chat (Phase 2 rotation)
    this.timings = []; // most recent completed requests, oldest first
    this.stats = new Map(); // site -> lifetime counters (debug; see statsSummary)
    this.startedAt = Date.now();
    this.cancelAckMs = cancelAckMs;
    this.busyGiveUpMs = busyGiveUpMs;
    this.busyBaseMs = busyBaseMs;
    this.busyMaxMs = busyMaxMs;
  }

  // Per-site lifetime counters. Cheap to keep and the only way to see, from
  // /health on a real site, whether the fast paths are actually used.
  statsFor(site) {
    const key = site || "any";
    let s = this.stats.get(key);
    if (!s) {
      s = {
        requests: 0,
        completedByStop: 0,
        completedByFallback: 0,
        completedBySse: 0,
        earlyReturn: 0,
        sseSeen: 0,
        resubmits: 0,
        aborted: 0,
        timeouts: 0,
        // Truncation canary: how many times the page grew the last reply after
        // the turn was already returned, and the total extra characters. Both
        // must stay 0 for the fast paths to be trustworthy.
        lateGrowth: 0,
        lateGrowthChars: 0,
      };
      this.stats.set(key, s);
    }
    return s;
  }

  statsSummary() {
    const out = {};
    for (const [site, s] of this.stats) out[site] = { ...s };
    return out;
  }

  register(conn, info) {
    // A browser uses ONE websocket for all tabs, so a single client can be
    // "on" several sites at once (one tab per site).
    const prev = this.clients.get(conn);
    const entry = prev || { sites: new Set(), site: null, url: null, joinedAt: Date.now() };
    if (info.site) entry.sites.add(info.site);
    if (info.site && entry.site !== info.site) {
      this.log(`client ${conn.id} now on site: ${info.site} (active: ${[...entry.sites].join(", ")})`);
    }
    entry.site = info.site || entry.site; // most recent site is primary
    if (info.url) entry.url = info.url;
    entry.lastSeen = Date.now();
    this.clients.set(conn, entry);
    if (!prev) this.log(`browser client ${conn.id} connected (site: ${info.site || "?"})`);
  }

  unregister(conn) {
    const info = this.clients.get(conn);
    if (info) this.log(`browser client ${conn.id} disconnected (was: ${info.site || "?"})`);
    this.clients.delete(conn);
    // A gone tab can never confirm a cancel: release any slot it was blocking.
    for (const id of [...this.cancelling.keys()]) {
      const record = this.cancelling.get(id);
      if ((record.conns || []).includes(conn)) this._ackCancelled(id);
    }
  }

  // The extension tells us a tab closed and no other tab of that site is left.
  // Drop the site from the socket that reported it so `sites()` stops offering it.
  removeSite(conn, site) {
    const info = this.clients.get(conn);
    if (!info || !site) return;
    info.sites?.delete(site);
    if (info.site === site) info.site = info.sites?.size ? [...info.sites][info.sites.size - 1] : null;
    this.log(`client ${conn.id} no longer on site: ${site}`);
  }

  touch(conn) {
    const c = this.clients.get(conn);
    if (c) c.lastSeen = Date.now();
  }

  listClients() {
    return [...this.clients.entries()].map(([conn, c]) => ({
      id: conn.id,
      site: c.site,
      url: c.url,
      connected: !conn.closed,
      lastSeen: c.lastSeen,
    }));
  }

  sites() {
    const available = new Set();
    for (const c of this.clients.values()) {
      if (c.site) available.add(c.site);
      if (c.sites) for (const s of c.sites) available.add(s);
    }
    return SITES.map((s) => ({ ...s, available: available.has(s.key) }));
  }

  status() {
    return {
      ok: true,
      name: "noapi-bridge",
      version: "0.1.0",
      startedAt: this.startedAt,
      clients: this.listClients(),
      pending: this.listPending(),
      sites: this.sites(),
      timings: this.timingsSummary(),
      stats: this.statsSummary(),
    };
  }

  // Where the time went: the most recent records, plus average and last value
  // per site. All values are milliseconds. "total" is measured by the bridge
  // (dispatch -> reply), the named stages come from the extension.
  timingsSummary() {
    const bySite = {};
    for (const site of new Set(this.timings.map((r) => r.site || "any"))) {
      const records = this.timings.filter((r) => (r.site || "any") === site);
      bySite[site] = { avg: averageTimings(records), last: records[records.length - 1], recent: records };
    }
    return {
      stages: TIMING_STAGES,
      count: this.timings.length,
      last: this.timings[this.timings.length - 1] || null,
      recent: this.timings.slice(-5),
      bySite,
    };
  }

  listPending() {
    return [...this.pending.values()].map((p) => ({
      id: p.id,
      site: p.site,
      chars: p.prompt.length,
      waitingMs: Date.now() - p.startedAt,
    }));
  }

  // True when a tab (or MCP proxy) for `site` is connected right now.
  _hasTarget(site) {
    return [...this.clients.entries()].some(([conn, c]) => !conn.closed && (!site || c.site === site || c.sites?.has(site)));
  }

  // The extension reconnects to a freshly started bridge with a delay (MV3
  // service worker backoff, alarms), so a request that arrives first is held
  // for up to NOAPI_CLIENT_WAIT_MS (default 15000, 0 = fail at once) instead
  // of failing with "No browser tab ... is connected".
  async _waitForClient({ site, signal, onProgress }) {
    const raw = Number(process.env.NOAPI_CLIENT_WAIT_MS);
    const ms = Number.isFinite(raw) && process.env.NOAPI_CLIENT_WAIT_MS !== "" ? Math.min(Math.max(raw, 0), 120_000) : 15_000;
    if (ms <= 0 || this._hasTarget(site)) return;
    onProgress?.(`Waiting for the browser extension to connect${site ? ` on ${site}` : ""}`);
    const until = Date.now() + ms;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 400));
      if (signal?.aborted) throw new Error("Request cancelled.");
      if (this._hasTarget(site)) return;
    }
  }

  _nextId() {
    this.seq += 1;
    return `req_${Date.now().toString(36)}_${this.seq}`;
  }

  // Requests for the same site are serialized: a website chat can only answer
  // one prompt at a time.
  async requestPrompt({
    prompt,
    system,
    site,
    timeoutMs = 600_000,
    onProgress,
    onPartial,
    signal,
    toolsEnabled = false,
    earlyReturn = true,
    earlyReturnMs = 400,
    toolNames = [],
    sse = true,
    newChat = false,
    tuning = null,
    sseText = false,
  }) {
    const key = site || "*";
    const prev = this.locks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((r) => (release = r));
    const tail = prev.then(() => gate);
    this.locks.set(key, tail);
    if (this.busy.get(key)) onProgress?.("Waiting for the previous request to finish");
    this.busy.set(key, (this.busy.get(key) || 0) + 1);

    // The site slot is this gate. Normally the finally below releases it. When a
    // request is cancelled we hand the release to the cancel path: it waits for
    // the tab's terminal message (or a safety timeout / socket close) so the
    // next request is not dispatched while the tab is still unwinding this one.
    const slot = { released: false, deferred: false };
    slot.release = () => {
      if (slot.released) return;
      slot.released = true;
      release();
      const left = (this.busy.get(key) || 1) - 1;
      if (left <= 0) {
        this.busy.delete(key);
        if (this.locks.get(key) === tail) this.locks.delete(key);
      } else this.busy.set(key, left);
    };

    try {
      await prev;
      if (signal?.aborted) throw new Error("Request cancelled.");
      await this._waitForClient({ site, signal, onProgress });
      return await this._dispatch({
        prompt,
        system,
        site,
        timeoutMs,
        onProgress,
        onPartial,
        signal,
        toolsEnabled,
        earlyReturn,
        earlyReturnMs,
        toolNames,
        sse,
        newChat,
        tuning,
        sseText,
        slot,
      });
    } finally {
      if (!slot.deferred) slot.release();
    }
  }

  _dispatch({
    prompt,
    system,
    site,
    timeoutMs,
    onProgress,
    onPartial,
    signal,
    toolsEnabled = false,
    earlyReturn = true,
    earlyReturnMs = 400,
    toolNames = [],
    sse = true,
    newChat = false,
    tuning = null,
    sseText = false,
    slot = null,
  }) {
    return new Promise((resolve, reject) => {
      const id = this._nextId();
      const targets = [...this.clients.entries()].filter(
        ([conn, c]) => !conn.closed && (!site || c.site === site || c.sites?.has(site))
      );
      if (!targets.length) {
        reject(
          new Error(
            site
              ? `No browser tab on "${site}" is connected. Open ${siteUrl(site)} with the NOAPI? extension active (and be logged in), then try again.`
              : "No browser tab with the NOAPI? extension is connected to the bridge."
          )
        );
        return;
      }
      let timer = null;
      let onAbort = null;
      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(retryTimer);
        retryTimer = null;
        if (record.ackTimer) {
          clearTimeout(record.ackTimer);
          record.ackTimer = null;
        }
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      };
      let retryTimer = null;
      const record = {
        id,
        prompt,
        system: system || null,
        site: site || null,
        startedAt: Date.now(),
        onProgress,
        onPartial,
        conns: targets.map(([conn]) => conn),
        payload: null,
        slot,
        ackTimer: null,
        retryTimer: null,
        busyAttempts: 0,
        busySince: 0,
        resolve: (text) => {
          if (this.pending.delete(id)) {
            cleanup();
            resolve(text);
          }
        },
        reject: (err) => {
          if (this.pending.delete(id)) {
            cleanup();
            reject(err);
          }
        },
      };
      this.pending.set(id, record);
      const payload = JSON.stringify({
        t: "request",
        id,
        prompt,
        system: record.system,
        site: record.site,
        timeout_ms: timeoutMs,
        tools_enabled: Boolean(toolsEnabled),
        // Read from the bridge's environment and passed down because a content
        // script cannot read process.env. See NOAPI_EARLY_RETURN* in http.js.
        early_return: Boolean(earlyReturn),
        early_return_ms: Number(earlyReturnMs) || 400,
        tool_names: Array.isArray(toolNames) ? toolNames : [],
        // Phase 3: NOAPI_SSE=0 disables the page-SSE completion signal.
        sse: Boolean(sse),
        // Phase 5: NOAPI_NEW_CHAT=1 asks the tab to open a fresh chat first.
        new_chat: Boolean(newChat),
        // Task 1: timing knobs read from the bridge environment and forwarded
        // because a content script cannot read process.env. Absent keys keep the
        // content script's shipped defaults.
        tuning: tuning && typeof tuning === "object" ? tuning : null,
        // Task 5: optional SSE-text fast path (default off).
        sse_text: Boolean(sseText),
      });
      record.payload = payload;
      let delivered = 0;
      for (const [conn] of targets) {
        try {
          conn.send(payload);
          delivered += 1;
        } catch {}
      }
      if (!delivered) {
        this.pending.delete(id);
        cleanup();
        reject(new Error("Could not deliver the prompt to any browser client."));
        return;
      }
      timer = setTimeout(() => {
        this._cancelRecord(record, "timeout", `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the website to answer.`);
      }, timeoutMs);
      if (signal) {
        onAbort = () => {
          this._cancelRecord(record, "abort", "Request cancelled.");
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      this.log(`request ${id} -> ${delivered} client(s) (site: ${record.site || "any"})`);
      this.statsFor(record.site).requests += 1;
    });
  }

  // Reject the caller now (OpenCode must see its cancellation fast) but keep the
  // site slot held until the browser confirms the tab stopped. A terminal message
  // for this id (response / error / cancelled), the socket closing, or a safety
  // timeout releases it. The record moves to `cancelling` so late messages are
  // recognised and ignored rather than mistaken for the next request.
  _cancelRecord(record, reason, message) {
    if (!this.pending.has(record.id)) return;
    const stats = this.statsFor(record.site);
    if (reason === "timeout") stats.timeouts += 1;
    else stats.aborted += 1;
    const msg = JSON.stringify({ t: "cancel", id: record.id });
    for (const conn of record.conns || []) {
      try {
        conn.send(msg);
      } catch {}
    }
    if (record.slot) record.slot.deferred = true;
    this.cancelling.set(record.id, record);
    record.reject(new Error(message));
    record.ackTimer = setTimeout(() => {
      if (!this.cancelling.has(record.id)) return;
      this.log(
        `warning: no cancel acknowledgement for ${record.id} after ${this.cancelAckMs}ms; releasing the site queue anyway`
      );
      this._ackCancelled(record.id);
    }, this.cancelAckMs);
  }

  // The tab confirmed it stopped (or we gave up waiting): release the site slot.
  _ackCancelled(id) {
    const record = this.cancelling.get(id);
    if (!record) return;
    this.cancelling.delete(id);
    if (record.ackTimer) {
      clearTimeout(record.ackTimer);
      record.ackTimer = null;
    }
    record.slot?.release();
  }

  ackCancelled(id) {
    this._ackCancelled(id);
  }

  // A busy rejection is retryable: the previous request is still unwinding, so
  // keep the slot and resend after a short backoff instead of surfacing the raw
  // "already handling a prompt" error to OpenCode.
  _retryBusy(record) {
    if (!this.pending.has(record.id)) return;
    if (!record.busySince) record.busySince = Date.now();
    const waited = Date.now() - record.busySince;
    if (waited >= this.busyGiveUpMs) {
      this.log(`request ${record.id} stayed busy for ${Math.round(waited / 1000)}s; giving up`);
      record.reject(
        new Error(`The browser tab stayed busy for ${Math.round(waited / 1000)}s and never freed up; gave up retrying.`)
      );
      return;
    }
    record.busyAttempts += 1;
    const delay = Math.min(this.busyMaxMs, this.busyBaseMs * record.busyAttempts);
    this.log(`request ${record.id} reported busy; retrying in ${delay}ms (attempt ${record.busyAttempts})`);
    clearTimeout(record.retryTimer);
    record.retryTimer = setTimeout(() => {
      record.retryTimer = null;
      if (!this.pending.has(record.id)) return;
      for (const conn of record.conns || []) {
        try {
          conn.send(record.payload);
        } catch {}
      }
    }, delay);
  }

  progress(id, status, { site = null, lateGrowth = 0 } = {}) {
    // The truncation canary may arrive with no request in flight (it fires ~1s
    // after a turn ended), so count it before the request lookup.
    const extra = Number(lateGrowth);
    if (Number.isFinite(extra) && extra > 0) this.lateGrowth(site, extra);
    if (!status) return;
    const record = this.pending.get(id);
    if (!record) return;
    try {
      record.onProgress?.(String(status));
    } catch {}
  }

  // Truncation canary: the page grew the last reply after the turn was already
  // returned. Any occurrence means a completion fast path may have cut a reply.
  lateGrowth(site, chars) {
    const stats = this.statsFor(site);
    stats.lateGrowth += 1;
    stats.lateGrowthChars += Math.max(0, Math.round(Number(chars) || 0));
    this.log(
      `warning: late reply growth after completion on ${site || "any"} (+${chars} chars) - a fast path may have truncated a reply`
    );
  }

  // Streaming text so far, from the browser. Advisory only: the final
  // `response` remains the source of truth (and may differ slightly, e.g. when
  // the site re-renders a message).
  partial(id, text) {
    const record = this.pending.get(id);
    if (!record || typeof text !== "string") return;
    try {
      record.onPartial?.(text);
    } catch {}
  }

  respond(conn, id, text, timings) {
    // A terminal message for a cancelled id: the tab may have finished anyway.
    // Release the slot it was holding, but never resolve the next request with
    // this answer and never record a timing for a reply the caller abandoned.
    if (this.cancelling.has(id)) {
      this.log(`late response for cancelled ${id} ignored`);
      this._ackCancelled(id);
      return;
    }
    const record = this.pending.get(id);
    if (!record) return;
    const clean = String(text ?? "").trim();
    if (!clean) {
      record.reject(new Error("The browser returned an empty response."));
      return;
    }
    this.recordTiming(record, timings, clean.length);
    this.log(`response ${id} received (${clean.length} chars)`);
    record.resolve(clean);
  }

  // Keep the last few timing records and log a one-line summary per request.
  recordTiming(record, timings, replyChars = null) {
    const entry = { id: record.id, site: record.site, at: Date.now(), total: Date.now() - record.startedAt };
    // Prompt / reply sizes make the A/B report able to tell a slow reply from a
    // big one, and postToken = the client overhead after the model's last token.
    const promptChars = String(record.prompt || "").length;
    if (promptChars) entry.promptChars = promptChars;
    if (Number.isFinite(Number(replyChars))) entry.replyChars = Number(replyChars);
    if (timings && typeof timings === "object") {
      for (const k of TIMING_STAGES) {
        if (Number.isFinite(Number(timings[k]))) entry[k] = Number(timings[k]);
      }
      if (timings.stopSeen) entry.stopSeen = true;
      if (timings.earlyReturn) entry.earlyReturn = true;
      if (timings.sseSeen) entry.sseSeen = true;
      if (timings.newChat) entry.newChat = true;
      if (Number.isFinite(Number(timings.idleMs))) entry.idleMs = Number(timings.idleMs);
      // When the model produced its last token, so the benchmark can separate
      // model time from the overhead the client adds after it.
      if (Number.isFinite(Number(timings.lastToken))) entry.lastToken = Number(timings.lastToken);
      // Client overhead after the model's final token: what every completion
      // fast path is chasing. Only meaningful when both stages were reported.
      if (Number.isFinite(Number(entry.lastToken)) && Number.isFinite(Number(entry.complete))) {
        entry.postToken = Math.max(0, Number(entry.complete) - Number(entry.lastToken));
      }
      if (timings.completedBy) entry.completedBy = String(timings.completedBy);
      if (Number.isFinite(Number(timings.resubmits))) entry.resubmits = Number(timings.resubmits);
    }
    this.timings.push(entry);
    // Trim the oldest record of THIS site once it has more than the per-site
    // cap, so every site keeps at least 50 recent requests; then enforce the
    // overall cap so a spray of site names cannot grow memory without bound.
    const siteKey = entry.site || "any";
    let mine = 0;
    for (const r of this.timings) if ((r.site || "any") === siteKey) mine++;
    if (mine > MAX_TIMING_RECORDS_PER_SITE) {
      const i = this.timings.findIndex((r) => (r.site || "any") === siteKey);
      if (i !== -1) this.timings.splice(i, 1);
    }
    if (this.timings.length > MAX_TIMING_RECORDS_TOTAL) this.timings.shift();
    const stats = this.statsFor(record.site);
    if (entry.completedBy === "stop-button") stats.completedByStop += 1;
    else if (entry.completedBy === "fallback-2200") stats.completedByFallback += 1;
    else if (entry.completedBy === "sse") stats.completedBySse += 1;
    if (entry.sseSeen) stats.sseSeen += 1;
    if (entry.earlyReturn) stats.earlyReturn += 1;
    if (Number.isFinite(Number(entry.resubmits))) stats.resubmits += Number(entry.resubmits);
    const parts = TIMING_STAGES.filter((k) => entry[k] != null).map((k) => `${k}=${entry[k]}ms`);
    this.log(
      `timing ${record.site || "any"}: total=${entry.total}ms${parts.length ? " " + parts.join(" ") : ""}` +
        `${entry.postToken != null ? ` post-token=${entry.postToken}ms` : ""}` +
        `${entry.promptChars != null ? ` prompt=${entry.promptChars}ch` : ""}` +
        `${entry.replyChars != null ? ` reply=${entry.replyChars}ch` : ""}` +
        `${entry.stopSeen ? " stop=yes" : ""}${entry.sseSeen ? " sse=yes" : ""}${entry.earlyReturn ? " early-return=yes" : ""}`
    );
  }

  fail(conn, id, error, code) {
    // A terminal message (including the tab's own "Cancelled.") for an id we
    // already cancelled: release the slot and stop there.
    if (this.cancelling.has(id)) {
      this.log(`late error for cancelled ${id} ignored`);
      this._ackCancelled(id);
      return;
    }
    const record = this.pending.get(id);
    if (!record) return;
    // A busy tab is a transient state (the previous request is still unwinding),
    // not a real failure: retry instead of surfacing it to OpenCode.
    if (code === "busy" || /already handling a prompt/i.test(String(error || ""))) {
      this._retryBusy(record);
      return;
    }
    this.log(`request ${id} failed from browser: ${error}`);
    record.reject(new Error(String(error || "browser error")));
  }
}