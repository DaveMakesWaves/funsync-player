/**
 * @vitest-environment jsdom
 * jsdom on purpose: script-editor.js imports DOM-branching modules
 * (notes/CLAUDE.md "Test environments").
 */
// The editor's modifier routes say what actually happened.
//
// Every route used to toast "Applied …" unconditionally, so a refusal or a
// run that changed nothing would have shown both the reason and a claim of
// success. Each route now reads applyModifier's status: refused → why, no-op
// → "Nothing changed", success → the old "Applied …" toast. Covered: the
// docked Modify menu, the Remap / Offset / Remove Pauses / Range Extend
// dialogs, the pop-out's OP_APPLY_MODIFIER, and Equalize (now localized).
//
// Also here, because they need the REAL ScriptEditor: the Range Extend
// dialog's timing (defect 8 lived in the dialog, not in a modifier), the
// created record surviving a real script switch through the per-path undo
// cache (defect 9), and the four selection dialogs refusing when the pop-out
// changed the selection while they were open (FT-031).
//
// The REAL prototype methods run on a minimal stand-in for the panel; only
// the toast and the Modal are mocked (the Modal resolves with what the user
// would have typed).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));
vi.mock('../../renderer/components/modal.js', () => ({ Modal: { open: vi.fn() } }));

const { showToast } = await import('../../renderer/js/toast.js');
const { Modal } = await import('../../renderer/components/modal.js');
const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { ScriptEditor } = await import('../../renderer/components/script-editor.js');
const { EditableScript } = await import('../../renderer/js/editable-script.js');
const { doubleSpeed } = await import('../../renderer/js/script-modifiers.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const DE = JSON.parse(fs.readFileSync('renderer/locales/de.json', 'utf8'));
// FT-031's toast as the user reads it. Pinned as text, not read from en.json,
// so a missing or renamed editor.toast.selectionChanged (t() would show the
// raw key) fails here.
const ENX = structuredClone(EN);
const SELECTION_CHANGED = 'The selection changed while the dialog was open. Nothing was applied.';

const zigzag = (n, step = 500) => Array.from({ length: n }, (_, i) => ({ at: i * step, pos: i % 2 ? 100 : 0 }));
const pairs = (es) => es.actions.map((a) => `${a.at}:${a.pos}`);
const toasts = () => showToast.mock.calls.map((c) => c[0]);
const REFUSED_DOUBLE =
  'Double Speed needs a continuous selection. Selections with gaps, like Every Nth point, work with move, nudge, invert and remap.';

function editorWith(actions) {
  const ed = Object.create(ScriptEditor.prototype);
  ed.editableScript = new EditableScript();
  ed.editableScript.loadFromData({ actions });
  ed._modifySelect = { value: '', selectedIndex: 0 };
  return ed;
}
const pickModify = (ed, value) => {
  ed._modifySelect.value = value;
  return ed._onModifyChange();
};

beforeEach(() => {
  showToast.mockClear();
  Modal.open.mockReset();
  _setBundlesForTests('en', ENX, ENX);
});

describe('Modify menu (docked)', () => {
  it.each([
    ['halfSpeed', 'Half Speed'],
    ['doubleSpeed', 'Double Speed'],
    ['reverse', 'Reverse'],
  ])('%s on a Ctrl+3 selection is refused, changes nothing and never says Applied', async (value, label) => {
    const ed = editorWith(zigzag(13));
    ed.editableScript.selectByPositionRange(0, 33);
    const before = pairs(ed.editableScript);
    await pickModify(ed, value);
    expect(pairs(ed.editableScript)).toEqual(before);
    expect(toasts()).toEqual([
      `${label} needs a continuous selection. Selections with gaps, like Every Nth point, work with move, nudge, invert and remap.`,
    ]);
  });

  it('a no-op says "Nothing changed", not Applied', async () => {
    const ed = editorWith(zigzag(5));
    ed.editableScript._selectedIndices = new Set([0, 1]); // Double Speed needs 3
    await pickModify(ed, 'doubleSpeed');
    expect(toasts()).toEqual(['Nothing changed']);
    expect(ed.editableScript.dirty).toBe(false);
  });

  it('a real change still says Applied', async () => {
    const ed = editorWith(zigzag(5));
    ed.editableScript.selectAll();
    await pickModify(ed, 'doubleSpeed');
    expect(toasts()).toEqual(['Applied: Double Speed']);
    expect(ed.editableScript.actions).toHaveLength(9);
  });
});

describe('modifier dialogs', () => {
  it('Remap to the same range: Nothing changed; to a new range: Remapped', async () => {
    const ed = editorWith(zigzag(4));
    ed.editableScript.selectAll();
    Modal.open.mockResolvedValueOnce({ min: 0, max: 100 });
    await ed._openRemapRangeModal();
    expect(toasts()).toEqual(['Nothing changed']);
    Modal.open.mockResolvedValueOnce({ min: 20, max: 80 });
    await ed._openRemapRangeModal();
    expect(toasts()).toEqual(['Nothing changed', 'Remapped to 20–80']);
  });

  it('Offset that clamps to where it already is: Nothing changed', async () => {
    const ed = editorWith(zigzag(4));
    ed.editableScript.select(0); // at 0 already
    Modal.open.mockResolvedValueOnce({ deltaMs: -500 });
    await ed._openOffsetTimeModal();
    expect(toasts()).toEqual(['Nothing changed']);
    Modal.open.mockResolvedValueOnce({ deltaMs: 500 });
    await ed._openOffsetTimeModal();
    expect(toasts()).toEqual(['Nothing changed', 'Offset by 500ms']);
  });

  it('Remove Pauses on a gappy selection is refused BEFORE its dialog opens', async () => {
    const ed = editorWith(zigzag(13));
    ed.editableScript.selectByPositionRange(0, 33);
    const before = pairs(ed.editableScript);
    await ed._openRemovePausesModal();
    expect(Modal.open).not.toHaveBeenCalled();
    expect(pairs(ed.editableScript)).toEqual(before);
    // The menu label is "Remove Pauses…"; the toast drops the ellipsis.
    expect(toasts()).toEqual([
      'Remove Pauses needs a continuous selection. Selections with gaps, like Every Nth point, work with move, nudge, invert and remap.',
    ]);
  });

  it('Remove Pauses with no pause: Nothing changed; with one: Pauses removed', async () => {
    const ed = editorWith(zigzag(4));
    ed.editableScript.selectAll();
    Modal.open.mockResolvedValueOnce({ maxGapMs: 5000 });
    await ed._openRemovePausesModal();
    expect(toasts()).toEqual(['Nothing changed']);
    const ed2 = editorWith([{ at: 0, pos: 0 }, { at: 500, pos: 100 }, { at: 20000, pos: 0 }, { at: 20500, pos: 100 }]);
    Modal.open.mockResolvedValueOnce({ maxGapMs: 5000 });
    await ed2._openRemovePausesModal();
    expect(toasts()).toEqual(['Nothing changed', 'Pauses removed']);
  });
});

describe('Range Extend dialog (defect 8)', () => {
  it('4 points ×2 → 0, 200, 400, 600 in one undo step', async () => {
    const ed = editorWith([{ at: 0, pos: 0 }, { at: 100, pos: 100 }, { at: 200, pos: 0 }, { at: 300, pos: 100 }]);
    ed.editableScript.selectAll();
    Modal.open.mockResolvedValueOnce({ factor: 2 });
    await ed._openRangeExtendModal();
    // The old per-index loop gave 0, 200, 300, 800.
    expect(ed.editableScript.actions.map((a) => a.at)).toEqual([0, 200, 400, 600]);
    expect(toasts()).toEqual(['Time scaled by 2x']);
    ed.editableScript.undo();
    expect(ed.editableScript.actions.map((a) => a.at)).toEqual([0, 100, 200, 300]);
  });

  it('8 points ×1.5 stay evenly spaced', async () => {
    const ed = editorWith(zigzag(8, 100));
    ed.editableScript.selectAll();
    Modal.open.mockResolvedValueOnce({ factor: 1.5 });
    await ed._openRangeExtendModal();
    expect(ed.editableScript.actions.map((a) => a.at)).toEqual([0, 150, 300, 450, 600, 750, 900, 1050]);
  });

  it('a gappy selection is refused before the dialog', async () => {
    const ed = editorWith(zigzag(13));
    ed.editableScript.selectByPositionRange(0, 33);
    await ed._openRangeExtendModal();
    expect(Modal.open).not.toHaveBeenCalled();
    expect(toasts()).toEqual([
      'Range Extend/Compress needs a continuous selection. Selections with gaps, like Every Nth point, work with move, nudge, invert and remap.',
    ]);
  });

  // Rewritten for FT-031: it pinned "Select 2+ actions to extend/compress",
  // the old re-check, which looked only at the COUNT (any other 2 points
  // still scaled). Every dialog now refuses on any change with one toast.
  it('a selection cleared while the dialog was open scales nothing', async () => {
    const ed = editorWith(zigzag(4, 100));
    ed.editableScript.selectAll();
    Modal.open.mockImplementationOnce(async () => {
      ed.editableScript.clearSelection(); // e.g. Esc in the pop-out
      return { factor: 2 };
    });
    await ed._openRangeExtendModal();
    expect(ed.editableScript.actions.map((a) => a.at)).toEqual([0, 100, 200, 300]);
    expect(toasts()).toEqual([SELECTION_CHANGED]);
  });
});

describe('the selection dialogs re-check the selection on Apply (FT-031)', () => {
  // 0..300 is a run of 100 ms strokes, then a 4.7 s pause, then three more.
  const SCRIPT = [0, 100, 200, 300, 5000, 5100, 5200].map((at, i) => ({ at, pos: i % 2 ? 100 : 0 }));
  const DIALOGS = [
    ['Remap Range', '_openRemapRangeModal', { min: 20, max: 80 }],
    ['Offset Time', '_openOffsetTimeModal', { deltaMs: 100 }],
    ['Remove Pauses', '_openRemovePausesModal', { maxGapMs: 1000 }],
    ['Range Extend', '_openRangeExtendModal', { factor: 2 }],
  ];
  // What the pop-out does while the dialog is open in the main window,
  // through the parent's REAL pop-out dispatch.
  const CHANGES = [
    ['Esc in the pop-out (nothing selected: the old code applied to the WHOLE script)', { op: 'clearSelection' }],
    ['a rubber band in the pop-out (other points)', { op: 'select', indices: [4, 5, 6] }],
    ['Shift+Up in the pop-out (the same points, moved)', { op: 'moveActions', deltaPos: 5 }],
  ];
  const cases = DIALOGS.flatMap(([name, method, value]) => CHANGES.map(([change, op]) => [name, change, method, value, op]));

  it.each(cases)('%s, then %s: Apply changes nothing and says why', async (_name, _change, method, value, op) => {
    const ed = editorWith(SCRIPT);
    ed.editableScript._selectedIndices = new Set([0, 1, 2]);
    let afterPopout = null;
    Modal.open.mockImplementationOnce(async () => {
      ed._applyPopoutEdit(op);
      afterPopout = pairs(ed.editableScript);
      return value;
    });
    await ed[method]();
    expect(Modal.open).toHaveBeenCalledTimes(1);
    expect(pairs(ed.editableScript)).toEqual(afterPopout);
    expect(toasts()).toEqual([SELECTION_CHANGED]);
  });

  it.each(DIALOGS)('%s with the selection untouched still applies', async (_name, method, value) => {
    const ed = editorWith(SCRIPT);
    ed.editableScript._selectedIndices = new Set([0, 1, 2, 3]);
    const before = pairs(ed.editableScript);
    Modal.open.mockResolvedValueOnce(value);
    await ed[method]();
    expect(toasts()).not.toContain(SELECTION_CHANGED);
    if (method === '_openRemovePausesModal') {
      expect(toasts()).toEqual(['Nothing changed']); // no pause inside 0..300
    } else {
      expect(pairs(ed.editableScript)).not.toEqual(before);
    }
  });

  it('nothing selected when it opened and nothing at Apply: Remap still remaps the whole script', async () => {
    const ed = editorWith(SCRIPT);
    Modal.open.mockResolvedValueOnce({ min: 20, max: 80 });
    await ed._openRemapRangeModal();
    expect(ed.editableScript.actions.map((a) => a.pos)).toEqual([20, 80, 20, 80, 20, 80, 20]);
    expect(toasts()).toEqual(['Remapped to 20–80']);
  });

  it('the signature is the sorted indices with each point\'s at and pos, and is empty with nothing selected', () => {
    const ed = editorWith(SCRIPT);
    const es = ed.editableScript;
    expect(es.selectionSignature()).toBe('');
    es._selectedIndices = new Set([2, 0]);
    expect(es.selectionSignature()).toBe('0:0:0|2:200:0');
    const sig = es.selectionSignature();
    es._selectedIndices = new Set([0, 2]);
    expect(es.selectionSignature()).toBe(sig); // Set order does not matter
  });
});

describe('Equalize toasts are localized', () => {
  it('in German', () => {
    _setBundlesForTests('de', DE, EN);
    const ed = editorWith(zigzag(5));
    ed.editableScript._selectedIndices = new Set([0, 1]);
    ed._equalizeSelected();
    ed.editableScript._selectedIndices = new Set([0, 1, 2]);
    ed._equalizeSelected();
    expect(toasts()).toEqual(['Mindestens 3 Aktionen zum Angleichen auswählen', '3 Aktionen angeglichen']);
  });
});

describe("the pop-out's OP_APPLY_MODIFIER", () => {
  it('a refusal is toasted and changes nothing', () => {
    const ed = editorWith(zigzag(13));
    ed.editableScript.selectByPositionRange(0, 33);
    const before = pairs(ed.editableScript);
    ed._applyPopoutEdit({ op: 'applyModifier', name: 'doubleSpeed' });
    expect(pairs(ed.editableScript)).toEqual(before);
    expect(toasts()).toEqual([REFUSED_DOUBLE]);
  });

  it('a no-op says Nothing changed; a success stays silent as before', () => {
    const ed = editorWith(zigzag(5));
    ed.editableScript._selectedIndices = new Set([0, 1]);
    ed._applyPopoutEdit({ op: 'applyModifier', name: 'doubleSpeed' });
    expect(toasts()).toEqual(['Nothing changed']);
    ed.editableScript.selectAll();
    ed._applyPopoutEdit({ op: 'applyModifier', name: 'doubleSpeed' });
    expect(toasts()).toEqual(['Nothing changed']);
    expect(ed.editableScript.actions).toHaveLength(9);
  });
});

describe('the created record survives a real script switch (defect 9)', () => {
  // Rewritten for CB-01: this switched away from UNSAVED edits (autosave off)
  // without a word, which is the data loss CB-01 fixed: the way back reloaded
  // the file, so the unsaved points were gone. The switch now asks first; the
  // user answers Save here (the file gets the edits), and the cached stack
  // still brings the record back on undo.
  // Multi-axis editing (Dave, 2026-11-24): a switch asks nothing and keeps A
  // in memory as it was: its edits, its "new points" record (it used to
  // reset on a switch) and its undo history.
  it('A → B → A keeps A in memory: its edits, its new-points record, and undo back past the nudge', async () => {
    const A = [{ at: 0, pos: 0 }, { at: 500, pos: 50 }, { at: 1000, pos: 100 }, { at: 1500, pos: 50 }, { at: 2000, pos: 0 }];
    const DISK = {
      'C:\\s\\A.funscript': JSON.stringify({ actions: A }),
      'C:\\s\\B.funscript': JSON.stringify({ actions: zigzag(4) }),
    };
    window.funsync = {
      readFunscript: async (p) => DISK[p],
      writeFunscript: async (json, p) => { DISK[p] = json; return p; },
    };
    const ed = editorWith(A);
    Object.assign(ed, {
      _funscriptPath: 'C:\\s\\A.funscript',
      _scriptSelect: { value: 'C:\\s\\A.funscript' },
      _availableScripts: [],
      _undoCache: new Map(),
      _loadToken: 0,
      _autosaveTimer: null,
      _autosaveEnabled: false,
      _stackedView: false,
      graph: null,
      _statusEl: {},
      _updateToolbarState() {},
      _broadcastScriptsChanged() {},
      _broadcastActionsChanged() {},
      _reloadIntoEngineAndSync() {},
    });
    const es = ed.editableScript;
    es.selectAll();
    es.applyModifier(doubleSpeed);
    es._selectedIndices = new Set(es.getCreatedIndices());
    es.moveActions(es.selectedIndices, 0, 20);
    const edited = pairs(es);
    const created = es.getCreatedActions().map((a) => `${a.at}:${a.pos}`);

    ed._scriptSelect.value = 'C:\\s\\B.funscript';
    await ed._onScriptSelectChange();
    expect(Modal.open).not.toHaveBeenCalled(); // no Save / Don't save / Cancel on a switch
    expect(JSON.parse(DISK['C:\\s\\A.funscript']).actions).toEqual(A); // nothing written
    ed._scriptSelect.value = 'C:\\s\\A.funscript';
    await ed._onScriptSelectChange();
    expect(pairs(es)).toEqual(edited);
    expect(es.getCreatedActions().map((a) => `${a.at}:${a.pos}`)).toEqual(created);

    es.undo(); // the snapshot taken before the nudge, through JSON and back
    expect(es.getCreatedActions().map((a) => `${a.at}:${a.pos}`))
      .toEqual(['250:50', '750:50', '1250:50', '1750:50']);
    delete window.funsync;
  });
});
