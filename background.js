import { getSettings } from './settings.js';
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
  chrome.action.setBadgeText({ text: '' }); // drop the old "OFF" badge
});

chrome.runtime.onStartup.addListener(setupRules);

// Budget of backup-stream tokens shared by every player tab. During an ad
// break each player swaps backup sessions as Twitch reaches them with the
// ad, which means many new tokens; with several lives open that adds up to a
// request pattern Twitch may rate-limit. A token bucket caps the total: up
// to BUDGET_MAX at once, refilled by one every BUDGET_REFILL ms. A tab in the
// background only gets one while HIDDEN_RESERVE are left for the visible one.
// Kept in memory: if the service worker is stopped the bucket starts full,
// which it would be by then anyway.
const BUDGET_MAX = 10;
const BUDGET_REFILL = 6_000;
const HIDDEN_RESERVE = 2;
let budget = BUDGET_MAX;
let budgetAt = Date.now();

function takeBackupToken(visible) {
  const now = Date.now();
  budget = Math.min(BUDGET_MAX, budget + (now - budgetAt) / BUDGET_REFILL);
  budgetAt = now;
  if (budget < (visible ? 1 : HIDDEN_RESERVE + 1)) return false;
  budget -= 1;
  return true;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'backup-token') {
    const ok = takeBackupToken(!!msg.visible);
    sendResponse({ ok, left: Math.floor(budget) });
    return;
  }
  if (msg?.type === 'navigated' && sender.tab?.id != null) {
    onNavigated(msg.url, sender.tab.id).catch(err => console.warn('[ATP]', err));
  }
});
