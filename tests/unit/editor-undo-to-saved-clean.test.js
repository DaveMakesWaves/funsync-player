/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL ScriptEditor builds its panel and canvas, its
 * keys are real KeyboardEvents on the canvas, and script-editor.js imports
 * DOM-branching modules (notes/CLAUDE.md "Test environments").
 */
// R4-18 (low, seen by real-app verifier 3 while re-verifying R3-19): Ctrl+Z
// back to the saved point still left the editor dirty. Companion Clip, undone
// back to its 34 saved points, still showed "*", and a window close, a quit
// and a load all asked Save / Don't save / Cancel about a script with no net
// change. EditableScript.undo() and redo() set dirty = true whatever state
// they landed on.
//
// The fix gives every state of the script an id (EditableScript revisions):
// the script is clean exactly while the state on screen is the one last
// loaded or saved. What is asserted is what the user sees and gets: the "*"
// in the status, whether a close or a video switch asks, what main was told
// (the R3-19 guard, the REAL electron/unsaved-edits-guard.js on a fake
// ipcMain), what autosave writes.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const require_ = createRequire(import.meta.url);
const { createUnsavedEditsGuard, DIRTY_CHANNEL, ASK_CHANNEL } = require_('../../electron/unsaved-edits-guard.js');
const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { ScriptEditor } = await import('../../renderer/components/script-editor.js');
const { EditableScript } = await import('../../renderer/js/editable-script.js');
const { applyPopoutEdit } = await import('../../renderer/js/editor-popout-dispatch.js');
const { editOp, OP_UNDO, OP_REDO, OP_INSERT } = await import('../../renderer/js/editor-popout-protocol.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const PATH = 'C:\\sandbox\\library\\Companion Clip.funscript';
const OTHER = 'C:\\sandbox\\library\\Companion Clip (soft).funscript';
/** Companion Clip: 34 saved points. */
const SAVED = Array.from({ length: 34 }, (_, i) => ({ at: i * 250, pos: i % 2 ? 85 : 15 }));

let disk;
let writes;
let dirtyReports;

const fresh = (actions = SAVED) => {
  const es = new EditableScript();
  es.loadFromData({ version: '1.0', actions });
  return es;
};
/** Three new points after the last saved one. */
const edit3 = (es) => { for (let i = 0; i < 3; i++) es.insertAction(9000 + i * 100, 50); };

describe('EditableScript: clean exactly while the saved state is on screen (R4-18)', () => {
  it('Ctrl+Z back to the loaded state is clean; a redo away from it is dirty again', () => {
    const es = fresh();
    edit3(es);
    expect(es.dirty).toBe(true);
    es.undo(); es.undo();
    expect(es.dirty).toBe(true); // one edit still on screen
    es.undo();
    expect(es.actionCount).toBe(34);
    expect(es.dirty).toBe(false);
    es.redo();
    expect(es.dirty).toBe(true);
    es.undo();
    expect(es.dirty).toBe(false);
  });

  it('undo past a save is dirty, and redo back to the save is clean again', () => {
    const es = fresh();
    es.insertAction(9000, 50);
    es.insertAction(9100, 50);
    es.markSaved();                // 36 points written
    es.insertAction(9200, 50);
    es.undo();
    expect(es.dirty).toBe(false);  // the 36 on disk
    es.undo();
    expect(es.dirty).toBe(true);   // 35: not what is on disk
    es.redo();
    expect(es.dirty).toBe(false);
    es.redo();
    expect(es.dirty).toBe(true);
  });

  it('a new edit after undoing past the save drops the redo history: no redo ever returns to clean', () => {
    const es = fresh();
    es.insertAction(9000, 50);
    es.markSaved();                // 35 on disk
    es.undo();                     // 34, dirty
    es.insertAction(9500, 20);     // a different 35
    expect(es.canRedo).toBe(false);
    expect(es.dirty).toBe(true);
    es.undo();                     // 34 again: still not what is on disk
    expect(es.dirty).toBe(true);
    es.redo();
    expect(es.dirty).toBe(true);
    expect(es.canRedo).toBe(false);
  });

  it('a save overtaken by an edit: the edit stays unsaved, and Ctrl+Z back to what was written is clean', () => {
    const es = fresh();
    es.insertAction(9000, 50);
    const written = es.revision;   // what _save / _autosave serialise
    es.insertAction(9100, 50);     // made while the write was on its way
    es.markSaved(written);
    expect(es.dirty).toBe(true);
    es.undo();
    expect(es.dirty).toBe(false);
  });

  it('a drag that moved nothing leaves a clean script clean', () => {
    const es = fresh();
    es.select(3);
    es.beginBatch();
    es.moveActions(es.selectedIndices, 0, 0);
    es.endBatch();
    expect(es.canUndo).toBe(false);
    expect(es.dirty).toBe(false);
  });

  it('a Simplify that removes nothing leaves no undo step: one Ctrl+Z undoes the edit before it', () => {
    const es = fresh();
    es.insertAction(9000, 50);
    es.select(0); es.toggleSelect(1); es.toggleSelect(2); // 15 / 85 / 15: every point is a turn
    es.simplify(2);
    expect(es.actionCount).toBe(35);
    es.undo();
    expect(es.actionCount).toBe(34);
    expect(es.dirty).toBe(false);
  });

  it('once the saved state has fallen off the 100-step history it is never reported clean', () => {
    const es = fresh();
    for (let i = 0; i < 101; i++) es.insertAction(10000 + i * 10, 50);
    while (es.canUndo) es.undo();
    expect(es.actionCount).toBe(35); // the first edit is past the history
    expect(es.dirty).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The real editor, as the verifier had it.

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };

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
  ed._reloadIntoEngineAndSync = () => {};
  ed.setFunscriptPath(PATH);
  ed.editableScript.loadFromData(JSON.parse(disk[PATH]));
  ed._autosaveEnabled = autosave;
  ed._panel.removeAttribute('inert'); // open, as the user has it
  ed._updateStatus();
  return ed;
}

const press = (ed, key, { ctrl = false, shift = false } = {}) => {
  ed._canvas.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ctrlKey: ctrl, shiftKey: shift }));
};
const status = (ed) => ed._statusEl.textContent;

/** The main window and its guard, wired to this page as preload.js wires it. */
function connect() {
  const ipcMain = new EventEmitter();
  const guard = createUnsavedEditsGuard({ ipcMain, log: null });
  const wc = new EventEmitter();
  const win = new EventEmitter();
  const asked = [];
  Object.assign(wc, {
    isDestroyed: () => win.destroyed, isCrashed: () => false,
    send: (channel, token) => { if (channel === ASK_CHANNEL) asked.push(token); },
  });
  Object.assign(win, {
    webContents: wc, destroyed: false, closed: 0,
    isDestroyed: () => win.destroyed, isMinimized: () => false, isVisible: () => true,
    restore() {}, show() {}, focus() {},
    close() {
      let prevented = false;
      win.emit('close', { preventDefault: () => { prevented = true; } });
      if (!prevented) { win.closed++; win.destroyed = true; }
    },
  });
  window.funsync.editorDirtyChanged = (dirty) => {
    dirtyReports.push(dirty);
    ipcMain.emit(DIRTY_CHANNEL, { sender: wc }, dirty === true);
  };
  guard.attach(win);
  return { guard, win, asked };
}

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  disk = {
    [PATH]: JSON.stringify({ version: '1.0', actions: SAVED }),
    [OTHER]: JSON.stringify({ version: '1.0', actions: SAVED.slice(0, 10) }),
  };
  writes = [];
  dirtyReports = [];
  window.funsync = {
    readFunscript: async (p) => disk[p] ?? null,
    writeFunscript: async (json, p) => { writes.push(p); disk[p] = json; return p; },
    saveFunscript: async () => null,
  };
});

afterEach(() => {
  delete window.funsync;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('the editor after Ctrl+Z back to the saved point (R4-18)', () => {
  it('Companion Clip undone back to its 34 saved points: no "*", main told clean, the window closes without a question', async () => {
    const ed = realEditor();
    const { win, asked } = connect();
    expect(status(ed)).not.toMatch(/\*$/);
    for (let i = 0; i < 3; i++) { ed.editableScript.insertAction(9000 + i * 100, 50); }
    expect(status(ed)).toMatch(/\*$/);
    expect(dirtyReports).toEqual([true]);

    press(ed, 'z', { ctrl: true }); press(ed, 'z', { ctrl: true }); press(ed, 'z', { ctrl: true });
    expect(ed.editableScript.actionCount).toBe(34);
    expect(status(ed)).not.toMatch(/\*$/);
    expect(ed.hasUnsavedChanges()).toBe(false);
    expect(dirtyReports).toEqual([true, false]);
    // A video switch asks nothing (true at once), and neither does a close.
    expect(ed.confirmBeforeReplace()).toBe(true);
    win.close();
    await settle();
    expect(asked).toEqual([]);
    expect(win.closed).toBe(1);
    expect(writes).toEqual([]);
  });

  it('Ctrl+Y away from the saved point is unsaved again: the "*" is back and a close asks', async () => {
    const ed = realEditor();
    const { win, asked } = connect();
    ed.editableScript.insertAction(9000, 50);
    press(ed, 'z', { ctrl: true });
    press(ed, 'y', { ctrl: true });
    expect(ed.editableScript.actionCount).toBe(35);
    expect(status(ed)).toMatch(/\*$/);
    expect(dirtyReports).toEqual([true, false, true]);
    win.close();
    expect(win.closed).toBe(0);
    expect(asked).toHaveLength(1);
  });

  it('after Ctrl+S, more edits undone back to the save are clean too', async () => {
    const ed = realEditor();
    ed.editableScript.insertAction(9000, 50);
    await ed._save({ syncEngine: false });
    expect(writes).toEqual([PATH]);
    ed.editableScript.insertAction(9100, 50);
    ed.editableScript.insertAction(9200, 50);
    press(ed, 'z', { ctrl: true }); press(ed, 'z', { ctrl: true });
    expect(ed.hasUnsavedChanges()).toBe(false);
    expect(status(ed)).not.toMatch(/\*$/);
    press(ed, 'z', { ctrl: true, shift: true }); // Ctrl+Shift+Z: redo
    expect(ed.hasUnsavedChanges()).toBe(true);
  });

  it('the pop-out\'s Undo / Redo land on the same state as the docked editor\'s', () => {
    const ed = realEditor();
    applyPopoutEdit(ed.editableScript, editOp(OP_INSERT, { at: 9000, pos: 50 }), {});
    expect(ed.hasUnsavedChanges()).toBe(true);
    applyPopoutEdit(ed.editableScript, editOp(OP_UNDO), {});
    expect(ed.hasUnsavedChanges()).toBe(false);
    expect(status(ed)).not.toMatch(/\*$/);
    applyPopoutEdit(ed.editableScript, editOp(OP_REDO), {});
    expect(ed.hasUnsavedChanges()).toBe(true);
    expect(status(ed)).toMatch(/\*$/);
  });

  it('switching to another script and back keeps it: undo off the save is unsaved, redo back to it is clean', async () => {
    const ed = realEditor();
    ed.setAvailableScripts([{ label: 'Main', path: PATH }, { label: 'Soft', path: OTHER }]);
    ed.editableScript.insertAction(9000, 50);
    await ed._save({ syncEngine: false });
    await ed.selectScript(OTHER);
    expect(ed._funscriptPath).toBe(OTHER);
    await ed.selectScript(PATH);
    expect(ed._funscriptPath).toBe(PATH);
    expect(ed.editableScript.actionCount).toBe(35);
    expect(ed.hasUnsavedChanges()).toBe(false);
    ed.editableScript.undo();
    expect(ed.hasUnsavedChanges()).toBe(true);
    ed.editableScript.redo();
    expect(ed.hasUnsavedChanges()).toBe(false);
  });

  it('autosave: an edit made while the write is on its way is written by its own autosave, not left behind', async () => {
    const ed = realEditor({ autosave: true });
    let release;
    window.funsync.writeFunscript = (json, p) => new Promise((resolve) => {
      release = () => { writes.push(p); disk[p] = json; resolve(p); };
    });
    ed.editableScript.insertAction(9000, 50);
    clearTimeout(ed._autosaveTimer);
    const first = ed._autosave();
    ed.editableScript.insertAction(9100, 50); // during the write
    clearTimeout(ed._autosaveTimer);
    release();
    await first;
    expect(ed.hasUnsavedChanges()).toBe(true);
    // The second edit's own debounced write.
    const second = ed._autosave();
    release();
    await second;
    expect(writes).toEqual([PATH, PATH]);
    expect(JSON.parse(disk[PATH]).actions).toHaveLength(36);
    expect(ed.hasUnsavedChanges()).toBe(false);
  });
});
