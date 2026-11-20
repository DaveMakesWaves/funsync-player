/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// FT-102 (Pudknocker #372): "If only one video is in a directory, automatic
// association of any funscripts in that directory with that video (allows
// for easy use of journeys and fapland rounds)".
//
// Opt-in: Settings > Library "One-video folders", `library.folderScriptsAsVariants`,
// default false. When on, a folder holding exactly one video offers every
// non-axis script in it as a variant of that video. Its own script stays the
// default, axis files stay axis files, nothing is written anywhere.
//
// The REAL scan (electron/library-scan.js) against real temp folders, and the
// REAL `scan-directory` handler lifted out of main.js with the REAL store.js
// (electron-conf mocked, no file), so the default and the wiring are what the
// app runs. What is asserted is what the scan offers: the variant list a
// video's menu and the phone show, its script, and what is left unmatched.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { liftMainHandler } from './helpers/main-handlers.js';

const require_ = createRequire(import.meta.url);
const { scanLibrary } = require_('../../electron/library-scan.js');

// electron-conf as the store sees it on a first run: the defaults, no file.
class MockConf {
  constructor({ defaults }) { this._data = JSON.parse(JSON.stringify(defaults)); }
  get(p) {
    let v = this._data;
    for (const k of p.split('.')) {
      if (v == null || typeof v !== 'object') return undefined;
      v = v[k];
    }
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  }
  set(p, value) {
    const keys = p.split('.');
    let o = this._data;
    for (const k of keys.slice(0, -1)) o = (o[k] ??= {});
    o[keys.at(-1)] = JSON.parse(JSON.stringify(value));
  }
}
vi.mock('electron-conf', () => ({ default: MockConf }));
const store = await import('../../electron/store.js');

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'funsync-folder-variants-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Create files (and their folders) under `root`. */
function tree(root, files) {
  for (const rel of files) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, rel.endsWith('.funscript') ? `{"actions":[],"n":${JSON.stringify(rel)}}` : 'x');
  }
}

const quietLog = () => ({ info: vi.fn(), warn: vi.fn() });
const scan = (src, on) => scanLibrary(src, { [src]: 'src' }, { log: quietLog(), folderScriptsAsVariants: on });
const video = (r, name) => r.videos.find((v) => v.name === name);
const labels = (v) => v.variants.map((x) => x.label);
const unmatched = (r) => r.unmatchedFunscripts.map((x) => x.name).sort();

const JOURNEY = [
  'Journey/Journey.mp4',
  'Journey/Journey.funscript',
  'Journey/Round 1.funscript',
  'Journey/Round 2.funscript',
  'Journey/Round 10.funscript',
  'Journey/Journey.roll.funscript',     // the video's own companion axis
  'Journey/Round 1.twist.funscript',    // an axis file whose video is not here
];

describe('FT-102: a one-video folder offers its scripts as variants (opt-in)', () => {
  it('off: the video has its own script only, the rounds stay unmatched', async () => {
    const src = path.join(tmp, 'off');
    tree(src, JOURNEY);
    const r = await scan(src, false);
    const v = video(r, 'Journey.mp4');
    expect(v.funscriptPath).toBe(path.join(src, 'Journey', 'Journey.funscript'));
    expect(labels(v)).toEqual(['Default']);
    expect(unmatched(r)).toEqual(['Round 1.funscript', 'Round 1.twist.funscript', 'Round 10.funscript', 'Round 2.funscript']);
  });

  it('on: its own script stays the default, every other script follows in round order, labelled by name', async () => {
    const src = path.join(tmp, 'on');
    tree(src, JOURNEY);
    const r = await scan(src, true);
    const v = video(r, 'Journey.mp4');
    expect(v.funscriptPath).toBe(path.join(src, 'Journey', 'Journey.funscript'));
    expect(labels(v)).toEqual(['Default', 'Round 1', 'Round 2', 'Round 10']);
    expect(v.variants[0].path).toBe(v.funscriptPath);              // index 0 is what a load plays
    expect(v.variants.find((x) => x.label === 'Round 10').path).toBe(path.join(src, 'Journey', 'Round 10.funscript'));
    // Axis files are never variants: the video's own companion stays its
    // axis (matched, so not unmatched either); the orphan axis stays an orphan.
    expect(v.variants.some((x) => /\.(roll|twist)\.funscript$/.test(x.name))).toBe(false);
    expect(unmatched(r)).toEqual(['Round 1.twist.funscript']);
  });

  it('on, no script named after the video: it plays the first round and lists them all', async () => {
    const src = path.join(tmp, 'fapland');
    tree(src, ['FapLand/Big Video.mp4', 'FapLand/Round 2.funscript', 'FapLand/Round 1.funscript']);
    const off = video(await scan(src, false), 'Big Video.mp4');
    expect(off.hasFunscript).toBe(false);
    const on = video(await scan(src, true), 'Big Video.mp4');
    expect(on.hasFunscript).toBe(true);
    expect(on.funscriptPath).toBe(path.join(src, 'FapLand', 'Round 1.funscript'));
    expect(labels(on)).toEqual(['Round 1', 'Round 2']);
  });

  it('a folder with two videos is left exactly as it was', async () => {
    const src = path.join(tmp, 'pair');
    tree(src, ['Pair/A.mp4', 'Pair/B.mp4', 'Pair/A.funscript', 'Pair/Extra.funscript']);
    const off = await scan(src, false);
    const on = await scan(src, true);
    expect(on.videos).toEqual(off.videos);
    expect(labels(video(on, 'A.mp4'))).toEqual(['Default']);
    expect(video(on, 'B.mp4').hasFunscript).toBe(false);
    expect(unmatched(on)).toEqual(['Extra.funscript']);
  });

  it('counts the folder itself, not its subfolders, on both sides', async () => {
    const src = path.join(tmp, 'nested');
    tree(src, ['J/Main.mp4', 'J/R1.funscript', 'J/sub/Other.mp4', 'J/sub/S.funscript']);
    const r = await scan(src, true);
    expect(labels(video(r, 'Main.mp4'))).toEqual(['R1']);
    expect(labels(video(r, 'Other.mp4'))).toEqual(['S']);
  });

  it('the video\'s own variants keep their labels; a name that repeats one is told apart', async () => {
    const src = path.join(tmp, 'labels');
    tree(src, ['K/Clip.mp4', 'K/Clip.funscript', 'K/Clip (Soft).funscript', 'K/Soft.funscript']);
    const v = video(await scan(src, true), 'Clip.mp4');
    expect(labels(v)).toEqual(['Default', 'Soft', 'Soft.funscript']);
    expect(new Set(labels(v).map((l) => l.toLowerCase())).size).toBe(v.variants.length);
  });

  it('a fuzzy-paired script leads, named Default, with the folder\'s other scripts after it', async () => {
    const src = path.join(tmp, 'fuzzy');
    // "Scene One" and "Scene_One" tokenise the same: fuzzy, not by name.
    tree(src, ['F/[Studio] Scene One.mp4', 'F/Scene One [Studio].funscript', 'F/Bonus.funscript']);
    const v = video(await scan(src, true), '[Studio] Scene One.mp4');
    expect(v.funscriptPath).toBe(path.join(src, 'F', 'Scene One [Studio].funscript'));
    expect(v.variants.map((x) => [x.label, x.name])).toEqual([
      ['Default', 'Scene One [Studio].funscript'],
      ['Bonus', 'Bonus.funscript'],
    ]);
  });

  it('writes nothing: every file in the folder is byte-identical, and nothing is added', async () => {
    const src = path.join(tmp, 'untouched');
    tree(src, JOURNEY);
    const snap = () => fs.readdirSync(path.join(src, 'Journey')).sort().map((n) => {
      const p = path.join(src, 'Journey', n);
      return [n, fs.readFileSync(p, 'utf8'), fs.statSync(p).mtimeMs];
    });
    const before = snap();
    await scan(src, true);
    expect(snap()).toEqual(before);
  });
});

describe('FT-102: the setting, through the REAL store and the scan-directory handler', () => {
  async function handlerScan(src) {
    const handler = liftMainHandler('scan-directory', {
      scanLibrary,
      store,
      log: quietLog(),
      path,
      // No backend in a test: the registration post goes nowhere.
      fetch: vi.fn(async () => ({ ok: true })),
      require: () => ({ app: { getPath: () => tmp } }),
    });
    return handler({}, src, { [src]: 'src' });
  }

  it('defaults to off in electron/store.js, and the scan then offers nothing extra', async () => {
    await store.initStore();
    expect(store.DEFAULTS.settings.library.folderScriptsAsVariants).toBe(false);
    expect(store.getSetting('library.folderScriptsAsVariants')).toBe(false);
    expect(store.getAll().settings.library.folderScriptsAsVariants).toBe(false);
    const src = path.join(tmp, 'store-off');
    tree(src, JOURNEY);
    expect(labels(video(await handlerScan(src), 'Journey.mp4'))).toEqual(['Default']);
  });

  it('turned on in the store, every scan the app runs offers the rounds; off again, they are gone', async () => {
    await store.initStore();
    const src = path.join(tmp, 'store-on');
    tree(src, JOURNEY);
    store.setSetting('library.folderScriptsAsVariants', true);
    expect(labels(video(await handlerScan(src), 'Journey.mp4'))).toEqual(['Default', 'Round 1', 'Round 2', 'Round 10']);
    // A rescan of just the video's folder (the variant menu's) agrees.
    expect(labels(video(await handlerScan(path.join(src, 'Journey')), 'Journey.mp4'))).toEqual(['Default', 'Round 1', 'Round 2', 'Round 10']);
    store.setSetting('library.folderScriptsAsVariants', false);
    expect(labels(video(await handlerScan(src), 'Journey.mp4'))).toEqual(['Default']);
  });

  it('the settings-panel fallback constant agrees with the store default', () => {
    const src = fs.readFileSync('renderer/components/settings-panel.js', 'utf8');
    const m = src.match(/'library\.folderScriptsAsVariants':\s*(true|false)/);
    expect(m, 'SETTINGS_DEFAULTS is missing library.folderScriptsAsVariants').not.toBeNull();
    expect(m[1] === 'true').toBe(store.DEFAULTS.settings.library.folderScriptsAsVariants);
  });
});
