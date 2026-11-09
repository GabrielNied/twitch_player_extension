// Ad filtering for Twitch HLS media playlists.
//
// Twitch stitches ads directly into the live playlist (server-side). Ad
// segments are marked: their #EXTINF title is not "live" and there are
// "stitched-ad" DATERANGE tags.
//
// The player never gets Twitch's playlists as they are. The filter keeps one
// timeline shared by every quality: a list of slots, each one a moment of the
// broadcast (EXT-X-PROGRAM-DATE-TIME) with its own media sequence number,
// discontinuity count and the stream it comes from. The primary stream fills
// the timeline; only where it has ad segments does a backup stream (another
// player type, often served without ads) supply the same moments, and a
// moment no stream has is skipped with a discontinuity. Each quality's
// playlist is that timeline rendered with the segments of that quality, so a
// quality switch lands on the same content, sequence number and discontinuity
// count, and the timeline can't go back in time.
//
// Streams cut their segments at different moments (up to a segment apart),
// so changing stream repeats or skips up to about a second. That only
// happens at the edges of an ad break: while the primary stream is clean,
// backups are never used, even when an ad break is announced or a backup is
// ahead of it.
//
// Backup sessions are opened ahead of time: a new token usually starts with
// its own pre-roll, so a session opened only once the ad shows up is rarely
// clean in time.
import { fetchMaster, fetchText } from './api.js';

const BACKUP_PLAYER_TYPES = ['popout', 'autoplay', 'embed', 'picture-by-picture'];
const SESSION_MAX_AGE = 20 * 60 * 1000; // open a replacement backup session after this long
const BACKUP_COOLDOWN = 10 * 1000;      // min time between new tokens for the same player type
const DENIED_RETRY = 3 * 1000;          // ask again this soon after the shared budget refused a token
const WARM_INTERVAL = 30 * 1000;        // how often backup sessions are checked while there are no ads
const CONTIG_TOL = 250;                 // ms: next segment of the same stream, or same moment in another quality
const SWITCH_TOL = 1100;                // ms: how far from the cursor another stream's segment may start
const BACKUP_WAIT = 6000;               // ms to wait for a backup behind the cursor before skipping an ad
const CACHE_AGE = 3 * 60 * 1000;        // segments older than this are forgotten
const TIMELINE_MAX = 150;
const START_SEGMENTS = 3;               // segments the first playlist waits for
const MIN_WINDOW = 6;
const MAX_WINDOW = 60;
const AD_TAG = /stitched-ad|twitch-ad|X-TV-TWITCH-AD/i;
const PRIMARY = 'primary';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const segEnd = s => s.pdt + s.duration * 1000;
const clock = ms => new Date(ms).toISOString().slice(11, 23);

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

// Segment of `segs` starting closest to `t` (within `tol` ms) that still
// plays past `t`; on a tie the later one (skipping a little beats repeating).
function nearest(segs, t, tol) {
  let best = null;
  let bestDiff = Infinity;
  for (const s of segs) {
    if (segEnd(s) <= t + 100) continue;
    const diff = Math.abs(s.pdt - t);
    if (diff > tol) continue;
    if (diff < bestDiff - 100 || (diff <= bestDiff + 100 && best && s.pdt > best.pdt)) {
      best = s;
      bestDiff = Math.min(bestDiff, diff);
    }
  }
  return best;
}

export class AdFilter {
  // `canOpenSession(type, why)` resolves to false to refuse a new backup
  // token (a budget shared by every player); by default always allowed.
  constructor(login, variants, onStatus, log = () => {}, canOpenSession = async () => true) {
    this.login = login;
    this.canOpenSession = canOpenSession;
    this.variants = variants;
    this.byUrl = new Map(variants.map(v => [v.url, v]));
    this.onStatus = onStatus;
    this.log = log;
    // Shared timeline: [{ sn, cc, pdt, duration, source }], source being
    // PRIMARY or a backup session id.
    this.timeline = [];
    // Content segments seen, by `${source}|${quality}`: [{ pdt, duration, uri, map }]
    this.cache = new Map();
    this.outputs = new Map();   // variant url -> { version, target, text }
    this.sources = new Map();   // segment uri -> source, for diagnostics
    this.window = MIN_WINDOW;   // segments per playlist, follows the primary playlist
    this.wanted = null;         // variant the player is loading
    this.waitSince = 0;         // waiting for a lagging backup since
    this.skippedAt = 0;         // last time a moment was skipped
    // Backup sessions by player type. `pending` is a newer session still in
    // its own pre-roll; it replaces `current` once it played clean.
    // Session: { id, type, variants, at, wasClean, hadAds, failures }.
    this.backups = new Map(BACKUP_PLAYER_TYPES.map(type => [type, { current: null, pending: null, retryAt: 0 }]));
    this.sessions = new Map();  // session id -> session, also retired ones still in the timeline
    this.sessionSeq = 0;
    this.status = '';
    this.started = false;       // a playlist was handed to the player
    this.destroyed = false;
    this.warm();
    this.warmTimer = setInterval(() => this.warm(), WARM_INTERVAL);
  }

  sourceOf(uri) {
    return this.sources.get(uri);
  }

  destroy() {
    this.destroyed = true;
    clearInterval(this.warmTimer);
  }

  setStatus(status) {
    const key = JSON.stringify(status);
    if (key === this.status) return;
    this.log('ad-status', status);
    this.status = key;
    this.onStatus?.(status);
  }

  async process(url, raw) {
    const wanted = this.byUrl.get(url);
    if (wanted) this.wanted = wanted;
    let text = await this.update(url, raw);
    // Pre-roll with nothing to fall back on: hold the response until
    // content shows up. The first playlist waits for a few segments: one
    // starts playback at the very edge with no buffer, stalling every
    // segment.
    const enough = () => text && (this.started || (this.outputs.get(url)?.rows ?? Infinity) >= START_SEGMENTS);
    while (!enough()) {
      this.log('filter-hold', { q: wanted?.name, rows: this.outputs.get(url)?.rows });
      if (!text) this.setStatus({ mode: 'waiting' });
      await sleep(2000);
      if (this.destroyed) throw new Error('destroyed');
      text = await this.update(url, await fetchText(url));
    }
    this.started = true;
    return text;
  }

  // Used when processing failed: what the player already has, if anything.
  fallback(url, raw) {
    return this.outputs.get(url)?.text || stripAds(raw) || raw;
  }

  async update(url, raw) {
    const variant = this.byUrl.get(url);
    const quality = variant?.name || url;
    const primary = parseMedia(raw, url);
    if (primary.segments.length && primary.segments.every(s => s.pdt == null)) {
      // Can't place segments in time: strip ads the simple way.
      this.setStatus({ mode: hasAds(raw) ? 'strip' : 'clean' });
      return stripAds(raw);
    }

    const backups = hasAds(raw) ? await this.backupPlaylists(variant).catch(() => []) : [];
    if (this.destroyed) throw new Error('destroyed');

    this.store(PRIMARY, quality, primary);
    for (const b of backups) this.store(b.source, quality, b.playlist);
    this.window = Math.min(MAX_WINDOW, Math.max(this.window, primary.segments.length));

    const added = this.extend(primary.segments.filter(s => s.pdt != null), backups);
    await this.fillMissing(quality, variant);
    if (this.destroyed) throw new Error('destroyed');

    const out = this.outputs.get(url) || { version: 3, target: 0, text: null };
    this.outputs.set(url, out);
    out.version = Math.max(out.version, primary.version, ...backups.map(b => b.playlist.version));
    out.target = Math.max(out.target, primary.target, ...backups.map(b => b.playlist.target));
    const rows = this.rowsFor(quality);
    out.text = rows.length ? this.render(out, rows, primary.ended) : null;
    out.rows = rows.length;

    this.updateStatus(primary, backups);
    this.logUpdate(quality, primary, backups, added, rows);
    return out.text;
  }

  // Remembers the content segments of a playlist.
  store(source, quality, playlist) {
    const key = `${source}|${quality}`;
    const list = this.cache.get(key) || [];
    const last = list[list.length - 1];
    for (const s of playlist.segments) {
      if (s.ad || s.pdt == null) continue;
      if (last && s.pdt <= last.pdt + CONTIG_TOL) {
        // Already known (or older): refresh in place.
        const i = list.findIndex(x => Math.abs(x.pdt - s.pdt) <= CONTIG_TOL);
        if (i >= 0) list[i] = { pdt: s.pdt, duration: s.duration, uri: s.uri, map: s.map };
        continue;
      }
      list.push({ pdt: s.pdt, duration: s.duration, uri: s.uri, map: s.map });
    }
    const cutoff = Date.now() - CACHE_AGE;
    while (list.length && list[0].pdt < cutoff) list.shift();
    this.cache.set(key, list);
  }

  lookup(source, quality, pdt) {
    const list = this.cache.get(`${source}|${quality}`);
    if (!list) return null;
    for (let i = list.length - 1; i >= 0; i--) {
      if (Math.abs(list[i].pdt - pdt) <= CONTIG_TOL) return list[i];
      if (list[i].pdt < pdt - CONTIG_TOL) break;
    }
    return null;
  }

  // Adds the moments after the end of the timeline. The primary stream
  // supplies every moment it has without an ad; under its ads, backups
  // supply them (the one in use first); a moment nobody has is skipped.
  extend(primary, backups) {
    if (!primary.length) return [];
    const added = [];
    const backupSegs = backups.map(b => ({ source: b.source, segs: b.playlist.segments.filter(s => !s.ad && s.pdt != null) }));
    const primaryEnd = segEnd(primary[primary.length - 1]);
    const primaryTailAd = primary[primary.length - 1].ad;
    let tail = this.timeline[this.timeline.length - 1];
    let t = tail ? segEnd(tail) : this.startTime(primary, backupSegs);

    const push = (seg, source) => {
      const prev = tail;
      let sn;
      let cc;
      if (!prev) {
        sn = Math.floor(seg.pdt / 1000);
        cc = 0;
      } else {
        sn = prev.sn + 1;
        cc = prev.cc;
        const gapMs = seg.pdt - segEnd(prev);
        if (source !== prev.source || Math.abs(gapMs) > CONTIG_TOL) {
          cc++;
          this.log('filter-disc', { sn, cc, gapMs, from: prev.source, to: source });
        }
      }
      tail = { sn, cc, pdt: seg.pdt, duration: seg.duration, source };
      this.timeline.push(tail);
      added.push(tail);
      t = segEnd(tail);
    };

    for (let guard = 0; guard < 300; guard++) {
      const p = nearest(primary, t, tail && tail.source === PRIMARY ? CONTIG_TOL : SWITCH_TOL);
      if (p && !p.ad) {
        push(p, PRIMARY);
        this.waitSince = 0;
        continue;
      }
      // Primary has no content here: in an ad, or not there yet.
      const covering = primary.find(s => s.pdt <= t && segEnd(s) > t);
      const ahead = t >= primaryEnd - CONTIG_TOL; // primary hasn't got here yet
      const inAd = p ? p.ad : covering ? covering.ad : ahead && primaryTailAd;
      if (!inAd) {
        if (ahead) {
          // Already on a backup that is ahead of the primary stream: keep
          // going on it rather than stall until the primary catches up.
          const current = tail && tail.source !== PRIMARY && backupSegs.find(b => b.source === tail.source);
          const seg = current && nearest(current.segs, t, CONTIG_TOL);
          if (!seg) break;
          push(seg, current.source);
          continue;
        }
        // A hole in the primary stream itself: jump it.
        const next = primary.find(s => !s.ad && s.pdt > t);
        if (!next) break;
        this.log('filter-skip', { from: clock(t), to: clock(next.pdt), secs: (next.pdt - t) / 1000, hole: true });
        push(next, PRIMARY);
        continue;
      }

      const b = this.pickBackup(backupSegs, t, tail);
      if (b) {
        push(b.seg, b.source);
        this.waitSince = 0;
        continue;
      }
      // Nobody has this moment. Once the ad is over on the primary stream,
      // skip to its content, unless a backup just hasn't got here yet.
      const next = primary.find(s => !s.ad && s.pdt > t);
      if (!next) break;
      const lagging = backupSegs.some(({ segs }) => segs.length && segEnd(segs[segs.length - 1]) <= t + SWITCH_TOL);
      if (lagging) {
        if (!this.waitSince) this.waitSince = Date.now();
        if (Date.now() - this.waitSince < BACKUP_WAIT) break;
      }
      this.waitSince = 0;
      this.skippedAt = Date.now();
      this.log('filter-skip', { from: clock(t), to: clock(next.pdt), secs: (next.pdt - t) / 1000 });
      push(next, PRIMARY);
    }

    if (this.timeline.length > TIMELINE_MAX) this.timeline.splice(0, this.timeline.length - TIMELINE_MAX);
    return added;
  }

  // Where an empty timeline starts: the oldest primary content, or during a
  // pre-roll the oldest backup content.
  startTime(primary, backupSegs) {
    if (!primary[0].ad) return primary[0].pdt;
    const firstClean = primary.find(s => !s.ad);
    const fromBackups = backupSegs.flatMap(b => b.segs).map(s => s.pdt).filter(pdt => pdt >= primary[0].pdt - SWITCH_TOL);
    if (fromBackups.length) return Math.min(...fromBackups);
    return firstClean ? firstClean.pdt : primary[0].pdt;
  }

  // Backup segment for moment `t`: the backup in use first (it continues
  // without a seam), then the others in rank order.
  pickBackup(backupSegs, t, tail) {
    const current = backupSegs.find(b => b.source === tail?.source);
    if (current) {
      const seg = nearest(current.segs, t, CONTIG_TOL);
      if (seg) return { seg, source: current.source };
    }
    for (const b of backupSegs) {
      const seg = nearest(b.segs, t, SWITCH_TOL);
      if (seg) return { seg, source: b.source };
    }
    return null;
  }

  // Backup sessions in the timeline this quality has no segments of (a
  // quality switch, a session no longer polled): fetch them once.
  async fillMissing(quality, wanted) {
    const missing = new Set();
    for (const slot of this.timeline.slice(-this.window)) {
      if (slot.source !== PRIMARY && !this.lookup(slot.source, quality, slot.pdt)) missing.add(slot.source);
    }
    await Promise.all([...missing].map(async id => {
      const session = this.sessions.get(id);
      if (!session) return;
      const poll = await this.pollSession(session, wanted);
      if (poll) this.store(id, quality, poll.playlist);
    }));
  }

  // The newest slots this quality has segments for, as one contiguous run.
  rowsFor(quality) {
    const rows = [];
    for (let i = this.timeline.length - 1; i >= 0 && rows.length < this.window; i--) {
      const slot = this.timeline[i];
      const seg = this.lookup(slot.source, quality, slot.pdt);
      if (!seg) {
        if (rows.length) break;
        continue;
      }
      rows.unshift({ ...slot, duration: seg.duration, uri: seg.uri, map: seg.map });
      this.sources.set(seg.uri, slot.source);
    }
    while (this.sources.size > 1000) this.sources.delete(this.sources.keys().next().value);
    return rows;
  }

  updateStatus(primary, backups) {
    const tail = this.timeline[this.timeline.length - 1];
    const last = primary.segments[primary.segments.length - 1];
    if (tail && tail.source !== PRIMARY) {
      const b = backups.find(x => x.source === tail.source);
      this.setStatus({ mode: 'backup', type: this.sessions.get(tail.source)?.type, name: b?.name });
    } else if (last?.ad) {
      this.setStatus({ mode: 'waiting' });
    } else if (Date.now() - this.skippedAt < 30_000) {
      this.setStatus({ mode: 'strip' });
    } else {
      this.setStatus({ mode: 'clean' });
    }
  }

  logUpdate(quality, primary, backups, added, rows) {
    const segs = primary.segments;
    const primaryEnd = segs.length && segs[segs.length - 1].pdt != null ? segEnd(segs[segs.length - 1]) : null;
    const tail = this.timeline[this.timeline.length - 1];
    this.log('pl', {
      q: quality,
      n: segs.length,
      nAd: segs.filter(s => s.ad).length,
      // seconds between now and the end of the newest segment (negative: clock skew or bad PDT)
      edgeAge: primaryEnd != null ? (Date.now() - primaryEnd) / 1000 : null,
      bk: backups.map(b => {
        const bs = b.playlist.segments;
        return {
          src: b.source,
          clean: b.clean,
          n: bs.length,
          nAd: bs.filter(s => s.ad).length,
          // PDT of the newest backup segment relative to the primary's newest (s)
          skew: primaryEnd != null && bs.length ? (segEnd(bs[bs.length - 1]) - primaryEnd) / 1000 : null,
        };
      }),
      add: added.map(e => `${e.sn}/${e.cc}/${e.source}/${clock(e.pdt)}`),
      out: rows.length ? [rows[0].sn, rows[rows.length - 1].sn, rows[rows.length - 1].cc, rows.length] : null,
      // timeline slots not in this quality's playlist yet (newest end)
      behind: tail && rows.length ? tail.sn - rows[rows.length - 1].sn : undefined,
      st: this.status,
    });
  }

  render(out, rows, ended = false) {
    const target = Math.max(out.target, ...rows.map(e => Math.ceil(e.duration)));
    const lines = [
      '#EXTM3U',
      `#EXT-X-VERSION:${out.version}`,
      `#EXT-X-TARGETDURATION:${target}`,
      `#EXT-X-MEDIA-SEQUENCE:${rows[0].sn}`,
      `#EXT-X-DISCONTINUITY-SEQUENCE:${rows[0].cc}`,
    ];
    let map = null;
    rows.forEach((e, i) => {
      if (i > 0 && e.cc !== rows[i - 1].cc) lines.push('#EXT-X-DISCONTINUITY');
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
  // the backup in use, then BACKUP_PLAYER_TYPES order.
  async backupPlaylists(wanted) {
    const results = (await Promise.all(
      BACKUP_PLAYER_TYPES.map(type => this.pollType(type, wanted).catch(() => [])),
    )).flat();
    const inUse = this.timeline[this.timeline.length - 1]?.source;
    const rank = r => (r.clean ? 0 : 4) + (wanted && r.height === wanted.height ? 0 : 2) + (r.source === inUse ? 0 : 1);
    return results
      .filter(r => r.playlist.segments.some(s => !s.ad))
      .sort((a, b) => rank(a) - rank(b));
  }

  // Keeps backup sessions open and past their pre-roll before they are needed.
  warm() {
    if (this.destroyed) return;
    const wanted = this.wanted || pickVariant(this.variants, null);
    for (const type of BACKUP_PLAYER_TYPES) {
      this.pollType(type, wanted)
        .then(polls => polls.forEach(p => this.store(p.source, wanted.name, p.playlist)))
        .catch(() => {});
    }
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
      const why = !cur ? 'none' : cur.failures >= 3 ? 'failures' : cur.hadAds ? 'midroll' : 'age';
      // Tokens are shared with other players (tabs): ask before taking one.
      const allowed = await this.canOpenSession(type, why).catch(() => true);
      if (!allowed) {
        slot.retryAt = now + DENIED_RETRY;
        if (!slot.denied) this.log('backup-open-denied', { type, why });
        slot.denied = true;
      } else {
        slot.denied = false;
        try {
          const master = await fetchMaster(this.login, type);
          const id = `${type}#${++this.sessionSeq}`;
          slot.pending = { id, type, variants: master.variants, at: Date.now(), wasClean: false, hadAds: false, failures: 0 };
          this.sessions.set(id, slot.pending);
          this.log('backup-open', { id, why });
        } catch (err) {
          this.log('backup-open-fail', { type, msg: String(err?.message || err) });
          // keep the current session, if any
        }
      }
    }
    if (this.destroyed || !wanted) return [];

    const sessions = [slot.current, slot.pending].filter(Boolean);
    const polls = await Promise.all(sessions.map(s => this.pollSession(s, wanted)));
    if (slot.pending?.failures >= 3) slot.pending = null;
    if (slot.pending && (slot.pending.wasClean || !slot.current || slot.current.failures >= 3)) {
      this.log('backup-promote', { id: slot.pending.id, clean: slot.pending.wasClean });
      slot.current = slot.pending;
      slot.pending = null;
    }
    this.pruneSessions();
    return polls.filter(Boolean).map(p => ({ type, ...p }));
  }

  // Forgets retired sessions the timeline no longer uses.
  pruneSessions() {
    const live = new Set(this.timeline.map(s => s.source));
    for (const slot of this.backups.values()) {
      if (slot.current) live.add(slot.current.id);
      if (slot.pending) live.add(slot.pending.id);
    }
    for (const id of this.sessions.keys()) {
      if (live.has(id)) continue;
      this.sessions.delete(id);
      for (const key of this.cache.keys()) if (key.startsWith(`${id}|`)) this.cache.delete(key);
    }
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
    return { source: session.id, name: variant.name, height: variant.height, clean, playlist: parseMedia(text, variant.url) };
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
