/**
 * @vitest-environment jsdom
 * jsdom on purpose: drives the REAL Library (library.js imports modules that
 * branch on `window`; notes/CLAUDE.md "Test environments").
 */
// FT-044 (also in v0.9.2): a funscript saved with a UTF-8 BOM failed the
// backend's speed probe, which then stored avgSpeed 0 / maxSpeed 0. The
// renderer's poll cached that 0/0 in library.speedStatsCache, hydrated it on
// every launch as a KNOWN value, and sent it back in the register payload, so
// the backend never probed the script again: Sort by Speed put it last and
// the card had no speed badge, forever.
//
// The renderer half of the fix: a cached 0/0 is "unknown". The video
// registers without stats, the backend probes it again (now BOM-safe), and
// the next poll writes the real value over the 0/0.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Library } from '../../renderer/components/library.js';

const A_FS = 'C:\\Lib\\Bravo Duplicate.funscript';
const B_FS = 'C:\\Lib\\Charlie.funscript';

function makeLibrary(cache) {
  const store = { 'library.speedStatsCache': cache, 'backend.port': 5123 };
  const settings = {
    get: (k) => store[k],
    set: vi.fn((k, v) => { store[k] = v; }),
    getPlaylists: () => [],
    getCategories: () => [],
  };
  const lib = new Library({ settings });
  lib._videos = [
    { name: 'Bravo Duplicate.mp4', path: 'C:\\Lib\\Bravo Duplicate.mp4', hasFunscript: true, funscriptPath: A_FS },
    { name: 'Charlie.mp4', path: 'C:\\Lib\\Charlie.mp4', hasFunscript: true, funscriptPath: B_FS },
  ];
  lib._applyFilters = vi.fn();
  return { lib, store };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete window.funsync;
});

describe('FT-044: a cached 0/0 speed is unknown, and the backend heals it', () => {
  it('a cached 0/0 is not hydrated, the register leaves it out, and the next poll replaces it', async () => {
    const { lib, store } = makeLibrary({
      [A_FS]: { avgSpeed: 0, maxSpeed: 0 },       // what the BOM failure cached
      [B_FS]: { avgSpeed: 120, maxSpeed: 300 },   // a real value
    });
    const [bravo, charlie] = lib._videos;

    lib._hydrateSpeedStatsCache();

    // Unknown, not "speed 0": no badge from it, and it is still pending.
    expect(bravo.avgSpeed ?? null).toBeNull();
    expect(bravo.maxSpeed ?? null).toBeNull();
    // A real cached value still hydrates (sort by speed works at once).
    expect(charlie.avgSpeed).toBe(120);
    expect(charlie.maxSpeed).toBe(300);

    // The register payload carries no 0 for the backend to trust, so its
    // probe (`avgSpeed is None`) runs for this script again.
    const bodies = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true }; }));
    window.funsync = {
      getSpeedStats: vi.fn(async () => ({ [A_FS]: { avgSpeed: 250, maxSpeed: 250 } })),
    };
    lib._registerWithBackend();
    expect(bodies).toHaveLength(1);
    const sent = Object.fromEntries(bodies[0].videos.map(v => [v.funscriptPath, v]));
    expect(sent[A_FS].avgSpeed ?? null).toBeNull();
    expect(sent[B_FS].avgSpeed).toBe(120);

    // The backend's recomputed value lands on the video and over the 0/0.
    await lib._precomputeSpeedStatsInBackground();
    expect(window.funsync.getSpeedStats).toHaveBeenCalledTimes(1);
    expect(bravo.avgSpeed).toBe(250);
    expect(bravo.maxSpeed).toBe(250);
    expect(store['library.speedStatsCache'][A_FS]).toEqual({ avgSpeed: 250, maxSpeed: 250 });
    expect(store['library.speedStatsCache'][B_FS]).toEqual({ avgSpeed: 120, maxSpeed: 300 });
    expect(lib._applyFilters).toHaveBeenCalled();   // the badge / sort re-render
  });

  it('a non-zero cached value with one zero half still hydrates', () => {
    // Only the exact 0/0 pair is the old failure marker; a script whose
    // average rounds to 0 but has a max is a real (if odd) measurement.
    const { lib } = makeLibrary({ [A_FS]: { avgSpeed: 0, maxSpeed: 5 } });
    lib._hydrateSpeedStatsCache();
    expect(lib._videos[0].avgSpeed).toBe(0);
    expect(lib._videos[0].maxSpeed).toBe(5);
  });
});

// Block C fix-up (2026-11-06, real-app verifier 2; new since v0.9.2): a
// cached 0/0 was skipped at hydrate but never rewritten when the visible
// card's own read computed the speed before the background poll ran: the
// poll persisted only entries pending at its start, so the entry stayed 0/0
// and the script was read again on every launch. Badge, sort and backend
// were right; the stored cache was not.
describe('FT-044 fix-up: a cached 0/0 is rewritten even when the card read the speed first', () => {
  it('the card computed 450 before the poll: the cache entry becomes 450/450', async () => {
    const { lib, store } = makeLibrary({
      [A_FS]: { avgSpeed: 0, maxSpeed: 0 },
      [B_FS]: { avgSpeed: 120, maxSpeed: 300 },
    });
    lib._hydrateSpeedStatsCache();
    const [bravo] = lib._videos;
    // The visible card's own read landed first.
    bravo.avgSpeed = 450;
    bravo.maxSpeed = 450;
    window.funsync = {
      getSpeedStats: vi.fn(async () => ({
        [A_FS]: { avgSpeed: 450, maxSpeed: 450 },
        [B_FS]: { avgSpeed: 120, maxSpeed: 300 },
      })),
    };
    await lib._precomputeSpeedStatsInBackground();
    expect(store['library.speedStatsCache'][A_FS]).toEqual({ avgSpeed: 450, maxSpeed: 450 });
    expect(store['library.speedStatsCache'][B_FS]).toEqual({ avgSpeed: 120, maxSpeed: 300 });
    expect(bravo.avgSpeed).toBe(450);
  });

  it('nothing cached as 0/0 and every speed known: no poll at all, as before', async () => {
    const { lib } = makeLibrary({ [A_FS]: { avgSpeed: 300, maxSpeed: 400 }, [B_FS]: { avgSpeed: 120, maxSpeed: 300 } });
    lib._hydrateSpeedStatsCache();
    window.funsync = { getSpeedStats: vi.fn(async () => ({})) };
    await lib._precomputeSpeedStatsInBackground();
    expect(window.funsync.getSpeedStats).not.toHaveBeenCalled();
  });
});
