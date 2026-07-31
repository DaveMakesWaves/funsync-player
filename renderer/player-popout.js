// Player pop-out — detached-window renderer (Phase 2, full parity).
//
// The pop-out is the PLAYBACK AUTHORITY: it owns the only decoding <video>
// and REUSES the same VideoPlayer + ProgressBar classes as the inline
// player (its DOM mirrors their contract), so the control bar, heatmap,
// chapters, thumbnails and tooltips are the real components, not
// re-implementations. Its clock streams up to the main window, where a
// RemotePlaybackProxy feeds the device sync engines. Bucket 3 (Devices /
// Editor / queue / back / playlist) lives in the main window.

import { t, initI18n, setLocale, translatePage } from './js/i18n.js';
import { installConsoleForwarding } from './js/logger.js';
import {
  createIcons, Play, Pause, RotateCcw, Volume2, Volume1, VolumeX,
  ChevronDown, PictureInPicture2, Maximize, Minimize, Repeat1,
  EllipsisVertical, Gauge, Keyboard, SkipBack, SkipForward,
} from './js/icons.js';
import { VideoPlayer } from './js/video-player.js';
import { ProgressBar } from './js/progress-bar.js';
import { UpNextCard } from './components/up-next-card.js';
import {
  INITIAL_STATE, LOAD_VIDEO, SEEK, SET_PLAY_STATE, SET_RATE, SET_VOLUME,
  HEATMAP, CHAPTERS, VARIANTS, SWITCH_VARIANT, QUEUE_STATE, LOAD_PREV, LOAD_NEXT,
  UP_NEXT, UP_NEXT_ACTION, THEME, LOCALE, READY, TIME_TICK, VIDEO_EVENT, VIDEO_META,
  makeMessage, classifyMessage,
} from './js/player-popout-protocol.js';

try { installConsoleForwarding(); } catch { /* non-fatal */ }

const $ = (id) => document.getElementById(id);
const loadingEl = $('player-popout-loading');
const containerEl = $('ppo-container');
const video = $('video');

let _i18nReady = false;
let _hasVideo = false;
let _tickTimer = null;
let videoPlayer = null;
let progressBar = null;
let upNextCard = null;
let _backendPort = null;
// Metadata for the up-next card the engine (in main) last asked us to show.
// The card resolves its title/duration via a library shim keyed on this.
let _upNextMeta = null;

function send(payload) { window.funsync?.playerPopoutRelay?.('to-parent', payload); }
function applyTheme(theme) {
  if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;
}
function applyStyle(style) {
  // No-op on undefined (a theme-only message must not reset the style).
  if (style === 'classic' || style === 'modern') document.documentElement.dataset.style = style;
}

// --- clock streaming up to main (drives the device-sync proxy) ---
function sendTick() {
  send(makeMessage(TIME_TICK, {
    timeMs: Math.round((video.currentTime || 0) * 1000),
    paused: !!video.paused,
    rate: video.playbackRate || 1,
    loop: !!video.loop, // main suppresses Up Next / auto-advance while looping
  }));
}
function startTicks() { if (!_tickTimer) _tickTimer = setInterval(sendTick, 100); }
function stopTicks() { if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = null; } }

function showSpinner(on) { const s = $('ppo-spinner'); if (s) s.hidden = !on; }

function renderQueueState({ hasPrev, hasNext, label } = {}) {
  const prev = $('btn-prev'); const next = $('btn-next'); const ind = $('queue-indicator');
  if (prev) prev.hidden = !hasPrev;
  if (next) next.hidden = !hasNext;
  if (ind) { ind.hidden = !label; ind.textContent = label || ''; }
}

function render() {
  if (!_i18nReady) return;
  if (loadingEl && !_hasVideo) loadingEl.textContent = t('player.windowWaiting');
}

// --- build the reused player once i18n is ready ---
function setupPlayer() {
  // Render the lucide icons baked into the copied DOM.
  createIcons({
    icons: {
      Play, Pause, RotateCcw, Volume2, Volume1, VolumeX,
      ChevronDown, PictureInPicture2, Maximize, Minimize, Repeat1,
      EllipsisVertical, Gauge, Keyboard, SkipBack, SkipForward,
    },
    attrs: { width: 20, height: 20, 'stroke-width': 1.75 },
  });
  translatePage(document);

  videoPlayer = new VideoPlayer({
    videoElement: video,
    controlsElement: $('controls'),
    containerElement: containerEl,
  });
  progressBar = new ProgressBar({
    containerElement: $('progress-container'),
    videoPlayer,
    backendPort: _backendPort,
  });
  // Hover scrubbing preview (same wiring the inline player uses).
  videoPlayer.onProgressHover = (timeSeconds) => progressBar.updateThumbnailPreview(timeSeconds);

  // Up Next countdown card — the SAME component as the inline player. The
  // engine (queue + funscript + countdown) lives in main; here it's a pure
  // view fed over the protocol. The library shim returns the metadata main
  // streamed with the `show` message; interactions relay back up so the
  // one authoritative engine handles play-now / dismiss / hover-pause.
  upNextCard = new UpNextCard({
    element: $('up-next-card'),
    library: {
      getVideoByPath: (p) => (_upNextMeta && _upNextMeta.path === p
        ? { name: _upNextMeta.name, duration: _upNextMeta.duration, hasFunscript: _upNextMeta.hasFunscript }
        : null),
    },
    captureFrame: null, // thumbnail arrives via UP_NEXT 'thumb' → setThumbnail
    onPlayNext: () => send(makeMessage(UP_NEXT_ACTION, { action: 'play' })),
    onDismiss: () => send(makeMessage(UP_NEXT_ACTION, { action: 'dismiss' })),
    onHoverEnter: () => send(makeMessage(UP_NEXT_ACTION, { action: 'pause' })),
    onHoverLeave: () => send(makeMessage(UP_NEXT_ACTION, { action: 'resume' })),
    onBackToSource: () => send(makeMessage(UP_NEXT_ACTION, { action: 'back' })),
  });

  // Stream the local <video>'s clock + events up so main's proxy (and thus
  // the devices) follow. VideoPlayer handles the UI; these are additive.
  video.addEventListener('play', () => {
    startTicks();
    send(makeMessage(VIDEO_EVENT, { event: 'play', timeMs: Math.round(video.currentTime * 1000) }));
  });
  video.addEventListener('pause', () => {
    stopTicks();
    sendTick(); // final tick so the proxy freezes at the exact spot
    send(makeMessage(VIDEO_EVENT, { event: 'pause', timeMs: Math.round(video.currentTime * 1000) }));
  });
  video.addEventListener('seeked', () => {
    send(makeMessage(VIDEO_EVENT, { event: 'seeked', timeMs: Math.round(video.currentTime * 1000) }));
  });
  video.addEventListener('ended', () => {
    stopTicks();
    send(makeMessage(VIDEO_EVENT, { event: 'ended', timeMs: Math.round(video.currentTime * 1000) }));
  });

  // Buffering / hand-off spinner.
  video.addEventListener('waiting', () => showSpinner(true));
  video.addEventListener('seeking', () => showSpinner(true));
  video.addEventListener('playing', () => showSpinner(false));
  video.addEventListener('canplay', () => showSpinner(false));
  video.addEventListener('seeked', () => showSpinner(false));

  // Variant selector — click relays the chosen label up; main does the
  // actual switch (loads script, re-uploads to cloud devices) and streams
  // back fresh VARIANTS/HEATMAP.
  $('variant-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const dd = $('variant-dropdown');
    if (dd) dd.hidden = !dd.hidden;
  });

  // Overflow (⋮) menu — speed / loop / help.
  const overflowMenu = $('controls-overflow-menu');
  const overflowBtn = $('btn-overflow');
  overflowBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    overflowMenu.hidden = !overflowMenu.hidden;
    overflowBtn.setAttribute('aria-expanded', String(!overflowMenu.hidden));
  });

  // Playback speed — LOCAL (the pop-out <video> is the authority; the rate
  // is streamed up in every TIME_TICK so the device proxy scales too).
  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  const speedPopover = $('speed-popover');
  const updateSpeedUI = (rate) => {
    const txt = `${rate}×`;
    const chip = $('speed-chip');
    if ($('speed-chip-label')) $('speed-chip-label').textContent = txt;
    if ($('speed-menu-current')) $('speed-menu-current').textContent = txt;
    if (chip) chip.hidden = (rate === 1);
  };
  const applyRate = (rate) => { videoPlayer.setPlaybackRate(rate); updateSpeedUI(rate); };
  const openSpeedPopover = () => {
    speedPopover.replaceChildren();
    const cur = video.playbackRate || 1;
    SPEEDS.forEach((s) => {
      const b = document.createElement('button');
      b.className = 'speed-popover__item' + (s === cur ? ' is-active' : '');
      b.textContent = `${s}×`;
      b.addEventListener('click', (e) => { e.stopPropagation(); applyRate(s); speedPopover.hidden = true; });
      speedPopover.appendChild(b);
    });
    speedPopover.hidden = false;
  };
  $('speed-chip')?.addEventListener('click', (e) => { e.stopPropagation(); speedPopover.hidden ? openSpeedPopover() : (speedPopover.hidden = true); });
  $('btn-speed-menu')?.addEventListener('click', (e) => { e.stopPropagation(); overflowMenu.hidden = true; openSpeedPopover(); });

  // Loop — LOCAL (video.loop on the pop-out's element).
  const updateLoopUI = () => {
    const on = video.loop;
    if ($('loop-chip')) $('loop-chip').hidden = !on;
    if ($('loop-video-state')) $('loop-video-state').textContent = on ? t('player.loopVideo.stateOn') : t('player.loopVideo.stateOff');
    $('btn-loop-video')?.setAttribute('aria-checked', String(on));
  };
  const toggleLoop = () => { video.loop = !video.loop; updateLoopUI(); };
  $('btn-loop-video')?.addEventListener('click', (e) => { e.stopPropagation(); overflowMenu.hidden = true; toggleLoop(); });
  $('loop-chip')?.addEventListener('click', (e) => { e.stopPropagation(); toggleLoop(); });

  // Keyboard-shortcuts help overlay.
  $('btn-help')?.addEventListener('click', (e) => { e.stopPropagation(); overflowMenu.hidden = true; showShortcutsHelp(); });

  // Queue prev/next — relayed to main, which advances the queue and loads
  // the next/prev video back into this window.
  $('btn-prev')?.addEventListener('click', () => send(makeMessage(LOAD_PREV)));
  $('btn-next')?.addEventListener('click', () => send(makeMessage(LOAD_NEXT)));

  // Close all popovers/menus on any outside click.
  document.addEventListener('click', () => {
    const dd = $('variant-dropdown'); if (dd) dd.hidden = true;
    if (overflowMenu) overflowMenu.hidden = true;
    if (speedPopover) speedPopover.hidden = true;
  });

  // Global keyboard (VideoPlayer only binds per-element handlers; the
  // app-level keyboard.js isn't loaded in this renderer).
  const cycleSpeed = (dir) => {
    const cur = video.playbackRate || 1;
    let i = SPEEDS.indexOf(cur);
    if (i < 0) i = SPEEDS.indexOf(1);
    i = Math.max(0, Math.min(SPEEDS.length - 1, i + dir));
    applyRate(SPEEDS[i]);
  };
  window.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    switch (e.key) {
      case ' ': case 'k': e.preventDefault(); videoPlayer.togglePlay(); break;
      case 'f': case 'F': videoPlayer.toggleFullscreen(); break;
      case 'm': case 'M': videoPlayer.toggleMute(); break;
      case 'ArrowLeft': e.preventDefault(); video.currentTime = Math.max(0, video.currentTime - 5); break;
      case 'ArrowRight': e.preventDefault(); video.currentTime = Math.min(video.duration || 1e9, video.currentTime + 5); break;
      case 'j': video.currentTime = Math.max(0, video.currentTime - 10); break;
      case 'l': video.currentTime = Math.min(video.duration || 1e9, video.currentTime + 10); break;
      case '<': case ',': cycleSpeed(-1); break;
      case '>': case '.': cycleSpeed(1); break;
      case 'L': if (e.shiftKey) toggleLoop(); break;
      case 'p': e.preventDefault(); send(makeMessage(LOAD_PREV)); break;
      case 'n': e.preventDefault(); send(makeMessage(LOAD_NEXT)); break;
      default: break;
    }
  });
}

// Minimal keyboard-shortcuts overlay for the detached window.
function showShortcutsHelp() {
  let el = document.getElementById('ppo-shortcuts');
  if (el) { el.remove(); return; }
  el = document.createElement('div');
  el.id = 'ppo-shortcuts';
  el.className = 'ppo-shortcuts';
  const rows = [
    ['Space / K', t('player.play')],
    ['← / →', '± 5s'],
    ['J / L', '± 10s'],
    ['M', t('player.mute')],
    ['F', t('player.fullscreen')],
    ['< / >', t('player.speed.menuLabel')],
    ['Shift + L', t('player.loopVideo.menuLabel')],
    ['P / N', t('player.previous') + ' / ' + t('player.next')],
  ];
  el.innerHTML = `<div class="ppo-shortcuts__card"><h2>${t('player.keyboardShortcuts')}</h2>${
    rows.map(([k, v]) => `<div class="ppo-shortcuts__row"><kbd>${k}</kbd><span>${v}</span></div>`).join('')
  }</div>`;
  el.addEventListener('click', () => el.remove());
  document.body.appendChild(el);
}

// --- load / switch the video ---
function loadVideo({ src, timeMs, autoplay, title }) {
  if (!src || !videoPlayer) return;
  _hasVideo = true;
  if (loadingEl) loadingEl.hidden = true;
  containerEl.hidden = false;
  if (title) document.title = `FunSync Player — ${title}`;
  showSpinner(true); // until the new video can actually play
  videoPlayer.loadSource(src, title || '');
  progressBar?.setVideoSource(src);
  const seekTo = (timeMs || 0) / 1000;
  const onLoaded = () => {
    try { if (seekTo > 0) video.currentTime = seekTo; } catch { /* ignore */ }
    if (autoplay) video.play().catch(() => { /* autoplay blocked; user clicks */ });
    send(makeMessage(VIDEO_META, {
      src, durationMs: Math.round((video.duration || 0) * 1000),
      width: video.videoWidth, height: video.videoHeight,
    }));
  };
  video.addEventListener('loadedmetadata', onLoaded, { once: true });
}

// --- render funscript-driven overlays (data streamed from main) ---
function renderVariants(list, activeLabel) {
  const selector = $('variant-selector');
  const dropdown = $('variant-dropdown');
  const label = $('variant-btn-label');
  if (!selector || !dropdown) return;
  const variants = Array.isArray(list) ? list : [];
  if (variants.length < 2) { selector.hidden = true; return; }
  selector.hidden = false;
  if (label) label.textContent = activeLabel || variants[0]?.label || '';
  dropdown.replaceChildren();
  variants.forEach((v) => {
    const item = document.createElement('button');
    item.className = 'variant-selector__item';
    if ((v.label || '') === activeLabel) item.classList.add('is-active');
    item.textContent = v.label || '';
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.hidden = true;
      send(makeMessage(SWITCH_VARIANT, { label: v.label }));
    });
    dropdown.appendChild(item);
  });
}

// --- Up Next card (engine in main; this is the view) ---
function handleUpNext(payload) {
  if (!upNextCard) return;
  switch (payload.action) {
    case 'show':
      _upNextMeta = {
        path: payload.path, name: payload.name,
        duration: payload.duration, hasFunscript: payload.hasFunscript,
      };
      upNextCard.show(payload.path, payload.countdownSec);
      break;
    case 'thumb':
      upNextCard.setThumbnail(payload.path, payload.thumbDataUrl);
      break;
    case 'tick':
      upNextCard.tick(payload.remaining);
      break;
    case 'end':
      upNextCard.showEndOfList(payload.sourceLabel, {});
      break;
    case 'hide':
      upNextCard.hide();
      _upNextMeta = null;
      break;
    default: break;
  }
}

// --- incoming messages from main ---
function onMessage(payload) {
  const type = classifyMessage(payload);
  if (!type) return;
  switch (type) {
    case INITIAL_STATE:
      applyTheme(payload.theme);
      applyStyle(payload.uiStyle);
      if (typeof payload.backendPort === 'number') _backendPort = payload.backendPort;
      if (payload.locale) setLocale(payload.locale).then(() => { _i18nReady = true; render(); });
      else render();
      if (payload.video) loadVideo(payload.video);
      break;
    case LOAD_VIDEO: loadVideo(payload); break;
    case SEEK: try { video.currentTime = (payload.timeMs || 0) / 1000; } catch { /* ignore */ } break;
    case SET_PLAY_STATE: if (payload.paused) video.pause(); else video.play().catch(() => {}); break;
    case SET_RATE: if (payload.rate > 0) videoPlayer?.setPlaybackRate?.(payload.rate); break;
    case SET_VOLUME:
      if (typeof payload.volume === 'number') videoPlayer?.setVolume?.(payload.volume);
      break;
    case HEATMAP:
      if (progressBar && Array.isArray(payload.actions)) {
        progressBar.renderHeatmap(payload.actions, (payload.durationMs || 0) / 1000);
      }
      break;
    case CHAPTERS:
      if (progressBar) {
        progressBar.setMarkers({ chapters: payload.chapters || [], bookmarks: payload.bookmarks || [] });
        if (payload.durationMs) progressBar.renderChapterStrip((payload.durationMs) / 1000);
      }
      break;
    case VARIANTS: renderVariants(payload.list, payload.activeLabel); break;
    case QUEUE_STATE: renderQueueState(payload); break;
    case UP_NEXT: handleUpNext(payload); break;
    case THEME: applyTheme(payload.theme); applyStyle(payload.uiStyle); break;
    case LOCALE: if (payload.locale) setLocale(payload.locale).then(() => { translatePage(document); render(); }); break;
    default: break;
  }
}

// --- bootstrap ---
window.funsync?.onPlayerPopoutEvent?.((evt) => {
  if (!evt) return;
  if (evt.type === 'opened') { send(makeMessage(READY)); return; }
  if (evt.type === 'closed') return;
  if (evt.type === 'message') onMessage(evt.payload);
});

initI18n({ savedLocale: 'en' }).then(() => {
  _i18nReady = true;
  setupPlayer();
  send(makeMessage(READY));
  render();
}).catch((err) => {
  console.warn('[player-window] initI18n failed:', err);
  _i18nReady = true;
  try { setupPlayer(); } catch (e) { console.warn('[player-window] setupPlayer failed:', e); }
  send(makeMessage(READY));
  render();
});
