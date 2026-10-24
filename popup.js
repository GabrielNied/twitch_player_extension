import { getSettings, setSettings } from './settings.js';
import { channelFromUrl, getStreamInfo, twitchUrl } from './api.js';

const $ = id => document.getElementById(id);
const playerPage = chrome.runtime.getURL('player.html');

init();

async function init() {
  $('version').textContent = `v${chrome.runtime.getManifest().version}`;
  const [settings, [tab]] = await Promise.all([
    getSettings(),
    chrome.tabs.query({ active: true, currentWindow: true }),
  ]);

  for (const input of document.querySelectorAll('[data-key]')) {
    input.checked = settings[input.dataset.key];
    input.addEventListener('change', () => setSettings({ [input.dataset.key]: input.checked }));
  }

  const url = tab?.url || '';
  const inPlayer = url.startsWith(playerPage);
  const login = inPlayer
    ? new URL(url).searchParams.get('channel')?.toLowerCase()
    : channelFromUrl(url);
  if (!login) {
    $('hint').hidden = false;
    return;
  }

  $('channel').hidden = false;
  $('channel-name').textContent = login;
  if (inPlayer) {
    // Already watching here: offer the way back to Twitch instead.
    $('open-player').hidden = true;
    $('open-twitch').hidden = false;
    $('open-twitch').addEventListener('click', () => go(tab, twitchUrl(login, true)));
  } else {
    $('open-player').addEventListener('click', () => go(tab, `${playerPage}?channel=${encodeURIComponent(login)}`));
  }
  showInfo(login);
}

async function showInfo(login) {
  const user = await getStreamInfo(login).catch(() => null);
  if (!user) return;
  $('channel-name').textContent = user.displayName;
  if (user.profileImageURL) $('avatar').src = user.profileImageURL;
  const live = user.stream?.type === 'live';
  const status = $('channel-status');
  status.classList.toggle('live', live);
  status.textContent = live ? user.broadcastSettings?.game?.displayName || 'Ao vivo' : 'Offline';
}

async function go(tab, url) {
  await chrome.tabs.update(tab.id, { url });
  window.close();
}
