/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL KeyboardHandler listens on `document`, the
 * keys are dispatched on real focused elements, and keyboard.js imports
 * i18n.js, which branches on `typeof window` (notes/CLAUDE.md
 * "Test environments").
 */
// Which keys the player's document-level shortcut handler may take, and
// which belong to something else. App test 2026-11-02:
//
//   V45  Ctrl+= / Ctrl+- / Ctrl+0 were taken for VR zoom in every view and
//        on every video, so the View menu's whole-interface zoom (an
//        Electron menu accelerator, which only fires for a key the page did
//        NOT preventDefault) was dead everywhere except a text field.
//        Regression in v0.9.2 (forum #372).
//   V43  Arrow keys, Space and Home/End on a focused <select> (every
//        Settings dropdown) changed the volume, played/paused or seeked,
//        and the preventDefault stopped the dropdown changing.
//   V44  End/Home in the Library were swallowed as "seek the player", so
//        End never scrolled to the last row (and seeked a docked
//        mini-player instead).
//
// Assertions are on what the user would see: whether the player acted
// (volume, play, seek, VR zoom) and whether the browser was left free to do
// its own thing (`defaultPrevented` false is what lets a <select> change,
// the page scroll, or a menu accelerator fire). V44/V45 build the handler
// from app.js's REAL `_keyboardOptions`, so the wiring is under test too.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KeyboardHandler } from '../../renderer/js/keyboard.js';
import { showToast } from '../../renderer/js/toast.js';
import { liftAppClass } from './helpers/app-methods.js';

// Every KeyboardHandler binds to `document` for good. Record the listeners
// each test adds and take them off afterwards, so a handler from an earlier
// test can never act on (or preventDefault) a later test's key.
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
});

function makePlayer() {
  return {
    video: { volume: 0.5 },
    duration: 300,
    isVRProjecting: false,
    togglePlay: vi.fn(),
    skip: vi.fn(),
    seek: vi.fn(),
    setVolume: vi.fn(),
    toggleMute: vi.fn(),
    toggleFullscreen: vi.fn(),
    captureScreenshot: vi.fn(),
    toggleInfoOverlay: vi.fn(),
    setLoopPoint: vi.fn(),
    clearAbLoop: vi.fn(),
    cycleAspectRatio: vi.fn(),
    cyclePlaybackRate: vi.fn(),
  };
}

/** Dispatch a real, cancelable keydown on `target`; return the event. */
function key(target, keyName, init = {}) {
  const e = new KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

function el(html) {
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  document.body.appendChild(wrap);
  return wrap;
}

// ---------------------------------------------------------------------------
// V45 — Ctrl+= / Ctrl+- / Ctrl+0
// ---------------------------------------------------------------------------

const Lifted = liftAppClass(['_keyboardOptions', '_currentView'], {});

/** The app state the REAL `_keyboardOptions` closures read. */
function makeApp({ view = 'library', stereo = null, path = null, popout = false } = {}) {
  const app = new Lifted();
  Object.assign(app, {
    videoPlayer: makePlayer(),
    connectionPanel: null,
    dragDrop: { _openNativeDialog: vi.fn() },
    queuePanel: null,
    _navStack: view === 'library' ? ['library'] : ['library', view],
    _currentStereoFormat: stereo,
    _currentVideoPath: path,
    _navigateTo: vi.fn(),
    _toggleQueuePanel: vi.fn(),
    _jumpChapter: vi.fn(),
    _jumpBookmark: vi.fn(),
    _playNext: vi.fn(),
    _playPrev: vi.fn(),
    _seekedPopoutTo: null,
    // The pop-out route: true (took it) only while the pop-out owns playback.
    _playerWindowPlayback: vi.fn((command, arg) => {
      if (!popout) return false;
      app._seekedPopoutTo = { command, arg };
      return true;
    }),
  });
  return app;
}

/** The REAL handler with the REAL app wiring, and VR zoom hooked as init does. */
function wire(app) {
  const handler = new KeyboardHandler(app._keyboardOptions());
  handler.onVRZoom = vi.fn();
  handler.onVRZoomReset = vi.fn();
  return handler;
}

describe('V45: Ctrl+= / Ctrl+- / Ctrl+0 are VR zoom only with a VR video open in the player', () => {
  const VR = { view: 'player', stereo: 'sbs-half', path: 'D:\\Lib\\Scene_180_LR.mp4' };

  it('in the Library they are left alone, so the View menu zooms the interface', () => {
    const app = makeApp({ view: 'library' });
    const kb = wire(app);
    for (const [k, code] of [['=', 'Equal'], ['+', 'Equal'], ['-', 'Minus'], ['0', 'Digit0']]) {
      const e = key(document.body, k, { code, ctrlKey: true });
      expect(e.defaultPrevented, `Ctrl+${k} must reach the menu accelerator`).toBe(false);
    }
    expect(kb.onVRZoom).not.toHaveBeenCalled();
    expect(kb.onVRZoomReset).not.toHaveBeenCalled();
  });

  it('on a flat video in the player they are left alone too', () => {
    const app = makeApp({ view: 'player', stereo: null, path: 'D:\\Lib\\Flat.mp4' });
    const kb = wire(app);
    expect(key(document.body, '=', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(key(document.body, '-', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(key(document.body, '0', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(kb.onVRZoom).not.toHaveBeenCalled();
  });

  it('a VR video docked in the mini-player over the Library does not take them', () => {
    const app = makeApp({ view: 'library', stereo: 'sbs-half', path: VR.path });
    const kb = wire(app);
    expect(key(document.body, '=', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(kb.onVRZoom).not.toHaveBeenCalled();
  });

  it('with a VR video open in the player they zoom the video and the interface stays put', () => {
    const app = makeApp(VR);
    const kb = wire(app);
    expect(key(document.body, '=', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(key(document.body, '-', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(key(document.body, '0', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(kb.onVRZoom.mock.calls).toEqual([[1], [-1]]);
    expect(kb.onVRZoomReset).toHaveBeenCalledTimes(1);
  });

  it('with the script editor open they stay out of the way, VR video or not', () => {
    const app = makeApp(VR);
    const kb = wire(app);
    kb.scriptEditor = { isOpen: true, hide: vi.fn(), toggle: vi.fn() };
    expect(key(document.body, '=', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(kb.onVRZoom).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// V43 — a focused control keeps its keys
// ---------------------------------------------------------------------------

describe('V43: a focused dropdown, list, text field or dialog button keeps its own keys', () => {
  let player;
  beforeEach(() => {
    player = makePlayer();
    new KeyboardHandler({ videoPlayer: player });
  });

  it('Arrow keys, Space, Home/End and letters on a focused <select> leave the volume and video alone', () => {
    // The Settings modal: a dropdown inside an aria-modal dialog.
    const root = el(`<div role="dialog" aria-modal="true"><select id="s">
      <option value="hold">Hold</option><option value="toggle">Toggle</option></select></div>`);
    const select = root.querySelector('#s');
    select.focus();
    for (const k of ['ArrowDown', 'ArrowUp', ' ', 'Home', 'End', 'k', 't']) {
      const e = key(select, k);
      expect(e.defaultPrevented, `${JSON.stringify(k)} must reach the <select>`).toBe(false);
    }
    expect(player.setVolume).not.toHaveBeenCalled();
    expect(player.togglePlay).not.toHaveBeenCalled();
    expect(player.seek).not.toHaveBeenCalled();
  });

  it('a select OUTSIDE a dialog is just as off-limits', () => {
    const select = el('<select id="s"><option>a</option><option>b</option></select>').querySelector('#s');
    expect(key(select, 'ArrowDown').defaultPrevented).toBe(false);
    expect(player.setVolume).not.toHaveBeenCalled();
  });

  it('an option inside a role=listbox (the Library sort picker) keeps its arrows', () => {
    const opt = el(`<div role="listbox"><div role="option" tabindex="0" id="o">Name</div></div>`).querySelector('#o');
    expect(key(opt, 'ArrowDown').defaultPrevented).toBe(false);
    expect(key(opt, ' ').defaultPrevented).toBe(false);
    expect(player.setVolume).not.toHaveBeenCalled();
    expect(player.togglePlay).not.toHaveBeenCalled();
  });

  it('typing k / m / f in a contenteditable does not play, mute or go fullscreen', () => {
    const ed = el('<div contenteditable="true" id="c">note</div>').querySelector('#c');
    for (const k of ['k', 'm', 'f', ' ']) key(ed, k);
    expect(player.togglePlay).not.toHaveBeenCalled();
    expect(player.toggleMute).not.toHaveBeenCalled();
    expect(player.toggleFullscreen).not.toHaveBeenCalled();
  });

  it('Space on a button in a modal dialog activates the button, not play/pause under the dialog', () => {
    const btn = el('<div role="dialog" aria-modal="true"><button id="ok">Got it</button></div>').querySelector('#ok');
    const e = key(btn, ' ');
    expect(e.defaultPrevented).toBe(false); // the button's native activation runs
    expect(player.togglePlay).not.toHaveBeenCalled();
  });

  it('Space on a player control button (no dialog) still plays/pauses, as its tooltip says', () => {
    const btn = el('<div class="controls"><button id="loop">Loop</button></div>').querySelector('#loop');
    const e = key(btn, ' ');
    expect(player.togglePlay).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true); // so the focused button is not ALSO clicked
  });

  it('a key a focused control already handled is not handled again (no double seek on the slider)', () => {
    // The progress bar is role="slider" with its own Arrow/Home/End seeking
    // (video-player.js), which calls preventDefault. The player handler
    // seeked a second time on top: ArrowLeft jumped 10 s, not 5.
    const slider = el('<div role="slider" tabindex="0" id="p"></div>').querySelector('#p');
    let ownSeeks = 0;
    slider.addEventListener('keydown', (e) => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { e.preventDefault(); ownSeeks++; }
    });
    key(slider, 'ArrowLeft');
    key(slider, 'End');
    expect(ownSeeks).toBe(2);
    expect(player.skip).not.toHaveBeenCalled();
    expect(player.seek).not.toHaveBeenCalled();
    // Space is not the slider's: it still plays/pauses from there.
    key(slider, ' ');
    expect(player.togglePlay).toHaveBeenCalledTimes(1);
  });

  it('Space on a focused toast dismisses the toast and does not also toggle the video', () => {
    el('<div id="toast-container"></div>');
    const handle = showToast('Saved', 'info', 0);
    handle.el.focus();
    key(handle.el, ' ');
    expect(handle.el.classList.contains('toast--out')).toBe(true);
    expect(player.togglePlay).not.toHaveBeenCalled();
  });

  it('Space / Enter on a button IN a toast (a sort or gap-skip Undo) is the button\'s: not cancelled, and no play/pause', () => {
    el('<div id="toast-container"></div>');
    const body = document.createElement('div');
    const undo = document.createElement('button');
    undo.textContent = 'Undo';
    body.appendChild(undo);
    const handle = showToast(body, 'info', 0);
    undo.focus();
    for (const k of [' ', 'Enter']) {
      const e = key(undo, k);
      expect(e.defaultPrevented, `${JSON.stringify(k)} must reach the button`).toBe(false);
    }
    expect(player.togglePlay).not.toHaveBeenCalled();
    expect(handle.el.classList.contains('toast--out')).toBe(false);
  });

  it('an Escape a surface marked taken clears nothing else (FT-072)', () => {
    // The overflow menu / speed popover / device panel preventDefault the Esc
    // that closes them. This test pinned v0.9.2's behaviour, where that same
    // press then cleared the A-B loop too; it is one press, one layer now.
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    e.preventDefault();
    document.body.dispatchEvent(e);
    expect(player.clearAbLoop).not.toHaveBeenCalled();
    // The next Esc, which nothing on top takes, clears the loop as before.
    key(document.body, 'Escape');
    expect(player.clearAbLoop).toHaveBeenCalledTimes(1);
  });

  it('keys on the page body still drive the player', () => {
    key(document.body, 'ArrowDown');
    key(document.body, ' ');
    expect(player.setVolume).toHaveBeenCalledWith(0.45);
    expect(player.togglePlay).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// V44 — Home/End belong to the page outside the player
// ---------------------------------------------------------------------------

describe('V44: Home / End scroll the Library instead of seeking', () => {
  it('in the Library End and Home are left to the page (it scrolls) and nothing seeks', () => {
    const app = makeApp({ view: 'library', path: 'D:\\Lib\\Docked.mp4' }); // mini-player docked
    wire(app);
    expect(key(document.body, 'End').defaultPrevented).toBe(false);
    expect(key(document.body, 'Home').defaultPrevented).toBe(false);
    expect(app.videoPlayer.seek).not.toHaveBeenCalled();
  });

  it('in Playlists and Categories too', () => {
    for (const view of ['playlists', 'categories']) {
      const app = makeApp({ view });
      wire(app);
      expect(key(document.body, 'End').defaultPrevented, view).toBe(false);
      expect(app.videoPlayer.seek, view).not.toHaveBeenCalled();
    }
  });

  it('on the player view they still jump to the start / just before the end', () => {
    const app = makeApp({ view: 'player', path: 'D:\\Lib\\Alpha.mp4' });
    wire(app);
    expect(key(document.body, 'End').defaultPrevented).toBe(true);
    expect(key(document.body, 'Home').defaultPrevented).toBe(true);
    expect(app.videoPlayer.seek.mock.calls).toEqual([[299.95], [0]]);
  });

  it('while the pop-out owns playback they still seek the pop-out from the Library (V13)', () => {
    const app = makeApp({ view: 'library', popout: true });
    wire(app);
    expect(key(document.body, 'End').defaultPrevented).toBe(true);
    expect(app._seekedPopoutTo).toEqual({ command: 'seekToEnd', arg: undefined });
    expect(app.videoPlayer.seek).not.toHaveBeenCalled();
  });
});

// Found 2a-dialog (2026-11-18, latent): targetOwnsKey read the navigation mark BEFORE its input rules,
// so a text box inside a data-owns-keys="navigation" list owned only the arrows, and "f" typed there
// toggled fullscreen behind it.
describe('a control inside a navigation-only list keeps its own keys', () => {
  function setup() {
    const player = makePlayer();
    new KeyboardHandler({ videoPlayer: player, scriptEditor: { isOpen: false } });
    const list = document.createElement('div');
    list.setAttribute('data-owns-keys', 'navigation');
    list.setAttribute('role', 'listbox');
    list.tabIndex = 0;
    list.innerHTML = '<input type="text" id="t"><input type="checkbox" id="c"><select id="s"><option>a</option></select><div role="option" tabindex="-1" id="o">Buzz</div>';
    document.body.appendChild(list);
    return { player, list, text: list.querySelector('#t'), box: list.querySelector('#c'), sel: list.querySelector('#s'), opt: list.querySelector('#o') };
  }

  it('typing f, k, m in a text box there reaches the box, not the player', () => {
    const { player, text } = setup();
    for (const k of ['f', 'k', 'm', ' ']) key(text, k);
    expect(player.toggleFullscreen).not.toHaveBeenCalled();
    expect(player.togglePlay).not.toHaveBeenCalled();
    expect(player.toggleMute).not.toHaveBeenCalled();
  });

  it('a checkbox there owns Space; F still goes to the player, as on any checkbox', () => {
    const { player, box } = setup();
    key(box, ' ');
    expect(player.togglePlay).not.toHaveBeenCalled();
    key(box, 'f');
    expect(player.toggleFullscreen).toHaveBeenCalledTimes(1);
  });

  it('a select there owns every key', () => {
    const { player, sel } = setup();
    key(sel, 'f');
    expect(player.toggleFullscreen).not.toHaveBeenCalled();
  });

  it('the list itself and its options still own only the navigation keys: F goes to the player, the arrows stay', () => {
    const { player, list, opt } = setup();
    key(list, 'f');
    key(opt, 'f');
    expect(player.toggleFullscreen).toHaveBeenCalledTimes(2);
    key(opt, 'ArrowRight');
    expect(player.skip).not.toHaveBeenCalled();
  });
});

// FT-104 re-check (fixed 2026-11-22): an Up Next card armed in a player hidden behind another view took the
// first Esc there (dismissed, nothing visible changed), so the queue panel needed a second Esc.
describe('Esc and an Up Next card nobody can see', () => {
  function setup(view, offView = false) {
    const player = makePlayer();
    const onToggleQueue = vi.fn();
    const h = new KeyboardHandler({
      videoPlayer: player, scriptEditor: { isOpen: false },
      getView: () => view, hasOffViewPlayer: () => offView,
      isQueueOpen: () => true, onToggleQueue,
    });
    h.upNextEngine = { visible: true, dismiss: vi.fn() };
    return { h, onToggleQueue };
  }

  it('in a playlist view with the player hidden: Esc closes the queue panel; the hidden card is left alone', () => {
    const { h, onToggleQueue } = setup('playlists');
    key(document.body, 'Escape');
    expect(h.upNextEngine.dismiss).not.toHaveBeenCalled();
    expect(onToggleQueue).toHaveBeenCalledTimes(1);
  });

  it('in the player view (or with the mini player showing) Esc dismisses the card first, as before', () => {
    const a = setup('player');
    key(document.body, 'Escape');
    expect(a.h.upNextEngine.dismiss).toHaveBeenCalledTimes(1);
    expect(a.onToggleQueue).not.toHaveBeenCalled();
    for (const [type, fn, opts] of added.splice(0)) document.removeEventListener(type, fn, opts);
    const b = setup('library', true);
    key(document.body, 'Escape');
    expect(b.h.upNextEngine.dismiss).toHaveBeenCalledTimes(1);
  });
});
