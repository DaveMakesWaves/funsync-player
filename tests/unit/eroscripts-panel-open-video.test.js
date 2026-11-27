/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL EroScriptsPanel reads #player-container and sets
 * real button labels, and it imports DOM-branching modules (notes/CLAUDE.md
 * "Test environments").
 */
// Where an EroScripts panel download goes, and what its button says after.
//
// C-05 (round-4 re-verify, low): after the video was CLOSED (the mini
// player's ×, or Back with the mini player off) the video stays loaded but
// paused, and #player-container[data-video-path] and `_currentVideoName`
// still name it. The panel took that as "a video is open": it wrote
// `<that video>.funscript` beside it and the app loaded the download into
// the closed video, instead of offering the Save dialog. The panel now asks
// the app (`getOpenVideoPath`), which answers from what is on screen: the
// player view, the docked mini player, or the detached player window.
//
// C-10 (cosmetic, new since v0.9.2): after a download whose bytes were already
// there (nothing written; the toast says "Already up to date"), the Get Script
// button still read "Script saved".
//
// REAL EroScriptsPanel methods, REAL app.js hooks (lifted), a fake disk and
// fake IPC. Asserted: which file is written, whether the Save dialog opens,
// whether the closed video gets the script (association, engine), and the
// button's text.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { liftAppClass } from './helpers/app-methods.js';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { showToast } = await import('../../renderer/js/toast.js');
const { _setBundlesForTests, t } = await import('../../renderer/js/i18n.js');
const { EroScriptsPanel } = await import('../../renderer/components/eroscripts-panel.js');
const { cleanSearchName } = await import('../../renderer/js/search-name-clean.js');

// The REAL English bundle, with nothing added: the button's words must come
// from en.json, so a key missing there fails here instead of the button
// showing the raw key.
const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));

const VIDEO = 'C:\\sandbox\\library\\Alpha Scene.mp4';
const BESIDE = 'C:\\sandbox\\library\\Alpha Scene.funscript';
const PICKED = 'C:\\sandbox\\downloads\\alpha_v2.funscript';
const SOURCE_ROOT = 'C:\\sandbox\\library';
const BYTES = JSON.stringify({ version: '1.0', actions: [{ at: 0, pos: 0 }, { at: 500, pos: 100 }] });

const Lifted = liftAppClass(
  ['_hasOpenVideo', '_currentView', '_openVideoPath', '_confirmBeforeEroScriptsDownload',
    '_onEroScriptDownloaded', '_editorAllowsReplace'],
  { showToast, t },
);

let disk;
let writes;
beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  showToast.mockClear();
  document.body.innerHTML = '<div id="player-container"></div>';
  // What loadVideo set, and what stays after a close.
  document.getElementById('player-container').dataset.videoPath = VIDEO;
  disk = {};
  writes = [];
  window.funsync = {
    eroscriptsDownload: vi.fn(async (_url, p, opts = {}) => {
      if (opts.checkOnly) return p in disk ? { success: true, checked: true, unchanged: disk[p] === BYTES } : { success: true, checked: true };
      if (disk[p] === BYTES) return { success: true, unchanged: true };
      writes.push(p);
      disk[p] = BYTES;
      return { success: true };
    }),
    eroscriptsForgetDownload: async () => {},
    pickDownloadSavePath: vi.fn(async () => PICKED),
    readFunscript: async (p) => disk[p] ?? null,
  };
});
afterEach(() => {
  delete window.funsync;
  document.body.innerHTML = '';
});

/**
 * The app in a given state and the panel wired to it as app.js init() wires
 * it. `view`: the top of the nav stack; `mini`: the docked mini player shows;
 * `popout`: the detached player window owns playback.
 */
function setup({ view, mini = false, popout = false, sources = [] }) {
  const app = new Lifted();
  Object.assign(app, {
    _navStack: view === 'library' ? ['library'] : ['library', view],
    _miniActive: mini,
    _playerWindowActive: popout,
    _currentVideoName: 'Alpha Scene.mp4',
    _currentVideoPath: VIDEO,
    funscriptEngine: {},
    scriptEditor: null,
    _autoAdvancing: false,
    library: { associateDownloadedScript: vi.fn() },
    loadFunscript: vi.fn(async () => {}),
  });
  const panel = Object.assign(Object.create(EroScriptsPanel.prototype), {
    _settings: { get: (k) => (k === 'library.sources' ? sources : undefined) },
  });
  panel.confirmBeforeDownload = () => app._confirmBeforeEroScriptsDownload();
  panel.onScriptDownloaded = (fsPath, fsName) => app._onEroScriptDownloaded(fsPath, fsName);
  panel.getOpenVideoPath = () => app._openVideoPath();
  const btn = document.createElement('button');
  const run = () => panel._downloadAttachment({ name: 'alpha_v2.funscript', url: 'https://example.invalid/a' }, btn, null);
  return { app, panel, btn, run };
}

describe('C-05: a download goes beside the OPEN video only', () => {
  const open = {
    'the player view': { view: 'player' },
    'the docked mini player over the Library': { view: 'library', mini: true },
    'the detached player window': { view: 'library', popout: true },
  };
  for (const [where, state] of Object.entries(open)) {
    it(`open in ${where}: <video>.funscript beside it, associated and loaded`, async () => {
      const { app, run } = setup(state);
      await run();
      expect(writes).toEqual([BESIDE]);
      expect(window.funsync.pickDownloadSavePath).not.toHaveBeenCalled();
      expect(app.library.associateDownloadedScript).toHaveBeenCalledWith(VIDEO, BESIDE);
      expect(app.loadFunscript).toHaveBeenCalledTimes(1);
      expect(app.loadFunscript.mock.calls[0][0].path).toBe(BESIDE);
    });
  }

  it('closed (the mini player\'s ×, or Back with it off): the Save dialog picks the place; the closed video gets nothing', async () => {
    const { app, run } = setup({ view: 'library', mini: false });
    await run();
    expect(window.funsync.pickDownloadSavePath).toHaveBeenCalledWith('alpha_v2.funscript');
    expect(writes).toEqual([PICKED]);
    expect(BESIDE in disk).toBe(false); // nothing beside the closed video
    expect(app.library.associateDownloadedScript).not.toHaveBeenCalled();
    expect(app.loadFunscript).not.toHaveBeenCalled();
  });

  it('closed, with one library source: saved at its root under its own name, as with no video', async () => {
    const { app, run } = setup({ view: 'library', sources: [{ path: SOURCE_ROOT, enabled: true }] });
    await run();
    expect(writes).toEqual([`${SOURCE_ROOT}\\alpha_v2.funscript`]);
    expect(window.funsync.pickDownloadSavePath).not.toHaveBeenCalled();
    expect(app.loadFunscript).not.toHaveBeenCalled();
  });

  it('closed: the Save dialog cancelled writes nothing', async () => {
    const { run } = setup({ view: 'playlists' });
    window.funsync.pickDownloadSavePath.mockResolvedValueOnce(null);
    await run();
    expect(writes).toEqual([]);
  });
});

describe('C-10: the Get Script button tells a fresh save from an already-there one', () => {
  it('a new file: "Script saved"', async () => {
    const { btn, run } = setup({ view: 'player' });
    await run();
    expect(btn.textContent).toBe(EN.eroscripts.scriptSaved);
  });

  it('the same bytes were already there (nothing written): "Up to date", as the toast says', async () => {
    disk[BESIDE] = BYTES;
    const { btn, run } = setup({ view: 'player' });
    await run();
    expect(writes).toEqual([]);
    expect(showToast).toHaveBeenCalledWith(t('eroscripts.alreadyUpToDate', { name: 'Alpha Scene.funscript' }), 'info');
    expect(btn.textContent).toBe('Up to date');
    expect(btn.textContent).not.toBe(EN.eroscripts.scriptSaved);
    expect(btn.disabled).toBe(false);
  });
});

// Block C fix-up (2026-11-06, real-app verifier 1; both also in v0.9.2).
//
// After a video was CLOSED (the mini player's ×), the nav bar's EroScripts
// button still opened the panel pre-filled with the closed video's name and
// searched for it: onEroScriptsClick read `_currentVideoName`, which a close
// keeps. C-05 fixed only where the download goes.
//
// After Get Script, Escape no longer closed the panel: the button is disabled
// while it downloads, the focus falls to <body>, and the panel's Escape and
// Tab listeners sit on the panel itself. The next click outside then only
// closed the panel (a library card clicked then did not open).
describe('fix-up: the nav button searches for the OPEN video only', () => {
  const NavLifted = liftAppClass(['_onEroScriptsNavClick', '_hasOpenVideo', '_currentView'], { showToast, t, cleanSearchName });
  function nav(state, name = 'Square OU.mp4') {
    const app = Object.assign(new NavLifted(), {
      _navStack: state.view === 'library' ? ['library'] : ['library', state.view],
      _miniActive: !!state.mini,
      _playerWindowActive: !!state.popout,
      _currentVideoName: name,
      funscriptEngine: { isLoaded: false },
      eroscriptsPanel: { _visible: false, setSearchQuery: vi.fn(), toggle: vi.fn() },
    });
    app._onEroScriptsNavClick();
    return app.eroscriptsPanel;
  }

  it('open in the player or the docked mini player: pre-filled and searched', () => {
    for (const state of [{ view: 'player' }, { view: 'library', mini: true }, { view: 'library', popout: true }]) {
      const panel = nav(state);
      expect(panel.setSearchQuery).toHaveBeenCalledWith('Square OU', true);
      expect(panel.toggle).toHaveBeenCalledTimes(1);
    }
  });

  it('v0.10.1: a slug-style file name is searched as words, the same query the auto-match uses', () => {
    const panel = nav({ view: 'player' }, 'anna-claire-clouds-takes-on-a-mouthful-of-cum_1080p.mp4');
    expect(panel.setSearchQuery).toHaveBeenCalledWith('anna claire clouds takes on a mouthful of cum', true);
  });

  it('closed with the mini player\'s ×: the panel opens empty, no search for the closed video', () => {
    const panel = nav({ view: 'library', mini: false });
    expect(panel.setSearchQuery).not.toHaveBeenCalled();
    expect(panel.toggle).toHaveBeenCalledTimes(1);
  });
});

describe('fix-up: after Get Script the panel still answers Escape', () => {
  it('the focus comes back to the button, and Escape closes the panel', async () => {
    const { panel, btn, run } = setup({ view: 'player' });
    // The panel as show() wires it: the search field and a result's button.
    const el = document.createElement('div');
    el.innerHTML = '<input id="es-search-input">';
    el.appendChild(btn);
    document.body.appendChild(el);
    panel._panel = el;
    panel.show();
    btn.focus();
    expect(document.activeElement).toBe(btn);
    // Chromium moves the focus to <body> for good the moment a focused button
    // is disabled (focus fixup). jsdom only hides it while the button is
    // disabled and gives it back on enable, so the fixup is done by hand: the
    // focus goes to a throwaway control that then lets go of it.
    const dropFocus = () => {
      const tmp = document.createElement('button');
      document.body.appendChild(tmp);
      tmp.focus();
      tmp.blur();
      tmp.remove();
    };
    const realDownload = window.funsync.eroscriptsDownload;
    window.funsync.eroscriptsDownload = vi.fn(async (...args) => {
      if (btn.disabled) dropFocus();
      expect(document.activeElement).toBe(document.body);
      return realDownload(...args);
    });
    await run();
    expect(writes).toEqual([BESIDE]);
    expect(btn.disabled).toBe(false);
    expect(document.activeElement).toBe(btn);
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.activeElement.dispatchEvent(esc);
    expect(panel._visible).toBe(false);
    expect(el.hidden).toBe(true);
  });

  it('a focus the user moved elsewhere meanwhile is left where it is', async () => {
    const { panel, btn, run } = setup({ view: 'player' });
    const el = document.createElement('div');
    el.innerHTML = '<input id="es-search-input">';
    el.appendChild(btn);
    document.body.appendChild(el);
    panel._panel = el;
    panel.show();
    const search = el.querySelector('#es-search-input');
    const realDownload = window.funsync.eroscriptsDownload;
    window.funsync.eroscriptsDownload = vi.fn(async (...args) => { search.focus(); return realDownload(...args); });
    await run();
    expect(document.activeElement).toBe(search);
    panel.hide();
  });
});
