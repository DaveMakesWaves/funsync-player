/**
 * @vitest-environment jsdom
 * jsdom on purpose: library.js imports i18n.js, which branches on
 * `typeof window` (notes/CLAUDE.md "Test environments").
 */
// Default playback "Multi-axis when available" ↔ "Single" (Dave, 2026-11-20).
//
// v0.10.1 moves the 'single' old releases wrote into every config to 'multi'
// once (multi-axis-default-migration.test.js), so the videos with axis files
// get paired by name. Dave chose: switching back to Single puts the videos
// FunSync paired by ITSELF back to their own script; anything set by hand is
// never touched. And, asked by Dave: with only a Handy, a multi-axis video
// plays exactly as before, because the Handy is sent the main script.
//
// The REAL scan (electron/library-scan.js) on real temp folders, the REAL
// library-load pass (Library.prototype._applyManualAssociations, which runs
// the auto-promote) and the REAL Library.prototype._revertAutoPromotion and
// resolvePlayData, over a settings store that records every write.
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'funsync-multi-switch-back-'));
  document.body.innerHTML = '<div id="toast-container"></div>';
  window.funsync = { ...(window.funsync || {}), readFunscript: async (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null) };
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Each script's text names its own file, so a read shows WHICH file was read. */
function tree(root, files) {
  for (const rel of files) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, rel.endsWith('.funscript')
      ? JSON.stringify({ file: rel, actions: [{ at: 0, pos: 10 }, { at: 500, pos: 90 }] })
      : 'x');
  }
}

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

async function load(src, settings) {
  const r = await scanLibrary(src, { [src]: 'src' }, { log: { info() {}, warn() {} }, folderScriptsAsVariants: false });
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
const assoc = (settings) => settings.values.get('library.associations');

const FILES = [
  'Axes.mp4', 'Axes.funscript', 'Axes.pitch.funscript', 'Axes.roll.funscript',   // paired by FunSync
  'Plain.mp4', 'Plain.funscript',                                                  // one script only
  'Hand.mp4', 'Hand.funscript', 'Hand.twist.funscript',                            // a set made by hand
  'Kept.mp4', 'Kept.funscript', 'Kept.twist.funscript', 'Other.funscript',         // a single picked by hand, inactive
];

function seed(src) {
  const p = (n) => path.join(src, n);
  return {
    'player.preferMultiAxis': 'multi',
    'library.associations': {
      [p('Hand.mp4')]: {
        active: 'multi', single: null, custom: null,
        multi: { main: p('Hand.funscript'), axes: { twist: p('Hand.twist.funscript') }, buttplugVib: false },
      },
      // Unpaired (nothing active) but holding a script the user picked once.
      [p('Kept.mp4')]: { active: null, single: p('Other.funscript'), multi: null, custom: null },
    },
  };
}

describe('Default playback back to Single: the auto-paired go back, the hand-made stay', () => {
  it('Multi-axis when available pairs ONLY the videos with axis files', async () => {
    const src = path.join(tmp, 'lib');
    tree(src, FILES);
    const settings = settingsStore(seed(src));
    const lib = await load(src, settings);
    const a = assoc(settings);
    expect(a[path.join(src, 'Axes.mp4')]).toMatchObject({ active: 'multi', multi: { autoAssigned: true } });
    expect(a[path.join(src, 'Kept.mp4')]).toMatchObject({ active: 'multi', single: path.join(src, 'Other.funscript'), multi: { autoAssigned: true } });
    // One script: nothing to pair, nothing stored, plays as it always did.
    expect(a[path.join(src, 'Plain.mp4')]).toBeUndefined();
    expect(video(lib, 'Plain.mp4')._multiAxis || null).toBeNull();
  });

  it('switching to Single puts back the two FunSync paired, and touches nothing set by hand', async () => {
    const src = path.join(tmp, 'lib');
    tree(src, FILES);
    const settings = settingsStore(seed(src));
    const lib = await load(src, settings);
    const handBefore = assoc(settings)[path.join(src, 'Hand.mp4')];

    settings.set('player.preferMultiAxis', 'single');   // the Settings select
    expect(lib._revertAutoPromotion()).toBe(2);

    const a = assoc(settings);
    // Paired by FunSync, nothing else in it: the entry is gone, as before pairing.
    expect(a[path.join(src, 'Axes.mp4')]).toBeUndefined();
    // The script the user once picked stays in the entry, inactive (as Unpair keeps it).
    expect(a[path.join(src, 'Kept.mp4')]).toEqual({ active: null, single: path.join(src, 'Other.funscript'), multi: null, custom: null });
    // A set made by hand is the user's: untouched.
    expect(a[path.join(src, 'Hand.mp4')]).toEqual(handBefore);

    // In memory, at once: the next play is the same-name script alone.
    const v = video(lib, 'Axes.mp4');
    expect(v._multiAxis).toBeNull();
    expect(v._manualAssociation).toBe(false);
    expect(v._autoAssigned).toBe(false);
    expect(v.funscriptPath).toBe(path.join(src, 'Axes.funscript'));
    expect(video(lib, 'Hand.mp4')._multiAxis).toBeTruthy();

    // A fresh load under Single finds the same thing (nothing re-pairs).
    const reloaded = await load(src, settings);
    expect(video(reloaded, 'Axes.mp4')._multiAxis || null).toBeNull();
    expect(assoc(settings)[path.join(src, 'Axes.mp4')]).toBeUndefined();
  });

  it('back on Multi-axis when available, they are paired again', async () => {
    const src = path.join(tmp, 'lib');
    tree(src, FILES);
    const settings = settingsStore(seed(src));
    const lib = await load(src, settings);
    settings.set('player.preferMultiAxis', 'single');
    lib._revertAutoPromotion();
    settings.set('player.preferMultiAxis', 'multi');
    expect(lib._reapplyAutoPromotion()).toBe(2);
    expect(assoc(settings)[path.join(src, 'Axes.mp4')]).toMatchObject({ active: 'multi', multi: { autoAssigned: true } });
  });

  it('does nothing while the setting is still Multi-axis when available', async () => {
    const src = path.join(tmp, 'lib');
    tree(src, FILES);
    const settings = settingsStore(seed(src));
    const lib = await load(src, settings);
    const writes = settings.writes.length;
    expect(lib._revertAutoPromotion()).toBe(0);
    expect(settings.writes.length).toBe(writes);
  });

  it('an auto-paired set the user then saved through Change… is theirs: it stays', async () => {
    const src = path.join(tmp, 'lib');
    tree(src, FILES);
    const settings = settingsStore(seed(src));
    await load(src, settings);
    // A save through the association modal builds a fresh slot, without autoAssigned.
    const a = assoc(settings);
    const key = path.join(src, 'Axes.mp4');
    const { autoAssigned, ...saved } = a[key].multi;
    a[key] = { ...a[key], multi: saved };
    settings.set('library.associations', a);
    const lib = await load(src, settings);
    settings.set('player.preferMultiAxis', 'single');
    expect(lib._revertAutoPromotion()).toBe(1);   // only Kept
    expect(assoc(settings)[key]).toMatchObject({ active: 'multi' });
  });
});

describe('Dave: "would playing a multi axis video with only a handy connected still work?"', () => {
  it('yes: what a multi-axis video sends to the player is its MAIN script, with the axis files only attached', async () => {
    const src = path.join(tmp, 'lib');
    tree(src, FILES);
    const settings = settingsStore(seed(src));
    const lib = await load(src, settings);
    const v = video(lib, 'Axes.mp4');
    expect(v._multiAxis).toBeTruthy();

    const { funscriptData } = await lib.resolvePlayData(v);
    // The text the player loads (and uploads to the Handy) is Axes.funscript's own.
    expect(JSON.parse(funscriptData.textContent).file).toBe('Axes.funscript');
    expect(funscriptData._funscriptPath).toBe(path.join(src, 'Axes.funscript'));
    // The axis files ride along for Intiface / T-Code only.
    expect(Object.keys(funscriptData._multiAxis.axes).sort()).toEqual(['pitch', 'roll']);

    // The same video under Single loads the very same main text.
    settings.set('player.preferMultiAxis', 'single');
    lib._revertAutoPromotion();
    const single = await lib.resolvePlayData(video(lib, 'Axes.mp4'));
    expect(single.funscriptData.textContent).toBe(funscriptData.textContent);
    expect(single.funscriptData._multiAxis).toBeUndefined();
  });
});
