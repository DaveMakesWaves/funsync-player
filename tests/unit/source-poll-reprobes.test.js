/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// R3-17 (found while checking FT-004, also in v0.9.2): the 30 s source poll
// never re-probed. `_pollSourceAvailability` -> `_refreshCollectionsUI` ->
// `_probeSourceReachability(sources)` WITHOUT force, which hands back the
// cached answer while the source list is unchanged. Seen live: a source
// renamed away mid-session, one poll later no "Source disconnected" toast,
// no lock, and 0 `fs.access` calls from the poll. Only Recheck re-probed.
//
// Now every poll asks afresh, one check per source root, bounded, never
// while a probe is out, and fail-safe: a check that does not answer (a
// timeout, an error) keeps the state the source had, so a sleeping drive is
// never toggled by its own slowness; only an explicit "not there" locks, and
// a lock prunes nothing.
//
// What runs is REAL app.js: `_pollSourceAvailability`, its fresh probe, the
// probe itself and `_refreshCollectionsUI` (lifted). The main process's
// `files-exist` is a fake whose answers a test sets per path.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { liftAppClass } from './helpers/app-methods.js';
import { sourcesToProbe } from '../../renderer/js/source-state.js';

const A = 'D:\\funsc';
const B = 'E:\\Second';
const SOURCES = [
  { id: 'a', name: 'Main', path: A, enabled: true },
  { id: 'b', name: 'Second', path: B, enabled: true },
];

let answers; // path -> true | false | null (what files-exist says)
let toasts;
let app;
let filesExist;
let store;

beforeEach(() => {
  answers = new Map([[A, true], [B, true]]);
  toasts = [];
  filesExist = vi.fn(async (paths) => paths.map((p) => answers.get(p)));
  store = {
    'library.sources': SOURCES.map((s) => ({ ...s })),
    'library.collections': [],
    'library.associations': { [`${B}\\Clip.mp4`]: { active: 'single', single: `${B}\\Clip.funscript`, multi: null, custom: null } },
  };
  const Lifted = liftAppClass(
    ['_pollSourceAvailability', '_pollSourceAvailabilityOnce', '_probeSourceReachability', '_refreshCollectionsUI'],
    {
      sourcesToProbe,
      SOURCE_PROBE_TIMEOUT_MS: 800,
      SOURCE_POLL_TIMEOUT_MS: 5000,
      t: (key, vars) => `${key}${vars?.names ? `:${vars.names}` : ''}`,
      showToast: (msg, level) => toasts.push([msg, level]),
      crypto: globalThis.crypto,
      window: { funsync: { get filesExist() { return filesExist; } } },
    },
  );
  app = Object.assign(new Lifted(), {
    settings: { get: (k) => store[k], set: (k, v) => { store[k] = v; } },
    navBar: { setCollections: vi.fn() },
    library: { _unavailablePaths: new Set(), _lastScanKey: 'scanned', show: vi.fn() },
    view: 'playlists',
    _currentView() { return this.view; },
    _getViewEl: () => ({}),
  });
});

/** Startup: the first probe (as `_refreshCollectionsUI` does at boot), cached. */
async function boot() {
  await app._refreshCollectionsUI();
  filesExist.mockClear();
}

describe('R3-17: the 30 s poll probes afresh', () => {
  it('a source that went away mid-session is noticed by the next poll: toast, lock, one check per root', async () => {
    await boot();
    answers.set(B, false); // renamed away / unplugged

    await app._pollSourceAvailability();

    expect(filesExist).toHaveBeenCalledTimes(1);
    expect(filesExist).toHaveBeenCalledWith([A, B], 5000);
    expect(toasts).toEqual([['toast.sourceDisconnected:Second', 'warn']]);
    expect([...app.library._unavailablePaths]).toEqual([B]);
    expect(app.library._lastScanKey).toBeNull(); // the Library view rescans when it opens
  });

  it('and its return by a later poll: "reconnected", unlocked', async () => {
    await boot();
    answers.set(B, false);
    await app._pollSourceAvailability();
    answers.set(B, true);
    await app._pollSourceAvailability();
    expect(toasts.at(-1)).toEqual(['toast.sourceReconnected:Second', 'info']);
    expect(app.library._unavailablePaths.size).toBe(0);
  });

  it('nothing changed: a probe each poll, no toast, no lock', async () => {
    await boot();
    await app._pollSourceAvailability();
    await app._pollSourceAvailability();
    expect(filesExist).toHaveBeenCalledTimes(2);
    expect(toasts).toEqual([]);
    expect(app.library._unavailablePaths.size).toBe(0);
  });

  it('no answer (a timeout) is no news: a reachable source stays unlocked, a locked one stays locked', async () => {
    await boot();
    answers.set(B, false);
    await app._pollSourceAvailability();
    toasts = [];
    answers.set(A, null);
    answers.set(B, null);
    await app._pollSourceAvailability();
    expect(toasts).toEqual([]);
    expect([...app.library._unavailablePaths]).toEqual([B]);
  });

  it('a failed or malformed check changes nothing either', async () => {
    await boot();
    answers.set(B, false);
    await app._pollSourceAvailability();
    toasts = [];
    filesExist.mockImplementationOnce(async () => { throw new Error('IPC gone'); });
    await app._pollSourceAvailability();
    filesExist.mockImplementationOnce(async () => [true]); // wrong length
    await app._pollSourceAvailability();
    expect(toasts).toEqual([]);
    expect([...app.library._unavailablePaths]).toEqual([B]);
  });

  it('never two probes at once: a poll while a check is still out does not start another', async () => {
    await boot();
    let release;
    filesExist.mockImplementationOnce((paths) => new Promise((r) => { release = () => r(paths.map(() => true)); }));
    const first = app._pollSourceAvailability();
    await app._pollSourceAvailability(); // 30 s later, the first still out
    await app._pollSourceAvailability();
    expect(filesExist).toHaveBeenCalledTimes(1);
    release();
    await first;
    await app._pollSourceAvailability();
    expect(filesExist).toHaveBeenCalledTimes(2);
  });

  it('a switched-off source is never probed; a lock prunes nothing', async () => {
    store['library.sources'] = [SOURCES[0], { ...SOURCES[1], enabled: false }];
    await boot();
    answers.set(B, false);
    await app._pollSourceAvailability();
    expect(filesExist).toHaveBeenCalledWith([A], 5000);
    answers.set(A, false);
    await app._pollSourceAvailability();
    expect([...app.library._unavailablePaths]).toEqual([A]);
    expect(store['library.associations'][`${B}\\Clip.mp4`].single).toBe(`${B}\\Clip.funscript`);
  });

  it('on the Library view the change re-renders it, as before', async () => {
    app.view = 'library';
    await boot();
    answers.set(A, false);
    await app._pollSourceAvailability();
    expect(app.library.show).toHaveBeenCalledTimes(1);
  });
});
