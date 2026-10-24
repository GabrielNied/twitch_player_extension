// Ad filtering for Twitch HLS media playlists.
//
// Twitch stitches ads directly into the live playlist (server-side). Ad
// segments are marked: their #EXTINF title is not "live" and there are
// "stitched-ad" DATERANGE tags.
//
// The player never gets Twitch's playlists as they are. For each quality the
// filter keeps its own playlist, made of content segments only, ordered by
// broadcast time (EXT-X-PROGRAM-DATE-TIME) and numbered with its own media
// sequence, which only grows. Ad segments of the primary stream are replaced
// by the same moments taken from backup streams (other player types, often
// served without ads); a moment no stream has is skipped with a
// discontinuity. Each session numbers its segments differently, so handing
// the player another session's playlist moved its timeline back and forth;
// here switching streams can't rewind it.
//
// Backup sessions are opened ahead of time: a new token usually starts with
// its own pre-roll, so a session opened only once the ad shows up is rarely
// clean in time.
import { fetchMaster, fetchText } from './api.js';

const BACKUP_PLAYER_TYPES = ['popout', 'autoplay', 'embed', 'picture-by-picture'];
const SESSION_MAX_AGE = 20 * 60 * 1000; // open a replacement backup session after this long
const BACKUP_COOLDOWN = 15 * 1000;      // min time between new tokens for the same player type
const WARM_INTERVAL = 30 * 1000;        // how often backup sessions are checked while there are no ads
const OUTPUT_IDLE = 30 * 1000;          // a quality not loaded for this long starts a new playlist
const GAP_TOLERANCE = 500;              // ms between segments that still count as contiguous
const MIN_WINDOW = 6;
const MAX_WINDOW = 60;
const AD_TAG = /stitched-ad|twitch-ad|X-TV-TWITCH-AD/i;

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function hasAds(text) {
  return AD_TAG.test(text) || /#EXTINF:[\d.]+,(?!live)/.test(text);
}

function isSegmentTag(line) {
  return /^#EXT(INF|-X-PROGRAM-DATE-TIME|-X-DATERANGE|-X-DISCONTINUITY:?$|-X-BYTERANGE)/.test(line);
}

function splitPlaylist(text) {
  const head = [];
  const segments = [];
  let current = [];
  let started = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.startsWith('#')) {
      current.push(line);
      segments.push(current);
      current = [];
      started = true;
    } else if (!started && !isSegmentTag(line)) {
      head.push(line);
    } else {
      current.push(line);
    }
  }
  return { head, segments, tail: current };
}

const isAdSegment = seg => seg.some(l => l.startsWith('#EXTINF') && !/,live\s*$/.test(l));

// Keeps only the first contiguous run of content segments. Leading ads are
// dropped by advancing EXT-X-MEDIA-SEQUENCE, so the remaining segments keep
// their real sequence numbers. Returns null if nothing but ads is left.
// Only used for playlists without PROGRAM-DATE-TIME and as error fallback.
export function stripAds(text) {
  const { head, segments } = splitPlaylist(text);
  const start = segments.findIndex(s => !isAdSegment(s));
  if (start < 0) return null;
  let end = segments.findIndex((s, i) => i > start && isAdSegment(s));
  if (end < 0) end = segments.length;

  const out = head
    .filter(l => !AD_TAG.test(l))
    .map(l => l.startsWith('#EXT-X-MEDIA-SEQUENCE:')
      ? `#EXT-X-MEDIA-SEQUENCE:${parseInt(l.split(':')[1], 10) + start}`
      : l);
  for (const seg of segments.slice(start, end)) out.push(...seg.filter(l => !AD_TAG.test(l)));
  return out.join('\n') + '\n';
}

const resolveUrl = (uri, base) => {
  try { return new URL(uri, base).href; } catch { return uri; }
};

// Parses a media playlist into its segments, each with its broadcast time in
// ms (`pdt`). A segment without its own PROGRAM-DATE-TIME continues from the
// previous one. URIs are made absolute: segments of a backup stream end up in
// a playlist the player loaded from another URL.
function parseMedia(text, baseUrl) {
  const out = { version: 3, target: 0, ended: false, segments: [] };
  let pending = {};
  let map = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.startsWith('#')) {
      if (pending.duration == null) continue;
      const prev = out.segments[out.segments.length - 1];
      const pdt = pending.pdt ?? (prev?.pdt != null ? prev.pdt + prev.duration * 1000 : null);
      out.segments.push({
        uri: resolveUrl(line, baseUrl),
        duration: pending.duration,
        pdt,
        map,
        ad: pending.title !== 'live',
      });
      pending = {};
    } else if (line.startsWith('#EXTINF:')) {
      const body = line.slice(8);
      const comma = body.indexOf(',');
      pending.duration = parseFloat(comma < 0 ? body : body.slice(0, comma)) || 0;
      pending.title = comma < 0 ? '' : body.slice(comma + 1).trim();
    } else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      const t = Date.parse(line.slice(25));
      if (!Number.isNaN(t)) pending.pdt = t;
    } else if (line.startsWith('#EXT-X-MAP:')) {
      map = line.replace(/URI="([^"]*)"/, (_, uri) => `URI="${resolveUrl(uri, baseUrl)}"`);
    } else if (line.startsWith('#EXT-X-VERSION:')) {
      out.version = parseInt(line.slice(15), 10) || 3;
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      out.target = parseInt(line.slice(22), 10) || 0;
    } else if (line === '#EXT-X-ENDLIST') {
      out.ended = true;
    }
  }
  return out;
}

function pickVariant(variants, wanted) {
  const video = variants.filter(v => v.height > 0);
  if (!wanted) return video[0] || variants[0];
  return variants.find(v => v.name === wanted.name)
    || video.find(v => v.height === wanted.height)
    || video.filter(v => v.height <= wanted.height).sort((a, b) => b.height - a.height)[0]
    || video[video.length - 1]
    || null;
}

export class AdFilter {
  constructor(login, variants, onStatus) {
    this.login = login;
    this.variants = variants;
    this.byUrl = new Map(variants.map(v => [v.url, v]));
    this.onStatus = onStatus;
    // Playlist handed to the player, by variant url:
    // { entries: [{ sn, cc, pdt, duration, uri, map, source }], version, target, used }
    this.outputs = new Map();
    this.recent = [];           // { pdt, sn } of the latest segments of every quality
    this.cc = 0;                // highest discontinuity count handed out
    this.window = MIN_WINDOW;   // segments per playlist, follows the primary playlist
    this.wanted = null;         // variant the player is loading
    this.lastBackup = null;     // backup player type used last
    // Backup sessions by player type. `pending` is a newer session still in
    // its own pre-roll; it replaces `current` once it played clean.
    // Session: { variants, at, wasClean, hadAds, failures }.
    this.backups = new Map(BACKUP_PLAYER_TYPES.map(type => [type, { current: null, pending: null, retryAt: 0 }]));
    this.status = '';
    this.destroyed = false;
    this.warm();
    this.warmTimer = setInterval(() => this.warm(), WARM_INTERVAL);
  }

  destroy() {
    this.destroyed = true;
    clearInterval(this.warmTimer);
  }

  setStatus(status) {
    const key = JSON.stringify(status);
    if (key === this.status) return;
    this.status = key;
    this.onStatus?.(status);
  }

  async process(url, raw) {
    const wanted = this.byUrl.get(url);
    if (wanted) this.wanted = wanted;
    let text = await this.update(url, raw);
    // Pre-roll with nothing to fall back on: hold the response until
    // content shows up.
    while (!text) {
      this.setStatus({ mode: 'waiting' });
      await sleep(2000);
      if (this.destroyed) throw new Error('destroyed');
      text = await this.update(url, await fetchText(url));
    }
    return text;
  }

  // Used when processing failed: what the player already has, if anything.
  fallback(url, raw) {
    const out = this.outputs.get(url);
    return out?.entries.length ? this.render(out) : stripAds(raw) || raw;
  }

  async update(url, raw) {
    const primary = parseMedia(raw, url);
    if (primary.segments.length && primary.segments.every(s => s.pdt == null)) {
      // Can't place segments in time: strip ads the simple way.
      this.setStatus({ mode: hasAds(raw) ? 'strip' : 'clean' });
      return stripAds(raw);
    }

    const ads = hasAds(raw);
    const backups = ads ? await this.backupPlaylists(this.byUrl.get(url)).catch(() => []) : [];
    if (this.destroyed) throw new Error('destroyed');

    const out = this.outputFor(url);
    this.window = Math.min(MAX_WINDOW, Math.max(this.window, primary.segments.length));
    const sources = [{ type: 'primary', playlist: primary }, ...backups];
    const added = this.append(out, sources);

    const fromBackup = added.filter(e => e.source !== 'primary').pop();
    if (fromBackup) this.lastBackup = fromBackup.source;
    const usable = fromBackup ? backups : backups.filter(b => b.clean);
    const backup = usable.find(b => b.type === (fromBackup?.source || this.lastBackup)) || usable[0];
    if (!ads) this.setStatus({ mode: 'clean' });
    else if (backup) this.setStatus({ mode: 'backup', type: backup.type, name: backup.name });
    else if (added.length) this.setStatus({ mode: 'strip' });
    else if (out.entries.length) this.setStatus({ mode: 'waiting' });

    if (!out.entries.length) return null;
    return this.render(out, primary.ended);
  }

  outputFor(url) {
    let out = this.outputs.get(url);
    if (!out || Date.now() - out.used > OUTPUT_IDLE) {
      out = { entries: [], version: 3, target: 0, used: 0 };
      this.outputs.set(url, out);
    }
    out.used = Date.now();
    return out;
  }

  // Adds the content segments newer than the end of `out`. For each moment the
  // first source that has it wins: primary, then backups in rank order.
  append(out, sources) {
    const last = out.entries[out.entries.length - 1];
    const after = last ? last.pdt + last.duration * 500 : -Infinity;
    const candidates = [];
    for (const { type, playlist } of sources) {
      out.version = Math.max(out.version, playlist.version);
      out.target = Math.max(out.target, playlist.target);
      for (const seg of playlist.segments) {
        if (seg.ad || seg.pdt == null || seg.pdt <= after) continue;
        if (candidates.some(c => Math.abs(c.pdt - seg.pdt) < c.duration * 500)) continue;
        candidates.push({ ...seg, source: type });
      }
    }
    candidates.sort((a, b) => a.pdt - b.pdt);

    const added = [];
    for (const seg of candidates) {
      const prev = out.entries[out.entries.length - 1];
      if (prev && seg.pdt < prev.pdt + prev.duration * 500) continue;
      let entry;
      if (!prev) {
        entry = { ...seg, sn: this.seedSn(seg.pdt), cc: this.cc };
      } else {
        const gap = seg.pdt - (prev.pdt + prev.duration * 1000) > GAP_TOLERANCE;
        const cc = gap || seg.source !== prev.source ? prev.cc + 1 : prev.cc;
        entry = { ...seg, sn: prev.sn + 1, cc };
      }
      this.cc = Math.max(this.cc, entry.cc);
      out.entries.push(entry);
      added.push(entry);
      this.recent.push({ pdt: entry.pdt, sn: entry.sn });
    }
    if (out.entries.length > this.window) out.entries.splice(0, out.entries.length - this.window);
    if (this.recent.length > 300) this.recent.splice(0, this.recent.length - 300);
    return added;
  }

  // Same moment, same sequence number in every quality: keeps quality
  // switches and the replay buffer aligned. The very first one comes from the
  // broadcast time, so numbers keep growing across player restarts.
  seedSn(pdt) {
    const match = this.recent.find(r => Math.abs(r.pdt - pdt) < 1000);
    if (match) return match.sn;
    const last = this.recent[this.recent.length - 1];
    if (!last) return Math.floor(pdt / 1000);
    const sn = last.sn + Math.round((pdt - last.pdt) / 2000);
    return pdt > last.pdt ? Math.max(last.sn + 1, sn) : sn;
  }

  render(out, ended = false) {
    const { entries } = out;
    const target = Math.max(out.target, ...entries.map(e => Math.ceil(e.duration)));
    const lines = [
      '#EXTM3U',
      `#EXT-X-VERSION:${out.version}`,
      `#EXT-X-TARGETDURATION:${target}`,
      `#EXT-X-MEDIA-SEQUENCE:${entries[0].sn}`,
      `#EXT-X-DISCONTINUITY-SEQUENCE:${entries[0].cc}`,
    ];
    let map = null;
    entries.forEach((e, i) => {
      if (i > 0 && e.cc !== entries[i - 1].cc) lines.push('#EXT-X-DISCONTINUITY');
      if (e.map && e.map !== map) lines.push(e.map);
      map = e.map;
      lines.push(
        `#EXT-X-PROGRAM-DATE-TIME:${new Date(e.pdt).toISOString()}`,
        `#EXTINF:${e.duration.toFixed(3)},live`,
        e.uri,
      );
    });
    if (ended) lines.push('#EXT-X-ENDLIST');
    return lines.join('\n') + '\n';
  }

  // Polls every backup player type in parallel. Returns the playlists that
  // have some content, best first: no ads at all, same quality as wanted,
  // the backup used last, then BACKUP_PLAYER_TYPES order.
  async backupPlaylists(wanted) {
    const results = (await Promise.all(
      BACKUP_PLAYER_TYPES.map(type => this.pollType(type, wanted).catch(() => [])),
    )).flat();
    const rank = r => (r.clean ? 0 : 4) + (wanted && r.height === wanted.height ? 0 : 2) + (r.type === this.lastBackup ? 0 : 1);
    return results
      .filter(r => r.playlist.segments.some(s => !s.ad))
      .sort((a, b) => rank(a) - rank(b));
  }

  // Keeps backup sessions open and past their pre-roll before they are needed.
  warm() {
    if (this.destroyed) return;
    const wanted = this.wanted || pickVariant(this.variants, null);
    for (const type of BACKUP_PLAYER_TYPES) this.pollType(type, wanted).catch(() => {});
  }

  async pollType(type, wanted) {
    const slot = this.backups.get(type);
    const now = Date.now();
    const cur = slot.current;
    // A session that was clean and now has ads is in a mid-roll, which can be
    // long: a fresh token may skip it. The current session stays in use
    // until the new one is out of its own pre-roll.
    const needNew = !cur || cur.failures >= 3 || cur.hadAds || now - cur.at > SESSION_MAX_AGE;
    if (needNew && !slot.pending && now >= slot.retryAt) {
      slot.retryAt = now + BACKUP_COOLDOWN;
      try {
        const master = await fetchMaster(this.login, type);
        slot.pending = { variants: master.variants, at: Date.now(), wasClean: false, hadAds: false, failures: 0 };
      } catch {
        // keep the current session, if any
      }
    }
    if (this.destroyed || !wanted) return [];

    const sessions = [slot.current, slot.pending].filter(Boolean);
    const polls = await Promise.all(sessions.map(s => this.pollSession(s, wanted)));
    if (slot.pending?.failures >= 3) slot.pending = null;
    if (slot.pending && (slot.pending.wasClean || !slot.current || slot.current.failures >= 3)) {
      slot.current = slot.pending;
      slot.pending = null;
    }
    return polls.filter(Boolean).map(p => ({ type, ...p }));
  }

  async pollSession(session, wanted) {
    const variant = pickVariant(session.variants, wanted);
    if (!variant) return null;
    let text;
    try {
      text = await fetchText(variant.url);
    } catch {
      session.failures++;
      return null;
    }
    session.failures = 0;
    const clean = !hasAds(text);
    if (clean) {
      session.wasClean = true;
      session.hadAds = false;
    } else if (session.wasClean) {
      session.hadAds = true;
    }
    return { name: variant.name, height: variant.height, clean, playlist: parseMedia(text, variant.url) };
  }

  // hls.js playlist loader that runs every media playlist through the filter.
  loaderFor(Hls) {
    const filter = this;
    return class FilteredLoader extends Hls.DefaultConfig.loader {
      load(context, config, callbacks) {
        const id = this._loadId = (this._loadId || 0) + 1;
        const onSuccess = callbacks.onSuccess;
        const wrapped = {
          ...callbacks,
          onSuccess: (response, stats, ctx, details) => {
            const data = response.data;
            if (typeof data !== 'string' || !data.includes('#EXTINF')) {
              onSuccess(response, stats, ctx, details);
              return;
            }
            filter.process(ctx.url, data).then(
              text => {
                if (id !== this._loadId || filter.destroyed) return;
                response.data = text;
                onSuccess(response, stats, ctx, details);
              },
              err => {
                if (id !== this._loadId || filter.destroyed) return;
                console.warn('[ATP] filter error', err);
                response.data = filter.fallback(ctx.url, data);
                onSuccess(response, stats, ctx, details);
              },
            );
          },
        };
        super.load(context, config, wrapped);
      }

      abort() {
        this._loadId = (this._loadId || 0) + 1;
        super.abort();
      }

      destroy() {
        this._loadId = (this._loadId || 0) + 1;
        super.destroy();
      }
    };
  }
}
