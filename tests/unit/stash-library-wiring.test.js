/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Library renders its header, Filters picker, chip
 * strip and cards into a DOM; i18n.js branches on `typeof window`
 * (notes/CLAUDE.md "Test environments").
 */
// The Stash link's library side (Stash S1, Round 2 stage 2d;
// DESIGN-stash-s1.md (c) "The renderer's copy and the stash tag source",
// "Re-home on move", (f) "The Tags filter", "The video options dialog").
// The REAL Library over the REAL DataService and the REAL stash-store.js,
// with a fake main behind `window.funsync`'s Stash calls. Asserted: what the
// user sees in the Filters picker and the grid, what main is asked, and the
// dialog's `host.stash` replies.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { DataService } from '../../renderer/js/data-service.js';
import { Library } from '../../renderer/components/library.js';
import {
  STASH_API, initStashStore, _resetStashStoreForTests, _setStashApiForTests,
} from '../../renderer/js/stash-store.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));

const SERVER = 'http://127.0.0.1:9999';
const LIB = 'C:\\Lib';
const ALPHA = `${LIB}\\Alpha Scene.mp4`;
const BRAVO = `${LIB}\\Bravo Take.mp4`;
const CHARLIE = `${LIB}\\Charlie Cut.mp4`;

const link = (sceneId, size = 1000) => ({
  sceneId, server: SERVER, by: 'oshash', fp: { size, mtimeMs: 5, oshash: `hash-${sceneId}` }, linkedAt: 2, state: 'ok',
});

function projection(rev, links = { [ALPHA]: link('1') }, extra = {}) {
  return {
    v: 1, rev, server: { url: SERVER, version: 'v0.32.0' }, lastSync: { at: 1, kind: 'full', ok: true },
    links, check: {}, refused: {},
    scenes: {
      1: { id: '1', title: 'Synthetic Scene Small', tagIds: ['5'], performerIds: ['3'], studioId: '2', markers: [], files: [] },
      4: { id: '4', title: 'Another Scene', tagIds: ['6'], performerIds: [], markers: [], files: [] },
    },
    performers: { 3: { id: '3', name: 'Synthetic Performer', disambiguation: '', stashIds: [] } },
    studios: { 2: { id: '2', name: 'Synthetic Studio', stashIds: [] } },
    tags: { 5: { id: '5', name: 'Synthetic Tag A' }, 6: { id: '6', name: 'Synthetic Tag B' } },
    ...extra,
  };
}

/** The fake main: the Stash calls, recorded with their arguments. */
function fakeMain(data, replies = {}) {
  const main = { calls: [], data, changed: null };
  const api = {};
  for (const name of Object.values(STASH_API)) {
    api[name] = vi.fn(async (...args) => {
      main.calls.push([name, ...args]);
      if (name === STASH_API.data) return main.data;
      if (name in replies) return typeof replies[name] === 'function' ? replies[name](...args) : replies[name];
      return { ok: true, undoId: `undo-${main.calls.length}` };
    });
  }
  api[STASH_API.onChanged] = vi.fn((cb) => { main.changed = cb; return () => {}; });
  api[STASH_API.onSettingsChanged] = vi.fn(() => () => {});
  api[STASH_API.onProgress] = vi.fn(() => () => {});
  _setStashApiForTests(api);
  return main;
}

const sent = (main, name) => main.calls.filter(([n]) => n === name).map(([, ...args]) => args);

function dataService({ enabled = true, library = {} } = {}) {
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
      ...library,
    },
    stash: { enabled, url: SERVER, syncOnStart: false, pathRules: [] },
  };
  ds._cache.categories = [];
  ds._cache.videoCategories = {};
  ds._initialized = true;
  return ds;
}

const video = (path, size = 1000) => ({
  name: path.split('\\').pop(), path, size, dateAdded: 5, hasFunscript: false, funscriptPath: null,
  hasSubtitle: false, subtitlePath: null, variants: [],
});

let main;
let lib;
let ds;
let container;

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const flush = () => new Promise((r) => setTimeout(r, 0));
const shown = () => [...container.querySelectorAll('.library__grid [data-video-path]')].map((el) => el.dataset.videoPath);
const pop = () => container.querySelector('#library-filters-pop');
const tagsSection = () => pop().querySelector('.library__picker-section--tags');
const box = (key) => tagsSection().querySelector(`input[type="checkbox"][data-filter-key="${key}"]`);
const chip = (key) => [...container.querySelectorAll('#library-chips .filter-chip')].find((c) => c.dataset.filterKey === key);

async function boot({ enabled = true, data = projection(1) } = {}) {
  main = fakeMain(data);
  ds = dataService({ enabled });
  await initStashStore({ isEnabled: () => ds.get('stash.enabled') === true });
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

function openFilters() {
  const btn = container.querySelector('#library-filters-btn');
  if (pop().hidden) btn.click();
  expect(pop().hidden).toBe(false);
}

function tick(key) {
  const b = box(key);
  expect(b, `no row ${key}`).toBeTruthy();
  b.checked = true;
  b.dispatchEvent(new Event('change', { bubbles: true }));
}

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  _resetStashStoreForTests();
  document.body.innerHTML = '<div id="toast-container"></div>';
  vi.stubGlobal('requestAnimationFrame', (cb) => { cb(0); return 0; });
  globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  const known = {
    setSetting: vi.fn(),
    scanDirectory: vi.fn(async () => ({
      videos: [video(ALPHA), video(BRAVO), video(CHARLIE)],
      unmatchedFunscripts: [], allFunscripts: [], failedPaths: [], skippedPaths: [],
    })),
    readFunscript: vi.fn(async () => null),
    filesExist: vi.fn(async (list) => list.map(() => true)),
    fileExists: vi.fn(async () => true),
    assignCategory: vi.fn(),
    unassignCategory: vi.fn(),
  };
  window.funsync = new Proxy(known, { get: (o, k) => (k in o ? o[k] : vi.fn(async () => null)) });
});

afterEach(() => {
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
  _resetStashStoreForTests();
  delete window.funsync;
});

describe('"Tags from: Stash" in the Tags filter', () => {
  it('reads "Stash" (not the raw id), and filters to the videos with a Stash tag', async () => {
    await boot();
    openFilters();
    const row = box('source:stash').closest('label');
    expect(row.textContent).toContain('Stash');
    expect(row.textContent).not.toContain('stash');
    tick('source:stash');
    expect(shown()).toEqual([ALPHA]);
    expect(chip('source:stash').textContent).toBe('Tags from: Stash');
  });

  it('a Stash change (a sync linked another video) re-filters the grid', async () => {
    await boot();
    openFilters();
    tick('source:stash');
    expect(shown()).toEqual([ALPHA]);
    main.data = projection(2, { [ALPHA]: link('1'), [CHARLIE]: link('4') });
    main.changed({ rev: 2 });
    await settle();
    await flush();
    expect(shown().sort()).toEqual([ALPHA, CHARLIE].sort());
  });

  it('turning Stash off takes its tags out of the filter at once', async () => {
    await boot();
    openFilters();
    tick('source:stash');
    expect(shown()).toEqual([ALPHA]);
    ds.set('stash.enabled', false);
    await flush();
    expect(shown()).toEqual([]);
  });

  it('Stash off from the start: no "Tags from: Stash" row at all', async () => {
    await boot({ enabled: false });
    openFilters();
    expect(box('source:stash')).toBeNull();
    expect(sent(main, STASH_API.data)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Re-home on move: the Stash link moves with the video's other tag data, in
// one plan, and main is told once.
// ---------------------------------------------------------------------------

/** A real Library at the end of a scan, without its constructor (as rehome-tag-maps.test.js). */
function scan(settings, { videos, scannedRoots = [], unavailable = [] }) {
  const l = Object.create(Library.prototype);
  l._settings = settings;
  l._videos = videos.map((p) => ({ path: p, name: p.split(/[\\/]/).pop() }));
  l._unavailablePaths = new Set(unavailable);
  l._failedScanPaths = new Set();
  l._skippedScanPaths = new Set();
  l._scannedSourceRoots = scannedRoots;
  l._allFunscripts = [];
  l._applyManualAssociations();
  return l;
}

const OLD = 'C:\\Lib\\Zulu Last.mp4';
const NEW = 'C:\\Lib\\sub\\Zulu Last.mp4';

describe('re-home on move: the Stash link moves with the video\'s tag data', () => {
  async function loaded(links, extra) {
    main = fakeMain(projection(1, links, extra));
    await initStashStore({ isEnabled: () => true });
  }

  it('a moved video\'s link goes to main as ONE move, with its tags moved in the same plan', async () => {
    await loaded({ [OLD]: link('1') });
    const settings = dataService({ library: { userTags: { [OLD]: ['pov'] } } });
    scan(settings, { videos: [NEW], scannedRoots: ['C:\\Lib'] });
    expect(sent(main, STASH_API.rehome)).toEqual([[[{ from: OLD, to: NEW, keepSource: false }]]]);
    expect(settings.get('library.userTags')).toEqual({ [NEW]: ['pov'] });
  });

  it('a video with only Stash data (a link, a check or a refusal) moves too', async () => {
    await loaded({}, {
      check: { [OLD]: { kind: 'several', sceneIds: ['1', '4'] } },
      refused: { 'C:\\Lib\\Yankee.mp4': { oshash: 'x', sceneIds: ['4'], at: 1 } },
    });
    scan(dataService(), { videos: [NEW, 'C:\\Lib\\sub\\Yankee.mp4'], scannedRoots: ['C:\\Lib'] });
    const [moves] = sent(main, STASH_API.rehome)[0];
    expect(moves.sort((a, b) => a.from.localeCompare(b.from))).toEqual([
      { from: 'C:\\Lib\\Yankee.mp4', to: 'C:\\Lib\\sub\\Yankee.mp4', keepSource: false },
      { from: OLD, to: NEW, keepSource: false },
    ]);
  });

  it('absence without proof: the move keeps the old entry (keepSource), as the tags do', async () => {
    const GONE = 'F:\\Removed\\Zulu Last.mp4';
    await loaded({ [GONE]: link('1') });
    scan(dataService(), { videos: [NEW], scannedRoots: ['C:\\Lib'] });
    expect(sent(main, STASH_API.rehome)).toEqual([[[{ from: GONE, to: NEW, keepSource: true }]]]);
  });

  it('two old videos of that name: nothing moves (never two videos\' data on one)', async () => {
    await loaded({ [OLD]: link('1'), 'C:\\Lib\\old\\Zulu Last.mp4': link('4') });
    scan(dataService(), { videos: [NEW], scannedRoots: ['C:\\Lib'] });
    expect(sent(main, STASH_API.rehome)).toEqual([]);
  });

  it('a destination that has Stash data of its own keeps it: no move onto it', async () => {
    await loaded({ [NEW]: link('4') });
    const settings = dataService({ library: { userTags: { [OLD]: ['pov'] } } });
    scan(settings, { videos: [NEW], scannedRoots: ['C:\\Lib'] });
    expect(sent(main, STASH_API.rehome)).toEqual([]);
    expect(settings.get('library.userTags')).toEqual({ [OLD]: ['pov'] });
  });

  it('a move that touches no Stash data asks main nothing', async () => {
    await loaded({});
    scan(dataService({ library: { userTags: { [OLD]: ['pov'] } } }), { videos: [NEW], scannedRoots: ['C:\\Lib'] });
    expect(sent(main, STASH_API.rehome)).toEqual([]);
  });

  it('an offline source\'s video never moves', async () => {
    const OFF = 'E:\\VR\\Zulu Last.mp4';
    await loaded({ [OFF]: link('1') });
    scan(dataService(), { videos: ['C:\\Downloads\\Zulu Last.mp4'], scannedRoots: ['C:\\Downloads'], unavailable: ['E:\\VR'] });
    expect(sent(main, STASH_API.rehome)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// host.stash: what the video options dialog uses.
// ---------------------------------------------------------------------------

describe('the dialog\'s host.stash', () => {
  it('view(): the video\'s view model while Stash is on, null when off', async () => {
    await boot();
    const host = lib._videoOptionsHost().stash;
    expect(host.enabled()).toBe(true);
    const view = host.view(ALPHA);
    expect(view.state).toBe('linked');
    expect(view.scene.title).toBe('Synthetic Scene Small');
    expect(view.counts).toEqual({ tags: 1, performers: 1, studio: 1 });
    ds.set('stash.enabled', false);
    expect(host.enabled()).toBe(false);
    expect(host.view(ALPHA)).toBeNull();
  });

  it('view(): the trust check reads the scanned size (a swapped file shows its data hidden)', async () => {
    await boot({ data: projection(1, { [ALPHA]: link('1', 999) }) });
    const view = lib._videoOptionsHost().stash.view(ALPHA);
    expect(view.state).toBe('changed');
    expect(view.hidden).toBe(true);
  });

  it('each change goes to main as main expects it, and answers its undoId and the new view', async () => {
    await boot();
    const host = lib._videoOptionsHost().stash;
    main.data = projection(2, {}, { refused: { [ALPHA]: { oshash: 'hash-1', sceneIds: ['1'], at: 3 } } });
    const refused = await host.refuse(ALPHA, 'link');
    expect(sent(main, STASH_API.refuse)).toEqual([[{ path: ALPHA, target: 'link' }]]);
    expect(refused.ok).toBe(true);
    expect(typeof refused.undoId).toBe('string');
    expect(refused.view.state).toBe('refused');

    main.data = projection(3);
    const undone = await host.undo(ALPHA, refused.undoId);
    expect(sent(main, STASH_API.undo)).toEqual([[refused.undoId]]);
    expect(undone.view.state).toBe('linked');

    await host.choose(ALPHA, '4');
    await host.unlink(ALPHA);
    await host.link(ALPHA, '4');
    await host.syncVideo(ALPHA);
    await host.openInStash(ALPHA, '1');
    await host.search('synthetic');
    expect(sent(main, STASH_API.choose)).toEqual([[{ path: ALPHA, sceneId: '4' }]]);
    expect(sent(main, STASH_API.unlink)).toEqual([[{ path: ALPHA }]]);
    expect(sent(main, STASH_API.linkScene)).toEqual([[{ path: ALPHA, sceneId: '4' }]]);
    expect(sent(main, STASH_API.syncVideo)).toEqual([[{ path: ALPHA, size: 1000, mtimeMs: 5 }]]);
    expect(sent(main, STASH_API.openScene)).toEqual([[{ path: ALPHA, sceneId: '1' }]]);
    expect(sent(main, STASH_API.search)).toEqual([[{ q: 'synthetic' }]]);
  });

  it('Not this scene… and Unlink carry the scene the dialog named, as given (Stash fix-up, RA-S1-3)', async () => {
    await boot();
    const host = lib._videoOptionsHost().stash;
    await host.refuse(ALPHA, 'link', '1');
    await host.refuse(ALPHA, 'check');
    await host.unlink(ALPHA, `1@${SERVER}`);
    expect(sent(main, STASH_API.refuse)).toEqual([[{ path: ALPHA, target: 'link', sceneId: '1' }], [{ path: ALPHA, target: 'check' }]]);
    expect(sent(main, STASH_API.unlink)).toEqual([[{ path: ALPHA, sceneId: `1@${SERVER}` }]]);
  });

  it('a refused change leaves the view as it was (nothing cleared)', async () => {
    main = fakeMain(projection(1), { [STASH_API.unlink]: { ok: false, code: 'damaged' } });
    ds = dataService();
    await initStashStore({ isEnabled: () => true });
    lib = Object.create(Library.prototype);
    lib._settings = ds;
    lib._videosByPath = new Map([[ALPHA, video(ALPHA)]]);
    lib._videos = [video(ALPHA)];
    lib.getVideoByPath = (p) => lib._videosByPath.get(p) || null;
    const reply = await lib._stashHost().unlink(ALPHA);
    expect(reply.ok).toBe(false);
    expect(reply.code).toBe('damaged');
    expect(reply.view.state).toBe('linked');
  });

  it('opening the dialog\'s Stash view sends main nothing (never on its own)', async () => {
    await boot();
    const before = main.calls.length;
    const host = lib._videoOptionsHost().stash;
    host.view(ALPHA);
    host.view(BRAVO);
    host.data();
    host.version();
    expect(main.calls.length).toBe(before);
  });
});
