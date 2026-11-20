// What the backend's registry is told, and when (app test 2026-11-02: V22, V23).
//
// jsdom on purpose (no node docblock): library.js imports modules that branch
// on `typeof window` (i18n.js, heatmap-strip.js). See notes/CLAUDE.md
// "Test environments".
//
// The backend never scans disk. HereSphere's scenes and tags, and every list
// the phone shows, come from whatever the desktop last POSTed to
// /api/media/register. These tests drive the REAL app.js methods (lifted, see
// helpers/app-methods.js), the REAL Library._registerWithBackend, the REAL
// DataService and the REAL event bus, and assert on the POST bodies a fake
// backend receives: the observable thing the headset and the phone read.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { liftAppClass } from './helpers/app-methods.js';
import { Library } from '../../renderer/components/library.js';
import { DataService } from '../../renderer/js/data-service.js';
import { eventBus } from '../../renderer/js/event-bus.js';

const PORT = 5123;

/** A backend that records every /api/media/register body it is sent. */
function fakeBackend() {
  const backend = { registers: [], up: true };
  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    if (!backend.up) throw new TypeError('fetch failed');
    if (String(url).endsWith('/api/media/register')) {
      backend.registers.push(JSON.parse(opts.body));
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  return backend;
}

function realDataService() {
  const ds = new DataService();
  ds._cache = {
    settings: {
      backend: { port: PORT },
      library: {
        sources: [{ id: 's1', name: 'Main', path: 'D:/v', enabled: true }],
        collections: [],
      },
    },
    playlists: [{ id: 'p1', name: 'Favs', videoPaths: ['D:/v/A.mp4'] }],
    categories: [{ id: 'c1', name: 'Solo', color: '#f00' }],
    videoCategories: {},
  };
  ds._initialized = true;
  return ds;
}

function realLibrary(settings, videos) {
  const lib = Object.create(Library.prototype);
  lib._settings = settings;
  lib._videos = videos;
  return lib;
}

describe('a restarted backend gets the library again (V22)', () => {
  const Lifted = liftAppClass(
    ['_onBackendStatusForRegistry', '_registerGroupingsEarly'],
    {},
  );
  let backend;
  let app;

  beforeEach(() => {
    backend = fakeBackend();
    window.funsync = {
      getCustomThumbsDir: vi.fn(async () => 'C:/userData/custom-thumbs'),
    };
    const settings = realDataService();
    app = new Lifted();
    app.backendPort = PORT;
    app.settings = settings;
    app.library = realLibrary(settings, [
      { path: 'D:/v/A.mp4', name: 'A.mp4', hasFunscript: true },
      { path: 'D:/v/B.mp4', name: 'B.mp4' },
    ]);
  });

  afterEach(() => {
    delete globalThis.fetch;
    delete window.funsync;
  });

  it('re-sends videos and groupings once the restart is running', async () => {
    app._onBackendStatusForRegistry('restarting');
    expect(backend.registers).toHaveLength(0);
    app._onBackendStatusForRegistry('running');
    await vi.waitFor(() => expect(backend.registers.some((r) => r.videos)).toBe(true));

    const withVideos = backend.registers.find((r) => r.videos);
    expect(withVideos.videos.map((v) => v.path)).toEqual(['D:/v/A.mp4', 'D:/v/B.mp4']);
    const groupings = backend.registers.find((r) => !r.videos);
    expect(groupings.playlists.map((p) => p.name)).toEqual(['Favs']);
    expect(groupings.categories.map((c) => c.name)).toEqual(['Solo']);
  });

  it('a restart that goes down before it comes up is still re-sent', async () => {
    app._onBackendStatusForRegistry('restarting');
    app._onBackendStatusForRegistry('down');
    app._onBackendStatusForRegistry('running');
    await vi.waitFor(() => expect(backend.registers.some((r) => r.videos)).toBe(true));
  });

  it('a busy flap (down, then running, same process) re-sends nothing', async () => {
    app._onBackendStatusForRegistry('running');
    app._onBackendStatusForRegistry('down');
    app._onBackendStatusForRegistry('running');
    await new Promise((r) => setTimeout(r, 20));
    expect(backend.registers).toHaveLength(0);
  });

  it('re-sends once per restart, not on every later running', async () => {
    app._onBackendStatusForRegistry('restarting');
    app._onBackendStatusForRegistry('running');
    await vi.waitFor(() => expect(backend.registers.length).toBeGreaterThan(0));
    const sent = backend.registers.length;
    app._onBackendStatusForRegistry('down');
    app._onBackendStatusForRegistry('running');
    await new Promise((r) => setTimeout(r, 20));
    expect(backend.registers).toHaveLength(sent);
  });
});

describe('a playlist / category / collection edit reaches the backend without a scan (V23)', () => {
  const Lifted = liftAppClass(
    ['_wireGroupingsRegister', '_registerGroupingsEarly'],
    { eventBus },
  );
  let backend;
  let settings;
  let savedHandlers;

  beforeEach(() => {
    vi.useFakeTimers();
    // The bus is a module singleton: give each test a clean one.
    savedHandlers = eventBus._handlers;
    eventBus._handlers = new Map();
    backend = fakeBackend();
    window.funsync = new Proxy({}, { get: () => vi.fn(async () => ({ id: 'new' })) });
    settings = realDataService();
    const app = new Lifted();
    app.backendPort = PORT;
    app.settings = settings;
    app._wireGroupingsRegister();
  });

  afterEach(() => {
    vi.useRealTimers();
    eventBus._handlers = savedHandlers;
    delete globalThis.fetch;
    delete window.funsync;
  });

  it('assigning a category is sent, so HereSphere gets the Category: tag', async () => {
    settings.assignCategory('D:/v/B.mp4', 'c1');
    expect(backend.registers).toHaveLength(0);           // debounced
    await vi.advanceTimersByTimeAsync(500);
    expect(backend.registers).toHaveLength(1);
    expect(backend.registers[0].videoCategories).toEqual({ 'D:/v/B.mp4': ['c1'] });
    expect(backend.registers[0].categories.map((c) => c.name)).toEqual(['Solo']);
    expect(backend.registers[0].videos).toBeUndefined();  // groupings only
  });

  it('adding a video to a playlist is sent', async () => {
    settings.addVideoToPlaylist('p1', 'D:/v/B.mp4');
    await vi.advanceTimersByTimeAsync(500);
    expect(backend.registers.at(-1).playlists[0].videoPaths).toEqual(['D:/v/A.mp4', 'D:/v/B.mp4']);
  });

  it('a collection edit is sent', async () => {
    settings.set('library.collections', [{ id: 'k1', name: 'Faves', videoPaths: ['D:/v/A.mp4'] }]);
    await vi.advanceTimersByTimeAsync(500);
    expect(backend.registers.at(-1).collections.map((c) => c.name)).toEqual(['Faves']);
  });

  it('a bulk assign of 25 videos is ONE send carrying all 25', async () => {
    for (let i = 0; i < 25; i++) settings.assignCategory(`D:/v/clip${i}.mp4`, 'c1');
    await vi.advanceTimersByTimeAsync(500);
    expect(backend.registers).toHaveLength(1);
    expect(Object.keys(backend.registers[0].videoCategories)).toHaveLength(25);
  });

  it('an unrelated setting sends nothing', async () => {
    settings.set('player.volume', 0.4);
    await vi.advanceTimersByTimeAsync(3000);
    expect(backend.registers).toHaveLength(0);
  });

  it('a failed send is retried with the CURRENT groupings, never an older snapshot', async () => {
    backend.up = false;
    settings.assignCategory('D:/v/A.mp4', 'c1');
    await vi.advanceTimersByTimeAsync(500);              // first send fails, retry armed
    backend.up = true;
    settings.assignCategory('D:/v/B.mp4', 'c1');         // a newer edit
    await vi.advanceTimersByTimeAsync(5000);             // its send AND the old retry's slot
    expect(backend.registers).toHaveLength(1);
    expect(backend.registers[0].videoCategories).toEqual({
      'D:/v/A.mp4': ['c1'], 'D:/v/B.mp4': ['c1'],
    });
  });
});

describe('Mark as VR / Mark as Flat / Reset VR reach the headset without a scan (V68)', () => {
  // The projection HereSphere and DeoVR are served comes from the
  // `manualVRType` on each registered video entry (vr_api.py
  // detect_vr_format_for_video), so what these tests read is the videos
  // slice of the POST: the REAL kebab and bulk-toolbar handlers, the REAL
  // DataService write, the REAL bus, the REAL app.js wiring.
  const Lifted = liftAppClass(
    ['_wireGroupingsRegister', '_registerGroupingsEarly'],
    { eventBus },
  );
  const A = 'D:/v/Alpha Scene.mp4';
  const VR = 'D:/v/Scene_180_LR.mp4';
  let backend;
  let settings;
  let lib;
  let savedHandlers;

  /** The override the last video registration gave each path. */
  const lastOverrides = () => {
    const sent = backend.registers.filter((r) => r.videos).at(-1);
    return Object.fromEntries(sent.videos.map((v) => [v.path, v.manualVRType ?? null]));
  };

  beforeEach(() => {
    vi.useFakeTimers();
    savedHandlers = eventBus._handlers;
    eventBus._handlers = new Map();
    backend = fakeBackend();
    window.funsync = new Proxy({}, { get: () => vi.fn(async () => null) });
    settings = realDataService();
    const bulk = Array.from({ length: 25 }, (_, i) => ({ path: `D:/v/Bulk ${i}.mp4`, name: `Bulk ${i}.mp4` }));
    lib = realLibrary(settings, [
      { path: A, name: 'Alpha Scene.mp4' },
      { path: VR, name: 'Scene_180_LR.mp4' },
      ...bulk,
    ]);
    lib._applyFilters = vi.fn(); // the grid re-render; not what the headset reads
    const app = new Lifted();
    app.backendPort = PORT;
    app.settings = settings;
    app.library = lib;
    app._wireGroupingsRegister();
  });

  afterEach(() => {
    vi.useRealTimers();
    eventBus._handlers = savedHandlers;
    delete globalThis.fetch;
    delete window.funsync;
  });

  it('Mark as VR is sent with the video list', async () => {
    await lib._toggleVRType(lib.getVideoByPath(A));
    expect(backend.registers).toHaveLength(0);           // debounced
    await vi.advanceTimersByTimeAsync(500);
    expect(lastOverrides()[A]).toBe('vr');
    expect(lastOverrides()[VR]).toBe(null);
  });

  it('Mark as Flat on a VR-named file is sent', async () => {
    await lib._toggleVRType(lib.getVideoByPath(VR));
    await vi.advanceTimersByTimeAsync(500);
    expect(lastOverrides()[VR]).toBe('flat');
  });

  it('Reset VR clears the override on the backend', async () => {
    await lib._toggleVRType(lib.getVideoByPath(A));
    await vi.advanceTimersByTimeAsync(500);
    await lib._toggleVRType(lib.getVideoByPath(A));      // override set -> Reset VR
    await vi.advanceTimersByTimeAsync(500);
    expect(lastOverrides()[A]).toBe(null);
  });

  // FT-026 (2026-11-05, new since v0.9.2): the single-card path. Mark / Flat /
  // Reset clicked fast on cards (each its own write) is one send carrying the
  // LAST state of every card, and clicks further apart than the 400 ms window
  // each get their own.
  it('three single-card clicks within 400 ms (A, B, A) are ONE send with the last state of each', async () => {
    const B = 'D:/v/Bulk 0.mp4';
    await lib._toggleVRType(lib.getVideoByPath(A));      // Mark as VR
    await vi.advanceTimersByTimeAsync(100);
    await lib._toggleVRType(lib.getVideoByPath(B));      // Mark as VR
    await vi.advanceTimersByTimeAsync(100);
    await lib._toggleVRType(lib.getVideoByPath(A));      // Reset VR
    expect(backend.registers.filter((r) => r.videos)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(backend.registers.filter((r) => r.videos)).toHaveLength(1);
    expect(lastOverrides()[A]).toBe(null);
    expect(lastOverrides()[B]).toBe('vr');
    await vi.advanceTimersByTimeAsync(3000);             // nothing else follows
    expect(backend.registers.filter((r) => r.videos)).toHaveLength(1);
  });

  it('single-card clicks 500 ms apart are sent once each', async () => {
    const B = 'D:/v/Bulk 0.mp4';
    await lib._toggleVRType(lib.getVideoByPath(A));
    await vi.advanceTimersByTimeAsync(500);
    expect(backend.registers.filter((r) => r.videos)).toHaveLength(1);
    expect(lastOverrides()[A]).toBe('vr');
    await lib._toggleVRType(lib.getVideoByPath(B));
    await vi.advanceTimersByTimeAsync(500);
    expect(backend.registers.filter((r) => r.videos)).toHaveLength(2);
    expect(lastOverrides()[A]).toBe('vr');
    expect(lastOverrides()[B]).toBe('vr');
  });

  it('a bulk Mark as Flat of 25 videos is ONE send carrying all 25', async () => {
    const paths = lib._videos.filter((v) => v.name.startsWith('Bulk')).map((v) => v.path);
    await lib._bulkSetVRType(paths, 'flat');
    await vi.advanceTimersByTimeAsync(500);
    expect(backend.registers.filter((r) => r.videos)).toHaveLength(1);
    expect(paths.every((p) => lastOverrides()[p] === 'flat')).toBe(true);
    await lib._bulkSetVRType(paths, 'reset');
    await vi.advanceTimersByTimeAsync(500);
    expect(backend.registers.filter((r) => r.videos)).toHaveLength(2);
    expect(paths.every((p) => lastOverrides()[p] === null)).toBe(true);
  });

  it('nothing is sent before a scan has listed videos (an empty list would empty the registry)', async () => {
    lib._videos = [];
    settings.set('library.manualVRType', { [A]: 'vr' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(backend.registers.filter((r) => r.videos)).toHaveLength(0);
  });

  it('a late retry never lands an older override over a newer one', async () => {
    backend.up = false;
    await lib._toggleVRType(lib.getVideoByPath(A));      // Mark as VR: send fails, retry armed
    await vi.advanceTimersByTimeAsync(500);
    backend.up = true;
    await lib._toggleVRType(lib.getVideoByPath(A));      // Reset VR: a newer send
    await vi.advanceTimersByTimeAsync(5000);             // its send AND the old retry's slot
    expect(lastOverrides()[A]).toBe(null);
    // The superseded retry sends nothing at all: no second full library.
    expect(backend.registers.filter((r) => r.videos)).toHaveLength(1);
  });

  it('a retry of the video list never undoes a newer collection edit', async () => {
    backend.up = false;
    await lib._toggleVRType(lib.getVideoByPath(A));      // video send fails, retry armed
    await vi.advanceTimersByTimeAsync(500);
    backend.up = true;
    settings.set('library.collections', [{ id: 'k1', name: 'Faves', videoPaths: [A] }]);
    await vi.advanceTimersByTimeAsync(5000);             // groupings send, then the retry
    const last = backend.registers.at(-1);
    expect(last.videos).toBeDefined();                   // the retry landed last...
    expect(last.collections.map((c) => c.name)).toEqual(['Faves']); // ...with today's collections
    expect(lastOverrides()[A]).toBe('vr');
  });
});
