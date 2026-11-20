/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL ScriptEditor builds its panel and the REAL Modal
 * draws the question in the document, and script-editor.js imports
 * DOM-branching modules (notes/CLAUDE.md "Test environments").
 */
// R3-19 (data loss, also in v0.9.2), the renderer's half: closing the main
// window, quitting, a reload, Restart Now and Import / Restore's relaunch
// dropped unsaved editor edits (autosave off) without a word.
//
// The whole handshake runs here: the REAL main-side guard
// (electron/unsaved-edits-guard.js) on a fake ipcMain, wired to this page the
// way electron/preload.js wires it, the REAL app.js `_answerUnsavedBeforeExit`
// (lifted), a REAL ScriptEditor and the REAL Modal. What is asserted is what
// the user sees and keeps: the question, whether the window closes, what the
// file on disk holds, what the editor holds.
//
// R3-21 is here too: the question for an action from another window (the
// detached player, the editor pop-out) brings the main window forward.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { liftAppClass } from './helpers/app-methods.js';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const require_ = createRequire(import.meta.url);
const {
  createUnsavedEditsGuard, DIRTY_CHANNEL, ASK_CHANNEL, ACK_CHANNEL, ANSWER_CHANNEL, EXPIRED_CHANNEL,
} = require_('../../electron/unsaved-edits-guard.js');
const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { ScriptEditor } = await import('../../renderer/components/script-editor.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const PATH = 'C:\\sandbox\\library\\Alpha Scene.funscript';
const ON_DISK = Array.from({ length: 33 }, (_, i) => ({ at: i * 250, pos: i % 2 ? 90 : 10 }));

let disk;
let writes;
let dirtyReports;

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
const dialog = () => document.querySelector('.modal-overlay');
const pointsOnDisk = () => JSON.parse(disk[PATH]).actions.length;

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
 * One main process and this page, connected as preload.js connects them.
 * The window is a BrowserWindow stand-in whose 'close' is cancellable.
 */
function connect(ed) {
  const ipcMain = new EventEmitter();
  const guard = createUnsavedEditsGuard({ ipcMain, log: null });
  const wc = new EventEmitter();
  const win = new EventEmitter();
  Object.assign(win, {
    webContents: wc, destroyed: false, closed: 0,
    isDestroyed: () => win.destroyed, isMinimized: () => false, isVisible: () => true,
    restore() {}, show() {}, focus: vi.fn(),
    close() {
      let prevented = false;
      win.emit('close', { preventDefault: () => { prevented = true; } });
      if (!prevented) { win.closed++; win.destroyed = true; }
    },
  });
  const Lifted = liftAppClass(['_answerUnsavedBeforeExit'], { window, console: { warn() {} } });
  const app = Object.assign(new Lifted(), { scriptEditor: ed });
  const asked = [];
  Object.assign(wc, {
    isDestroyed: () => win.destroyed,
    isCrashed: () => false,
    // main → page: preload's onConfirmUnsavedBeforeExit, as app.js init registers it
    send: (channel, token) => {
      if (channel !== ASK_CHANNEL) return;
      asked.push(token);
      app._answerUnsavedBeforeExit(token);
    },
  });
  // page → main: preload's editorDirtyChanged / confirmUnsavedAck / confirmUnsavedAnswer
  Object.assign(window.funsync, {
    editorDirtyChanged: (dirty) => { dirtyReports.push(dirty); ipcMain.emit(DIRTY_CHANNEL, { sender: wc }, dirty === true); },
    confirmUnsavedAck: (token) => ipcMain.emit(ACK_CHANNEL, { sender: wc }, token),
    confirmUnsavedAnswer: (token, go) => ipcMain.emit(ANSWER_CHANNEL, { sender: wc }, token, go !== false),
  });
  guard.attach(win);
  return { guard, win, asked };
}

async function answer(choice) {
  await vi.waitFor(() => expect(dialog()).not.toBeNull());
  dialog().querySelector(`[data-choice="${choice}"]`).click();
}

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  disk = { [PATH]: JSON.stringify({ version: '1.0', actions: ON_DISK }) };
  writes = [];
  dirtyReports = [];
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

describe('the editor tells main when it turns dirty or clean (R3-19)', () => {
  it('an edit reports dirty once; Ctrl+S\'s save reports clean; an undo after it, dirty again', async () => {
    const ed = realEditor();
    // Set up before any report: the window holds nothing yet.
    window.funsync.editorDirtyChanged = (d) => dirtyReports.push(d);
    edit(ed);
    expect(dirtyReports).toEqual([true]);
    await ed._save({ syncEngine: false });
    expect(dirtyReports).toEqual([true, false]);
    ed.editableScript.undo();
    expect(dirtyReports).toEqual([true, false, true]);
  });

  it('Don\'t save at a video switch reports clean (the file is put back)', async () => {
    const ed = realEditor();
    window.funsync.editorDirtyChanged = (d) => dirtyReports.push(d);
    edit(ed);
    const asked = ed.confirmUnsavedChanges();
    await answer('discard');
    await expect(asked).resolves.toBe(true);
    expect(dirtyReports).toEqual([true, false]);
  });
});

describe('closing the main window with unsaved edits, through the whole handshake (R3-19)', () => {
  it('asks "Save changes to <script>?"; Cancel keeps the window, the edits and the file as they were', async () => {
    const ed = realEditor();
    const { win, asked } = connect(ed);
    edit(ed);
    win.close();
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    expect(asked).toHaveLength(1);
    expect(dialog().querySelector('.modal-title').textContent)
      .toBe(EN.editor.unsaved.title.replace('{name}', 'Alpha Scene.funscript'));
    await answer('cancel');
    await settle();
    expect(win.closed).toBe(0);
    expect(ed.editableScript.actionCount).toBe(38);
    expect(ed.hasUnsavedChanges()).toBe(true);
    expect(pointsOnDisk()).toBe(33);
    expect(writes).toEqual([]);
  });

  it('Save writes the 38 points to the script\'s file, then the window closes', async () => {
    const ed = realEditor();
    const { win } = connect(ed);
    edit(ed);
    win.close();
    await answer('save');
    await settle();
    expect(writes).toEqual([PATH]);
    expect(pointsOnDisk()).toBe(38);
    expect(win.closed).toBe(1);
  });

  it('Don\'t save closes the window and leaves the file as it was', async () => {
    const ed = realEditor();
    const { win } = connect(ed);
    edit(ed);
    win.close();
    await answer('discard');
    await settle();
    expect(win.closed).toBe(1);
    expect(pointsOnDisk()).toBe(33);
    expect(writes).toEqual([]);
  });

  it('autosave on: no question, the pending write is flushed, then the window closes', async () => {
    const ed = realEditor({ autosave: true });
    const { win } = connect(ed);
    edit(ed); // arms the 1 s autosave timer
    expect(ed._autosaveTimer).not.toBeNull();
    win.close();
    await settle();
    expect(dialog()).toBeNull();
    expect(writes).toEqual([PATH]);
    expect(pointsOnDisk()).toBe(38);
    expect(win.closed).toBe(1);
  });

  it('a clean editor: main does not ask at all and the window closes at once', () => {
    const ed = realEditor();
    const { win, asked } = connect(ed);
    win.close();
    expect(asked).toEqual([]);
    expect(win.closed).toBe(1);
  });

  it('after Save at a video switch, closing asks nothing (the clean report reached main)', async () => {
    const ed = realEditor();
    const { win, asked } = connect(ed);
    edit(ed);
    const switching = ed.confirmUnsavedChanges();
    await answer('save');
    await switching;
    win.close();
    expect(asked).toEqual([]);
    expect(win.closed).toBe(1);
  });

  it('a renderer whose question throws still lets the window close (never trapped)', async () => {
    const ed = realEditor();
    const { win } = connect(ed);
    edit(ed);
    ed.confirmUnsavedChanges = async () => { throw new Error('broken'); };
    win.close();
    await settle();
    expect(win.closed).toBe(1);
  });
});

describe('the question opens where the user can see it (R3-21)', () => {
  it('asked for from another window (the main window has no focus): the main window is brought forward and Save has focus', async () => {
    const ed = realEditor();
    edit(ed);
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const asked = ed.confirmUnsavedChanges();
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    expect(window.funsync.bringMainWindowForward).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(document.activeElement?.dataset?.choice).toBe('save'));
    await answer('cancel');
    await asked;
  });

  it('asked for in the main window itself: nothing is raised', async () => {
    const ed = realEditor();
    edit(ed);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const asked = ed.confirmUnsavedChanges();
    await answer('cancel');
    await asked;
    expect(window.funsync.bringMainWindowForward).not.toHaveBeenCalled();
  });
});

// R4 fix-up (real-app verifier 2, low, new since v0.9.2): a page busy past
// main's 10 s got to the question AFTER main had gone ahead without it. The
// Import it was asked for had already failed, yet "Save changes to …?"
// opened, and Don't save there threw the edits away for an action that never
// happened. Main now says when it stops waiting (the ASK's deadline) and
// withdraws a question it went ahead without (EXPIRED_CHANNEL).
describe('a question main has stopped waiting for is never asked (R4 fix-up)', () => {
  /**
   * The same handshake as connect(), but the page is busy: every message
   * from main reaches it `lateMs` later, in order. Main's acknowledgement
   * wait is `ackTimeoutMs`.
   */
  function connectBusy(ed, { ackTimeoutMs, lateMs }) {
    const ipcMain = new EventEmitter();
    const guard = createUnsavedEditsGuard({ ipcMain, log: null, ackTimeoutMs });
    const wc = new EventEmitter();
    const win = new EventEmitter();
    Object.assign(win, {
      webContents: wc, destroyed: false,
      isDestroyed: () => win.destroyed, isMinimized: () => false, isVisible: () => true,
      restore() {}, show() {}, focus() {}, close() {},
    });
    const Lifted = liftAppClass(['_answerUnsavedBeforeExit', '_onUnsavedExitAskExpired'], { window, console: { warn() {} } });
    const app = Object.assign(new Lifted(), { scriptEditor: ed });
    Object.assign(wc, {
      isDestroyed: () => false,
      isCrashed: () => false,
      // main → page, as preload.js wires onConfirmUnsavedBeforeExit / onConfirmUnsavedExpired
      send: (channel, ...args) => setTimeout(() => {
        if (channel === ASK_CHANNEL) app._answerUnsavedBeforeExit(...args);
        if (channel === EXPIRED_CHANNEL) app._onUnsavedExitAskExpired(...args);
      }, lateMs),
    });
    Object.assign(window.funsync, {
      editorDirtyChanged: (dirty) => ipcMain.emit(DIRTY_CHANNEL, { sender: wc }, dirty === true),
      confirmUnsavedAck: (token) => ipcMain.emit(ACK_CHANNEL, { sender: wc }, token),
      confirmUnsavedAnswer: (token, go) => ipcMain.emit(ANSWER_CHANNEL, { sender: wc }, token, go !== false),
    });
    guard.attach(win);
    ipcMain.emit(DIRTY_CHANNEL, { sender: wc }, true);
    return { guard, win };
  }

  it('busy past main\'s wait (an Import that then failed): no question opens, the edits stay, nothing is written', async () => {
    const ed = realEditor();
    edit(ed);
    const { guard } = connectBusy(ed, { ackTimeoutMs: 20, lateMs: 80 });
    await expect(guard.confirm('importing a backup')).resolves.toBe(true); // main went ahead after 20 ms
    guard.reset('Importing a backup'); // the Import failed (R4-17)
    await new Promise((r) => setTimeout(r, 150)); // the page recovers and gets the ASK
    await settle();
    expect(dialog()).toBeNull();
    expect(ed.editableScript.actionCount).toBe(38);
    expect(ed.hasUnsavedChanges()).toBe(true);
    expect(writes).toEqual([]);
    expect(guard.needsAsk()).toBe(true); // a later close or quit still asks
  });

  it('the window turned unresponsive (main went ahead early) and the page recovers before the deadline: the question it opened is withdrawn as Cancel', async () => {
    const ed = realEditor();
    edit(ed);
    const { guard, win } = connectBusy(ed, { ackTimeoutMs: 10000, lateMs: 30 });
    const going = guard.confirm('importing a backup');
    setTimeout(() => win.emit('unresponsive'), 5);
    await expect(going).resolves.toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    await settle();
    expect(dialog()).toBeNull();
    expect(ed.editableScript.actionCount).toBe(38);
    expect(ed.hasUnsavedChanges()).toBe(true);
    expect(writes).toEqual([]);
  });

  it('a page that answers in time is asked as before', async () => {
    const ed = realEditor();
    edit(ed);
    const { guard } = connectBusy(ed, { ackTimeoutMs: 10000, lateMs: 5 });
    const going = guard.confirm('importing a backup');
    await answer('cancel');
    await expect(going).resolves.toBe(false);
    expect(ed.hasUnsavedChanges()).toBe(true);
  });
});
