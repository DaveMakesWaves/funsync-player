// jsdom on purpose (no node docblock): settings-panel.js imports i18n.js,
// which branches on `typeof window`. See notes/CLAUDE.md "Test environments".
//
// The renderer half of app test V04 / forum #360.
//
// The scan used to fail a whole source over one permission-denied subfolder.
// That was wrong for the user (no videos at all), but it did keep their data
// safe: a failed source joins every prune and re-home guard. Now the source
// scans and the locked folder comes back in `skippedPaths`. Inside a folder
// you cannot list, `fs.access` on a file fails with EPERM and the existence
// probe reports it as ABSENT, while the folder itself answers. Without the
// guard, `_safeToPrune` would approve deleting an association to a script in
// that folder: the exact 2026-08-11 shape. So skipped folders must guard like
// a failed source, without the "Source unavailable" toast.
//
// Recheck: a folder that exists but cannot be listed passes the probe and
// fails the scan. Recheck said "All sources are reachable." and the scan said
// "Source unavailable" 50 ms later, because Recheck counted only the probe and
// did not wait for the rescan it started.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { showToast } = await import('../../renderer/js/toast.js');
const { Library } = await import('../../renderer/components/library.js');
const { SettingsPanel } = await import('../../renderer/components/settings-panel.js');

const SRC = 'D:\\Videos\\lockedsrc';
const LOCKED = 'D:\\Videos\\lockedsrc\\Locked Sub';
const SCRIPT_IN_LOCKED = `${LOCKED}\\Hidden.funscript`;
const VIDEO_IN_LOCKED = `${LOCKED}\\Hidden.mp4`;

/** A Library with real methods and only the collaborators ensureScanned needs. */
function scannedLibrary(scanResult, { filesExist } = {}) {
  const lib = Object.create(Library.prototype);
  lib._settings = { get: (k) => (k === 'library.sources' ? [{ id: 's1', name: 'lockedsrc', path: SRC, enabled: true }] : undefined) };
  lib._unavailablePaths = new Set();
  lib._durationCache = new Map();
  lib._applyManualAssociations = vi.fn();
  lib._hydrateSpeedStatsCache = vi.fn();
  lib._hydrateDurationCache = vi.fn();
  lib._registerWithBackend = vi.fn();
  window.funsync = {
    scanDirectory: vi.fn().mockResolvedValue(scanResult),
    // The EPERM shape measured on Windows: the file "does not exist", its
    // folder does.
    filesExist: filesExist || vi.fn(async (list) => list.map((p) => p === LOCKED || p === SRC)),
  };
  return lib;
}

const scanWithLockedSub = () => ({
  videos: [{ name: 'Visible.mp4', path: `${SRC}\\Visible.mp4`, variants: [] }],
  unmatchedFunscripts: [],
  allFunscripts: [],
  failedPaths: [],
  skippedPaths: [LOCKED],
});

beforeEach(() => {
  showToast.mockClear();
});

describe('a skipped subfolder guards like a failed source', () => {
  it('refuses to prune a script inside the folder the scan could not open', async () => {
    const lib = scannedLibrary(scanWithLockedSub());
    await lib.ensureScanned({ forceRescan: true });

    expect(lib._isUnderUnavailableSource(SCRIPT_IN_LOCKED)).toBe(true);
    await expect(lib._safeToPrune(SCRIPT_IN_LOCKED)).resolves.toBe(false);
  });

  it('never calls a video in that folder provably gone, so a re-home only copies', async () => {
    const lib = scannedLibrary(scanWithLockedSub());
    await lib.ensureScanned({ forceRescan: true });

    expect(lib._isProvablyGone(VIDEO_IN_LOCKED)).toBe(false);
    // The rest of the source was walked, so real deletions elsewhere still count.
    expect(lib._isProvablyGone(`${SRC}\\Deleted.mp4`)).toBe(true);
  });

  it('does not call the source unavailable', async () => {
    const lib = scannedLibrary(scanWithLockedSub());
    await lib.ensureScanned({ forceRescan: true });

    expect(lib._failedScanPaths.size).toBe(0);
    expect(lib._scannedSourceRoots).toEqual([SRC]);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('a fresh scan without the skip lifts the guard', async () => {
    const lib = scannedLibrary(scanWithLockedSub());
    await lib.ensureScanned({ forceRescan: true });
    window.funsync.scanDirectory.mockResolvedValue({ ...scanWithLockedSub(), skippedPaths: [] });
    await lib.ensureScanned({ forceRescan: true });

    expect(lib._isUnderUnavailableSource(SCRIPT_IN_LOCKED)).toBe(false);
  });
});

// --- Recheck: the REAL app.js `_recheckSources` behind the REAL button ------

function liftMethod(src, signature) {
  const start = src.indexOf(signature);
  expect(start, `${signature} not found in app.js`).toBeGreaterThan(-1);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error('unbalanced braces');
}

// eslint-disable-next-line no-new-func
const recheckSources = new Function(
  `return async function () {${liftMethod(fs.readFileSync('renderer/js/app.js', 'utf8'), 'async _recheckSources()')}};`,
)();

/**
 * An app whose probe finds the folder (it exists), whose listing check
 * (`dirs-listable`) cannot open it, and whose rescan, started by
 * `library.show`, finds that its root cannot be read. The last scan listed it
 * fine (V82 verify: the lock came after it). Like the real `show`, the fake
 * rescans only when `_recheckSources` cleared the scan key, and takes a
 * moment, as a real scan does.
 */
function appWithUnlistableRoot() {
  const sources = [{ id: 's1', name: 'lockedsrc', path: SRC, enabled: true }];
  const app = {
    settings: { get: (k) => (k === 'library.sources' ? sources : undefined) },
    _sourceProbeCache: new Set(),
    _probeSourceReachability: vi.fn(async function () { app._sourceProbeCache = new Set(); return app._sourceProbeCache; }),
    _sourceRootsListable: vi.fn(async () => false),
    _refreshCollectionsUI: vi.fn(async () => {}),
    _currentView: () => 'library',
    _getViewEl: () => document.createElement('div'),
    library: {
      _failedScanPaths: new Set(),
      _lastScanKey: SRC,
      show: vi.fn(() => {
        if (app.library._lastScanKey !== null) return Promise.resolve();   // cached videos, no scan
        return new Promise((resolve) => setTimeout(() => {
          app.library._lastScanKey = SRC;
          app.library._failedScanPaths = new Set([SRC]);
          resolve();
        }, 30));
      }),
    },
  };
  return { app, sources };
}

function panelFor(app, sources) {
  const panel = new SettingsPanel({
    settings: { get: (k) => (k === 'library.sources' ? sources : undefined), set: vi.fn() },
    getUnreachableSources: () => app._sourceProbeCache || new Set(),
    getFailedScanSources: () => app.library?._failedScanPaths || new Set(),
    onRecheckSources: () => recheckSources.call(app),
  });
  app.settingsPanel = panel;
  return panel;
}

async function clickRecheck(panel) {
  const tab = panel._buildSourcesTab();
  document.body.appendChild(tab);
  const btn = tab.querySelector('.settings-panel__recheck-btn');
  btn.click();
  await vi.waitFor(() => expect(showToast).toHaveBeenCalled(), { timeout: 2000 });
  tab.remove();
}

describe('Recheck agrees with the scan it triggers', () => {
  it('reports a source whose folder exists but cannot be read as not reachable', async () => {
    const { app, sources } = appWithUnlistableRoot();
    await clickRecheck(panelFor(app, sources));

    expect(app.library.show).toHaveBeenCalled();
    const [message, type] = showToast.mock.calls.at(-1);
    expect(type).toBe('warn');
    expect(message).toMatch(/recheckedSome|still not reachable/);
    expect(showToast.mock.calls.some(([m]) => /recheckedAll|All sources are reachable/.test(m))).toBe(false);
  });

  it('still says all reachable when the probe and the rescan both succeed', async () => {
    const { app, sources } = appWithUnlistableRoot();
    app.library.show = vi.fn(async () => {});
    await clickRecheck(panelFor(app, sources));

    const [message, type] = showToast.mock.calls.at(-1);
    expect(type).toBe('info');
    expect(message).toMatch(/recheckedAll|All sources are reachable/);
  });

  it('ignores a failed scan for a source that has since been removed', async () => {
    const { app } = appWithUnlistableRoot();
    app.library.show = vi.fn(async () => { app.library._failedScanPaths = new Set(['E:\\old-source']); });
    await clickRecheck(panelFor(app, [{ id: 's1', name: 'lockedsrc', path: SRC, enabled: true }]));

    const [, type] = showToast.mock.calls.at(-1);
    expect(type).toBe('info');
  });
});
