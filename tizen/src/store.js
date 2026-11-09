// Settings, favorites and the Twitch login, kept in localStorage.

export const DEFAULTS = {
  language: 'PT',       // "Em alta" and category streams: 'PT', or '' for all
  quality: 'auto',      // 'auto', 'source' or a height (1080, 720, 480)
  lowLatency: true,
  chat: true,
  chatSide: 'right',    // 'right' | 'left'
  chatMode: 'overlay',  // 'overlay' (over the video) | 'side' (video shrinks)
  chatWidth: 420,
  chatFont: 26,
  chatOpacity: 0.55,    // chat background
  thirdPartyEmotes: true,
  chatHistory: true,
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable: the value lasts until the app closes.
  }
}

let settings = { ...DEFAULTS, ...read('settings', {}) };

export const getSettings = () => settings;

export function setSetting(key, value) {
  settings = { ...settings, [key]: value };
  write('settings', settings);
}

let favorites = read('favorites', []);

export const getFavorites = () => favorites;
export const isFavorite = login => favorites.includes(login);

// Returns whether the channel is a favorite now.
export function toggleFavorite(login) {
  favorites = isFavorite(login) ? favorites.filter(l => l !== login) : [...favorites, login];
  write('favorites', favorites);
  return isFavorite(login);
}

let auth = read('auth', null);

export const getAuth = () => auth;

export function setAuth(value) {
  auth = value;
  write('auth', value);
}
