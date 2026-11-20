// Re-home on move for your own tags, the tags you hid, and the EroScripts
// record (Round 3, 2026-11-18; DESIGN-video-options.md (e) "Re-home on
// move"). `library.userTags` and `library.hiddenTags` are path-keyed like the
// associations; nothing moved them, so moving a video into a subfolder left
// its tags under a path that no longer exists. They now go through the same
// planner (association-rehome.js) with the same guards, planned ONCE with
// `scriptTags` over the union of the three maps' paths, so a video's tag
// data moves together or not at all.
//
// The REAL Library scan step (`_applyManualAssociations`) over the REAL
// DataService; asserted: what the app reads back and what it told main.
// Categories keep their own pass (rehome-categories-tags.test.js).
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

function dataService(library = {}) {
  const ds = new DataService();
  ds._cache.settings.library = {
    associations: {}, subtitleAssociations: {}, ...structuredClone(library),
  };
  ds._cache.categories = [];
  ds._cache.videoCategories = {};
  ds._initialized = true;
  return ds;
}

/** A real Library at the end of a scan, without its constructor. */
function scan(settings, { videos, scannedRoots = [], unavailable = [], failed = [] }) {
  const lib = Object.create(Library.prototype);
  lib._settings = settings;
  lib._videos = videos.map((v) => (typeof v === 'string'
    ? { path: v, name: v.split(/[\\/]/).pop() }
    : { name: v.path.split(/[\\/]/).pop(), ...v }));
  lib._unavailablePaths = new Set(unavailable);
  lib._failedScanPaths = new Set(failed);
  lib._skippedScanPaths = new Set();
  lib._scannedSourceRoots = scannedRoots;
  lib._allFunscripts = [];
  lib._applyManualAssociations();
  return lib;
}

const writesOf = (key) => bridge.setSetting.mock.calls.filter(([k]) => k === key);

const OLD = 'C:\\Lib\\Zulu Last.mp4';
const NEW = 'C:\\Lib\\sub\\Zulu Last.mp4';

describe('a provably moved video takes all its tag data with it', () => {
  function moved() {
    const ds = dataService({
      userTags: { [OLD]: ['pov', 'cosplay'], 'C:\\Lib\\Other.mp4': ['x'] },
      hiddenTags: { [OLD]: ['content:junk'] },
      scriptTags: { [OLD]: RECORD },
    });
    scan(ds, { videos: [NEW, 'C:\\Lib\\Other.mp4'], scannedRoots: ['C:\\Lib'] });
    return ds;
  }

  it('your tags, your hides and the post\'s record are at the new path, gone from the old', () => {
    const ds = moved();
    expect(ds.get('library.userTags')).toEqual({ [NEW]: ['pov', 'cosplay'], 'C:\\Lib\\Other.mp4': ['x'] });
    expect(ds.get('library.hiddenTags')).toEqual({ [NEW]: ['content:junk'] });
    expect(ds.get('library.scriptTags')).toEqual({ [NEW]: RECORD });
  });

  it('main is told once per map, the whole new map', () => {
    const ds = moved();
    expect(writesOf('library.userTags')).toEqual([['library.userTags', ds.get('library.userTags')]]);
    expect(writesOf('library.hiddenTags')).toEqual([['library.hiddenTags', { [NEW]: ['content:junk'] }]]);
    expect(writesOf('library.scriptTags')).toEqual([['library.scriptTags', { [NEW]: RECORD }]]);
  });

  it('a second scan changes nothing more', () => {
    const ds = moved();
    bridge.setSetting.mockClear();
    scan(ds, { videos: [NEW, 'C:\\Lib\\Other.mp4'], scannedRoots: ['C:\\Lib'] });
    expect(bridge.setSetting).not.toHaveBeenCalled();
  });
});

describe('absence without proof is a COPY', () => {
  const GONE = 'F:\\Removed\\Zulu Last.mp4'; // its source was removed, not walked
  it('both paths keep every map\'s entry, each its own copy', () => {
    const ds = dataService({ userTags: { [GONE]: ['pov'] }, hiddenTags: { [GONE]: ['vr'] }, scriptTags: { [GONE]: RECORD } });
    scan(ds, { videos: [NEW], scannedRoots: ['C:\\Lib'] });
    const user = ds.get('library.userTags');
    expect(user).toEqual({ [GONE]: ['pov'], [NEW]: ['pov'] });
    expect(user[NEW]).not.toBe(user[GONE]);
    expect(ds.get('library.hiddenTags')).toEqual({ [GONE]: ['vr'], [NEW]: ['vr'] });
    expect(ds.get('library.scriptTags')).toEqual({ [GONE]: RECORD, [NEW]: RECORD });
  });
});

describe('what never moves', () => {
  it('an offline source\'s video keeps its tags where they are', () => {
    const OFF = 'E:\\VR\\Zulu Last.mp4';
    const ds = dataService({ userTags: { [OFF]: ['pov'] }, hiddenTags: { [OFF]: ['vr'] } });
    scan(ds, { videos: ['C:\\Downloads\\Zulu Last.mp4'], scannedRoots: ['C:\\Downloads'], unavailable: ['E:\\VR'] });
    expect(ds.get('library.userTags')).toEqual({ [OFF]: ['pov'] });
    expect(ds.get('library.hiddenTags')).toEqual({ [OFF]: ['vr'] });
    expect(bridge.setSetting).not.toHaveBeenCalled();
  });

  it('two old paths of that name, in DIFFERENT maps: nothing moves (two videos\' tags never land on one)', () => {
    const A = 'C:\\Lib\\A\\Zulu Last.mp4';
    const B = 'C:\\Lib\\B\\Zulu Last.mp4';
    const ds = dataService({ userTags: { [A]: ['pov'] }, hiddenTags: { [B]: ['vr'] } });
    scan(ds, { videos: ['C:\\Lib\\C\\Zulu Last.mp4'], scannedRoots: ['C:\\Lib'] });
    expect(ds.get('library.userTags')).toEqual({ [A]: ['pov'] });
    expect(ds.get('library.hiddenTags')).toEqual({ [B]: ['vr'] });
    expect(bridge.setSetting).not.toHaveBeenCalled();
  });

  it('a collision: the new path already has tag data in ANY map, so it keeps its own and nothing moves', () => {
    const MINE = { ...RECORD, topicId: 7, tags: ['mine'] };
    const ds = dataService({ userTags: { [OLD]: ['pov'] }, hiddenTags: { [OLD]: ['vr'] }, scriptTags: { [NEW]: MINE } });
    scan(ds, { videos: [NEW], scannedRoots: ['C:\\Lib'] });
    expect(ds.get('library.userTags')).toEqual({ [OLD]: ['pov'] });
    expect(ds.get('library.hiddenTags')).toEqual({ [OLD]: ['vr'] });
    expect(ds.get('library.scriptTags')).toEqual({ [NEW]: MINE });
    expect(bridge.setSetting).not.toHaveBeenCalled();
  });

  it('two scanned videos with that name: neither gets them (ambiguous target)', () => {
    const ds = dataService({ userTags: { [OLD]: ['pov'] } });
    scan(ds, { videos: ['C:\\Lib\\A\\Zulu Last.mp4', 'C:\\Lib\\B\\Zulu Last.mp4'], scannedRoots: ['C:\\Lib'] });
    expect(ds.get('library.userTags')).toEqual({ [OLD]: ['pov'] });
  });

  it('a video still in the library is never robbed for a same-named one', () => {
    const ds = dataService({ userTags: { [OLD]: ['pov'] } });
    scan(ds, { videos: [OLD, NEW], scannedRoots: ['C:\\Lib'] });
    expect(ds.get('library.userTags')).toEqual({ [OLD]: ['pov'] });
    expect(bridge.setSetting).not.toHaveBeenCalled();
  });

  it('a damaged map is neither read nor written; the others still move', () => {
    const ds = dataService({ userTags: ['not', 'a', 'map'], hiddenTags: { [OLD]: ['vr'] } });
    scan(ds, { videos: [NEW], scannedRoots: ['C:\\Lib'] });
    expect(ds.get('library.userTags')).toEqual(['not', 'a', 'map']);
    expect(writesOf('library.userTags')).toEqual([]);
    expect(ds.get('library.hiddenTags')).toEqual({ [NEW]: ['vr'] });
  });

  it('an empty list is no tag data: it neither moves nor blocks', () => {
    const ds = dataService({ userTags: { [OLD]: [], [NEW]: [] }, hiddenTags: { [OLD]: ['vr'] } });
    scan(ds, { videos: [NEW], scannedRoots: ['C:\\Lib'] });
    expect(ds.get('library.hiddenTags')).toEqual({ [NEW]: ['vr'] });
    expect(ds.get('library.userTags')).toEqual({ [OLD]: [], [NEW]: [] });
  });
});

describe('the moved EroScripts record names the script the moved video plays', () => {
  const OLD_OWN = 'C:\\Lib\\Zulu Last.funscript';
  const NEW_OWN = 'C:\\Lib\\sub\\Zulu Last.funscript';

  it('the sidecar moved with the video: the record names the new one (its tags show again)', () => {
    const ds = dataService({ scriptTags: { [OLD]: { ...RECORD, scriptPath: OLD_OWN } } });
    scan(ds, { videos: [{ path: NEW, funscriptPath: NEW_OWN, hasFunscript: true }], scannedRoots: ['C:\\Lib'] });
    expect(ds.get('library.scriptTags')).toEqual({ [NEW]: { ...RECORD, scriptPath: NEW_OWN } });
  });

  it('the video plays another script now: the record is moved as it was', () => {
    const ds = dataService({ scriptTags: { [OLD]: { ...RECORD, scriptPath: OLD_OWN } } });
    scan(ds, { videos: [{ path: NEW, funscriptPath: 'C:\\Scripts\\Other.funscript', hasFunscript: true }], scannedRoots: ['C:\\Lib'] });
    expect(ds.get('library.scriptTags')[NEW].scriptPath).toBe(OLD_OWN);
  });

  it('a record about a hand-paired script elsewhere is moved as it was', () => {
    const HAND = 'C:\\Scripts\\Zulu Hand.funscript';
    const ds = dataService({ scriptTags: { [OLD]: { ...RECORD, scriptPath: HAND } } });
    scan(ds, { videos: [{ path: NEW, funscriptPath: NEW_OWN, hasFunscript: true }], scannedRoots: ['C:\\Lib'] });
    expect(ds.get('library.scriptTags')[NEW].scriptPath).toBe(HAND);
  });

  it('a record with no scriptPath (an older download) is moved as it was', () => {
    const ds = dataService({ scriptTags: { [OLD]: RECORD } });
    scan(ds, { videos: [{ path: NEW, funscriptPath: NEW_OWN, hasFunscript: true }], scannedRoots: ['C:\\Lib'] });
    expect(ds.get('library.scriptTags')[NEW]).toEqual(RECORD);
  });
});
