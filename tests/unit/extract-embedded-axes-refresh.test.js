/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Library renders its cards into a DOM
 * (library.js imports DOM-branching modules; notes/CLAUDE.md "Test
 * environments").
 */
// "Extract embedded axes" must take effect in the session it runs in (app
// test V40, the workaround offered for forum #376).
//
// The handler wrote the companion files and the association, then called
// `library.ensureScanned(true)`. ensureScanned takes `{ forceRescan = false }`,
// so destructuring `true` gave forceRescan=false and it returned at once on
// any populated library. Nothing re-rendered either. Until a manual Refresh
// the card kept its "embedded" badge, the new files were missing from the
// library's script list, and the next play still took the embedded path, so
// the editor never got an axis selector.
//
// The REAL app.js handler is lifted and run against the REAL Library (real
// ensureScanned, association overlay and card render) over a fake disk.
// What is asserted is what the user sees and what the next play receives.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { liftAppClass } from './helpers/app-methods.js';
import { Library } from '../../renderer/components/library.js';
import { t } from '../../renderer/js/i18n.js';
import {
  extractEmbeddedAxes, buildCompanionFiles, companionPathMap,
} from '../../renderer/js/embedded-multi-axis.js';

const DIR = 'C:\\Lib';
const VIDEO = `${DIR}\\Combined Clip.mp4`;
const MAIN = `${DIR}\\Combined Clip.funscript`;
const ramp = (n) => Array.from({ length: n }, (_, i) => ({ at: i * 100, pos: (i * 13) % 100 }));
const MAIN_CONTENT = JSON.stringify({
  actions: ramp(10),
  axes: [{ id: 'R0', actions: ramp(12) }, { id: 'R1', actions: ramp(14) }, { id: 'R2', actions: ramp(16) }],
});

const showToast = vi.fn();
const LiftedApp = liftAppClass([
  '_extractEmbeddedAxesToCompanions',
  'getEmbeddedAxes',
  'detectEmbeddedAxesForPath',
], {
  window, console, showToast, t, extractEmbeddedAxes, buildCompanionFiles, companionPathMap,
});

let disk;
let store;
let lib;
let app;
let container;
let onPlayVideo;

/** What the real scan returns for the files on the fake disk. */
function scanResult() {
  const scripts = [...disk.keys()].filter((p) => p.endsWith('.funscript'));
  // The scan pairs a script by name only when one sits next to the video.
  const paired = disk.has(MAIN);
  return {
    videos: [{ name: 'Combined Clip.mp4', path: VIDEO, hasFunscript: paired, funscriptPath: paired ? MAIN : null, variants: [] }],
    allFunscripts: scripts.map((p) => ({ name: p.split('\\').pop(), path: p })),
    unmatchedFunscripts: [],
    failedPaths: [],
    skippedPaths: [],
  };
}

function card() {
  return [...container.querySelectorAll('.library__card')].find((el) => el.dataset.videoPath === VIDEO) || null;
}

beforeEach(async () => {
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(() => cb(0), 0));
  disk = new Map([[VIDEO, ''], [MAIN, MAIN_CONTENT]]);
  store = {
    'library.viewMode': 'grid',
    'library.sources': [{ id: 's1', name: 'Lib', path: DIR, enabled: true }],
    'library.associations': {},
  };
  const settings = {
    get: (k) => store[k],
    set: (k, v) => { store[k] = v; },
    getVideoCategories: () => [],
    getCategories: () => [],
  };
  window.funsync = {
    scanDirectory: vi.fn(async () => scanResult()),
    readFunscript: vi.fn(async (p) => disk.get(p) ?? null),
    writeFunscript: vi.fn(async (content, p) => { disk.set(p, content); return true; }),
    filesExist: vi.fn(async (list) => list.map((p) => disk.has(p) || p === DIR)),
  };
  onPlayVideo = vi.fn();
  lib = new Library({ settings, onPlayVideo });
  // Not under test: thumbnails, backend registration, background validation.
  lib._lazyLoadVisibleThumbnails = () => {};
  lib._drainPendingThumbnailsOnScrollEnd = () => {};
  lib._registerWithBackend = () => {};
  lib._validateAssociationsInBackground = () => {};
  lib._validateManualVariantsInBackground = () => {};
  container = document.createElement('div');
  container.innerHTML = '<div class="library__grid-wrapper"><div class="library__grid"></div></div>';
  document.body.appendChild(container);
  lib._container = container;
  const wrapper = container.querySelector('.library__grid-wrapper');
  Object.defineProperty(wrapper, 'clientHeight', { value: 900, configurable: true });
  Object.defineProperty(wrapper, 'clientWidth', { value: 1700, configurable: true });

  // The library as the user has it: scanned once, the combined clip on screen.
  await lib.ensureScanned({ forceRescan: true });
  lib._applyFilters();

  app = new LiftedApp();
  app.settings = settings;
  app.library = lib;
  app._currentView = () => 'library';
  showToast.mockClear();
});

afterEach(() => {
  container.remove();
  vi.unstubAllGlobals();
});

describe('Extract embedded axes takes effect in the same session (V40)', () => {
  it('rescans and re-renders: the card shows the companion multi-axis badge', async () => {
    const before = card();
    expect(before).toBeTruthy();
    expect(before.querySelector('.library__multi-badge')?.title).not.toBe(t('library.multiAxisCount', { count: 4 }));

    await app._extractEmbeddedAxesToCompanions(lib._videosByPath.get(VIDEO));

    const after = card();
    expect(after).not.toBe(before); // the grid was rebuilt
    expect(after.querySelector('.library__multi-badge')?.title).toBe(t('library.multiAxisCount', { count: 4 }));
  });

  it('puts the new companion files in the library script list (the modal dropdowns read it)', async () => {
    await app._extractEmbeddedAxesToCompanions(lib._videosByPath.get(VIDEO));

    const listed = lib._allFunscripts.map((f) => f.path);
    for (const s of ['twist', 'roll', 'pitch']) {
      expect(listed).toContain(`${DIR}\\Combined Clip.${s}.funscript`);
    }
  });

  it('a script FunSync paired by name keeps the auto funscript badge after Extract (V41)', async () => {
    await app._extractEmbeddedAxesToCompanions(lib._videosByPath.get(VIDEO));
    // The card is the one the rescan built from the persisted association,
    // so this is also what a relaunch shows.
    const badge = card().querySelector('.library__funscript-badge');
    expect(badge.classList.contains('library__funscript-badge--auto')).toBe(true);
  });

  it('a script the user picked by hand stays manual after Extract', async () => {
    // No same-named script: the user associated a differently named one.
    const picked = `${DIR}\\From The Forum.funscript`;
    disk.delete(MAIN);
    disk.set(picked, MAIN_CONTENT);
    store['library.associations'] = {
      [VIDEO]: { active: 'single', single: picked, multi: null, custom: null },
    };
    await lib.ensureScanned({ forceRescan: true });
    lib._applyFilters();
    await app._extractEmbeddedAxesToCompanions(lib._videosByPath.get(VIDEO));
    const badge = card().querySelector('.library__funscript-badge');
    expect(badge.classList.contains('library__funscript-badge--manual')).toBe(true);
  });

  it('Extract again (the kebab still offers it) keeps a companion the user edited since', async () => {
    await app._extractEmbeddedAxesToCompanions(lib._videosByPath.get(VIDEO));
    const twist = `${DIR}\\Combined Clip.twist.funscript`;
    const edited = JSON.stringify({ version: '1.0', actions: ramp(3) });
    disk.set(twist, edited);

    await app._extractEmbeddedAxesToCompanions(lib._videosByPath.get(VIDEO));

    expect(disk.get(twist)).toBe(edited);
    expect(store['library.associations'][VIDEO].multi.axes.twist).toBe(twist);
  });

  it('the next play carries the companions, even when the rescan fails', async () => {
    const video = lib._videosByPath.get(VIDEO);
    window.funsync.scanDirectory.mockRejectedValueOnce(new Error('drive busy'));

    await app._extractEmbeddedAxesToCompanions(video);
    await lib._playVideo(video);

    const funscriptData = onPlayVideo.mock.calls.at(-1)[1];
    expect(funscriptData._multiAxis.axes).toEqual({
      twist: `${DIR}\\Combined Clip.twist.funscript`,
      roll: `${DIR}\\Combined Clip.roll.funscript`,
      pitch: `${DIR}\\Combined Clip.pitch.funscript`,
    });
  });
});
