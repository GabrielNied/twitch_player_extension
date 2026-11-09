// Alt Player for Samsung TVs (Tizen): browse Twitch with the remote and watch
// live channels through the extension's ad filter.
import { $, startClock } from './ui.js';
import * as home from './home.js';
import * as player from './player.js';
import * as login from './login.js';

const KEYS = {
  13: 'enter', 37: 'left', 38: 'up', 39: 'right', 40: 'down',
  10009: 'back', 27: 'back', // Esc stands in for Back on a computer
  10252: 'playPause', 415: 'play', 19: 'pause', 413: 'stop',
  427: 'chUp', 428: 'chDown',
  65376: 'imeDone', 65385: 'imeCancel',
};

const TV_KEYS = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'ChannelUp', 'ChannelDown'];

function registerKeys() {
  if (typeof tizen === 'undefined') return;
  for (const key of TV_KEYS) {
    try {
      tizen.tvinputdevice.registerKey(key);
    } catch {
      // Not on this remote.
    }
  }
}

function watch(channel, preview) {
  home.hide();
  player.open(channel, preview);
}

document.addEventListener('keydown', e => {
  const key = KEYS[e.keyCode];
  if (!key) return;
  let handled;
  if (login.isOpen()) handled = login.onKey(key);
  else if (!$('player').hidden) handled = player.onKey(key);
  else handled = home.onKey(key);
  if (handled) e.preventDefault();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) player.suspend();
  else player.resume();
});

registerKeys();
startClock();
player.init(() => home.show());
home.init(watch);

// ?channel=<login> opens straight into the player (testing on a computer).
const initial = new URLSearchParams(location.search).get('channel');
if (initial) watch(initial.toLowerCase());
