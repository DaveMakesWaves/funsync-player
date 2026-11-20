/**
 * @vitest-environment jsdom
 * jsdom on purpose: library.js imports i18n.js, which branches on
 * `typeof window`, and Assign script to selected ends in a real toast
 * (notes/CLAUDE.md "Test environments").
 */
// FT-102 (Pudknocker #372), block E2 review: the one-video folder scripts are
// scan-time only. Nothing may be written to library.associations because
// the setting is on, and a user's own choice still leads.
//
// The review found the existing multi-axis auto-promote did write one. A
// folder video with no script of its own plays the folder's first script
// ("Round 1"). Under the store default "Multi-axis when available"
// (player.preferMultiAxis = 'multi') every library load promoted any video
// with no association whose script has companion files, and saved that
// promotion. So "Round 1" + "Round 1.twist" went into config.json, and after
// the setting was switched off the video kept playing them through the
// stored association.
//
// The REAL scan (electron/library-scan.js) on real temp folders, then the
// REAL library-load pass (Library.prototype._applyManualAssociations, which
// runs the auto-promote) over a settings store that records every write. What
// is asserted is what the user ends up with: what config.json holds, what the
// video plays and what its script menu lists.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Library } from '../../renderer/components/library.js';

const require_ = createRequire(import.meta.url);
const { scanLibrary } = require_('../../electron/library-scan.js');

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'funsync-folder-variants-assoc-'));
  document.body.innerHTML = '<div id="toast-container"></div>';
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function tree(root, files) {
  for (const rel of files) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, rel.endsWith('.funscript') ? '{"actions":[]}' : 'x');
  }
}

/** A settings store like DataService's: values are copies, every write is recorded. */
function settingsStore(initial) {
  const values = new Map(Object.entries(structuredClone(initial)));
  const writes = [];
  return {
    values,
    writes,
    get: (k) => (values.has(k) ? structuredClone(values.get(k)) : undefined),
    set: (k, v) => { writes.push(k); values.set(k, structuredClone(v)); },
  };
}

/** A library load: the REAL scan, then the REAL association pass that runs after it. */
async function load(src, settings, on) {
  const r = await scanLibrary(src, { [src]: 'src' }, { log: { info() {}, warn() {} }, folderScriptsAsVariants: on });
  const lib = Object.create(Library.prototype);
  Object.assign(lib, {
    _settings: settings,
    _videos: r.videos,
    _allFunscripts: r.allFunscripts,
    _videosByPath: new Map(r.videos.map((v) => [v.path, v])),
    _isUnderUnavailableSource: () => false,
    _isProvablyGone: () => false,
    _validateAssociationsInBackground() {},
    _validateManualVariantsInBackground() {},
  });
  lib._applyManualAssociations();
  return lib;
}

const video = (lib, name) => lib._videos.find((v) => v.name === name);
const names = (v) => (v.variants || []).map((x) => x.name);

const FAPLAND = [
  'FapLand/Big Video.mp4',
  'FapLand/Round 1.funscript',
  'FapLand/Round 1.twist.funscript',
  'FapLand/Round 2.funscript',
];
const MULTI = { 'player.preferMultiAxis': 'multi', 'library.associations': {} };

describe('FT-102: one-video folder scripts are never written as an association', () => {
  it('setting on, "Multi-axis when available": the folder video plays Round 1 but nothing is stored', async () => {
    const src = path.join(tmp, 'on');
    tree(src, FAPLAND);
    const settings = settingsStore(MULTI);
    const lib = await load(src, settings, true);

    const v = video(lib, 'Big Video.mp4');
    expect(v.funscriptPath).toBe(path.join(src, 'FapLand', 'Round 1.funscript'));
    expect(names(v)).toEqual(['Round 1.funscript', 'Round 2.funscript']);
    // Not promoted, so not saved.
    expect(settings.writes).not.toContain('library.associations');
    expect(settings.values.get('library.associations')).toEqual({});
    expect(v._multiAxis || null).toBeNull();
    expect(v._manualAssociation || false).toBe(false);

    // The Settings dropdown's count and its re-run agree: nothing to promote.
    expect(lib._countAutoPromotionEligible({ detail: true })).toEqual({ eligible: 0, assigned: 0 });
    expect(lib._reapplyAutoPromotion()).toBe(0);
    expect(settings.writes).not.toContain('library.associations');
  });

  it('switching the setting off afterwards leaves the video with no script, as before it was ever on', async () => {
    const src = path.join(tmp, 'onoff');
    tree(src, FAPLAND);
    const settings = settingsStore(MULTI);
    await load(src, settings, true);
    await load(src, settings, true); // a relaunch, still on

    const off = video(await load(src, settings, false), 'Big Video.mp4');
    expect(off.hasFunscript).toBe(false);
    expect(off.funscriptPath || null).toBeNull();
    expect(off._multiAxis || null).toBeNull();
    expect(settings.values.get('library.associations')).toEqual({});
  });

  it('a video\'s OWN script with its own companion is still promoted, setting on or off (no change there)', async () => {
    for (const on of [false, true]) {
      const src = path.join(tmp, `own-${on}`);
      tree(src, ['Journey/Journey.mp4', 'Journey/Journey.funscript', 'Journey/Journey.roll.funscript', 'Journey/Round 1.funscript']);
      const settings = settingsStore(MULTI);
      const lib = await load(src, settings, on);
      const key = path.join(src, 'Journey', 'Journey.mp4');
      const entry = settings.values.get('library.associations')[key];
      expect(entry?.active, `on=${on}`).toBe('multi');
      expect(entry.multi.main).toBe(path.join(src, 'Journey', 'Journey.funscript'));
      expect(entry.multi.axes).toEqual({ roll: path.join(src, 'Journey', 'Journey.roll.funscript') });
      expect(video(lib, 'Journey.mp4')._multiAxis?.main).toBe(entry.multi.main);
    }
  });
});

describe('FT-102: a user\'s own choice still leads with the setting on', () => {
  it('an associated script plays first, and the menu (also after its folder rescan) lists the rounds after it', async () => {
    const src = path.join(tmp, 'assoc');
    tree(src, [...FAPLAND, 'Mine/My Script.funscript']);
    const big = path.join(src, 'FapLand', 'Big Video.mp4');
    const mine = path.join(src, 'Mine', 'My Script.funscript');
    const settings = settingsStore({
      ...MULTI,
      'library.associations': { [big]: { active: 'single', single: mine, multi: null, custom: null } },
    });
    const lib = await load(src, settings, true);

    const v = video(lib, 'Big Video.mp4');
    expect(v.funscriptPath).toBe(mine);
    expect(names(v)).toEqual(['My Script.funscript', 'Round 1.funscript', 'Round 2.funscript']);
    // The variant menu rescans the video's folder when it opens
    // (app.js _refreshCurrentVariantsFromDisk) and asks the library to order it.
    const rescan = await scanLibrary(path.join(src, 'FapLand'), {}, { log: { info() {}, warn() {} }, folderScriptsAsVariants: true });
    const menu = lib.variantsForVideo(big, rescan.videos[0].variants);
    expect(menu.map((x) => x.name)).toEqual(['My Script.funscript', 'Round 1.funscript', 'Round 2.funscript']);
    // The stored association is the user's, untouched.
    expect(settings.values.get('library.associations')[big]).toEqual({ active: 'single', single: mine, multi: null, custom: null });
  });

  it('Assign script to selected gives a folder video the picked script as its own, as it does with the setting off', async () => {
    for (const on of [false, true]) {
      const src = path.join(tmp, `bulk-${on}`);
      tree(src, [...FAPLAND, 'Mine/My Script.funscript']);
      const big = path.join(src, 'FapLand', 'Big Video.mp4');
      const mine = path.join(src, 'Mine', 'My Script.funscript');
      const settings = settingsStore({ 'player.preferMultiAxis': 'single', 'library.associations': {} });
      const lib = await load(src, settings, on);
      Object.assign(lib, {
        _selectedPaths: new Set([big]),
        _registerWithBackend() {},
        _exitSelectMode() {},
        _applyFilters() {},
      });
      window.funsync = { selectFunscript: async () => ({ path: mine, name: 'My Script.funscript' }) };

      await lib._bulkAssignScript();

      const entry = settings.values.get('library.associations')[big];
      expect(entry?.active, `on=${on}`).toBe('single');
      expect(entry.single).toBe(mine);
      expect(settings.values.get('library.manualVariants') || {}).toEqual({});
      const v = video(lib, 'Big Video.mp4');
      expect(v.funscriptPath).toBe(mine);
      // What a load plays is index 0 of the menu (variant-select.js).
      if (on) expect(names(v)).toEqual(['My Script.funscript', 'Round 1.funscript', 'Round 2.funscript']);
    }
  });
});
