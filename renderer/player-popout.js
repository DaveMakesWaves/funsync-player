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
import { eventBus } from './js/event-bus.js';
import { applySeason } from './js/holiday.js';
import { installConsoleForwarding } from './js/logger.js';
import { watchWcoClass } from './js/wco.js';
import { layoutKey } from './js/keyboard-layout.js';
import { localizeChordPart } from './js/keyboard-help.js';
import { targetOwnsKey } from './js/keyboard.js';
import { playedSeconds, isAudioPath } from './js/video-load-check.js';
import { setPlayerAudioTile } from './js/player-audio-tile.js';
import { setEdgeCarryNotice } from './js/edge-hold-carry.js';
import { isPictureStarved, ProgressWatch } from './js/playback-stall.js';
import { showUpdateAvailableToast, showUpdateReadyToast } from './js/update-toasts.js';
import {
  createIcons, Play, Pause, RotateCcw, Volume2, Volume1, VolumeX,
  ChevronDown, PictureInPicture2, Maximize, Minimize, Repeat1,
  EllipsisVertical, Gauge, Keyboard, SkipBack, SkipForward,
  Activity, Thermometer, Captions, icon,
} from './js/icons.js';
import { VideoPlayer } from './js/video-player.js';
import { ProgressBar } from './js/progress-bar.js';
import { InlineViz } from './components/inline-viz.js';
import { UpNextCard } from './components/up-next-card.js';
import { wireMenuKeys, moveMenuFocus, focusMenuFromKeyboard } from './js/menu-keys.js';
import {
  INITIAL_STATE, LOAD_VIDEO, SEEK, SET_PLAY_STATE, SET_RATE, SET_VOLUME, SET_LOOP,
  HEATMAP, CHAPTERS, VARIANTS, SWITCH_VARIANT, QUEUE_STATE, LOAD_PREV, LOAD_NEXT,
  UP_NEXT, UP_NEXT_ACTION, THEME, LOCALE, READY, TIME_TICK, VIDEO_EVENT, VIDEO_META,
  SET_INLINE_VIZ, INLINE_VIZ_STATE, ORGASM_HOLD, EDGE_HOLD, EDGE_NOTICE, SUBTITLE, STOP_ALL, makeMessage, classifyMessage,
} from './js/player-popout-protocol.js';

try { installConsoleForwarding(); } catch { /* non-fatal */ }
// Frameless window → the page owns the drag region (.ppo-dragstrip).
// Kept in step with the overlay for the whole session, not just at boot (FT-055).
watchWcoClass({ where: 'player pop-out' });

const $ = (id) => document.getElementById(id);
const loadingEl = $('player-popout-loading');
const containerEl = $('ppo-container');
const video = $('video');

let _i18nReady = false;
let _hasVideo = false;
let _tickTimer = null;
let videoPlayer = null;
let progressBar = null;
let inlineViz = null;
// TL/HM state seeded from INITIAL_STATE; the pop-out has no settings store,
// so main persists the flags (SET_INLINE_VIZ) and both windows stay in step.
const _vizState = { timeline: false, heatmap: false };
let upNextCard = null;
let _backendPort = null;
// Metadata for the up-next card the engine (in main) last asked us to show.
// The card resolves its title/duration via a library shim keyed on this.
let _upNextMeta = null;
// Repaints the loop chip + menu state; set up in setupPlayer so SET_LOOP
// from main can refresh the same UI the local toggle does.
let _updateLoopUI = null;
// READY goes out once, and only once setupPlayer() has run. Main answers it
// with INITIAL_STATE + LOAD_VIDEO, and a LOAD_VIDEO that lands before the
// VideoPlayer exists is dropped. It used to be sent from both 'opened' and
// the i18n init, so main sent the state and the video twice (V17).
let _setupDone = false;
let _readySent = false;

function send(payload) { window.funsync?.playerPopoutRelay?.('to-parent', payload); }
/** X / Z held down in this window (the press was sent, the release not yet). */
const _holdKeys = { orgasm: false, edge: false };

function sendReady() {
  if (!_setupDone || _readySent) return;
  _readySent = true;
  send(makeMessage(READY));
}

/**
 * Wire the TL/HM checkbox items in the overflow menu. Mirrors the main
 * window's behaviour: aria-checked drives the CSS tick, and the toggle is
 * relayed up so main can persist it (the pop-out has no settings store).
 */
function _wireInlineVizToggles() {
  const wire = (btnId, key, apply) => {
    const btn = $(btnId);
    if (!btn) return;
    btn.addEventListener('click', () => {
      const on = !_vizState[key];
      _vizState[key] = on;
      apply(on);
      btn.setAttribute('aria-checked', String(on));
      send(makeMessage(SET_INLINE_VIZ, { key, on }));
    });
  };
  wire('btn-inline-tl', 'timeline', (on) => inlineViz?.setTimelineVisible(on));
  wire('btn-inline-hm', 'heatmap', (on) => inlineViz?.setHeatmapVisible(on));
}

// --- Caption strip (Windows Controls Overlay) ---------------------------
// Matches the main window's PLAYER VIEW exactly: transparent background so
// the buttons sit on the video rather than a solid nav-bar-coloured block,
// white symbols (the video behind is dark whatever the app theme), and the
// symbols hiding along with the control bar. Without this the pop-out kept
// the themed strip it was created with and looked nothing like the main
// window (Dave 2026-08-04).
let _captionState = null;
let _popoutTheme = 'dark';

/** Caption-button strip in CSS px relative to the content area, or null. */
function _captionRect() {
  const wco = navigator.windowControlsOverlay;
  if (!wco?.visible) return null;
  try {
    const r = wco.getTitlebarAreaRect();
    const left = r.x + r.width;
    const width = Math.max(0, window.innerWidth - left);
    if (width <= 0) return null;
    return { x: left, y: 0, width, height: r.height || 48 };
  } catch {
    return null;
  }
}

function syncCaptionOverlay(visible = null) {
  if (!window.funsync?.updateWindowChrome) return;
  // Fullscreen has no caption strip at all — nothing to sync.
  if (document.fullscreenElement) return;
  const shown = visible === null
    ? !!containerEl?.classList.contains('controls-visible')
    : !!visible;
  const next = shown ? 'over-video' : 'over-video-hidden';
  if (_captionState === next) return;
  _captionState = next;
  try {
    window.funsync.updateWindowChrome(_popoutTheme, {
      overVideo: true,
      hideSymbols: !shown,
      captionRect: _captionRect(),
    });
  } catch { /* non-fatal */ }
}

/** Apply TL/HM state from main (INITIAL_STATE) without echoing it back. */
function _applyInlineVizState(state) {
  if (!state) return;
  _vizState.timeline = state.timeline === true;
  _vizState.heatmap = state.heatmap === true;
  inlineViz?.setTimelineVisible(_vizState.timeline);
  inlineViz?.setHeatmapVisible(_vizState.heatmap);
  // HM playhead marker (#381): the main window's setting, read when the
  // pop-out opens. A change while it is open arrives as INLINE_VIZ_STATE.
  inlineViz?.setHeatmapPlayhead(state.playhead === true);
  // Over or under the video, as the main window (#381).
  inlineViz?.setPlacement?.(state.placement);
  // The Timeline's window and playhead, as the main window (#381).
  if (state.timelineView) inlineViz?.setTimelineView?.(state.timelineView);
  $('btn-inline-tl')?.setAttribute('aria-checked', String(_vizState.timeline));
  $('btn-inline-hm')?.setAttribute('aria-checked', String(_vizState.heatmap));
  _applyInlineVizOpacity(state.opacity);
}

/** The overlay opacity (percent, clamped 20-100), as the main window applies it. */
function _applyInlineVizOpacity(value) {
  const pct = Number(value);
  if (value === null || value === undefined || !Number.isFinite(pct)) return;
  document.documentElement.style.setProperty(
    '--inline-viz-opacity', String(Math.min(100, Math.max(20, pct)) / 100),
  );
}

/**
 * Settings > Playback changed the HM playhead marker or the overlay opacity
 * while this window is open (FT-028: before, it took effect only on the next
 * open). Applied here; nothing is sent back, main already saved it.
 */
function _applyInlineVizLive(state) {
  if (!state) return;
  if (typeof state.playhead === 'boolean') inlineViz?.setHeatmapPlayhead(state.playhead);
  if (state.placement === 'below' || state.placement === 'overlay') inlineViz?.setPlacement?.(state.placement);
  if (state.timelineView) inlineViz?.setTimelineView?.(state.timelineView);
  _applyInlineVizOpacity(state.opacity);
}
function applyTheme(theme) {
  if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;
  // Retint this window's native chrome too. Previously the pop-out only
  // restyled its CSS, so after a theme switch its caption strip kept the
  // colours it was CREATED with while the main window updated — a visible
  // mismatch between the two windows.
  if (theme === 'dark' || theme === 'light' || theme === 'system') _popoutTheme = theme;
  _captionState = null; // force re-apply with the new colours
  syncCaptionOverlay();
}
function applyStyle(style) {
  // No-op on undefined (a theme-only message must not reset the style).
  if (style === 'classic' || style === 'modern') document.documentElement.dataset.style = style;
}

// The Holiday style's palette (v0.10.1): the main window sends its season with
// the style. No snow in a pop-out. No-op on undefined, like applyStyle.
function applyPopoutSeason(season) {
  if (season === undefined) return;
  applySeason(season === 'holiday' ? 'holiday' : null, document, { snow: false });
}

// --- clock streaming up to main (drives the device-sync proxy) ---
// N-01: a stall fires no 'pause', and `paused` stayed false through it, so
// main's proxy kept "playing" at a frozen time while the Handy ran 12 s
// ahead, and when the picture moved again nothing re-anchored it
// (reproduced 2026-11-16). Each tick also says whether the picture is
// stalled: starved, seeking or failed (the phone's remote-sync.js test), or
// a time that has not moved for a second. `paused` stays the element's own
// flag, which main's Play/Pause toggle needs.
const _progress = new ProgressWatch();
function stallState() {
  const paused = !!video.paused;
  const starved = isPictureStarved(video);
  // Starved counts as accounted for, so the watch restarts its window when
  // the picture moves again instead of reporting the stall's old one.
  const frozen = _progress.sample(video.currentTime || 0, paused || starved, performance.now());
  return { paused, stalled: !paused && (starved || frozen) };
}
function sendTick() {
  const { paused, stalled } = stallState();
  send(makeMessage(TIME_TICK, {
    timeMs: Math.round((video.currentTime || 0) * 1000),
    paused,
    stalled,
    rate: video.playbackRate || 1,
    loop: !!video.loop, // main suppresses Up Next / auto-advance while looping
    ...decodeReport(),
  }));
}

/**
 * What main's no-frames check needs from THIS window's <video> (E-10, also
 * in v0.9.2): with the player popped out it skipped the check (the inline
 * copy is paused and hidden), so a track that has a size but decodes no
 * frames played black here with no message. Frames decoded so far (null when
 * the browser cannot say), seconds actually played, and whether this window
 * is hidden (a minimised window may legitimately skip decoding).
 */
function decodeReport() {
  let frames = null;
  try {
    const q = video.getVideoPlaybackQuality?.();
    if (q && typeof q.totalVideoFrames === 'number') frames = q.totalVideoFrames;
  } catch { /* unknown */ }
  return {
    frames,
    playedSec: Math.round(playedSeconds(video) * 1000) / 1000,
    hidden: document.visibilityState === 'hidden',
  };
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

/**
 * Re-apply, in the new language, everything this window paints from state.
 * setLocale() walks the static data-i18n keys and only then emits
 * language:changed, so this runs after the walk. The walk alone reset
 * "Loop video" to "Off" with loop on and a muted video's button to "Mute"
 * (app test V69). It always lands late on open: main's READY handoff sends
 * SET_VOLUME and SET_LOOP while the INITIAL_STATE locale is still loading.
 * The Up Next card redraws itself.
 */
function retranslateWindow() {
  _updateLoopUI?.();
  videoPlayer?.refreshLabels?.();
  // An open shortcut card was built in the old language and has no data-i18n
  // keys for the walk: build it again (FT-065).
  const card = document.getElementById('ppo-shortcuts');
  if (card) { card.remove(); showShortcutsHelp(); }
  render();
}

/**
 * The CC button: its icon and an on / off switch, as the main window has
 * (app.js). It showed here as a blank square that did nothing once the
 * main window started sending subtitles (full manual test, 2026-11-23).
 * The track it switches on is the newest: an emptied one from an earlier
 * video can stay in the list.
 */
function wireSubtitleButton() {
  const badge = $('subtitle-badge');
  if (!badge || badge.dataset.wired) return;
  badge.dataset.wired = '1';
  badge.appendChild(icon(Captions, { width: 20, height: 20, 'stroke-width': 1.75 }));
  badge.setAttribute('role', 'button');
  badge.setAttribute('tabindex', '0');
  badge.setAttribute('data-i18n-aria-label', 'app.toggleSubtitles');
  badge.setAttribute('aria-label', t('app.toggleSubtitles'));
  badge.style.cursor = 'pointer';
  const toggle = () => {
    const tracks = [...(video?.textTracks || [])];
    if (!tracks.length) return;
    const showing = tracks.some((tr) => tr.mode === 'showing');
    for (const tr of tracks) tr.mode = 'disabled';
    if (!showing) tracks[tracks.length - 1].mode = 'showing';
    badge.classList.toggle('subtitle-badge--active', !showing);
  };
  badge.addEventListener('click', toggle);
  badge.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  });
}

// --- build the reused player once i18n is ready ---
function setupPlayer() {
  // Render the lucide icons baked into the copied DOM.
  createIcons({
    icons: {
      Play, Pause, RotateCcw, Volume2, Volume1, VolumeX,
      ChevronDown, PictureInPicture2, Maximize, Minimize, Repeat1,
      EllipsisVertical, Gauge, Keyboard, SkipBack, SkipForward,
      // Inline TL/HM overlay toggles in the overflow menu.
      Activity, Thermometer,
    },
    attrs: { width: 20, height: 20, 'stroke-width': 1.75 },
  });
  translatePage(document);

  videoPlayer = new VideoPlayer({
    videoElement: video,
    controlsElement: $('controls'),
    containerElement: containerEl,
  });
  wireSubtitleButton();
  progressBar = new ProgressBar({
    containerElement: $('progress-container'),
    videoPlayer,
    backendPort: _backendPort,
  });
  // A Stash marker's hover label in this window's language, worded as the
  // main window's (app.js _applyStashMarkers; s1-review-a RA-S1-6). t()
  // reads the current language at hover time, so a live switch follows.
  progressBar.stashMarkerLabel = (title) => (title
    ? t('player.stashMarker', { title })
    : t('player.stashMarkerUntitled'));
  // Hover scrubbing preview and the marker label (same wiring the inline
  // player uses, app.js): the chapter, bookmark or Stash marker under the
  // cursor is named above the thumbnail. Before the Stash fix-up
  // (RA-S1-6) this window drew its markers but never named them on hover.
  videoPlayer.onProgressHover = (timeSeconds, xPx, widthPx) => {
    progressBar.updateThumbnailPreview(timeSeconds);
    progressBar.updateScriptPreview?.(timeSeconds);
    if (Number.isFinite(xPx) && Number.isFinite(widthPx)) {
      progressBar.updateMarkerTooltip(xPx, widthPx, (videoPlayer.duration || 0) * 1000);
    }
  };

  // Inline TL/HM overlays — the SAME component as the inline player, fed by
  // the actions main already streams for the seek-bar heatmap.
  inlineViz = new InlineViz({ container: containerEl, video });
  _wireInlineVizToggles();

  // Caption buttons follow the control bar, same as the main window's player.
  videoPlayer.onControlsVisibilityChanged = (visible) => syncCaptionOverlay(visible);
  document.addEventListener('fullscreenchange', () => {
    // Leaving fullscreen brings the strip back — re-assert the current state.
    _captionState = null;
    syncCaptionOverlay();
  });
  syncCaptionOverlay();

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
    // Resume choice. The label is resolved in main (only it can read the
    // play context and settings) and arrives on the UP_NEXT 'show' payload;
    // null means no row, same as in the main window.
    getResumeChoice: (p) => (_upNextMeta && _upNextMeta.path === p && _upNextMeta.resumeLabel
      ? { label: _upNextMeta.resumeLabel }
      : null),
    onStartOver: () => send(makeMessage(UP_NEXT_ACTION, { action: 'start-over' })),
  });

  // Stream the local <video>'s clock + events up so main's proxy (and thus
  // the devices) follow. VideoPlayer handles the UI; these are additive.
  video.addEventListener('play', () => {
    startTicks();
    // A tick first (N-01): it tells main whether the picture can move yet,
    // so a Play on a position still loading does not start the devices
    // ahead of it; the 'play' below then only ends a hang's hold (FT-098).
    sendTick();
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
  // Volume lives in main's settings (player.volume); report every change,
  // from this window's slider or from main's own volume keys, so main can
  // keep the saved value and its next relative step in step (V13).
  video.addEventListener('volumechange', () => {
    send(makeMessage(VIDEO_EVENT, { event: 'volumechange', volume: video.volume, muted: video.muted }));
  });

  // Buffering / hand-off spinner.
  video.addEventListener('waiting', () => showSpinner(true));
  video.addEventListener('seeking', () => showSpinner(true));
  video.addEventListener('playing', () => showSpinner(false));
  video.addEventListener('canplay', () => showSpinner(false));
  video.addEventListener('seeked', () => showSpinner(false));
  // Stall boundaries push a tick at once (N-01), as the phone does: each one
  // flips `stalled`, which holds or releases the devices in main, and the
  // 100 ms cadence alone would let a device run on (or wait) that long.
  // Only while ticks stream: a paused window has nothing to hold.
  const stallBoundary = () => { if (_tickTimer) sendTick(); };
  for (const ev of ['waiting', 'seeking', 'stalled', 'playing', 'canplay', 'error']) {
    video.addEventListener(ev, stallBoundary);
  }

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
  // The main window's arrow keys in the menu (menu-keys.js; document runs
  // before this window's player keys on window), and Escape closes it here
  // too (it never did in this window), the focus back on ⋮.
  if (overflowBtn && overflowMenu) {
    wireMenuKeys(overflowBtn, overflowMenu, {
      close: () => { overflowMenu.hidden = true; overflowBtn.setAttribute('aria-expanded', 'false'); },
    });
  }

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
  // A rate set from main (SET_RATE, its < / > keys) repaints the chip too.
  // And every change is reported up at once: ticks only stream during
  // playback, so while paused main's proxy kept the old rate, and its
  // < / > keys stepped from that (V13).
  video.addEventListener('ratechange', () => {
    updateSpeedUI(video.playbackRate || 1);
    sendTick();
  });
  // The main window's keys (menu-keys.js; B089, break-it 2026-11-25): opened
  // from the keyboard the focus goes to the current speed, the arrows move
  // through the speeds (they changed the volume), Escape closes it (it never
  // did here) and gives the focus back to where it was opened from.
  let speedAnchor = null;
  const openSpeedPopover = (anchor = null, fromKeyboard = false) => {
    speedPopover.replaceChildren();
    const cur = video.playbackRate || 1;
    SPEEDS.forEach((s) => {
      const b = document.createElement('button');
      b.className = 'speed-popover__item' + (s === cur ? ' is-active' : '');
      b.setAttribute('role', 'menuitem');
      b.textContent = `${s}×`;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        // Chosen with Enter: the focus back to where it was opened from
        // (read before the rate, as in main, where the list re-renders).
        const hadFocus = speedPopover.contains(document.activeElement);
        applyRate(s);
        if (hadFocus) speedAnchor?.focus();
        speedPopover.hidden = true;
      });
      speedPopover.appendChild(b);
    });
    speedPopover.hidden = false;
    speedAnchor = anchor;
    if (fromKeyboard) focusMenuFromKeyboard(speedPopover, '.speed-popover__item.is-active');
  };
  $('speed-chip')?.addEventListener('click', (e) => { e.stopPropagation(); speedPopover.hidden ? openSpeedPopover($('speed-chip'), e.detail === 0) : (speedPopover.hidden = true); });
  $('btn-speed-menu')?.addEventListener('click', (e) => { e.stopPropagation(); overflowMenu.hidden = true; openSpeedPopover(overflowBtn, e.detail === 0); });
  document.addEventListener('keydown', (e) => {
    if (!speedPopover || speedPopover.hidden || e.key !== 'Escape') return;
    e.preventDefault();
    if (speedPopover.contains(document.activeElement)) speedAnchor?.focus();
    speedPopover.hidden = true;
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (moveMenuFocus(speedPopover, e.key)) e.preventDefault();
  });

  // Loop — LOCAL (video.loop on the pop-out's element).
  const updateLoopUI = () => {
    const on = video.loop;
    if ($('loop-chip')) $('loop-chip').hidden = !on;
    if ($('loop-video-state')) $('loop-video-state').textContent = on ? t('player.loopVideo.stateOn') : t('player.loopVideo.stateOff');
    $('btn-loop-video')?.setAttribute('aria-checked', String(on));
  };
  _updateLoopUI = updateLoopUI;
  // Tick at once so main's Up Next suppression follows the loop flag even
  // while paused (ticks only stream during playback).
  const toggleLoop = () => { video.loop = !video.loop; updateLoopUI(); sendTick(); };
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
  // The View menu's F11 (an F11 a focused control kept): the player's
  // fullscreen, never the window's (Dave 2026-11-22).
  window.funsync?.onMenuToggleFullscreen?.(() => videoPlayer?.toggleFullscreen());
  window.addEventListener('keydown', (e) => {
    // The main window's rule (keyboard.js targetOwnsKey, C-01): a focused
    // control keeps only the keys it uses. This returned for ANY focused
    // <input>, so the volume slider, once Tab had focused it, swallowed
    // Space, K, F, M and the arrows (E-01, also in v0.9.2). A key the
    // focused control already handled (the seek bar's arrows, Enter or
    // Space on the Up Next card) is not acted on a second time either.
    if (targetOwnsKey(e)) return;
    // layoutKey (FT-035): the Latin letter on the key when the layout types
    // another alphabet, so K, F, M, J, L, P, N work on a Russian or Korean
    // layout too; they matched e.key ('л', 'а', …) and did nothing (CB-07).
    switch (layoutKey(e)) {
      // Shift+Space: Stop all (DESIGN.md §2.15). This window's video pauses
      // at once; main stops every device and every other source.
      case ' ':
        e.preventDefault();
        if (e.shiftKey) { video.pause(); send(makeMessage(STOP_ALL)); break; }
        videoPlayer.togglePlay();
        break;
      case 'k': e.preventDefault(); videoPlayer.togglePlay(); break;
      case 'f': case 'F': videoPlayer.toggleFullscreen(); break;
      // F11 is the player's fullscreen too (Dave 2026-11-22), never the
      // window's: taken here, the View menu's F11 never sees it.
      case 'F11': e.preventDefault(); videoPlayer.toggleFullscreen(); break;
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
      // X (Orgasm Switch) and Z (Edge Hold), as in the main window
      // (keyboard.js): the press is sent once (keydown auto-repeats while
      // the key is held), the release on keyup below. Main applies hold or
      // toggle as set (next major, Dave 2026-11-17).
      case 'x': case 'X':
        e.preventDefault();
        if (!_holdKeys.orgasm) { _holdKeys.orgasm = true; send(makeMessage(ORGASM_HOLD, { active: true })); }
        break;
      case 'z': case 'Z':
        e.preventDefault();
        if (!_holdKeys.edge) { _holdKeys.edge = true; send(makeMessage(EDGE_HOLD, { active: true })); }
        break;
      // ? opens this window's shortcut card, as it opens the main window's
      // list; it opened only from the overflow menu here. Escape closes it
      // (R3 fix-up, real-app verifier 1).
      case '?': e.preventDefault(); showShortcutsHelp(); break;
      case 'Escape': {
        const card = document.getElementById('ppo-shortcuts');
        if (card) { e.preventDefault(); card.remove(); }
        break;
      }
      default: break;
    }
  });
  // The release of a hold started above. Like the main window's keyup
  // (keyboard.js _onKeyUp) it is not gated on focus: a hold that started
  // must always end, even if a control took the focus meanwhile. The same
  // layoutKey as the press, so a Russian layout's ч / я end what they began.
  window.addEventListener('keyup', (e) => {
    const key = layoutKey(e);
    if ((key === 'x' || key === 'X') && _holdKeys.orgasm) {
      _holdKeys.orgasm = false;
      send(makeMessage(ORGASM_HOLD, { active: false }));
    }
    if ((key === 'z' || key === 'Z') && _holdKeys.edge) {
      _holdKeys.edge = false;
      send(makeMessage(EDGE_HOLD, { active: false }));
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
  // Chords in canonical English, each alternative rendered through the
  // keys.* names like the main window's ? overlay (localizeChordPart,
  // CB-08), so a German card reads Leertaste / Umschalt+L instead of
  // "Space / K", "Shift + L" (R3-24).
  const rows = [
    ['Space / K', t('player.play')],
    ['Left / Right', t('kbd.seek5s')],
    ['J / L', t('kbd.seek10s')],
    ['M', t('player.mute')],
    ['F', t('player.fullscreen')],
    ['< / >', t('player.speed.menuLabel')],
    ['Shift+L', t('player.loopVideo.menuLabel')],
    ['P / N', t('player.previous') + ' / ' + t('player.next')],
    ['Shift+Space', t('kbd.stopAll')],
  ];
  const card = document.createElement('div');
  card.className = 'ppo-shortcuts__card';
  const title = document.createElement('h2');
  title.textContent = t('player.keyboardShortcuts');
  card.appendChild(title);
  for (const [keys, desc] of rows) {
    const row = document.createElement('div');
    row.className = 'ppo-shortcuts__row';
    const chord = document.createElement('span');
    chord.className = 'ppo-shortcuts__keys';
    for (const part of keys.split(/\s*\/\s*/)) {
      if (chord.children.length) chord.appendChild(document.createTextNode(' / '));
      const kbd = document.createElement('kbd');
      kbd.textContent = localizeChordPart(part);
      chord.appendChild(kbd);
    }
    const text = document.createElement('span');
    text.textContent = desc;
    row.append(chord, text);
    card.appendChild(row);
  }
  el.appendChild(card);
  el.addEventListener('click', () => el.remove());
  document.body.appendChild(el);
}

// --- load / switch the video ---
function loadVideo({ src, timeMs, autoplay, title }) {
  if (!src || !videoPlayer) return;
  // An audio file: the audio tile, as the main player shows it (S033).
  setPlayerAudioTile(document.getElementById('video-wrapper'),
    isAudioPath(decodeURIComponent(String(src).split(/[?#]/)[0])) ? (title || decodeURIComponent(String(src).split('/').pop())) : null);
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
function renderVariants(list, activeLabel, activeText, extra = {}) {
  const selector = $('variant-selector');
  const dropdown = $('variant-dropdown');
  const label = $('variant-btn-label');
  if (!selector || !dropdown) return;
  const variants = Array.isArray(list) ? list : [];
  if (variants.length < 2) { selector.hidden = true; return; }
  selector.hidden = false;
  // `text` is the label as shown (main names an unlabelled script by its
  // file, FN-03); `label` stays what a switch is matched on.
  const shown = (v) => v?.text || v?.label || '';
  // The playing entry by place when main says it (`activeIndex`, -1: none
  // plays), else by label as before.
  const activeAt = Number.isInteger(extra.activeIndex)
    ? extra.activeIndex
    : variants.findIndex((v) => (v.label || '') === activeLabel);
  const active = activeAt >= 0 ? variants[activeAt] : null;
  // `activeText`: no entry plays (removed in Manage variations while it
  // played); main names the script that does, and nothing is marked.
  if (label) label.textContent = active ? shown(active) : (activeText || activeLabel || shown(variants[0]));
  dropdown.replaceChildren();
  variants.forEach((v, i) => {
    const item = document.createElement('button');
    item.className = 'variant-selector__item';
    // The same look as the inline menu (FN-03): tinted, ticked and announced
    // as current. It used to get `is-active`, which no stylesheet styles, so
    // the pop-out marked nothing.
    const playing = i === activeAt;
    if (playing) {
      item.classList.add('variant-selector__item--active');
      item.setAttribute('aria-current', 'true');
    }
    const check = document.createElement('span');
    check.className = 'variant-selector__check';
    check.setAttribute('aria-hidden', 'true');
    check.textContent = playing ? '✓' : '';
    const name = document.createElement('span');
    name.className = 'variant-selector__item-label';
    name.textContent = shown(v);
    item.append(check, name);
    if (v.main && extra.mainTag) {
      const main = document.createElement('span');
      main.className = 'variant-selector__main-tag';
      main.textContent = extra.mainTag;
      item.appendChild(main);
    }
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.hidden = true;
      send(makeMessage(SWITCH_VARIANT, { label: v.label }));
    });
    dropdown.appendChild(item);
    markVariantItemIfMissing(item, v.path);
  });
}

/**
 * A variation whose file is gone: dimmed, "Script not found", not offered,
 * as the main window's menu and the video options dialog mark it
 * (2026-11-22; also in v0.9.2). Only a definite "absent" marks it; a check
 * that cannot answer leaves the row as it is.
 */
function markVariantItemIfMissing(item, path) {
  const api = window.funsync;
  if (!path || typeof api?.filesExist !== 'function') return;
  Promise.resolve(api.filesExist([path])).then((answer) => {
    if (!Array.isArray(answer) || answer[0] !== false || !item.isConnected) return;
    item.disabled = true;
    item.classList.add('variant-selector__item--missing');
    const tag = document.createElement('span');
    tag.className = 'variant-selector__missing-tag';
    tag.textContent = t('videoOptions.script.status.missing');
    const name = item.querySelector('.variant-selector__item-label');
    if (name) name.after(tag); else item.appendChild(tag);
  }, () => { /* unknown: leave the row as it is */ });
}

// --- Up Next card (engine in main; this is the view) ---
function handleUpNext(payload) {
  if (!upNextCard) return;
  switch (payload.action) {
    case 'show':
      _upNextMeta = {
        path: payload.path, name: payload.name,
        duration: payload.duration, hasFunscript: payload.hasFunscript,
        resumeLabel: payload.resumeLabel || null,
      };
      upNextCard.show(payload.path, payload.countdownSec);
      break;
    case 'thumb':
      // No picture to show (an audio file): the grey logo tile (N-05).
      if (payload.thumbNoVideo) upNextCard.setNoVideoThumbnail(payload.path, { stream: !!payload.thumbStream });
      else upNextCard.setThumbnail(payload.path, payload.thumbDataUrl);
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
      applyStyle(payload.uiStyle); applyPopoutSeason(payload.season);
      if (typeof payload.backendPort === 'number') _backendPort = payload.backendPort;
      _applyInlineVizState(payload.inlineViz);
      if (payload.locale) setLocale(payload.locale).then(() => { _i18nReady = true; render(); });
      else render();
      if (payload.video) loadVideo(payload.video);
      break;
    case LOAD_VIDEO: loadVideo(payload); break;
    case EDGE_NOTICE: setEdgeCarryNotice(document.getElementById('video-wrapper'), payload?.text || null); break;
    case SEEK: try { video.currentTime = (payload.timeMs || 0) / 1000; } catch { /* ignore */ } break;
    case SET_PLAY_STATE: if (payload.paused) video.pause(); else video.play().catch(() => {}); break;
    case SET_RATE: if (payload.rate > 0) videoPlayer?.setPlaybackRate?.(payload.rate); break;
    case SET_VOLUME:
      // Muted first: setVolume repaints the mute button from video.muted.
      if (typeof payload.muted === 'boolean') video.muted = payload.muted;
      if (typeof payload.volume === 'number') videoPlayer?.setVolume?.(payload.volume);
      else if (typeof payload.muted === 'boolean') videoPlayer?.setVolume?.(video.volume);
      break;
    case SET_LOOP:
      video.loop = payload.loop === true;
      _updateLoopUI?.();
      break;
    case HEATMAP:
      if (Array.isArray(payload.actions)) {
        const durSec = (payload.durationMs || 0) / 1000;
        progressBar?.renderHeatmap(payload.actions, durSec);
        // Same data drives the inline overlays; the menu items only appear
        // once there's a script to visualise (matches the main window).
        inlineViz?.setScript(payload.actions, durSec);
        const has = payload.actions.length >= 2;
        const tl = $('btn-inline-tl');
        const hm = $('btn-inline-hm');
        if (tl) tl.hidden = !has;
        if (hm) hm.hidden = !has;
      }
      break;
    case CHAPTERS:
      if (progressBar) {
        progressBar.setMarkers({ chapters: payload.chapters || [], bookmarks: payload.bookmarks || [] });
        progressBar.setStashMarkers?.(payload.stashMarkers || []); // Stash S1: next to the chapters
        if (payload.durationMs) progressBar.renderChapterStrip((payload.durationMs) / 1000);
      }
      break;
    case VARIANTS: renderVariants(payload.list, payload.activeLabel, payload.activeText, payload); break;
    case QUEUE_STATE: renderQueueState(payload); break;
    case UP_NEXT: handleUpNext(payload); break;
    case INLINE_VIZ_STATE: _applyInlineVizLive(payload); break;
    case THEME: applyTheme(payload.theme); applyStyle(payload.uiStyle); applyPopoutSeason(payload.season); break;
    // The video's subtitles, from the main window (2026-11-22: none showed).
    case SUBTITLE:
      if (payload.name && typeof payload.text === 'string') {
        videoPlayer?.loadSubtitles({ name: payload.name, textContent: payload.text }, { show: payload.show !== false });
      } else {
        videoPlayer?.clearSubtitles();
      }
      break;
    // A live switch in the main window (V50). setLocale walks the static
    // data-i18n keys itself, then its language:changed runs
    // retranslateWindow(), which re-applies what this window owns (V69).
    case LOCALE: if (payload.locale) setLocale(payload.locale).then(() => { render(); }); break;
    default: break;
  }
}

// --- update notices (FT-101) ---
// The updater in main sends its events to this window too: someone watching
// here never saw "Update available" or "ready to install" (also in v0.9.2).
// Same toasts as the main window (update-toasts.js), in this window's
// language once it has one.
function onUpdateEvent(channel, data) {
  if (channel === 'update:available') showUpdateAvailableToast(data || {});
  else if (channel === 'update:downloaded') showUpdateReadyToast(data || {});
}

// --- bootstrap ---
window.funsync?.onUpdateEvent?.(onUpdateEvent);
eventBus.on('language:changed', retranslateWindow);
window.funsync?.onPlayerPopoutEvent?.((evt) => {
  if (!evt) return;
  if (evt.type === 'opened') { sendReady(); return; }
  if (evt.type === 'closed') return;
  if (evt.type === 'message') onMessage(evt.payload);
});

initI18n({ savedLocale: 'en' }).then(() => {
  _i18nReady = true;
  setupPlayer();
  _setupDone = true;
  sendReady();
  render();
}).catch((err) => {
  console.warn('[player-window] initI18n failed:', err);
  _i18nReady = true;
  try { setupPlayer(); } catch (e) { console.warn('[player-window] setupPlayer failed:', e); }
  _setupDone = true;
  sendReady();
  render();
});
