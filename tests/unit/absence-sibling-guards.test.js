// Absence is never destructive: the paths V01's sibling sweep found.
//
// App test V01 (2026-11-02, critical) was the category view treating an
// unplugged drive as deleted files. The review of that fix swept every other
// "a file did not answer, so change the user's data" path, and found the same
// mistake in four more places, all present in v0.9.2:
//
//   1. library.js `_readFunscriptResilient` pruned a video's association
//      whenever both reads of its script failed. `read-funscript` returns null
//      for ANY error, and the only guard was on the VIDEO's path. A C: video
//      paired with a script on an unplugged D: lost its pairing as soon as its
//      card scrolled into view: the 2026-08-11 incident shape, one call away
//      from the validator that had been fixed for it.
//   2. Subtitle associations still used the first-basename-match-wins loop
//      that association-rehome.js was written to replace: an unplugged drive's
//      subtitle moved onto a same-named copy elsewhere, and was deleted.
//   3. app.js `library.manualVariants` / `library.preferredVariants` re-homes
//      counted an offline drive's videos as orphans and deleted their keys.
//   4. The Orgasm Switch finisher was re-pointed at any same-named library
//      file whenever it failed to load, offline drive included.
//
// Plus the validators and `_safeToPrune` deciding "missing" with the singular
// file-exists IPC, which folds a TIMEOUT into false.
//
// 2026-11-18 (Dave, "Stop pruning"): an association is not pruned even when
// its script is provably gone; the tests that pinned that prune now pin the
// keep. Manual variants still use `_safeToPrune` as before.
//
// Every test here drives real code and asserts what happened to the stored
// data. jsdom (no docblock): library.js imports i18n.js, which branches on
// `typeof window` — see notes/CLAUDE.md "Test environments".
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Library } from '../../renderer/components/library.js';
import { liftAppClass } from './helpers/app-methods.js';
import { pickRehomeCandidate, findMovedFile } from '../../renderer/js/association-rehome.js';
import { buildAssociationEntry } from '../../renderer/js/association-shape.js';

afterEach(() => { delete window.funsync; });

/** DataService-shaped settings: get returns the live object, set records. */
function fakeSettings(initial) {
  const store = structuredClone(initial);
  return {
    store,
    get: (k) => store[k],
    set: vi.fn((k, v) => { store[k] = structuredClone(v); }),
  };
}

/**
 * Bridge where `status` maps a path to true / false / null (timed out).
 * Unlisted paths are absent. `fileExists` collapses null to false exactly as
 * main.js's singular `file-exists` handler does, so code that still asked it
 * would see a timeout as "missing" — which is the hole being pinned.
 */
function installBridge(status = {}) {
  const st = (p) => (p in status ? status[p] : false);
  window.funsync = {
    readFunscript: vi.fn(async () => null),
    filesExist: vi.fn(async (list) => list.map(st)),
    fileExists: vi.fn(async (p) => st(p) === true),
  };
}

/** A real Library (prototype methods intact) without running its constructor. */
function makeLibrary({
  settings = {}, videos = [], unavailable = [], scannedRoots = [], funscripts = [],
} = {}) {
  const lib = Object.create(Library.prototype);
  lib._settings = fakeSettings(settings);
  lib._videos = videos.map((p) => ({ path: p }));
  lib._unavailablePaths = new Set(unavailable);
  lib._failedScanPaths = new Set();
  lib._scannedSourceRoots = scannedRoots;
  lib._allFunscripts = funscripts.map((p) => ({ path: p, name: p.split(/[\\/]/).pop() }));
  return lib;
}

const single = (p) => buildAssociationEntry('single', p, null, null);

// ---------------------------------------------------------------------------
// 1. A failed script READ prunes nothing unless the script is provably gone.
// ---------------------------------------------------------------------------
describe('_readFunscriptResilient: a failed read is not a deleted script', () => {
  const VIDEO = 'C:\\Videos\\v.mp4';
  const SCRIPT = 'D:\\Scripts\\v.funscript';

  async function readFails({ status, unavailable = [], funscriptPath = SCRIPT, stored = SCRIPT }) {
    installBridge(status);
    const lib = makeLibrary({
      settings: { 'library.associations': { [VIDEO]: single(stored) } },
      unavailable,
    });
    const video = { path: VIDEO, hasFunscript: true, funscriptPath };
    const content = await lib._readFunscriptResilient(video);
    return { lib, video, content };
  }

  it('keeps the association when the SCRIPT is on an offline source (video is fine)', async () => {
    const { lib, video, content } = await readFails({
      status: { 'D:\\Scripts': true }, unavailable: ['D:\\Scripts'],
    });
    expect(content).toBeNull();
    expect(lib._settings.set).not.toHaveBeenCalled();
    expect(lib._settings.store['library.associations'][VIDEO].single).toBe(SCRIPT);
    // It stays paired on screen (2026-11-18, Dave "Stop pruning"): marked
    // "Can't check the script right now" for this session, which also stops
    // the retries. It used to be dropped from the video for the session.
    expect(video).toMatchObject({ hasFunscript: true, funscriptPath: SCRIPT, _scriptMissing: SCRIPT });
    expect(lib._scriptMissingStatus(video)).toBe('unknown');
  });

  it("keeps it when the script's folder does not answer (drive unplugged, not a source)", async () => {
    const { lib } = await readFails({ status: {} });
    expect(lib._settings.set).not.toHaveBeenCalled();
    expect(lib._settings.store['library.associations'][VIDEO].single).toBe(SCRIPT);
  });

  it('keeps it when the file check timed out', async () => {
    const { lib } = await readFails({ status: { [SCRIPT]: null, 'D:\\Scripts': true } });
    expect(lib._settings.set).not.toHaveBeenCalled();
  });

  it('keeps it when the file is still there and only the read failed (locked)', async () => {
    const { lib } = await readFails({ status: { [SCRIPT]: true, 'D:\\Scripts': true } });
    expect(lib._settings.set).not.toHaveBeenCalled();
  });

  it('keeps the stored script when the read that failed was a DIFFERENT one', async () => {
    // e.g. an auto-paired file that vanished; the user's own pick is healthy.
    const { lib } = await readFails({
      status: { 'C:\\Videos': true, 'D:\\Scripts': true, [SCRIPT]: true },
      funscriptPath: 'C:\\Videos\\v.funscript',
    });
    expect(lib._settings.set).not.toHaveBeenCalled();
    expect(lib._settings.store['library.associations'][VIDEO].single).toBe(SCRIPT);
  });

  // Rewritten 2026-11-18 (Dave, "Stop pruning"): this was "prunes only when
  // the folder answers and the file is definitely gone". A pairing is never
  // removed because its script is missing; the card says "Script not found".
  it('keeps it even when the folder answers and the file is definitely gone; the video says "Script not found"', async () => {
    const { lib, video } = await readFails({ status: { 'D:\\Scripts': true } });
    expect(lib._settings.set).not.toHaveBeenCalled();
    expect(lib._settings.store['library.associations'][VIDEO].single).toBe(SCRIPT);
    expect(video).toMatchObject({ hasFunscript: true, funscriptPath: SCRIPT });
    expect(lib._scriptMissingStatus(video)).toBe('missing');
  });
});

// ---------------------------------------------------------------------------
// 2. Subtitle associations re-home under the guarded planner.
// ---------------------------------------------------------------------------
describe('subtitle re-home: offline and live entries are never taken', () => {
  function scan({ videos, subs, unavailable = [], scannedRoots = [] }) {
    const lib = makeLibrary({
      settings: { 'library.associations': {}, 'library.subtitleAssociations': subs },
      videos, unavailable, scannedRoots,
    });
    lib._autoPromoteEligibleVideos = () => 0;
    lib._validateAssociationsInBackground = () => {};
    lib._validateManualVariantsInBackground = () => {};
    lib._applyManualAssociations();
    return lib;
  }

  it("does not move an unplugged drive's subtitle onto a same-named copy", async () => {
    const lib = scan({
      videos: ['C:\\Downloads\\x.mp4'],
      subs: { 'E:\\VR\\x.mp4': 'E:\\VR\\x.srt' },
      unavailable: ['E:\\VR'],
    });
    expect(lib._settings.store['library.subtitleAssociations']).toEqual({ 'E:\\VR\\x.mp4': 'E:\\VR\\x.srt' });
    expect(lib._videos[0].hasSubtitle).toBeFalsy();
  });

  it('does not take a LIVE video\'s subtitle for a same-named video without one', async () => {
    const lib = scan({
      videos: ['C:\\A\\x.mp4', 'C:\\B\\x.mp4'],
      subs: { 'C:\\A\\x.mp4': 'C:\\A\\x.srt' },
    });
    expect(lib._settings.store['library.subtitleAssociations']).toEqual({ 'C:\\A\\x.mp4': 'C:\\A\\x.srt' });
    expect(lib._videos[0].subtitlePath).toBe('C:\\A\\x.srt');
    expect(lib._videos[1].hasSubtitle).toBeFalsy();
  });

  it('moves the subtitle when the scan proves the old file is gone', async () => {
    const lib = scan({
      videos: ['C:\\New\\x.mp4'],
      subs: { 'C:\\Old\\x.mp4': 'C:\\Old\\x.srt' },
      scannedRoots: ['C:\\Old', 'C:\\New'],
    });
    expect(lib._settings.store['library.subtitleAssociations']).toEqual({ 'C:\\New\\x.mp4': 'C:\\Old\\x.srt' });
    expect(lib._videos[0].subtitlePath).toBe('C:\\Old\\x.srt');
  });

  it('COPIES (keeps the original) when the old source was removed rather than walked', async () => {
    const lib = scan({
      videos: ['C:\\New\\x.mp4'],
      subs: { 'F:\\Removed\\x.mp4': 'F:\\Removed\\x.srt' },
      scannedRoots: ['C:\\New'],
    });
    expect(lib._settings.store['library.subtitleAssociations']).toEqual({
      'F:\\Removed\\x.mp4': 'F:\\Removed\\x.srt',
      'C:\\New\\x.mp4': 'F:\\Removed\\x.srt',
    });
  });
});

// ---------------------------------------------------------------------------
// 5. The validators: a check that timed out is unknown, not missing.
// ---------------------------------------------------------------------------
describe('background validators: a timed-out check prunes nothing', () => {
  const VIDEO = 'C:\\Videos\\v.mp4';
  const SCRIPT = '\\\\nas\\share\\v.funscript';

  it('association validator leaves the entry when the script check times out', async () => {
    installBridge({ [SCRIPT]: null, '\\\\nas\\share': true });
    const lib = makeLibrary({ settings: { 'library.associations': { [VIDEO]: single(SCRIPT) } } });
    await lib._validateAssociationsInBackground();
    expect(lib._settings.set).not.toHaveBeenCalled();
    expect(lib._settings.store['library.associations'][VIDEO].single).toBe(SCRIPT);
  });

  // Rewritten 2026-11-18 (Dave, "Stop pruning"): this pinned "still prunes a
  // definite miss in a folder that answers".
  it('association validator keeps a definite miss in a folder that answers too', async () => {
    installBridge({ '\\\\nas\\share': true });
    const lib = makeLibrary({ settings: { 'library.associations': { [VIDEO]: single(SCRIPT) } } });
    await lib._validateAssociationsInBackground();
    expect(lib._settings.set).not.toHaveBeenCalled();
    expect(lib._settings.store['library.associations'][VIDEO].single).toBe(SCRIPT);
  });

  it('variant validator leaves a variant whose check timed out', async () => {
    installBridge({ [SCRIPT]: null, '\\\\nas\\share': true });
    const variants = { [VIDEO]: [{ label: 'Soft', path: SCRIPT, name: 'v.funscript' }] };
    const lib = makeLibrary({ settings: { 'library.manualVariants': variants } });
    await lib._validateManualVariantsInBackground();
    expect(lib._settings.set).not.toHaveBeenCalled();
    expect(lib._settings.store['library.manualVariants']).toEqual(variants);
  });

  // Rewritten 2026-11-18 (Dave, "Yes, stop those too"): this pinned "still
  // prunes a definite miss in a folder that answers".
  it('variant validator keeps a definite miss in a folder that answers too', async () => {
    installBridge({ '\\\\nas\\share': true });
    const variants = { [VIDEO]: [{ label: 'Soft', path: SCRIPT, name: 'v.funscript' }] };
    const lib = makeLibrary({ settings: { 'library.manualVariants': variants } });
    await lib._validateManualVariantsInBackground();
    expect(lib._settings.set).not.toHaveBeenCalled();
    expect(lib._settings.store['library.manualVariants']).toEqual(variants);
  });
});

// ---------------------------------------------------------------------------
// 3 + 4. app.js — the REAL methods, compiled out of the source.
// ---------------------------------------------------------------------------

const APP_SRC = fs.readFileSync('renderer/js/app.js', 'utf8');

/**
 * Compile one method out of app.js. app.js instantiates `new App()` when
 * imported, so it cannot be loaded in a test — but its method bodies can, and
 * running them is what lets these tests assert behaviour instead of text.
 * Throws if the method is renamed or moved, rather than silently passing.
 */
function appMethod(name, deps) {
  const m = new RegExp(`\\n  (async )?${name}\\(`).exec(APP_SRC);
  if (!m) throw new Error(`app.js: method ${name}( not found`);
  const start = m.index + 1;
  let i = APP_SRC.indexOf('(', start);
  for (let depth = 0; i < APP_SRC.length; i++) {
    if (APP_SRC[i] === '(') depth++;
    else if (APP_SRC[i] === ')' && --depth === 0) break;
  }
  i = APP_SRC.indexOf('{', i);
  let depth = 0;
  let quote = null;
  for (; i < APP_SRC.length; i++) {
    const c = APP_SRC[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') { quote = c; continue; }
    if (c === '/' && APP_SRC[i + 1] === '/') { i = APP_SRC.indexOf('\n', i); continue; }
    if (c === '/' && APP_SRC[i + 1] === '*') { i = APP_SRC.indexOf('*/', i) + 1; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) break;
  }
  const names = Object.keys(deps);
  // eslint-disable-next-line no-new-func
  const holder = new Function(...names, `return ({ ${APP_SRC.slice(start, i + 1)} });`)(
    ...names.map((n) => deps[n]),
  );
  if (typeof holder[name] !== 'function') throw new Error(`app.js: could not compile ${name}`);
  return holder[name];
}

const APP_DEPS = {
  pickRehomeCandidate, findMovedFile, buildAssociationEntry, showToast: () => {}, t: (k) => k,
};
const APP_METHODS = [
  '_planLazyRehome', '_manualVariantsFor', '_getPreferredVariantLabel',
  '_recoverOrgasmPaths', '_saveOrgasmConfigQuiet',
];

function makeApp({ settings, library }) {
  const app = { settings: fakeSettings(settings), library };
  for (const name of APP_METHODS) app[name] = appMethod(name, APP_DEPS);
  return app;
}

describe('manualVariants / preferredVariants re-home at playback time', () => {
  const NOW = 'C:\\Downloads\\scene.mp4';
  const OFFLINE = 'E:\\VR\\scene.mp4';
  const VARIANTS = [{ label: 'Soft', path: 'E:\\VR\\scene.soft.funscript', name: 'scene.soft.funscript' }];

  it('leaves an OFFLINE video\'s variants where they are', () => {
    const library = makeLibrary({ videos: [NOW], unavailable: ['E:\\VR'] });
    const app = makeApp({ settings: { 'library.manualVariants': { [OFFLINE]: VARIANTS } }, library });
    expect(app._manualVariantsFor(NOW)).toEqual([]);
    expect(app.settings.set).not.toHaveBeenCalled();
    expect(app.settings.store['library.manualVariants']).toEqual({ [OFFLINE]: VARIANTS });
  });

  it('leaves an OFFLINE video\'s pinned variant where it is', () => {
    const library = makeLibrary({ videos: [NOW], unavailable: ['E:\\VR'] });
    const app = makeApp({ settings: { 'library.preferredVariants': { [OFFLINE]: 'Soft' } }, library });
    expect(app._getPreferredVariantLabel(NOW)).toBeNull();
    expect(app.settings.set).not.toHaveBeenCalled();
    expect(app.settings.store['library.preferredVariants']).toEqual({ [OFFLINE]: 'Soft' });
  });

  it('MOVES both when the scan proves the old file is gone', () => {
    const OLD = 'C:\\Old\\scene.mp4';
    const library = makeLibrary({ videos: [NOW], scannedRoots: ['C:\\Old', 'C:\\Downloads'] });
    const app = makeApp({
      settings: {
        'library.manualVariants': { [OLD]: VARIANTS },
        'library.preferredVariants': { [OLD]: 'Soft' },
      },
      library,
    });
    expect(app._manualVariantsFor(NOW)).toEqual(VARIANTS);
    expect(app._getPreferredVariantLabel(NOW)).toBe('Soft');
    expect(app.settings.store['library.manualVariants']).toEqual({ [NOW]: VARIANTS });
    expect(app.settings.store['library.preferredVariants']).toEqual({ [NOW]: 'Soft' });
  });

  it('COPIES both when the old source was removed rather than walked', () => {
    const OLD = 'F:\\Removed\\scene.mp4';
    const library = makeLibrary({ videos: [NOW], scannedRoots: ['C:\\Downloads'] });
    const app = makeApp({
      settings: {
        'library.manualVariants': { [OLD]: VARIANTS },
        'library.preferredVariants': { [OLD]: 'Soft' },
      },
      library,
    });
    const got = app._manualVariantsFor(NOW);
    expect(got).toEqual(VARIANTS);
    expect(app._getPreferredVariantLabel(NOW)).toBe('Soft');
    expect(app.settings.store['library.manualVariants']).toEqual({ [OLD]: VARIANTS, [NOW]: VARIANTS });
    expect(app.settings.store['library.preferredVariants']).toEqual({ [OLD]: 'Soft', [NOW]: 'Soft' });
    // The copy is its own list: healing one must not edit the other in place.
    expect(got).not.toBe(app.settings.get('library.manualVariants')[OLD]);
  });
});

describe('Orgasm Switch finisher recovery re-points only a provably-gone script', () => {
  const MINE = 'D:\\Finishers\\finish.funscript';
  const COPY = 'C:\\Library\\finish.funscript';

  function appFor({ status, unavailable = [] }) {
    installBridge(status);
    const library = makeLibrary({ funscripts: [COPY], unavailable });
    const app = makeApp({
      settings: { 'player.orgasmConfig': single(MINE), 'player.orgasmScript': MINE },
      library,
    });
    app._orgasmEntry = single(MINE);
    return app;
  }

  it('does not touch the config when its drive is an offline source', async () => {
    const app = appFor({ status: { 'D:\\Finishers': true }, unavailable: ['D:\\Finishers'] });
    await expect(app._recoverOrgasmPaths([MINE])).resolves.toBe(false);
    expect(app.settings.set).not.toHaveBeenCalled();
  });

  it('does not touch it when the folder does not answer (unplugged, not a source)', async () => {
    const app = appFor({ status: {} });
    await expect(app._recoverOrgasmPaths([MINE])).resolves.toBe(false);
    expect(app.settings.set).not.toHaveBeenCalled();
  });

  it('does not touch it when the file is there but would not load (locked / bad JSON)', async () => {
    const app = appFor({ status: { [MINE]: true, 'D:\\Finishers': true } });
    await expect(app._recoverOrgasmPaths([MINE])).resolves.toBe(false);
    expect(app.settings.set).not.toHaveBeenCalled();
  });

  it('re-points when the folder answers and the file is definitely gone', async () => {
    const app = appFor({ status: { 'D:\\Finishers': true } });
    await expect(app._recoverOrgasmPaths([MINE])).resolves.toBe(true);
    expect(app.settings.store['player.orgasmConfig'].single).toBe(COPY);
    expect(app.settings.store['player.orgasmScript']).toBe(COPY);
  });

  it('does not write back a config the user replaced while the checks ran', async () => {
    const app = appFor({ status: { 'D:\\Finishers': true } });
    const newer = single('C:\\Other\\new.funscript');
    const realGuard = app.library._safeToPrune.bind(app.library);
    app.library._safeToPrune = async (p) => {
      app._orgasmEntry = newer; // a reload landed mid-check
      return realGuard(p);
    };
    await expect(app._recoverOrgasmPaths([MINE])).resolves.toBe(false);
    expect(app.settings.set).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// FT-003: app.js, a variation's script that cannot be read (the REAL reader).
// ---------------------------------------------------------------------------
//
// The player-side prune (both reads of a variant's script failed) was gated
// on `library._safeToPrune` and failed closed. Since 2026-11-18 (Dave: "Yes,
// stop those too") it is gone: `_readScriptResilient` changes nothing stored
// whatever the evidence, provably gone included; the video options say
// "Script not found" with Locate. Lifted out of app.js and run here.

const PruneApp = liftAppClass(['_readScriptResilient'], {});
const SCENE = 'C:\\Videos\\scene.mp4';

describe('app.js _readScriptResilient: a variation whose script cannot be read stays in manualVariants', () => {
  const GONE = 'D:\\Scripts\\scene.soft.funscript';
  const OTHER = 'D:\\Scripts\\scene.hard.funscript';
  const VARIANTS = {
    'C:\\Videos\\scene.mp4': [
      { label: 'Soft', path: GONE, name: 'scene.soft.funscript' },
      { label: 'Hard', path: OTHER, name: 'scene.hard.funscript' },
    ],
    'C:\\Videos\\scene (copy).mp4': [{ label: 'Soft', path: GONE, name: 'scene.soft.funscript' }],
  };

  function appFor({ status = {}, unavailable = [], withLibrary = true } = {}) {
    installBridge(status);
    return Object.assign(new PruneApp(), {
      settings: fakeSettings({ 'library.manualVariants': VARIANTS }),
      library: withLibrary ? makeLibrary({ unavailable }) : null,
    });
  }

  it('keeps every variant when the script is on an offline source', async () => {
    const app = appFor({ status: { 'D:\\Scripts': true }, unavailable: ['D:\\Scripts'] });
    await expect(app._readScriptResilient(GONE, SCENE)).resolves.toBeNull();
    expect(app.settings.set).not.toHaveBeenCalled();
    expect(app.settings.store['library.manualVariants']).toEqual(VARIANTS);
  });

  it("keeps them when the script's folder does not answer (unplugged, not a source)", async () => {
    const app = appFor({ status: {} });
    await expect(app._readScriptResilient(GONE, SCENE)).resolves.toBeNull();
    expect(app.settings.set).not.toHaveBeenCalled();
    expect(app.settings.store['library.manualVariants']).toEqual(VARIANTS);
  });

  it('keeps them when the file check timed out', async () => {
    const app = appFor({ status: { [GONE]: null, 'D:\\Scripts': true } });
    await expect(app._readScriptResilient(GONE, SCENE)).resolves.toBeNull();
    expect(app.settings.set).not.toHaveBeenCalled();
    expect(app.settings.store['library.manualVariants']).toEqual(VARIANTS);
  });

  it('keeps them when there is no library to ask (fails closed)', async () => {
    const app = appFor({ status: { 'D:\\Scripts': true }, withLibrary: false });
    await expect(app._readScriptResilient(GONE, SCENE)).resolves.toBeNull();
    expect(app.settings.set).not.toHaveBeenCalled();
    expect(app.settings.store['library.manualVariants']).toEqual(VARIANTS);
  });

  // Rewritten 2026-11-18 (Dave, "Yes, stop those too"): this pinned "prunes
  // that script from every video when its folder answers and the file is gone".
  it('keeps them even when its folder answers and the file is definitely gone', async () => {
    const app = appFor({ status: { 'D:\\Scripts': true, [OTHER]: true } });
    await expect(app.library._safeToPrune(GONE)).resolves.toBe(true);      // provably gone
    await expect(app._readScriptResilient(GONE, SCENE)).resolves.toBeNull();
    expect(app.settings.set).not.toHaveBeenCalled();
    expect(app.settings.store['library.manualVariants']).toEqual(VARIANTS);
  });
});

// ---------------------------------------------------------------------------
// FT-002: a permission-denied folder OUTSIDE every source is not absence.
// ---------------------------------------------------------------------------
//
// Inside a source, the scan's `skippedPaths` guards a folder it could not
// open (V04). A script kept outside every source had only the existence
// check, and `pathReachable` read EPERM (a file in a folder whose listing is
// denied) as "definitely absent" while the folder itself answered: the exact
// shape of a proven deletion. Real folders, a real deny rule, and the REAL
// electron/path-status.js behind the bridge, the way main.js's `files-exist`
// (kept tri-state) and `file-exists` (collapsed to a boolean) use it.

const requireCjs = createRequire(import.meta.url);
const { pathReachable } = requireCjs('../../electron/path-status.js');

const IS_WIN = process.platform === 'win32';
// root ignores POSIX permission bits, so a chmod'd folder is not denied.
const CAN_DENY = IS_WIN || (typeof process.getuid === 'function' && process.getuid() !== 0);

/** Deny listing (and reading) a folder for the current user; returns the undo. */
function denyFolder(dir) {
  if (IS_WIN) {
    const who = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
    execFileSync('icacls', [dir, '/deny', `${who}:(OI)(CI)(RX)`], { stdio: 'ignore' });
    return () => execFileSync('icacls', [dir, '/remove:d', who], { stdio: 'ignore' });
  }
  fs.chmodSync(dir, 0o000);
  return () => fs.chmodSync(dir, 0o755);
}

function installRealFsBridge() {
  window.funsync = {
    readFunscript: vi.fn(async () => null),
    filesExist: vi.fn(async (list) => Promise.all(list.map((p) => pathReachable(p)))),
    fileExists: vi.fn(async (p) => (await pathReachable(p)) === true),
  };
}

describe.runIf(CAN_DENY)('FT-002: a script in a permission-denied folder outside every source', () => {
  let root = null;
  let unlock = null;
  let VIDEO;
  let SCRIPT;

  function setUp({ lock }) {
    root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'funsync-denied-'));
    const videos = nodePath.join(root, 'videos');
    const locked = nodePath.join(root, 'outside', 'Locked');
    fs.mkdirSync(videos, { recursive: true });
    fs.mkdirSync(locked, { recursive: true });
    VIDEO = nodePath.join(videos, 'Clip.mp4');
    SCRIPT = nodePath.join(locked, 'x.funscript');
    fs.writeFileSync(VIDEO, 'v');
    fs.writeFileSync(SCRIPT, '{"actions":[]}');
    if (lock) unlock = denyFolder(locked);
    installRealFsBridge();
    // No sources at all: nothing the scan knows about guards this path.
    return makeLibrary({
      settings: {
        'library.associations': { [VIDEO]: single(SCRIPT) },
        'library.manualVariants': { [VIDEO]: [{ label: 'Soft', path: SCRIPT, name: 'x.funscript' }] },
      },
    });
  }

  afterEach(() => {
    if (unlock) { try { unlock(); } catch { /* best effort */ } unlock = null; }
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it('the association validator keeps the association', async () => {
    const lib = setUp({ lock: true });
    await lib._validateAssociationsInBackground();
    expect(lib._settings.set).not.toHaveBeenCalled();
    expect(lib._settings.store['library.associations'][VIDEO].single).toBe(SCRIPT);
  });

  it('a failed read on the card keeps it too', async () => {
    const lib = setUp({ lock: true });
    const video = { path: VIDEO, hasFunscript: true, funscriptPath: SCRIPT };
    await expect(lib._readFunscriptResilient(video)).resolves.toBeNull();
    expect(lib._settings.set).not.toHaveBeenCalled();
    expect(lib._settings.store['library.associations'][VIDEO].single).toBe(SCRIPT);
  });

  it('the variant validator and the player-side read keep the variant', async () => {
    const lib = setUp({ lock: true });
    const variants = structuredClone(lib._settings.store['library.manualVariants']);
    await lib._validateManualVariantsInBackground();
    const app = Object.assign(new PruneApp(), { settings: lib._settings, library: lib });
    await app._readScriptResilient(SCRIPT, VIDEO);
    expect(lib._settings.set).not.toHaveBeenCalled();
    expect(lib._settings.store['library.manualVariants']).toEqual(variants);
  });

  // Since 2026-11-18 (Dave, "Stop pruning", "Yes, stop those too") the
  // association and the variation are both kept here too. The proof still
  // says the file is gone, which keeps this a control that the folder really
  // was readable.
  it('control: folder readable and the file really deleted: proven gone, and both are kept', async () => {
    const lib = setUp({ lock: false });
    const variants = structuredClone(lib._settings.store['library.manualVariants']);
    fs.rmSync(SCRIPT);
    await expect(lib._safeToPrune(SCRIPT)).resolves.toBe(true);
    await lib._validateAssociationsInBackground();
    await lib._validateManualVariantsInBackground();
    expect(lib._settings.store['library.associations'][VIDEO].single).toBe(SCRIPT);
    expect(lib._settings.store['library.manualVariants']).toEqual(variants);
  });
});
