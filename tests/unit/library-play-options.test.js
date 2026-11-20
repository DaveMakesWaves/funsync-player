/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Library, Categories and Playlists build their
 * headers and dialogs as DOM and are clicked like a user would; library.js
 * and settings code branch on `typeof window` (notes/CLAUDE.md "Test
 * environments").
 */
// Playlist play options from the Library and Categories (zaikechi,
// EroScripts #381): Loop, "Give every script an equal turn" and "Prefer
// unwatched", for the Library's Shuffle All and a category's new Play All /
// Shuffle All. One global `library.playOptions`, set from a small options
// button that opens the playlist Advanced dialog's own rows.
//
// The invariants:
//   * All off (the default) reproduces the queues these buttons built before:
//     the Library's Shuffle All and the queue panel's Shuffle
//     (`_shuffleUpcoming`) are pinned against v0.9.2's requests under one
//     seeded random.
//   * With an option on, the order changes the way a playlist's does: the
//     same request through the same `_playAllOrder`.
//   * The two Library shuffle paths read the options the same way.
//
// REAL app.js methods (lifted), the REAL Library / Categories / Playlists,
// seeded Math.random: an order is a fact, not a probability.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import { liftAppClass } from './helpers/app-methods.js';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import {
  shuffle as shuffleArray, balancedShuffle, reshuffleAvoidingRepeat, reshuffleBalancedAvoidingRepeat,
} from '../../renderer/js/shuffle.js';
import { partitionByWatched } from '../../renderer/js/playlist-progress.js';
import { libraryPlayRequest, readLibraryPlayOptions } from '../../renderer/js/library-play-options.js';
import { Library } from '../../renderer/components/library.js';
import { Categories } from '../../renderer/components/categories.js';
import { Playlists } from '../../renderer/components/playlists.js';

// The real toast.js, loaded slowly the first time, as a cold dynamic import
// is (see `played` below): a wait that only works when the import is fast
// fails here every run, not one run in three.
vi.mock('../../renderer/js/toast.js', async (importOriginal) => {
  await new Promise((r) => setTimeout(r, 30));
  return importOriginal();
});

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
afterAll(() => _setBundlesForTests('en', EN, EN));

const P = (n) => `C:\\Lib\\${n}.mp4`;
const NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel'];
const PATHS = NAMES.map(P);
const SHARED = 'C:\\Lib\\Shared.funscript';
// Four videos share one script; the rest have their own.
const scriptOf = (p) => (['Alpha', 'Bravo', 'Charlie', 'Delta'].some((n) => p === P(n))
  ? SHARED : p.replace(/\.mp4$/, '.funscript'));
const VIDEOS = PATHS.map((path) => ({ name: path.split('\\').pop(), path, funscriptPath: scriptOf(path) }));
// Finished in a playlist (the "watched" mark every Prefer unwatched reads).
const WATCHED = new Set([P('Alpha'), P('Echo'), P('Golf')]);

// --- seeded Math.random ---------------------------------------------------
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
function withSeed(seed, fn) {
  const spy = vi.spyOn(Math, 'random').mockImplementation(seeded(seed));
  try { return fn(); } finally { spy.mockRestore(); }
}

// --- app.js, lifted -------------------------------------------------------
// `_editorAllowsReplace` (CB-01's unsaved-edits question) is the real one:
// with no editor here it answers `true` at once, so Play All runs as before.
const Lifted = liftAppClass(['_playAll', '_playAllOrder', '_scriptKeyOf', '_shuffleUpcoming', '_reshuffleQueueForWrap', '_queueWrapOrder', '_wrapOrder', '_editorAllowsReplace'], {
  t: (k) => k,
  shuffleArray,
  balancedShuffle,
  partitionByWatched,
  libraryPlayRequest,
  reshuffleAvoidingRepeat,
  reshuffleBalancedAvoidingRepeat,
});

let store;
function settingsFake() {
  return {
    get: (k) => store[k],
    set: (k, v) => { store[k] = v; },
    getPlaylists: () => [],
    getPlaylist: () => null,
    getCategories: () => [CAT],
    getCategory: () => CAT,
    getVideosByCategory: (id) => (id === CAT.id ? CAT_PATHS.slice() : []),
    unassignCategory: vi.fn(),
  };
}

function makeApp() {
  const app = new Lifted();
  app.settings = settingsFake();
  app._navigateTo = vi.fn();
  app._playQueueItem = vi.fn();
  app._setUpNextContext = vi.fn();
  app._updateQueueUI = vi.fn();
  app._updateQueuePanelState = vi.fn();
  return app;
}
const queuePaths = (app) => app._playQueue.map((v) => v.path);
const isWatched = (p) => WATCHED.has(p);
const resumeMap = () => Object.fromEntries([...WATCHED].map((p) => [p, { finished: true, duration: 600, updatedAt: 1 }]));

function makeLibrary(app) {
  const lib = new Library({
    settings: app.settings,
    onPlayAll: (list, opts) => app._playAll(list, opts),
  });
  lib._filteredVideos = VIDEOS.map((v) => ({ ...v }));
  lib._headerTitle = 'All Videos';
  return lib;
}

const SEEDS = [1, 7, 42, 2026, 99991];

beforeEach(() => {
  document.body.innerHTML = '<div id="library-container"></div><div id="categories-container"></div><div id="playlists-container"></div>';
  store = { 'library.resumePositions': resumeMap() };
  _setBundlesForTests('en', EN, EN);
  window.funsync = {
    filesExist: vi.fn(async (list) => list.map((p) => !p.startsWith('E:'))),
    fileExists: vi.fn(async (p) => !p.startsWith('E:')),
    readFunscript: vi.fn(async () => null),
    generateSingleThumbnail: vi.fn(async () => null),
  };
});
afterEach(() => { delete window.funsync; });

describe('the defaults reproduce today\'s queues (#381)', () => {
  it('the store default is every option off', async () => {
    const { DEFAULTS } = await import('../../electron/store.js');
    expect(DEFAULTS.settings.library.playOptions).toEqual({ loop: false, balanceByScript: false, preferUnwatched: false });
    store['library.playOptions'] = DEFAULTS.settings.library.playOptions;
    expect(readLibraryPlayOptions(settingsFake())).toEqual({ loop: false, balanceByScript: false, preferUnwatched: false });
  });

  it('Library Shuffle All builds exactly the v0.9.2 queue, with no options saved at all', () => {
    for (const seed of SEEDS) {
      const app = makeApp();
      withSeed(seed, () => makeLibrary(app)._shuffleAllVisible());
      const now = { order: queuePaths(app), loop: app._playQueueLoop, balance: app._playQueueBalance };

      // v0.9.2's request, through the same Play All.
      const before = makeApp();
      withSeed(seed, () => before._playAll(VIDEOS.map((v) => ({ ...v })), {
        shuffle: true, loop: false, sourceLabel: 'All Videos', sourceContext: { kind: 'library-shuffle' },
      }));
      expect(now.order, `seed ${seed}`).toEqual(queuePaths(before));
      // ...which was a plain shuffle of everything shown.
      expect(now.order).toEqual(withSeed(seed, () => shuffleArray(PATHS)));
      expect(now.loop).toBe(false);
      expect(now.balance).toBe(false);
    }
  });

  it('the stored all-off map builds the same queue as no map', () => {
    const app = makeApp();
    withSeed(7, () => makeLibrary(app)._shuffleAllVisible());
    const noMap = queuePaths(app);
    store['library.playOptions'] = { loop: false, balanceByScript: false, preferUnwatched: false };
    const app2 = makeApp();
    withSeed(7, () => makeLibrary(app2)._shuffleAllVisible());
    expect(queuePaths(app2)).toEqual(noMap);
  });

  it('the queue panel\'s Shuffle in a library context builds exactly the v0.9.2 queue', () => {
    for (const seed of SEEDS) {
      const app = makeApp();
      app.library = makeLibrary(app);
      app._currentPlayContext = { source: 'library' };
      app._currentVideoPath = P('Charlie');
      expect(withSeed(seed, () => app._shuffleUpcoming())).toBe(true);
      // v0.9.2: the current video first, then shuffleArray(the rest).
      const rest = PATHS.filter((p) => p !== P('Charlie'));
      expect(queuePaths(app), `seed ${seed}`).toEqual([P('Charlie'), ...withSeed(seed, () => shuffleArray(rest))]);
      expect(app._playQueueLoop).toBe(false);
      expect(app._currentPlayContext.loop).toBe(false);
      expect(app._playQueueIndex).toBe(0);
    }
  });
});

describe('with an option on, the order changes the way a playlist\'s does (#381)', () => {
  /** The same request a playlist with these options sends, for comparison. */
  const playlistOrder = (seed, list, opts) => {
    const app = makeApp();
    withSeed(seed, () => app._playAll(list.map((v) => ({ ...v })), { shuffle: true, ...opts, isWatched }));
    return queuePaths(app);
  };

  it('Prefer unwatched: Shuffle All plays every unwatched video before any watched one', () => {
    store['library.playOptions'] = { preferUnwatched: true };
    for (const seed of SEEDS) {
      const app = makeApp();
      withSeed(seed, () => makeLibrary(app)._shuffleAllVisible());
      const order = queuePaths(app);
      const firstWatched = order.findIndex((p) => WATCHED.has(p));
      expect(order.slice(firstWatched).every((p) => WATCHED.has(p)), `seed ${seed}`).toBe(true);
      expect(order).toHaveLength(PATHS.length);
      expect(order).toEqual(playlistOrder(seed, VIDEOS, { preferUnwatched: true }));
    }
  });

  it('Equal turn: videos sharing a script get one slot between them, as in a playlist', () => {
    store['library.playOptions'] = { balanceByScript: true };
    for (const seed of SEEDS) {
      const app = makeApp();
      withSeed(seed, () => makeLibrary(app)._shuffleAllVisible());
      const order = queuePaths(app);
      expect(order.filter((p) => scriptOf(p) === SHARED), `seed ${seed}`).toHaveLength(1);
      expect(order).toHaveLength(PATHS.length - 3);
      expect(order).toEqual(playlistOrder(seed, VIDEOS, { balanceByScript: true }));
      expect(app._playQueueBalance).toBe(true);
    }
  });

  it('Loop: the Shuffle All queue loops', () => {
    store['library.playOptions'] = { loop: true };
    const app = makeApp();
    makeLibrary(app)._shuffleAllVisible();
    expect(app._playQueueLoop).toBe(true);
  });

  it('the queue panel\'s Shuffle reads the same options: unwatched first, and it loops', () => {
    store['library.playOptions'] = { preferUnwatched: true, loop: true };
    for (const seed of SEEDS) {
      const app = makeApp();
      app.library = makeLibrary(app);
      app._currentPlayContext = { source: 'library' };
      app._currentVideoPath = P('Hotel');
      withSeed(seed, () => app._shuffleUpcoming());
      const [current, ...rest] = queuePaths(app);
      expect(current).toBe(P('Hotel'));
      const firstWatched = rest.findIndex((p) => WATCHED.has(p));
      expect(rest.slice(firstWatched).every((p) => WATCHED.has(p)), `seed ${seed}`).toBe(true);
      // The same rule as the header's Shuffle All, applied to the rest.
      const restVideos = VIDEOS.filter((v) => v.path !== P('Hotel'));
      expect(rest).toEqual(playlistOrder(seed, restVideos, { preferUnwatched: true }));
      expect(app._playQueueLoop).toBe(true);
      expect(app._currentPlayContext.loop).toBe(true);
    }
  });

  // Review 2026-11-04: with Equal turn on, the queue panel's Shuffle gave
  // the playing video's script a second slot in the first cycle, and kept
  // only the drawn videos for the Loop redraw.
  const queuePanelShuffle = (seed, current) => {
    const app = makeApp();
    app.library = makeLibrary(app);
    app._currentPlayContext = { source: 'library' };
    app._currentVideoPath = current;
    expect(withSeed(seed, () => app._shuffleUpcoming())).toBe(true);
    return app;
  };

  it('Equal turn, the queue panel\'s Shuffle: the playing video takes its script\'s slot, as a shuffled playlist start does', () => {
    store['library.playOptions'] = { balanceByScript: true };
    for (const seed of SEEDS) {
      const [current, ...rest] = queuePaths(queuePanelShuffle(seed, P('Charlie')));   // Charlie shares SHARED
      expect(current).toBe(P('Charlie'));
      expect(rest.filter((p) => scriptOf(p) === SHARED), `seed ${seed}`).toEqual([]);   // no second turn
      // The rest: Play All's balanced order of every OTHER script.
      const others = VIDEOS.filter((v) => scriptOf(v.path) !== SHARED);
      expect(rest, `seed ${seed}`).toEqual(playlistOrder(seed, others, { balanceByScript: true }));
    }
  });

  it('Equal turn + Loop, the queue panel\'s Shuffle: each wrap can pick a different video for a shared script', () => {
    store['library.playOptions'] = { balanceByScript: true, loop: true };
    let changed = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const app = queuePanelShuffle(seed, P('Hotel'));
      const first = queuePaths(app).find((p) => scriptOf(p) === SHARED);
      app._playQueueIndex = app._playQueue.length - 1;          // the cycle ended
      withSeed(seed + 1000, () => app._reshuffleQueueForWrap());
      const next = queuePaths(app);
      expect(next.filter((p) => scriptOf(p) === SHARED), `seed ${seed}`).toHaveLength(1);   // still one slot
      expect(next).toHaveLength(PATHS.length - 3);
      if (next.find((p) => scriptOf(p) === SHARED) !== first) changed++;
    }
    // Drawn from all four videos that share the script, not only the one
    // the first cycle drew.
    expect(changed).toBeGreaterThan(10);
  });
});

// --- The options button and dialog ---------------------------------------

function showLibraryHeader(app) {
  const lib = makeLibrary(app);
  lib._renderBreadcrumb = () => {};
  lib._buildSortPicker = () => {};
  lib._buildFiltersPicker = () => {};
  lib._renderFilterChips = () => {};
  lib._syncSortForActiveTab = () => {};
  lib._container = document.getElementById('library-container');
  lib._renderWithHeader();
  return lib;
}

const dialogBoxes = () => [...document.querySelectorAll('.modal-panel input[type="checkbox"]')];
const closeDialog = async () => {
  [...document.querySelectorAll('.modal-panel button')].find((b) => b.textContent === EN.common.close)?.click();
  await new Promise((r) => setTimeout(r, 0));
};

describe('the Library options button (#381)', () => {
  it('sits next to Shuffle All, untinted by default, and opens the three options unticked', async () => {
    const app = makeApp();
    showLibraryHeader(app);
    const shuffle = document.querySelector('.library__shuffle-btn');
    const btn = document.querySelector('.library__play-options-btn');
    expect(btn).not.toBeNull();
    expect(shuffle.nextElementSibling).toBe(btn);
    expect(btn.getAttribute('aria-label')).toBe(EN.library.playOptions.openTitle);
    expect(btn.classList.contains('library__play-options-btn--on')).toBe(false);

    btn.click();
    const boxes = dialogBoxes();
    expect(boxes.map((b) => b.dataset.option)).toEqual(['loop', 'balanceByScript', 'preferUnwatched']);
    expect(boxes.every((b) => !b.checked && !b.disabled)).toBe(true);
    // The playlist dialog's own words for the two shared options.
    const labels = [...document.querySelectorAll('.modal-panel .playlists__advanced-label')].map((l) => l.textContent);
    expect(labels).toEqual([EN.library.playOptions.loopLabel, EN.playlists.advanced.balanceLabel, EN.playlists.advanced.unwatchedLabel]);
    await closeDialog();
  });

  it('a tick saves at once, keeps the other two, and tints the button', async () => {
    const app = makeApp();
    showLibraryHeader(app);
    const btn = document.querySelector('.library__play-options-btn');
    btn.click();
    dialogBoxes().find((b) => b.dataset.option === 'loop').click();
    expect(store['library.playOptions']).toEqual({ loop: true, balanceByScript: false, preferUnwatched: false });
    dialogBoxes().find((b) => b.dataset.option === 'preferUnwatched').click();
    expect(store['library.playOptions']).toEqual({ loop: true, balanceByScript: false, preferUnwatched: true });
    expect(btn.classList.contains('library__play-options-btn--on')).toBe(true);
    await closeDialog();

    // And the next Shuffle All uses them.
    makeLibrary(app)._shuffleAllVisible();
    expect(app._playQueueLoop).toBe(true);
  });
});

// --- Categories: Play All / Shuffle All ----------------------------------

const CAT = { id: 'cat-1', name: 'Faves', color: '#e94560' };
const OFFLINE = 'E:\\Away\\Offline.mp4';
const CAT_PATHS = [P('Delta'), P('Alpha'), OFFLINE, P('Golf'), P('Bravo')];

async function openCategory(app) {
  const cats = new Categories({
    settings: app.settings,
    library: null,
    onPlayVideo: vi.fn(),
    onPlayAll: (list, opts) => app._playAll(list, opts),
  });
  cats._container = document.getElementById('categories-container');
  cats._view = 'detail';
  cats._detailCategoryId = CAT.id;
  await cats._renderDetail(CAT.id);
  return cats;
}
// The click handler awaits the availability probe AND a dynamic
// import('../js/toast.js') for the "skipped unavailable" toast before it
// calls onPlayAll. Waiting one setTimeout(0) raced that import: a cold one
// takes longer, `_playQueue` was still unset, and Play All failed 3 runs in 8
// (notes/FLAKY-TESTS.md row 4). So each case waits for the effect itself:
// the queue's first play, or the "none available" toast. The vi.mock at the
// top makes every first import of toast.js slow, so the old one-tick wait
// fails every run instead of sometimes.
const played = (app, times = 1) => vi.waitFor(() => expect(app._playQueueItem).toHaveBeenCalledTimes(times));
const toastShown = (text) => vi.waitFor(() => expect(
  [...document.querySelectorAll('#toast-container .toast__body')].map((el) => el.textContent),
).toContain(text));

describe('Categories: Play All and Shuffle All (#381)', () => {
  beforeEach(() => {
    const host = document.createElement('div');
    host.id = 'toast-container';
    document.body.appendChild(host);
  });

  it('the detail header has Play All, Shuffle All and the options button', async () => {
    await openCategory(makeApp());
    const header = document.querySelector('.categories__header');
    expect(header.querySelector('.categories__play-all-btn').textContent.trim()).toBe(EN.playlists.playAll);
    expect(header.querySelector('.categories__shuffle-all-btn').textContent.trim()).toBe(EN.library.shuffleAll);
    expect(header.querySelector('.categories__play-options-btn').getAttribute('aria-label')).toBe(EN.library.playOptions.openTitle);
  });

  it('Play All plays the category in its order, skipping the offline video without unassigning it', async () => {
    const app = makeApp();
    await openCategory(app);
    document.querySelector('.categories__play-all-btn').click();
    await played(app);
    expect(queuePaths(app)).toEqual([P('Delta'), P('Alpha'), P('Golf'), P('Bravo')]);
    expect(app._playQueueShuffle).toBe(false);
    expect(app._playQueueLoop).toBe(false);
    expect(app._playQueueSource.sourceContext).toEqual({ kind: 'category', id: CAT.id });
    expect(app._playQueueSource.sourceLabel).toBe(CAT.name);
    expect(app.settings.unassignCategory).not.toHaveBeenCalled();
    expect(app._playQueueItem).toHaveBeenCalledWith(0);
  });

  it('Shuffle All plays the reachable videos in a seeded shuffle, like the Library\'s', async () => {
    const reachable = [P('Delta'), P('Alpha'), P('Golf'), P('Bravo')];
    for (const seed of SEEDS) {
      const app = makeApp();
      await openCategory(app);
      const spy = vi.spyOn(Math, 'random').mockImplementation(seeded(seed));
      document.querySelector('.categories__shuffle-all-btn').click();
      // The seed stays in place until the shuffle has really run.
      await played(app);
      spy.mockRestore();
      expect(queuePaths(app), `seed ${seed}`).toEqual(withSeed(seed, () => shuffleArray(reachable)));
      expect(app._playQueueShuffle).toBe(true);
    }
  });

  it('the options apply here too: Loop loops Play All, Prefer unwatched reorders Shuffle All', async () => {
    store['library.playOptions'] = { loop: true, preferUnwatched: true };
    const app = makeApp();
    await openCategory(app);
    document.querySelector('.categories__play-all-btn').click();
    await played(app, 1);
    expect(app._playQueueLoop).toBe(true);
    // Play All keeps the list order: Prefer unwatched is a shuffle option.
    expect(queuePaths(app)).toEqual([P('Delta'), P('Alpha'), P('Golf'), P('Bravo')]);

    document.querySelector('.categories__shuffle-all-btn').click();
    await played(app, 2);
    const order = queuePaths(app);
    const firstWatched = order.findIndex((p) => WATCHED.has(p));
    expect(order.slice(firstWatched).every((p) => WATCHED.has(p))).toBe(true);
    expect(order.slice(0, firstWatched).every((p) => !WATCHED.has(p))).toBe(true);
  });

  it('the category options button edits the same global options and tints when one is on', async () => {
    const app = makeApp();
    await openCategory(app);
    const btn = document.querySelector('.categories__play-options-btn');
    expect(btn.classList.contains('is-on')).toBe(false);
    btn.click();
    dialogBoxes().find((b) => b.dataset.option === 'balanceByScript').click();
    expect(store['library.playOptions']).toEqual({ loop: false, balanceByScript: true, preferUnwatched: false });
    expect(btn.classList.contains('is-on')).toBe(true);
    await closeDialog();
  });

  it('a category with every video offline says so and plays nothing', async () => {
    const app = makeApp();
    app.settings.getVideosByCategory = () => [OFFLINE];
    await openCategory(app);
    document.querySelector('.categories__play-all-btn').click();
    // "Says so" is the handler's last step, so after it nothing can still
    // be on its way to play.
    await toastShown(EN.toast.playlistAllUnavailable);
    expect(app._playQueueItem).not.toHaveBeenCalled();
    expect(app.settings.unassignCategory).not.toHaveBeenCalled();
  });
});

// --- The playlist Advanced dialog, now built by the shared helper ----------

describe('the playlist Advanced dialog is unchanged by the shared helper (#381)', () => {
  function openAdvanced(pl) {
    const settings = {
      ...settingsFake(),
      setPlaylistBalance: vi.fn(),
      setPlaylistPreferUnwatched: vi.fn(),
    };
    const playlists = new Playlists({ settings, library: null, onPlayVideo: vi.fn(), onPlayAll: vi.fn() });
    playlists._openAdvancedSettings(pl);
    return settings;
  }

  it('two options, no Loop row (a playlist has its own Loop button), disabled with Shuffle off', async () => {
    openAdvanced({ id: 'p1', shuffle: false, balanceByScript: true, preferUnwatched: false });
    const boxes = dialogBoxes();
    expect(boxes.map((b) => b.dataset.option)).toEqual(['balanceByScript', 'preferUnwatched']);
    expect(boxes.map((b) => b.checked)).toEqual([true, false]);
    expect(boxes.every((b) => b.disabled)).toBe(true);
    expect(document.querySelector('.modal-panel .playlists__advanced-note').textContent)
      .toBe(EN.playlists.advanced.balanceNeedsShuffleOff);
    expect(document.querySelector('.modal-panel .modal-title').textContent).toBe(EN.playlists.advanced.title);
    await closeDialog();
  });

  it('with Shuffle on, a tick saves to THAT playlist, not the global options', async () => {
    const pl = { id: 'p1', shuffle: true, balanceByScript: false, preferUnwatched: false };
    const settings = openAdvanced(pl);
    dialogBoxes().find((b) => b.dataset.option === 'balanceByScript').click();
    dialogBoxes().find((b) => b.dataset.option === 'preferUnwatched').click();
    expect(settings.setPlaylistBalance).toHaveBeenCalledWith('p1', true);
    expect(settings.setPlaylistPreferUnwatched).toHaveBeenCalledWith('p1', true);
    expect(pl).toMatchObject({ balanceByScript: true, preferUnwatched: true });
    expect(store['library.playOptions']).toBeUndefined();
    expect(document.querySelector('.modal-panel .playlists__advanced-note').textContent)
      .toBe(EN.playlists.advanced.balanceNeedsShuffleOn);
    await closeDialog();
  });
});
