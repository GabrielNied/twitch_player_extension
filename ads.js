// Ad filtering for Twitch HLS media playlists.
//
// Twitch stitches ads directly into the live playlist (server-side). Ad
// segments are marked: their #EXTINF title is not "live" and there are
// "stitched-ad" DATERANGE tags. When the playlist we get contains ads:
//   1. try a backup stream requested with another player type, which is often
//      served without ads, and play that playlist instead;
//   2. otherwise strip the ad segments (the picture pauses during the break
//      and resumes at the live edge when the content comes back).
import { fetchMaster, fetchText } from './api.js';

const BACKUP_PLAYER_TYPES = ['popout', 'autoplay', 'embed', 'picture-by-picture'];
const BACKUP_TTL = 5 * 60 * 1000;
const BACKUP_COOLDOWN = 15 * 1000;
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

// Each switch between primary and backup streams is a discontinuity for the
// player (different encoder/resolution), so we bump the discontinuity sequence.
function withDiscontinuityOffset(text, offset) {
  if (!offset) return text;
  const { head, segments, tail } = splitPlaylist(text);
  const existing = head.findIndex(l => l.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:'));
  const base = existing >= 0 ? parseInt(head[existing].split(':')[1], 10) || 0 : 0;
  const tag = `#EXT-X-DISCONTINUITY-SEQUENCE:${base + offset}`;
  if (existing >= 0) head[existing] = tag;
  else head.splice(Math.max(1, head.findIndex(l => l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) + 1), 0, tag);
  return [...head, ...segments.flat(), ...tail].join('\n') + '\n';
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
    this.byUrl = new Map(variants.map(v => [v.url, v]));
    this.onStatus = onStatus;
    this.lastClean = new Map();   // variant url -> last ad-free primary playlist
    this.backup = null;           // { type, variants, at }
    this.backupRetryAt = 0;
    this.source = 'primary';
    this.switches = 0;
    this.status = 'clean';
    this.destroyed = false;
  }

  destroy() {
    this.destroyed = true;
  }

  setStatus(status) {
    const key = JSON.stringify(status);
    if (key === this.status) return;
    this.status = key;
    this.onStatus?.(status);
  }

  finalize(text, source) {
    if (source !== this.source) {
      this.source = source;
      this.switches++;
    }
    return withDiscontinuityOffset(text, this.switches);
  }

  async process(url, raw) {
    let result = await this.resolve(url, raw);
    if (!result) {
      const cached = this.lastClean.get(url);
      if (cached) {
        // Whole window is ads: hand back the previous playlist so the player
        // simply waits for new segments.
        this.setStatus({ mode: 'waiting' });
        return this.finalize(cached, 'primary');
      }
      // Pre-roll with nothing to fall back on: hold the response until
      // content shows up.
      this.setStatus({ mode: 'waiting' });
      while (!result) {
        await sleep(2000);
        if (this.destroyed) throw new Error('destroyed');
        result = await this.resolve(url, await fetchText(url));
      }
    }
    this.setStatus(result.status);
    return this.finalize(result.text, result.source);
  }

  async resolve(url, raw) {
    if (!hasAds(raw)) {
      this.lastClean.set(url, raw);
      return { text: raw, source: 'primary', status: { mode: 'clean' } };
    }
    const alt = await this.backupPlaylist(this.byUrl.get(url)).catch(() => null);
    if (alt) return { text: alt.text, source: alt.type, status: { mode: 'backup', type: alt.type, name: alt.name } };
    const stripped = stripAds(raw);
    if (stripped) return { text: stripped, source: 'primary', status: { mode: 'strip' } };
    return null;
  }

  async backupPlaylist(wanted) {
    if (this.backup && Date.now() - this.backup.at < BACKUP_TTL) {
      const text = await this.tryBackup(this.backup, wanted).catch(() => null);
      if (text) return text;
    }
    if (Date.now() < this.backupRetryAt) return null;

    for (const type of BACKUP_PLAYER_TYPES) {
      if (this.destroyed) return null;
      try {
        const master = await fetchMaster(this.login, type);
        const backup = { type, variants: master.variants, at: Date.now() };
        const text = await this.tryBackup(backup, wanted);
        if (text) {
          this.backup = backup;
          return text;
        }
      } catch {
        // try the next player type
      }
    }
    this.backup = null;
    this.backupRetryAt = Date.now() + BACKUP_COOLDOWN;
    return null;
  }

  async tryBackup(backup, wanted) {
    const variant = pickVariant(backup.variants, wanted);
    if (!variant) return null;
    const text = await fetchText(variant.url);
    return hasAds(text) ? null : { type: backup.type, name: variant.name, text };
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
                const stripped = stripAds(data);
                response.data = stripped || data;
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
