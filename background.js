import { getSettings, setSettings } from './settings.js';
import { channelFromUrl, getStreamInfo } from './api.js';

const playerUrl = login => chrome.runtime.getURL(`player.html?channel=${encodeURIComponent(login)}`);

// Requests made by the extension get twitch.tv as Origin/Referer, and the chat
// iframe is allowed to load inside the player page.
async function setupRules() {
  const ext = chrome.runtime.id;
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1, 2],
    addRules: [
      {
        id: 1,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Origin', operation: 'set', value: 'https://www.twitch.tv' },
            { header: 'Referer', operation: 'set', value: 'https://www.twitch.tv/' },
          ],
        },
        condition: {
          requestDomains: ['gql.twitch.tv', 'usher.ttvnw.net'],
          initiatorDomains: [ext],
          resourceTypes: ['xmlhttprequest', 'other'],
        },
      },
      {
        id: 2,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          responseHeaders: [
            { header: 'X-Frame-Options', operation: 'remove' },
            { header: 'Content-Security-Policy', operation: 'remove' },
          ],
        },
        condition: {
          requestDomains: ['www.twitch.tv'],
          initiatorDomains: [ext],
          resourceTypes: ['sub_frame'],
        },
      },
    ],
  });
}

async function updateBadge() {
  const { enabled } = await getSettings();
  await chrome.action.setBadgeBackgroundColor({ color: '#6b6b76' });
  await chrome.action.setBadgeText({ text: enabled ? '' : 'OFF' });
}

async function isSkipped(login) {
  const { skip = [] } = await chrome.storage.session.get('skip');
  return skip.includes(login);
}

async function addSkip(login) {
  const { skip = [] } = await chrome.storage.session.get('skip');
  if (!skip.includes(login)) await chrome.storage.session.set({ skip: [...skip, login] });
}

async function onNavigated(url, tabId) {
  const login = channelFromUrl(url);
  if (!login) return;

  // "Abrir na Twitch" from the player adds ?atp-skip=1: stay on Twitch for
  // this channel until the browser is closed.
  if (new URL(url).searchParams.has('atp-skip')) return addSkip(login);
  if (await isSkipped(login)) return;

  const { enabled } = await getSettings();
  if (!enabled) return;

  const user = await getStreamInfo(login).catch(() => null);
  if (user?.stream?.type !== 'live') return;

  // The user may have navigated elsewhere while we were checking.
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || channelFromUrl(tab.url) !== login) return;
  await chrome.tabs.update(tabId, { url: playerUrl(login) });
}

chrome.runtime.onInstalled.addListener(() => {
  setupRules();
  updateBadge();
});

chrome.runtime.onStartup.addListener(() => {
  setupRules();
  updateBadge();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'enabled' in changes) updateBadge();
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'navigated' && sender.tab?.id != null) {
    onNavigated(msg.url, sender.tab.id).catch(err => console.warn('[ATP]', err));
  }
});

// Toolbar button: on a channel page, open it in the player; elsewhere, toggle
// automatic redirection.
chrome.action.onClicked.addListener(async tab => {
  const login = channelFromUrl(tab.url || '');
  if (login) {
    await chrome.tabs.update(tab.id, { url: playerUrl(login) });
    return;
  }
  const { enabled } = await getSettings();
  await setSettings({ enabled: !enabled });
});
