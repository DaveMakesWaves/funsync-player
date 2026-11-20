/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL ScriptEditor builds its panel and the REAL Modal
 * draws the question in the document, and script-editor.js imports
 * DOM-branching modules (notes/CLAUDE.md "Test environments").
 */
// R4-20 (low, developer path, also in v0.9.2): a reload started from inside
// DevTools (Ctrl+R / F5 with DevTools focused) bypassed the View menu, so
// R3-19's question never came and unsaved editor edits (autosave off) were
// dropped without a word.
//
// Now the page holds its unload while the editor is dirty (app.js
// _onBeforeUnload), Electron reports the held unload to main as
// 'will-prevent-unload', and main lets it go or asks the same question
// (electron/unsaved-edits-guard.js). The whole chain runs here: the REAL
// guard on a fake ipcMain, a BrowserWindow / webContents stand-in that keeps
// Electron's unload contract (beforeunload first; a held one is reported as
// 'will-prevent-unload', whose preventDefault() lets the page go; a page that
// goes fires pagehide), the REAL app.js methods and listener wiring (lifted),
// a REAL ScriptEditor and the REAL Modal. What is asserted is what the user
// sees and keeps: the question, whether the page reloads, what the file holds,
// whether the devices were stopped.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { liftAppClass, APP_SRC } from './helpers/app-methods.js';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const require_ = createRequire(import.meta.url);
const {
  createUnsavedEditsGuard, DIRTY_CHANNEL, ASK_CHANNEL, ACK_CHANNEL, ANSWER_CHANNEL,
} = require_('../../electron/unsaved-edits-guard.js');
const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { ScriptEditor } = await import('../../renderer/components/script-editor.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const PATH = 'C:\\sandbox\\library\\Alpha Scene.funscript';
const ON_DISK = Array.from({ length: 33 }, (_, i) => ({ at: i * 250, pos: i % 2 ? 90 : 10 }));

let disk;
let writes;

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
const dialog = () => document.querySelector('.modal-overlay');
const pointsOnDisk = () => JSON.parse(disk[PATH]).actions.length;

/**
 * app.js's unload wiring, lifted from its init as it stands: the device
 * stops (_stopEverythingOnUnload) and the beforeunload / pagehide listeners.
 */
function liftUnloadWiring() {
  const start = APP_SRC.indexOf('    this._stopEverythingOnUnload = () => {');
  const endMarker = "    window.addEventListener('pagehide', () => this._onPageHide());";
  const end = APP_SRC.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error('unload wiring not found in app.js');
  // eslint-disable-next-line no-new-func
  return new Function('window', 'clearInterval', APP_SRC.slice(start, end + endMarker.length));
}

function realEditor({ autosave = false } = {}) {
  document.body.innerHTML = '<div id="player-container"></div>';
  const video = Object.assign(new EventTarget(), { currentTime: 2, duration: 60, paused: true });
  const videoPlayer = Object.assign(new EventTarget(), { video, duration: 60, currentTime: 2 });
  const ed = new ScriptEditor({
    videoPlayer,
    funscriptEngine: { isLoaded: false, getActions: () => [], getMetadata: () => null },
    progressBar: { renderHeatmap() {} },
    settings: { get: () => undefined, set() {} },
  });
  ed._sendLivePreview = () => {};
  ed.setFunscriptPath(PATH);
  ed.editableScript.loadFromData(JSON.parse(disk[PATH]));
  ed._autosaveEnabled = autosave;
  return ed;
}

/** Five new points: 38 in memory, dirty, nothing on disk yet. */
function edit(ed) {
  for (let i = 0; i < 5; i++) ed.editableScript.insertAction(9000 + i * 100, 50);
  expect(ed.editableScript.dirty).toBe(true);
}

/**
 * The main window (real guard) and this page (real app.js methods), wired as
 * preload.js wires them, plus a connected Handy and a running sync engine.
 */
function boot(ed) {
  const ipcMain = new EventEmitter();
  const guard = createUnsavedEditsGuard({ ipcMain, log: null });
  const pageWindow = new EventTarget(); // this page's `window` for the unload listeners
  const Lifted = liftAppClass(['_answerUnsavedBeforeExit', '_onBeforeUnload', '_onPageHide'], { window, console: { warn() {} } });
  const app = Object.assign(new Lifted(), {
    scriptEditor: ed,
    syncEngine: { stop: vi.fn() },
    handyManager: { connected: true, hsspStop: vi.fn(), disconnect: vi.fn() },
  });
  liftUnloadWiring().call(app, pageWindow, clearInterval);

  const wc = new EventEmitter();
  const win = new EventEmitter();
  const asked = [];
  const page = { reloads: 0 };
  /** Chromium + Electron: the page's beforeunload first; a held unload is
   *  'will-prevent-unload' in main, whose preventDefault() lets it go; a page
   *  that goes fires pagehide. Returns whether the page went. */
  const unload = () => {
    const ev = new Event('beforeunload', { cancelable: true });
    pageWindow.dispatchEvent(ev);
    let goes = !ev.defaultPrevented;
    if (!goes) wc.emit('will-prevent-unload', { preventDefault: () => { goes = true; } });
    if (goes) pageWindow.dispatchEvent(new Event('pagehide'));
    return goes;
  };
  const reload = () => {
    if (!unload()) return;
    page.reloads++;
    wc.emit('did-navigate');
  };
  Object.assign(wc, {
    isDestroyed: () => win.destroyed,
    isCrashed: () => false,
    reload: vi.fn(reload),
    // main → page: preload's onConfirmUnsavedBeforeExit, as app.js init registers it
    send: (channel, token) => {
      if (channel !== ASK_CHANNEL) return;
      asked.push(token);
      app._answerUnsavedBeforeExit(token);
    },
  });
  Object.assign(win, {
    webContents: wc, destroyed: false, closed: 0,
    isDestroyed: () => win.destroyed, isMinimized: () => false, isVisible: () => true,
    restore() {}, show() {}, focus() {},
    close() {
      let prevented = false;
      win.emit('close', { preventDefault: () => { prevented = true; } });
      if (prevented) return;
      if (unload()) { win.closed++; win.destroyed = true; }
    },
  });
  Object.assign(window.funsync, {
    editorDirtyChanged: (dirty) => ipcMain.emit(DIRTY_CHANNEL, { sender: wc }, dirty === true),
    confirmUnsavedAck: (token) => ipcMain.emit(ACK_CHANNEL, { sender: wc }, token),
    confirmUnsavedAnswer: (token, go) => ipcMain.emit(ANSWER_CHANNEL, { sender: wc }, token, go !== false),
  });
  guard.attach(win);
  /** DevTools' Ctrl+R / F5: a reload main's View menu never sees. */
  const devtoolsReload = reload;
  const devicesStopped = () => app.handyManager.hsspStop.mock.calls.length > 0
    || app.handyManager.disconnect.mock.calls.length > 0
    || app.syncEngine.stop.mock.calls.length > 0;
  return { app, guard, win, wc, asked, page, devtoolsReload, devicesStopped };
}

async function answer(choice) {
  await vi.waitFor(() => expect(dialog()).not.toBeNull());
  dialog().querySelector(`[data-choice="${choice}"]`).click();
}

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  disk = { [PATH]: JSON.stringify({ version: '1.0', actions: ON_DISK }) };
  writes = [];
  window.funsync = {
    filesExist: async (paths) => paths.map((p) => p in disk),
    readFunscript: async (p) => disk[p] ?? null,
    writeFunscript: async (json, p) => { writes.push(p); disk[p] = json; return p; },
    saveFunscript: async () => null,
    bringMainWindowForward: vi.fn(),
  };
});

afterEach(() => {
  delete window.funsync;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('a DevTools reload with unsaved edits asks first (R4-20)', () => {
  it('asks "Save changes to <script>?"; Cancel keeps the page, the 38 points, the file, and the Handy connected', async () => {
    const ed = realEditor();
    const s = boot(ed);
    edit(ed);
    s.devtoolsReload();
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    expect(s.asked).toHaveLength(1);
    expect(dialog().querySelector('.modal-title').textContent)
      .toBe(EN.editor.unsaved.title.replace('{name}', 'Alpha Scene.funscript'));
    await answer('cancel');
    await settle();
    expect(s.page.reloads).toBe(0);
    expect(ed.editableScript.actionCount).toBe(38);
    expect(pointsOnDisk()).toBe(33);
    expect(writes).toEqual([]);
    // A held unload stops nothing: the page stays, and so do its devices.
    expect(s.devicesStopped()).toBe(false);
  });

  it('Save writes the 38 points, then the page reloads once, stopping the devices on the way out', async () => {
    const ed = realEditor();
    const s = boot(ed);
    edit(ed);
    s.devtoolsReload();
    await answer('save');
    await settle();
    expect(writes).toEqual([PATH]);
    expect(pointsOnDisk()).toBe(38);
    expect(s.page.reloads).toBe(1);
    expect(s.asked).toHaveLength(1);
    expect(s.app.handyManager.hsspStop).toHaveBeenCalledTimes(1);
    expect(s.app.handyManager.disconnect).toHaveBeenCalledTimes(1);
  });

  it('Don\'t save reloads the page and leaves the file as it was', async () => {
    const ed = realEditor();
    const s = boot(ed);
    edit(ed);
    s.devtoolsReload();
    await answer('discard');
    await settle();
    expect(s.page.reloads).toBe(1);
    expect(pointsOnDisk()).toBe(33);
    expect(writes).toEqual([]);
  });

  it('a clean editor reloads at once, unasked, and stops the devices as before', () => {
    const ed = realEditor();
    const s = boot(ed);
    s.devtoolsReload();
    expect(s.page.reloads).toBe(1);
    expect(s.asked).toEqual([]);
    expect(dialog()).toBeNull();
    expect(s.app.syncEngine.stop).toHaveBeenCalledTimes(1);
    expect(s.app.handyManager.hsspStop).toHaveBeenCalledTimes(1);
  });

  it('autosave on: no question, the pending write is flushed, then the page reloads', async () => {
    const ed = realEditor({ autosave: true });
    const s = boot(ed);
    edit(ed);
    s.devtoolsReload();
    await settle();
    expect(dialog()).toBeNull();
    expect(writes).toEqual([PATH]);
    expect(pointsOnDisk()).toBe(38);
    expect(s.page.reloads).toBe(1);
  });

  it('the window X still asks once (main\'s own route), and the page\'s hold never adds a second question', async () => {
    const ed = realEditor();
    const s = boot(ed);
    edit(ed);
    s.win.close();
    await answer('save');
    await settle();
    expect(s.win.closed).toBe(1);
    expect(s.asked).toHaveLength(1);
  });

  it('a page that still says dirty after main let a close go (its question threw) is not trapped, and its devices are still stopped', async () => {
    const ed = realEditor();
    const s = boot(ed);
    edit(ed);
    ed.confirmUnsavedChanges = async () => { throw new Error('broken'); };
    s.win.close();
    await settle();
    expect(s.win.closed).toBe(1);
    expect(ed.hasUnsavedChanges()).toBe(true); // the page held its unload; main let it go
    expect(s.app.handyManager.hsspStop).toHaveBeenCalledTimes(1);
    expect(s.app.handyManager.disconnect).toHaveBeenCalledTimes(1);
  });
});
