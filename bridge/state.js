import { SITES, siteUrl } from "./sites.js";

const MAX_TIMING_RECORDS = 20;
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
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.clients = new Map(); // wsConn -> { site, url, joinedAt, lastSeen }
    this.pending = new Map(); // id -> record
    this.seq = 0;
    this.locks = new Map(); // site -> promise chain (one in-flight prompt per site)
    this.busy = new Map(); // site -> queued + running count
    this.toolHashes = new Map(); // site -> hash of the tool set the website chat already knows
    this.timings = []; // most recent completed requests, oldest first
    this.startedAt = Date.now();
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
    const available = new Set(
      [...this.clients.values()].map((c) => c.site).filter(Boolean)
    );
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
    };
  }

  // Where the time went: the most recent records, plus average and last value
  // per site. All values are milliseconds. "total" is measured by the bridge
  // (dispatch -> reply), the named stages come from the extension.
  timingsSummary() {
    const bySite = {};
    for (const site of new Set(this.timings.map((r) => r.site || "any"))) {
      const records = this.timings.filter((r) => (r.site || "any") === site);
      bySite[site] = { avg: averageTimings(records), last: records[records.length - 1] };
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

  _nextId() {
    this.seq += 1;
    return `req_${Date.now().toString(36)}_${this.seq}`;
  }

  // Requests for the same site are serialized: a website chat can only answer
  // one prompt at a time.
  async requestPrompt({ prompt, system, site, timeoutMs = 600_000, onProgress, signal, toolsEnabled = false }) {
    const key = site || "*";
    const prev = this.locks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((r) => (release = r));
    const tail = prev.then(() => gate);
    this.locks.set(key, tail);
    if (this.busy.get(key)) onProgress?.("Waiting for the previous request to finish");
    this.busy.set(key, (this.busy.get(key) || 0) + 1);
    try {
      await prev;
      if (signal?.aborted) throw new Error("Request cancelled.");
      return await this._dispatch({ prompt, system, site, timeoutMs, onProgress, signal, toolsEnabled });
    } finally {
      release();
      const left = (this.busy.get(key) || 1) - 1;
      if (left <= 0) {
        this.busy.delete(key);
        if (this.locks.get(key) === tail) this.locks.delete(key);
      } else this.busy.set(key, left);
    }
  }

  _dispatch({ prompt, system, site, timeoutMs, onProgress, signal, toolsEnabled = false }) {
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
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      };
      const record = {
        id,
        prompt,
        system: system || null,
        site: site || null,
        startedAt: Date.now(),
        onProgress,
        conns: targets.map(([conn]) => conn),
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
      });
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
        this.cancel(id);
        record.reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the website to answer.`));
      }, timeoutMs);
      if (signal) {
        onAbort = () => {
          this.cancel(id);
          record.reject(new Error("Request cancelled."));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      this.log(`request ${id} -> ${delivered} client(s) (site: ${record.site || "any"})`);
    });
  }

  // Tell the browser to stop generating / forget this request.
  cancel(id) {
    const record = this.pending.get(id);
    if (!record) return;
    const msg = JSON.stringify({ t: "cancel", id });
    for (const conn of record.conns || []) {
      try {
        conn.send(msg);
      } catch {}
    }
  }

  progress(id, status) {
    const record = this.pending.get(id);
    if (!record || !status) return;
    try {
      record.onProgress?.(String(status));
    } catch {}
  }

  respond(conn, id, text, timings) {
    const record = this.pending.get(id);
    if (!record) return;
    const clean = String(text ?? "").trim();
    if (!clean) {
      record.reject(new Error("The browser returned an empty response."));
      return;
    }
    this.recordTiming(record, timings);
    this.log(`response ${id} received (${clean.length} chars)`);
    record.resolve(clean);
  }

  // Keep the last few timing records and log a one-line summary per request.
  recordTiming(record, timings) {
    const entry = { id: record.id, site: record.site, at: Date.now(), total: Date.now() - record.startedAt };
    if (timings && typeof timings === "object") {
      for (const k of TIMING_STAGES) {
        if (Number.isFinite(Number(timings[k]))) entry[k] = Number(timings[k]);
      }
      if (timings.stopSeen) entry.stopSeen = true;
      if (timings.earlyReturn) entry.earlyReturn = true;
      if (Number.isFinite(Number(timings.idleMs))) entry.idleMs = Number(timings.idleMs);
    }
    this.timings.push(entry);
    if (this.timings.length > MAX_TIMING_RECORDS) this.timings.shift();
    const parts = TIMING_STAGES.filter((k) => entry[k] != null).map((k) => `${k}=${entry[k]}ms`);
    this.log(
      `timing ${record.site || "any"}: total=${entry.total}ms${parts.length ? " " + parts.join(" ") : ""}` +
        `${entry.stopSeen ? " stop=yes" : ""}${entry.earlyReturn ? " early-return=yes" : ""}`
    );
  }

  fail(conn, id, error) {
    const record = this.pending.get(id);
    if (!record) return;
    this.log(`request ${id} failed from browser: ${error}`);
    record.reject(new Error(String(error || "browser error")));
  }
}
