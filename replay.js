// Keeps a copy of the downloaded video segments so the last minutes can be
// saved to a file ("Salvar replay"), and records everything between start and
// stop ("Gravar"). Segments are saved as-is: no re-encoding, original quality.
export class ReplayBuffer {
  constructor(maxSeconds = 120) {
    this.maxSeconds = maxSeconds;
    this.entries = [];          // { sn, init, duration, bytes }
    this.inits = new Map();     // init segment url -> ArrayBuffer
    this.recording = null;      // { entries, startedAt }
  }

  // hls.js fragment loader that copies every segment before playback uses it.
  loaderFor(Hls) {
    const replay = this;
    return class ReplayLoader extends Hls.DefaultConfig.loader {
      load(context, config, callbacks) {
        const onSuccess = callbacks.onSuccess;
        super.load(context, config, {
          ...callbacks,
          onSuccess: (response, stats, ctx, details) => {
            try {
              replay.add(ctx.frag, response.data);
            } catch (err) {
              console.warn('[ATP] replay', err);
            }
            onSuccess(response, stats, ctx, details);
          },
        });
      }
    };
  }

  add(frag, data) {
    if (!frag || !(data instanceof ArrayBuffer)) return;
    const bytes = data.slice(0);
    if (frag.sn === 'initSegment') {
      this.inits.set(frag.url, bytes);
      return;
    }
    const entry = { sn: frag.sn, init: frag.initSegment?.url || null, duration: frag.duration || 2, bytes };

    // The same segment can be loaded twice (quality switch, retry): keep the latest.
    const existing = this.entries.findIndex(e => e.sn === entry.sn && this.sameInit(e.init, entry.init));
    if (existing >= 0) this.entries[existing] = entry;
    else this.entries.push(entry);

    let total = this.entries.reduce((s, e) => s + e.duration, 0);
    while (this.entries.length > 1 && total - this.entries[0].duration >= this.maxSeconds) {
      total -= this.entries.shift().duration;
    }

    if (this.recording) {
      const list = this.recording.entries;
      const i = list.findIndex(e => e.sn === entry.sn && this.sameInit(e.init, entry.init));
      if (i >= 0) list[i] = entry;
      else list.push(entry);
    }
  }

  get availableSeconds() {
    return this.entries.reduce((s, e) => s + e.duration, 0);
  }

  last(seconds) {
    let total = 0;
    let i = this.entries.length;
    while (i > 0 && total < seconds) total += this.entries[--i].duration;
    return this.entries.slice(i);
  }

  startRecording() {
    this.recording = { entries: [], startedAt: Date.now() };
  }

  stopRecording() {
    const entries = this.recording?.entries || [];
    this.recording = null;
    return entries;
  }

  get recordingInfo() {
    if (!this.recording) return null;
    const { entries, startedAt } = this.recording;
    return {
      elapsed: (Date.now() - startedAt) / 1000,
      bytes: entries.reduce((s, e) => s + e.bytes.byteLength, 0),
    };
  }

  // Init segment URLs are signed and may change between playlist refreshes
  // while the content stays the same, so compare the bytes when we have them.
  sameInit(a, b) {
    if (a === b) return true;
    const x = this.inits.get(a);
    const y = this.inits.get(b);
    if (!x || !y || x.byteLength !== y.byteLength) return false;
    const u = new Uint8Array(x);
    const v = new Uint8Array(y);
    for (let i = 0; i < u.length; i++) if (u[i] !== v[i]) return false;
    return true;
  }

  async getInit(url) {
    let bytes = this.inits.get(url);
    if (!bytes) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`init HTTP ${res.status}`);
      bytes = await res.arrayBuffer();
      this.inits.set(url, bytes);
    }
    return bytes;
  }

  // Builds playable files from a list of segments. fMP4 segments become .mp4
  // (init + fragments), MPEG-TS segments become .ts. A change of init segment
  // (quality switch, backup stream) starts a new file.
  async buildFiles(entries) {
    const runs = [];
    for (const e of entries) {
      if (e.init) await this.getInit(e.init).catch(() => {});
      const last = runs[runs.length - 1];
      if (last && this.sameInit(last.init, e.init)) last.items.push(e);
      else runs.push({ init: e.init, items: [e] });
    }
    const files = [];
    for (const run of runs) {
      const parts = [];
      if (run.init) {
        const init = await this.getInit(run.init);
        parts.push(init);
        parts.push(...rebaseFragments(init, run.items.map(e => e.bytes)));
      } else {
        for (const e of run.items) parts.push(e.bytes);
      }
      files.push({
        blob: new Blob(parts, { type: run.init ? 'video/mp4' : 'video/mp2t' }),
        ext: run.init ? 'mp4' : 'ts',
        seconds: run.items.reduce((s, e) => s + e.duration, 0),
      });
    }
    return files;
  }
}

/* ---------- fMP4 timestamp rebasing ---------- */
// Live segments carry timestamps counted from the start of the broadcast, so a
// saved replay would claim to be hours long. Shift every track so the file
// starts at 0, keeping the audio/video offset between tracks.

function* boxes(view, start, end) {
  let p = start;
  while (p + 8 <= end) {
    let size = view.getUint32(p);
    const type = String.fromCharCode(view.getUint8(p + 4), view.getUint8(p + 5), view.getUint8(p + 6), view.getUint8(p + 7));
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(p + 8));
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header || p + size > end) return;
    yield { type, body: p + header, end: p + size };
    p += size;
  }
}

function child(view, box, type) {
  for (const b of boxes(view, box.body, box.end)) if (b.type === type) return b;
  return null;
}

// track id -> timescale, from the init segment (moov/trak/{tkhd, mdia/mdhd}).
function timescales(init) {
  const view = new DataView(init);
  const out = new Map();
  for (const moov of boxes(view, 0, init.byteLength)) {
    if (moov.type !== 'moov') continue;
    for (const trak of boxes(view, moov.body, moov.end)) {
      if (trak.type !== 'trak') continue;
      const tkhd = child(view, trak, 'tkhd');
      const mdia = child(view, trak, 'mdia');
      const mdhd = mdia && child(view, mdia, 'mdhd');
      if (!tkhd || !mdhd) continue;
      const id = view.getUint32(tkhd.body + (view.getUint8(tkhd.body) === 1 ? 20 : 12));
      const scale = view.getUint32(mdhd.body + (view.getUint8(mdhd.body) === 1 ? 20 : 12));
      out.set(id, scale);
    }
  }
  return out;
}

// Positions of every tfdt (baseMediaDecodeTime) in a fragment.
function tfdts(view) {
  const out = [];
  for (const moof of boxes(view, 0, view.byteLength)) {
    if (moof.type !== 'moof') continue;
    for (const traf of boxes(view, moof.body, moof.end)) {
      if (traf.type !== 'traf') continue;
      const tfhd = child(view, traf, 'tfhd');
      const tfdt = child(view, traf, 'tfdt');
      if (!tfhd || !tfdt) continue;
      out.push({ trackId: view.getUint32(tfhd.body + 4), pos: tfdt.body + 4, wide: view.getUint8(tfdt.body) === 1 });
    }
  }
  return out;
}

const readTime = (view, t) => (t.wide ? view.getBigUint64(t.pos) : BigInt(view.getUint32(t.pos)));

function rebaseFragments(init, fragments) {
  try {
    const scales = timescales(init);
    const copies = fragments.map(f => f.slice(0));
    const views = copies.map(b => new DataView(b));

    // Earliest start in seconds across tracks.
    const first = new Map();
    views.forEach(view => {
      for (const t of tfdts(view)) if (!first.has(t.trackId)) first.set(t.trackId, readTime(view, t));
    });
    let startSeconds = Infinity;
    for (const [id, time] of first) {
      const scale = scales.get(id);
      if (scale) startSeconds = Math.min(startSeconds, Number(time) / scale);
    }
    if (!Number.isFinite(startSeconds)) return fragments;

    views.forEach(view => {
      for (const t of tfdts(view)) {
        const scale = scales.get(t.trackId);
        if (!scale) continue;
        const shift = BigInt(Math.floor(startSeconds * scale));
        let value = readTime(view, t) - shift;
        if (value < 0n) value = 0n;
        if (t.wide) view.setBigUint64(t.pos, value);
        else view.setUint32(t.pos, Number(value));
      }
    });
    return copies;
  } catch (err) {
    console.warn('[ATP] rebase failed', err);
    return fragments;
  }
}
