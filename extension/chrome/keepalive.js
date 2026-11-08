// NOAPI? Phase 3 - background side. Keeps the AI tabs usable while you work in
// other windows:
//   1. marks every AI tab as "never discard" (browser memory saver / sleeping tabs)
//   2. keeps the computer awake while an AI tab is open (set KEEP_AWAKE = false to skip)
//   3. wakes the background script every 30 s so it and the bridge connection stay alive
//
// Nothing here is required for the bridge to work and every call is guarded: a
// missing permission just disables that one feature.
//
// HOW TO ADD IT (see the notes that came with this file):
//   manifest.json  -> "permissions": add "power" and "alarms" (the "tabs" permission is
//                     NOT needed: host_permissions already cover every page we touch)
//   background.js  -> classic service worker / background script:  importScripts("keepalive.js");
//                     ES-module service worker ("type": "module"):  import "./keepalive.js";
//                     MV2 or Firefox "background.scripts": add "keepalive.js" to the list.
(() => {
  const KEEP_AWAKE = true;
  const api = typeof chrome !== "undefined" ? chrome : typeof browser !== "undefined" ? browser : null;
  if (!api) return;

  const guard = (fn) => {
    try {
      const r = fn();
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch {}
  };

  // The pages the content script runs on, taken from the manifest itself.
  const matches = (() => {
    try {
      const all = (api.runtime.getManifest().content_scripts || []).flatMap((c) => c.matches || []);
      return [...new Set(all)];
    } catch {
      return [];
    }
  })();
  if (!matches.length) return;

  let awake = false;
  function setAwake(on) {
    if (!KEEP_AWAKE || !api.power || on === awake) return;
    awake = on;
    guard(() => (on ? api.power.requestKeepAwake("system") : api.power.releaseKeepAwake()));
  }

  function pin(tab) {
    if (tab && tab.id != null && tab.autoDiscardable !== false && api.tabs?.update) {
      guard(() => api.tabs.update(tab.id, { autoDiscardable: false }));
    }
  }

  async function sweep() {
    try {
      const tabs = await api.tabs.query({ url: matches });
      tabs.forEach(pin);
      setAwake(tabs.length > 0);
    } catch {}
  }

  if (api.tabs) {
    api.tabs.onCreated?.addListener((tab) => {
      pin(tab);
      sweep();
    });
    api.tabs.onUpdated?.addListener((id, change, tab) => {
      if (change.status || change.url || change.discarded) {
        pin(tab);
        sweep();
      }
    });
    api.tabs.onRemoved?.addListener(() => sweep());
  }
  api.runtime.onStartup?.addListener(sweep);
  api.runtime.onInstalled?.addListener(sweep);

  // 30 s is the shortest period Chrome allows for an alarm; each firing wakes a
  // sleeping service worker and resets its idle timer.
  if (api.alarms) {
    guard(() => api.alarms.create("noapi-keepalive", { periodInMinutes: 0.5 }));
    api.alarms.onAlarm.addListener((a) => {
      if (a.name === "noapi-keepalive") sweep();
    });
  }

  sweep();
})();