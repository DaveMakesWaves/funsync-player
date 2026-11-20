// jsdom on purpose (no node docblock): the REAL Library renders its header
// and grid, and the REAL SettingsPanel builds its Sources tab; both import
// i18n.js, which branches on `typeof window`. See notes/CLAUDE.md
// "Test environments".
//
// V82 (Dave, 2026-11-03): "the recheck for different sources" is
// horrifically slow. Measured on his real library: 5.5 s from the click to
// the summary, every time, of which the probe was 10 ms and the rest a full
// rescan of a 939 GB USB drive, because `_recheckSources` cleared the scan
// key on every click even when every source answered exactly as before.
//
// What a user gets now, through app.js's REAL `_recheckSources`,
// `_refreshCollectionsUI` and `_probeSourceReachability` (lifted) driving the
// REAL Library:
//   - nothing changed: no rescan, and the summary still comes
//   - a source came back, or went away: a rescan of what answers
//   - a source the last scan could not list: a rescan (V04: the probe cannot
//     see that failure, only a scan can tell whether it is fixed)
//   - a source the last scan DID list whose listing has been denied since: a
//     rescan, and the summary reports it (V82 verify: the probe passes such a
//     folder, so the first V82 fix skipped the rescan and said "All sources
//     are reachable."). `dirs-listable` is modelled on the same disk as the
//     scan: a root the scan cannot list cannot be listed.
// and the header Refresh reports the right counts, with a Set-based diff.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { liftAppClass } from './helpers/app-methods.js';
import { sourcesToProbe } from '../../renderer/js/source-state.js';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { showToast } = await import('../../renderer/js/toast.js');
const { _setBundlesForTests, t } = await import('../../renderer/js/i18n.js');
const { Library } = await import('../../renderer/components/library.js');
const { SettingsPanel } = await import('../../renderer/components/settings-panel.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));

const A = 'D:\\funsc';
const B = 'E:\\Second';
const SOURCES = [
  { id: 'a', name: 'Main', path: A, enabled: true },
  { id: 'b', name: 'Second', path: B, enabled: true },
];

const LiftedApp = liftAppClass(
  ['_probeSourceReachability', '_recheckSources', '_sourceRootsListable', '_refreshCollectionsUI'],
  { sourcesToProbe, SOURCE_PROBE_TIMEOUT_MS: 800, t, crypto: globalThis.crypto },
);

const video = (dir, name) => ({ name, path: `${dir}\\${name}`, hasFunscript: false, variants: [] });

let store;
let reachable;     // path -> does the probe find it
let failedRoots;   // roots the next scan cannot list
let app;
let lib;
let container;

/** What the main-process scan returns for the paths it is asked for. */
function scanFor(paths) {
  const list = Array.isArray(paths) ? paths : [paths];
  const videos = [];
  const failedPaths = [];
  for (const p of list) {
    if (failedRoots.has(p)) { failedPaths.push(p); continue; }
    videos.push(video(p, 'One.mp4'), video(p, 'Two.mp4'));
  }
  return { videos, unmatchedFunscripts: [], unmatchedSubtitles: [], allFunscripts: [], failedPaths, skippedPaths: [] };
}

beforeEach(async () => {
  _setBundlesForTests('en', EN, EN);
  showToast.mockClear();
  store = {
    'library.sources': SOURCES.map((s) => ({ ...s })),
    'library.collections': [],
    'library.associations': {},
  };
  reachable = new Set([A, B]);
  failedRoots = new Set();
  const settings = {
    get: (k) => store[k],
    set: (k, v) => { store[k] = v; },
    getVideoCategories: () => [],
    getCategories: () => [],
  };
  window.funsync = {
    filesExist: vi.fn(async (paths) => paths.map((p) => reachable.has(p))),
    // Open the folder and read one entry: fails where the scan's root read
    // fails, and for a folder that is not there.
    dirsListable: vi.fn(async (paths) => paths.map((p) => reachable.has(p) && !failedRoots.has(p))),
    scanDirectory: vi.fn(async (paths) => scanFor(paths)),
  };
  lib = new Library({ settings });
  // Not under test: background passes and thumbnails.
  lib._registerWithBackend = () => {};
  lib._validateAssociationsInBackground = () => {};
  lib._validateManualVariantsInBackground = () => {};
  lib._precomputeDurationsInBackground = async () => {};
  lib._precomputeSpeedStatsInBackground = async () => {};
  lib._lazyLoadVisibleThumbnails = () => {};
  lib._activeTab = 'all';   // the test videos have no scripts
  container = document.createElement('div');
  document.body.appendChild(container);

  app = new LiftedApp();
  app.settings = settings;
  app.library = lib;
  app.navBar = { setCollections: vi.fn() };
  app._currentView = () => 'library';
  app._getViewEl = () => container;
});

afterEach(() => {
  container.remove();
  vi.restoreAllMocks();
});

/** App start: probe, then show the library (which scans). */
async function boot() {
  await app._refreshCollectionsUI();
  await lib.show(container);
}

const scannedPaths = (call) => {
  const p = window.funsync.scanDirectory.mock.calls[call][0];
  return (Array.isArray(p) ? p : [p]).slice().sort();
};
const shownVideos = () => (lib._videos || []).map((v) => v.path).sort();

describe('Recheck rescans only when the answer can have changed (V82)', () => {
  it('every source answering as before: no rescan, the library keeps its videos', async () => {
    await boot();
    expect(window.funsync.scanDirectory).toHaveBeenCalledTimes(1);
    const before = shownVideos();

    await app._recheckSources();

    expect(window.funsync.filesExist).toHaveBeenCalledTimes(2);   // it did re-probe
    expect(window.funsync.scanDirectory).toHaveBeenCalledTimes(1);
    expect(shownVideos()).toEqual(before);
    expect(container.querySelectorAll('.library__card, .library__list-item').length).toBe(4);
  });

  it('a source that comes back is rescanned, and its videos return', async () => {
    reachable.delete(B);
    await boot();
    expect(scannedPaths(0)).toEqual([A]);

    reachable.add(B);
    await app._recheckSources();

    expect(window.funsync.scanDirectory).toHaveBeenCalledTimes(2);
    expect(scannedPaths(1)).toEqual([A, B].sort());
    expect(shownVideos()).toContain(`${B}\\One.mp4`);
  });

  it('a source that goes away is left out of the rescan, and nothing else is touched', async () => {
    await boot();
    store['library.associations'] = { [`${B}\\One.mp4`]: { active: 'single', single: `${B}\\One.funscript` } };
    const assocBefore = JSON.stringify(store['library.associations']);

    reachable.delete(B);
    await app._recheckSources();

    expect(window.funsync.scanDirectory).toHaveBeenCalledTimes(2);
    expect(scannedPaths(1)).toEqual([A]);
    expect(lib._unavailablePaths.has(B)).toBe(true);
    expect(JSON.stringify(store['library.associations'])).toBe(assocBefore);
  });

  it('a source the last scan could not list is scanned again, though the probe finds it (V04)', async () => {
    failedRoots.add(A);
    await boot();
    expect(lib._failedScanPaths.has(A)).toBe(true);

    failedRoots.delete(A);   // the user fixed the permission
    await app._recheckSources();

    expect(window.funsync.scanDirectory).toHaveBeenCalledTimes(2);
    expect(lib._failedScanPaths.has(A)).toBe(false);
    expect(shownVideos()).toContain(`${A}\\One.mp4`);
  });

  it('the REAL Recheck button reports "All sources are reachable." without a rescan', async () => {
    await boot();
    const [message, type] = await clickRecheck();
    expect(message).toBe(t('settingsPanel.sources.recheckedAll'));
    expect(type).toBe('info');
    expect(window.funsync.scanDirectory).toHaveBeenCalledTimes(1);
  });
});

/** The REAL Settings > Sources Recheck button; resolves with its summary toast. */
async function clickRecheck() {
  const panel = new SettingsPanel({
    settings: app.settings,
    getUnreachableSources: () => app._sourceProbeCache || new Set(),
    getFailedScanSources: () => lib._failedScanPaths || new Set(),
    onRecheckSources: () => app._recheckSources(),
  });
  app.settingsPanel = panel;
  const tab = panel._buildSourcesTab();
  document.body.appendChild(tab);
  showToast.mockClear();
  tab.querySelector('.settings-panel__recheck-btn').click();
  const summaries = [t('settingsPanel.sources.recheckedAll'), t('settingsPanel.sources.recheckedSome', { count: 1 })];
  await vi.waitFor(() => expect(showToast.mock.calls.some(([m]) => summaries.includes(m))).toBe(true), { timeout: 2000 });
  tab.remove();
  return showToast.mock.calls.find(([m]) => summaries.includes(m));
}

describe('a source listed fine at the last scan and unlistable since (V82 verify)', () => {
  it('Recheck rescans it and the REAL button reports it, where it said "All sources are reachable."', async () => {
    await boot();
    expect(lib._failedScanPaths.size).toBe(0);
    store['library.associations'] = { [`${A}\\One.mp4`]: { active: 'single', single: `${A}\\One.funscript` } };
    const assocBefore = JSON.stringify(store['library.associations']);

    failedRoots.add(A);   // icacls /deny (RX): the probe still passes it
    const [message, type] = await clickRecheck();

    expect(window.funsync.scanDirectory).toHaveBeenCalledTimes(2);
    expect(lib._failedScanPaths.has(A)).toBe(true);
    expect(message).toBe(t('settingsPanel.sources.recheckedSome', { count: 1 }));
    expect(type).toBe('warn');
    // Absence is never destructive: the failed root guards, it does not prune.
    expect(JSON.stringify(store['library.associations'])).toBe(assocBefore);
    expect(lib._isUnderUnavailableSource(`${A}\\One.funscript`)).toBe(true);
  });

  it('asks only about the sources the probe passed and the last scan listed', async () => {
    reachable.delete(B);
    await boot();

    await app._recheckSources();

    expect(window.funsync.dirsListable).toHaveBeenCalledTimes(1);
    expect(window.funsync.dirsListable.mock.calls[0][0]).toEqual([A]);
    expect(window.funsync.scanDirectory).toHaveBeenCalledTimes(1);
  });

  it('once it can be listed again: a rescan brings its videos back, and the Recheck after that does not scan', async () => {
    await boot();
    failedRoots.add(A);
    await app._recheckSources();
    expect(shownVideos()).not.toContain(`${A}\\One.mp4`);

    failedRoots.delete(A);
    const [message] = await clickRecheck();
    expect(message).toBe(t('settingsPanel.sources.recheckedAll'));
    expect(window.funsync.scanDirectory).toHaveBeenCalledTimes(3);
    expect(shownVideos()).toContain(`${A}\\One.mp4`);

    await app._recheckSources();
    expect(window.funsync.scanDirectory).toHaveBeenCalledTimes(3);
  });

  it('a listing check that cannot answer rescans rather than calling the source fine', async () => {
    await boot();
    window.funsync.dirsListable.mockImplementationOnce(async (paths) => paths.map(() => null));   // timed out
    await app._recheckSources();
    expect(window.funsync.scanDirectory).toHaveBeenCalledTimes(2);

    window.funsync.dirsListable.mockImplementationOnce(async () => { throw new Error('IPC down'); });
    await app._recheckSources();
    expect(window.funsync.scanDirectory).toHaveBeenCalledTimes(3);

    window.funsync.dirsListable.mockImplementationOnce(async () => [true]);   // one answer for two paths
    await app._recheckSources();
    expect(window.funsync.scanDirectory).toHaveBeenCalledTimes(4);
  });
});

// FT-067 (V82 follow-up): Recheck from the Playlists or Categories view
// cleared the scan key but rescanned only `if (view === 'library')`, so a
// source whose listing had been denied since the last scan was never
// scanned, `_failedScanPaths` stayed empty, and the panel said "All sources
// are reachable.". Now the rescan runs without rendering the library, and
// the view the user is on is redrawn.
describe.each(['playlists', 'categories'])('Recheck from the %s view (FT-067)', (view) => {
  let viewComponent;
  beforeEach(() => {
    viewComponent = { show: vi.fn() };
    app[view] = viewComponent;
  });

  it('a listing denied since the last scan: one rescan, and the REAL button says 1 source is still not reachable', async () => {
    await boot();   // a good scan in the Library view
    app._currentView = () => view;
    store['library.associations'] = { [`${A}\\One.mp4`]: { active: 'single', single: `${A}\\One.funscript` } };
    store['library.playlists'] = [{ id: 'p1', name: 'P', videoPaths: [`${A}\\One.mp4`] }];
    store['library.videoCategories'] = { [`${A}\\One.mp4`]: ['c1'] };
    const before = JSON.stringify(store);

    failedRoots.add(A);   // the deny recipe: the probe still passes it
    const [message, type] = await clickRecheck();

    expect(window.funsync.scanDirectory).toHaveBeenCalledTimes(2);
    expect(lib._failedScanPaths.has(A)).toBe(true);
    expect(message).toBe(t('settingsPanel.sources.recheckedSome', { count: 1 }));
    expect(type).toBe('warn');
    // The view the user is on is redrawn; the library is not.
    expect(viewComponent.show).toHaveBeenCalledWith(container);
    // Absence is never destructive: associations, playlist and category
    // entries are exactly as they were.
    expect(JSON.stringify(store)).toBe(before);
    // The Library view scans for itself when it opens.
    expect(lib._lastScanKey).toBeNull();
  });

  it('unlocked again: Recheck rescans and says "All sources are reachable."', async () => {
    await boot();
    app._currentView = () => view;
    failedRoots.add(A);
    await clickRecheck();

    failedRoots.delete(A);
    const [message] = await clickRecheck();
    expect(message).toBe(t('settingsPanel.sources.recheckedAll'));
    expect(window.funsync.scanDirectory).toHaveBeenCalledTimes(3);
    expect(lib._failedScanPaths.has(A)).toBe(false);
  });

  it('nothing changed: no rescan, no redraw, and the summary still comes', async () => {
    await boot();
    app._currentView = () => view;
    const [message] = await clickRecheck();
    expect(message).toBe(t('settingsPanel.sources.recheckedAll'));
    expect(window.funsync.scanDirectory).toHaveBeenCalledTimes(1);
    expect(viewComponent.show).not.toHaveBeenCalled();
  });
});

describe('the header Refresh counts what changed', () => {
  it('reports new and removed videos against the scan before it', async () => {
    await boot();   // A and B, One + Two in each
    window.funsync.scanDirectory.mockImplementationOnce(async () => ({
      ...scanFor([A]),
      videos: [video(A, 'Two.mp4'), video(A, 'Three.mp4'), video(B, 'One.mp4'), video(B, 'Four.mp4'), video(B, 'Five.mp4')],
    }));
    showToast.mockClear();

    await lib.refresh();

    // Before: A\One A\Two B\One B\Two. After: A\Two A\Three B\One B\Four B\Five.
    const expected = t('library.refreshedSummary', {
      parts: [t('library.refreshNewVideos', { count: 3 }), t('library.refreshRemoved', { count: 2 })].join(', '),
    });
    expect(showToast.mock.calls.map(([m]) => m)).toContain(expected);
  });

  it('says "no changes" when the scan finds the same videos', async () => {
    await boot();
    showToast.mockClear();
    await lib.refresh();
    expect(showToast.mock.calls.map(([m]) => m)).toContain(t('library.refreshedNoChanges'));
  });
});
