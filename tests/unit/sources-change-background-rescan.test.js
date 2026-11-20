/**
 * @vitest-environment jsdom
 * jsdom on purpose: library.js imports modules that branch on
 * `typeof window` (i18n.js, heatmap-strip.js). See notes/CLAUDE.md
 * "Test environments".
 */
// CB-26 (2026-11-05, found verifying block B; also in v0.9.2): a source
// removed or switched off from Settings while the Playlists or Categories
// view was open was not rescanned. app.js `onSourcesChanged` rescanned only
// when the Library view was the one open, so the library's list, and the
// phone's and HereSphere's (the backend registry, which only a scan
// refreshes), kept the removed source's videos until the Library view
// opened again.
//
// What runs is REAL: the `onSourcesChanged` the app hands SettingsPanel
// (lifted with liftCtorOptions) and `_rescanLibraryInBackground`, the REAL
// Library's ensureScanned, association pass and backend registration, and
// the REAL DataService. The disk is a fake folder listing, the backend a fake
// that records what /api/media/register is sent. Asserted: what the library
// holds, what the phone and VR are sent, that no hidden view was rendered,
// and that nothing stored for the removed source's videos was pruned.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { liftAppClass, liftCtorOptions } from './helpers/app-methods.js';
import { Library } from '../../renderer/components/library.js';
import { DataService } from '../../renderer/js/data-service.js';
import { t } from '../../renderer/js/i18n.js';
import { canonicalPath, isSubpath } from '../../renderer/js/path-utils.js';

const SRC_A = { id: 'a', name: 'Main', path: 'D:/v', enabled: true };
const SRC_B = { id: 'b', name: 'Bulk', path: 'E:/bulk', enabled: true };
const DISK = {
  'D:/v': ['D:/v/Alpha.mp4', 'D:/v/Bravo.mp4'],
  'E:/bulk': ['E:/bulk/Bulk 003.mp4', 'E:/bulk/Bulk 005.mp4'],
};
const BULK_ASSOC = {
  'E:/bulk/Bulk 003.mp4': { active: 'single', single: 'E:/bulk/scripts/Bulk 003 v2.funscript', multi: null, custom: null },
};

let backend;
let app;
let lib;
let ds;
let scans;

const registeredVideos = () => (backend.registers.filter((r) => r.videos).at(-1)?.videos || []).map((v) => v.path);

beforeEach(() => {
  backend = { registers: [] };
  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    if (String(url).endsWith('/api/media/register')) backend.registers.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({}) };
  });
  scans = [];
  window.funsync = {
    // The folder listing of every source the scan is given; every file is on disk.
    scanDirectory: vi.fn(async (dirs) => {
      const list = Array.isArray(dirs) ? dirs : [dirs];
      scans.push(list);
      return {
        videos: list.flatMap((d) => (DISK[d] || []).map((p) => ({ path: p, name: p.split('/').pop(), hasFunscript: false }))),
        unmatchedFunscripts: [], unmatchedSubtitles: [], allFunscripts: [], failedPaths: [], skippedPaths: [],
      };
    }),
    filesExist: vi.fn(async (paths) => paths.map(() => true)),
    fileExists: vi.fn(async () => true),
    getCustomThumbsDir: vi.fn(async () => null),
    setSetting: vi.fn(async () => {}),
  };
  ds = new DataService();
  ds._cache = {
    settings: {
      backend: { port: 5123 },
      library: { sources: [SRC_A, SRC_B], collections: [], associations: structuredClone(BULK_ASSOC) },
    },
    playlists: [], categories: [], videoCategories: {},
  };
  ds._initialized = true;

  lib = new Library({ settings: ds });
  lib._videos = [...DISK['D:/v'], ...DISK['E:/bulk']].map((p) => ({ path: p, name: p.split('/').pop() }));
  lib._lastScanKey = ['D:/v', 'E:/bulk'].sort().join('\0');
  lib.show = vi.fn(); // the Library view rendering: must not happen from another view

  const Lifted = liftAppClass(['_rescanLibraryInBackground'], {});
  app = Object.assign(new Lifted(), {
    settings: ds,
    library: lib,
    upNextEngine: { refresh: vi.fn() },
    _refreshCollectionsUI() {},
    _getViewEl: () => document.createElement('div'),
    view: 'playlists',
    _currentView() { return this.view; },
  });
  app.settingsPanelOptions = liftCtorOptions('SettingsPanel', { showToast: vi.fn(), t }).call(app);
});

afterEach(() => {
  delete globalThis.fetch;
  delete window.funsync;
});

/** Settings > Sources, from whatever view is open, then let the scan finish. */
async function changeSources(sources) {
  ds.set('library.sources', sources);
  app.settingsPanelOptions.onSourcesChanged();
  await app._bgRescan;
}

describe('CB-26: a source changed from another view is rescanned at once, in the background', () => {
  it('removed from the Playlists view: the library and the phone / VR lose its videos now', async () => {
    await changeSources([SRC_A]);

    expect(lib._videos.map((v) => v.path)).toEqual(DISK['D:/v']);
    expect(registeredVideos()).toEqual(DISK['D:/v']);
    expect(scans).toEqual([['D:/v']]);
    expect(lib.show).not.toHaveBeenCalled(); // no view switch, no hidden render
    expect(app.upNextEngine.refresh).toHaveBeenCalled();
  });

  it('switched off from the Categories view: the same', async () => {
    app.view = 'categories';
    await changeSources([SRC_A, { ...SRC_B, enabled: false }]);
    expect(lib._videos.map((v) => v.path)).toEqual(DISK['D:/v']);
    expect(registeredVideos()).toEqual(DISK['D:/v']);
  });

  it('from the player too, and a source added comes in the same way', async () => {
    app.view = 'player';
    await changeSources([SRC_A]);
    await changeSources([SRC_A, SRC_B]);
    expect(lib._videos.map((v) => v.path)).toEqual([...DISK['D:/v'], ...DISK['E:/bulk']]);
    expect(registeredVideos()).toEqual([...DISK['D:/v'], ...DISK['E:/bulk']]);
  });

  it('nothing stored for the removed source\'s videos is pruned (absence is never destructive)', async () => {
    await changeSources([SRC_A]);
    await new Promise((r) => setTimeout(r, 0)); // the background association check
    expect(ds.get('library.associations')).toEqual(BULK_ASSOC);
  });

  it('the Library view opened afterwards shows that scan instead of scanning again', async () => {
    await changeSources([SRC_A]);
    expect(lib._lastScanKey).toBe('D:/v'); // what show() compares against the sources it reads
  });

  it('three quick changes scan at most twice, and the library ends on the last one', async () => {
    ds.set('library.sources', [SRC_A]);
    app.settingsPanelOptions.onSourcesChanged();
    ds.set('library.sources', [SRC_B]);
    app.settingsPanelOptions.onSourcesChanged();
    ds.set('library.sources', [SRC_A, SRC_B]);
    app.settingsPanelOptions.onSourcesChanged();
    await app._bgRescan;
    expect(scans.length).toBeGreaterThanOrEqual(1);
    expect(scans.length).toBeLessThanOrEqual(2);
    expect([...scans.at(-1)].sort()).toEqual(['D:/v', 'E:/bulk']); // the sources as they ended
    expect(lib._videos.map((v) => v.path)).toEqual([...DISK['D:/v'], ...DISK['E:/bulk']]);
  });

  it('with the Library view open it is the view that rescans, as before', async () => {
    app.view = 'library';
    ds.set('library.sources', [SRC_A]);
    app.settingsPanelOptions.onSourcesChanged();
    expect(lib.show).toHaveBeenCalledTimes(1);
    expect(app._bgRescan).toBeUndefined();
  });
});

// R3-12 (found while CB-26): removing or switching off the LAST enabled
// source left `library._videos` and the phone / VR registry on the old
// videos, from any view: ensureScanned returned early with nothing to scan,
// and the Library view drew its empty state over the old list. Now the
// library empties and the backend is sent the empty list, nothing stored is
// pruned, and Up Next offers none of the old videos (an emptied library is
// known, not "not scanned yet"; FT-018).
describe('R3-12: the last source removed or switched off empties the library, and only that', () => {
  const LiftedUpNext = liftAppClass(['_isUpNextPlayable', '_isUnderEnabledSource'], { canonicalPath, isSubpath });
  const upNextOffers = (path) => Object.assign(new LiftedUpNext(), { settings: ds, library: lib })._isUpNextPlayable(path);

  it('removed from the Playlists view: no videos left, the phone / VR told so, nothing pruned', async () => {
    await changeSources([]);
    await new Promise((r) => setTimeout(r, 0));
    expect(lib._videos).toEqual([]);
    expect(lib.getVideoByPath('D:/v/Alpha.mp4')).toBeFalsy();
    expect(backend.registers.at(-1).videos).toEqual([]);
    expect(registeredVideos()).toEqual([]);
    expect(lib.show).not.toHaveBeenCalled();
    expect(ds.get('library.associations')).toEqual(BULK_ASSOC);
    expect(app.upNextEngine.refresh).toHaveBeenCalled();
  });

  it('switched off, from the player: the same, and Up Next offers none of the old videos', async () => {
    app.view = 'player';
    await changeSources([{ ...SRC_A, enabled: false }, { ...SRC_B, enabled: false }]);
    expect(lib._videos).toEqual([]);
    expect(registeredVideos()).toEqual([]);
    expect(upNextOffers('D:/v/Bravo.mp4')).toBe(false);
    expect(upNextOffers('E:/bulk/Bulk 003.mp4')).toBe(false);
  });

  it('switched back on: scanned again, and Up Next offers its videos again', async () => {
    await changeSources([{ ...SRC_A, enabled: false }, { ...SRC_B, enabled: false }]);
    await changeSources([SRC_A, { ...SRC_B, enabled: false }]);
    expect(lib._videos.map((v) => v.path)).toEqual(DISK['D:/v']);
    expect(registeredVideos()).toEqual(DISK['D:/v']);
    expect(upNextOffers('D:/v/Bravo.mp4')).toBe(true);
  });

  it('sources that are on but all offline keep the list, as before (nothing to scan is not "no source")', async () => {
    lib._unavailablePaths = new Set(['D:/v', 'E:/bulk']);
    const before = backend.registers.length;
    await changeSources([SRC_A, SRC_B]);
    expect(lib._videos).toHaveLength(4);
    expect(backend.registers.length).toBe(before);
  });

  it('the Library view with no source on: the empty state, with no list of old videos behind it', () => {
    ds.set('library.sources', [{ ...SRC_A, enabled: false }]);
    const container = document.createElement('div');
    Library.prototype.show.call(lib, container);
    expect(container.querySelector('.library__empty')).not.toBeNull();
    expect(lib._videos).toEqual([]);
    expect(registeredVideos()).toEqual([]);
    expect(ds.get('library.associations')).toEqual(BULK_ASSOC);
  });

  it('a library that never had a source keeps "unknown = playable" for Up Next (nothing was emptied)', () => {
    lib._videos = [];
    ds.set('library.sources', []);
    expect(upNextOffers('C:/dropped/Clip.mp4')).toBe(true);
  });
});

// R3-13 (found verifying CB-26, also in v0.9.2): a source ADDED with the nav
// bar's Library ▾ > "Add Source Folder…" while Playlists or Categories was
// open was not scanned: `_addSource` called library.show() only on the
// Library view. Now it rescans in the background from any other view, as
// a source added in Settings does (CB-26), without showing the Library.
describe('R3-13: a source added from the nav bar in another view is scanned at once', () => {
  const SRC_NEW = 'F:/new';
  let adder;

  beforeEach(() => {
    DISK[SRC_NEW] = ['F:/new/Fresh 001.mp4'];
    ds.set('library.sources', [SRC_A]);
    lib._videos = DISK['D:/v'].map((p) => ({ path: p, name: p.split('/').pop() }));
    lib._lastScanKey = 'D:/v';
    window.funsync.selectDirectory = vi.fn(async () => SRC_NEW);
    const Lifted = liftAppClass(['_addSource', '_switchCollection', '_rescanLibraryInBackground'], {
      Modal: { prompt: async () => 'New' },
      crypto: globalThis.crypto,
      showToast: vi.fn(),
      t,
    });
    adder = Object.assign(new Lifted(), {
      settings: ds,
      library: lib,
      upNextEngine: { refresh: vi.fn() },
      _refreshCollectionsUI: vi.fn(async () => {}),
      _getViewEl: () => document.createElement('div'),
      view: 'playlists',
      _currentView() { return this.view; },
    });
  });

  afterEach(() => { delete DISK[SRC_NEW]; });

  it('from Playlists: the library, Up Next and the phone / VR get its videos now, with no view switch', async () => {
    await adder._addSource();
    await adder._bgRescan;
    expect(lib._videos.map((v) => v.path)).toEqual([...DISK['D:/v'], ...DISK[SRC_NEW]]);
    expect(registeredVideos()).toEqual([...DISK['D:/v'], ...DISK[SRC_NEW]]);
    expect(lib.show).not.toHaveBeenCalled();
    expect(adder.upNextEngine.refresh).toHaveBeenCalled();
    // The Library view opened later reuses this scan.
    expect(lib._lastScanKey).toBe(['D:/v', SRC_NEW].sort().join('\0'));
  });

  it('from Categories the same; from the Library view it is the view that scans, as before', async () => {
    adder.view = 'categories';
    await adder._addSource();
    await adder._bgRescan;
    expect(registeredVideos()).toContain('F:/new/Fresh 001.mp4');

    ds.set('library.sources', [SRC_A]);
    adder.view = 'library';
    adder._bgRescan = undefined;
    await adder._addSource();
    expect(lib.show).toHaveBeenCalledTimes(1);
    expect(adder._bgRescan).toBeUndefined();
  });

  it('a collection switch from another view scans only when a source\'s reachability changed', async () => {
    await adder._switchCollection('c1');
    expect(scans).toEqual([]); // a collection is only a filter the Library view applies
    lib._lastScanKey = null; // _refreshCollectionsUI saw a source come back
    await adder._switchCollection(null);
    await adder._bgRescan;
    expect(scans).toEqual([['D:/v']]);
    expect(lib.show).not.toHaveBeenCalled();
  });
});
