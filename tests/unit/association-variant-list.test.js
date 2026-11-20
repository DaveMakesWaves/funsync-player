// Round-4 leftovers in the variant list a single association builds (R4-06
// puts the user's associated script FIRST in `video.variants`, the scan's own
// variants after it):
//
// C-08 (new since v0.9.2): a video whose own script was FUZZY-matched (no
// `<video>.funscript`, one fuzzy hit) gets `variants: []` from the scan, and
// the list was returned unchanged when empty, so while a single association
// won, the video's own script was in no variant menu until Remove.
//
// C-03 (new since v0.9.2): the Associate Funscript dialog's Variations section
// tags every entry of `video.variants` "auto", so the user's OWN association
// read "Alpha Custom Take  auto".
//
// Driven through the REAL Library scan (`ensureScanned` and
// `_applyManualAssociations`), the REAL DataService, what a play loads
// (`resolvePlayData`), the variant-menu refresh hook app.js calls
// (`variantsForVideo`) and the REAL Associate Funscript dialog.
//
// jsdom (no docblock): library.js imports i18n.js, which branches on
// `typeof window`. See notes/CLAUDE.md "Test environments".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import { Library } from '../../renderer/components/library.js';
import { DataService } from '../../renderer/js/data-service.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));

const LIB = 'C:\\Lib';
const BRAVO = `${LIB}\\Bravo Scene.mp4`;
const BRAVO_FUZZY = `${LIB}\\Bravo Scene HD.funscript`;        // paired by a fuzzy match
const BRAVO_ASSOC = `${LIB}\\Scripts\\Bravo Custom.funscript`;
const ALPHA = `${LIB}\\Alpha Scene.mp4`;
const ALPHA_OWN = `${LIB}\\Alpha Scene.funscript`;
const ALPHA_ASSOC = `${LIB}\\Scripts\\Alpha Custom Take.funscript`;
const TEXT = '{"actions":[{"at":0,"pos":0},{"at":400,"pos":100}]}';
const files = new Map([[BRAVO_FUZZY, TEXT], [BRAVO_ASSOC, TEXT], [ALPHA_OWN, TEXT], [ALPHA_ASSOC, TEXT]]);

const single = (p) => ({ active: 'single', single: p, multi: null, custom: null });
let lib;

function scanResult() {
  return {
    videos: [
      // What electron/library-scan.js returns for a single fuzzy hit.
      { name: 'Bravo Scene.mp4', path: BRAVO, hasFunscript: true, funscriptPath: BRAVO_FUZZY, _fuzzyMatched: true, variants: [] },
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
    library: {
      sources: [{ id: 's1', name: 'Lib', path: LIB, enabled: true }],
      associations: { [BRAVO]: single(BRAVO_ASSOC), [ALPHA]: single(ALPHA_ASSOC) },
    },
  };
  ds._initialized = true;
  lib = new Library({ settings: ds });
  lib._registerWithBackend = () => {};
  lib._applyFilters = () => {};
  lib._validateAssociationsInBackground = () => {};
  lib._validateManualVariantsInBackground = () => {};
  lib._precomputeSpeedStatsInBackground = async () => {};
  lib._precomputeDurationsInBackground = async () => {};
  await lib.ensureScanned({ forceRescan: true });
  return lib;
}

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

afterEach(() => {
  document.querySelector('.modal-close-btn')?.click();
  delete window.funsync;
  lib = null;
});

describe('C-08: a fuzzy-paired own script stays in the variant menu while an association wins', () => {
  it('the play gets [associated, own], the associated script playing', async () => {
    await boot();
    const video = lib.getVideoByPath(BRAVO);
    expect(video.funscriptPath).toBe(BRAVO_ASSOC);

    const { funscriptData, variants } = await lib.resolvePlayData(video);
    expect(funscriptData._funscriptPath).toBe(BRAVO_ASSOC);
    expect(variants.map((v) => v.path)).toEqual([BRAVO_ASSOC, BRAVO_FUZZY]);
    expect(variants[1]).toMatchObject({ label: 'Default', name: 'Bravo Scene HD.funscript' });
  });

  it('the variant menu\'s refresh from disk (an empty fresh list) keeps it too', async () => {
    await boot();
    expect(lib.variantsForVideo(BRAVO, []).map((v) => v.path)).toEqual([BRAVO_ASSOC, BRAVO_FUZZY]);
  });

  it('Remove gives back the scan\'s own state (one script, no menu)', async () => {
    await boot();
    const video = lib.getVideoByPath(BRAVO);
    lib._removeAssociation(video, document.createElement('div'));
    expect(video.funscriptPath).toBe(BRAVO_FUZZY);
    expect(video.variants).toEqual([]);
  });

  // N-02 (2026-11-16): this used to pin `[]`, and that empty list was the
  // N-02 loss: the player's menu then named "Default" after the editor's
  // file, so Add variation dropped the association from the menu. The list
  // now holds the associated script, the one that plays, and nothing else
  // (no own script is invented). tests/unit/variant-menu-states.test.js
  // drives the menu through Add, every pick and a reload.
  it('a video with no script of its own gets the associated script as its one entry, nothing invented', async () => {
    await boot();
    const only = [{ label: 'Bravo Custom', path: BRAVO_ASSOC, name: 'Bravo Custom.funscript' }];
    expect(lib._variantsLeadingWith([], BRAVO_ASSOC, null)).toEqual(only);
    expect(lib._variantsLeadingWith([], BRAVO_ASSOC, BRAVO_ASSOC)).toEqual(only);
    expect(lib._variantsLeadingWith([], null, null)).toEqual([]);
  });
});

describe('C-03: the Associate dialog tags the user\'s own association "manual", not "auto"', () => {
  async function variationRows(path) {
    const video = lib.getVideoByPath(path);
    lib._associateFunscript(video, null);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    return [...document.querySelectorAll('.modal-body .library__assoc-variant-row')].map((row) => ({
      name: row.querySelector('.library__assoc-variant-name')?.textContent,
      tag: row.querySelector('.library__assoc-variant-tag')?.textContent ?? null,
    }));
  }

  it('Alpha Custom Take reads "manual", the sidecar "auto"', async () => {
    await boot();
    expect(await variationRows(ALPHA)).toEqual([
      { name: 'Alpha Custom Take', tag: t('library.assoc.currentManual') },
      // FN-03 (2026-11-16): the sidecar is named by its file; it read "Default".
      { name: 'Alpha Scene', tag: t('library.assoc.autoVariantTag') },
    ]);
  });

  it('a fuzzy-paired own script listed after it (C-08) reads "auto"', async () => {
    await boot();
    expect(await variationRows(BRAVO)).toEqual([
      { name: 'Bravo Custom', tag: t('library.assoc.currentManual') },
      { name: 'Bravo Scene HD', tag: t('library.assoc.autoVariantTag') },
    ]);
  });
});

// Block C fix-up (2026-11-06, real-app verifier 2; cosmetic, also in
// v0.9.2): in the Custom Routing pane a route's "Select" button opened a
// picker titled "Select Script for Variation". It reuses the variation
// picker (`_showVariantSearchModal`), title included, though it picks the
// route's script. Driven through the REAL Associate dialog.
describe('fix-up: the Custom Routing pane\'s script picker is titled for a route', () => {
  const titles = () => [...document.querySelectorAll('.modal-overlay .modal-title')].map((el) => el.textContent);

  it('Select on a route: "Select Script for Route"; + Add Variation still says Variation', async () => {
    await boot();
    lib._associateFunscript(lib.getVideoByPath(ALPHA), null);
    await new Promise((r) => setTimeout(r, 0));
    const custom = document.getElementById('assoc-custom');
    custom.checked = true;
    custom.dispatchEvent(new Event('change', { bubbles: true }));
    const select = [...document.querySelectorAll('.library__custom-route-field button')]
      .find((b) => b.textContent === t('library.assoc.selectScriptBtn'));
    expect(select).toBeTruthy();
    select.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(titles().at(-1)).toBe(EN.library.assoc.routeScriptSearchTitle);
    expect(titles().at(-1)).not.toBe(EN.library.assoc.variantSearchTitle);
    document.querySelectorAll('.modal-overlay').item(1).querySelector('.modal-close-btn').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(titles()).toHaveLength(1);
  });

  it('the variation picker keeps its own title', async () => {
    await boot();
    const picked = lib._showVariantSearchModal(lib.getVideoByPath(ALPHA));
    expect(titles().at(-1)).toBe(EN.library.assoc.variantSearchTitle);
    document.querySelector('.modal-overlay .modal-close-btn').click();
    expect(await picked).toBeNull();
  });
});

// FN-03 (Dave 2026-11-16: "the default means nothing, the name of the
// currently assigned script should be highlighted"; also in v0.9.2): the
// Associate dialog's Variations list names each row as the player's menu
// does (an unlabelled script by its file), marks the script the video opens
// on "main", and, when the video is the one in the player, highlights the
// row that plays and announces it as current. Driven through the REAL dialog.
describe('FN-03: the Associate dialog names every variation, marks main and the one that plays', () => {
  async function rows(path) {
    lib._associateFunscript(lib.getVideoByPath(path), null);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    return [...document.querySelectorAll('.modal-body .library__assoc-variant-row')].map((row) => ({
      name: row.querySelector('.library__assoc-variant-name')?.textContent,
      main: row.querySelector('.library__assoc-variant-main')?.textContent ?? null,
      playing: row.getAttribute('aria-current') === 'true' && row.classList.contains('library__assoc-variant-row--playing'),
    }));
  }

  it('the association is main; the sidecar is named by its file; nothing plays when the video is not in the player', async () => {
    await boot();
    lib._getPlayingScript = () => null;
    expect(await rows(ALPHA)).toEqual([
      { name: 'Alpha Custom Take', main: t('variants.mainTag'), playing: false },
      { name: 'Alpha Scene', main: null, playing: false },
    ]);
    expect(document.querySelector('.library__assoc-variants').textContent).not.toContain('Default');
  });

  it('the video is in the player on its sidecar: that row is highlighted and current', async () => {
    await boot();
    lib._getPlayingScript = (videoPath) => (videoPath === ALPHA ? ALPHA_OWN : null);
    expect((await rows(ALPHA)).map((r) => [r.name, r.playing])).toEqual([
      ['Alpha Custom Take', false], ['Alpha Scene', true],
    ]);
  });
});
