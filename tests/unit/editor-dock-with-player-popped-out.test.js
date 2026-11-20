/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL ScriptEditor builds its panel in the document,
 * and script-editor.js imports DOM-branching modules (notes/CLAUDE.md "Test
 * environments").
 */
// Two editor pop-out leftovers from D-01 (verify-3), both also in v0.9.2.
//
// E-07: Dock while the PLAYER is popped out left the editor out of sight.
// Editor popped out, player popped out too (the main window goes to the
// Library), Dock in the editor pop-out: the pop-out closed and the editor
// stayed open, docked into the player view the main window was not showing,
// at the hidden inline copy's stale time. It showed again only once the
// player window was closed by hand. Docking the editor now docks the player
// too: the player window closes, playback folds back where it was, and the
// player view opens with the editor in it.
//
// E-08: after one pop-out / dock cycle the editor's pop-out button tooltip
// and aria-label were English literals in every language, and the
// "Pop-out unavailable" toast was English too.
//
// The parent's REAL ScriptEditor receives the editor pop-out's lifecycle
// events as main sends them; the REAL app.js methods (_initPlayerWindow,
// _onEditorDocked, _deactivatePlayerWindow) are lifted over recording fakes.
// Asserted: what the main window shows, where playback is, what the button
// says.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { liftAppClass } from './helpers/app-methods.js';
import { RemotePlaybackProxy } from '../../renderer/js/remote-playback-proxy.js';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { _setBundlesForTests, t } = await import('../../renderer/js/i18n.js');
const { eventBus } = await import('../../renderer/js/event-bus.js');
const { showToast } = await import('../../renderer/js/toast.js');
const { ScriptEditor } = await import('../../renderer/components/script-editor.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
// The two keys E-08 added, as the strings stage writes them into en.json.
const NEW_EN = {
  'editor.btn.dock': 'Dock editor back to main window',
  'editor.toast.popoutUnavailable': 'The editor cannot pop out: the app bridge is missing.',
};
const withKey = (bundle, dotted, value) => {
  const parts = dotted.split('.');
  let o = bundle;
  for (const p of parts.slice(0, -1)) o = (o[p] = { ...(o[p] || {}) });
  if (o[parts.at(-1)] === undefined) o[parts.at(-1)] = value;
};
const enWithNew = () => {
  const b = JSON.parse(JSON.stringify(EN));
  for (const [k, v] of Object.entries(NEW_EN)) withKey(b, k, v);
  return b;
};
/** The English text of a key, the new ones included. */
const enVal = (key) => key.split('.').reduce((o, p) => o?.[p], enWithNew());
/** A pseudo-locale: every English string wrapped, so a literal stands out. */
const pseudo = (tag) => {
  const wrap = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? `${tag}[${v}]` : wrap(v)]));
  return wrap(enWithNew());
};

const PATH = 'C:\\sandbox\\library\\Long 30fps.funscript';
const ACTIONS = Array.from({ length: 40 }, (_, i) => ({ at: i * 500, pos: i % 2 ? 90 : 10 }));

let editorEvent;   // main's editor-popout:event, into the parent
let playerEvent;   // main's player-popout:event, into the parent
let closes;        // playerPopoutClose calls
let ed;
let app;
let video;         // the main window's inline <video> stand-in
let view;          // the main window's current view

const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); };

function buildEditor() {
  document.body.innerHTML = '<div id="player-container"></div>';
  video = Object.assign(new EventTarget(), {
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
  return videoPlayer;
}

function buildApp(videoPlayer) {
  const Lifted = liftAppClass(['_initPlayerWindow', '_onEditorDocked', '_deactivatePlayerWindow'], {
    window: { get funsync() { return window.funsync; } },
    showToast,
    t,
    console,
  });
  app = new Lifted();
  Object.assign(app, {
    videoPlayer,
    scriptEditor: ed,
    _updatePlayerWindowButton: () => {},
    _onPlayerWindowMessage: () => {},
    _currentPopoutVideo: () => ({ path: 'C:\\sandbox\\library\\Long 30fps.mp4' }),
    _currentView: () => view,
    _navigateTo: (v) => { view = v; },
  });
  app._initPlayerWindow();
  // As app.js init() wires the editor.
  ed.onPopoutDocked = () => app._onEditorDocked();
  return app;
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
  _setBundlesForTests('en', enWithNew(), enWithNew());
  editorEvent = null;
  playerEvent = null;
  closes = 0;
  view = 'player';
  window.funsync = {
    onEditorPopoutEvent: (cb) => { editorEvent = cb; return () => {}; },
    onPlayerPopoutEvent: (cb) => { playerEvent = cb; },
    editorPopoutOpen: async () => {},
    editorPopoutClose: async () => {},
    editorPopoutRelay: () => {},
    // Main closes the player window; its 'closed' event comes back a beat later.
    playerPopoutClose: vi.fn(async () => { closes++; setTimeout(() => playerEvent({ type: 'closed' }), 0); }),
    editorDirtyChanged() {},
    readFunscript: async () => JSON.stringify({ version: '1.0', actions: ACTIONS }),
    writeFunscript: async (json, p) => p,
    filesExist: async (paths) => paths.map(() => true),
    setSetting() {},
    updateWindowChrome() {},
  };
  if (typeof globalThis.requestAnimationFrame !== 'function') globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  buildApp(buildEditor());
  ed.show();
});

afterEach(() => {
  delete window.funsync;
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('E-07: Dock with the player popped out shows the editor', () => {
  it('paused: the player window closes, the player view opens at the window\'s time, the editor in it, still paused', async () => {
    editorEvent({ type: 'opened' }); // the editor pops out
    popOutPlayer({ at: 34000, paused: true });
    expect(ed._panel.hidden).toBe(true);

    editorEvent({ type: 'closed' }); // Dock in the editor pop-out
    await flush();

    expect(closes).toBe(1);
    expect(app._playerWindowActive).toBe(false);
    expect(view).toBe('player');
    expect(ed.isOpen).toBe(true);
    expect(ed._panel.hidden).toBe(false);
    expect(document.getElementById('player-container').classList.contains('player-container--editor-open')).toBe(true);
    expect(video.currentTime).toBe(34);
    expect(video.play).not.toHaveBeenCalled();
  });

  it('playing: playback carries on in the main window, where the editor is', async () => {
    editorEvent({ type: 'opened' });
    popOutPlayer({ at: 20000, paused: false });

    editorEvent({ type: 'closed' });
    await flush();

    expect(view).toBe('player');
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(Math.abs(video.currentTime - 20)).toBeLessThan(0.5);
  });

  it('player docked: Dock closes nothing and changes no view', async () => {
    editorEvent({ type: 'opened' });
    view = 'player';
    editorEvent({ type: 'closed' });
    await flush();
    expect(closes).toBe(0);
    expect(view).toBe('player');
    expect(ed._panel.hidden).toBe(false);
  });

  it('the editor was closed meanwhile: the player window stays where it is', async () => {
    editorEvent({ type: 'opened' });
    popOutPlayer();
    ed.hide();
    editorEvent({ type: 'closed' });
    await flush();
    expect(closes).toBe(0);
    expect(app._playerWindowActive).toBe(true);
    expect(view).toBe('library');
  });

  it('the player window closed by hand later (no Dock) folds back as before: no view change when paused', async () => {
    popOutPlayer({ paused: true });
    playerEvent({ type: 'closed' });
    await flush();
    expect(view).toBe('library');
  });
});

describe('E-08: the pop-out button speaks the user\'s language through a pop-out / dock cycle', () => {
  const btn = () => ed._btnPopout;

  it('popped out it says Dock, docked again it says Pop out, both in the current language', () => {
    _setBundlesForTests('xx', pseudo('xx'), enWithNew());
    editorEvent({ type: 'opened' });
    expect(btn().title).toBe(`xx[${enVal('editor.btn.dock')}]`);
    expect(btn().getAttribute('aria-label')).toBe(`xx[${enVal('editor.btn.dock')}]`);
    editorEvent({ type: 'closed' });
    expect(btn().title).toBe(t('editor.btn.popout'));
    expect(btn().title).toBe(`xx[${EN.editor.btn.popout}]`);
    expect(btn().getAttribute('aria-label')).toBe(`xx[${EN.editor.btn.popout}]`);
  });

  it('a language switch while popped out keeps it saying Dock, in the new language', () => {
    editorEvent({ type: 'opened' });
    _setBundlesForTests('yy', pseudo('yy'), enWithNew());
    eventBus.emit('language:changed', 'yy');
    expect(btn().title).toBe(`yy[${enVal('editor.btn.dock')}]`);
    expect(btn().getAttribute('aria-label')).toBe(`yy[${enVal('editor.btn.dock')}]`);
    editorEvent({ type: 'closed' });
  });

  it('"Pop-out unavailable" is said in the current language', async () => {
    _setBundlesForTests('xx', pseudo('xx'), enWithNew());
    delete window.funsync.editorPopoutOpen;
    await ed._togglePopoutWindow();
    expect(showToast).toHaveBeenCalledWith(`xx[${enVal('editor.toast.popoutUnavailable')}]`, 'error');
  });
});
