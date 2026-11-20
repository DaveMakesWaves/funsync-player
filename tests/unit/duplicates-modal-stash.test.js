/**
 * @vitest-environment jsdom
 * jsdom on purpose: the real DuplicatesModal renders into a real element
 * and its real buttons are clicked; i18n.js branches on `typeof window`
 * (notes/CLAUDE.md "Test environments").
 */
// Find duplicates' "Looks the same (Stash)" tier on screen (Stash "next"
// lot, stage sn-library, 2026-11-19; DESIGN-stash-s1.md (j) #2). The real
// modal over the seeded test Stash's data (tests/helpers/stash-next-
// fixtures.js: synthetic_large.mkv and its re-encode share a phash),
// renamed so FunSync's own checks find nothing. window.funsync is the
// preload bridge with the answers main gives; the REAL stash-store.js
// holds the synced data, its Stash calls recorded. Asserted: the tier and
// its words; nothing ticked by itself, the keeper cannot be ticked, nothing
// goes to the Recycle Bin without the confirm; Stash is asked nothing; Stash
// off, or a file changed since its link, shows no such tier.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { DuplicatesModal } from '../../renderer/components/duplicates-modal.js';
import { TIER } from '../../renderer/js/duplicate-finder.js';
import { dataService } from '../../renderer/js/data-service.js';
import {
  STASH_API, initStashStore, _resetStashStoreForTests, _setStashApiForTests, stashData,
} from '../../renderer/js/stash-store.js';
import { bundleWith } from '../helpers/stash-dialog-fixtures.js';
import { P, NEXT_STRINGS, snProjection, snVideos } from '../helpers/stash-next-fixtures.js';

const EN = bundleWith(JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8')), NEXT_STRINGS);
const RENAMED = 'zz_export_7731.mp4';

/** The library's videos, the re-encode renamed (its name says nothing). */
const VIDEOS = snVideos().map((v) => (v.path === P.reencode ? { ...v, name: RENAMED } : v));
const SIZES = Object.fromEntries(VIDEOS.map((v) => [v.path, { size: v.size }]));

let modal;
let mainCalls;
let origFunsync;
let funsync;

/** The renderer's Stash copy, loaded from a fake main; every Stash call recorded. */
async function loadStash(data, { enabled = true } = {}) {
  mainCalls = [];
  const api = {};
  for (const name of Object.values(STASH_API)) {
    api[name] = vi.fn(async (...args) => {
      mainCalls.push([name, ...args]);
      return name === STASH_API.data ? data : { ok: true };
    });
  }
  api[STASH_API.onChanged] = vi.fn(() => () => {});
  api[STASH_API.onSettingsChanged] = vi.fn(() => () => {});
  api[STASH_API.onProgress] = vi.fn(() => () => {});
  _setStashApiForTests(api);
  dataService._cache.settings.stash = { enabled, syncOnStart: false };
  await initStashStore({ isEnabled: () => true });
  mainCalls.length = 0; // from here on, any call is the modal's
}

async function scan({ sizes = SIZES, stash } = {}) {
  funsync = {
    statVideoFiles: vi.fn(async () => sizes),
    hashVideoFiles: vi.fn(async () => ({})),
    trashVideoFiles: vi.fn(async (paths) => paths.map((p) => ({ path: p, ok: true, size: 1 }))),
  };
  window.funsync = funsync;
  modal = new DuplicatesModal({ getVideos: () => VIDEOS, ...(stash ? { stash } : {}) });
  modal._body = document.createElement('div');
  document.body.appendChild(modal._body);
  await modal._scan();
  return modal;
}

const ticked = () => [...modal._body.querySelectorAll('.duplicates__check')].filter((cb) => cb.checked).map((cb) => cb.dataset.path);
const stashGroups = () => modal._groups.filter((g) => g.tier === TIER.STASH);

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  _resetStashStoreForTests();
  origFunsync = window.funsync;
});

afterEach(() => {
  window.funsync = origFunsync;
  _resetStashStoreForTests();
  delete dataService._cache.settings.stash;
  document.body.innerHTML = '';
});

describe('Find duplicates: "Looks the same (Stash)"', () => {
  it('groups the renamed re-encode with its original, under its own heading and words', async () => {
    await loadStash(snProjection());
    await scan();
    expect(stashGroups()).toHaveLength(1);
    expect(stashGroups()[0].members.map((m) => m.path).sort()).toEqual([P.large, P.reencode].sort());
    const head = modal._body.querySelector('.duplicates__tier-badge--stash');
    expect(head.textContent).toBe('Looks the same (Stash)');
    expect(head.parentElement.querySelector('.duplicates__tier-why').textContent)
      .toBe('Your Stash gives them the same picture fingerprint (phash), probably a re-encode');
    expect(modal._body.querySelector('[data-select-tier="stash"]').textContent.trim())
      .toBe('Select spares that look the same in Stash (1)');
  });

  it('ticks nothing by itself; the keeper cannot be ticked; nothing goes to the Recycle Bin without the confirm', async () => {
    await loadStash(snProjection());
    await scan();
    expect(ticked()).toEqual([]);
    expect(modal._body.querySelector('#dup-remove').disabled).toBe(true);
    const keeper = [...modal._body.querySelectorAll('.duplicates__check')].find((cb) => cb.dataset.path === P.large);
    expect(keeper.disabled).toBe(true);
    modal._body.querySelector('[data-select-tier="stash"]').click();
    expect(ticked()).toEqual([P.reencode]);
    expect(funsync.trashVideoFiles).not.toHaveBeenCalled();
  });

  it('reads only the data already synced: no request to Stash, nothing written', async () => {
    const data = snProjection();
    await loadStash(data);
    const before = JSON.stringify(stashData());
    await scan();
    expect(stashGroups()).toHaveLength(1);
    expect(mainCalls).toEqual([]);
    expect(JSON.stringify(stashData())).toBe(before);
    expect(Object.keys(funsync).filter((k) => funsync[k].mock.calls.length > 0).sort())
      .toEqual(['statVideoFiles']);
  });

  it('Stash off: no such tier (and the data is not read)', async () => {
    await loadStash(snProjection(), { enabled: false });
    await scan();
    expect(stashGroups()).toEqual([]);
    expect(modal._body.querySelector('.duplicates__tier-badge--stash')).toBeNull();
  });

  it('a file changed since its link (its size now differs): its old scene\'s phash does not count', async () => {
    await loadStash(snProjection());
    await scan({ sizes: { ...SIZES, [P.reencode]: { size: 1 } } });
    expect(stashGroups()).toEqual([]);
  });

  it('an older library.json without phashes: no such tier, the rest as before', async () => {
    await loadStash(snProjection({ omitNext: true }));
    await scan();
    expect(stashGroups()).toEqual([]);
  });

  it("Stash's own duplicate sets, when given, group too (none are read from today's data)", async () => {
    await loadStash(snProjection({ scenes: { 2: { phash: null }, 10: { phash: null } } }));
    await scan();
    expect(stashGroups()).toEqual([]);
    await scan({ stash: { enabled: () => true, data: () => stashData(), duplicateSets: () => [['2', '10']] } });
    expect(stashGroups()).toHaveLength(1);
  });
});
