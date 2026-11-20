/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL ScriptEditor builds its panel in the document,
 * and real KeyboardEvents reach the REAL KeyboardHandler on `document`
 * (notes/CLAUDE.md "Test environments").
 */
// E2-01 (also in v0.9.2): E in the main window while the PLAYER is popped out
// opened the editor out of sight. The docked editor lives in the player view;
// with the player in its own window the main window shows the Library, so E
// opened it into the hidden view (the state E-07 fixed for Dock), and E again
// only closed that hidden copy, leaving an editor window open.
//
// Now, while the player window owns playback, E opens the editor in its own
// window and E again closes that window; the player window stays. Elsewhere
// E toggles the docked editor as before, and Dock in the editor window still
// docks the player too (E-07).
//
// The REAL KeyboardHandler is built from app.js's REAL `_keyboardOptions`; the
// REAL app.js methods (_toggleScriptEditor, _initPlayerWindow,
// _onEditorDocked, _deactivatePlayerWindow) are lifted over recording fakes
// for main. Asserted: which windows are open, what the main window shows, and
// whether the editor is open.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { liftAppClass } from './helpers/app-methods.js';
import { RemotePlaybackProxy } from '../../renderer/js/remote-playback-proxy.js';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { t } = await import('../../renderer/js/i18n.js');
const { showToast } = await import('../../renderer/js/toast.js');
const { ScriptEditor } = await import('../../renderer/components/script-editor.js');
const { KeyboardHandler } = await import('../../renderer/js/keyboard.js');

const PATH = 'C:\\sandbox\\library\\Long 30fps.funscript';
const ACTIONS = Array.from({ length: 40 }, (_, i) => ({ at: i * 500, pos: i % 2 ? 90 : 10 }));

// One handler per test, forwarded from one document listener (the real one
// binds to `document` for good).
class TestKeyboardHandler extends KeyboardHandler { _bindEvents() {} }
let keys = null;
document.addEventListener('keydown', (e) => keys?._onKeyDown(e));

let editorEvent;   // main's editor-popout:event, into the parent
let playerEvent;   // main's player-popout:event, into the parent
let editorWindow;  // is main's editor window open?
let playerCloses;
let ed;
let app;
let view;

const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); };
const pressE = () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', code: 'KeyE', bubbles: true, cancelable: true }));

function build() {
  document.body.innerHTML = '<div id="player-container"></div>';
  const video = Object.assign(new EventTarget(), {
    currentTime: 12, duration: 60, paused: true, src: 'file:///C:/sandbox/library/Long%2030fps.mp4', loop: false,
    currentSrc: 'file:///C:/sandbox/library/Long%2030fps.mp4',
    play: vi.fn(function play() { this.paused = false; return Promise.resolve(); }),
    pause: vi.fn(function pause() { this.paused = true; }),
  });
  const videoPlayer = Object.assign(new EventTarget(), {
    video,
    get currentTime() { return video.currentTime; },
    get duration() { return video.duration; },
    setPlaybackRate() {},
    togglePlay: vi.fn(), skip: vi.fn(),
  });
  ed = new ScriptEditor({
    videoPlayer,
    funscriptEngine: { isLoaded: false, getActions: () => [], getMetadata: () => null },
    progressBar: { renderHeatmap() {} },
    settings: { get: () => undefined, set() {} },
  });
  ed._sendLivePreview = () => {};
  ed._reuploadToHandy = () => {};
  ed.setFunscriptPath(PATH);
  ed.editableScript.loadFromData({ version: '1.0', actions: ACTIONS });

  const Lifted = liftAppClass(
    ['_keyboardOptions', '_toggleScriptEditor', '_initPlayerWindow', '_onEditorDocked', '_deactivatePlayerWindow'],
    { window: { get funsync() { return window.funsync; } }, showToast, t, console },
  );
  app = Object.assign(new Lifted(), {
    videoPlayer,
    scriptEditor: ed,
    connectionPanel: { toggle: vi.fn(), hide: vi.fn() },
    dragDrop: { _openNativeDialog: vi.fn() },
    queuePanel: { visible: false },
    _miniActive: false,
    _updatePlayerWindowButton: () => {},
    _onPlayerWindowMessage: () => {},
    _currentPopoutVideo: () => ({ path: 'C:\\sandbox\\library\\Long 30fps.mp4' }),
    _currentView: () => view,
    _navigateTo: (v) => { view = v; },
    _playerWindowPlayback: () => false,
  });
  app._initPlayerWindow();
  // As app.js init() wires the editor and the keys.
  ed.onPopoutDocked = () => app._onEditorDocked();
  const editorOwnToggle = ed.toggle.bind(ed);
  ed.toggle = () => app._toggleScriptEditor(editorOwnToggle);
  keys = new TestKeyboardHandler(app._keyboardOptions());
  keys.scriptEditor = ed;
}

/** The player pops out: main opened its window and the take-over ran (the Library shows). */
function popOutPlayer({ at = 34000, paused = true } = {}) {
  playerEvent({ type: 'opened' });
  app._playerWinProxy = new RemotePlaybackProxy();
  app._playerWinProxy.updateState({ at, paused, duration: 60 });
  app._playerWindowActive = true;
  view = 'library';
}

beforeEach(() => {
  editorEvent = null;
  playerEvent = null;
  editorWindow = false;
  playerCloses = 0;
  view = 'player';
  window.funsync = {
    onEditorPopoutEvent: (cb) => { editorEvent = cb; return () => {}; },
    onPlayerPopoutEvent: (cb) => { playerEvent = cb; },
    // Main's broker: the window's 'opened' / 'closed' come back a beat later.
    editorPopoutOpen: vi.fn(async () => {
      if (editorWindow) return;
      editorWindow = true;
      setTimeout(() => editorEvent({ type: 'opened' }), 0);
    }),
    editorPopoutClose: vi.fn(async () => {
      if (!editorWindow) return;
      editorWindow = false;
      setTimeout(() => editorEvent({ type: 'closed' }), 0);
    }),
    editorPopoutRelay: () => {},
    playerPopoutClose: vi.fn(async () => { playerCloses++; setTimeout(() => playerEvent({ type: 'closed' }), 0); }),
    editorDirtyChanged() {},
    readFunscript: async () => JSON.stringify({ version: '1.0', actions: ACTIONS }),
    writeFunscript: async (json, p) => p,
    filesExist: async (paths) => paths.map(() => true),
    setSetting() {},
    updateWindowChrome() {},
  };
  if (typeof globalThis.requestAnimationFrame !== 'function') globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  build();
});

afterEach(() => {
  keys = null;
  delete window.funsync;
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('E2-01: E with the player in its own window', () => {
  it('opens the editor in its own window; the main window stays on the Library, the player window stays', async () => {
    popOutPlayer();
    pressE();
    await flush();
    expect(editorWindow).toBe(true);
    expect(ed.isOpen).toBe(true);
    expect(ed._panel.hidden).toBe(true); // nothing in the hidden player view
    expect(view).toBe('library');
    expect(playerCloses).toBe(0);
    expect(app._playerWindowActive).toBe(true);
  });

  it('E again closes the editor window and leaves the player window where it is', async () => {
    popOutPlayer();
    pressE();
    await flush();
    expect(editorWindow).toBe(true);
    pressE();
    await flush();
    expect(editorWindow).toBe(false);
    expect(ed.isOpen).toBe(false);
    expect(playerCloses).toBe(0);
    expect(app._playerWindowActive).toBe(true);
    expect(view).toBe('library');
  });

  it('an editor window opened with its own button: E closes it (v0.9.2 closed only the hidden copy)', async () => {
    ed.toggle();
    await ed._togglePopoutWindow(); // the docked editor's pop-out button
    await flush();
    popOutPlayer();
    expect(editorWindow).toBe(true);
    pressE();
    await flush();
    expect(editorWindow).toBe(false);
    expect(ed.isOpen).toBe(false);
    expect(playerCloses).toBe(0);
  });

  it('an editor left open in the player view before the player popped out: E brings it to its own window, not closed', async () => {
    ed.toggle(); // E on the player view: the docked editor
    expect(ed.isOpen).toBe(true);
    expect(window.funsync.editorPopoutOpen).not.toHaveBeenCalled();
    popOutPlayer();
    pressE();
    await flush();
    expect(ed.isOpen).toBe(true);
    expect(editorWindow).toBe(true);
  });

  it('Dock in that editor window still docks the player too (E-07)', async () => {
    popOutPlayer();
    pressE();
    await flush();
    expect(editorWindow).toBe(true);
    editorWindow = false;
    editorEvent({ type: 'closed' }); // the window's Dock
    await flush();
    expect(playerCloses).toBe(1);
    expect(app._playerWindowActive).toBe(false);
    expect(view).toBe('player');
    expect(ed.isOpen).toBe(true);
    expect(ed._panel.hidden).toBe(false);
  });
});

describe('E with the player in the main window: the docked editor, as before', () => {
  it('opens and closes the docked editor; no editor window', async () => {
    pressE();
    await flush();
    expect(ed.isOpen).toBe(true);
    expect(ed._panel.hidden).toBe(false);
    pressE();
    await flush();
    expect(ed.isOpen).toBe(false);
    expect(window.funsync.editorPopoutOpen).not.toHaveBeenCalled();
    expect(window.funsync.editorPopoutClose).not.toHaveBeenCalled();
  });
});
