// FT-005 (2026-11-05, in v0.9.2 too): a moved video keeps its categories and
// its EroScripts tag record.
//
// The scan re-homed `library.associations` and subtitles when a video moved
// (renderer/js/association-rehome.js), and app.js re-homes variants, the
// pinned variant and sync offsets lazily. Nothing touched
// `settings.library.scriptTags` or the ROOT `videoCategories` map, so moving
// a video into a subfolder dropped it out of every category it was in, and
// its tag record stayed under a path that no longer existed.
//
// Both now go through the same planner with the same guards. These tests run
// the REAL Library scan step (`_applyManualAssociations`) over the REAL
// DataService, and assert what the app then reads back (its cache, which
// every category view lists from) and what it told main (the IPC calls that
// write config.json).
//
// jsdom (no docblock): library.js imports i18n.js, which branches on
// `typeof window`. See notes/CLAUDE.md "Test environments".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Library } from '../../renderer/components/library.js';
import { DataService } from '../../renderer/js/data-service.js';

const RECORD = {
  tags: ['the-handy', 'non-vr'], topicId: 4242, topicUrl: 'https://example.invalid/t/4242',
  source: 'eroscripts', savedAt: 1,
};

let bridge;

beforeEach(() => {
  bridge = {
    setSetting: vi.fn(),
    assignCategory: vi.fn(),
    unassignCategory: vi.fn(),
    filesExist: vi.fn(async (list) => list.map(() => true)),
    fileExists: vi.fn(async () => true),
  };
  window.funsync = bridge;
});

afterEach(() => { delete window.funsync; });

/** The real DataService, its cache loaded as `init()` would from config.json. */
function dataService({ scriptTags = {}, videoCategories = {} } = {}) {
  const ds = new DataService();
  ds._cache.settings.library = {
    associations: {}, subtitleAssociations: {}, scriptTags: structuredClone(scriptTags),
  };
  ds._cache.categories = [
    { id: 'c1', name: 'Moved', color: '#f00' },
    { id: 'c2', name: 'Faves', color: '#0f0' },
    { id: 'c3', name: 'Other', color: '#00f' },
  ];
  ds._cache.videoCategories = structuredClone(videoCategories);
  ds._initialized = true;
  return ds;
}

/** A real Library (prototype intact) at the end of a scan, without its constructor. */
function scan(settings, { videos, scannedRoots = [], unavailable = [], failed = [] }) {
  const lib = Object.create(Library.prototype);
  lib._settings = settings;
  lib._videos = videos.map((p) => ({ path: p, name: p.split(/[\\/]/).pop() }));
  lib._unavailablePaths = new Set(unavailable);
  lib._failedScanPaths = new Set(failed);
  lib._skippedScanPaths = new Set();
  lib._scannedSourceRoots = scannedRoots;
  lib._allFunscripts = [];
  lib._applyManualAssociations();
  return lib;
}

const scriptTagWrites = () => bridge.setSetting.mock.calls.filter(([k]) => k === 'library.scriptTags');

describe('a provably moved video takes its categories and tags with it', () => {
  const OLD = 'C:\\Lib\\Zulu Last.mp4';
  const NEW = 'C:\\Lib\\sub\\Zulu Last.mp4';

  function moved() {
    const ds = dataService({
      scriptTags: { [OLD]: RECORD },
      videoCategories: { [OLD]: ['c1', 'c2'] },
    });
    // C:\Lib was walked this pass and Zulu Last.mp4 was not where it was.
    scan(ds, { videos: [NEW, 'C:\\Lib\\Alpha Scene.mp4'], scannedRoots: ['C:\\Lib'] });
    return ds;
  }

  it('categories: listed at the new path, gone from the old one', () => {
    const ds = moved();
    expect(ds.getVideoCategories(NEW)).toEqual(['c1', 'c2']);
    expect(ds.getVideoCategories(OLD)).toEqual([]);
    expect(ds.getVideosByCategory('c1')).toEqual([NEW]);
    expect(Object.keys(ds.getAllVideoCategories())).toEqual([NEW]);
  });

  it("categories: main's store is told, through DataService's own writes", () => {
    moved();
    expect(bridge.assignCategory.mock.calls).toEqual([[NEW, 'c1'], [NEW, 'c2']]);
    expect(bridge.unassignCategory.mock.calls).toEqual([[OLD, 'c1'], [OLD, 'c2']]);
  });

  it('scriptTags: the record is at the new key, the old key is gone, in one write', () => {
    const ds = moved();
    expect(ds.get('library.scriptTags')).toEqual({ [NEW]: RECORD });
    expect(scriptTagWrites()).toEqual([['library.scriptTags', { [NEW]: RECORD }]]);
  });
});

describe('absence without proof is a COPY', () => {
  // The old source was removed, not walked: its file may well still exist.
  const OLD = 'F:\\Removed\\Zulu Last.mp4';
  const NEW = 'C:\\Lib\\Zulu Last.mp4';

  function copied() {
    const ds = dataService({ scriptTags: { [OLD]: RECORD }, videoCategories: { [OLD]: ['c1'] } });
    scan(ds, { videos: [NEW], scannedRoots: ['C:\\Lib'] });
    return ds;
  }

  it('both paths keep the categories; nothing is unassigned', () => {
    const ds = copied();
    expect(ds.getVideoCategories(NEW)).toEqual(['c1']);
    expect(ds.getVideoCategories(OLD)).toEqual(['c1']);
    expect(bridge.unassignCategory).not.toHaveBeenCalled();
  });

  it('both paths keep the tag record, each its own copy', () => {
    const ds = copied();
    const tags = ds.get('library.scriptTags');
    expect(tags).toEqual({ [OLD]: RECORD, [NEW]: RECORD });
    expect(tags[NEW]).not.toBe(tags[OLD]);
  });

  it('a second scan changes nothing more', () => {
    const ds = copied();
    bridge.assignCategory.mockClear();
    bridge.setSetting.mockClear();
    scan(ds, { videos: [NEW], scannedRoots: ['C:\\Lib'] });
    expect(bridge.assignCategory).not.toHaveBeenCalled();
    expect(scriptTagWrites()).toEqual([]);
    expect(ds.getVideoCategories(NEW)).toEqual(['c1']);
  });
});

describe('what never moves', () => {
  it("an offline source's video keeps its categories and tags where they are", () => {
    const OFF = 'E:\\VR\\Zulu Last.mp4';
    const ds = dataService({ scriptTags: { [OFF]: RECORD }, videoCategories: { [OFF]: ['c1'] } });
    scan(ds, { videos: ['C:\\Downloads\\Zulu Last.mp4'], scannedRoots: ['C:\\Downloads'], unavailable: ['E:\\VR'] });
    expect(ds.getAllVideoCategories()).toEqual({ [OFF]: ['c1'] });
    expect(ds.get('library.scriptTags')).toEqual({ [OFF]: RECORD });
    expect(bridge.assignCategory).not.toHaveBeenCalled();
    expect(scriptTagWrites()).toEqual([]);
  });

  it('a source that failed to scan this pass counts as offline too', () => {
    const OFF = 'E:\\VR\\Zulu Last.mp4';
    const ds = dataService({ videoCategories: { [OFF]: ['c1'] } });
    scan(ds, { videos: ['C:\\Downloads\\Zulu Last.mp4'], scannedRoots: ['C:\\Downloads'], failed: ['E:\\VR'] });
    expect(ds.getAllVideoCategories()).toEqual({ [OFF]: ['c1'] });
    expect(bridge.assignCategory).not.toHaveBeenCalled();
  });

  it('two scanned videos with that name: neither gets them (ambiguous target)', () => {
    const OLD = 'C:\\Lib\\Zulu Last.mp4';
    const ds = dataService({ scriptTags: { [OLD]: RECORD }, videoCategories: { [OLD]: ['c1'] } });
    scan(ds, { videos: ['C:\\Lib\\A\\Zulu Last.mp4', 'C:\\Lib\\B\\Zulu Last.mp4'], scannedRoots: ['C:\\Lib'] });
    expect(ds.getAllVideoCategories()).toEqual({ [OLD]: ['c1'] });
    expect(ds.get('library.scriptTags')).toEqual({ [OLD]: RECORD });
    expect(bridge.assignCategory).not.toHaveBeenCalled();
  });

  it('two stored entries with that name: neither moves (ambiguous source)', () => {
    const cats = { 'C:\\Lib\\A\\Zulu Last.mp4': ['c1'], 'C:\\Lib\\B\\Zulu Last.mp4': ['c2'] };
    const ds = dataService({ videoCategories: cats });
    scan(ds, { videos: ['C:\\Lib\\C\\Zulu Last.mp4'], scannedRoots: ['C:\\Lib'] });
    expect(ds.getAllVideoCategories()).toEqual(cats);
    expect(bridge.assignCategory).not.toHaveBeenCalled();
  });

  it('a video that already has categories and tags keeps its own (target untouched)', () => {
    const OLD = 'C:\\Lib\\Zulu Last.mp4';
    const NEW = 'C:\\Lib\\sub\\Zulu Last.mp4';
    const MINE = { ...RECORD, topicId: 7, tags: ['mine'] };
    const ds = dataService({
      scriptTags: { [OLD]: RECORD, [NEW]: MINE },
      videoCategories: { [OLD]: ['c1'], [NEW]: ['c3'] },
    });
    scan(ds, { videos: [NEW], scannedRoots: ['C:\\Lib'] });
    expect(ds.getAllVideoCategories()).toEqual({ [OLD]: ['c1'], [NEW]: ['c3'] });
    expect(ds.get('library.scriptTags')).toEqual({ [OLD]: RECORD, [NEW]: MINE });
    expect(bridge.assignCategory).not.toHaveBeenCalled();
    expect(bridge.unassignCategory).not.toHaveBeenCalled();
    expect(scriptTagWrites()).toEqual([]);
  });

  it('a video still in the library is never robbed for a same-named one', () => {
    const LIVE = 'C:\\Lib\\Zulu Last.mp4';
    const ds = dataService({ scriptTags: { [LIVE]: RECORD }, videoCategories: { [LIVE]: ['c1'] } });
    scan(ds, { videos: [LIVE, 'C:\\Lib\\sub\\Zulu Last.mp4'], scannedRoots: ['C:\\Lib'] });
    expect(ds.getAllVideoCategories()).toEqual({ [LIVE]: ['c1'] });
    expect(ds.get('library.scriptTags')).toEqual({ [LIVE]: RECORD });
    expect(bridge.assignCategory).not.toHaveBeenCalled();
  });

  it('settings without the category API (older fakes) re-home tags and skip categories', () => {
    const OLD = 'C:\\Lib\\Zulu Last.mp4';
    const NEW = 'C:\\Lib\\sub\\Zulu Last.mp4';
    const store = { 'library.scriptTags': { [OLD]: RECORD } };
    const settings = { get: (k) => store[k], set: vi.fn((k, v) => { store[k] = v; }) };
    expect(() => scan(settings, { videos: [NEW], scannedRoots: ['C:\\Lib'] })).not.toThrow();
    expect(store['library.scriptTags']).toEqual({ [NEW]: RECORD });
  });
});

describe('DataService.getAllVideoCategories', () => {
  it('is a copy: editing it does not touch the cache', () => {
    const ds = dataService({ videoCategories: { 'C:\\a.mp4': ['c1'] } });
    const all = ds.getAllVideoCategories();
    all['C:\\a.mp4'].push('c2');
    delete all['C:\\a.mp4'];
    expect(ds.getVideoCategories('C:\\a.mp4')).toEqual(['c1']);
  });

  it('leaves out an entry that is not a list', () => {
    const ds = dataService({ videoCategories: { 'C:\\a.mp4': ['c1'], 'C:\\b.mp4': 'c2', 'C:\\c.mp4': null } });
    expect(ds.getAllVideoCategories()).toEqual({ 'C:\\a.mp4': ['c1'] });
  });
});
