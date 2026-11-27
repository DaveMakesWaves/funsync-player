// A Multi Axis or Custom Routing pairing on a video that also has its own
// `<video>.funscript`: the variant list leads with the script that PLAYS
// (the set's main, the main route's script), as a single association's does
// (R4-06 note, TODO triage 2026-11-23, also in v0.9.2). The scan's list put
// the sidecar first, so the variant menu named it as playing and picking it
// did nothing (index 0 is taken as already active).
//
// Driven through the REAL Library scan (`ensureScanned` and the manual
// associations pass), what a play loads (`resolvePlayData`), the menu's
// refresh from disk (`variantsForVideo`) and a save (`_syncVideoStateForActive`).
//
// jsdom (no docblock): library.js imports i18n.js, which branches on
// `typeof window`. See notes/CLAUDE.md "Test environments".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { Library } from '../../renderer/components/library.js';
import { DataService } from '../../renderer/js/data-service.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const LIB = 'C:\\Lib';
const MULTI = `${LIB}\\Multi Scene.mp4`;
const MULTI_OWN = `${LIB}\\Multi Scene.funscript`;
const MULTI_SOFT = `${LIB}\\Multi Scene.soft.funscript`;
const MULTI_MAIN = `${LIB}\\Scripts\\Multi Custom.funscript`;
const MULTI_PITCH = `${LIB}\\Scripts\\Multi Custom.pitch.funscript`;
const ROUTED = `${LIB}\\Routed Scene.mp4`;
const ROUTED_OWN = `${LIB}\\Routed Scene.funscript`;
const ROUTED_MAIN = `${LIB}\\Scripts\\Routed Main.funscript`;
const ROUTED_VIB = `${LIB}\\Scripts\\Routed Vibe.funscript`;
const AXES = `${LIB}\\Axes Only.mp4`;
const AXES_OWN = `${LIB}\\Axes Only.funscript`;
const AUTO = `${LIB}\\Auto Scene.mp4`;
const AUTO_OWN = `${LIB}\\Auto Scene.funscript`;
const TEXT = '{"actions":[{"at":0,"pos":0},{"at":400,"pos":100}]}';
const files = new Map([MULTI_OWN, MULTI_SOFT, MULTI_MAIN, MULTI_PITCH, ROUTED_OWN, ROUTED_MAIN, ROUTED_VIB, AXES_OWN, AUTO_OWN]
  .map((p) => [p, TEXT]));

const own = (path, label = 'Default') => ({ label, path, name: path.split('\\').pop() });
const assocs = {
  [MULTI]: { active: 'multi', single: null, multi: { main: MULTI_MAIN, axes: { pitch: MULTI_PITCH } }, custom: null },
  [ROUTED]: {
    active: 'custom', single: null, multi: null,
    custom: { routes: [
      { role: 'main', deviceId: 'handy', scriptPath: ROUTED_MAIN },
      { role: 'extra', deviceId: 'bp:1', scriptPath: ROUTED_VIB },
    ] },
  },
  // Axes only, no main: nothing to lead with.
  [AXES]: { active: 'multi', single: null, multi: { main: null, axes: { pitch: MULTI_PITCH } }, custom: null },
  // FunSync's own promotion: the main IS the sidecar.
  [AUTO]: { active: 'multi', single: null, multi: { main: AUTO_OWN, axes: {}, autoAssigned: true }, custom: null },
};

function scanResult() {
  return {
    videos: [
      { name: 'Multi Scene.mp4', path: MULTI, hasFunscript: true, funscriptPath: MULTI_OWN, variants: [own(MULTI_OWN), own(MULTI_SOFT, 'soft')] },
      { name: 'Routed Scene.mp4', path: ROUTED, hasFunscript: true, funscriptPath: ROUTED_OWN, variants: [own(ROUTED_OWN)] },
      { name: 'Axes Only.mp4', path: AXES, hasFunscript: true, funscriptPath: AXES_OWN, variants: [own(AXES_OWN)] },
      { name: 'Auto Scene.mp4', path: AUTO, hasFunscript: true, funscriptPath: AUTO_OWN, variants: [own(AUTO_OWN)] },
    ],
    unmatchedFunscripts: [],
    allFunscripts: [...files.keys()].map((p) => ({ name: p.split('\\').pop(), path: p })),
    failedPaths: [],
    skippedPaths: [],
  };
}

let lib;
async function boot() {
  const ds = new DataService();
  ds._cache.settings = {
    library: { sources: [{ id: 's1', name: 'Lib', path: LIB, enabled: true }], associations: structuredClone(assocs) },
  };
  ds._initialized = true;
  lib = new Library({ settings: ds });
  lib._registerWithBackend = () => {};
  lib._applyFilters = () => {};
  await lib.ensureScanned();
}
const paths = (list) => list.map((v) => v.path);

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  document.body.innerHTML = '';
  const known = {
    setSetting: vi.fn(),
    scanDirectory: vi.fn(async () => scanResult()),
    readFunscript: vi.fn(async (p) => files.get(p) ?? null),
    filesExist: vi.fn(async (list) => list.map((p) => files.has(p))),
    fileExists: vi.fn(async (p) => files.has(p)),
  };
  window.funsync = new Proxy(known, { get: (o, k) => (k in o ? o[k] : vi.fn(async () => null)) });
});
afterEach(() => { delete window.funsync; lib = null; });

describe('at load (the scan applies the pairing)', () => {
  it('Multi Axis: the set\'s main first, then the video\'s own script and its other variants', async () => {
    await boot();
    const video = lib.getVideoByPath(MULTI);
    expect(video.funscriptPath).toBe(MULTI_MAIN);
    const { funscriptData, variants } = await lib.resolvePlayData(video);
    expect(funscriptData._funscriptPath ?? funscriptData.path).toBe(MULTI_MAIN);
    expect(paths(variants)).toEqual([MULTI_MAIN, MULTI_OWN, MULTI_SOFT]);
    expect(variants[0]).toMatchObject({ label: 'Multi Custom', name: 'Multi Custom.funscript' });
    expect(variants[1]).toMatchObject({ label: 'Default', name: 'Multi Scene.funscript' });
  });

  it('Custom Routing: the main route\'s script first, the video\'s own after it; the other routes are not variants', async () => {
    await boot();
    const video = lib.getVideoByPath(ROUTED);
    expect(paths(video.variants)).toEqual([ROUTED_MAIN, ROUTED_OWN]);
    expect(paths(video.variants)).not.toContain(ROUTED_VIB);
  });

  it('a set with axes and no main: the scan\'s list as it is', async () => {
    await boot();
    expect(paths(lib.getVideoByPath(AXES).variants)).toEqual([AXES_OWN]);
  });

  it('FunSync\'s own promotion (main = the video\'s own script): one entry, unchanged', async () => {
    await boot();
    expect(paths(lib.getVideoByPath(AUTO).variants)).toEqual([AUTO_OWN]);
  });
});

describe('the variant menu\'s refresh from disk (on opening it)', () => {
  it('keeps the played script first for Multi Axis and Custom Routing too', async () => {
    await boot();
    expect(paths(lib.variantsForVideo(MULTI, [own(MULTI_OWN), own(MULTI_SOFT, 'soft')]))).toEqual([MULTI_MAIN, MULTI_OWN, MULTI_SOFT]);
    expect(paths(lib.variantsForVideo(ROUTED, [own(ROUTED_OWN)]))).toEqual([ROUTED_MAIN, ROUTED_OWN]);
    expect(paths(lib.variantsForVideo(AXES, [own(AXES_OWN)]))).toEqual([AXES_OWN]);
  });
});

describe('a save (Associate > Multi Axis / Custom Routing)', () => {
  it('the list leads with the new main at once; switching back to the video\'s own script restores the scan\'s list', async () => {
    await boot();
    const video = lib.getVideoByPath(AUTO);
    lib._syncVideoStateForActive(video, 'multi', { main: MULTI_MAIN, axes: { pitch: MULTI_PITCH } });
    expect(paths(video.variants)).toEqual([MULTI_MAIN, AUTO_OWN]);
    lib._syncVideoStateForActive(video, 'custom', { routes: [{ role: 'main', deviceId: 'handy', scriptPath: ROUTED_MAIN }] });
    expect(paths(video.variants)).toEqual([ROUTED_MAIN, AUTO_OWN]);
    lib._syncVideoStateForActive(video, 'none');
    expect(paths(video.variants)).toEqual([AUTO_OWN]);
  });

  it('the source is never touched: lists are rebuilt, not mutated', async () => {
    await boot();
    const video = lib.getVideoByPath(MULTI);
    const ownList = video._ownVariants;
    expect(paths(ownList)).toEqual([MULTI_OWN, MULTI_SOFT]);
    lib._syncVideoStateForActive(video, 'multi', { main: MULTI_MAIN, axes: {} });
    expect(paths(ownList)).toEqual([MULTI_OWN, MULTI_SOFT]);
  });
});
