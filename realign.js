// On a quality switch hls.js places the new playlist on the timeline using
// the first fragment of the previous quality with the same discontinuity
// count. When the new playlist starts in the middle of that run (a quality
// with fewer segments of a backup stream), that puts it whole segments off:
// playback jumped 20 s back, and 94 s once. The ad filter gives a moment the
// same sequence number in every quality, so this lines the new playlist up by
// sequence number instead, before hls.js picks the next fragment from it.
export function realignOnLevelSwitch(hls, Hls, log = () => {}) {
  let last = null;
  hls.on(Hls.Events.LEVEL_UPDATED, (_, { details, level }) => {
    const prev = last;
    last = { level, details };
    if (!prev || prev.level === level || !details.live || !details.fragments.length) return;
    const at = sn => details.fragments[sn - details.startSN];
    const known = f => f && Number.isFinite(f.start) && at(f.sn);
    let ref = hls.streamController?.currentFrag;
    if (!known(ref)) ref = [...prev.details.fragments].reverse().find(known);
    if (!ref) return;
    const delta = ref.start - at(ref.sn).start;
    if (Math.abs(delta) < 0.25) return;
    for (const f of details.fragments) {
      f.start += delta;
      if (Number.isFinite(f.startPTS)) f.startPTS += delta;
      if (Number.isFinite(f.endPTS)) f.endPTS += delta;
    }
    log('realign', { from: prev.level, to: level, sn: ref.sn, delta });
  });
}
