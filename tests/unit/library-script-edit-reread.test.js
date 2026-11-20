// jsdom on purpose (no node docblock): the REAL Library renders its header,
// sort picker and cards, and imports i18n.js, which branches on
// `typeof window`. See notes/CLAUDE.md "Test environments".
//
// V81 review (Dave, 2026-11-03): since V81 a script read once this session
// is painted from what that read left on the video instead of being read on
// every render (`_statsReadFor`). The check compares the script PATH, so a
// script edited and saved in place by the app's own editor kept its old
// avg/max speed, heatmap and embedded-axes badge for the rest of the session,
// and the speed sorts ordered by the pre-edit values. Driven through the
// REAL editor `_save` (which writes, then announces the save) and the REAL
// library and sort picker.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { Library } = await import('../../renderer/components/library.js');
const { ScriptEditor } = await import('../../renderer/components/script-editor.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const DIR = 'D:\\funsc';
const A = `${DIR}\\Alpha.funscript`;
const B = `${DIR}\\Bravo.funscript`;

/** A script that strokes 0-100 every `ms` milliseconds: shorter is faster. */
const strokes = (ms) => JSON.stringify({
  actions: Array.from({ length: 20 }, (_, i) => ({ at: i * ms, pos: i % 2 ? 100 : 0 })),
});

let scripts;
let lib;
let container;

beforeEach(async () => {
  _setBundlesForTests('en', EN, EN);
  scripts = { [A]: strokes(1000), [B]: strokes(200) };   // Bravo is the fast one
  const store = {
    'library.sources': [{ id: 'a', name: 'Main', path: DIR, enabled: true }],
    'library.collections': [],
    'library.associations': {},
  };
  const settings = {
    get: (k) => store[k],
    set: (k, v) => { store[k] = v; },
    getVideoCategories: () => [],
    getCategories: () => [],
  };
  window.funsync = {
    scanDirectory: vi.fn(async () => ({
      videos: [
        { name: 'Alpha.mp4', path: `${DIR}\\Alpha.mp4`, hasFunscript: true, funscriptPath: A, variants: [] },
        { name: 'Bravo.mp4', path: `${DIR}\\Bravo.mp4`, hasFunscript: true, funscriptPath: B, variants: [] },
      ],
      unmatchedFunscripts: [], unmatchedSubtitles: [], allFunscripts: [], failedPaths: [], skippedPaths: [],
    })),
    readFunscript: vi.fn(async (p) => scripts[p] ?? null),
    writeFunscript: vi.fn(async (json, p) => { scripts[p] = json; return p; }),
  };
  lib = new Library({ settings });
  // Not under test: background passes and thumbnails (backend).
  lib._registerWithBackend = () => {};
  lib._validateAssociationsInBackground = () => {};
  lib._validateManualVariantsInBackground = () => {};
  lib._precomputeDurationsInBackground = async () => {};
  lib._precomputeSpeedStatsInBackground = async () => {};
  lib._queueThumbnail = () => {};
  container = document.createElement('div');
  document.body.appendChild(container);
  await lib.show(container);
  await new Promise((r) => setTimeout(r, 0));   // the cards' script reads land
});

afterEach(() => {
  container.remove();
  vi.restoreAllMocks();
});

const shownNames = () => [...container.querySelectorAll('.library__card')]
  .map((c) => c.dataset.videoPath.split('\\').pop());
function pickSort(field) {
  container.querySelector('#library-sort-btn').click();
  container.querySelector(`.library__picker-item[data-value="${field}"] input[type="radio"]`).click();
}
const settle = () => new Promise((r) => setTimeout(r, 0));

/** The editor saving Alpha's script in place, through its real _save. */
async function editAndSave(path, json) {
  const editor = Object.create(ScriptEditor.prototype);
  editor._funscriptPath = path;
  editor.editableScript = { toFunscriptJSON: () => json, markSaved: () => {} };
  editor._updateStatus = () => {};
  editor._reloadIntoEngineAndSync = () => {};
  await editor._save();
}

describe('a script edited in the app is read again (V81 review)', () => {
  it('the speed sort follows the edit, not the speeds read before it', async () => {
    pickSort('avgSpeed');                              // fastest first
    expect(shownNames()).toEqual(['Bravo.mp4', 'Alpha.mp4']);

    await editAndSave(A, strokes(50));                 // Alpha is now the fastest
    expect(window.funsync.writeFunscript).toHaveBeenCalledWith(strokes(50), A);

    lib._applyFilters();                               // back in the library: a render
    await settle();                                    // ...whose card reads land
    pickSort('name');
    pickSort('avgSpeed');

    expect(shownNames()).toEqual(['Alpha.mp4', 'Bravo.mp4']);
    expect(window.funsync.readFunscript.mock.calls.filter(([p]) => p === A)).toHaveLength(2);
  });

  it('an EroScripts download over the same file is read again too', async () => {
    scripts[A] = strokes(50);                          // the download replaced Alpha's script
    lib.associateDownloadedScript(`${DIR}\\Alpha.mp4`, A);   // what app.js calls after it
    await settle();
    pickSort('avgSpeed');

    expect(shownNames()).toEqual(['Alpha.mp4', 'Bravo.mp4']);
  });

  it('a render with nothing saved still reads no script twice', async () => {
    const reads = window.funsync.readFunscript.mock.calls.length;
    lib._applyFilters();
    await settle();
    expect(window.funsync.readFunscript.mock.calls.length).toBe(reads);
  });
});
