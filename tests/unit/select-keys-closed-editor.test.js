/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL ScriptEditor builds its panel into the document,
 * and the REAL Library renders its grid there (both import DOM-branching
 * modules; notes/CLAUDE.md "Test environments").
 */
// Block E2 verify-1, in the real app: Ctrl+A in the Library never selected
// anything (also in v0.9.2), and in a playlist's Select mode neither Esc nor
// Ctrl+A did anything (FT-104). Both key handlers stood back for the script
// editor with `document.querySelector('.script-editor:not([hidden])')`, and
// that always matched: the docked editor's panel is built at app start, and a
// CLOSED one is only inert, with no `--open` class; it is never `[hidden]`.
// The jsdom tests passed because they built no editor.
//
// So this file puts the REAL editor in the document, closed as at app start,
// and dispatches the keys the way the user presses them. The editor's own
// cases stay: open and on screen, it keeps its keys; popped out (its docked
// panel hidden by the pop-out's 'opened' event) or in the mini player, it
// does not.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { ScriptEditor } = await import('../../renderer/components/script-editor.js');
const { Library } = await import('../../renderer/components/library.js');

let emitPopout;

/** The editor as app.js builds it at startup: in #player-container, closed. */
function realEditor() {
  const video = Object.assign(new EventTarget(), { currentTime: 2, duration: 60, paused: true });
  const videoPlayer = Object.assign(new EventTarget(), { video, duration: 60, currentTime: 2 });
  const ed = new ScriptEditor({
    videoPlayer,
    funscriptEngine: { isLoaded: false, getActions: () => [], getMetadata: () => null },
    progressBar: { renderHeatmap() {} },
    settings: { get: () => undefined, set() {} },
  });
  ed._sendLivePreview = () => {};
  return ed;
}

const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); };
function ctrlA(target = document.body) {
  const e = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
}

const SOURCE = 'C:\\Lib';
// Scripted, so the Library's default Matched tab shows all three.
const VIDEOS = ['Alpha', 'Bravo', 'Charlie'].map((n) => ({
  name: `${n}.mp4`, path: `${SOURCE}\\${n}.mp4`,
  hasFunscript: true, funscriptPath: `${SOURCE}\\${n}.funscript`, variants: [],
}));

/** The Library view on screen with three videos (a return to the view: no rescan). */
function shownLibrary() {
  const store = {
    'library.viewMode': 'grid',
    'library.showCardHeatmap': false,
    'library.sources': [{ id: 's1', name: 'Lib', path: SOURCE, enabled: true }],
  };
  const settings = {
    get: (k) => store[k],
    set: (k, v) => { store[k] = v; },
    getVideoCategories: () => [],
    getCategories: () => [],
    getPlaylists: () => [],
  };
  const lib = new Library({ settings });
  lib._videos = VIDEOS.map((v) => ({ ...v }));
  lib._videosByPath = new Map(lib._videos.map((v) => [v.path, v]));
  lib._lastScanKey = SOURCE;
  lib._queueThumbnail = () => {};
  const container = document.createElement('div');
  document.getElementById('library-view').appendChild(container);
  // jsdom does no layout: offsetParent is how the handler asks "on screen?".
  Object.defineProperty(container, 'offsetParent', { get: () => document.body, configurable: true });
  lib.show(container);
  return lib;
}
const selectedCards = () => [...document.querySelectorAll('#library-view [data-video-path].library__card--selected')]
  .map((el) => el.dataset.videoPath);

beforeEach(() => {
  document.body.innerHTML = '<div id="library-view"></div><div id="player-view"><div id="player-container"></div></div>';
  window.funsync = {
    filesExist: async (paths) => paths.map(() => false),
    readFunscript: async () => null,
    writeFunscript: async (_json, p) => p,
    onEditorPopoutEvent: (cb) => { emitPopout = cb; return () => {}; },
  };
});

afterEach(() => {
  delete window.funsync;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('Library Ctrl+A with the script editor built but closed (block E2 verify-1, also in v0.9.2)', () => {
  it('closed, as from app start: Ctrl+A selects every video', async () => {
    const ed = realEditor();
    expect(ed.isOpen).toBe(false);
    expect(document.querySelector('.script-editor')).not.toBe(null); // the panel is there
    const lib = shownLibrary();
    await settle();
    expect(document.querySelectorAll('#library-view [data-video-path]')).toHaveLength(3);
    expect(selectedCards()).toEqual([]);

    const e = ctrlA();
    expect(e.defaultPrevented).toBe(true);
    expect(lib._selectMode).toBe(true);
    expect(selectedCards()).toEqual(VIDEOS.map((v) => v.path));
  });

  it('open and on screen: Ctrl+A is the editor\'s, the Library selects nothing', async () => {
    const ed = realEditor();
    const lib = shownLibrary();
    ed.show();
    await settle();
    const e = ctrlA();
    expect(e.defaultPrevented).toBe(false);
    expect(lib._selectMode).toBe(false);
    expect(selectedCards()).toEqual([]);
  });

  it('open but popped out: the docked panel is hidden, and Ctrl+A is the Library\'s again', async () => {
    const ed = realEditor();
    const lib = shownLibrary();
    ed.show();
    await settle();
    emitPopout({ type: 'opened' });
    expect(ed.isOpen).toBe(true);
    expect(ctrlA().defaultPrevented).toBe(true);
    expect(lib._selectMode).toBe(true);
    expect(selectedCards()).toEqual(VIDEOS.map((v) => v.path));
  });

  it('open in the mini player (editor.css hides it there): the Library\'s too', async () => {
    const ed = realEditor();
    const lib = shownLibrary();
    ed.show();
    await settle();
    document.getElementById('player-container').classList.add('player-container--mini');
    expect(ctrlA().defaultPrevented).toBe(true);
    expect(selectedCards()).toEqual(VIDEOS.map((v) => v.path));
    expect(lib._selectMode).toBe(true);
  });

  it('open, but the player view is hidden behind the Library: the Library\'s', async () => {
    const ed = realEditor();
    const lib = shownLibrary();
    ed.show();
    await settle();
    document.getElementById('player-view').hidden = true;
    expect(ctrlA().defaultPrevented).toBe(true);
    expect(lib._selectMode).toBe(true);
  });
});
