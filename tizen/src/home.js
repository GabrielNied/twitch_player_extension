// Home: a sidebar of sections on the left (the content follows the focused
// item), grids of live channels and categories on the right.
import { $, h, streamCard, channelCard, gameCard, toast, exitApp } from './ui.js';
import * as nav from './nav.js';
import * as twitch from './twitch.js';
import { getSettings, setSetting, getAuth, getFavorites } from './store.js';
import { loginAvailable, logout } from './auth.js';
import { openLogin } from './login.js';
import { APP_VERSION } from './config.js';

const SECTION_DELAY = 300; // ms on a sidebar item before its content loads
const EXIT_WINDOW = 2500;  // a second Back within this leaves the app

const ON_OFF = [[true, 'Ligado'], [false, 'Desligado']];
const SETTINGS = [
  { key: 'language', label: 'Idioma das lives', options: [['PT', 'Português'], ['', 'Todos']] },
  { key: 'quality', label: 'Qualidade inicial', options: [['auto', 'Automática'], ['source', 'Máxima'], [1080, '1080p'], [720, '720p'], [480, '480p']] },
  { key: 'lowLatency', label: 'Baixa latência', options: ON_OFF },
  { key: 'chat', label: 'Mostrar chat', options: ON_OFF },
  { key: 'chatMode', label: 'Posição do chat', options: [['overlay', 'Sobre o vídeo'], ['side', 'Ao lado do vídeo']] },
  { key: 'chatSide', label: 'Lado do chat', options: [['right', 'Direita'], ['left', 'Esquerda']] },
  { key: 'chatWidth', label: 'Largura do chat', options: [[340, 'Estreito'], [420, 'Médio'], [520, 'Largo']] },
  { key: 'chatFont', label: 'Letra do chat', options: [[22, 'Pequena'], [26, 'Média'], [30, 'Grande']] },
  { key: 'chatOpacity', label: 'Fundo do chat', options: [[0, 'Transparente'], [0.35, 'Claro'], [0.55, 'Médio'], [0.8, 'Escuro']] },
  { key: 'thirdPartyEmotes', label: 'Emotes 7TV, BTTV e FFZ', options: ON_OFF },
  { key: 'chatHistory', label: 'Mensagens anteriores ao entrar', options: ON_OFF },
];

const SECTIONS = {
  search: { title: 'Buscar', render: renderSearch },
  following: { title: 'Seguindo', render: renderFollowing },
  top: { title: 'Em alta', render: renderTop },
  games: { title: 'Categorias', render: renderGames },
  settings: { title: 'Configurações', render: renderSettings },
};

let watch = null;
let section = null;
let views = [];          // drill-down stack: { title, render, focusKey }
let shown = null;        // view whose content is on screen
let renderId = 0;
let pendingFocus = null; // data-key to focus once the content has it
let sectionTimer = 0;
let lastBack = 0;
let lastFocus = null;
let query = '';
let editing = null;      // the search field while the on-screen keyboard is up
let searchTimer = 0;
const cache = new Map();

const navItem = key => $('sidebar').querySelector(`[data-section="${key}"]`);

export function init(onWatch) {
  watch = onWatch;
  const sidebar = $('sidebar');
  sidebar.addEventListener('focusin', e => {
    const key = e.target.dataset.section;
    if (!key || key === section) return;
    clearTimeout(sectionTimer);
    sectionTimer = setTimeout(() => showSection(key), SECTION_DELAY);
  });
  for (const item of sidebar.querySelectorAll('.nav-item')) {
    item.addEventListener('click', () => {
      showSection(item.dataset.section);
      const input = $('content-body').querySelector('.search-input');
      if (input) {
        nav.focus(input);
        startEditing(input);
      } else {
        focusContent();
      }
    });
  }
  updateAccount();
  const start = getAuth() || getFavorites().length ? 'following' : 'top';
  nav.setScope($('home'));
  showSection(start);
  nav.focus(navItem(start));
  refreshCount();
}

export function show() {
  $('home').hidden = false;
  nav.setScope($('home'));
  cache.delete('following');
  if (lastFocus?.isConnected) nav.focus(lastFocus);
  else nav.focus(navItem(section));
  render();
  refreshCount();
}

export function hide() {
  lastFocus = document.activeElement;
  clearTimeout(sectionTimer);
  $('home').hidden = true;
}

// Results reused for a while, so Back and section hops are instant.
function cached(key, ttl, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.promise;
  const promise = load();
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => cache.delete(key));
  return promise;
}

function showSection(key) {
  clearTimeout(sectionTimer);
  if (key === section) return;
  section = key;
  for (const item of $('sidebar').querySelectorAll('.nav-item')) {
    item.classList.toggle('active', item.dataset.section === key);
  }
  views = [{ title: SECTIONS[key].title, render: SECTIONS[key].render }];
  render();
}

function render() {
  const token = ++renderId;
  const view = views[views.length - 1];
  const current = () => token === renderId;
  Promise.resolve()
    .then(() => view.render(current))
    .catch(err => {
      if (!current()) return;
      console.warn('[home]', err);
      setContent(view.title, [
        h('p', { className: 'error' }, `Não foi possível carregar: ${err.message}`),
        h('button', { className: 'btn focusable', dataset: { key: 'retry' }, onclick: () => { shown = null; render(); } }, 'Tentar de novo'),
      ]);
    });
}

// Focus follows the element with the same data-key (or pendingFocus) into the
// new content; while it's loading, it waits on the loading line.
function setContent(title, nodes) {
  const body = $('content-body');
  const active = document.activeElement;
  const hadFocus = $('content').contains(active);
  const key = pendingFocus || (hadFocus ? active.dataset.key : null);
  if (shown !== views[views.length - 1]) body.scrollTop = 0;
  shown = views[views.length - 1];
  $('content-title').textContent = title;
  body.replaceChildren(...nodes);
  if ($('home').hidden || (!hadFocus && !pendingFocus)) return;
  const keyed = key && body.querySelector(`[data-key="${CSS.escape(key)}"]`);
  const loading = body.querySelector('.loading.focusable');
  if (!keyed && loading) {
    nav.focus(loading);
    return;
  }
  pendingFocus = null;
  const target = keyed || body.querySelector('.card.focusable') || nav.focusables(body)[0];
  nav.focus(target || navItem(section));
}

// A refresh keeps the old content on screen until the new one is in.
function setLoading(title, nodes = []) {
  if (shown === views[views.length - 1]) return;
  setContent(title, [...nodes, h('p', { className: 'loading focusable', tabIndex: -1, dataset: { key: 'loading' } }, 'Carregando…')]);
}

function focusContent() {
  const body = $('content-body');
  const target = body.querySelector('.card.focusable') || nav.focusables(body)[0];
  if (target) nav.focus(target);
}

function back() {
  if ($('content').contains(document.activeElement)) {
    if (views.length > 1) {
      views.pop();
      pendingFocus = views[views.length - 1].focusKey || null;
      render();
    } else {
      nav.focus(navItem(section));
    }
    return;
  }
  if (Date.now() - lastBack < EXIT_WINDOW) {
    exitApp();
    return;
  }
  lastBack = Date.now();
  toast('Pressione Voltar de novo para sair');
}

/* ---------- Building blocks ---------- */

const empty = text => h('p', { className: 'empty' }, text);
const subhead = text => h('h2', { className: 'subhead' }, text);
const streamGrid = streams => h('div', { className: 'grid streams' }, streams.map(s => streamCard(s, () => watch(s.login, s))));
const channelGrid = list => h('div', { className: 'grid channels' }, list.map(c => channelCard(c, () => watch(c.login, c))));
const gameGrid = games => h('div', { className: 'grid games' }, games.map(g => gameCard(g, () => openGame(g))));

function languageChips() {
  const selected = getSettings().language;
  const chips = [['PT', 'Português'], ['', 'Todos os idiomas']].map(([value, label]) => h('button', {
    className: `chip focusable${value === selected ? ' selected' : ''}`,
    dataset: { key: `lang-${value}` },
    onclick: () => {
      if (value === getSettings().language) return;
      setSetting('language', value);
      for (const chip of chips) chip.classList.toggle('selected', chip.dataset.key === `lang-${value}`);
      render();
    },
  }, label));
  return h('div', { className: 'chips' }, chips);
}

function loginBanner() {
  return h('div', { className: 'banner' },
    h('span', null, 'Entre com sua conta da Twitch para ver aqui os canais que você segue.'),
    h('button', { className: 'btn focusable', dataset: { key: 'login' }, onclick: () => openLogin(onAccountChange) }, 'Entrar'));
}

function onAccountChange() {
  cache.delete('following');
  updateAccount();
  render();
  refreshCount();
}

function updateAccount() {
  const auth = getAuth();
  $('account').textContent = auth ? `Conectado como ${auth.login}` : '';
}

function refreshCount() {
  cached('following', 30_000, twitch.following).then(({ live }) => {
    navItem('following').querySelector('.count').textContent = live.length ? String(live.length) : '';
  }, () => {});
}

/* ---------- Sections ---------- */

async function renderFollowing(current) {
  setLoading('Seguindo');
  const { live, offline } = await cached('following', 30_000, twitch.following);
  if (!current()) return;
  const nodes = [];
  if (!getAuth() && loginAvailable()) nodes.push(loginBanner());
  if (live.length) nodes.push(streamGrid(live));
  else {
    nodes.push(empty(getAuth() || getFavorites().length
      ? 'Nenhum canal está ao vivo agora.'
      : 'Abra uma live e use "☆ Favoritar" para o canal aparecer aqui.'));
  }
  if (offline.length) nodes.push(subhead('Favoritos offline'), channelGrid(offline));
  setContent('Seguindo', nodes);
}

async function renderTop(current) {
  const lang = getSettings().language;
  setLoading('Em alta', [languageChips()]);
  const streams = await cached(`top:${lang}`, 60_000, () => twitch.topStreams(lang));
  if (!current()) return;
  setContent('Em alta', [languageChips(), streams.length ? streamGrid(streams) : empty('Nenhuma live encontrada.')]);
}

async function renderGames(current) {
  setLoading('Categorias');
  const games = await cached('games', 120_000, twitch.topGames);
  if (!current()) return;
  setContent('Categorias', [gameGrid(games)]);
}

function openGame(game) {
  views[views.length - 1].focusKey = `game-${game.name}`;
  views.push({ title: game.displayName, render: current => renderGame(current, game) });
  render();
}

async function renderGame(current, game) {
  const lang = getSettings().language;
  setLoading(game.displayName, [languageChips()]);
  const streams = await cached(`game:${game.name}:${lang}`, 60_000, () => twitch.gameStreams(game.name, lang));
  if (!current()) return;
  setContent(game.displayName, [languageChips(), streams.length ? streamGrid(streams) : empty('Nenhuma live nesta categoria.')]);
}

function renderSearch() {
  const input = h('input', {
    className: 'search-input focusable',
    type: 'text',
    value: query,
    readOnly: true,
    placeholder: 'Buscar canais e categorias',
    spellcheck: false,
    autocomplete: 'off',
    dataset: { key: 'search' },
  });
  input.addEventListener('click', () => startEditing(input));
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(input.value), 700);
  });
  input.addEventListener('blur', () => {
    if (editing === input) finishEditing(true);
  });
  const loading = query && h('p', { className: 'loading focusable', tabIndex: -1, dataset: { key: 'loading' } }, 'Buscando…');
  setContent('Buscar', [input, h('div', { id: 'search-results' }, loading)]);
  if (query) runSearch(query);
}

// The field is read-only until OK, so moving over it doesn't pop up the
// on-screen keyboard.
function startEditing(input) {
  input.blur();
  editing = input;
  input.readOnly = false;
  input.classList.add('editing');
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function finishEditing(searchNow) {
  const input = editing;
  if (!input) return;
  editing = null;
  input.readOnly = true;
  input.classList.remove('editing');
  if (searchNow) {
    clearTimeout(searchTimer);
    runSearch(input.value);
  }
  // Blurring closes the keyboard; the D-pad focus stays on the field.
  input.blur();
  if (!$('home').hidden) nav.focus(input);
}

async function runSearch(text) {
  query = text.trim();
  const token = renderId;
  const results = $('search-results');
  if (!results) return;
  if (query.length < 2) {
    results.replaceChildren();
    return;
  }
  if (!results.childElementCount) results.replaceChildren(h('p', { className: 'loading' }, 'Buscando…'));
  let found;
  try {
    found = await cached(`search:${query.toLowerCase()}`, 60_000, () => twitch.search(query));
  } catch (err) {
    if (token === renderId) results.replaceChildren(h('p', { className: 'error' }, `Não foi possível buscar: ${err.message}`));
    return;
  }
  if (token !== renderId || query !== text.trim()) return;
  const { channels, games } = found;
  const live = channels.filter(c => c.live);
  const offline = channels.filter(c => !c.live);
  const hadFocus = results.contains(document.activeElement);
  const key = pendingFocus || (hadFocus ? document.activeElement.dataset.key : null);
  results.replaceChildren(...[
    channels.length > 0 && subhead('Canais'),
    live.length > 0 && streamGrid(live),
    offline.length > 0 && channelGrid(offline),
    games.length > 0 && subhead('Categorias'),
    games.length > 0 && gameGrid(games),
    !channels.length && !games.length && empty('Nada encontrado.'),
  ].filter(Boolean));
  pendingFocus = null;
  const target = key && results.querySelector(`[data-key="${CSS.escape(key)}"]`);
  if (target) nav.focus(target);
  else if (hadFocus) nav.focus($('content-body').querySelector('.search-input'));
}

function renderSettings() {
  const s = getSettings();
  setContent('Configurações', [
    h('div', { className: 'settings' }, SETTINGS.map(def => settingRow(def, s[def.key])), accountRow()),
    h('p', { className: 'version' }, `Alt Player ${APP_VERSION}`),
  ]);
}

function settingRow(def, value) {
  const index = Math.max(0, def.options.findIndex(([v]) => v === value));
  return h('button', {
    className: 'row focusable',
    dataset: { key: `setting-${def.key}` },
    onclick: () => {
      setSetting(def.key, def.options[(index + 1) % def.options.length][0]);
      renderSettings();
    },
  }, h('span', { className: 'label' }, def.label), h('span', { className: 'value' }, def.options[index][1]));
}

function accountRow() {
  const auth = getAuth();
  if (!loginAvailable()) {
    return h('div', { className: 'row disabled' },
      h('span', { className: 'label' }, 'Conta da Twitch'),
      h('span', { className: 'value' }, 'Indisponível (sem Client ID)'));
  }
  return h('button', {
    className: 'row focusable',
    dataset: { key: 'account' },
    onclick: () => {
      if (!auth) {
        openLogin(onAccountChange);
        return;
      }
      logout();
      toast('Conta desconectada');
      onAccountChange();
    },
  }, h('span', { className: 'label' }, 'Conta da Twitch'), h('span', { className: 'value' }, auth ? `${auth.login} · Sair` : 'Entrar'));
}

/* ---------- Keys ---------- */

export function onKey(key) {
  if (editing) {
    if (key === 'enter' || key === 'imeDone') finishEditing(true);
    else if (key === 'back' || key === 'imeCancel') finishEditing(false);
    else return false;
    return true;
  }
  switch (key) {
    case 'left':
    case 'right':
    case 'up':
    case 'down':
      nav.move(key);
      return true;
    case 'enter':
      document.activeElement?.click?.();
      return true;
    case 'back':
      back();
      return true;
    default:
      return false;
  }
}
