// Twitch API helpers: GQL, playback access tokens and usher playlists.
const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const DEVICE_ID = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');

export const PRIMARY_PLAYER_TYPE = 'site';

// Paths on twitch.tv that look like /<name> but are not channels.
const RESERVED = new Set([
  'directory', 'videos', 'settings', 'subscriptions', 'inventory', 'wallet', 'drops',
  'search', 'downloads', 'jobs', 'p', 'turbo', 'prime', 'friends', 'messages', 'popout',
  'embed', 'moderator', 'u', 'store', 'broadcast', 'following', 'payments', 'team',
  'collections', 'login', 'signup', 'logout', 'creatorcamp', 'bits', 'privacy', 'legal',
  'activate', 'annual-recap', 'recaps', 'event', 'products', 'redeem', 'security',
]);

export function channelFromUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.hostname !== 'www.twitch.tv' && u.hostname !== 'm.twitch.tv') return null;
  const m = u.pathname.match(/^\/([a-zA-Z0-9_]{2,25})\/?$/);
  if (!m) return null;
  const login = m[1].toLowerCase();
  return RESERVED.has(login) ? null : login;
}

export function twitchUrl(login, skipRedirect = false) {
  return `https://www.twitch.tv/${login}${skipRedirect ? '?atp-skip=1' : ''}`;
}

async function gql(query, variables) {
  const res = await fetch('https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: {
      'Client-ID': CLIENT_ID,
      'X-Device-Id': DEVICE_ID,
      'Content-Type': 'text/plain;charset=UTF-8',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GQL HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data;
}

export async function getStreamInfo(login) {
  const data = await gql(`query StreamInfo($login: String!) {
    user(login: $login) {
      login
      displayName
      profileImageURL(width: 70)
      broadcastSettings { title game { displayName } }
      stream { id type viewersCount createdAt }
    }
  }`, { login });
  return data.user;
}

export async function getAccessToken(login, playerType) {
  const data = await gql(`query PlaybackAccessToken($login: String!, $playerType: String!) {
    streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) {
      value
      signature
    }
  }`, { login, playerType });
  const token = data.streamPlaybackAccessToken;
  if (!token) throw new Error('Sem token de reprodução');
  return token;
}

function usherUrl(login, token) {
  const params = new URLSearchParams({
    allow_source: 'true',
    allow_audio_only: 'true',
    fast_bread: 'true',
    p: String(Math.floor(Math.random() * 1e7)),
    player_backend: 'mediaplayer',
    playlist_include_framerate: 'true',
    reassignments_supported: 'true',
    supported_codecs: 'avc1',
    platform: 'web',
    sig: token.signature,
    token: token.value,
  });
  return `https://usher.ttvnw.net/api/channel/hls/${login}.m3u8?${params}`;
}

export class OfflineError extends Error {}

// Returns the master playlist text and its parsed variants.
export async function fetchMaster(login, playerType) {
  const token = await getAccessToken(login, playerType);
  const res = await fetch(usherUrl(login, token));
  if (res.status === 404) throw new OfflineError('Canal offline');
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const msg = body.match(/"error":"([^"]+)"/)?.[1];
    throw new Error(msg || `Usher HTTP ${res.status}`);
  }
  const text = await res.text();
  return { text, variants: parseMaster(text) };
}

export async function fetchText(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function parseAttrs(line) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  const body = line.slice(line.indexOf(':') + 1);
  let m;
  while ((m = re.exec(body))) out[m[1]] = m[2].replace(/^"|"$/g, '');
  return out;
}

export function parseMaster(text) {
  const names = {};
  const variants = [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttrs(line);
      if (a['GROUP-ID']) names[a['GROUP-ID']] = a.NAME;
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttrs(line);
      const url = lines[++i];
      const height = parseInt((a.RESOLUTION || 'x0').split('x')[1], 10) || 0;
      variants.push({
        url,
        name: (names[a.VIDEO] || a.VIDEO || '').replace(/\s*\(source\)/i, ''),
        group: a.VIDEO || '',
        height,
        bandwidth: Number(a.BANDWIDTH) || 0,
      });
    }
  }
  return variants;
}
