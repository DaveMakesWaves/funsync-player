// FT-043: a script the app EXPECTED to load, but could not find, left no trace
// in main.log above debug.
//
// V57 (app test 2026-11-02) moved `read-funscript`'s ENOENT line from error to
// debug, because most reads are PROBES: playlist, category and library cards
// read the sibling `<video>.funscript` of every entry just to pick a badge, and
// a scriptless video is not a failure. main.js cannot tell a probe from a read
// that expected a script, so the two resilient readers, which only ever read a
// STORED path (an association, a variant, a route, an axis), now say it: one
// `[Script] expected script not found: <path>` warn per path per session.
//
// Driven through the REAL readers with a bridge whose reads all miss and a
// library whose `_safeToPrune` says no (the file's location is in doubt), so
// the warn is checked on the very branch that must also keep the user's data.
//
// jsdom (no docblock): library.js imports i18n.js, which branches on
// `typeof window` — see notes/CLAUDE.md "Test environments".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Library } from '../../renderer/components/library.js';
import { liftAppClass } from './helpers/app-methods.js';
import { buildAssociationEntry } from '../../renderer/js/association-shape.js';

const VIDEO = 'C:\\Lib\\Clip.mp4';
const SCRIPT = 'C:\\Scripts\\Clip.funscript';
const OTHER = 'C:\\Scripts\\Other.funscript';

let warn;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  delete window.funsync;
});

/** Reads answer from `disk` (path -> content); anything else misses (null).
 *  `status` is what the existence probe says of a path not on `disk`: false
 *  (provably gone, the default: these tests are about MISSING scripts), true
 *  (there but unreadable) or null (unknown). C-09: the library's warn asks. */
function installBridge(disk = {}, status = false) {
  window.funsync = {
    readFunscript: vi.fn(async (p) => (p in disk ? disk[p] : null)),
    filesExist: vi.fn(async (list) => list.map((p) => (p in disk ? true : status))),
    fileExists: vi.fn(async () => false),
  };
}

/** The library's warn waits on that probe (C-09). */
const settle = () => new Promise((r) => setTimeout(r, 0));

function fakeSettings(initial) {
  const store = structuredClone(initial);
  return {
    store,
    get: (k) => store[k],
    set: vi.fn((k, v) => { store[k] = structuredClone(v); }),
  };
}

const missWarns = () => warn.mock.calls.filter((c) => String(c[0]).startsWith('[Script] expected script not found'));

describe('App._readScriptResilient', () => {
  const ReaderApp = liftAppClass(['_readScriptResilient'], {});

  function makeApp() {
    const settings = fakeSettings({
      'library.manualVariants': { [VIDEO]: [{ path: SCRIPT, name: 'Soft' }] },
    });
    const library = { _safeToPrune: vi.fn(async () => false) };
    return Object.assign(new ReaderApp(), { settings, library });
  }

  it('warns once, naming the path, when a stored script is missing', async () => {
    installBridge();
    const app = makeApp();
    await expect(app._readScriptResilient(SCRIPT, VIDEO)).resolves.toBeNull();
    const w = missWarns();
    expect(w).toHaveLength(1);
    expect(w[0]).toEqual(['[Script] expected script not found:', SCRIPT]);
    // Nothing prunes a variation (2026-11-18, Dave: "Yes, stop those too"): it is still there.
    expect(app.settings.set).not.toHaveBeenCalled();
    expect(app.settings.store['library.manualVariants'][VIDEO]).toHaveLength(1);
  });

  it('there but unreadable (locked, no permission): says so, not "not found" (C-09, triage 2026-11-23)', async () => {
    installBridge();
    const app = makeApp();
    app.library._pathStatus = vi.fn(async () => true);
    await expect(app._readScriptResilient(SCRIPT, VIDEO)).resolves.toBeNull();
    expect(missWarns()).toEqual([]);
    expect(warn.mock.calls.filter((c) => String(c[0]).startsWith('[Script] expected script is there'))).toEqual([
      ['[Script] expected script is there but could not be read:', SCRIPT],
    ]);
    expect(app.library._pathStatus).toHaveBeenCalledWith(SCRIPT);
  });

  it('does not warn again for the same path, but does for a new one', async () => {
    installBridge();
    const app = makeApp();
    await app._readScriptResilient(SCRIPT, VIDEO);
    await app._readScriptResilient(SCRIPT, VIDEO);
    await app._readScriptResilient(SCRIPT, null);
    expect(missWarns()).toHaveLength(1);
    await app._readScriptResilient(OTHER, VIDEO);
    expect(missWarns().map((c) => c[1])).toEqual([SCRIPT, OTHER]);
  });

  it('stays quiet when the script reads, or is recovered next to the video', async () => {
    installBridge({ [SCRIPT]: '{"actions":[]}', 'C:\\Lib\\Moved.funscript': '{"actions":[]}' });
    const app = makeApp();
    await expect(app._readScriptResilient(SCRIPT, VIDEO)).resolves.toMatchObject({ recoveredPath: null });
    await expect(app._readScriptResilient('C:\\Old\\Moved.funscript', VIDEO))
      .resolves.toMatchObject({ recoveredPath: 'C:\\Lib\\Moved.funscript' });
    expect(missWarns()).toHaveLength(0);
  });
});

describe('Library._readFunscriptResilient', () => {
  function makeLibrary() {
    const lib = Object.create(Library.prototype);
    lib._settings = fakeSettings({
      'library.associations': { [VIDEO]: buildAssociationEntry('single', SCRIPT, null, null) },
    });
    lib._videos = [{ path: VIDEO }];
    lib._unavailablePaths = new Set();
    lib._failedScanPaths = new Set();
    lib._scannedSourceRoots = [];
    lib._allFunscripts = [];
    lib._safeToPrune = vi.fn(async () => false);
    return lib;
  }
  const card = (funscriptPath = SCRIPT) => ({ path: VIDEO, hasFunscript: true, funscriptPath });

  it('warns once, naming the path, when the paired script is missing', async () => {
    installBridge();
    const lib = makeLibrary();
    await expect(lib._readFunscriptResilient(card())).resolves.toBeNull();
    await settle();
    const w = missWarns();
    expect(w).toHaveLength(1);
    expect(w[0]).toEqual(['[Script] expected script not found:', SCRIPT]);
    // _safeToPrune said no: the pairing is kept.
    expect(lib._settings.set).not.toHaveBeenCalled();
    expect(lib._settings.store['library.associations'][VIDEO].single).toBe(SCRIPT);
  });

  it('does not warn again when a later scan hands it a fresh card for the same path', async () => {
    installBridge();
    const lib = makeLibrary();
    await lib._readFunscriptResilient(card());
    await lib._readFunscriptResilient(card());
    await settle();
    expect(missWarns()).toHaveLength(1);
    await lib._readFunscriptResilient(card(OTHER));
    await settle();
    expect(missWarns().map((c) => c[1])).toEqual([SCRIPT, OTHER]);
  });

  it('stays quiet when the script reads, and for a card with no script at all', async () => {
    installBridge({ [SCRIPT]: '{"actions":[]}' });
    const lib = makeLibrary();
    await expect(lib._readFunscriptResilient(card())).resolves.toBe('{"actions":[]}');
    await expect(lib._readFunscriptResilient({ path: VIDEO, hasFunscript: false, funscriptPath: null }))
      .resolves.toBeNull();
    await settle();
    expect(missWarns()).toHaveLength(0);
  });
});

// Verifier 2 (2026-11-05): OPENING the video was the one expected read the
// fix missed. Square OU's associated script was moved out of the library and
// the card opened twice: only `[debug] read-funscript: no file`, no warn. The
// open reads `video.funscriptPath` directly in `resolvePlayData` (shared by a
// click and every Play All item); the warn came only later, from a rescan's
// card read. Driven through the REAL `_playVideo`, as a click opens it.
describe('Library open (_playVideo -> resolvePlayData)', () => {
  function makeOpenLibrary() {
    const played = [];
    const lib = new Library({
      settings: fakeSettings({ 'library.associations': { [VIDEO]: buildAssociationEntry('single', SCRIPT, null, null) } }),
      onPlayVideo: (fileData, funscriptData) => played.push({ fileData, funscriptData }),
    });
    const video = { name: 'Clip.mp4', path: VIDEO, hasFunscript: true, funscriptPath: SCRIPT };
    lib._videos = [video];
    return { lib, video, played };
  }

  it('opening a video whose paired script is gone warns once, naming it; the video still opens', async () => {
    installBridge();
    const { lib, video, played } = makeOpenLibrary();
    await lib._playVideo(video);
    await lib._playVideo(video);
    expect(played).toHaveLength(2);
    expect(played[0].fileData.path).toBe(VIDEO);
    expect(played[0].funscriptData).toBeNull();
    await settle();
    expect(missWarns()).toEqual([['[Script] expected script not found:', SCRIPT]]);
  });

  it('the open and a later card read of the same path share the one warn', async () => {
    installBridge();
    const { lib, video } = makeOpenLibrary();
    lib._unavailablePaths = new Set();
    lib._failedScanPaths = new Set();
    lib._scannedSourceRoots = [];
    lib._allFunscripts = [];
    lib._safeToPrune = vi.fn(async () => false);
    await lib._playVideo(video);
    await lib._readFunscriptResilient({ ...video });
    await settle();
    expect(missWarns()).toHaveLength(1);
  });

  it('stays quiet when the script reads, and when the video has no script to expect', async () => {
    installBridge({ [SCRIPT]: '{"actions":[]}' });
    const { lib, video, played } = makeOpenLibrary();
    await lib._playVideo(video);
    expect(played[0].funscriptData?.textContent).toBe('{"actions":[]}');
    await lib._playVideo({ name: 'Bare.mp4', path: 'C:\Lib\Bare.mp4', hasFunscript: false, funscriptPath: null });
    await settle();
    expect(missWarns()).toHaveLength(0);
    // The scriptless open looks only for a `<name>.funscript` added since
    // the last scan, once, and its miss says nothing (FT-069; this line used
    // to pin "the scriptless open reads nothing").
    expect(window.funsync.readFunscript).toHaveBeenCalledTimes(2);
    expect(window.funsync.readFunscript.mock.calls[1][0]).toBe('C:LibBare.funscript');
    expect(warn).not.toHaveBeenCalled();
  });
});

// C-09 (cosmetic, log only): `read-funscript` answers null for a missing file
// AND for one it cannot read, and the library's warn said "not found" for
// both. An associated script behind a deny ACL was logged
// `[Script] expected script not found` right after main's
// `read-funscript failed: EPERM`. The warn now asks the path's status first.
describe('C-09: an unreadable script is not logged as "not found"', () => {
  const unreadWarns = () => warn.mock.calls.filter((c) => String(c[0]).startsWith('[Script] expected script could not be read'));
  function makeLibrary() {
    const lib = Object.create(Library.prototype);
    lib._settings = fakeSettings({
      'library.associations': { [VIDEO]: buildAssociationEntry('single', SCRIPT, null, null) },
    });
    lib._videos = [{ path: VIDEO }];
    lib._unavailablePaths = new Set();
    lib._failedScanPaths = new Set();
    lib._scannedSourceRoots = [];
    lib._allFunscripts = [];
    lib._safeToPrune = vi.fn(async () => false);
    return lib;
  }
  const card = () => ({ path: VIDEO, hasFunscript: true, funscriptPath: SCRIPT });

  it('a script that is there but cannot be read (EPERM) says "could not be read", once', async () => {
    installBridge({}, true);                  // the probe finds it; the read fails
    const lib = makeLibrary();
    await lib._readFunscriptResilient(card());
    await lib._readFunscriptResilient(card());
    await settle();
    expect(missWarns()).toEqual([]);
    expect(unreadWarns()).toEqual([['[Script] expected script could not be read:', SCRIPT]]);
  });

  it('a script whose location does not answer (unknown) is not called missing either', async () => {
    installBridge({}, null);
    const lib = makeLibrary();
    await lib._readFunscriptResilient(card());
    await settle();
    expect(missWarns()).toEqual([]);
    expect(unreadWarns()).toHaveLength(1);
  });

  it('the open says the same as the card read', async () => {
    installBridge({}, true);
    const lib = new Library({
      settings: fakeSettings({ 'library.associations': { [VIDEO]: buildAssociationEntry('single', SCRIPT, null, null) } }),
      onPlayVideo: () => {},
    });
    const video = { name: 'Clip.mp4', path: VIDEO, hasFunscript: true, funscriptPath: SCRIPT };
    lib._videos = [video];
    await lib._playVideo(video);
    await settle();
    expect(missWarns()).toEqual([]);
    expect(unreadWarns()).toEqual([['[Script] expected script could not be read:', SCRIPT]]);
  });
});
