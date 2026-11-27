// VideoPlayer — HTML5 video wrapper with custom controls

import { showToast } from './toast.js';
import { HLS_QUALITY_CONFIG, normalizeStreamQuality, pickLevelIndex } from './stream-quality.js';
import { t } from './i18n.js';
import { eventBus } from './event-bus.js';
import { VRProjectionRenderer } from './vr-projection-renderer.js';

export const PLAYBACK_RATE_PRESETS = Object.freeze([0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]);

// Non-planar projections — dispatched to the WebGL renderer instead of
// the CSS transform path. Phase 2a ships equirect-180 + fisheye-180;
// Phase 2b adds equirect-360, fisheye-190/200, MKX200, RF52, EAC.
const NONPLANAR_FORMATS = new Set(['equirect-180', 'fisheye-180']);

/**
 * Format seconds into human-readable time string.
 * @param {number} seconds
 * @returns {string} e.g. "1:23" or "1:01:23"
 */
export function formatTime(seconds) {
  if (!isFinite(seconds)) return '0:00';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');

  if (h > 0) {
    return `${h}:${pad(m)}:${pad(sec)}`;
  }
  return `${m}:${pad(sec)}`;
}

/**
 * How far past a frame's START a frame step lands, in seconds.
 *
 * A step used to add n / fps to currentTime and land exactly ON the target
 * frame's start, or (float sums: 30 + 1/30 + 1/30 = 30.0666...63) a hair
 * before it, and Chromium then shows the frame BEFORE: from 30.000 s at 30 fps
 * Right, Right, Left, Left showed frames 901, 901, 900, 900, so half the
 * presses showed no new frame (D-02 real-app check, verify-1, 2026-11-07;
 * also in v0.9.2). A container that counts in whole ms (Matroska) puts a
 * frame's start up to 0.5 ms after n / fps, so the margin is 1 ms: past
 * either, and with snap-to-frame on (the default) a point placed there
 * still snaps to the frame's start. Not a frame's middle: at 60 fps the
 * middle of a 1/30 s step is exactly a 60 fps frame start.
 */
export const FRAME_STEP_MARGIN_SEC = 0.001;

/**
 * Where a step of `frames` frames from `currentTime` lands, in seconds:
 * the frame on screen (the last frame start at or before currentTime) plus
 * `frames`, at FRAME_STEP_MARGIN_SEC past that frame's start, clamped to
 * [0, duration]. The 1e-6 of a frame only absorbs float noise in
 * currentTime * fps.
 * @param {number} currentTime  seconds
 * @param {number} frames       positive = forward, negative = back
 * @param {number} fps
 * @param {number} [duration]   seconds; not finite = no upper clamp
 * @param {number} [phase]      seconds: where the video's frame grid starts
 *   (framePhaseSec). Frames sit at phase + n / fps; 0 assumed a grid from 0,
 *   and a video whose frames are offset (Natsuki: 12.7 ms) landed every step
 *   and point that far from the frame's real start (2026-11-24).
 * @returns {number}
 */
export function frameStepTime(currentTime, frames, fps, duration = Infinity, phase = 0) {
  const rate = fps > 0 && Number.isFinite(fps) ? fps : 30;
  const ph = Number.isFinite(phase) && phase > 0 && phase < 1 / rate ? phase : 0;
  const now = Number.isFinite(currentTime) ? Math.max(0, currentTime) : 0;
  const shown = Math.floor((now - ph) * rate + 1e-6);
  const target = Math.max(0, shown + (Number(frames) || 0));
  const t = ph + target / rate + FRAME_STEP_MARGIN_SEC;
  return Number.isFinite(duration) && duration > 0 ? Math.min(t, duration) : t;
}

/**
 * A probed frame rate as the exact rate. ffprobe's rate reaches the renderer
 * rounded to 2 decimals (29.97), and the NTSC rates are n * 1000 / 1001
 * (29.97002997...): 0.5 ms adrift after 9 minutes on the rounded value. Any
 * other rate is kept as it is; nothing usable (0, NaN, absurd) gives null.
 * @param {number} fps
 * @returns {number|null}
 */
export function exactFrameRate(fps) {
  const n = Number(fps);
  if (!Number.isFinite(n) || n < 1 || n > 1000) return null;
  for (const base of [24, 30, 48, 60, 120, 240]) {
    const ntsc = base * 1000 / 1001;
    if (Math.abs(n - ntsc) < 0.006) return ntsc;
  }
  return n;
}

export class VideoPlayer {
  constructor({ videoElement, controlsElement, containerElement }) {
    this.video = videoElement;
    this.controls = controlsElement;
    this.container = containerElement;

    this._controlsTimeout = null;
    this._cursorTimeout = null;
    this._isSeeking = false;
    // Our own view of the playback rate, tracked separately from
    // `video.playbackRate`: the ELEMENT's value is reset to
    // `defaultPlaybackRate` (1) by the browser whenever a new resource
    // loads, so it can't be used to detect "the rate needs resetting".
    // See `_onMetadataLoaded`.
    this._currentRate = 1;
    // Returns whether the playback rate should carry across videos. A
    // PROVIDER rather than a cached flag so there's no state to keep in
    // sync when the setting changes — nothing subscribes to settings
    // changes in the renderer, and a stale copy here would be invisible.
    this._rememberRateProvider = null;
    this._clickTimer = null;
    this._abLoop = { a: null, b: null };
    this._infoVisible = false;
    this._aspectModes = ['contain', 'cover', '16 / 9', '4 / 3'];
    this._aspectIndex = 0;
    this._centerFlashTimer = null;
    this.onProgressHover = null; // callback: (timeSeconds) => {}
    // Fired only on an actual show/hide transition of the control chrome.
    this.onControlsVisibilityChanged = null; // callback: (visible: boolean) => {}
    this.onSeekDrag = null; // callback: (timeSeconds) => {} — called during scrub
    // Fired when the frame rate or the frame grid's start changes (the
    // editor re-sends them to its pop-out).
    this.onFrameGridChanged = null; // callback: () => {}
    // The video's own frame rate (setFps, from ffprobe); undefined = unknown
    // (30 assumed). Reset by every loadSource.
    this._fps = undefined;
    // The frame on screen, as the browser presented it: { mediaTime } in
    // seconds (requestVideoFrameCallback). null until a frame is presented.
    this._shownFrame = null;
    // Where the frame grid starts, in seconds (frames sit at phase + n / fps).
    this._phase = 0;

    this._cacheElements();
    this._bindEvents();
    this._watchPresentedFrames();
  }

  /**
   * Follow the frames the browser actually presents. Their timestamps are the
   * truth for "the frame on screen", where currentTime is only the time asked
   * for: a point placed while paused belongs at the shown frame's start, and a
   * video whose frames don't start at 0 (Natsuki, D:, 2026-11-24: every frame
   * 12.7 ms after the 29.97 grid) needs that offset to step and snap right.
   * Without requestVideoFrameCallback nothing changes (grid from 0).
   */
  _watchPresentedFrames() {
    const v = this.video;
    if (typeof v?.requestVideoFrameCallback !== 'function') return;
    const onFrame = (_now, meta) => {
      this._onPresentedFrame(meta?.mediaTime);
      v.requestVideoFrameCallback(onFrame);
    };
    v.requestVideoFrameCallback(onFrame);
  }

  /** @param {number} mediaTime  seconds, the presented frame's timestamp */
  _onPresentedFrame(mediaTime) {
    if (!Number.isFinite(mediaTime) || mediaTime < 0) return;
    this._shownFrame = { mediaTime };
    this._learnPhase();
  }

  /** The grid's start from the last presented frame, once the real rate is known. */
  _learnPhase() {
    if (!this._fps || !this._shownFrame) return;
    const dur = 1 / this._fps;
    const t = this._shownFrame.mediaTime;
    let phase = t - Math.floor(t / dur + 1e-6) * dur;
    if (!(phase > 0.00005 && phase < dur - 0.00005)) phase = 0;
    if (Math.abs(phase - this._phase) > 0.0002) {
      this._phase = phase;
      this.onFrameGridChanged?.();
    }
  }

  /** Length of one frame in ms: the video's own rate, or 1/30 s unknown. */
  frameDurationMs() {
    return 1000 / this._estimateFps();
  }

  /** Where the frame grid starts, in seconds (0 until learned). */
  framePhaseSec() {
    return this._phase || 0;
  }

  /**
   * The start of the frame on screen, in ms, while paused: the presented
   * frame's own timestamp. null when not known for sure (playing, seeking, no
   * frame presented since the last seek, or none ever): the caller then uses
   * the frame grid. A frame presented before a step is never taken for the
   * new one: it must start at or before currentTime and less than one frame
   * before it.
   * @returns {number|null}
   */
  shownFrameTimeMs() {
    const v = this.video;
    const shown = this._shownFrame;
    if (!shown || !v || !v.paused || v.seeking) return null;
    const now = v.currentTime;
    if (!Number.isFinite(now)) return null;
    const dur = 1 / this._estimateFps();
    if (shown.mediaTime > now + 0.0005 || now - shown.mediaTime >= dur) return null;
    return shown.mediaTime * 1000;
  }

  _cacheElements() {
    this.btnPlay = document.getElementById('btn-play');
    this.iconPlay = this.btnPlay.querySelector('.icon-play');
    this.iconPause = this.btnPlay.querySelector('.icon-pause');

    this.btnMute = document.getElementById('btn-mute');
    this.iconVolume = this.btnMute.querySelector('.icon-volume');
    this.iconVolumeLow = this.btnMute.querySelector('.icon-volume-low');
    this.iconMuted = this.btnMute.querySelector('.icon-muted');
    this.volumeSlider = document.getElementById('volume-slider');

    this.btnFullscreen = document.getElementById('btn-fullscreen');
    this.iconExpand = this.btnFullscreen.querySelector('.icon-expand');
    this.iconCompress = this.btnFullscreen.querySelector('.icon-compress');

    this.btnPip = document.getElementById('btn-pip');
    // Hide the PiP button when the browser doesn't support it (Chromium
    // on some Linux builds, embedded contexts, etc.). Cheaper than
    // rendering it and silently failing on click — Norman constraints
    // (limit possible actions to prevent invalid ones).
    if (this.btnPip && document.pictureInPictureEnabled === false) {
      this.btnPip.hidden = true;
    }

    this.timeCurrent = document.getElementById('time-current');
    this.timeDuration = document.getElementById('time-duration');

    this.progressContainer = document.getElementById('progress-container');
    this.progressBar = document.getElementById('progress-bar');
    this.progressThumb = document.getElementById('progress-thumb');
    this.bufferedBar = document.getElementById('buffered-bar');

    this.progressTooltip = document.getElementById('progress-tooltip');
    this.tooltipTime = document.getElementById('tooltip-time');

    this.centerPlayBtn = document.getElementById('center-play-btn');
    this.centerIconPlay = this.centerPlayBtn.querySelector('.center-play__icon--play');
    this.centerIconPause = this.centerPlayBtn.querySelector('.center-play__icon--pause');
    this.centerIconReplay = this.centerPlayBtn.querySelector('.center-play__icon--replay');
    this.iconReplay = this.btnPlay.querySelector('.icon-replay');
  }

  _bindEvents() {
    // Play/pause — delayed click avoids conflict with double-click fullscreen
    this.btnPlay.addEventListener('click', () => this.togglePlay());
    this.video.addEventListener('click', () => {
      clearTimeout(this._clickTimer);
      this._clickTimer = setTimeout(() => this.togglePlay(), 250);
    });
    this.video.addEventListener('dblclick', () => {
      clearTimeout(this._clickTimer);
      this.toggleFullscreen();
    });
    this.video.addEventListener('play', () => {
      this._ended = false;
      this._updatePlayButton(true);
      // Remove heatmap preview mode on first play
      this.progressContainer.classList.remove('progress--preview');
    });
    this.video.addEventListener('pause', () => this._updatePlayButton(false));
    this.video.addEventListener('ended', () => this._onEnded());
    // A seek back from the end leaves the video paused there, not ended:
    // Space, K and Play play from the seek, and the button says Play again.
    // `_ended` was cleared only by play, a load or replay, so they replayed
    // from 0:00 under a Replay button (R3 fix-up, verifier 2, also in v0.9.2).
    this.video.addEventListener('seeked', () => {
      if (this._ended && !this.video.ended) {
        this._ended = false;
        this._updatePlayButton(false);
      }
    });

    // Center play/pause overlay — click to toggle
    this.centerPlayBtn.addEventListener('click', () => this.togglePlay());
    // Double-click on center button should fullscreen (same as video)
    this.centerPlayBtn.addEventListener('dblclick', () => {
      clearTimeout(this._clickTimer);
      this.toggleFullscreen();
    });

    // Time updates
    this.video.addEventListener('timeupdate', () => this._onTimeUpdate());
    this.video.addEventListener('loadedmetadata', () => this._onMetadataLoaded());
    this.video.addEventListener('progress', () => this._updateBuffered());

    // Volume
    this.btnMute.addEventListener('click', () => this.toggleMute());
    this.volumeSlider.addEventListener('input', (e) => this.setVolume(e.target.value / 100));
    // A slider set with the mouse gives the focus back when the button comes
    // up (C-01). Left focused, it kept the arrows (1 % volume steps, no 5 s
    // seek) while fullscreen hid the bar, so the keys looked dead "until i
    // click the video". Tab still lands on it, and it keeps its arrows then.
    // The release can land outside the slider after a drag, so it is watched
    // on the document; the blur waits a tick so the slider finishes its own
    // handling of the release first.
    this.volumeSlider.addEventListener('pointerdown', () => { this._volumeByPointer = true; });
    const releaseVolume = () => {
      if (!this._volumeByPointer) return;
      this._volumeByPointer = false;
      setTimeout(() => this._blurVolumeSlider(), 0);
    };
    document.addEventListener('pointerup', releaseVolume, true);
    document.addEventListener('pointercancel', releaseVolume, true);

    // Fullscreen
    this.btnFullscreen.addEventListener('click', () => this.toggleFullscreen());
    document.addEventListener('fullscreenchange', () => {
      this._updateFullscreenButton();
      this._placeCuesForControls(); // a new video height: the cue line follows (R4-05)
    });
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', () => {
        if (this._liftedCues?.size) this._placeCuesForControls();
      });
    }

    // PiP
    this.btnPip.addEventListener('click', () => this.togglePip());

    // Progress bar seeking — mouse drag.
    this.progressContainer.addEventListener('mousedown', (e) => this._startSeek(e));
    this.progressContainer.addEventListener('mousemove', (e) => this._onProgressHover(e));
    document.addEventListener('mousemove', (e) => this._onSeekDrag(e));
    document.addEventListener('mouseup', () => this._endSeek());

    // Keyboard seeking — when the progress bar (role="slider") has
    // focus. Arrow keys = ±5s; Shift = ±1 frame; Home / End jump to
    // start / end. Brings the WCAG 2.1.1 keyboard contract to a control
    // that previously only responded to mouse events.
    this.progressContainer.addEventListener('keydown', (e) => {
      const dur = this.video.duration;
      if (!isFinite(dur) || dur <= 0) return;
      let delta = 0;
      switch (e.key) {
        case 'ArrowLeft':  delta = e.shiftKey ? -1 / this._estimateFps() : -5; break;
        case 'ArrowRight': delta = e.shiftKey ?  1 / this._estimateFps() :  5; break;
        case 'Home':
          e.preventDefault();
          this.video.currentTime = 0;
          return;
        case 'End':
          e.preventDefault();
          this.video.currentTime = Math.max(0, dur - 0.5);
          return;
        default: return;
      }
      e.preventDefault();
      this.video.currentTime = Math.max(0, Math.min(dur, this.video.currentTime + delta));
    });

    // Controls visibility
    this.container.addEventListener('mousemove', () => this._showControls());
    this.container.addEventListener('mouseleave', () => this._hideControlsDelayed());
  }

  // --- Public API ---

  /**
   * Tear down any active hls.js instance. Called before every loadSource so
   * switching from a remote HLS stream back to a local file (or another
   * stream) doesn't leak the MSE pipeline / its event listeners.
   */
  _destroyHls() {
    if (this._hls) {
      // What the line carried: Auto's first pick for a single-file stream.
      const bw = Number(this._hls.bandwidthEstimate);
      if (bw > 0) this.onBandwidth?.(bw);
      try { this._hls.destroy(); } catch { /* already gone */ }
      this._hls = null;
      this.onStreamLevels?.(null);
    }
  }

  /**
   * A stream's quality levels for the player's Quality button: {levels:
   * [{index, height, bitrate}], current (the level playing), auto}. Null
   * when no stream with levels is playing.
   */
  streamLevels() {
    const hls = this._hls;
    if (!hls || !Array.isArray(hls.levels) || !hls.levels.length) return null;
    const current = hls.currentLevel >= 0 ? hls.currentLevel : hls.loadLevel;
    return {
      levels: hls.levels.map((l, i) => ({ index: i, height: l.height || 0, bitrate: l.bitrate || 0 })),
      current,
      auto: hls.autoLevelEnabled !== false && this._streamPref === 'auto',
    };
  }

  /** 'auto' or a height: held for this stream and the next (2026-11-22). */
  setStreamQuality(pref) {
    this._streamPref = normalizeStreamQuality(pref);
    this._applyStreamQuality();
  }

  _applyStreamQuality() {
    const hls = this._hls;
    if (!hls || !Array.isArray(hls.levels) || !hls.levels.length) return;
    // currentLevel switches at once (the buffer is flushed): a chosen height
    // is seen straight away; -1 hands the choice back to hls.js.
    hls.currentLevel = pickLevelIndex(hls.levels, this._streamPref || 'auto');
    this.onStreamLevels?.(this.streamLevels());
  }

  /**
   * Attach a remote HLS (.m3u8) stream via hls.js + Media Source Extensions.
   * Chromium's <video> can't play HLS natively, but hls.js feeds it through
   * MSE into the SAME <video> element — so currentTime / play / pause / seek
   * (and therefore the funscript sync engines) work unchanged. hls.js is
   * dynamically imported so the ~500KB lib only loads when a user actually
   * plays a remote stream. See SCOPE-remote-video-url.md §6.
   */
  async _attachHls(url) {
    this._destroyHls();
    let Hls;
    try {
      ({ default: Hls } = await import('../../node_modules/hls.js/dist/hls.mjs'));
    } catch (err) {
      console.error('[hls] failed to load hls.js:', err);
      this.video.dispatchEvent(new Event('error'));
      return;
    }
    if (Hls.isSupported()) {
      // Quality first (Dave, 2026-11-22: "the quality went really poor"):
      // start high, buffer further ahead, step back up sooner.
      const hls = new Hls({ ...HLS_QUALITY_CONFIG });
      this._hls = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, () => this._applyStreamQuality());
      hls.on(Hls.Events.LEVEL_SWITCHED, () => this.onStreamLevels?.(this.streamLevels()));
      hls.loadSource(url);
      hls.attachMedia(this.video);
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (data?.fatal) {
          console.error('[hls] fatal error:', data.type, data.details);
          // Surface to the same <video> 'error' path the app already handles.
          this.video.dispatchEvent(new Event('error'));
        }
      });
    } else if (this.video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS (Safari-like) — feed the URL directly.
      this.video.src = url;
      this.video.load();
    } else {
      console.error('[hls] MSE not supported and no native HLS');
      this.video.dispatchEvent(new Event('error'));
    }
  }

  /**
   * The same video from a new address, where it was and as it was (playing
   * or paused): an expired stream looked up again, or another quality of a
   * single-file stream (2026-11-23). No hiding, no reset: the engines see a
   * wait and a seek, and follow.
   */
  async swapSource(url, { isHls = false, at = 0, play = false } = {}) {
    const v = this.video;
    const ready = new Promise((resolve) => {
      let timer = null;
      const fin = () => { clearTimeout(timer); v.removeEventListener('loadedmetadata', fin); resolve(); };
      v.addEventListener('loadedmetadata', fin);
      timer = setTimeout(fin, 30_000);
    });
    if (isHls) {
      await this._attachHls(url);
    } else {
      this._destroyHls();
      v.src = url;
      v.load();
    }
    await ready;
    try { if (at > 0) v.currentTime = at; } catch { /* not seekable yet */ }
    if (play) v.play().catch(() => { /* autoplay refused: the user presses Play */ });
  }

  loadSource(url, filename, opts = {}) {
    // Hide the video element AND any active VR projection canvas while
    // the new source decodes its first frame. Without this, both keep
    // painting the LAST frame of the previous video until the new one
    // is ready — visible as a stale-frame leak behind any overlay
    // opened during the transition (e.g. the VR Format modal during a
    // queue auto-advance to a big HEVC VR file, where first-frame
    // decode can take hundreds of ms).
    //
    // VR projection mode is the dominant repro: the underlying <video>
    // is already CSS-hidden, but the WebGL canvas keeps reading frames
    // from it via texImage2D so the OLD frame paints to the projected
    // canvas until the new one decodes. Both surfaces need hiding.
    //
    // `visibility: hidden` rather than `display: none` so layout stays
    // stable and any sibling overlays anchored to the player retain
    // their geometry. Cleared on `loadeddata` (one-shot listener so
    // the hide doesn't persist across subsequent unrelated loads).
    this.video.style.visibility = 'hidden';
    // A new video: its frame rate and frame grid are not known yet (app.js
    // sets the rate from ffprobe; the grid comes from its first frames).
    const hadGrid = !!this._fps || this._phase !== 0;
    this._fps = undefined;
    this._shownFrame = null;
    this._phase = 0;
    if (hadGrid) this.onFrameGridChanged?.();
    const vrCanvas = this._vrRenderer?.canvas || null;
    if (vrCanvas) vrCanvas.style.visibility = 'hidden';
    const revealOnFirstFrame = () => {
      this.video.style.visibility = '';
      if (vrCanvas) vrCanvas.style.visibility = '';
      this.video.removeEventListener('loadeddata', revealOnFirstFrame);
      this.video.removeEventListener('error', revealOnFirstFrame);
    };
    this.video.addEventListener('loadeddata', revealOnFirstFrame);
    // Error path also clears the hide — otherwise a failed load leaves
    // the element invisible until the next successful src change.
    this.video.addEventListener('error', revealOnFirstFrame);

    // Remote streams are served by our localhost proxy with permissive CORS;
    // mark the element anonymous so the VR-flatten WebGL path can sample it
    // (texImage2D taints otherwise). Local file:// sources clear it.
    this.video.crossOrigin = opts.remote ? 'anonymous' : null;

    if (opts.isHls) {
      // HLS via hls.js (MSE) — does NOT set video.src; hls.js drives the
      // element. _attachHls is async (lazy import) and fire-and-forget.
      // The element is emptied NOW (2026-11-23): until hls.js attaches, it
      // held the previous video, whose duration let a resume seek land on
      // that old media and be lost (a saved stream resumed at 0:00).
      this._destroyHls();
      this.video.removeAttribute('src');
      try { this.video.load(); } catch { /* nothing to unload */ }
      this._attachHls(url);
    } else {
      this._destroyHls(); // switching away from a prior HLS stream
      this.video.src = url;
      this.video.load();
    }

    // Reset progress bar to start position
    this.progressBar.style.width = '0%';
    this.progressThumb.style.left = '0%';
    this.progressContainer.setAttribute('aria-valuenow', '0');
    this.timeCurrent.textContent = '0:00';
    this.timeDuration.textContent = '0:00';

    // Show heatmap at full height until first play (reset first in case of rapid loads)
    this.progressContainer.classList.remove('progress--preview');
    this.progressContainer.classList.add('progress--preview');

    // Show controls briefly so user knows the player is active
    this._showControls();
    // A new source starts paused and not ended (V12). Reset BOTH controls,
    // not just the centre overlay: `load()` fires no 'pause', so a src swap
    // on a playing element (Up Next) kept the bar's Pause icon, and a stale
    // `_ended` from the previous clip kept Replay — and made Space call
    // replay(), which seeks to 0 and throws away the user's seek.
    this._ended = false;
    this._updatePlayButton(false);
  }

  togglePlay() {
    if (this._ended) {
      this.replay();
      return;
    }
    if (this.video.paused || this.video.ended) {
      this.video.play();
    } else {
      this.video.pause();
    }
  }

  replay() {
    this._ended = false;
    this.video.currentTime = 0;
    this.video.play();
  }

  play() {
    return this.video.play();
  }

  pause() {
    this.video.pause();
  }

  get paused() {
    return this.video.paused;
  }

  get currentTime() {
    return this.video.currentTime;
  }

  get duration() {
    return this.video.duration;
  }

  seek(time) {
    if (isFinite(time) && time >= 0 && time <= this.video.duration) {
      this.video.currentTime = time;
    }
  }

  skip(seconds) {
    this.seek(this.video.currentTime + seconds);
  }

  /**
   * Step forward or backward by one video frame.
   * Pauses the video first (OFS convention).
   * @param {1|-1} direction — 1 = forward, -1 = backward
   */
  stepFrame(direction) {
    this.stepFrames(direction);
  }

  /**
   * Step forward or backward by N video frames in one go. Used by the
   * editor's fast-step binding (OFS convention: Ctrl+Left/Right at a
   * configurable frame count). Pauses first like `stepFrame`.
   * @param {number} count — frames; positive = forward, negative = backward
   */
  stepFrames(count) {
    if (!count) return;
    this.video.pause();
    // Just past the target frame's start, never on it (frameStepTime).
    const newTime = frameStepTime(this.video.currentTime, count, this._estimateFps(), this.video.duration, this.framePhaseSec());
    if (isFinite(newTime)) this.video.currentTime = newTime;
  }

  /**
   * Set the FPS from external metadata (e.g. backend ffprobe).
   * @param {number} fps
   */
  setFps(fps) {
    if (fps > 0 && isFinite(fps)) {
      const changed = this._fps !== fps;
      this._fps = fps;
      if (changed) {
        this._learnPhase();
        this.onFrameGridChanged?.();
      }
    }
  }

  _estimateFps() {
    return this._fps || 30;
  }

  setVolume(level) {
    const clamped = Math.max(0, Math.min(1, level));
    this.video.volume = clamped;
    this.volumeSlider.value = Math.round(clamped * 100);
    this._updateMuteButton();
  }

  toggleMute() {
    this.video.muted = !this.video.muted;
    this._updateMuteButton();
  }

  async toggleFullscreen() {
    // Never fullscreen the DOCKED mini-player. The keyboard handler has no
    // view gating, so F / F11 fires while the user is browsing the library
    // with a video docked in the corner. A fullscreen element fills the
    // display regardless of its CSS box, so the corner overlay would take
    // over the whole screen — and `.player-container--mini` hides the top
    // bar, so it would do so with no back arrow and no way out but killing
    // the app. Same stuck state as the Back-while-fullscreen bug
    // (zaikechi, EroScripts #229); this is its second route in.
    if (!document.fullscreenElement
        && this.container?.classList?.contains('player-container--mini')) {
      return;
    }
    // Fullscreen can be denied by browser policy (no user gesture, or
    // the page is in an embedded iframe without `allow="fullscreen"`).
    // Wrap in try/catch and surface the failure so the user knows the
    // click did something (Nielsen #1 visibility, #9 error recovery —
    // plain language, not just a silent no-op).
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await this.container.requestFullscreen();
      }
    } catch (err) {
      const msg = (err && err.message) || t('toast.fullscreenUnavailable');
      showToast(t('toast.fullscreenBlocked', { error: msg }), 'warn');
    }
  }

  async togglePip() {
    // PiP throws when: video has no metadata yet, browser blocks PiP
    // for autoplay-restricted media, or the document doesn't have
    // recent user interaction. Same surface-the-failure rationale as
    // toggleFullscreen above.
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (document.pictureInPictureEnabled) {
        await this.video.requestPictureInPicture();
      } else {
        showToast(t('toast.pipUnsupported'), 'warn');
      }
    } catch (err) {
      const msg = (err && err.message) || t('toast.pipFailed');
      showToast(t('toast.pipError', { error: msg }), 'warn');
    }
  }

  /**
   * Re-draw the labels this player owns (play / pause / replay, mute /
   * unmute, fullscreen / exit) from the element's state, in the active
   * language. For a language switch: the static data-i18n walk resets them
   * to their boot keys, so a muted video's button said "Mute" (app test
   * V69). Labels only, unlike `_updatePlayButton`, which also flashes the
   * centre button.
   */
  refreshLabels() {
    const playing = !this.video.paused && !this.video.ended;
    const playLabel = this._ended ? t('player.replay') : playing ? t('player.pause') : t('player.play');
    this.btnPlay.setAttribute('aria-label', playLabel);
    this.btnPlay.title = this._ended ? t('player.replayTitle')
      : playing ? t('player.pauseTitle') : t('player.playTitle');
    this.centerPlayBtn.setAttribute('aria-label', playLabel);
    this._updateMuteButton();
    this._updateFullscreenButton();
  }

  // --- Private ---

  _onEnded() {
    this._ended = true;
    // Show replay icons in both the bar button and center overlay
    this.iconPlay.hidden = true;
    this.iconPause.hidden = true;
    if (this.iconReplay) this.iconReplay.hidden = false;
    this.btnPlay.setAttribute('aria-label', t('player.replay'));
    this.btnPlay.title = t('player.replayTitle');

    // Center overlay — show replay icon persistently
    clearTimeout(this._centerFlashTimer);
    this.centerPlayBtn.classList.remove('center-play--flash');
    this.centerIconPlay.hidden = true;
    this.centerIconPause.hidden = true;
    if (this.centerIconReplay) this.centerIconReplay.hidden = false;
    this.centerPlayBtn.classList.add('center-play--visible');
    this.centerPlayBtn.setAttribute('aria-label', t('player.replay'));
  }

  _updatePlayButton(isPlaying) {
    this.iconPlay.hidden = isPlaying;
    this.iconPause.hidden = !isPlaying;
    if (this.iconReplay) this.iconReplay.hidden = true;
    this.btnPlay.setAttribute('aria-label', isPlaying ? t('player.pause') : t('player.play'));
    this.btnPlay.title = isPlaying ? t('player.pauseTitle') : t('player.playTitle');
    this._updateCenterPlay(isPlaying);
  }

  /** Three-state mute icon (Nielsen #1 visibility of state).
   *
   *  - "muted":       explicit `video.muted = true` (set by M key /
   *                   the toggleMute path). Recovery = press M again.
   *  - "low":         volume ≤ 50% AND not explicitly muted. The user
   *                   dragged the slider down; recovery = drag back up.
   *  - "audible":     volume > 50%, not muted. Default.
   *
   *  Without the middle state, "audible at 30%" looked identical to
   *  "muted via M" — same `volume-x` icon, no signal which path the
   *  user took. */
  _updateMuteButton() {
    const isMuted = this.video.muted;
    const isLow = !isMuted && this.video.volume <= 0.5;
    this.iconVolume.hidden = isMuted || isLow;
    if (this.iconVolumeLow) this.iconVolumeLow.hidden = !isLow;
    this.iconMuted.hidden = !isMuted;
    this.btnMute.setAttribute('aria-label', isMuted ? t('player.unmute') : t('player.mute'));
    // The tooltip too, in the active language and for the state (FT-064): it
    // was the HTML's static English "Mute (M)", muted or not.
    this.btnMute.title = isMuted ? t('player.unmuteTitle') : t('player.muteTitle');
  }

  _updateFullscreenButton() {
    const isFs = !!document.fullscreenElement;
    this.iconExpand.hidden = isFs;
    this.iconCompress.hidden = !isFs;
    // The visible label and the tooltip say it too, not only the icon and
    // the aria-label: in fullscreen they still read "Fullscreen" (block C
    // verifier 1; also in v0.9.2). The data-i18n keys move with them, so a
    // language switch in fullscreen keeps "Exit fullscreen".
    const key = isFs ? 'player.exitFullscreen' : 'player.fullscreen';
    const btn = this.btnFullscreen;
    btn.setAttribute('aria-label', t(key));
    btn.setAttribute('title', t(key));
    if (btn.hasAttribute?.('data-i18n-aria-label')) btn.setAttribute('data-i18n-aria-label', key);
    if (btn.hasAttribute?.('data-i18n-title')) btn.setAttribute('data-i18n-title', key);
    const label = btn.querySelector?.('.control-btn__label');
    if (label) {
      label.textContent = t(key);
      if (label.hasAttribute?.('data-i18n')) label.setAttribute('data-i18n', key);
    }
  }

  _updateCenterPlay(isPlaying) {
    clearTimeout(this._centerFlashTimer);
    this.centerPlayBtn.classList.remove('center-play--flash', 'center-play--visible');
    if (this.centerIconReplay) this.centerIconReplay.hidden = true;

    if (isPlaying) {
      // Flash the pause icon briefly, then hide
      this.centerIconPlay.hidden = true;
      this.centerIconPause.hidden = false;
      this.centerPlayBtn.classList.add('center-play--flash');
      this._centerFlashTimer = setTimeout(() => {
        this.centerPlayBtn.classList.remove('center-play--flash');
      }, 500);
    } else {
      // Paused — show play icon persistently
      this.centerIconPlay.hidden = false;
      this.centerIconPause.hidden = true;
      this.centerPlayBtn.classList.add('center-play--visible');
    }

    this.centerPlayBtn.setAttribute('aria-label', isPlaying ? t('player.pause') : t('player.play'));
  }

  _onTimeUpdate() {
    if (this._isSeeking) return;
    const { currentTime, duration } = this.video;
    if (!isFinite(duration)) return;

    const pct = (currentTime / duration) * 100;
    this.progressBar.style.width = `${pct}%`;
    this.progressThumb.style.left = `${pct}%`;
    this.progressContainer.setAttribute('aria-valuenow', Math.round(pct));

    this.timeCurrent.textContent = this._formatTime(currentTime);
  }

  _onMetadataLoaded() {
    this.timeDuration.textContent = this._formatTime(this.video.duration);

    // Reset playback rate to 1× on every new video load. Matches YouTube
    // / VLC convention — avoids "why is this video at 2×?" surprise the
    // next morning. Replaces the editor-close reset (removed from
    // script-editor.js since rate is now player-owned).
    //
    // Guarded on OUR tracked rate, not `video.playbackRate`. Loading a new
    // resource already reset the element to `defaultPlaybackRate` (1), so
    // by the time this runs `video.playbackRate` is ALWAYS 1 and the old
    // guard never fired. The rate really did drop to 1×, but nothing
    // emitted `playback:rate-changed`, so the speed chip kept showing the
    // previous video's rate — "appears to persist but doesn't really", and
    // reselecting the same value was the only way to make it take effect.
    //
    // It also left the Handy in HDSP mode after a non-1× video, since the
    // HSSP↔HDSP switch lives in setPlaybackRate and was likewise skipped.
    //
    // With "remember playback speed" on we re-APPLY the tracked rate rather
    // than resetting — the element still needs writing to either way, since
    // the browser has just reset it to 1.
    if (this._currentRate !== 1) {
      let remember = false;
      try {
        remember = !!this._rememberRateProvider?.();
      } catch {
        // A broken provider must not stop the reset — falling back to 1×
        // is the safe direction.
        remember = false;
      }
      this.setPlaybackRate(remember ? this._currentRate : 1);
    }

    // Resolution badge
    const h = this.video.videoHeight;
    let label = '';
    if (h >= 2160) label = '4K';
    else if (h >= 1440) label = '1440p';
    else if (h >= 1080) label = '1080p';
    else if (h >= 720) label = '720p';
    else if (h >= 480) label = '480p';
    else if (h > 0) label = `${h}p`;

    this._resolutionLabel = label;
  }

  _updateBuffered() {
    if (this.video.buffered.length > 0) {
      const end = this.video.buffered.end(this.video.buffered.length - 1);
      const pct = (end / this.video.duration) * 100;
      this.bufferedBar.style.width = `${pct}%`;
    }
  }

  // --- Seeking ---

  _startSeek(e) {
    this._isSeeking = true;
    this._seekToPosition(e);
  }

  _onSeekDrag(e) {
    if (!this._isSeeking) return;
    this._seekToPosition(e);
  }

  _endSeek() {
    this._isSeeking = false;
  }

  _seekToPosition(e) {
    const rect = this.progressContainer.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const time = pct * this.video.duration;
    if (isFinite(time)) {
      this.video.currentTime = time;
      this.progressBar.style.width = `${pct * 100}%`;
      this.progressThumb.style.left = `${pct * 100}%`;

      // Notify for HDSP scrub preview
      if (this._isSeeking && this.onSeekDrag) {
        this.onSeekDrag(time);
      }
    }
  }

  _onProgressHover(e) {
    const rect = this.progressContainer.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const time = pct * this.video.duration;

    if (isFinite(time)) {
      this.tooltipTime.textContent = this._formatTime(time);

      // Notify for thumbnail preview + chapter/bookmark marker tooltip.
      // Second arg is the cursor X within the progress container so the
      // marker resolver can hit-test against its own px coordinates.
      if (this.onProgressHover) {
        this.onProgressHover(time, e.clientX - rect.left, rect.width);
      }

      // Centred on the cursor, but kept inside the bar: near either end the
      // 160 px frame and script preview went past the window's edge (test
      // day 2026-11-26, B097). Measured after the callback above has filled
      // it; the time label still names the cursor's time.
      let leftPct = pct * 100;
      const half = (this.progressTooltip.offsetWidth || 0) / 2;
      if (half > 0 && rect.width > 2 * half) {
        const x = pct * rect.width;
        if (x < half) leftPct = (half / rect.width) * 100;
        else if (x > rect.width - half) leftPct = ((rect.width - half) / rect.width) * 100;
      }
      this.progressTooltip.style.left = `${leftPct}%`;
    }
  }

  // --- Controls Visibility ---

  /** Drop the focus from the volume slider, if it has it (C-01). */
  _blurVolumeSlider() {
    const slider = this.volumeSlider;
    if (slider && typeof document !== 'undefined' && document.activeElement === slider) slider.blur();
  }

  _showControls() {
    // Fire the callback only on an actual transition. `_showControls` runs on
    // every mousemove, so notifying unconditionally would spam the consumer
    // (the caption-overlay sync is an IPC round-trip).
    const wasVisible = this.container.classList.contains('controls-visible');
    this.container.classList.add('controls-visible');
    this.container.style.cursor = '';
    clearTimeout(this._controlsTimeout);
    clearTimeout(this._cursorTimeout);
    this._hideControlsDelayed();
    if (!wasVisible) {
      this._placeCuesForControls(); // subtitles move above the bar (R4-05)
      this._emitControlsVisibility(true);
    }
  }

  _hideControlsDelayed() {
    clearTimeout(this._controlsTimeout);
    clearTimeout(this._cursorTimeout);
    this._controlsTimeout = setTimeout(() => {
      if (!this.video.paused) {
        const wasVisible = this.container.classList.contains('controls-visible');
        this.container.classList.remove('controls-visible');
        this.container.style.cursor = 'none';
        // A slider nobody can see owns no keys (C-01): a hidden, focused
        // volume slider kept the arrows in fullscreen.
        this._blurVolumeSlider();
        if (wasVisible) {
          this._placeCuesForControls(); // and back down (R4-05)
          this._emitControlsVisibility(false);
        }
      }
    }, 1500);
  }

  // --- Subtitles clear of the control bar (R4-05) ---

  /**
   * Keep subtitle text off the control bar while it shows (R4-05, probably
   * also in v0.9.2). The bar overlays the bottom of the video and the
   * browser draws a cue at the bottom of the video box, so whenever the
   * controls were up the text sat over the bar's buttons. `::cue` cannot be
   * positioned, so the cues on screen get a line just above the bar (and
   * above the inline heatmap / timeline when they show), and their own
   * placement back when the bar hides. Only cues the browser places
   * (`line: auto`, every SRT cue and most VTT ones) move: a cue its file
   * puts somewhere (the top of the frame, a line number) stays there.
   * Called on every show / hide of the bar, on `cuechange` (a cue coming up
   * while the bar shows) and on a resize or fullscreen change.
   */
  _placeCuesForControls() {
    const lifted = this._liftedCues || (this._liftedCues = new Map()); // cue → its own placement
    const visible = !!this.container?.classList?.contains('controls-visible');
    const line = visible ? this._cueLineAboveControls() : null;
    if (line == null) {
      for (const [cue, own] of lifted) this._putCueBack(cue, own);
      lifted.clear();
      return;
    }
    const tracks = this.video?.textTracks;
    for (let i = 0; i < (tracks?.length || 0); i++) {
      const tt = tracks[i];
      if (tt?.mode !== 'showing' || !tt.activeCues) continue;
      for (const cue of Array.from(tt.activeCues)) {
        if (!lifted.has(cue)) {
          if (cue.line !== 'auto') continue; // placed by its file: leave it
          lifted.set(cue, { line: cue.line, snapToLines: cue.snapToLines, lineAlign: cue.lineAlign });
        }
      }
    }
    for (const cue of lifted.keys()) {
      try {
        // Only what changes: a cue change can raise `cuechange`, which runs this.
        if (cue.snapToLines !== false) cue.snapToLines = false;
        if (cue.lineAlign !== 'end') cue.lineAlign = 'end'; // the box's bottom at `line` %, where supported
        if (cue.line !== line) cue.line = line;
      } catch { /* a cue of a removed track */ }
    }
  }

  /**
   * Something drawn over the bottom of the video appeared or went (the Up
   * Next card): place the cues on screen again (R4 fix-up). A no-op while the
   * bar is hidden and nothing is lifted.
   */
  refreshCuePlacement() {
    this._placeCuesForControls();
  }

  /**
   * A lifted cue back where the browser puts it. Not by setting `line` back
   * to 'auto': Chromium's cue layout keeps state, and a cue restored that
   * way came down about one line short of where it began (measured in a
   * headless window, R4-05). A fresh copy of the cue, same timing, text
   * and settings, in its place lands exactly where the original did.
   */
  _putCueBack(cue, own) {
    const track = cue?.track;
    if (track && typeof VTTCue === 'function') {
      try {
        const copy = new VTTCue(cue.startTime, cue.endTime, cue.text);
        copy.id = cue.id;
        copy.pauseOnExit = cue.pauseOnExit;
        for (const key of ['vertical', 'position', 'size', 'align', 'region']) {
          if (key in cue && cue[key] !== undefined) copy[key] = cue[key];
        }
        copy.snapToLines = own.snapToLines;
        copy.line = own.line;
        if (own.lineAlign !== undefined) copy.lineAlign = own.lineAlign;
        track.removeCue(cue);
        track.addCue(copy);
        return;
      } catch { /* fall back to restoring it in place */ }
    }
    try {
      cue.snapToLines = own.snapToLines;
      cue.line = own.line;
      if (own.lineAlign !== undefined) cue.lineAlign = own.lineAlign;
    } catch { /* a cue of a removed track */ }
  }

  /**
   * The `line` (in % of the video box) that keeps a lifted cue's box above
   * the top of the control bar, or of the inline heatmap / timeline when
   * they show (they sit above the bar). Layout offsets, not on-screen
   * rectangles: the inline viz slides with a transform. Null while nothing
   * is laid out (a hidden player).
   *
   * Chromium has no `lineAlign` (it is set anyway, for an engine that does):
   * with `snapToLines` off it anchors the cue box proportionally, the point
   * `line`% down the box at `line`% down the video, so the box's bottom
   * lands at line·H + (1 − line)·boxHeight. Solved for a box of about two
   * cue lines (cue text is 5% of the video height), so one and two line
   * cues clear the bar and a third line reaches at most into the bar's
   * transparent top padding. Measured in a headless window (R4-05).
   */
  _cueLineAboveControls() {
    const video = this.video;
    const height = video?.clientHeight || 0;
    if (!(height > 0) || !this.controls) return null;
    let top = this.controls.offsetTop;
    const viz = this.container?.querySelector?.('.inline-viz');
    if (viz && !viz.hidden && viz.offsetHeight > 0) top = Math.min(top, viz.offsetTop);
    // The Up Next card while it shows (bottom right above the bar, left of an
    // open queue panel since R4-03): a cue lifted to just above the bar lay
    // in the card's band and was cut off behind it (R4 fix-up, real-app
    // verifier 1). The app places the cues again when it shows or goes
    // (`refreshCuePlacement`).
    const card = this.container?.querySelector?.('.up-next');
    if (card && !card.hidden && card.offsetHeight > 0) top = Math.min(top, card.offsetTop);
    const videoTop = (video.offsetParent === this.container ? 0 : (video.offsetParent?.offsetTop || 0)) + video.offsetTop;
    const GAP_PX = 6;
    const bottom = top - GAP_PX - videoTop; // where the box's bottom may go, px from the video's top
    const box = 0.12 * height;              // about two lines of cue text
    const fraction = (bottom - box) / (height - box);
    if (!Number.isFinite(fraction)) return null;
    return Math.max(0, Math.min(100, Math.round(fraction * 10000) / 100));
  }

  /** Notify the app that the control chrome appeared/disappeared. */
  _emitControlsVisibility(visible) {
    try { this.onControlsVisibilityChanged?.(visible); } catch { /* best-effort */ }
  }

  // --- Screenshot ---

  captureScreenshot() {
    const canvas = document.createElement('canvas');
    canvas.width = this.video.videoWidth;
    canvas.height = this.video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(this.video, 0, 0, canvas.width, canvas.height);

    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `screenshot_${this._formatTime(this.video.currentTime).replace(/:/g, '-')}.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  }

  // --- Info Overlay ---

  toggleInfoOverlay() {
    this._infoVisible = !this._infoVisible;
    let overlay = document.getElementById('info-overlay');

    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'info-overlay';
      overlay.className = 'info-overlay';
      this.container.appendChild(overlay);
    }

    if (this._infoVisible) {
      const w = this.video.videoWidth;
      const h = this.video.videoHeight;
      const codec = this.video.videoWidth ? 'H.264' : '—';
      overlay.innerHTML = `
        <div>${t('player.infoResolution')}: ${w}x${h}</div>
        <div>${t('player.infoDuration')}: ${this._formatTime(this.video.duration)}</div>
        <div>${t('player.infoCurrent')}: ${this._formatTime(this.video.currentTime)}</div>
        <div>${t('player.infoVolume')}: ${Math.round(this.video.volume * 100)}%</div>
        <div>${t('player.infoPlaybackRate')}: ${this.video.playbackRate}x</div>
      `;
      overlay.hidden = false;
    } else {
      overlay.hidden = true;
    }
  }

  // --- A-B Loop ---

  setLoopPoint(point) {
    if (point === 'a') {
      this._abLoop.a = this.video.currentTime;
      console.log(`Loop A set: ${this._formatTime(this._abLoop.a)}`);
    } else if (point === 'b') {
      this._abLoop.b = this.video.currentTime;
      console.log(`Loop B set: ${this._formatTime(this._abLoop.b)}`);
      if (this._abLoop.a !== null && this._abLoop.b !== null) {
        this._startAbLoop();
      }
    }
  }

  clearAbLoop() {
    this._abLoop = { a: null, b: null };
    console.log('A-B loop cleared');
  }

  _startAbLoop() {
    const checkLoop = () => {
      if (this._abLoop.a === null || this._abLoop.b === null) return;
      if (this.video.currentTime >= this._abLoop.b) {
        this.video.currentTime = this._abLoop.a;
      }
      if (this._abLoop.a !== null && this._abLoop.b !== null) {
        requestAnimationFrame(checkLoop);
      }
    };
    requestAnimationFrame(checkLoop);
  }

  // --- Aspect Ratio ---

  cycleAspectRatio() {
    this._aspectIndex = (this._aspectIndex + 1) % this._aspectModes.length;
    const mode = this._aspectModes[this._aspectIndex];

    if (mode === 'contain' || mode === 'cover') {
      this.video.style.objectFit = mode;
      this.video.style.aspectRatio = '';
    } else {
      this.video.style.objectFit = 'contain';
      this.video.style.aspectRatio = mode;
    }

    const labels = { contain: 'Fit', cover: 'Fill', '16 / 9': '16:9', '4 / 3': '4:3' };
    console.log(`Aspect ratio: ${labels[mode]}`);
  }

  // --- VR Flatten ---
  //
  // Two render paths share this single entry point:
  //   - PLANAR (sbs-half/full, tb-half/full): CSS `transform: scaleX/Y(2)`
  //     on the <video> element. Zero shader cost; covers the most common
  //     SBS/TB VR rips.
  //   - NON-PLANAR (equirect-180, fisheye-180): hands off to the
  //     VRProjectionRenderer (WebGL2 canvas overlay). Mount/unmount
  //     happens lazily here so non-VR sessions never pay the cost.
  //
  // Eye is 1 (left/top, default) or 2 (right/bottom).
  // `opts.zoom`  (1.0-2.0) — planar only; multiplies the base crop.
  // `opts.fov`   (deg)     — spherical only; viewport FOV.
  // `opts.yaw`   (deg)     — spherical only; pan horizontal.
  // `opts.pitch` (deg)     — spherical only; pan vertical (clamped ±85°).
  //
  // Idempotent: applying the same format+eye+zoom twice is a no-op.
  setVRFlatten(format, eye = 1, opts = {}) {
    const PLANAR = ['sbs-half', 'sbs-full', 'tb-half', 'tb-full'];

    // Clear prior planar classes regardless of next state — cheap and
    // avoids the trap where switching SBS → TB leaves both on.
    for (const v of PLANAR) {
      this.video.classList.remove(`player__video--flat-${v}`);
    }
    this.video.classList.remove('player__video--flat-eye-2');
    if (this.video.style?.removeProperty) {
      this.video.style.removeProperty('--vr-flatten-zoom');
      this.video.style.removeProperty('--vr-view-zoom');
      this.video.style.removeProperty('--vr-pan-x');
      this.video.style.removeProperty('--vr-pan-y');
    }
    this._vrFlattenFormat = null;
    this._vrFlattenEye = 1;
    this._vrFlattenZoom = 1;
    this._vrViewZoom = 1;
    this._vrPanX = 0;
    this._vrPanY = 0;

    // Non-planar — mount renderer, configure, show the canvas.
    if (format && NONPLANAR_FORMATS.has(format)) {
      this._mountVRRendererIfNeeded();
      if (!this._vrRenderer) return; // mount failed (no WebGL2); silently fall through to off
      this._vrRenderer.setProjection(format);
      this._vrRenderer.setEye(eye === 2 ? 'right' : 'left');
      // Phase 2a assumes SBS-half for equirect-180 / fisheye-180 (the
      // overwhelming majority of VR180 rips). When mono support is
      // added the panel can expose stereoMode explicitly.
      this._vrRenderer.setStereoMode(1);
      this._vrRenderer.setFov(Number.isFinite(opts.fov) ? opts.fov : 90);
      this._vrRenderer.setYawPitch(
        Number.isFinite(opts.yaw) ? opts.yaw : 0,
        Number.isFinite(opts.pitch) ? opts.pitch : 0,
      );
      this._setVRProjectingState(true);
      this._vrFlattenFormat = format;
      this._vrFlattenEye = eye;
      this._vrFlattenZoom = 1;
      return;
    }

    // Planar (or off / null) — unmount the renderer if it's up.
    if (this._vrRenderer?.mounted) {
      this._vrRenderer.unmount();
      this._setVRProjectingState(false);
    }

    if (!format || format === 'off' || !PLANAR.includes(format)) return;
    this.video.classList.add(`player__video--flat-${format}`);
    if (eye === 2) this.video.classList.add('player__video--flat-eye-2');
    const zoom = Number.isFinite(opts.zoom) ? Math.max(1, Math.min(2, opts.zoom)) : 1;
    if (zoom !== 1 && this.video.style?.setProperty) {
      this.video.style.setProperty('--vr-flatten-zoom', String(zoom));
    }
    this._vrFlattenFormat = format;
    this._vrFlattenEye = eye;
    this._vrFlattenZoom = zoom;
    // Restore any saved viewer zoom/pan for this video. Separate call so
    // the gesture path can update it later without re-running the whole
    // class-swapping dance above.
    this.setVRViewZoom(opts.viewZoom, opts.panX, opts.panY);
  }

  /**
   * Uniform viewer zoom + pan for a PLANAR flattened video.
   *
   * Distinct from `opts.zoom` above, which is the one-axis packing-ratio
   * correction (`--vr-flatten-zoom`). That one stretches; this one
   * magnifies. Conflating them is what made the VR Format panel's "Zoom"
   * slider misleading — see vr-zoom.js.
   *
   * Values are written as CSS custom properties and composed by the
   * transform in player.css, so there is no per-frame JS.
   */
  setVRViewZoom(viewZoom, panX = 0, panY = 0) {
    const z = Number.isFinite(viewZoom) ? Math.max(1, viewZoom) : 1;
    const x = Number.isFinite(panX) ? panX : 0;
    const y = Number.isFinite(panY) ? panY : 0;
    this._vrViewZoom = z;
    this._vrPanX = x;
    this._vrPanY = y;
    if (!this.video?.style?.setProperty) return;
    this.video.style.setProperty('--vr-view-zoom', String(z));
    this.video.style.setProperty('--vr-pan-x', String(x));
    this.video.style.setProperty('--vr-pan-y', String(y));
  }

  /** Current viewer zoom, for callers deciding whether a drag should pan. */
  get vrViewZoom() { return this._vrViewZoom || 1; }

  /** Update the pan/zoom/roll of an already-active spherical projection
   *  without remounting. Caller (drag-to-pan, FOV slider, "Rotate 180°"
   *  toggle from VR Format panel) uses this on every input event.
   *  No-op when not projecting. */
  updateVRProjection({ fov, yaw, pitch, roll } = {}) {
    if (!this._vrRenderer?.mounted) return;
    if (Number.isFinite(fov))   this._vrRenderer.setFov(fov);
    if (Number.isFinite(yaw) || Number.isFinite(pitch)) {
      this._vrRenderer.setYawPitch(
        Number.isFinite(yaw)   ? yaw   : 0,
        Number.isFinite(pitch) ? pitch : 0,
      );
    }
    if (Number.isFinite(roll)) this._vrRenderer.setRoll(roll);
  }

  /** Whether a non-planar VR projection is currently being rendered.
   *  Used by drag/keyboard handlers to gate gestures. */
  get isVRProjecting() {
    return !!this._vrRenderer?.mounted;
  }

  /** Returns the WebGL canvas element if mounted (null otherwise).
   *  Lets callers (panel) wire pointer events directly. */
  get vrProjectionCanvas() {
    return this._vrRenderer?.canvas || null;
  }

  _mountVRRendererIfNeeded() {
    if (this._vrRenderer?.mounted) return;
    if (!this._vrRenderer) this._vrRenderer = new VRProjectionRenderer();
    const container = this.video.parentElement;
    if (!container) return;
    try {
      this._vrRenderer.mount(this.video, container);
    } catch (err) {
      console.warn('[VR projection] mount failed:', err?.message || err);
      showToast(t('vrFormat.webglUnavailable'), 'warn', 4000);
      this._vrRenderer = null;
    }
  }

  _setVRProjectingState(active) {
    const wrap = this.video?.parentElement;
    if (!wrap?.classList) return;
    wrap.classList.toggle('player__video-wrapper--vr-projecting', !!active);
  }

  /**
   * Cycle the VR-flatten state through Off → Left/Top eye → Right/Bottom
   * eye → Off. Caller passes the detected `format` for the loaded video;
   * when null, only the Off state is reachable (no-op cycle).
   */
  cycleVRFlatten(format) {
    if (!format) {
      this.setVRFlatten('off');
      return 'off';
    }
    if (!this._vrFlattenFormat) {
      this.setVRFlatten(format, 1);
      return `${format} (left)`;
    }
    if (this._vrFlattenEye === 1) {
      this.setVRFlatten(format, 2);
      return `${format} (right)`;
    }
    this.setVRFlatten('off');
    return 'off';
  }

  get vrFlattenState() {
    return {
      format: this._vrFlattenFormat || null,
      eye: this._vrFlattenEye || 1,
      zoom: this._vrFlattenZoom || 1,
    };
  }

  // --- Playback Speed ---
  //
  // Single source of truth for playback rate. Editor dropdown, player
  // controls button, keyboard shortcuts, and (Phase 2) web-remote all
  // route through here so the Handy HSSP↔HDSP mode switch fires in
  // exactly one place.
  //
  // HSSP can't follow rate changes (cloud schedules at 1.0× regardless),
  // so at non-1× we switch to HDSP-polled mode — the polled engine reads
  // `video.currentTime` per tick, which naturally scales with the rate.
  // Buttplug / TCode / Autoblow already handle rate via per-tick reads.

  setPlaybackRate(rate) {
    if (!PLAYBACK_RATE_PRESETS.includes(rate)) return;
    this.video.playbackRate = rate;
    this._currentRate = rate;

    if (this._handyManager?.connected) {
      if (rate === 1) {
        if (this._handyHdspSync?.active) this._handyHdspSync.stop();
        if (this._handySyncEngine) this._handySyncEngine.start();
      } else {
        if (this._handySyncEngine) this._handySyncEngine.stop();
        if (this._handyHdspSync && !this._handyHdspSync.active) {
          this._handyHdspSync.start();
        }
      }
    }

    eventBus.emit('playback:rate-changed', rate);
  }

  cyclePlaybackRate(dir) {
    const current = this.video.playbackRate || 1;
    const idx = PLAYBACK_RATE_PRESETS.indexOf(current);
    let next;
    if (idx === -1) {
      next = 1;
    } else {
      const target = idx + (dir > 0 ? 1 : -1);
      if (target < 0 || target >= PLAYBACK_RATE_PRESETS.length) return current;
      next = PLAYBACK_RATE_PRESETS[target];
    }
    this.setPlaybackRate(next);
    return next;
  }

  get playbackRate() {
    return this.video.playbackRate;
  }

  /**
   * Wire the Handy sync references so setPlaybackRate can manage the
   * HSSP↔HDSP mode switch. Called by app.js once the managers are
   * constructed. Idempotent — passing nullish keeps existing refs.
   */
  /**
   * Supply a predicate for "carry the playback rate across videos"
   * (`player.rememberPlaybackSpeed`). Read at each video load, so a change
   * in Settings takes effect on the very next video with no propagation.
   *
   * @param {() => boolean} fn
   */
  setRememberRateProvider(fn) {
    this._rememberRateProvider = typeof fn === 'function' ? fn : null;
  }

  setHandySyncRefs({ handyManager, handySyncEngine, handyHdspSync }) {
    if (handyManager !== undefined) this._handyManager = handyManager;
    if (handySyncEngine !== undefined) this._handySyncEngine = handySyncEngine;
    if (handyHdspSync !== undefined) this._handyHdspSync = handyHdspSync;
  }

  // --- Subtitles ---

  /**
   * Remove any attached subtitle <track> elements, revoke their blob URLs,
   * and hide the subtitle indicator. Safe to call when no subtitle is loaded.
   * Called on every video load so a previous video's subtitle can't leak
   * onto the next one (which otherwise persisted until app restart).
   */
  clearSubtitles() {
    const existing = this.video.querySelectorAll('track');
    existing.forEach((t) => {
      if (t.src && t.src.startsWith('blob:')) URL.revokeObjectURL(t.src);
      t.remove();
    });
    // Removing the <track> ELEMENT does not drop the associated TextTrack
    // from video.textTracks in Chromium — it lingers with mode 'showing' and
    // keeps painting its cues onto EVERY subsequent video (the long-standing
    // "subtitles from one video show up on all the next ones" bug). Removing
    // the element alone never fixed it; force every track to 'disabled' so
    // no stale cues render, and drop any cues we still have a handle on.
    const tracks = this.video.textTracks;
    if (tracks) {
      for (let i = 0; i < tracks.length; i++) {
        const tt = tracks[i];
        try {
          tt.mode = 'disabled';
          if (tt.cues) {
            // Static copy — removeCue mutates the live cue list as we go.
            Array.from(tt.cues).forEach((cue) => { try { tt.removeCue(cue); } catch { /* ignore */ } });
          }
        } catch { /* jsdom / detached track — nothing to disable */ }
      }
    }
    const badge = document.getElementById('subtitle-badge');
    if (badge) badge.hidden = true;
    this._liftedCues?.clear(); // their track is gone (R4-05)
    this.onSubtitlesChanged?.(null);
  }

  /**
   * @param {File|{name: string, textContent: string}} file
   * @param {{ show?: boolean }} [opts] show: false loads the track switched
   *   off (an embedded stream the file does not mark as default, #268);
   *   the CC button turns it on.
   */
  async loadSubtitles(file, { show = true } = {}) {
    // Remove existing tracks and revoke old blob URLs
    this.clearSubtitles();

    // Read file content
    let text = typeof file.textContent === 'string' ? file.textContent : await file.text();
    const name = file.name || 'subtitles';
    const original = text;
    const ext = name.slice(name.lastIndexOf('.')).toLowerCase();

    // Convert SRT to VTT (HTML5 <track> only supports WebVTT)
    if (ext === '.srt') {
      text = 'WEBVTT\n\n' + text.replace(/\r\n/g, '\n').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    }

    const blob = new Blob([text], { type: 'text/vtt' });
    const url = URL.createObjectURL(blob);

    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = name.replace(/\.[^/.]+$/, '');
    track.src = url;
    track.default = !!show;
    this.video.appendChild(track);

    // Enable ONLY the newly-added track via its own TextTrack handle. Don't
    // use textTracks[0] — a stale (now-disabled) track from a previous video
    // can still sit at index 0 in Chromium, so [0].mode = 'showing' would
    // re-show the WRONG subtitles. `.track` is live once the element is in
    // the DOM; the load listener is a belt-and-suspenders fallback.
    const enableNew = () => { if (track.track) track.track.mode = show ? 'showing' : 'disabled'; };
    enableNew();
    track.addEventListener('load', enableNew, { once: true });
    // Its cues keep off the control bar while it shows (R4-05): the ones
    // coming up as playback moves, and the first ones once the file loads.
    track.track?.addEventListener?.('cuechange', () => this._placeCuesForControls());
    track.addEventListener('load', () => this._placeCuesForControls(), { once: true });

    // Show subtitle indicator
    const badge = document.getElementById('subtitle-badge');
    if (badge) {
      badge.hidden = false;
      badge.classList.toggle('subtitle-badge--active', !!show);
    }
    // The player pop-out shows them too (app.js, 2026-11-22): the file as
    // read, and whether it shows (an embedded track can load switched off).
    this.onSubtitlesChanged?.({ name, text: original, show: !!show });
  }

  // --- Utils ---

  _formatTime(seconds) {
    return formatTime(seconds);
  }
}
