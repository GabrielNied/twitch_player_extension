import { getSettings, setSettings } from './settings.js';
import { fetchMaster, getStreamInfo, twitchUrl, OfflineError, PRIMARY_PLAYER_TYPE } from './api.js';
import { AdFilter } from './ads.js';
import { ReplayBuffer } from './replay.js';

const Hls = window.Hls;
const $ = id => document.getElementById(id);

const login = (new URLSearchParams(location.search).get('channel') || '').toLowerCase();
const video = $('video');
const stage = $('stage');
const REWIND_SECONDS = 120;

let settings;
let hls = null;
let filter = null;
let variants = [];
let adStatus = { mode: 'clean' };
let restartTimer = 0;
let mediaRecoveries = 0;
let streamStart = null;
let displayName = login;
let rewinding = false;   // user moved back in time: don't speed up to catch the live edge
let bestDelay = Infinity; // lowest delay behind the broadcast seen in this session (s)
let driftTicks = 0;
const DRIFT_LIMIT = 20;   // seconds behind bestDelay that mean the timeline went out of sync
const replay = new ReplayBuffer(REWIND_SECONDS);

init();

async function init() {
  settings = await getSettings();
  if (!/^[a-z0-9_]{1,25}$/.test(login)) {
    showOverlay('Canal inválido.', { static: true });
    return;
  }
  document.title = `${login} · Alternate Player`;
  $('name').textContent = login;
  $('name').href = twitchUrl(login, true);
  $('open-twitch').href = twitchUrl(login, true);

  setupControls();
  setupMenus();
  setupSeekBar();
  setupReplay();
  setupBackground();
  applyChat();
  setupChatResize();
  wake();
  await refreshInfo();
  start();
  setInterval(refreshInfo, 60_000);
  setInterval(tick, 500);
}

function tick() {
  updateUptime();
  updateLatency();
  updateSeekBar();
  updateStats();
  updateRecording();
  checkDrift();
}

/* ---------- Channel info ---------- */

async function refreshInfo() {
  let user;
  try {
    user = await getStreamInfo(login);
  } catch {
    return;
  }
  if (!user) {
    showOverlay('Canal não encontrado.', { static: true });
    return;
  }
  displayName = user.displayName;
  document.title = `${user.displayName} · Alternate Player`;
  $('name').textContent = user.displayName;
  if (user.profileImageURL) $('avatar').src = user.profileImageURL;
  $('title').textContent = user.broadcastSettings?.title || '';
  $('title').title = user.broadcastSettings?.title || '';
  $('game').textContent = user.broadcastSettings?.game?.displayName || '';
  const live = user.stream?.type === 'live';
  $('viewers').textContent = live ? `${user.stream.viewersCount.toLocaleString('pt-BR')} espectadores` : '';
  streamStart = live ? new Date(user.stream.createdAt) : null;
  updateUptime();
  // Shown by the OS media controls (and keeps them working while the tab is hidden).
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: user.broadcastSettings?.title || user.displayName,
      artist: user.displayName,
      artwork: user.profileImageURL ? [{ src: user.profileImageURL }] : [],
    });
  }
}

const pad = n => String(n).padStart(2, '0');
function formatTime(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  return h ? `${h}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

function updateUptime() {
  $('uptime').textContent = streamStart ? formatTime((Date.now() - streamStart) / 1000) : '';
}

/* ---------- Playback ---------- */

function destroyPlayer() {
  filter?.destroy();
  filter = null;
  if (hls) {
    hls.destroy();
    hls = null;
  }
}

function scheduleRestart(ms) {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(start, ms);
}

async function start() {
  clearTimeout(restartTimer);
  destroyPlayer();
  if (suspended) return;
  setAdStatus({ mode: 'clean' });
  showOverlay('Conectando à live…');

  let master;
  try {
    master = await fetchMaster(login, PRIMARY_PLAYER_TYPE);
  } catch (err) {
    if (err instanceof OfflineError) {
      showOverlay(`${displayName} está offline. Verificando de novo a cada 30 segundos.`, {
        static: true,
        actions: [{ label: 'Abrir na Twitch', href: twitchUrl(login, true) }],
      });
      scheduleRestart(30_000);
    } else {
      showOverlay(`Não foi possível carregar a live (${err.message}). Tentando de novo…`);
      scheduleRestart(5_000);
    }
    return;
  }
  if (suspended) return;

  variants = master.variants;
  filter = new AdFilter(login, variants, setAdStatus);
  const masterUrl = URL.createObjectURL(new Blob([master.text], { type: 'application/vnd.apple.mpegurl' }));

  rewinding = false;
  bestDelay = Infinity;
  driftTicks = 0;
  hls = new Hls({
    pLoader: filter.loaderFor(Hls),
    fLoader: replay.loaderFor(Hls),
    enableWorker: false,
    liveDurationInfinity: true,
    liveSyncDurationCount: settings.lowLatency ? 2 : 3,
    maxLiveSyncPlaybackRate: settings.lowLatency ? 1.15 : 1,
    backBufferLength: REWIND_SECONDS,
  });
  mediaRecoveries = 0;

  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    URL.revokeObjectURL(masterUrl);
    buildQualityMenu();
    play();
  });
  hls.on(Hls.Events.LEVEL_SWITCHED, updateQualityLabels);
  hls.on(Hls.Events.ERROR, onHlsError);

  hls.loadSource(masterUrl);
  hls.attachMedia(video);
}

function onHlsError(_, data) {
  if (!data.fatal) return;
  console.warn('[ATP] fatal hls error', data.type, data.details);
  if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 2) {
    if (mediaRecoveries++ === 1) hls.swapAudioCodec();
    hls.recoverMediaError();
    return;
  }
  showOverlay('Conexão perdida. Reconectando…');
  scheduleRestart(3_000);
}

async function play() {
  video.volume = settings.volume;
  video.muted = settings.muted;
  try {
    await video.play();
  } catch {
    // Autoplay with sound blocked: start muted and offer to unmute.
    video.muted = true;
    $('unmute-hint').hidden = settings.muted;
    video.play().catch(() => {});
  }
}

let pauseIntended = false; // the next 'pause' comes from the user, not from the browser
function pause() {
  pauseIntended = true;
  video.pause();
}

function setRewinding(value) {
  rewinding = value;
  if (hls) hls.config.maxLiveSyncPlaybackRate = !value && settings.lowLatency ? 1.15 : 1;
}

function liveEdge() {
  if (hls?.liveSyncPosition != null) return hls.liveSyncPosition;
  const r = video.seekable;
  return r.length ? r.end(r.length - 1) : video.currentTime;
}

// How far the frame on screen is behind the broadcast, from the segments'
// program date time. Unlike hls.latency it can't be fooled by a playlist
// timeline that went out of sync with the content (e.g. around ad breaks).
function broadcastDelay() {
  const date = hls?.playingDate;
  return date ? (Date.now() - date.getTime()) / 1000 : null;
}

function drifted() {
  const delay = broadcastDelay();
  return delay != null && delay - bestDelay > DRIFT_LIMIT;
}

// Playing "live" but showing old content: seeking can't fix it because the
// player's live edge is wrong too, so reload the stream like a page refresh.
function checkDrift() {
  const delay = broadcastDelay();
  if (delay == null || video.paused || rewinding || video.readyState < 3 || adStatus.mode === 'waiting') {
    driftTicks = 0;
    return;
  }
  bestDelay = Math.min(bestDelay, delay);
  driftTicks = drifted() ? driftTicks + 1 : 0;
  if (driftTicks >= 10) {
    console.warn('[ATP] playback drifted from the live edge, reloading', delay.toFixed(1), bestDelay.toFixed(1));
    start();
  }
}

function goLive() {
  setRewinding(false);
  if (hls && drifted() && liveEdge() - video.currentTime < DRIFT_LIMIT) {
    start();
    return;
  }
  if (hls) video.currentTime = liveEdge();
  video.play().catch(() => {});
}

function seekTo(time) {
  const r = video.seekable;
  if (!r.length) return;
  const edge = liveEdge();
  if (time >= edge - 1) {
    goLive();
    return;
  }
  setRewinding(true);
  video.currentTime = Math.max(r.start(0), time);
}

function updateLatency() {
  const btn = $('btn-live');
  if (!hls) return;
  const behindBy = liveEdge() - video.currentTime;
  const latency = hls.latency;
  const behind = video.paused || rewinding || behindBy > 8;
  btn.classList.toggle('behind', behind);
  if (behind && behindBy > 1) $('latency').textContent = `-${formatTime(behindBy)}`;
  else if (Number.isFinite(latency) && latency > 0) $('latency').textContent = `AO VIVO · ${latency.toFixed(1)}s`;
  else $('latency').textContent = 'AO VIVO';
}

/* ---------- Quality ---------- */

function levelName(level) {
  const url = level.uri || (Array.isArray(level.url) ? level.url[0] : level.url);
  const v = variants.find(x => x.url === url);
  if (v?.name) return v.name;
  if (!level.height) return 'Somente áudio';
  return `${level.height}p${level.frameRate > 31 ? Math.round(level.frameRate) : ''}`;
}

function buildQualityMenu() {
  const list = $('quality-list');
  list.textContent = '';
  const options = [{ index: -1, name: 'Automático' }].concat(
    hls.levels
      .map((level, index) => ({ index, name: levelName(level), height: level.height, bitrate: level.bitrate }))
      .sort((a, b) => b.height - a.height || b.bitrate - a.bitrate),
  );
  for (const opt of options) {
    const row = document.createElement('button');
    row.className = 'menu-row radio';
    row.dataset.index = opt.index;
    row.innerHTML = '<span></span>';
    row.firstChild.textContent = opt.name;
    row.addEventListener('click', () => selectQuality(opt.index, opt.name));
    list.append(row);
  }

  const level = lowQuality ? lightestLevel() : chosenLevel();
  if (level >= 0) hls.currentLevel = level;
  updateQualityLabels();
}

// Level picked in the quality menu, or -1 for automatic.
function chosenLevel() {
  return hls.levels.findIndex(level => levelName(level) === settings.quality);
}

// Smallest variant that still has video (audio-only would starve the video buffer).
function lightestLevel() {
  let best = -1;
  hls.levels.forEach((level, i) => {
    if (level.height && (best < 0 || level.bitrate < hls.levels[best].bitrate)) best = i;
  });
  return best;
}

function selectQuality(index, name) {
  if (!hls) return;
  hls.currentLevel = index;
  settings.quality = index < 0 ? 'auto' : name;
  setSettings({ quality: settings.quality });
  updateQualityLabels();
  showMenuView('main');
}

function updateQualityLabels() {
  if (!hls) return;
  const auto = hls.autoLevelEnabled;
  const current = hls.levels[hls.currentLevel];
  const currentName = current ? levelName(current) : '';
  $('quality-value').textContent = auto ? `Automático${currentName ? ` (${currentName})` : ''}` : currentName;
  for (const row of $('quality-list').children) {
    const index = Number(row.dataset.index);
    row.classList.toggle('checked', auto ? index === -1 : index === hls.currentLevel);
    if (index === -1) row.firstChild.textContent = auto && currentName ? `Automático (${currentName})` : 'Automático';
  }
}

/* ---------- Ad status ---------- */

// Kept discreet: a short toast when an ad break starts, plus a line in the
// channel info overlay while it lasts.
function setAdStatus(status) {
  const wasClean = adStatus.mode === 'clean';
  adStatus = status;
  const state = $('ad-state');
  if (status.mode === 'clean') {
    state.hidden = true;
    return;
  }
  state.hidden = false;
  // Pre-roll with no clean backup yet: say why nothing is showing.
  if (status.mode === 'waiting' && !$('overlay').hidden && video.readyState < 3) {
    showOverlay('Anúncio bloqueado. A live começa em instantes…');
  }
  state.textContent = status.mode === 'backup'
    ? `Anúncio bloqueado · stream reserva${status.name ? ` ${status.name}` : ''}`
    : 'Anúncio bloqueado';
  if (wasClean) toast('Anúncio bloqueado', 2500);
}

/* ---------- Overlay / toast ---------- */

function showOverlay(text, { static: isStatic = false, actions = [] } = {}) {
  const overlay = $('overlay');
  overlay.hidden = false;
  overlay.classList.toggle('static', isStatic);
  $('overlay-text').textContent = text;
  const box = $('overlay-actions');
  box.textContent = '';
  for (const a of actions) {
    const el = document.createElement(a.href ? 'a' : 'button');
    el.textContent = a.label;
    if (a.href) el.href = a.href;
    if (a.onClick) el.addEventListener('click', a.onClick);
    box.append(el);
  }
  $('big-play').hidden = true;
}

function hideOverlay() {
  $('overlay').hidden = true;
}

let toastTimer = 0;
function toast(text, ms = 3000) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/* ---------- Controls ---------- */

let wake = () => {};

function setupControls() {
  const playBtn = $('btn-play');
  const muteBtn = $('btn-mute');
  const volume = $('volume');

  const syncPlay = () => {
    playBtn.classList.toggle('playing', !video.paused);
    playBtn.dataset.tip = video.paused ? 'Play (k)' : 'Pausar (k)';
    $('big-play').hidden = !video.paused || !$('overlay').hidden;
    wake();
  };
  const syncVolume = () => {
    const muted = video.muted || video.volume === 0;
    muteBtn.classList.toggle('muted', muted);
    muteBtn.dataset.tip = muted ? 'Ativar som (m)' : 'Mudo (m)';
    volume.value = video.muted ? 0 : video.volume;
    volume.style.background = '';
  };

  video.addEventListener('play', () => {
    pauseIntended = false;
    syncPlay();
  });
  video.addEventListener('pause', () => {
    // Paused by the browser while playing in the background: keep going.
    if (!pauseIntended && settings.background && inBackground() && !video.ended) {
      video.play().catch(() => {});
      return;
    }
    // Pausing a live stream means coming back behind the live edge.
    setRewinding(true);
    syncPlay();
  });
  video.addEventListener('playing', () => {
    hideOverlay();
    syncPlay();
  });
  video.addEventListener('waiting', () => {
    if (adStatus.mode === 'waiting') showOverlay('Anúncio bloqueado. A live volta em instantes…');
    else showOverlay('');
  });

  let saveTimer = 0;
  video.addEventListener('volumechange', () => {
    syncVolume();
    if (!video.muted) $('unmute-hint').hidden = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      settings.volume = video.volume;
      settings.muted = video.muted;
      setSettings({ volume: video.volume, muted: video.muted });
    }, 400);
  });

  const togglePlay = () => (video.paused ? video.play().catch(() => {}) : pause());
  // Media keys, OS media controls and the PiP window go through these, so their
  // pauses count as the user's.
  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', () => video.play().catch(() => {}));
    navigator.mediaSession.setActionHandler('pause', pause);
  }
  const toggleMute = () => {
    video.muted = !video.muted;
    if (!video.muted && video.volume === 0) video.volume = 0.5;
  };
  const changeVolume = delta => {
    video.muted = false;
    video.volume = Math.min(1, Math.max(0, video.volume + delta));
    volume.classList.add('show');
    clearTimeout(changeVolume.t);
    changeVolume.t = setTimeout(() => volume.classList.remove('show'), 1200);
    toast(`Volume ${Math.round(video.volume * 100)}%`, 900);
  };
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else stage.requestFullscreen().catch(() => {});
  };
  const togglePip = async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch {
      toast('Picture-in-picture indisponível');
    }
  };

  playBtn.addEventListener('click', togglePlay);
  $('big-play').addEventListener('click', togglePlay);
  muteBtn.addEventListener('click', toggleMute);
  volume.addEventListener('input', () => {
    video.volume = Number(volume.value);
    video.muted = video.volume === 0;
  });
  $('unmute-hint').addEventListener('click', () => { video.muted = false; });
  $('btn-live').addEventListener('click', goLive);
  $('btn-fullscreen').addEventListener('click', toggleFullscreen);
  $('menu-pip').addEventListener('click', () => {
    closeMenus();
    togglePip();
  });
  $('btn-chat').addEventListener('click', toggleChat);

  video.addEventListener('click', () => {
    if (closeMenus()) return;
    togglePlay();
  });
  video.addEventListener('dblclick', toggleFullscreen);
  document.addEventListener('fullscreenchange', () => {
    $('btn-fullscreen').dataset.tip = document.fullscreenElement ? 'Sair da tela cheia (f)' : 'Tela cheia (f)';
  });

  // Show controls on activity; hide them after a few seconds while playing.
  let idleTimer = 0;
  const canHide = () => !video.paused && !menuOpen();
  wake = () => {
    stage.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (canHide()) stage.classList.add('idle');
    }, 3000);
  };
  stage.addEventListener('mousemove', wake);
  stage.addEventListener('mousedown', wake);
  stage.addEventListener('mouseleave', () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (canHide()) stage.classList.add('idle');
    }, 1000);
  });

  document.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName) && document.activeElement.type !== 'range' && document.activeElement.type !== 'checkbox') return;
    switch (e.key.toLowerCase()) {
      case ' ':
      case 'k': togglePlay(); break;
      case 'm': toggleMute(); break;
      case 'f': toggleFullscreen(); break;
      case 'c': toggleChat(); break;
      case 'i': togglePip(); break;
      case 'l': goLive(); break;
      case 'r': openMenu('replay-menu'); break;
      case 'g': toggleRecording(); break;
      case 'arrowleft': seekTo(video.currentTime - 10); toast('-10s', 700); break;
      case 'arrowright': seekTo(video.currentTime + 10); toast('+10s', 700); break;
      case 'arrowup': changeVolume(0.05); break;
      case 'arrowdown': changeVolume(-0.05); break;
      case 'escape': if (!closeMenus()) return; break;
      default: return;
    }
    e.preventDefault();
    wake();
  });

  syncPlay();
  syncVolume();
}

/* ---------- Menus ---------- */

function menuOpen() {
  return !$('settings-menu').hidden || !$('replay-menu').hidden;
}

function closeMenus() {
  const wasOpen = menuOpen();
  $('settings-menu').hidden = true;
  $('replay-menu').hidden = true;
  $('controls').classList.remove('menu-open');
  $('btn-settings').classList.remove('active');
  $('btn-replay').classList.remove('active');
  return wasOpen;
}

function openMenu(id) {
  const menu = $(id);
  const wasHidden = menu.hidden;
  closeMenus();
  if (!wasHidden) return;
  menu.hidden = false;
  $('controls').classList.add('menu-open');
  $(id === 'settings-menu' ? 'btn-settings' : 'btn-replay').classList.add('active');
  if (id === 'settings-menu') showMenuView('main');
  if (id === 'replay-menu') updateReplayMenu();
  wake();
}

function showMenuView(view) {
  $('view-main').hidden = view !== 'main';
  $('view-quality').hidden = view !== 'quality';
}

function setupMenus() {
  $('btn-settings').addEventListener('click', e => {
    e.stopPropagation();
    openMenu('settings-menu');
  });
  $('btn-replay').addEventListener('click', e => {
    e.stopPropagation();
    openMenu('replay-menu');
  });
  for (const menu of document.querySelectorAll('.menu')) menu.addEventListener('click', e => e.stopPropagation());
  document.addEventListener('click', closeMenus);

  $('open-quality').addEventListener('click', () => showMenuView('quality'));
  $('quality-back').addEventListener('click', () => showMenuView('main'));

  $('opt-enabled').checked = settings.enabled;
  $('opt-lowlatency').checked = settings.lowLatency;
  $('opt-background').checked = settings.background;
  $('opt-stats').checked = settings.stats;
  $('stats').hidden = !settings.stats;

  $('opt-enabled').addEventListener('change', e => {
    settings.enabled = e.target.checked;
    setSettings({ enabled: settings.enabled });
  });
  $('opt-lowlatency').addEventListener('change', e => {
    settings.lowLatency = e.target.checked;
    setSettings({ lowLatency: settings.lowLatency });
    applyLowLatency();
  });
  $('opt-background').addEventListener('change', e => {
    settings.background = e.target.checked;
    setSettings({ background: settings.background });
  });
  $('opt-stats').addEventListener('change', e => {
    settings.stats = e.target.checked;
    setSettings({ stats: settings.stats });
    $('stats').hidden = !settings.stats;
    updateStats();
  });

  // The same options can be changed from the toolbar popup.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if ('enabled' in changes) $('opt-enabled').checked = settings.enabled = changes.enabled.newValue;
    if ('background' in changes) $('opt-background').checked = settings.background = changes.background.newValue;
    if ('lowLatency' in changes && changes.lowLatency.newValue !== settings.lowLatency) {
      $('opt-lowlatency').checked = settings.lowLatency = changes.lowLatency.newValue;
      applyLowLatency();
    }
  });
}

function applyLowLatency() {
  if (!hls) return;
  hls.config.liveSyncDurationCount = settings.lowLatency ? 2 : 3;
  setRewinding(rewinding);
}

/* ---------- Seek bar (rewind inside the buffered window) ---------- */

function seekWindow() {
  const r = video.seekable;
  if (!hls || !r.length) return null;
  const start = r.start(0);
  const end = liveEdge();
  return end - start >= 15 ? { start, end } : null;
}

function setupSeekBar() {
  const seek = $('seek');
  const tip = $('seek-tip');
  let dragging = false;

  const timeAt = clientX => {
    const w = seekWindow();
    if (!w) return null;
    const rect = $('seek-track').getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return { time: w.start + ratio * (w.end - w.start), ratio, rect, w };
  };

  const showTip = clientX => {
    const at = timeAt(clientX);
    if (!at) return;
    const behind = at.w.end - at.time;
    tip.textContent = behind < 1 ? 'AO VIVO' : `-${formatTime(behind)}`;
    tip.style.left = `${at.ratio * at.rect.width + 4}px`;
    tip.hidden = false;
  };

  seek.addEventListener('mousemove', e => showTip(e.clientX));
  seek.addEventListener('mouseleave', () => { if (!dragging) tip.hidden = true; });
  seek.addEventListener('mousedown', e => {
    dragging = true;
    showTip(e.clientX);
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => { if (dragging) showTip(e.clientX); });
  document.addEventListener('mouseup', e => {
    if (!dragging) return;
    dragging = false;
    tip.hidden = true;
    const at = timeAt(e.clientX);
    if (at) seekTo(at.time);
  });
}

function updateSeekBar() {
  const w = seekWindow();
  $('seek').hidden = !w;
  if (!w) return;
  const ratio = Math.min(1, Math.max(0, (video.currentTime - w.start) / (w.end - w.start)));
  $('seek-fill').style.width = `${ratio * 100}%`;
  $('seek-thumb').style.left = `${ratio * 100}%`;
}

/* ---------- Replay / recording ---------- */

function fileStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

async function saveEntries(entries, label) {
  if (!entries.length) {
    toast('Nada para salvar ainda');
    return;
  }
  toast('Preparando arquivo…');
  try {
    const files = await replay.buildFiles(entries);
    const stamp = fileStamp();
    files.forEach((f, i) => {
      const part = files.length > 1 ? `_parte${i + 1}` : '';
      download(f.blob, `${login}_${label}_${stamp}${part}.${f.ext}`);
    });
    const total = files.reduce((s, f) => s + f.seconds, 0);
    toast(`${label === 'replay' ? 'Replay' : 'Gravação'} salvo (${formatTime(total)})`);
  } catch (err) {
    console.warn('[ATP] save failed', err);
    toast('Não foi possível salvar o arquivo');
  }
}

function updateReplayMenu() {
  const available = replay.availableSeconds;
  for (const btn of $('replay-menu').querySelectorAll('[data-seconds]')) {
    btn.disabled = available < 5;
  }
  $('replay-note').textContent = available < 5
    ? 'Aguardando alguns segundos de vídeo…'
    : `Disponível: ${formatTime(Math.min(available, REWIND_SECONDS))} · o arquivo é salvo na pasta de downloads`;
}

function setupReplay() {
  for (const btn of $('replay-menu').querySelectorAll('[data-seconds]')) {
    btn.addEventListener('click', () => {
      closeMenus();
      saveEntries(replay.last(Number(btn.dataset.seconds)), 'replay');
    });
  }
  $('btn-record').addEventListener('click', toggleRecording);
}

function toggleRecording() {
  if (replay.recording) {
    const entries = replay.stopRecording();
    updateRecording();
    saveEntries(entries, 'gravacao');
  } else {
    replay.startRecording();
    updateRecording();
    toast('Gravando… clique de novo para parar e salvar');
  }
}

function updateRecording() {
  const info = replay.recordingInfo;
  const btn = $('btn-record');
  btn.classList.toggle('recording', !!info);
  stage.classList.toggle('recording', !!info);
  btn.dataset.tip = info ? 'Parar e salvar gravação (g)' : 'Gravar (g)';
  $('rec-indicator').hidden = !info;
  if (info) $('rec-text').textContent = `REC ${formatTime(info.elapsed)} · ${(info.bytes / 1048576).toFixed(0)} MB`;
  if (!$('replay-menu').hidden) updateReplayMenu();
}

/* ---------- Background playback ---------- */

// "Continuar em segundo plano" on: a hidden tab keeps playing on the lightest
// variant (nobody sees it; saves bandwidth and decoding) and the chosen quality
// comes back on return. Off: the player is torn down while hidden and reconnects
// at the live edge on return. PiP and an ongoing recording always keep the
// stream as it is.
const LOW_QUALITY_DELAY = 10_000; // quick tab switches keep the quality
let hiddenTimer = 0;
let lowQuality = false;
let suspended = false;

function inBackground() {
  return document.hidden && !document.pictureInPictureElement;
}

function setupBackground() {
  document.addEventListener('visibilitychange', applyBackground);
  video.addEventListener('enterpictureinpicture', applyBackground);
  video.addEventListener('leavepictureinpicture', applyBackground);
  applyBackground();
}

function applyBackground() {
  clearTimeout(hiddenTimer);
  if (!inBackground()) {
    if (suspended) {
      suspended = false;
      start();
      return;
    }
    setLowQuality(false);
    // Fell behind while hidden (throttled or frozen tab): back to the live edge.
    if (hls && !rewinding && !video.paused && liveEdge() - video.currentTime > 8) goLive();
    return;
  }
  if (replay.recording) return;
  if (!settings.background) {
    suspended = true;
    destroyPlayer();
    clearTimeout(restartTimer);
    return;
  }
  hiddenTimer = setTimeout(() => setLowQuality(true), LOW_QUALITY_DELAY);
}

function setLowQuality(value) {
  if (lowQuality === value) return;
  lowQuality = value;
  if (!hls?.levels.length) return;
  // Down: no flush, the buffered seconds play out. Up: flush after the current segment.
  if (value) hls.loadLevel = lightestLevel();
  else hls.nextLevel = chosenLevel();
}

/* ---------- Stats ---------- */

function updateStats() {
  if (!settings?.stats || !hls) return;
  const level = hls.levels[hls.currentLevel];
  const b = video.buffered;
  let ahead = 0;
  for (let i = 0; i < b.length; i++) {
    if (video.currentTime >= b.start(i) && video.currentTime <= b.end(i)) ahead = b.end(i) - video.currentTime;
  }
  const q = video.getVideoPlaybackQuality?.();
  const lines = [
    `Qualidade   ${level ? levelName(level) : '-'}${hls.autoLevelEnabled ? ' (auto)' : ''}`,
    `Resolução   ${video.videoWidth}x${video.videoHeight}`,
    `Bitrate     ${level ? (level.bitrate / 1e6).toFixed(1) : '-'} Mbps`,
    `Banda       ${(hls.bandwidthEstimate / 1e6).toFixed(1)} Mbps`,
    `Buffer      ${ahead.toFixed(1)} s`,
    `Atraso      ${Number.isFinite(hls.latency) ? hls.latency.toFixed(1) : '-'} s`,
    `Velocidade  ${video.playbackRate.toFixed(2)}x`,
    `Frames perdidos ${q ? q.droppedVideoFrames : '-'}`,
    `Anúncios    ${adStatus.mode === 'clean' ? 'nenhum' : adStatus.mode === 'backup' ? `stream reserva (${adStatus.type})` : 'removendo'}`,
  ];
  $('stats').textContent = lines.join('\n');
}

/* ---------- Chat ---------- */

function applyChat() {
  $('app').classList.toggle('chat-on', settings.chat);
  $('btn-chat').classList.toggle('active', settings.chat);
  $('btn-chat').dataset.tip = settings.chat ? 'Ocultar chat (c)' : 'Mostrar chat (c)';
  const frame = $('chat-frame');
  if (settings.chat && !frame.src) frame.src = `https://www.twitch.tv/popout/${login}/chat?darkpopout`;
}

const CHAT_MIN = 240;
const CHAT_DEFAULT = 340;
const chatMax = () => Math.max(CHAT_MIN, Math.round(innerWidth * 0.6));
const clampChat = w => Math.min(chatMax(), Math.max(CHAT_MIN, Math.round(w)));

function setChatWidth(width) {
  document.documentElement.style.setProperty('--chat-w', `${clampChat(width)}px`);
}

function setupChatResize() {
  const handle = $('chat-resize');
  const app = $('app');
  setChatWidth(settings.chatWidth);
  addEventListener('resize', () => setChatWidth(settings.chatWidth));

  handle.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    app.classList.add('resizing');
    const startX = e.clientX;
    const startWidth = $('chat').getBoundingClientRect().width;

    const move = ev => {
      settings.chatWidth = clampChat(startWidth + (startX - ev.clientX));
      setChatWidth(settings.chatWidth);
    };
    const up = () => {
      app.classList.remove('resizing');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      setSettings({ chatWidth: settings.chatWidth });
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });

  handle.addEventListener('dblclick', () => {
    settings.chatWidth = CHAT_DEFAULT;
    setChatWidth(CHAT_DEFAULT);
    setSettings({ chatWidth: CHAT_DEFAULT });
  });
}

function toggleChat() {
  settings.chat = !settings.chat;
  setSettings({ chat: settings.chat });
  applyChat();
}
