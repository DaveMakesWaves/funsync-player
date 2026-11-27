/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// A script variant's own axis files are its video's, not stray scripts
// (TODO "Found while editing Dave's scripts", 2026-11-20; also in v0.9.2).
//
// "Title (muted).vib.funscript" beside "Title (muted).funscript" (a variant of
// "Title.mp4") has the base "title (muted)", which no video has, so the scan
// claimed it for nobody: it was listed as an unmatched script, offered as the
// main script of other videos, and the player never played it with the
// variant. The player now does (app.js `_multiAxisForScript`, by
// multi-axis.js `sameFolderCompanions`), and the scan claims exactly those
// files: the variant's own folder, its exact name.
//
// The REAL scan (electron/library-scan.js) over real folders in the system
// temp folder, and the REAL multi-axis.js rule.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sameFolderCompanions } from '../../renderer/js/multi-axis.js';

const require_ = createRequire(import.meta.url);
const { scanLibrary } = require_('../../electron/library-scan.js');

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'funsync-variant-axes-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Create files (and their folders) under `root`. */
function tree(root, files) {
  for (const rel of files) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, rel.endsWith('.funscript') ? '{"actions":[]}' : 'x');
  }
}

const quietLog = () => ({ info: vi.fn(), warn: vi.fn() });
const names = (list) => list.map((x) => x.name).sort();

describe('the scan claims a variant\'s own axis files for its video', () => {
  it('beside a parenthesised and a dotted variant; another folder\'s copy and a true orphan stay unmatched', async () => {
    const src = path.join(tmp, 'lib');
    tree(src, [
      'Vibcheck.mp4',
      'Vibcheck.funscript',
      'Vibcheck.vib.funscript',
      'Vibcheck (muted).funscript',
      'Vibcheck (muted).vib.funscript',
      'Vibcheck (muted).R0.funscript',
      'Vibcheck.soft.funscript',
      'Vibcheck.soft.twist.funscript',
      'Orphan (x).vib.funscript',
      'Elsewhere/Vibcheck (muted).vib.funscript',
    ]);
    const r = await scanLibrary(src, { [src]: 'lib' }, { log: quietLog() });

    const video = r.videos.find((v) => v.name === 'Vibcheck.mp4');
    // The variants are the stroke scripts only, as before.
    expect(names(video.variants)).toEqual(['Vibcheck (muted).funscript', 'Vibcheck.funscript', 'Vibcheck.soft.funscript']);
    expect(r.unmatchedFunscripts.map((f) => path.relative(src, f.path)).sort())
      .toEqual([path.join('Elsewhere', 'Vibcheck (muted).vib.funscript'), 'Orphan (x).vib.funscript']);
    // Every file stays in the full list, which the player's lookup reads.
    expect(r.allFunscripts).toHaveLength(9);
  });

  it('claims exactly what the player plays with each variant', async () => {
    const src = path.join(tmp, 'lib');
    tree(src, [
      'Clip.mp4', 'Clip.funscript', 'Clip.pitch.funscript',
      'Clip (Hard).funscript', 'Clip (Hard).vibrate.funscript', 'Clip (Hard).roll.funscript',
      'Clip (Easy).funscript',
      'Clip (Easy).twist.funscript.bak',
      'Other/Clip (Easy).twist.funscript',
    ]);
    const r = await scanLibrary(src, { [src]: 'lib' }, { log: quietLog() });
    const all = r.allFunscripts.map((f) => f.path);
    const unmatched = new Set(r.unmatchedFunscripts.map((f) => f.path));
    const played = new Set();
    for (const v of r.videos.find((x) => x.name === 'Clip.mp4').variants) {
      for (const p of Object.values(sameFolderCompanions(v.path, all))) played.add(p);
    }
    expect([...played].map((p) => path.basename(p)).sort())
      .toEqual(['Clip (Hard).roll.funscript', 'Clip (Hard).vibrate.funscript', 'Clip.pitch.funscript']);
    for (const p of played) expect(unmatched.has(p), `${path.basename(p)} is claimed`).toBe(false);
    // What the player leaves alone, the scan leaves unmatched.
    expect([...unmatched].map((p) => path.relative(src, p))).toEqual([path.join('Other', 'Clip (Easy).twist.funscript')]);
  });

  it('a one-video folder\'s script offered as a variant (FT-102) brings its axis files too', async () => {
    const src = path.join(tmp, 'lib');
    tree(src, [
      'Journey/Journey.mp4', 'Journey/Round 1.funscript', 'Journey/Round 2.funscript', 'Journey/Round 2.vib.funscript',
    ]);
    const r = await scanLibrary(src, { [src]: 'lib' }, { log: quietLog(), folderScriptsAsVariants: true });
    expect(names(r.videos[0].variants)).toEqual(['Round 1.funscript', 'Round 2.funscript']);
    expect(r.unmatchedFunscripts).toEqual([]);
  });
});

describe('sameFolderCompanions (multi-axis.js): the player\'s rule', () => {
  const W = 'C:\\Lib\\';
  const files = [
    `${W}Title (muted).funscript`,
    `${W}Title (muted).vib.funscript`,
    `${W}TITLE (MUTED).Twist.funscript`,      // any case
    `${W}Title (muted).v0.funscript`,         // a second vib spelling: the first one found wins
    `${W}Title (muted).suction.funscript`,    // an alias, keyed by its canonical name
    `${W}Title.vib.funscript`,                // the default's, not the variant's
    'C:\\Other\\Title (muted).pitch.funscript', // another folder
    `${W}Title (muted) extra.roll.funscript`, // another name
  ];

  it('its own folder and exact name only, canonical axis names, the first file per axis', () => {
    expect(sameFolderCompanions(`${W}Title (muted).funscript`, files)).toEqual({
      vib: `${W}Title (muted).vib.funscript`,
      twist: `${W}TITLE (MUTED).Twist.funscript`,
      suck: `${W}Title (muted).suction.funscript`,
    });
  });

  it('forward slashes and a differently cased folder name the same folder', () => {
    expect(sameFolderCompanions('c:/lib/Title (muted).funscript', files)).toHaveProperty('vib', `${W}Title (muted).vib.funscript`);
  });

  it('nothing for a script with no axis files, or with no list', () => {
    expect(sameFolderCompanions(`${W}Title (soft).funscript`, files)).toEqual({});
    expect(sameFolderCompanions(`${W}Title (muted).funscript`, [])).toEqual({});
    expect(sameFolderCompanions(null, files)).toEqual({});
    expect(sameFolderCompanions(`${W}Title (muted).funscript`, null)).toEqual({});
  });
});
