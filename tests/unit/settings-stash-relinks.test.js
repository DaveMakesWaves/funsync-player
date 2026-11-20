/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Stash block (settings-stash.js) builds its
 * linked view, live line and Re-linked list as DOM (notes/CLAUDE.md "Test
 * environments").
 */
// A full sync's re-links say so and offer Undo (Stash fix-up 2026-11-19,
// s1-review-a RA-S1-1; DESIGN-stash-s1.md (b) "Gone" / "Changed": "it is
// re-linked, with Undo"; (e): the only things that remove Stash data are
// your actions, each with Undo, "a re-link to a new unique match").
//
// Main answers each re-link of a sync with an Undo token (electron/
// stash-ipc.js syncReply: relinked[].undoId). Pinned here, by what the user
// sees and what main is sent:
//   - Settings > Sync now: the result line names the re-links, with one
//     Undo for them all (main gets each token back);
//   - the Re-linked list: one row per video, with an Undo each and Undo all;
//   - the start-up sync (Settings closed) keeps its re-links for the next
//     Settings (stash-store.js), and so does a Sync now that ends after
//     Settings closed;
//   - a row goes once its video is linked elsewhere since (an Undo never
//     undoes a later change), or main no longer has its token.
// The REAL StashSettingsBlock and stash-store.js; a fake main in s1-2a-main's
// reply shapes.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import { StashSettingsBlock } from '../../renderer/components/settings-stash.js';
import {
  stashRelinks, stashSyncOnStart, initStashStore, _resetStashStoreForTests, _setStashApiForTests,
} from '../../renderer/js/stash-store.js';
import { bundleWith, S1_FIXUP_STRINGS } from '../helpers/stash-dialog-fixtures.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const SERVER = 'http://127.0.0.1:9999';
const A = 'C:\\Lib\\Alpha Clip.mp4';
const B = 'C:\\Lib\\Bravo Clip.mp4';

const settle = async () => {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
    for (let j = 0; j < 10; j++) await Promise.resolve();
  }
};

function projection({ links = {} } = {}) {
  const link = (sceneId) => ({ sceneId, server: SERVER, by: 'oshash', fp: { size: 1000, mtimeMs: 5, oshash: 'aa' }, linkedAt: 9, state: 'ok' });
  return {
    v: 1, rev: 3, server: { url: SERVER, version: 'v0.32.0' }, lastSync: null,
    links: Object.fromEntries(Object.entries(links).map(([p, id]) => [p, link(id)])),
    check: {}, refused: {},
    scenes: {
      1: { id: '1', title: 'Old Scene', server: SERVER },
      2: { id: '2', title: 'Merged Scene', server: SERVER },
      3: { id: '3', title: 'Other Scene', server: SERVER },
      4: { id: '4', title: 'Merged Two', server: SERVER },
    },
    performers: {}, studios: {}, tags: {},
  };
}

/** A fake main (window.funsync's Stash calls): `data` is what stashGetData answers; Undo puts the old link back. */
function fakeMain({ links = { [A]: '2', [B]: '4' } } = {}) {
  const main = {
    data: projection({ links }), undone: [], syncResolve: null, progress: new Set(), expired: new Set(), key: {}, library: {}, removeUndo: [],
  };
  const undoOf = { 'u-a': [A, '1'], 'u-b': [B, '3'] };
  main.api = {
    stashStatus: vi.fn(async () => ({
      ok: true,
      settings: { enabled: true, url: SERVER, syncOnStart: true, pathRules: [], trustedCert: null },
      key: { hasKey: false, keyStorage: null, saveStorage: 'safeStorage', ...main.key },
      keyTravelsInClear: false,
      library: { state: 'loaded', rev: 3, server: { url: SERVER, version: 'v0.32.0' }, lastSync: null, counts: { links: 2, check: 0, refused: 0, scenes: 4 }, ...main.library },
      sync: { running: false, kind: null, progress: null },
    })),
    stashGetData: vi.fn(async () => structuredClone(main.data)),
    stashSync: vi.fn(() => new Promise((resolve) => { main.syncResolve = resolve; })),
    stashSyncOnStart: vi.fn(() => new Promise((resolve) => { main.syncResolve = resolve; })),
    stashCancel: vi.fn(async () => ({ ok: true })),
    stashUndo: vi.fn(async (id) => {
      if (id === 'undo-remove-1') return main.removeUndo.shift() ?? { ok: false, code: 'expired' };
      if (main.expired.has(id) || !undoOf[id]) return { ok: false, code: 'expired' };
      const [p, sceneId] = undoOf[id];
      main.data.links[p] = { ...main.data.links[p], sceneId };
      main.data.rev += 1;
      main.undone.push(id);
      delete undoOf[id];
      return { ok: true };
    }),
    stashRemoveData: vi.fn(async () => ({ ok: true, undoId: 'undo-remove-1', undoMs: 8000 })),
    onStashProgress: (cb) => { main.progress.add(cb); return () => main.progress.delete(cb); },
    onStashChanged: () => () => {},
    onStashSettingsChanged: () => () => {},
  };
  return main;
}

/** Main's sync reply (stash-ipc.js syncReply) with these re-links. */
function reply(relinked) {
  return {
    ok: true, kind: 'full', written: true, partial: false, cancelled: false, complete: true, skipped: false, error: null,
    counts: { linked: 2, check: 0, notInStash: 0, gone: 0, changed: 0, skipped: 0 },
    relinked,
    details: { done: 2, total: 2 },
  };
}
const RELINK_A = { path: A, from: '1', to: '2', undoId: 'u-a' };
const RELINK_B = { path: B, from: '3', to: '4', undoId: 'u-b' };

let main;
let block;

function settingsLike() {
  const stash = { enabled: true, url: SERVER, syncOnStart: true, pathRules: [], trustedCert: null };
  return {
    get: (p) => (p === 'stash' ? stash : p.startsWith('stash.') ? stash[p.slice(6)] : undefined),
    set: vi.fn(),
    applySavedSetting: vi.fn(),
  };
}

async function openBlock() {
  block = new StashSettingsBlock({ settings: settingsLike(), getVideos: () => [{ path: A, size: 1000, dateAdded: 5 }, { path: B, size: 1000, dateAdded: 5 }] });
  document.body.appendChild(block.el);
  await settle();
  return block;
}

const q = (sel) => block.el.querySelector(sel);
const live = () => q('.stash-settings__live-text').textContent;
const rows = () => [...block.el.querySelectorAll('.stash-settings__relink-row')];
const rowText = (r) => [...r.querySelectorAll('span')].map((s) => s.textContent);

beforeEach(() => {
  _resetStashStoreForTests();
  _setBundlesForTests('en', bundleWith(EN, S1_FIXUP_STRINGS), EN);
  document.body.innerHTML = '<div id="toast-container"></div>';
  main = fakeMain();
  window.funsync = main.api;
});

afterEach(() => {
  block?.destroy();
  block = null;
  delete window.funsync;
  _resetStashStoreForTests();
  document.body.innerHTML = '';
});

afterAll(() => _setBundlesForTests('en', EN, EN));

describe('Settings > Sync now that re-links videos', () => {
  it('the result line names the re-links and its Undo gives main each token back', async () => {
    await openBlock();
    q('[data-stash-focus="sync"]').click();
    await settle();
    main.syncResolve(reply([RELINK_A, RELINK_B]));
    await settle();
    expect(live()).toBe(`${t('settingsPanel.stash.syncDone', { counts: '2 videos matched · 0 need a check · 0 not in Stash' })} 2 videos were re-linked to another Stash scene.`);
    const undo = q('.stash-settings__undo');
    expect(undo.hidden).toBe(false);
    expect(undo.getAttribute('aria-label')).toBe('Undo the 2 re-links');
    undo.click();
    await settle();
    expect(main.api.stashUndo.mock.calls.map(([id]) => id)).toEqual(['u-a', 'u-b']);
    expect(live()).toBe('2 re-links undone.');
    expect(stashRelinks()).toEqual([]);
    expect(rows()).toEqual([]);
  });

  it('the Re-linked list: one row per video (its name, the scene it is linked to now) with its own Undo', async () => {
    await openBlock();
    q('[data-stash-focus="sync"]').click();
    await settle();
    main.syncResolve(reply([RELINK_B, RELINK_A]));
    await settle();
    expect(q('.stash-settings__relinks h3').textContent).toBe('Re-linked (2)');
    expect(rows().map(rowText)).toEqual([
      ['Alpha Clip.mp4', 'now linked to “Merged Scene”'],
      ['Bravo Clip.mp4', 'now linked to “Merged Two”'],
    ]);
    expect(rows()[0].querySelector('span').title).toBe(A);
    const rowUndo = rows()[1].querySelector('button');
    expect(rowUndo.getAttribute('aria-label')).toBe('Undo the re-link of Bravo Clip.mp4');
    rowUndo.click();
    await settle();
    expect(main.api.stashUndo.mock.calls.map(([id]) => id)).toEqual(['u-b']);
    expect(live()).toBe('Bravo Clip.mp4 is linked to its earlier Stash scene again.');
    expect(rows().map((r) => rowText(r)[0])).toEqual(['Alpha Clip.mp4']);
    expect(main.data.links[A].sceneId).toBe('2'); // the other video is untouched
  });

  it('Undo all sends every token left, and the list goes', async () => {
    await openBlock();
    q('[data-stash-focus="sync"]').click();
    await settle();
    main.syncResolve(reply([RELINK_A, RELINK_B]));
    await settle();
    const all = q('[data-stash-focus="relinks-undo-all"]');
    expect(all.textContent).toBe('Undo all');
    expect(all.getAttribute('aria-label')).toBe('Undo all 2 re-links');
    all.click();
    await settle();
    expect(main.api.stashUndo.mock.calls.map(([id]) => id)).toEqual(['u-a', 'u-b']);
    expect(main.data.links[A].sceneId).toBe('1');
    expect(main.data.links[B].sceneId).toBe('3');
    expect(q('.stash-settings__relinks').hidden).toBe(true);
  });

  it('a sync with no re-link says nothing more and offers no Undo', async () => {
    await openBlock();
    q('[data-stash-focus="sync"]').click();
    await settle();
    main.syncResolve(reply([]));
    await settle();
    expect(live()).toBe(t('settingsPanel.stash.syncDone', { counts: '2 videos matched · 0 need a check · 0 not in Stash' }));
    expect(q('.stash-settings__undo').hidden).toBe(true);
    expect(q('.stash-settings__relinks').hidden).toBe(true);
  });

  it('a re-link with no Undo token is not offered (nothing to send back)', async () => {
    await openBlock();
    q('[data-stash-focus="sync"]').click();
    await settle();
    main.syncResolve(reply([{ path: A, from: '1', to: '2', undoId: null }]));
    await settle();
    expect(q('.stash-settings__undo').hidden).toBe(true);
    expect(rows()).toEqual([]);
  });
});

describe('re-links made while Settings was closed', () => {
  it('the start-up sync\'s re-links (its reply used to be dropped) are listed when Settings opens, each with Undo', async () => {
    await initStashStore({ isEnabled: () => true, isSyncOnStart: () => true });
    const done = stashSyncOnStart([{ path: A, size: 1000, dateAdded: 5 }]);
    expect(main.api.stashSyncOnStart).toHaveBeenCalledTimes(1);
    main.syncResolve({ ...reply([RELINK_A]), started: true });
    await done;
    expect(stashRelinks().map((r) => r.undoId)).toEqual(['u-a']);

    await openBlock();
    expect(rows().map(rowText)).toEqual([['Alpha Clip.mp4', 'now linked to “Merged Scene”']]);
    rows()[0].querySelector('button').click();
    await settle();
    expect(main.api.stashUndo).toHaveBeenCalledWith('u-a');
    expect(main.data.links[A].sceneId).toBe('1');
    expect(rows()).toEqual([]);
  });

  it('Settings open while the start-up sync ends: its line names the re-links, with Undo', async () => {
    await openBlock();
    for (const cb of main.progress) cb({ kind: 'full', step: 'match', done: 1, total: 2 });
    for (const cb of main.progress) cb({ kind: 'full', step: 'finished', result: reply([RELINK_A]) });
    await settle();
    expect(live()).toContain('1 video was re-linked to another Stash scene.');
    expect(q('.stash-settings__undo').hidden).toBe(false);
    expect(rows()).toHaveLength(1);
  });

  it('a Sync now that ends after Settings closed keeps its re-links for the next Settings', async () => {
    await openBlock();
    q('[data-stash-focus="sync"]').click();
    await settle();
    block.destroy();
    block.el.remove();
    main.syncResolve(reply([RELINK_B]));
    await settle();
    await openBlock();
    expect(rows().map((r) => rowText(r)[0])).toEqual(['Bravo Clip.mp4']);
  });
});

describe('an Undo never undoes a later change', () => {
  it('a video linked to another scene since (you chose one, another sync) has no row', async () => {
    main.data.links[A] = { ...main.data.links[A], sceneId: '3' };
    await openBlock();
    q('[data-stash-focus="sync"]').click();
    await settle();
    main.syncResolve(reply([RELINK_A, RELINK_B]));
    await settle();
    expect(rows().map((r) => rowText(r)[0])).toEqual(['Bravo Clip.mp4']);
  });

  it('a token main no longer has ("expired"): the row goes and the line says it could not be undone', async () => {
    main.expired.add('u-a');
    await openBlock();
    q('[data-stash-focus="sync"]').click();
    await settle();
    main.syncResolve(reply([RELINK_A]));
    await settle();
    rows()[0].querySelector('button').click();
    await settle();
    expect(live()).toBe('The re-link of Alpha Clip.mp4 could not be undone. Its Stash data changed since, or FunSync could not save it.');
    expect(rows()).toEqual([]);
    expect(main.data.links[A].sceneId).toBe('2');
  });

  it('the newest re-link of a video replaces an older one in the list (only it is still the link)', async () => {
    await openBlock();
    q('[data-stash-focus="sync"]').click();
    await settle();
    main.syncResolve(reply([{ path: A, from: '9', to: '1', undoId: 'u-old' }]));
    await settle();
    q('[data-stash-focus="sync"]').click();
    await settle();
    main.syncResolve(reply([RELINK_A]));
    await settle();
    expect(stashRelinks().map((r) => r.undoId)).toEqual(['u-a']);
  });
});

// s1-fixup-main's newer status answers (SCRATCH/s1-fixup-main/ipc-changes.txt
// 3 and 4), shown where Settings showed the old ones.
describe('the key line and the data line follow main\'s newer answers', () => {
  const keyLine = () => q('.stash-settings__key-text').textContent;
  const dataLine = () => q('.stash-settings__note--warn');

  it('a key saved for another address says so (it is not sent here) instead of "API key saved"', async () => {
    main.key = { hasKey: true, keyStorage: 'safeStorage', address: 'http://192.168.1.20:9999', elsewhere: true };
    await openBlock();
    expect(keyLine()).toBe("The saved API key belongs to http://192.168.1.20:9999, so FunSync does not send it to this address. Paste this Stash's key, or remove the saved one.");
    main.key = { hasKey: true, keyStorage: 'safeStorage', address: null, elsewhere: true };
    await block.refresh();
    expect(keyLine()).toBe("The saved API key belongs to another address, so FunSync does not send it to this one. Paste this Stash's key, or remove the saved one.");
    main.key = { hasKey: true, keyStorage: 'safeStorage', address: SERVER, elsewhere: false };
    await block.refresh();
    expect(keyLine()).toBe(t('settingsPanel.stash.keySavedEncrypted'));
  });

  it('data recovered from the previous copy: no "Sync to rebuild it"', async () => {
    main.library = { damaged: { as: 'library.damaged-2026-11-19.json', reason: 'not-json' }, recovered: { from: 'library.json.bak', reason: 'not-json' } };
    await openBlock();
    expect(dataLine().hidden).toBe(false);
    expect(dataLine().textContent).toBe('FunSync could not read its Stash data. It was kept aside as library.damaged-2026-11-19.json, and the previous copy was used.');
    main.library = { damaged: null, recovered: { from: 'library.json.bak', reason: 'missing' } };
    await block.refresh();
    expect(dataLine().textContent).toBe("FunSync's Stash data file was missing. The previous copy was used.");
    main.library = { damaged: { as: 'library.damaged-2026-11-19.json', reason: 'not-json' }, recovered: null };
    await block.refresh();
    expect(dataLine().textContent).toBe(t('settingsPanel.stash.damaged', { name: 'library.damaged-2026-11-19.json' }));
    main.library = {};
    await block.refresh();
    expect(dataLine().hidden).toBe(true);
  });
});

// s1-fixup-main's Undo of Remove Stash data (ipc-changes.txt 6 + addendum).
describe('Remove Stash data…: its Undo follows main\'s newer answers', () => {
  async function removeIt() {
    await openBlock();
    q('[data-stash-focus="remove"]').click();
    await vi.waitFor(() => expect(document.querySelector('.modal-overlay .modal-btn--danger')).toBeTruthy());
    document.querySelector('.modal-overlay .modal-btn--danger').click();
    await vi.waitFor(() => expect(live()).toBe(t('settingsPanel.stash.removed')));
    expect(q('.stash-settings__undo').hidden).toBe(false);
  }

  it('put back together with what was synced since ({ok, merged}): says so', async () => {
    main.removeUndo = [{ ok: true, merged: true }];
    await removeIt();
    q('.stash-settings__undo').click();
    await settle();
    expect(live()).toBe('Stash data put back, together with what was synced since.');
    expect(q('.stash-settings__undo').hidden).toBe(true);
  });

  it('a put-back that failed keeps the data aside: says so and offers the same Undo again, which can then work', async () => {
    main.removeUndo = [{ ok: false, code: 'restore-failed' }, { ok: true }];
    await removeIt();
    q('.stash-settings__undo').click();
    await settle();
    expect(live()).toBe("The Stash data could not be put back. It is kept aside in FunSync's data folder; you can try Undo again.");
    expect(q('.stash-settings__undo').hidden).toBe(false);
    q('.stash-settings__undo').click();
    await settle();
    expect(main.api.stashUndo.mock.calls.map(([id]) => id)).toEqual(['undo-remove-1', 'undo-remove-1']);
    expect(live()).toBe(t('settingsPanel.stash.removeUndone'));
    expect(q('.stash-settings__undo').hidden).toBe(true);
  });

  it('too late ("expired"): the old words, and no second Undo', async () => {
    main.removeUndo = [{ ok: false, code: 'expired' }];
    await removeIt();
    q('.stash-settings__undo').click();
    await settle();
    expect(live()).toBe(t('settingsPanel.stash.undoFailed'));
    expect(q('.stash-settings__undo').hidden).toBe(true);
  });
});
