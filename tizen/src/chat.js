// Read-only Twitch chat: anonymous IRC over WebSocket, with the last messages
// sent before joining (recent-messages.robotty.de), badges, and Twitch, 7TV,
// BetterTTV and FrankerFaceZ emotes.
import { badges as loadBadges } from './twitch.js';
import { loadEmotes } from './emotes.js';
import { h } from './ui.js';

const IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';
const MAX_LINES = 120;
const ASSETS_WAIT = 3000; // ms to wait for badges/emotes before showing messages without them
const NAME_COLORS = ['#ff5c8a', '#ff8a4c', '#ffc53d', '#c4e538', '#4cd97b', '#2fd4c5', '#4aa8ff', '#9d8cff', '#e07bff', '#ff7ad9'];
const TAG_ESCAPES = { ':': ';', s: ' ', '\\': '\\', r: '\r', n: '\n' };

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function parseIrc(line) {
  const msg = { tags: {}, prefix: '', command: '', params: [] };
  let rest = line;
  if (rest[0] === '@') {
    const end = rest.indexOf(' ');
    for (const pair of rest.slice(1, end).split(';')) {
      const eq = pair.indexOf('=');
      if (eq < 0) msg.tags[pair] = '';
      else msg.tags[pair.slice(0, eq)] = pair.slice(eq + 1).replace(/\\(.)/g, (_, c) => TAG_ESCAPES[c] ?? c);
    }
    rest = rest.slice(end + 1);
  }
  if (rest[0] === ':') {
    const end = rest.indexOf(' ');
    msg.prefix = rest.slice(1, end);
    rest = rest.slice(end + 1);
  }
  const trailing = rest.indexOf(' :');
  [msg.command, ...msg.params] = (trailing < 0 ? rest : rest.slice(0, trailing)).split(' ').filter(Boolean);
  if (trailing >= 0) msg.params.push(rest.slice(trailing + 2));
  return msg;
}

// Twitch colors picked for light backgrounds get lightened; users without a
// color get a stable one from their name.
function nameColor(color, user) {
  if (!color) {
    let hash = 0;
    for (const c of user) hash = (hash * 31 + c.charCodeAt(0)) | 0;
    return NAME_COLORS[Math.abs(hash) % NAME_COLORS.length];
  }
  const n = parseInt(color.slice(1), 16);
  let rgb = [n >> 16, (n >> 8) & 255, n & 255];
  const luminance = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
  if (luminance < 0.45) rgb = rgb.map(v => Math.round(v + (255 - v) * 0.45));
  return `rgb(${rgb.join(', ')})`;
}

async function fetchHistory(login) {
  const res = await fetch(`https://recent-messages.robotty.de/api/v2/recent-messages/${login}?limit=60`);
  if (!res.ok) return [];
  const { messages = [] } = await res.json();
  return messages;
}

const emoteImg = (src, name) => h('img', { className: 'emote', src, alt: name });

export class Chat {
  constructor(list) {
    this.list = list;
    this.session = null;
    this.ws = null;
    this.badges = new Map();
    this.emotes = new Map();
    this.pending = [];
    this.frame = 0;
    this.retries = 0;
    this.retryTimer = 0;
  }

  // options: the settings (chatHistory, thirdPartyEmotes).
  join(login, options) {
    this.leave();
    const session = this.session = { login, ready: false };
    this.list.textContent = '';
    this.badges = new Map();
    this.emotes = new Map();

    const assets = loadBadges(login).then(async ({ roomId, badges }) => {
      if (session !== this.session) return;
      this.badges = badges;
      if (!roomId || !options.thirdPartyEmotes) return;
      const emotes = await loadEmotes(roomId);
      if (session === this.session) this.emotes = emotes;
    }).catch(err => console.warn('[chat] badges/emotes', err));
    const history = options.chatHistory ? fetchHistory(login).catch(() => []) : Promise.resolve([]);

    Promise.race([assets, sleep(ASSETS_WAIT)]).then(() => history).then(lines => {
      if (session !== this.session) return;
      session.ready = true;
      const old = lines.map(parseIrc)
        .filter(m => m.command === 'PRIVMSG' || m.command === 'USERNOTICE')
        .map(m => ({ ...m, historical: true }));
      this.pending.unshift(...old);
      this.schedule();
    });

    this.connect(session);
  }

  leave() {
    this.session = null;
    clearTimeout(this.retryTimer);
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.pending = [];
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  connect(session) {
    const ws = this.ws = new WebSocket(IRC_URL);
    ws.onopen = () => {
      this.retries = 0;
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      ws.send('PASS SCHMOOPIIE');
      ws.send(`NICK justinfan${10000 + Math.floor(Math.random() * 80000)}`);
      ws.send(`JOIN #${session.login}`);
    };
    ws.onmessage = e => {
      for (const line of String(e.data).split('\r\n')) if (line) this.onLine(line);
    };
    ws.onclose = () => {
      if (session !== this.session) return;
      // 1 s, 2 s, 4 s… up to 30 s between attempts.
      const delay = Math.min(30_000, 1000 * 2 ** this.retries++);
      this.retryTimer = setTimeout(() => this.connect(session), delay);
    };
  }

  onLine(line) {
    if (line.startsWith('PING')) {
      this.ws.send('PONG :tmi.twitch.tv');
      return;
    }
    const msg = parseIrc(line);
    switch (msg.command) {
      case 'PRIVMSG':
      case 'USERNOTICE':
        this.pending.push(msg);
        if (this.pending.length > MAX_LINES * 2) this.pending.splice(0, this.pending.length - MAX_LINES);
        this.schedule();
        break;
      case 'CLEARCHAT': // timeout/ban of one user, or the whole chat cleared
        if (msg.params[1]) this.removeWhere(el => el.dataset.user === msg.params[1], m => m.prefix.startsWith(`${msg.params[1]}!`));
        else this.removeWhere(() => true, () => true);
        break;
      case 'CLEARMSG':
        this.removeWhere(el => el.dataset.id === msg.tags['target-msg-id'], m => m.tags.id === msg.tags['target-msg-id']);
        break;
      case 'RECONNECT':
        this.ws.close();
        break;
      default:
        break;
    }
  }

  removeWhere(matchLine, matchPending) {
    for (const el of Array.from(this.list.children)) if (matchLine(el)) el.remove();
    this.pending = this.pending.filter(m => !matchPending(m));
  }

  // Lines are added at most once per frame, which keeps busy chats cheap.
  schedule() {
    if (this.frame || !this.session?.ready) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const batch = this.pending.splice(0).slice(-MAX_LINES);
      const fragment = document.createDocumentFragment();
      for (const msg of batch) fragment.append(this.render(msg));
      this.list.append(fragment);
      for (let extra = this.list.childElementCount - MAX_LINES; extra > 0; extra--) this.list.firstElementChild.remove();
    });
  }

  render(msg) {
    const { tags } = msg;
    const user = tags.login || msg.prefix.split('!')[0];
    const li = h('li', { className: `msg${msg.historical ? ' old' : ''}`, dataset: { user, id: tags.id || '' } });
    let text = msg.params[1] || '';
    if (msg.command === 'USERNOTICE') {
      li.classList.add('notice');
      li.append(h('div', { className: 'system' }, tags['system-msg'] || ''));
      if (!text) return li;
    }
    const action = text.startsWith('\u0001ACTION ') && text.endsWith('\u0001');
    if (action) text = text.slice(8, -1);

    for (const badge of (tags.badges || '').split(',')) {
      const url = badge && this.badges.get(badge);
      if (url) li.append(h('img', { className: 'chat-badge', src: url, alt: '' }));
    }
    const color = nameColor(tags.color, user);
    li.append(h('span', { className: 'name', style: { color } }, tags['display-name'] || user), action ? ' ' : ': ');
    const body = h('span', { className: action ? 'body action' : 'body', style: action ? { color } : null });
    this.appendText(body, text, tags.emotes);
    li.append(body);
    return li;
  }

  // Twitch emotes come as code point ranges in the "emotes" tag
  // ("25:0-4,12-16/1902:6-10"); the rest of the text goes through the
  // third-party emote words.
  appendText(el, text, emoteTag) {
    const chars = Array.from(text);
    const ranges = [];
    for (const part of (emoteTag || '').split('/')) {
      const [id, spots] = part.split(':');
      if (!spots) continue;
      for (const spot of spots.split(',')) {
        const [start, end] = spot.split('-').map(Number);
        ranges.push({ id, start, end });
      }
    }
    ranges.sort((a, b) => a.start - b.start);
    let pos = 0;
    for (const { id, start, end } of ranges) {
      if (start < pos) continue;
      this.appendWords(el, chars.slice(pos, start).join(''));
      el.append(emoteImg(`https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/1.0`, chars.slice(start, end + 1).join('')));
      pos = end + 1;
    }
    this.appendWords(el, chars.slice(pos).join(''));
  }

  appendWords(el, text) {
    if (!text) return;
    if (!this.emotes.size) {
      el.append(text);
      return;
    }
    let plain = '';
    for (const word of text.split(/( )/)) {
      const url = word !== ' ' && this.emotes.get(word);
      if (!url) {
        plain += word;
        continue;
      }
      if (plain) el.append(plain);
      plain = '';
      el.append(emoteImg(url, word));
    }
    if (plain) el.append(plain);
  }
}
