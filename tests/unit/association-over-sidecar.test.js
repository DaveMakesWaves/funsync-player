// R4-06 (2026-11-06, also in v0.9.2): a SINGLE association the user made to a
// script under another name wins over the video's own `<video>.funscript`.
//
// `Library._applyManualAssociations` applied a 'single' association only
// `if (!video.hasFunscript)`. Associate Alpha Scene with
// `Assoc For Alpha.funscript` while `Alpha Scene.funscript` sits beside the
// video: that session used it, but the next scan or View > Reload put the
// sidecar back, the editor opened and saved the sidecar, and
// `library.associations` still named the user's script. Multi and custom
// associations always won.
//
// These run the REAL Library scan (`ensureScanned` → `_applyManualAssociations`
// → the background validator) over the REAL DataService, a scripted scan
// result and an in-memory file system, and assert what a play loads
// (`resolvePlayData`: the script text, the file the editor saves to, the
// variant list), what the card read returns and what is stored. A reload is
// a new DataService loaded from what main stored plus a new Library.
//
// jsdom (no docblock): library.js imports i18n.js, which branches on
// `typeof window`. See notes/CLAUDE.md "Test environments".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Library } from '../../renderer/components/library.js';
import { DataService } from '../../renderer/js/data-service.js';
import { liftAppClass } from './helpers/app-methods.js';

const LIB = 'C:\\Lib';
const VIDEO = `${LIB}\\Alpha Scene.mp4`;
const SIDECAR = `${LIB}\\Alpha Scene.funscript`;
const SCRIPTS = 'C:\\Scripts';
const ASSOC = `${SCRIPTS}\\Assoc For Alpha.funscript`;
const SIDECAR_TEXT = '{"actions":[{"at":0,"pos":0}],"_who":"sidecar"}';
const ASSOC_TEXT = '{"actions":[{"at":0,"pos":100}],"_who":"assoc"}';

const singleEntry = (p) => ({ active: 'single', single: p, multi: null, custom: null });

/** Main's config.json, as the IPC writes reach it. */
let stored;
/** path → text; a folder in `dirs` answers, anything else is unknown. */
let files;
let dirs;
let unknown;

function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = (o[k] ||= {});
  o[keys[keys.length - 1]] = value;
}

beforeEach(() => {
  stored = {
    library: {
      sources: [{ id: 's1', name: 'Lib', path: LIB, enabled: true }],
      associations: { [VIDEO]: singleEntry(ASSOC) },
    },
  };
  files = new Map([[SIDECAR, SIDECAR_TEXT], [ASSOC, ASSOC_TEXT]]);
  dirs = new Set([LIB, SCRIPTS]);
  unknown = new Set();
  window.funsync = {
    setSetting: vi.fn((k, v) => setPath(stored, k, structuredClone(v))),
    scanDirectory: vi.fn(async () => scanResult()),
    readFunscript: vi.fn(async (p) => (unknown.has(p) ? null : files.get(p) ?? null)),
    filesExist: vi.fn(async (list) => list.map((p) => {
      if (unknown.has(p)) return null;
      if (files.has(p) || dirs.has(p)) return true;
      const dir = p.slice(0, p.lastIndexOf('\\'));
      return dirs.has(dir) && !unknown.has(dir) ? false : null;
    })),
    fileExists: vi.fn(async (p) => files.has(p)),
  };
});

afterEach(() => { delete window.funsync; });

/** What scan-directory answers: the video with its own sidecar paired by name. */
function scanResult() {
  return {
    videos: [{
      name: 'Alpha Scene.mp4',
      path: VIDEO,
      hasFunscript: true,
      funscriptPath: SIDECAR,
      variants: [{ label: 'Default', path: SIDECAR, name: 'Alpha Scene.funscript' }],
    }],
    unmatchedFunscripts: [],
    allFunscripts: [{ name: 'Alpha Scene.funscript', path: SIDECAR }],
    failedPaths: [],
    skippedPaths: [],
  };
}

/** The app's start: DataService loaded from config.json, a Library, a scan. */
async function boot() {
  const ds = new DataService();
  ds._cache.settings = structuredClone(stored);
  ds._initialized = true;
  const lib = Object.create(Library.prototype);
  lib._settings = ds;
  lib._videos = [];
  lib._unavailablePaths = new Set();
  lib._durationCache = new Map();
  lib._hydrateSpeedStatsCache = vi.fn();
  lib._hydrateDurationCache = vi.fn();
  lib._registerWithBackend = vi.fn();
  lib._applyFilters = vi.fn();
  // Keep the background validators' promises so a test can wait for them.
  lib._validateAssociationsInBackground = function () {
    return (lib._assocCheck = Library.prototype._validateAssociationsInBackground.call(this));
  };
  lib._validateManualVariantsInBackground = function () {
    return (lib._variantCheck = Library.prototype._validateManualVariantsInBackground.call(this));
  };
  await lib.ensureScanned({ forceRescan: true });
  await lib._assocCheck;
  await lib._variantCheck;
  return lib;
}

const video = (lib) => lib.getVideoByPath(VIDEO);

async function play(lib) {
  const { funscriptData, variants } = await lib.resolvePlayData(video(lib));
  return { text: funscriptData?.textContent ?? null, file: funscriptData?._funscriptPath ?? null, variants };
}

describe('a single association over the video\'s own sidecar (R4-06)', () => {
  it('a scan plays the associated script and the editor gets its path', async () => {
    const lib = await boot();
    const got = await play(lib);
    expect(got.text).toBe(ASSOC_TEXT);
    expect(got.file).toBe(ASSOC);
    expect(video(lib).funscriptPath).toBe(ASSOC);
  });

  it('the variant list leads with the associated script and keeps the sidecar selectable after it', async () => {
    const lib = await boot();
    const { variants } = await play(lib);
    expect(variants.map((v) => v.path)).toEqual([ASSOC, SIDECAR]);
    expect(variants[0].label).toBe('Assoc For Alpha');
  });

  it('a reload (config read back, a new scan) still plays it, and the stored association is unchanged', async () => {
    await boot();
    const before = structuredClone(stored.library.associations);
    const lib = await boot();
    const got = await play(lib);
    expect(got.text).toBe(ASSOC_TEXT);
    expect(got.file).toBe(ASSOC);
    expect(stored.library.associations).toEqual(before);
    expect(stored.library.associations[VIDEO]).toMatchObject({ active: 'single', single: ASSOC });
  });

  it('opening the variant menu (a fresh folder scan) keeps the associated script first', async () => {
    const lib = await boot();
    const App = liftAppClass(['_refreshCurrentVariantsFromDisk'], {});
    const app = new App();
    app.library = lib;
    app._currentVideoPath = VIDEO;
    app._currentVariants = (await play(lib)).variants;
    app._updateVariantSelector = vi.fn();
    await app._refreshCurrentVariantsFromDisk();
    expect(app._currentVariants.map((v) => v.path)).toEqual([ASSOC, SIDECAR]);
  });

  it('the card read (heatmap / speed stats) reads the associated script', async () => {
    const lib = await boot();
    await expect(lib._readFunscriptResilient(video(lib))).resolves.toBe(ASSOC_TEXT);
  });

  it('an association to the sidecar itself (an EroScripts download) plays the sidecar with the scan\'s variants', async () => {
    stored.library.associations[VIDEO] = singleEntry(SIDECAR);
    const lib = await boot();
    const got = await play(lib);
    expect(got.text).toBe(SIDECAR_TEXT);
    expect(got.variants.map((v) => v.path)).toEqual([SIDECAR]);
  });
});

describe('the associated file missing: the sidecar plays for now, the association is kept (R4-06)', () => {
  it('deleted (its folder answers): kept, never pruned, the video plays its sidecar', async () => {
    files.delete(ASSOC);
    const lib = await boot();
    expect(stored.library.associations[VIDEO]).toMatchObject({ active: 'single', single: ASSOC });
    const got = await play(lib);
    expect(got.text).toBe(SIDECAR_TEXT);
    expect(got.file).toBe(SIDECAR);
    expect(got.variants.map((v) => v.path)).toEqual([SIDECAR]);
    // The phone and VR are told about the sidecar.
    expect(lib._registerWithBackend).toHaveBeenCalled();
  });

  it('and when the file is back, the next scan plays the association again', async () => {
    files.delete(ASSOC);
    await boot();
    files.set(ASSOC, ASSOC_TEXT);
    const lib = await boot();
    const got = await play(lib);
    expect(got.text).toBe(ASSOC_TEXT);
    expect(got.file).toBe(ASSOC);
  });

  it('unreadable (no answer): the open plays the sidecar, nothing is pruned', async () => {
    unknown.add(ASSOC);
    const lib = await boot();
    const got = await play(lib);
    expect(got.text).toBe(SIDECAR_TEXT);
    expect(got.file).toBe(SIDECAR);
    expect(stored.library.associations[VIDEO]).toMatchObject({ active: 'single', single: ASSOC });
  });

  it('missing mid-session: the card read falls back to the sidecar and prunes nothing', async () => {
    const lib = await boot();
    files.delete(ASSOC);
    await expect(lib._readFunscriptResilient(video(lib))).resolves.toBe(SIDECAR_TEXT);
    // Let the guarded prune (if any) run.
    await new Promise((r) => setTimeout(r, 0));
    expect(stored.library.associations[VIDEO]).toMatchObject({ active: 'single', single: ASSOC });
    expect(video(lib).funscriptPath).toBe(SIDECAR);
  });

  // R4-06 fix-up (real-app verifier 2, after Ctrl+R and after a relaunch,
  // 4/4): the scan's validator fell back to the sidecar while a card read of
  // the associated file was still out; that read then failed, could not fall
  // back again (already done) and cleared the video: no script at all.
  it.each([
    ['the card read (heatmap / speed stats)', 'card'],
    ['an open (resolvePlayData)', 'open'],
  ])('the validator falls back while %s of the missing file is in flight: the sidecar still plays', async (_label, route) => {
    const lib = await boot(); // the associated file is there at the scan
    expect(video(lib).funscriptPath).toBe(ASSOC);
    files.delete(ASSOC); // gone (renamed away)
    let finishRead;
    const held = new Promise((r) => { finishRead = r; });
    const real = window.funsync.readFunscript.getMockImplementation();
    let holding = true;
    window.funsync.readFunscript.mockImplementation(async (p) => {
      if (p === ASSOC && holding) { holding = false; return held; }
      return real(p);
    });
    const inFlight = route === 'card' ? lib._readFunscriptResilient(video(lib)) : play(lib);
    await new Promise((r) => setTimeout(r, 0));
    // The validator (a reload's background check) lands meanwhile.
    await lib._validateAssociationsInBackground();
    expect(video(lib).funscriptPath).toBe(SIDECAR);
    finishRead(null); // the held read of the associated file fails
    const got = await inFlight;
    if (route === 'card') expect(got).toBe(SIDECAR_TEXT);
    else expect(got.text).toBe(SIDECAR_TEXT);
    expect(video(lib).hasFunscript).toBe(true);
    expect(video(lib).funscriptPath).toBe(SIDECAR);
    // The next open plays the sidecar too, and the association is kept.
    window.funsync.readFunscript.mockImplementation(real);
    expect((await play(lib)).text).toBe(SIDECAR_TEXT);
    expect(stored.library.associations[VIDEO]).toMatchObject({ active: 'single', single: ASSOC });
  });

  // Rewritten 2026-11-18 (Dave, "Stop pruning"): this pinned "a provably
  // deleted script is still cleared". It is kept now, with or without a
  // sidecar; without one the video stays paired and its card says "Script
  // not found" (video-options-library.test.js pins the card and the dialog).
  it('a video WITHOUT its own sidecar keeps it too: a provably deleted script is never cleared', async () => {
    files.delete(ASSOC);
    files.delete(SIDECAR);
    window.funsync.scanDirectory.mockImplementation(async () => {
      const r = scanResult();
      Object.assign(r.videos[0], { hasFunscript: false, funscriptPath: null, variants: [] });
      r.allFunscripts = [];
      return r;
    });
    const lib = await boot();
    expect(stored.library.associations[VIDEO]).toMatchObject({ active: 'single', single: ASSOC });
    expect(video(lib)).toMatchObject({ hasFunscript: true, funscriptPath: ASSOC });
  });
});

describe('Remove gives the video its own script back (R4-06)', () => {
  it('the sidecar plays at once, without a rescan', async () => {
    const lib = await boot();
    const card = document.createElement('div');
    lib._removeAssociation(video(lib), card);
    expect(stored.library.associations[VIDEO]).toBeUndefined();
    const got = await play(lib);
    expect(got.text).toBe(SIDECAR_TEXT);
    expect(got.file).toBe(SIDECAR);
  });
});
