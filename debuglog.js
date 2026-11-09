// Diagnostic log of the player: an in-memory ring buffer of events and
// periodic snapshots, downloadable with Shift+D (or the settings menu).
// Streaming it live to tools/log-server.mjs is off unless turned on from the
// player page's console: chrome.storage.local.set({ debugLive: true }) (the
// extension also needs host permission for http://127.0.0.1:7777/*).
const MAX_ENTRIES = 40000;   // in memory, this page load
const LIVE_URL = 'http://127.0.0.1:7777/log';
const LIVE_RETRY = 30_000;

const session = Math.random().toString(36).slice(2, 8);
const entries = [];
let pending = [];    // not yet sent to the live collector
let live = false;
let liveEnabled = false;
let retryAt = 0;

const round = v => {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) / 100 : String(v);
  if (Array.isArray(v)) return v.map(round);
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const o = {};
    for (const k in v) if (v[k] !== undefined) o[k] = round(v[k]);
    return o;
  }
  return v;
};

export function log(ev, data = {}) {
  const e = { t: Date.now(), s: session, ev, ...round(data) };
  entries.push(e);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  if (liveEnabled) pending.push(e);
  if (pending.length > 5000) pending.splice(0, pending.length - 5000);
}

async function flushLive() {
  if (!pending.length || (!live && Date.now() < retryAt)) return;
  const batch = pending;
  pending = [];
  try {
    const res = await fetch(LIVE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: batch.map(e => JSON.stringify(e)).join('\n') + '\n',
    });
    if (!res.ok) throw new Error(res.status);
    live = true;
  } catch {
    live = false;
    retryAt = Date.now() + LIVE_RETRY;
    pending = batch.concat(pending).slice(-5000);
  }
}

export function downloadLog(meta = {}) {
  const head = { ev: 'meta', t: Date.now(), s: session, ua: navigator.userAgent, ...meta };
  const lines = [head, ...entries].map(e => JSON.stringify(e));
  const blob = new Blob([lines.join('\n') + '\n'], { type: 'application/x-ndjson' });
  const a = document.createElement('a');
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  a.href = URL.createObjectURL(blob);
  a.download = `atp-log_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.ndjson`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

export function initLog(meta = {}) {
  for (const level of ['warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      log(`console.${level}`, { msg: args.map(a => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'object' ? safeJson(a) : String(a))).join(' ') });
      orig(...args);
    };
  }
  addEventListener('error', e => log('js-error', { msg: e.message, at: `${e.filename}:${e.lineno}:${e.colno}`, stack: e.error?.stack }));
  addEventListener('unhandledrejection', e => log('rejection', { msg: String(e.reason?.stack || e.reason) }));
  addEventListener('pagehide', () => log('pagehide'));
  log('session', { url: location.href, version: chrome.runtime.getManifest().version, ...meta });
  chrome.storage.local.get('debugLive').then(r => {
    if (!r.debugLive) return;
    liveEnabled = true;
    setInterval(flushLive, 1000);
  }).catch(() => {});
}

function safeJson(v) {
  try { return JSON.stringify(v).slice(0, 500); } catch { return String(v); }
}
