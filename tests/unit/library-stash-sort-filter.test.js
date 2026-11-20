/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Library renders its header, Sort and Filters
 * pickers, chip strip and cards into a DOM; i18n.js branches on `typeof
 * window` (notes/CLAUDE.md "Test environments").
 */
// Stash's sorts and filter in the library (Stash "next" lot, stage
// sn-library, 2026-11-19; DESIGN-stash-s1.md (j) #3, #10). The REAL Library
// over the REAL DataService and the REAL stash-store.js, with a fake main
// answering the projection of the seeded test Stash's scenes
// (tests/helpers/stash-next-fixtures.js). Asserted: what the user sees in
// the pickers, the chips and the grid; Stash off shows none of it; the
// filter is not remembered; nothing is asked of Stash.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import { DataService } from '../../renderer/js/data-service.js';
import { Library } from '../../renderer/components/library.js';
import * as tagFilter from '../../renderer/js/library-tag-filter.js';
import { compareVideoNames } from '../../renderer/js/library-search.js';
import {
  STASH_API, initStashStore, _resetStashStoreForTests, _setStashApiForTests,
} from '../../renderer/js/stash-store.js';
import { bundleWith } from '../helpers/stash-dialog-fixtures.js';
import {
  LIB, SERVER, P, NEXT_STRINGS, snProjection, snVideos,
} from '../helpers/stash-next-fixtures.js';

const EN = bundleWith(JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8')), NEXT_STRINGS);

/** The fake main: answers the projection; every Stash call recorded. */
function fakeMain(data) {
  const main = { calls: [], data, changed: null };
  const api = {};
  for (const name of Object.values(STASH_API)) {
    api[name] = vi.fn(async (...args) => {
      main.calls.push([name, ...args]);
      if (name === STASH_API.data) return main.data;
      return { ok: true, undoId: `undo-${main.calls.length}` };
    });
  }
  api[STASH_API.onChanged] = vi.fn((cb) => { main.changed = cb; return () => {}; });
  api[STASH_API.onSettingsChanged] = vi.fn(() => () => {});
  api[STASH_API.onProgress] = vi.fn(() => () => {});
  _setStashApiForTests(api);
  return main;
}

function dataService({ enabled = true } = {}) {
  const ds = new DataService();
  ds._cache.settings = {
    backend: { port: 5123 },
    player: {},
    library: {
      viewMode: 'grid',
      sources: [{ id: 's1', name: 'Lib', path: LIB, enabled: true }],
      associations: {}, subtitleAssociations: {},
      userTags: {}, hiddenTags: {}, scriptTags: {},
      tagSettings: { aliases: {}, hidden: [], facetOverrides: {} },
    },
    stash: { enabled, url: SERVER, syncOnStart: false, pathRules: [] },
  };
  ds._cache.categories = [];
  ds._cache.videoCategories = {};
  ds._initialized = true;
  return ds;
}

let main;
let lib;
let ds;
let container;

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const flush = () => new Promise((r) => setTimeout(r, 0));
const shown = () => [...container.querySelectorAll('.library__grid [data-video-path]')].map((el) => el.dataset.videoPath);
const sortPop = () => container.querySelector('#library-sort-pop');
const sortLabel = () => container.querySelector('#library-sort-btn .library__picker-label').textContent;
const stashSortRows = () => [...sortPop().querySelectorAll('.library__picker-item[data-stash="true"]')];
const filtersPop = () => container.querySelector('#library-filters-pop');
const stashSection = () => filtersPop().querySelector('.library__picker-section--stash');
const ratingRadio = (n) => stashSection().querySelector(`input[name="library-filter-stash-rating"][value="${n}"]`);
const organisedBox = () => stashSection().querySelector('input[data-filter-key="stash-organized"]');
const chips = () => [...container.querySelectorAll('#library-chips .filter-chip')];
const chip = (key) => chips().find((c) => c.dataset.filterKey === key);
const badge = () => container.querySelector('#library-filters-badge');
const byName = (paths) => [...paths].sort((a, b) => compareVideoNames({ path: a, name: a.split('\\').pop() }, { path: b, name: b.split('\\').pop() }));
const ALL = snVideos().map((v) => v.path);
const UNRATED = [P.reencode, P.edge65535, P.edge65536, P.edge65543, P.edge131079];
/** Stash calls other than reading main's file (a request to Stash would be one of these). */
const stashRequests = () => main.calls.filter(([n]) => ![STASH_API.data, STASH_API.onChanged, STASH_API.onSettingsChanged, STASH_API.onProgress].includes(n));

async function boot({ enabled = true, data = snProjection(), videos = snVideos() } = {}) {
  main = fakeMain(data);
  ds = dataService({ enabled });
  await initStashStore({ isEnabled: () => ds.get('stash.enabled') === true });
  window.funsync.scanDirectory = vi.fn(async () => ({
    videos, unmatchedFunscripts: [], allFunscripts: [], failedPaths: [], skippedPaths: [],
  }));
  lib = new Library({ settings: ds });
  lib._queueThumbnail = () => {};
  lib._validateAssociationsInBackground = () => {};
  lib._validateManualVariantsInBackground = () => {};
  lib._precomputeSpeedStatsInBackground = async () => {};
  lib._precomputeDurationsInBackground = async () => {};
  lib._activeTab = 'all';
  container = document.createElement('div');
  document.body.appendChild(container);
  await lib.show(container);
  const wrapper = container.querySelector('.library__grid-wrapper');
  Object.defineProperty(wrapper, 'clientHeight', { value: 900, configurable: true });
  Object.defineProperty(wrapper, 'clientWidth', { value: 1700, configurable: true });
  await settle();
  return lib;
}

function pickSort(field) {
  const radio = sortPop().querySelector(`input[name="library-sort"][value="${field}"]`);
  expect(radio, `no sort row ${field}`).toBeTruthy();
  radio.click();
}

function choose(input) {
  expect(input).toBeTruthy();
  if (input.type === 'radio') input.checked = true;
  else input.checked = !input.checked;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  _resetStashStoreForTests();
  document.body.innerHTML = '<div id="toast-container"></div>';
  vi.stubGlobal('requestAnimationFrame', (cb) => { cb(0); return 0; });
  globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  const known = {
    setSetting: vi.fn(),
    readFunscript: vi.fn(async () => null),
    filesExist: vi.fn(async (list) => list.map(() => true)),
    fileExists: vi.fn(async () => true),
    assignCategory: vi.fn(),
    unassignCategory: vi.fn(),
  };
  window.funsync = new Proxy(known, { get: (o, k) => (k in o ? o[k] : vi.fn(async () => null)), set: (o, k, v) => { o[k] = v; return true; } });
});

afterEach(() => {
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
  _resetStashStoreForTests();
  delete window.funsync;
});

describe('Stash off: the library is exactly as before', () => {
  it('no Stash sort rows, a hidden Stash section, no chips, and main is not even asked for the data', async () => {
    await boot({ enabled: false });
    expect(sortPop().querySelectorAll('.library__picker-item')).toHaveLength(5);
    expect(stashSortRows()).toEqual([]);
    expect(stashSection().hidden).toBe(true);
    expect(chips()).toEqual([]);
    expect(main.calls.filter(([n]) => n === STASH_API.data)).toEqual([]);
    expect(shown()).toEqual(byName(ALL));
  });
});

describe('Sort by Stash rating / Stash last played', () => {
  it('two rows after the five, worded with their direction', async () => {
    await boot();
    const rows = stashSortRows();
    expect(rows.map((r) => r.dataset.value)).toEqual(['stashRating', 'stashLastPlayed']);
    expect(rows.map((r) => r.querySelector('.library__picker-item-label').textContent))
      .toEqual(['Stash Rating High-Low', 'Recently Played in Stash']);
    expect(sortPop().querySelectorAll('.library__picker-item')).toHaveLength(7);
  });

  it('Stash Rating High-Low orders the grid; flipping it keeps the unrated last', async () => {
    await boot();
    pickSort('stashRating');
    expect(sortLabel()).toBe('Stash Rating High-Low');
    expect(shown()).toEqual([P.large, ...byName([P.small, P.edge131072]), P.mid, P.tiny, ...byName(UNRATED)]);
    pickSort('stashRating'); // the selected row again flips it
    expect(sortLabel()).toBe('Stash Rating Low-High');
    expect(shown()).toEqual([P.tiny, P.mid, ...byName([P.small, P.edge131072]), P.large, ...byName(UNRATED)]);
  });

  it('Recently Played in Stash: the three played scenes newest first, the never played after them', async () => {
    await boot();
    pickSort('stashLastPlayed');
    const out = shown();
    expect(out.slice(0, 3)).toEqual([P.large, P.mid, P.small]);
    expect(out.slice(3)).toEqual(byName(ALL.filter((p) => ![P.large, P.mid, P.small].includes(p))));
  });

  it('a Stash change (a sync) re-sorts the grid on its own', async () => {
    await boot();
    pickSort('stashRating');
    expect(shown()[0]).toBe(P.large);
    main.data = snProjection({ rev: 2, scenes: { 4: { rating100: 100 } } });
    main.changed({ rev: 2 });
    await settle();
    await flush();
    // Two 100s now: A-Z between them.
    expect(shown().slice(0, 2)).toEqual(byName([P.large, P.tiny]));
  });

  it('turning Stash off puts a Stash sort back to Name A-Z and takes its rows away', async () => {
    await boot();
    pickSort('stashRating');
    ds.set('stash.enabled', false);
    await flush();
    expect(stashSortRows()).toEqual([]);
    expect(sortLabel()).toBe('Name A-Z');
    expect(shown()).toEqual(byName(ALL));
    ds.set('stash.enabled', true);
    await flush();
    expect(stashSortRows()).toHaveLength(2);
    expect(sortLabel()).toBe('Name A-Z');
  });
});

describe('Filters: "Rated N stars or more" and "Organised in Stash"', () => {
  it('the section: Any rating, 1 to 5 stars, and the organised box', async () => {
    await boot();
    expect(stashSection().hidden).toBe(false);
    expect(stashSection().querySelector('.library__picker-section-title').textContent).toBe('Stash');
    const labels = [...stashSection().querySelectorAll('.library__picker-options label')].map((l) => l.textContent);
    expect(labels).toEqual(['Any rating', 'Rated 1 star or more', 'Rated 2 stars or more', 'Rated 3 stars or more', 'Rated 4 stars or more', 'Rated 5 stars or more']);
    expect(ratingRadio(0).checked).toBe(true);
    expect(organisedBox().closest('label').textContent).toBe('Organised in Stash');
  });

  it('4 stars or more: a chip, the badge, and only the linked videos rated 80 or 100', async () => {
    await boot();
    choose(ratingRadio(4));
    expect(chip('stash-rating').textContent).toBe('Stash: 4 stars or more');
    expect(badge().hidden).toBe(false);
    expect(badge().textContent).toBe('1');
    expect(shown()).toEqual(byName([P.large, P.small, P.edge131072]));
  });

  it('organised: its own chip; with 3 stars both must hold', async () => {
    await boot();
    choose(organisedBox());
    expect(chip('stash-organized').textContent).toBe('Organised in Stash');
    expect(shown()).toEqual(byName([P.large, P.tiny, P.small]));
    choose(ratingRadio(3));
    expect(shown()).toEqual(byName([P.large, P.small]));
    expect(badge().textContent).toBe('2');
  });

  it("a chip's × takes that one value off and the picker follows", async () => {
    await boot();
    choose(organisedBox());
    choose(ratingRadio(4));
    chip('stash-rating').click();
    expect(chip('stash-rating')).toBeUndefined();
    expect(ratingRadio(0).checked).toBe(true);
    expect(shown()).toEqual(byName([P.large, P.tiny, P.small]));
    chip('stash-organized').click();
    expect(organisedBox().checked).toBe(false);
    expect(chips()).toEqual([]);
    expect(shown()).toEqual(byName(ALL));
  });

  it('an unlinked video never passes, whatever its scene says', async () => {
    await boot({ data: snProjection({ unlinked: [P.large] }) });
    choose(ratingRadio(5));
    expect(shown()).toEqual([]);
  });

  it('a swapped file (its size differs from the link) shows none of the old scene\'s rating', async () => {
    const videos = snVideos().map((v) => (v.path === P.large ? { ...v, size: v.size + 1 } : v));
    await boot({ videos });
    choose(ratingRadio(5));
    expect(shown()).toEqual([]);
  });

  it('not remembered: nothing is written, a new library starts without it', async () => {
    await boot();
    const writes = window.funsync.setSetting.mock.calls.length;
    choose(ratingRadio(4));
    choose(organisedBox());
    expect(window.funsync.setSetting.mock.calls.length).toBe(writes);
    expect(JSON.stringify(ds._cache.settings)).not.toMatch(/minStars|stash-rating|stash-organized/);
    container.remove();
    lib = new Library({ settings: ds });
    lib._queueThumbnail = () => {};
    lib._validateAssociationsInBackground = () => {};
    lib._validateManualVariantsInBackground = () => {};
    lib._precomputeSpeedStatsInBackground = async () => {};
    lib._precomputeDurationsInBackground = async () => {};
    lib._activeTab = 'all';
    container = document.createElement('div');
    document.body.appendChild(container);
    await lib.show(container);
    await settle();
    expect(chips()).toEqual([]);
    expect(ratingRadio(0).checked).toBe(true);
    expect(organisedBox().checked).toBe(false);
  });

  it('Clear filters clears it too', async () => {
    await boot();
    choose(ratingRadio(5));
    lib._clearAllFilters();
    expect(chips()).toEqual([]);
    expect(ratingRadio(0).checked).toBe(true);
    expect(shown()).toEqual(byName(ALL));
  });

  it('turning Stash off drops the filter (and its chips) at once; on again does not bring it back', async () => {
    await boot();
    choose(ratingRadio(5));
    choose(organisedBox());
    expect(shown()).toEqual([P.large]);
    ds.set('stash.enabled', false);
    await flush();
    expect(stashSection().hidden).toBe(true);
    expect(chips()).toEqual([]);
    expect(badge().hidden).toBe(true);
    expect(shown()).toEqual(byName(ALL));
    ds.set('stash.enabled', true);
    await flush();
    expect(stashSection().hidden).toBe(false);
    expect(ratingRadio(0).checked).toBe(true);
    expect(organisedBox().checked).toBe(false);
    expect(shown()).toEqual(byName(ALL));
  });

  it('sorting and filtering ask Stash nothing (the data FunSync already synced)', async () => {
    await boot();
    pickSort('stashLastPlayed');
    choose(ratingRadio(2));
    choose(organisedBox());
    main.data = snProjection({ rev: 2 });
    main.changed({ rev: 2 });
    await settle();
    await flush();
    expect(stashRequests()).toEqual([]);
  });
});

describe('the Tags filter: "includes N sub-tags" (sn-tags\' opt-in, shown by the library)', () => {
  it('a row with sub-tags shows the note as text; a row without shows none', async () => {
    await boot();
    const idx = lib._tagIndexMemo();
    const realGet = idx.get.bind(idx);
    const parent = { key: 'content:synthetic-parent-tag', facet: 'content', label: 'Synthetic Parent Tag', count: 2, subTags: 2 };
    const plain = { key: 'content:synthetic-tag-a', facet: 'content', label: 'Synthetic Tag A', count: 1, subTags: 0 };
    idx.get = () => {
      const r = realGet();
      const counts = new Map(r.counts);
      counts.set(parent.key, parent);
      counts.set(plain.key, plain);
      return { ...r, counts };
    };
    container.querySelector('#library-filters-btn').click();
    const row = (key) => filtersPop().querySelector(`input[data-filter-key="tag:${key}"]`).closest('label');
    const note = row(parent.key).querySelector('.library__tag-option-subtags');
    expect(typeof tagFilter.subTagNoteText).toBe('function');
    const want = tagFilter.subTagNoteText(parent, t);
    expect(want).toBeTruthy();
    expect(note?.textContent).toBe(want);
    expect(row(plain.key).querySelector('.library__tag-option-subtags')).toBeNull();
  });
});
