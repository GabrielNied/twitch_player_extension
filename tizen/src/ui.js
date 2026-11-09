// DOM helpers, formatting, cards and the bits shared by the screens (toast,
// clock, leaving the app).

export const $ = id => document.getElementById(id);

// h('div', { className: 'x', onclick }, child, 'text'): strings become text
// nodes, never HTML.
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'dataset' || key === 'style') Object.assign(el[key], value);
    else if (key in el) el[key] = value;
    else el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false || child === '') continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

const short = (value, unit) => `${value.toFixed(value < 10 ? 1 : 0).replace('.', ',').replace(/,0$/, '')} ${unit}`;

export function formatCount(n) {
  if (n >= 1e6) return short(n / 1e6, 'mi');
  if (n >= 1e3) return short(n / 1e3, 'mil');
  return String(n);
}

export function formatUptime(startedAt) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(startedAt)) / 60_000));
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}

// Twitch serves previews at a fixed URL; a new query every 2 minutes keeps
// them from going stale in the cache.
const previewTag = () => Math.floor(Date.now() / 120_000);

export function streamCard(s, onclick) {
  return h('button', { className: 'card stream focusable', dataset: { key: s.login }, onclick },
    h('div', { className: 'thumb' },
      h('img', { src: `${s.preview}?t=${previewTag()}`, alt: '', loading: 'lazy' }),
      h('span', { className: `pill live${s.rerun ? ' rerun' : ''}` }, s.rerun ? 'REPRISE' : 'AO VIVO'),
      h('span', { className: 'pill uptime' }, formatUptime(s.startedAt)),
      h('span', { className: 'pill viewers' }, formatCount(s.viewers)),
      h('span', { className: 'pill watching' }, 'Assistindo'),
    ),
    h('div', { className: 'info' },
      h('img', { className: 'avatar', src: s.avatar, alt: '', loading: 'lazy' }),
      h('div', { className: 'text' },
        h('div', { className: 'name' }, s.displayName, s.game && h('span', { className: 'game' }, ` · ${s.game}`)),
        h('div', { className: 'title' }, s.title),
      ),
    ),
  );
}

export function channelCard(c, onclick) {
  return h('button', { className: 'card channel focusable', dataset: { key: c.login }, onclick },
    h('img', { className: 'avatar', src: c.avatar, alt: '', loading: 'lazy' }),
    h('div', { className: 'name' }, c.displayName),
    h('div', { className: 'status' }, 'Offline'),
  );
}

export function gameCard(g, onclick) {
  return h('button', { className: 'card game focusable', dataset: { key: `game-${g.name}` }, onclick },
    h('div', { className: 'art' }, h('img', { src: g.boxArt, alt: '', loading: 'lazy' })),
    h('div', { className: 'name' }, g.displayName),
    h('div', { className: 'viewers' }, `${formatCount(g.viewers)} assistindo`),
  );
}

let toastTimer = 0;

export function toast(text, ms = 2500) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

export function startClock() {
  const tick = () => {
    const now = new Date();
    const text = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    for (const el of document.querySelectorAll('.clock')) el.textContent = text;
  };
  tick();
  setInterval(tick, 10_000);
}

export function exitApp() {
  try {
    tizen.application.getCurrentApplication().exit();
  } catch {
    window.close();
  }
}
