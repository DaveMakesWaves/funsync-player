/**
 * @vitest-environment jsdom
 * jsdom on purpose: real KeyboardEvents on real focused elements reach the
 * REAL KeyboardHandler on `document` (notes/CLAUDE.md "Test environments").
 */
// CB-05: after Back from the player with the mini player off, Space in the
// Library played the hidden, paused video (audio, no picture): keyboard.js's
// playback keys had no view check. They now act only while a player is on
// screen: the player view, the docked mini player, or the detached player
// window. Elsewhere they do nothing and are NOT prevented, so Space reaches
// a focused control and the arrows scroll the page.
//
// CB-06: Alt+1/2/3 (Library / Playlists / Categories) never fired on AZERTY,
// whose unshifted number row types & é ": they match the key now.
//
// The handler is the REAL KeyboardHandler built from app.js's REAL
// `_keyboardOptions` (lifted), so the wiring that decides "is a player on
// screen" is the app's own. Assertions: what the player was told to do, and
// whether the browser's own action for the key was cancelled.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { liftAppClass } from './helpers/app-methods.js';

const { KeyboardHandler } = await import('../../renderer/js/keyboard.js');

const Lifted = liftAppClass(['_keyboardOptions'], {});

// One handler per test, forwarded from one pair of document listeners (the
// real one binds to `document` for good).
class TestKeyboardHandler extends KeyboardHandler { _bindEvents() {} }
let keys = null;
document.addEventListener('keydown', (e) => keys?._onKeyDown(e));
document.addEventListener('keyup', (e) => keys?._onKeyUp(e));

let app;
function build({ view = 'library', mini = false, popout = false } = {}) {
  const player = {
    video: { volume: 0.5 },
    togglePlay: vi.fn(), skip: vi.fn(), seek: vi.fn(), setVolume: vi.fn(),
    toggleMute: vi.fn(), toggleFullscreen: vi.fn(), captureScreenshot: vi.fn(),
    toggleInfoOverlay: vi.fn(), setLoopPoint: vi.fn(), cycleAspectRatio: vi.fn(),
    cyclePlaybackRate: vi.fn(), clearAbLoop: vi.fn(), isVRProjecting: false,
  };
  app = Object.assign(new Lifted(), {
    videoPlayer: player,
    connectionPanel: { toggle: vi.fn(), hide: vi.fn() },
    dragDrop: { _openNativeDialog: vi.fn() },
    queuePanel: { visible: false },
    _miniActive: mini,
    _playerWindowActive: popout,
    _currentView: () => view,
    _navigateTo: vi.fn(),
    _toggleQueuePanel: vi.fn(),
    _jumpChapter: vi.fn(),
    _jumpBookmark: vi.fn(),
    _playNext: vi.fn(),
    _playPrev: vi.fn(),
    // The pop-out takes a playback command only while it owns playback.
    _playerWindowPlayback: vi.fn(() => popout),
  });
  keys = new TestKeyboardHandler(app._keyboardOptions());
  keys.scriptEditor = { isOpen: false, toggle: vi.fn(), hide: vi.fn() };
  keys.onCycleVariant = vi.fn();
  keys.onOrgasmHold = vi.fn();
  return player;
}

/** Press `key` on `target` (default: the page); returns the event. */
function press(key, { target = document.body, code, ...mods } = {}) {
  const e = new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...mods });
  target.dispatchEvent(e);
  return e;
}

beforeEach(() => {
  document.body.innerHTML = '';
  keys = null;
});

describe('playback keys act only on a player the user can see (CB-05)', () => {
  it('the verifier\'s repro: Library, mini player off, Space plays nothing and is not taken', () => {
    const player = build({ view: 'library' });
    const e = press(' ');
    expect(player.togglePlay).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it('in the Library the arrows scroll the page instead of seeking or changing the volume', () => {
    const player = build({ view: 'library' });
    for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
      expect(press(k).defaultPrevented).toBe(false);
    }
    expect(player.skip).not.toHaveBeenCalled();
    expect(player.setVolume).not.toHaveBeenCalled();
  });

  it('nor any other playback key: K J L M F S I A B R < > , . G, the editor, variants, next/previous', () => {
    const player = build({ view: 'playlists' });
    for (const k of ['k', 'j', 'l', 'L', 'm', 'f', 'F11', 's', 'i', 'a', 'b', 'r', 'R', '<', '>', ',', '.', 'g', 'G', 'e', 'v', 'n', 'p']) {
      expect(press(k, { shiftKey: k === 'L' || k === 'R' || k === 'G' }).defaultPrevented, k).toBe(false);
    }
    for (const fn of Object.values(player)) if (typeof fn === 'function' && fn.mock) expect(fn).not.toHaveBeenCalled();
    expect(keys.scriptEditor.toggle).not.toHaveBeenCalled(); // E would open an editor, and auto-create a script, behind the Library
    expect(keys.onCycleVariant).not.toHaveBeenCalled();
    expect(app._playNext).not.toHaveBeenCalled();
    expect(app._playPrev).not.toHaveBeenCalled();
    expect(app._jumpChapter).not.toHaveBeenCalled();
  });

  it('Space on a focused Library button is the button\'s again (not cancelled)', () => {
    build({ view: 'library' });
    document.body.innerHTML = '<button id="card">Play All</button>';
    const btn = document.getElementById('card');
    btn.focus();
    expect(press(' ', { target: btn }).defaultPrevented).toBe(false);
  });

  it('the player view: Space and the arrows drive the player as before', () => {
    const player = build({ view: 'player' });
    expect(press(' ').defaultPrevented).toBe(true);
    press('ArrowRight');
    press('ArrowUp');
    expect(player.togglePlay).toHaveBeenCalledTimes(1);
    expect(player.skip).toHaveBeenCalledWith(5);
    expect(player.setVolume).toHaveBeenCalledTimes(1);
  });

  it('the docked mini player on the Library is on screen: Space toggles it', () => {
    const player = build({ view: 'library', mini: true });
    expect(press(' ').defaultPrevented).toBe(true);
    expect(player.togglePlay).toHaveBeenCalledTimes(1);
  });

  it('the detached player window owns playback: Space on the Library goes to it, never the hidden inline player', () => {
    const player = build({ view: 'library', popout: true });
    expect(press(' ').defaultPrevented).toBe(true);
    expect(app._playerWindowPlayback).toHaveBeenCalledWith('toggle', undefined);
    expect(player.togglePlay).not.toHaveBeenCalled();
  });

  it('keys that are not playback still work in the Library: H, Shift+Q, O, X, Esc', () => {
    build({ view: 'library' });
    press('h');
    press('Q', { shiftKey: true });
    press('o');
    press('x');
    expect(app.connectionPanel.toggle).toHaveBeenCalledTimes(1);
    expect(app._toggleQueuePanel).toHaveBeenCalledTimes(1);
    expect(app.dragDrop._openNativeDialog).toHaveBeenCalledTimes(1);
    expect(keys.onOrgasmHold).toHaveBeenCalledWith(true);
  });
});

describe('Alt+1/2/3 on the number-row key, whatever the layout types there (CB-06)', () => {
  it('AZERTY: Alt+& / Alt+é / Alt+" switch to Library / Playlists / Categories', () => {
    build({ view: 'player' });
    press('&', { code: 'Digit1', altKey: true });
    press('é', { code: 'Digit2', altKey: true });
    press('"', { code: 'Digit3', altKey: true });
    expect(app._navigateTo.mock.calls.map((c) => c[0])).toEqual(['library', 'playlists', 'categories']);
  });

  it('US keys are unchanged, and a numpad digit still counts', () => {
    build({ view: 'player' });
    press('1', { code: 'Digit1', altKey: true });
    press('3', { code: 'Numpad3', altKey: true });
    expect(app._navigateTo.mock.calls.map((c) => c[0])).toEqual(['library', 'categories']);
  });

  it('AZERTY\'s other number-row keys keep their own meaning: Alt+( (Digit5) navigates nowhere', () => {
    build({ view: 'player' });
    press('(', { code: 'Digit5', altKey: true });
    expect(app._navigateTo).not.toHaveBeenCalled();
  });
});
