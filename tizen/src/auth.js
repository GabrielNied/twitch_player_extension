// Twitch login with the device code flow (code shown on the TV, approved on a
// phone or computer) and Helix calls with the user's token.
import { TWITCH_CLIENT_ID } from './config.js';
import { getAuth, setAuth } from './store.js';

const SCOPES = 'user:read:follows';
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export const loginAvailable = () => Boolean(TWITCH_CLIENT_ID);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function post(url, params) {
  const res = await fetch(url, { method: 'POST', body: new URLSearchParams(params) });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

// Returns { device_code, user_code, verification_uri, expires_in, interval }.
export async function startDeviceLogin() {
  const { ok, status, body } = await post('https://id.twitch.tv/oauth2/device', {
    client_id: TWITCH_CLIENT_ID,
    scopes: SCOPES,
  });
  if (!ok) throw new Error(body.message || `HTTP ${status}`);
  return body;
}

// Polls until the user approves the code and resolves with the saved login.
// Stops when `cancel.cancelled` is set.
export async function waitForDeviceLogin(device, cancel) {
  const deadline = Date.now() + device.expires_in * 1000;
  let interval = (device.interval || 5) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    if (cancel.cancelled) throw new Error('Cancelado');
    const { ok, status, body } = await post(TOKEN_URL, {
      client_id: TWITCH_CLIENT_ID,
      scopes: SCOPES,
      device_code: device.device_code,
      grant_type: DEVICE_GRANT,
    });
    if (ok) return saveTokens(body);
    if (body.message === 'authorization_pending') continue;
    if (body.message === 'slow_down') {
      interval += 5000;
      continue;
    }
    throw new Error(body.message || `HTTP ${status}`);
  }
  throw new Error('O código expirou');
}

async function saveTokens(tokens) {
  const res = await fetch('https://id.twitch.tv/oauth2/validate', {
    headers: { Authorization: `OAuth ${tokens.access_token}` },
  });
  if (!res.ok) throw new Error(`Validação HTTP ${res.status}`);
  const user = await res.json();
  const auth = { access: tokens.access_token, refresh: tokens.refresh_token, userId: user.user_id, login: user.login };
  setAuth(auth);
  return auth;
}

let refreshing = null;

// Refresh tokens are single use, so concurrent 401s share one refresh.
function refresh() {
  refreshing = refreshing || (async () => {
    const auth = getAuth();
    const { ok, body } = await post(TOKEN_URL, {
      client_id: TWITCH_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: auth.refresh,
    });
    if (!ok) {
      setAuth(null);
      throw new Error('A sessão da Twitch expirou. Entre de novo nas Configurações.');
    }
    setAuth({ ...auth, access: body.access_token, refresh: body.refresh_token });
  })().finally(() => { refreshing = null; });
  return refreshing;
}

async function helix(path) {
  const call = () => fetch(`https://api.twitch.tv/helix/${path}`, {
    headers: { 'Client-Id': TWITCH_CLIENT_ID, Authorization: `Bearer ${getAuth().access}` },
  });
  let res = await call();
  if (res.status === 401) {
    await refresh();
    res = await call();
  }
  if (!res.ok) throw new Error(`Helix HTTP ${res.status}`);
  return res.json();
}

// Logins of the followed channels that are live now.
export async function followedLogins() {
  const auth = getAuth();
  if (!auth) return [];
  const { data = [] } = await helix(`streams/followed?user_id=${auth.userId}&first=100`);
  return data.map(s => s.user_login);
}

export function logout() {
  const auth = getAuth();
  setAuth(null);
  if (auth) post('https://id.twitch.tv/oauth2/revoke', { client_id: TWITCH_CLIENT_ID, token: auth.access }).catch(() => {});
}
