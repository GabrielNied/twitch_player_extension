// Twitch data for the screens: GQL (no login needed) for browsing, Helix for
// the follows of the logged-in user.
import { gql } from '../../api.js';
import { followedLogins } from './auth.js';
import { getFavorites } from './store.js';

const PAGE = 40;
const TOP_PAGE = 30; // the most "streams" accepts

const STREAM_FIELDS = `id type title viewersCount createdAt previewImageURL(width: 440, height: 248)
  broadcaster { id login displayName profileImageURL(width: 70) }
  game { name displayName }`;

const GAME_FIELDS = 'name displayName boxArtURL(width: 188, height: 250) viewersCount';

const nodes = connection => (connection?.edges || []).map(e => e.node).filter(Boolean);

function toStream(node) {
  const b = node.broadcaster;
  return {
    live: true,
    login: b.login,
    displayName: b.displayName || b.login,
    avatar: b.profileImageURL,
    title: node.title || '',
    game: node.game?.displayName || '',
    viewers: node.viewersCount || 0,
    startedAt: node.createdAt,
    preview: node.previewImageURL,
    rerun: node.type === 'rerun',
  };
}

function toChannel(user) {
  if (user.stream) return toStream({ ...user.stream, broadcaster: user.stream.broadcaster || user });
  return { live: false, login: user.login, displayName: user.displayName || user.login, avatar: user.profileImageURL };
}

const toGame = g => ({
  name: g.name,
  displayName: g.displayName || g.name,
  boxArt: g.boxArtURL,
  viewers: g.viewersCount || 0,
});

export async function topStreams(language) {
  const data = await gql(`query TopStreams($langs: [Language!]) {
    streams(first: ${TOP_PAGE}, options: { languages: $langs }) { edges { node { ${STREAM_FIELDS} } } }
  }`, { langs: language ? [language] : null });
  return nodes(data.streams).map(toStream);
}

export async function topGames() {
  const data = await gql(`query TopGames {
    games(first: 60) { edges { node { ${GAME_FIELDS} } } }
  }`);
  return nodes(data.games).map(toGame);
}

export async function gameStreams(name, language) {
  const data = await gql(`query GameStreams($name: String!, $langs: [String!]) {
    game(name: $name) { streams(first: ${PAGE}, options: { languages: $langs }) { edges { node { ${STREAM_FIELDS} } } } }
  }`, { name, langs: language ? [language.toLowerCase()] : null });
  return nodes(data.game?.streams).map(toStream);
}

export async function search(query) {
  const data = await gql(`query Search($query: String!) {
    searchFor(userQuery: $query, platform: "web") {
      channels { items { login displayName profileImageURL(width: 70) stream { ${STREAM_FIELDS} } } }
      games { items { ${GAME_FIELDS} } }
    }
  }`, { query });
  const result = data.searchFor || {};
  return {
    channels: (result.channels?.items || []).map(toChannel),
    games: (result.games?.items || []).map(toGame),
  };
}

export async function channels(logins) {
  const out = [];
  for (let i = 0; i < logins.length; i += 100) {
    const data = await gql(`query Channels($logins: [String!]) {
      users(logins: $logins) { login displayName profileImageURL(width: 70) stream { ${STREAM_FIELDS} } }
    }`, { logins: logins.slice(i, i + 100) });
    out.push(...(data.users || []).filter(Boolean).map(toChannel));
  }
  return out;
}

// Followed channels that are live (when logged in) plus favorites: live ones
// by viewers, then the favorites that are offline.
export async function following() {
  const favorites = getFavorites();
  const logins = [...new Set([...await followedLogins(), ...favorites])];
  const list = await channels(logins);
  return {
    live: list.filter(c => c.live).sort((a, b) => b.viewers - a.viewers),
    offline: list.filter(c => !c.live && favorites.includes(c.login)),
  };
}

let globalBadges = null;

// Chat badge images by "set/version" (channel badges override global ones),
// and the channel's user id.
export async function badges(login) {
  globalBadges = globalBadges || gql(`query GlobalBadges { badges { setID version imageURL(size: DOUBLE) } }`)
    .then(data => data.badges || [])
    .catch(err => {
      globalBadges = null;
      throw err;
    });
  const [global, channel] = await Promise.all([
    globalBadges,
    gql(`query ChannelBadges($login: String!) {
      user(login: $login) { id broadcastBadges { setID version imageURL(size: DOUBLE) } }
    }`, { login }),
  ]);
  const map = new Map();
  for (const b of [...global, ...(channel.user?.broadcastBadges || [])]) map.set(`${b.setID}/${b.version}`, b.imageURL);
  return { roomId: channel.user?.id, badges: map };
}
