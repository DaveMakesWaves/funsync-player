/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL ScriptEditor builds its panel in the document,
 * and script-editor.js imports DOM-branching modules (notes/CLAUDE.md "Test
 * environments").
 */
// C-12 (found by reading in R4-18, low): an autosave timer that fired while
// the previous autosave's write was still on its way started a second write
// of the newer state, and the two could finish in either order. When the
// older write landed last, the file held the OLDER state until the next edit
// (and a close could ask about edits that had in fact reached the disk).
// Autosave now runs one write at a time: the next waits for the one in
// flight, then writes the state as it is at its turn.
//
// The disk here finishes writes in the order the test chooses: newest first,
// the order that lost the newer state. Asserted: what the file holds at the
// end, and whether the editor says it is saved.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { ScriptEditor } = await import('../../renderer/components/script-editor.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const PATH = 'C:\\sandbox\\library\\Companion Clip.funscript';
const SAVED = Array.from({ length: 34 }, (_, i) => ({ at: i * 250, pos: i % 2 ? 85 : 15 }));

let disk;
let pending; // writes on their way: { p, json, finish }
let started; // how many writes were started, in order

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  disk = { [PATH]: JSON.stringify({ version: '1.0', actions: SAVED }) };
  pending = [];
  started = 0;
  window.funsync = {
    readFunscript: async (p) => disk[p] ?? null,
    // A write lands only when the test finishes it.
    writeFunscript: (json, p) => new Promise((resolve) => {
      started++;
      pending.push({ p, json, finish: () => { disk[p] = json; resolve(p); } });
    }),
    saveFunscript: async () => null,
  };
});
afterEach(() => {
  delete window.funsync;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const tick = () => new Promise((r) => setTimeout(r, 0));

/** The docked editor on Companion Clip's 34 saved points, autosave on, open. */
function realEditor() {
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
  ed._autosaveEnabled = true;
  ed._panel.removeAttribute('inert');
  return ed;
}

/** Finish every write on its way, NEWEST first, until none is left. */
async function finishNewestFirst() {
  for (let guard = 0; guard < 20; guard++) {
    await tick();
    if (pending.length === 0) return;
    pending.pop().finish();
  }
}

const pointsOnDisk = () => JSON.parse(disk[PATH]).actions.length;

describe('C-12: one autosave write at a time', () => {
  it('a second autosave while the first is on its way: the file ends on the NEWER state, and the editor is saved', async () => {
    const ed = realEditor();
    ed.editableScript.insertAction(9000, 50); // 35 points
    clearTimeout(ed._autosaveTimer);
    const first = ed._autosave();
    ed.editableScript.insertAction(9100, 50); // 36 points, during the write
    clearTimeout(ed._autosaveTimer);
    const second = ed._autosave(); // its timer fired before the first landed
    await finishNewestFirst();
    await Promise.all([first, second]);
    expect(pointsOnDisk()).toBe(36);
    expect(ed.hasUnsavedChanges()).toBe(false);
  });

  it('three in a row, each fired before the last landed: the newest state is what stays on disk', async () => {
    const ed = realEditor();
    const runs = [];
    for (let i = 0; i < 3; i++) {
      ed.editableScript.insertAction(9000 + i * 100, 50);
      clearTimeout(ed._autosaveTimer);
      runs.push(ed._autosave());
    }
    await finishNewestFirst();
    await Promise.all(runs);
    expect(pointsOnDisk()).toBe(37);
    expect(ed.hasUnsavedChanges()).toBe(false);
  });

  it('with nothing on its way the write starts at once, as before (same timing for every caller)', () => {
    const ed = realEditor();
    ed.editableScript.insertAction(9000, 50);
    clearTimeout(ed._autosaveTimer);
    ed._autosave();
    expect(started).toBe(1);
    pending.pop().finish();
  });

  // E-02 (found while C-12, low): Ctrl+S (`_save`) wrote outside the chain,
  // so it raced an autosave already on its way exactly as two autosaves did.
  it('E-02: Ctrl+S while an autosave is on its way: the file ends on the NEWER state, and the editor is saved', async () => {
    const ed = realEditor();
    ed.editableScript.insertAction(9000, 50); // 35 points
    clearTimeout(ed._autosaveTimer);
    const autosave = ed._autosave();
    ed.editableScript.insertAction(9100, 50); // 36 points, during the write
    clearTimeout(ed._autosaveTimer);
    const ctrlS = ed._save(); // Ctrl+S before the autosave landed
    await finishNewestFirst();
    await Promise.all([autosave, ctrlS]);
    expect(pointsOnDisk()).toBe(36);
    expect(ed.hasUnsavedChanges()).toBe(false);
  });

  it('E-02: an autosave fired while a Ctrl+S write is on its way waits for it', async () => {
    const ed = realEditor();
    ed.editableScript.insertAction(9000, 50); // 35 points
    clearTimeout(ed._autosaveTimer);
    const ctrlS = ed._save();
    ed.editableScript.insertAction(9100, 50); // 36 points, during the Ctrl+S write
    clearTimeout(ed._autosaveTimer);
    const autosave = ed._autosave();
    await finishNewestFirst();
    await Promise.all([ctrlS, autosave]);
    expect(pointsOnDisk()).toBe(36);
    expect(ed.hasUnsavedChanges()).toBe(false);
  });

  it('E-02: with nothing on its way, Ctrl+S writes at once, as before', () => {
    const ed = realEditor();
    ed.editableScript.insertAction(9000, 50);
    clearTimeout(ed._autosaveTimer);
    ed._save();
    expect(started).toBe(1);
    pending.pop().finish();
  });

  it('E-02: a Ctrl+S whose turn comes after the editor moved to another script writes nothing', async () => {
    const OTHER = 'C:\\sandbox\\library\\Other Clip.funscript';
    disk[OTHER] = JSON.stringify({ version: '1.0', actions: SAVED.slice(0, 4) });
    const ed = realEditor();
    ed.editableScript.insertAction(9000, 50);
    clearTimeout(ed._autosaveTimer);
    const autosave = ed._autosave();
    const ctrlS = ed._save();
    // Before the autosave lands, the editor is put on another script.
    ed.setFunscriptPath(OTHER);
    ed.editableScript.loadFromData(JSON.parse(disk[OTHER]));
    await finishNewestFirst();
    await Promise.all([autosave, ctrlS]);
    expect(started).toBe(1); // the autosave only
    expect(JSON.parse(disk[OTHER]).actions).toHaveLength(4);
    expect(pointsOnDisk()).toBe(35);
  });

  it('a failed write does not block the next one', async () => {
    const ed = realEditor();
    let fail = true;
    const realWrite = window.funsync.writeFunscript;
    window.funsync.writeFunscript = (json, p) => {
      if (fail) { fail = false; return Promise.reject(new Error('disk full')); }
      return realWrite(json, p);
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    ed.editableScript.insertAction(9000, 50);
    clearTimeout(ed._autosaveTimer);
    const first = ed._autosave();
    ed.editableScript.insertAction(9100, 50);
    clearTimeout(ed._autosaveTimer);
    const second = ed._autosave();
    await finishNewestFirst();
    await Promise.all([first, second]);
    expect(pointsOnDisk()).toBe(36);
    expect(ed.hasUnsavedChanges()).toBe(false);
  });
});
