/**
 * @vitest-environment jsdom
 * jsdom on purpose: library.js imports modules that branch on
 * `typeof window` (notes/CLAUDE.md "Test environments").
 */
// Test day 2026-11-24 (B023): a source folder came back while the start-up
// scan of 1,000 videos was still running; Refresh did nothing (refresh()
// returns at once while a scan is in flight), and the folder's videos stayed
// missing until Refresh was pressed again later. A Refresh during a scan now
// runs once more when that scan ends.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));
const { Library } = await import('../../renderer/components/library.js');

function makeLib() {
  const lib = Object.create(Library.prototype);
  const scans = [];
  lib._settings = { get: (k) => (k === 'library.sources' ? [{ path: 'C:\\Lib', name: 'Lib' }] : undefined) };
  lib._container = null;
  lib._videos = [];
  lib._unavailablePaths = new Set();
  lib._showLoadingState = () => {};
  lib.ensureScanned = vi.fn(() => new Promise((resolve) => scans.push(resolve)));
  return { lib, scans };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('Refresh pressed while a scan runs (B023)', () => {
  it('scans once more after the running scan ends', async () => {
    const { lib, scans } = makeLib();
    const first = lib._scanDirectory('C:\\Lib', {});      // the start-up scan
    await tick();
    expect(lib.ensureScanned).toHaveBeenCalledTimes(1);
    lib.refresh();                                         // the folder is back: Refresh
    await tick();
    expect(lib.ensureScanned).toHaveBeenCalledTimes(1);    // not two at once
    scans[0]();                                            // the first scan ends
    await first;
    for (let i = 0; i < 5; i++) await tick();
    expect(lib.ensureScanned).toHaveBeenCalledTimes(2);    // ... and the Refresh runs
    scans[1]();
  });

  it('several presses during one scan give ONE more scan', async () => {
    const { lib, scans } = makeLib();
    const first = lib._scanDirectory('C:\\Lib', {});
    await tick();
    lib.refresh(); lib.refresh(); lib.refresh();
    scans[0]();
    await first;
    for (let i = 0; i < 5; i++) await tick();
    expect(lib.ensureScanned).toHaveBeenCalledTimes(2);
    scans[1]();
    for (let i = 0; i < 5; i++) await tick();
    expect(lib.ensureScanned).toHaveBeenCalledTimes(2);
  });

  it('no press, no extra scan', async () => {
    const { lib, scans } = makeLib();
    const first = lib._scanDirectory('C:\\Lib', {});
    await tick();
    scans[0]();
    await first;
    for (let i = 0; i < 5; i++) await tick();
    expect(lib.ensureScanned).toHaveBeenCalledTimes(1);
  });
});

// The same day, the deeper half of B023: the start-up scan does not go
// through _scanDirectory, so a Refresh during it starts a SECOND scan. The
// older one (begun while the folder was missing) finished last and wrote its
// stale list over the newer one: the folder's videos stayed missing, and the
// stale list also went to the backend (the phone) and the missing-source
// guard. A scan whose answer arrives after a newer scan began is dropped.
describe('overlapping scans: the newest one wins (B023)', () => {
  function scanningLib() {
    const lib = Object.create(Library.prototype);
    const calls = [];
    lib._settings = { get: (k) => (k === 'library.sources' ? [{ path: 'C:\\Lib', name: 'Lib' }] : undefined) };
    lib._unavailablePaths = new Set();
    lib._durationCache = new Map();
    for (const m of ['_mergeStreams', '_applyManualAssociations', '_hydrateSpeedStatsCache', '_hydrateDurationCache']) lib[m] = vi.fn();
    lib._registerWithBackend = vi.fn();
    globalThis.window.funsync = { ...(globalThis.window.funsync || {}), scanDirectory: vi.fn(() => new Promise((resolve) => calls.push(resolve))) };
    return { lib, calls };
  }
  const vids = (...names) => ({ videos: names.map((n) => ({ name: n, path: `C:\\Lib\\${n}` })), failedPaths: [] });

  it('the older scan finishing last does not overwrite the newer list', async () => {
    const { lib, calls } = scanningLib();
    const older = lib.ensureScanned({ forceRescan: true });   // start-up: the folder is missing
    const newer = lib.ensureScanned({ forceRescan: true });   // Refresh: the folder is back
    calls[1](vids('A.mp4', 'Extra One.mp4'));
    await newer;
    calls[0](vids('A.mp4'));
    await older;
    expect(lib._videos.map((v) => v.name)).toEqual(['A.mp4', 'Extra One.mp4']);
    expect(lib._registerWithBackend).toHaveBeenCalledTimes(1);  // the stale list never reaches the phone
  });

  it('in order, both apply as before', async () => {
    const { lib, calls } = scanningLib();
    const first = lib.ensureScanned({ forceRescan: true });
    calls[0](vids('A.mp4'));
    await first;
    const second = lib.ensureScanned({ forceRescan: true });
    calls[1](vids('A.mp4', 'B.mp4'));
    await second;
    expect(lib._videos.map((v) => v.name)).toEqual(['A.mp4', 'B.mp4']);
    expect(lib._registerWithBackend).toHaveBeenCalledTimes(2);
  });
});
