// N-04 (Dave 2026-11-08: "we need to add a bulk add when adding variations
// from file browser, one at a time is annoying"): the parts under the flow
// that tests/unit/variant-menu-states.test.js drives end to end.
//
// - main's `select-funscript` (lifted from electron/main.js): `{multiple:
//   true}` opens the picker with multiSelections and answers a list; every
//   other caller (no options) still gets one `{name, path}`.
// - planVariantAdds: what is skipped and the name each file starts with.
// - suggestVariantLabels gives exactly the suggestions the two one-file
//   naming dialogs show (the REAL dialogs: library.js `_addVariantWithNaming`
//   and app.js `_addManualVariant`, lifted), so "the existing rules" stay one
//   set of rules.
//
// jsdom (no docblock): the REAL dialogs render through Modal, and library.js
// imports i18n.js, which branches on `typeof window`. See notes/CLAUDE.md
// "Test environments".
import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import { liftMainHandler } from './helpers/main-handlers.js';
import { liftAppClass } from './helpers/app-methods.js';
import { suggestVariantLabels, planVariantAdds, pickedFiles } from '../../renderer/js/variant-bulk-add.js';
import { Library } from '../../renderer/components/library.js';
import { Modal } from '../../renderer/components/modal.js';
import { t } from '../../renderer/js/i18n.js';

afterEach(() => {
  document.querySelectorAll('.modal-overlay').forEach((o) => o.remove());
  document.body.innerHTML = '';
});

describe('main: select-funscript', () => {
  function handlerAnswering(filePaths) {
    const calls = [];
    const dialog = {
      showOpenDialog: vi.fn(async (_win, opts) => { calls.push(opts); return { canceled: !filePaths.length, filePaths }; }),
    };
    return { handler: liftMainHandler('select-funscript', { dialog, mainWindow: {}, path: path.win32 }), calls };
  }

  it('{multiple: true}: the picker allows several files and the answer is a list', async () => {
    const { handler, calls } = handlerAnswering(['C:\\S\\A.funscript', 'C:\\S\\B (Soft).funscript']);
    await expect(handler({}, { multiple: true })).resolves.toEqual([
      { name: 'A.funscript', path: 'C:\\S\\A.funscript' },
      { name: 'B (Soft).funscript', path: 'C:\\S\\B (Soft).funscript' },
    ]);
    expect(calls[0].properties).toEqual(['openFile', 'multiSelections']);
  });

  it('every other caller (no options) still gets one file, as before', async () => {
    const { handler, calls } = handlerAnswering(['C:\\S\\A.funscript', 'C:\\S\\B.funscript']);
    await expect(handler({}, undefined)).resolves.toEqual({ name: 'A.funscript', path: 'C:\\S\\A.funscript' });
    expect(calls[0].properties).toEqual(['openFile']);
  });

  it('cancelled: null either way', async () => {
    const { handler } = handlerAnswering([]);
    await expect(handler({}, { multiple: true })).resolves.toBeNull();
    await expect(handler({}, undefined)).resolves.toBeNull();
  });
});

describe('planVariantAdds', () => {
  it('skips what the list holds and what was picked twice; the rest keep their order', () => {
    const plan = planVariantAdds([
      { path: 'C:\\S\\A.funscript' },
      { path: 'C:\\V\\Clip.funscript', name: 'Clip.funscript' },
      { path: 'c:/S/A.funscript', name: 'A.funscript' },
      { path: 'C:\\S\\B.funscript' },
    ], { listedPaths: ['C:\\V\\Clip.funscript'], listedLabels: ['Default'] });
    expect(plan.add.map((a) => a.path)).toEqual(['C:\\S\\A.funscript', 'C:\\S\\B.funscript']);
    expect(plan.skipped.map((s) => s.name)).toEqual(['Clip.funscript', 'A.funscript']);
  });

  it('starting names are unique, against the list and within the batch', () => {
    const plan = planVariantAdds([
      { path: 'C:\\S\\X (Soft).funscript' },
      { path: 'C:\\T\\Y (Soft).funscript' },
      { path: 'C:\\T\\Soft.funscript' },
      { path: 'C:\\U\\Soft.funscript' },
    ], { listedPaths: [], listedLabels: ['soft'] });
    expect(plan.add.map((a) => a.label)).toEqual(['X (Soft)', 'Y (Soft)', 'Soft (2)', 'Soft (3)']);
  });

  it('pickedFiles reads every shape the picker answers', () => {
    expect(pickedFiles(null)).toEqual([]);
    expect(pickedFiles({ path: 'a', name: 'a' })).toEqual([{ path: 'a', name: 'a' }]);
    expect(pickedFiles([{ path: 'a' }, null, { name: 'no path' }])).toEqual([{ path: 'a' }]);
  });
});

describe('the Associate dialog\'s script picker', () => {
  async function browseFrom(opts) {
    const lib = new Library({ settings: { get: () => ({}), set: () => {} } });
    lib._allFunscripts = [];
    const answer = [{ name: 'A.funscript', path: 'C:\\S\\A.funscript' }, { name: 'B.funscript', path: 'C:\\S\\B.funscript' }];
    window.funsync = { selectFunscript: vi.fn(async (o) => (o?.multiple ? answer : answer[0])) };
    const picked = lib._showVariantSearchModal({ name: 'Clip.mp4', path: 'C:\\V\\Clip.mp4' }, opts);
    await vi.waitFor(() => expect(document.querySelector('.modal-overlay .library__assoc-action')).not.toBeNull());
    document.querySelector('.modal-overlay .library__assoc-action').click();
    const result = await picked;
    const asked = window.funsync.selectFunscript.mock.calls[0][0];
    delete window.funsync;
    return { result, asked };
  }

  it('+ Add Variation: Browse... takes several files', async () => {
    const { result, asked } = await browseFrom({ multiple: true });
    expect(asked).toEqual({ multiple: true });
    expect(result.map((f) => f.name)).toEqual(['A.funscript', 'B.funscript']);
  });

  it('a Custom Routing route\'s Select still picks one', async () => {
    const { result, asked } = await browseFrom({ title: t('library.assoc.routeScriptSearchTitle') });
    expect(asked).toBeUndefined();
    expect(result).toEqual({ name: 'A.funscript', path: 'C:\\S\\A.funscript' });
  });
});

describe('the suggestions are the one-file dialogs\' own', () => {
  const NAMES = [
    'Scene (Soft) (Long).funscript',
    'Scene.hard.funscript',
    'Scene (Soft).soft.funscript',
    'Plain Name.funscript',
    'v2.0 (Edit).final.funscript',
  ];
  const shown = () => [...document.querySelectorAll('.modal-overlay .modal-body .library__assoc-save-btn')]
    .slice(0, -1).map((b) => b.textContent);   // the last one is OK

  it.each(NAMES)('%s: the Associate dialog\'s naming step', async (name) => {
    const lib = new Library({ settings: { get: () => ({}), set: () => {} } });
    const done = lib._addVariantWithNaming('C:\\V\\Clip.mp4', `C:\\S\\${name}`, name);
    await vi.waitFor(() => expect(document.querySelector('.modal-overlay')).not.toBeNull());
    expect(shown()).toEqual(suggestVariantLabels(name));
    document.querySelector('.modal-close-btn').click();
    await done;
  });

  it.each(NAMES)('%s: the player\'s naming step', async (name) => {
    const App = liftAppClass(['_addManualVariant'], { Modal, t });
    const app = Object.assign(new App(), { _currentVideoPath: 'C:\\V\\Clip.mp4', settings: { get: () => ({}), set() {} } });
    const done = app._addManualVariant(`C:\\S\\${name}`, name);
    await vi.waitFor(() => expect(document.querySelector('.modal-overlay')).not.toBeNull());
    expect(shown()).toEqual(suggestVariantLabels(name));
    document.querySelector('.modal-close-btn').click();
    await done;
  });
});
