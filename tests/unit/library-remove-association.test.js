// FT-045 (also in v0.9.2): kebab > Remove Funscript on a video with no script
// of its own left the card under the Matched chip, and the phone and the
// headset kept showing (and offering) the removed script. The kebab called
// `_removeAssociation` (gone since 2026-11-23) without re-filtering (the dialog's Remove did), and no
// association change re-registered the library with the backend: app.js
// re-sent the video list for `library.manualVRType` only.
//
// 2026-11-18 (video options, stage 2a): the ⋮ opens the video options dialog
// now, and Remove Funscript is its Script section's "Unpair funscript", with
// a stacked confirm. These tests drive that road; what they assert is
// unchanged.
//
// C-04 (also in v0.9.2, same area): after Remove on a video that DOES have
// its own script, the card's speed badge kept the REMOVED script's speed
// until a grid / list toggle (`_addSpeedBadge` keeps a badge it finds, and
// the video still carried the old avgSpeed).
//
// Driven through the REAL Library (scan, render, the ⋮'s dialog, card reads), the
// REAL DataService and event bus, and app.js's REAL `_wireGroupingsRegister`
// (lifted), with a fake backend that records every /api/media/register body:
// what the phone and HereSphere read.
//
// jsdom (no docblock): library.js imports i18n.js, which branches on
// `typeof window`. See notes/CLAUDE.md "Test environments".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import { Library } from '../../renderer/components/library.js';
import { DataService } from '../../renderer/js/data-service.js';
import { eventBus } from '../../renderer/js/event-bus.js';
import { liftAppClass } from './helpers/app-methods.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));

const LIB = 'C:\\Lib';
const SQUARE = `${LIB}\\Square Clip.mp4`;             // no script of its own
const ALPHA = `${LIB}\\Alpha Scene.mp4`;              // has its own sidecar
const ALPHA_OWN = `${LIB}\\Alpha Scene.funscript`;
const ZULU = `${LIB}\\Scripts\\Zulu Last.funscript`;  // associated with Square
const TAKE = `${LIB}\\Scripts\\Alpha Custom Take.funscript`; // associated with Alpha

// 0 -> 100 in 400 ms = 250 units/s; in 1000 ms = 100 units/s.
const script = (ms) => JSON.stringify({ actions: [{ at: 0, pos: 0 }, { at: ms, pos: 100 }, { at: 2 * ms, pos: 0 }] });
const files = new Map([[ZULU, script(400)], [TAKE, script(400)], [ALPHA_OWN, script(1000)]]);

const single = (p) => ({ active: 'single', single: p, multi: null, custom: null });

const Lifted = liftAppClass(['_wireGroupingsRegister', '_registerGroupingsEarly'], { eventBus });

let backend;
let lib;
let savedHandlers;

function scanResult() {
  return {
    videos: [
      { name: 'Square Clip.mp4', path: SQUARE, hasFunscript: false, funscriptPath: null, variants: [] },
      {
        name: 'Alpha Scene.mp4', path: ALPHA, hasFunscript: true, funscriptPath: ALPHA_OWN,
        variants: [{ label: 'Default', path: ALPHA_OWN, name: 'Alpha Scene.funscript' }],
      },
    ],
    unmatchedFunscripts: [],
    allFunscripts: [...files.keys()].map((p) => ({ name: p.split('\\').pop(), path: p })),
    failedPaths: [],
    skippedPaths: [],
  };
}

async function boot() {
  const ds = new DataService();
  ds._cache.settings = {
    backend: { port: 5123 },
    library: {
      viewMode: 'grid',
      sources: [{ id: 's1', name: 'Lib', path: LIB, enabled: true }],
      associations: { [SQUARE]: single(ZULU), [ALPHA]: single(TAKE) },
    },
  };
  ds._initialized = true;
  lib = new Library({ settings: ds });
  lib._queueThumbnail = () => {};
  lib._validateAssociationsInBackground = () => {};
  lib._validateManualVariantsInBackground = () => {};
  lib._precomputeSpeedStatsInBackground = async () => {};
  lib._precomputeDurationsInBackground = async () => {};
  const container = document.createElement('div');
  container.innerHTML = '<span class="library__video-count"></span><div class="library__grid-wrapper"><div class="library__grid"></div></div>';
  document.body.appendChild(container);
  const wrapper = container.querySelector('.library__grid-wrapper');
  Object.defineProperty(wrapper, 'clientHeight', { value: 900, configurable: true });
  Object.defineProperty(wrapper, 'clientWidth', { value: 1700, configurable: true });
  lib._container = container;
  await lib.ensureScanned({ forceRescan: true });
  lib._activeTab = 'matched';                 // the Matched chip
  lib._applyFilters();
  await settle();                             // the cards' speed reads

  const app = new Lifted();
  app.backendPort = 5123;
  app.settings = ds;
  app.library = lib;
  app._wireGroupingsRegister();
  backend.registers.length = 0;               // the scan's own register
  return lib;
}

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const cardFor = (p) => [...lib._container.querySelectorAll('.library__card')].find((el) => el.dataset.videoPath === p) || null;
const badgeTitle = (p) => cardFor(p)?.querySelector('.library__speed-badge')?.title ?? null;
const lastSent = (p) => backend.registers.filter((r) => r.videos).at(-1)?.videos.find((v) => v.path === p);

const overlays = () => [...document.querySelectorAll('.modal-overlay')];
// A turn of the microtask queue: real, also while a test fakes setTimeout.
const tick = () => new Promise((r) => queueMicrotask(r));

/**
 * ⋮ > Script > Unpair funscript, up to its confirm (all of it writes
 * nothing). Returns the confirm's Unpair button: its click is the removal.
 */
async function openUnpair(path) {
  cardFor(path).querySelector('.library__kebab-btn').click();
  await vi.waitFor(() => expect(document.querySelector('.modal-body.video-options')).toBeTruthy());
  const body = document.querySelector('.modal-body.video-options');
  body.querySelector('.video-options__rail-item[data-section="script"]').click();
  const btn = body.querySelector('[data-vo-focus="script:unpair"]');
  expect(btn, 'Unpair funscript is in the Script section').toBeTruthy();
  expect(btn.textContent).toBe(t('library.kebabRemoveFunscript'));
  btn.click();
  await vi.waitFor(() => expect(overlays()).toHaveLength(2));
  return overlays()[1].querySelector('.modal-btn--danger');
}

/** The removal: the confirm's Unpair, then the dialog closed. */
async function kebabRemove(path, confirmBtn = null) {
  const unpair = confirmBtn || await openUnpair(path);
  unpair.click();
  for (let i = 0; i < 10; i++) await tick();
  expect(overlays()).toHaveLength(1);
  overlays()[0].querySelector('.modal-close-btn').click();
  for (let i = 0; i < 10; i++) await tick();
}

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  document.body.innerHTML = '';
  vi.stubGlobal('requestAnimationFrame', (cb) => { cb(0); return 0; });
  savedHandlers = eventBus._handlers;
  eventBus._handlers = new Map();
  backend = { registers: [] };
  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    if (String(url).endsWith('/api/media/register')) backend.registers.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({}) };
  });
  const known = {
    setSetting: vi.fn(),
    scanDirectory: vi.fn(async () => scanResult()),
    readFunscript: vi.fn(async (p) => files.get(p) ?? null),
    filesExist: vi.fn(async (list) => list.map((p) => files.has(p))),
    fileExists: vi.fn(async (p) => files.has(p)),
  };
  window.funsync = new Proxy(known, { get: (o, k) => (k in o ? o[k] : vi.fn(async () => null)) });
});

afterEach(() => {
  vi.useRealTimers();
  for (const o of overlays()) o.remove();
  vi.unstubAllGlobals();
  eventBus._handlers = savedHandlers;
  delete globalThis.fetch;
  delete window.funsync;
  lib = null;
});

describe('FT-045: ⋮ > Unpair funscript (was kebab > Remove Funscript)', () => {
  it('drops a video with no script of its own out of Matched at once', async () => {
    await boot();
    expect(cardFor(SQUARE)).toBeTruthy();
    await kebabRemove(SQUARE);
    expect(cardFor(SQUARE)).toBeNull();        // gone from the Matched view
    expect(cardFor(ALPHA)).toBeTruthy();
  });

  it('re-registers the library, so the phone and HereSphere stop showing the script', async () => {
    await boot();
    const unpair = await openUnpair(SQUARE);  // the dialog opens with real timers
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await kebabRemove(SQUARE, unpair);
    expect(backend.registers).toHaveLength(0); // debounced
    await vi.advanceTimersByTimeAsync(500);
    expect(lastSent(SQUARE)).toMatchObject({ hasFunscript: false, funscriptPath: null });
    expect(lastSent(ALPHA)).toMatchObject({ hasFunscript: true, funscriptPath: TAKE });
  });

  it('an association made in the app reaches the backend too', async () => {
    await boot();
    // The removal's 400 ms re-register on FAKE timers, run out before the
    // association: on real timers it could land after the association's and
    // lastSent read the removal (flaky on a loaded machine; TODO triage
    // 2026-11-23). As the test above: the dialog opens with real timers.
    const unpair = await openUnpair(SQUARE);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await kebabRemove(SQUARE, unpair);
    await vi.advanceTimersByTimeAsync(500);
    expect(lastSent(SQUARE)).toMatchObject({ hasFunscript: false, funscriptPath: null });
    const card = document.createElement('div');
    card.innerHTML = '<div class="library__card-thumbnail"></div><div class="library__card-info"></div>';
    await lib._applyAssociation(lib.getVideoByPath(SQUARE), card, ZULU, 'Zulu Last.funscript');
    // Wait for the register itself, not a fixed 500 ms (FLAKY-TESTS row 8): a later change re-arms the 400 ms
    // debounce, so one fixed step could end just before it fired. At most 3 s of fake time.
    for (let i = 0; i < 30 && lastSent(SQUARE)?.funscriptPath !== ZULU; i++) await vi.advanceTimersByTimeAsync(100);
    expect(lastSent(SQUARE)).toMatchObject({ hasFunscript: true, funscriptPath: ZULU });
  });
});

describe('C-04: the speed badge after Remove', () => {
  it('shows the video\'s own script\'s speed, not the removed one\'s, without a re-render', async () => {
    await boot();
    expect(badgeTitle(ALPHA)).toBe(t('library.speedBadgeTitle', { avg: 250, max: 250 }));

    await kebabRemove(ALPHA);
    await settle();                            // the rebuilt card's read

    expect(lib.getVideoByPath(ALPHA).funscriptPath).toBe(ALPHA_OWN);
    expect(badgeTitle(ALPHA)).toBe(t('library.speedBadgeTitle', { avg: 100, max: 100 }));
    expect(cardFor(ALPHA).querySelectorAll('.library__speed-badge')).toHaveLength(1);
  });

  it('the re-register does not hand the backend the removed script\'s speed', async () => {
    await boot();
    const unpair = await openUnpair(ALPHA);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    lib._loadSpeedStatsForVideo = async () => {}; // the card read has not landed yet
    await kebabRemove(ALPHA, unpair);
    await vi.advanceTimersByTimeAsync(500);
    const sent = lastSent(ALPHA);
    expect(sent.funscriptPath).toBe(ALPHA_OWN);
    expect(sent.avgSpeed ?? null).toBeNull();  // unknown: the backend probes the own script
  });
});
