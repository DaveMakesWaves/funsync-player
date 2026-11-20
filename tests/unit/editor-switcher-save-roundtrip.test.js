/**
 * @vitest-environment jsdom
 * jsdom on purpose: script-editor.js imports DOM-branching modules
 * (notes/CLAUDE.md "Test environments").
 */
// FT-001: a save after the script switcher wrote the funscript back with
// its metadata flattened (in v0.9.2 and earlier).
//
// The switcher (_onScriptSelectChange) loads the picked file through
// EditableScript.loadFromData, which kept only the file's INNER `metadata`
// object as the whole file. Ctrl+S (_save) and autosave (_autosave) then
// wrote that out via toFunscriptJSON: title/creator/tags at the top level,
// version forced to "1.0", top-level inverted / range / axes gone, and MFP
// `time: "HH:MM:SS.mmm"` bookmarks written without any time.
//
// This drives the REAL ScriptEditor switch and save methods on a minimal
// stand-in panel, against a fake disk, and compares what is written with the
// file that was read. Only the toast and the Modal are mocked.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));
vi.mock('../../renderer/components/modal.js', () => ({ Modal: { open: vi.fn() } }));

const { ScriptEditor } = await import('../../renderer/components/script-editor.js');
const { EditableScript } = await import('../../renderer/js/editable-script.js');

const MAIN = 'C:\\sandbox\\library\\Variant Clip.funscript';
const META = 'C:\\sandbox\\library\\Variant Clip (meta).funscript';

const ORIGINAL = {
  version: '1.1',
  inverted: true,
  range: 90,
  axes: [{ id: 'R1', actions: [{ at: 0, pos: 50 }, { at: 600, pos: 80 }] }],
  metadata: {
    title: 'Variant Clip',
    creator: 'someone',
    tags: ['slow', 'tease'],
    bookmarks: [{ time: '00:00:05.000', name: 'x' }],
  },
  actions: [{ at: 0, pos: 0 }, { at: 500, pos: 100 }, { at: 1000, pos: 0 }],
};

let disk;
let writes;

function editorOn(path, actions) {
  const ed = Object.create(ScriptEditor.prototype);
  ed.editableScript = new EditableScript();
  ed.editableScript.loadFromData({ actions });
  Object.assign(ed, {
    _funscriptPath: path,
    _scriptSelect: { value: path },
    _availableScripts: [{ path: MAIN }, { path: META }],
    _undoCache: new Map(),
    _loadToken: 0,
    _autosaveTimer: null,
    _autosaveEnabled: false,
    _autosaveStatusEl: null,
    _stackedView: false,
    graph: null,
    _statusEl: {},
    _updateToolbarState() {},
    _updateStatus() {},
    _broadcastScriptsChanged() {},
    _broadcastActionsChanged() {},
    _reloadIntoEngineAndSync() {},
  });
  return ed;
}

async function switchTo(ed, path) {
  ed._scriptSelect.value = path;
  await ed._onScriptSelectChange();
  expect(ed._funscriptPath).toBe(path);
}

beforeEach(() => {
  disk = {
    [MAIN]: JSON.stringify({ version: '1.0', actions: [{ at: 0, pos: 10 }, { at: 400, pos: 90 }] }),
    [META]: JSON.stringify(ORIGINAL, null, 2),
  };
  writes = [];
  window.funsync = {
    readFunscript: async (p) => disk[p],
    writeFunscript: async (json, p) => { writes.push({ path: p, json }); disk[p] = json; return p; },
  };
});

afterEach(() => {
  delete window.funsync;
});

function expectShapeKept(written) {
  const out = JSON.parse(written);
  expect(Object.keys(out).sort()).toEqual(Object.keys(ORIGINAL).sort());
  expect(out.version).toBe('1.1');
  expect(out.inverted).toBe(true);
  expect(out.range).toBe(90);
  expect(out.axes).toEqual(ORIGINAL.axes);
  expect(out.metadata.title).toBe('Variant Clip');
  expect(out.metadata.creator).toBe('someone');
  expect(out.metadata.tags).toEqual(['slow', 'tease']);
  expect(out.metadata.bookmarks).toEqual([{ at: 5000, name: 'x' }]);
  return out;
}

describe('a save after the script switcher keeps the file\'s shape (FT-001)', () => {
  it('Ctrl+S writes back every top-level field, the metadata block and the bookmark time', async () => {
    const ed = editorOn(MAIN, [{ at: 0, pos: 10 }, { at: 400, pos: 90 }]);
    await switchTo(ed, META);

    ed.editableScript.moveActions([1], 0, -5); // a nudge
    await ed._save();

    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe(META);
    const out = expectShapeKept(writes[0].json);
    expect(out.actions).toEqual([{ at: 0, pos: 0 }, { at: 500, pos: 95 }, { at: 1000, pos: 0 }]);
  });

  it('autosave writes the same shape', async () => {
    const ed = editorOn(MAIN, [{ at: 0, pos: 10 }, { at: 400, pos: 90 }]);
    await switchTo(ed, META);

    ed.editableScript.moveActions([2], 0, 7);
    await ed._autosave();

    expect(writes).toHaveLength(1);
    expectShapeKept(writes[0].json);
  });

  it('the metadata dialog opens on the file\'s own fields after the switch', async () => {
    const ed = editorOn(MAIN, [{ at: 0, pos: 10 }]);
    await switchTo(ed, META);
    // What _openMetadataModal reads.
    const md = ed.editableScript.getMetadata().metadata || {};
    expect(md.title).toBe('Variant Clip');
    expect(md.creator).toBe('someone');
  });

  it('switching away and back, then saving, still keeps the shape', async () => {
    const ed = editorOn(MAIN, [{ at: 0, pos: 10 }, { at: 400, pos: 90 }]);
    await switchTo(ed, META);
    await switchTo(ed, MAIN);
    await switchTo(ed, META);
    ed.editableScript.moveActions([0], 0, 3);
    await ed._save();
    expectShapeKept(writes.at(-1).json);
  });
});
