// Third-party chat emotes (7TV, BetterTTV, FrankerFaceZ): word -> image URL.

let globalEmotes = null;

async function json(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const sevenTv = emotes => (emotes || [])
  .filter(e => e.data?.host)
  .map(e => [e.name, `https:${e.data.host.url}/1x.webp`]);

const bttv = emotes => (emotes || []).map(e => [e.code, `https://cdn.betterttv.net/emote/${e.id}/1x.webp`]);

const ffz = sets => Object.values(sets || {})
  .flatMap(set => set?.emoticons || [])
  .map(e => [e.name, (e.animated || e.urls)['1']]);

// Each source fails on its own: a channel without 7TV still gets BTTV and FFZ.
async function collect(sources) {
  const lists = await Promise.all(sources.map(source => source.catch(() => [])));
  return new Map(lists.flat());
}

function loadGlobal() {
  globalEmotes = globalEmotes || collect([
    json('https://7tv.io/v3/emote-sets/global').then(d => sevenTv(d.emotes)),
    json('https://api.betterttv.net/3/cached/emotes/global').then(bttv),
    json('https://api.frankerfacez.com/v1/set/global')
      .then(d => ffz(Object.fromEntries((d.default_sets || []).map(id => [id, d.sets[id]])))),
  ]);
  return globalEmotes;
}

export async function loadEmotes(roomId) {
  const [global, channel] = await Promise.all([
    loadGlobal(),
    collect([
      json(`https://7tv.io/v3/users/twitch/${roomId}`).then(d => sevenTv(d.emote_set?.emotes)),
      json(`https://api.betterttv.net/3/cached/users/twitch/${roomId}`)
        .then(d => bttv([...(d.channelEmotes || []), ...(d.sharedEmotes || [])])),
      json(`https://api.frankerfacez.com/v1/room/id/${roomId}`).then(d => ffz(d.sets)),
    ]),
  ]);
  return new Map([...global, ...channel]);
}
