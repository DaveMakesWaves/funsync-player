/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL KeyboardHandler listens on `document`, the keys
 * are dispatched on real focused elements, the REAL VideoPlayer is built on a
 * DOM scaffold, and keyboard.js imports i18n.js, which branches on
 * `typeof window` (notes/CLAUDE.md "Test environments").
 */
// C-01 (Dave 2026-11-06, also in v0.9.2): "when moving to full screen the
// pause hotkey and other hotkeys dont work until i click the video like they
// only work when the focus is on the video not the controls".
//
// Reproduced in the real app before the fix (scratchpad c01-repro.md): after a
// drag or click on the volume slider, the focused <input type="range"> owned
// EVERY key, because keyboard.js listed a bare 'input' among the controls that
// own all keys. Space, K, M and F did nothing; the arrows moved the volume 1 %
// (the slider's step) instead of seeking 5 s; F11 was not taken, so the View
// menu's window fullscreen ran and the player never knew. Fullscreen hides the
// bar, so the focus on the slider was invisible. One click on the video moved
// the focus off it, which is why that "fixed" it.
//
// Assertions are on what the user sees: is the video paused, where is it, how
// loud, muted or not, did fullscreen toggle, and was the key left to the
// browser (defaultPrevented false is what lets the slider step, or the menu's
// F11 run).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KeyboardHandler } from '../../renderer/js/keyboard.js';
import { VideoPlayer } from '../../renderer/js/video-player.js';

// Every KeyboardHandler and VideoPlayer binds to `document` for good. Record
// the listeners each test adds and take them off afterwards.
let added = [];
let realAdd;
beforeEach(() => {
  added = [];
  realAdd = document.addEventListener.bind(document);
  vi.spyOn(document, 'addEventListener').mockImplementation((type, fn, opts) => {
    added.push([type, fn, opts]);
    realAdd(type, fn, opts);
  });
  document.body.innerHTML = '';
});
afterEach(() => {
  for (const [type, fn, opts] of added) document.removeEventListener(type, fn, opts);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Dispatch a real, cancelable keydown on `target`; return the event. */
function key(target, keyName, init = {}) {
  const e = new KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

/** The player bar as index.html builds it (the parts VideoPlayer reads). */
function buildPlayerDom() {
  document.body.innerHTML = `
    <div id="player-container">
      <video id="video"></video>
      <div id="center-play-btn">
        <span class="center-play__icon--play"></span>
        <span class="center-play__icon--pause"></span>
      </div>
      <div id="player-controls">
        <div id="progress-container" role="slider" tabindex="0" aria-valuenow="0">
          <div id="buffered-bar"></div><div id="progress-bar"></div><div id="progress-thumb"></div>
          <div id="progress-tooltip"><span id="tooltip-time"></span></div>
        </div>
        <button id="btn-play"><span class="icon-play"></span><span class="icon-pause"></span></button>
        <button id="btn-mute"><span class="icon-volume"></span><span class="icon-muted"></span></button>
        <input type="range" id="volume-slider" class="volume-slider" min="0" max="100" value="100" aria-label="Volume">
        <span id="time-current">0:00</span><span id="time-duration">0:00</span>
        <button id="btn-pip"></button>
        <button id="btn-fullscreen"><span class="icon-expand"></span><span class="icon-compress"></span></button>
        <span id="resolution-badge" hidden></span>
      </div>
    </div>`;
}

/**
 * The REAL VideoPlayer with the REAL KeyboardHandler on top, a 10-minute clip
 * playing at 2:00, volume 50 %. jsdom has no media pipeline, so play/pause
 * flip a `paused` flag, and fullscreen (no Fullscreen API in jsdom) is
 * counted.
 */
function makePlayer() {
  buildPlayerDom();
  const video = document.getElementById('video');
  let paused = false;
  Object.defineProperty(video, 'paused', { get: () => paused, configurable: true });
  Object.defineProperty(video, 'duration', { value: 600, configurable: true });
  video.play = vi.fn(() => { paused = false; return Promise.resolve(); });
  video.pause = vi.fn(() => { paused = true; });
  const player = new VideoPlayer({
    videoElement: video,
    controlsElement: document.getElementById('player-controls'),
    containerElement: document.getElementById('player-container'),
  });
  player.setVolume(0.5);
  video.currentTime = 120;
  const fullscreen = vi.spyOn(player, 'toggleFullscreen').mockImplementation(() => {});
  new KeyboardHandler({ videoPlayer: player, getView: () => 'player' });
  const slider = document.getElementById('volume-slider');
  return { player, video, slider, fullscreen };
}

/** A press and release of the mouse on the slider, as a click or drag ends. */
function pointerOnSlider(slider, { releaseOn = slider } = {}) {
  slider.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
  slider.focus(); // the browser focuses a range input on mousedown
  releaseOn.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
}

// ---------------------------------------------------------------------------
// The focused volume slider owns only the keys that step it
// ---------------------------------------------------------------------------

describe('C-01: a focused volume slider no longer swallows the player keys', () => {
  it('Space and K pause and play, M mutes, F and F11 toggle fullscreen, with the slider focused', () => {
    const { video, slider, fullscreen } = makePlayer();
    slider.focus();
    expect(document.activeElement).toBe(slider);

    expect(key(slider, ' ').defaultPrevented).toBe(true);
    expect(video.paused).toBe(true);
    key(slider, 'k');
    expect(video.paused).toBe(false);
    key(slider, 'K');
    expect(video.paused).toBe(true);

    key(slider, 'm');
    expect(video.muted).toBe(true);
    key(slider, 'M');
    expect(video.muted).toBe(false);

    key(slider, 'f');
    // F11 is TAKEN (prevented), so the View menu's window fullscreen, which
    // the player does not know about and Esc cannot leave, never runs.
    const f11 = key(slider, 'F11');
    expect(f11.defaultPrevented).toBe(true);
    expect(fullscreen).toHaveBeenCalledTimes(2);
  });

  it('the arrows, Home / End and PageUp / PageDown stay the slider\'s while it has the focus', () => {
    const { video, slider } = makePlayer();
    slider.focus();
    for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']) {
      expect(key(slider, k).defaultPrevented, `${k} must reach the slider`).toBe(false);
    }
    expect(video.currentTime).toBe(120); // no seek
    expect(video.volume).toBe(0.5); // the player did not step the volume on top
  });

  it('a mouse drag on the slider gives the focus back, so the arrows seek 5 s again (the fullscreen case)', () => {
    vi.useFakeTimers();
    const { video, slider } = makePlayer();
    // Release outside the slider, as a drag usually ends.
    pointerOnSlider(slider, { releaseOn: document.body });
    vi.advanceTimersByTime(0);
    expect(document.activeElement).not.toBe(slider);

    key(document.activeElement, 'ArrowLeft');
    expect(video.currentTime).toBe(115);
    key(document.activeElement, 'ArrowUp');
    expect(video.volume).toBeCloseTo(0.55, 5);
    key(document.activeElement, ' ');
    expect(video.paused).toBe(true);
  });

  it('a plain click on the slider gives the focus back too', () => {
    vi.useFakeTimers();
    const { video, slider } = makePlayer();
    pointerOnSlider(slider);
    vi.advanceTimersByTime(0);
    expect(document.activeElement).not.toBe(slider);
    key(document.activeElement, 'ArrowRight');
    expect(video.currentTime).toBe(125);
  });

  it('Tab to the slider (no mouse) keeps the focus there while the bar shows: the keyboard user steps it', () => {
    vi.useFakeTimers();
    const { slider } = makePlayer();
    slider.focus();
    vi.advanceTimersByTime(0);
    expect(document.activeElement).toBe(slider);
  });

  it('when the bar hides during playback, a focused slider lets go, so the hidden bar owns no keys', () => {
    vi.useFakeTimers();
    const { player, video, slider } = makePlayer();
    slider.focus();
    player._showControls();
    vi.advanceTimersByTime(1600); // the bar fades after 1.5 s while playing
    expect(player.container.classList.contains('controls-visible')).toBe(false);
    expect(document.activeElement).not.toBe(slider);
    key(document.activeElement, 'ArrowLeft');
    expect(video.currentTime).toBe(115);
  });
});

// ---------------------------------------------------------------------------
// Every other kind of input: only its own keys
// ---------------------------------------------------------------------------

describe('C-01: each kind of <input> owns only the keys it uses', () => {
  let player;
  beforeEach(() => {
    player = {
      video: { volume: 0.5 },
      duration: 300,
      isVRProjecting: false,
      togglePlay: vi.fn(),
      skip: vi.fn(),
      seek: vi.fn(),
      setVolume: vi.fn(),
      toggleMute: vi.fn(),
      toggleFullscreen: vi.fn(),
      clearAbLoop: vi.fn(),
    };
    new KeyboardHandler({ videoPlayer: player });
  });

  function input(html) {
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    document.body.appendChild(wrap);
    const el = wrap.querySelector('input');
    el.focus();
    return el;
  }

  it('a checkbox keeps Space (it toggles) and lets M and F through', () => {
    const box = input('<input type="checkbox">');
    expect(key(box, ' ').defaultPrevented).toBe(false);
    expect(player.togglePlay).not.toHaveBeenCalled();
    key(box, 'm');
    key(box, 'f');
    expect(player.toggleMute).toHaveBeenCalledTimes(1);
    expect(player.toggleFullscreen).toHaveBeenCalledTimes(1);
  });

  it('a radio keeps Space and the arrows that move along its group', () => {
    const radio = input('<input type="radio" name="r">');
    for (const k of [' ', 'ArrowDown', 'ArrowLeft']) expect(key(radio, k).defaultPrevented, k).toBe(false);
    expect(player.togglePlay).not.toHaveBeenCalled();
    expect(player.setVolume).not.toHaveBeenCalled();
    expect(player.skip).not.toHaveBeenCalled();
    key(radio, 'k');
    expect(player.togglePlay).toHaveBeenCalledTimes(1);
  });

  it('a text, number or search field still owns every key, as before', () => {
    for (const type of ['text', 'number', 'search']) {
      const field = input(`<input type="${type}">`);
      for (const k of [' ', 'k', 'm', 'f', 'ArrowLeft', 'ArrowUp', 'Home']) {
        expect(key(field, k).defaultPrevented, `${type} ${k}`).toBe(false);
      }
    }
    const untyped = input('<input>');
    expect(key(untyped, ' ').defaultPrevented).toBe(false);
    expect(player.togglePlay).not.toHaveBeenCalled();
    expect(player.toggleMute).not.toHaveBeenCalled();
    expect(player.toggleFullscreen).not.toHaveBeenCalled();
    expect(player.skip).not.toHaveBeenCalled();
  });

  it('an <input type="button"> follows the <button> rule: Space is play/pause outside a dialog, the button\'s inside one', () => {
    const outside = input('<input type="button" value="Loop">');
    key(outside, ' ');
    expect(player.togglePlay).toHaveBeenCalledTimes(1);
    const inside = input('<div role="dialog" aria-modal="true"><input type="button" value="OK"></div>');
    expect(key(inside, ' ').defaultPrevented).toBe(false);
    expect(player.togglePlay).toHaveBeenCalledTimes(1);
  });
});

// Block C fix-up (2026-11-06, real-app verifier 1; the review's minor
// finding): the C-01 rule reached the sliders INSIDE dialogs too. With the
// mini player playing behind Settings, a focused Playback slider
// (#sp-upnext-countdown) let Space and K pause or play the video and M mute
// it. In v0.9.2 a focused input owned every key; inside a dialog it does
// again. The player bar's slider (C-01) is never in a dialog.
describe('C-01 fix-up: inside a dialog a focused <input> owns every key, as in v0.9.2', () => {
  let player;
  beforeEach(() => {
    player = {
      video: { volume: 0.5 },
      duration: 300,
      isVRProjecting: false,
      togglePlay: vi.fn(),
      skip: vi.fn(),
      seek: vi.fn(),
      setVolume: vi.fn(),
      toggleMute: vi.fn(),
      toggleFullscreen: vi.fn(),
      clearAbLoop: vi.fn(),
    };
    new KeyboardHandler({ videoPlayer: player });
  });

  function inDialog(html) {
    const wrap = document.createElement('div');
    wrap.innerHTML = `<div class="modal-panel" role="dialog" aria-modal="true">${html}</div>`;
    document.body.appendChild(wrap);
    const el = wrap.querySelector('input');
    el.focus();
    return el;
  }

  it('a Settings slider: Space, K, M and F leave the video behind the dialog alone', () => {
    const slider = inDialog('<input type="range" id="sp-upnext-countdown" min="0" max="30" value="10">');
    for (const k of [' ', 'k', 'K', 'm', 'M', 'f', 'j', 'l']) {
      expect(key(slider, k).defaultPrevented, k).toBe(false);
    }
    expect(player.togglePlay).not.toHaveBeenCalled();
    expect(player.toggleMute).not.toHaveBeenCalled();
    expect(player.toggleFullscreen).not.toHaveBeenCalled();
    expect(player.skip).not.toHaveBeenCalled();
    // Its own arrows still step it (the browser default is not prevented).
    expect(key(slider, 'ArrowRight').defaultPrevented).toBe(false);
    expect(player.setVolume).not.toHaveBeenCalled();
  });

  it('a checkbox in the Devices panel: M does not mute the video', () => {
    const box = inDialog('<input type="checkbox">');
    key(box, 'm');
    key(box, 'k');
    expect(player.toggleMute).not.toHaveBeenCalled();
    expect(player.togglePlay).not.toHaveBeenCalled();
  });

  it('outside a dialog the C-01 rule still holds: the bar slider lets Space through', () => {
    const wrap = document.createElement('div');
    wrap.innerHTML = '<input type="range" id="volume-slider" min="0" max="100" value="50">';
    document.body.appendChild(wrap);
    const slider = wrap.querySelector('input');
    slider.focus();
    key(slider, ' ');
    key(slider, 'm');
    expect(player.togglePlay).toHaveBeenCalledTimes(1);
    expect(player.toggleMute).toHaveBeenCalledTimes(1);
  });
});
