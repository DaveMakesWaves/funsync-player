/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The REAL library scan (electron/library-scan.js, behind main.js
// `scan-directory`), run against real folders on disk.
//
// V04 / forum #360: one permission-denied subfolder made the whole source scan
// as failed. Node's `readdir(root, { recursive: true })` rejects the entire
// call on the first folder it cannot open, so the source listed NO videos and
// the renderer toasted "Source unavailable" for a folder that was plainly
// there. The scan now reads one directory at a time: an unreadable SUBfolder
// is skipped and reported in `skippedPaths`, and only an unreadable ROOT puts
// the source in `failedPaths` (which the prune guards depend on).
//
// V34: companion axis files (Clip.roll.funscript) were never marked as used,
// so every one landed in `unmatchedFunscripts` and the Associate modal
// offered them as the MAIN script for unrelated videos.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const { scanLibrary, walkSource } = require_('../../electron/library-scan.js');

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'funsync-scan-'));
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

/** fs.promises.readdir, except the listed folders refuse like a deny ACL. */
function denying(...denied) {
  const deniedSet = new Set(denied.map((d) => path.resolve(d)));
  return vi.fn(async (dir, opts) => {
    if (deniedSet.has(path.resolve(dir))) {
      const err = new Error(`EPERM: operation not permitted, scandir '${dir}'`);
      err.code = 'EPERM';
      throw err;
    }
    return fs.promises.readdir(dir, opts);
  });
}

const quietLog = () => ({ info: vi.fn(), warn: vi.fn() });
const names = (list) => list.map((x) => x.name).sort();

describe('V04: one unreadable subfolder does not empty the source', () => {
  it('lists everything readable and skips only the locked folder', async () => {
    const src = path.join(tmp, 'lockedsrc');
    tree(src, ['Visible.mp4', 'Visible.funscript', 'Locked Sub/Hidden.mp4', 'Open Sub/Deep.mp4']);
    const locked = path.join(src, 'Locked Sub');
    const log = quietLog();

    const r = await scanLibrary(src, { [src]: 'lockedsrc' }, { log, readdir: denying(locked) });

    expect(names(r.videos)).toEqual(['Deep.mp4', 'Visible.mp4']);
    expect(r.videos.find((v) => v.name === 'Visible.mp4').funscriptPath).toBe(path.join(src, 'Visible.funscript'));
    // The source scanned. It is not unavailable and must not be toasted as such.
    expect(r.failedPaths).toEqual([]);
    // The renderer needs the folder to guard what it could not see.
    expect(r.skippedPaths).toEqual([locked]);
  });

  it('logs the skipped folders once, in one line, naming the reason', async () => {
    const src = path.join(tmp, 'src');
    tree(src, ['a.mp4', 'L1/x.mp4', 'L2/y.mp4']);
    const log = quietLog();

    await scanLibrary(src, {}, { log, readdir: denying(path.join(src, 'L1'), path.join(src, 'L2')) });

    const skipLines = log.warn.mock.calls.map((c) => c[0]).filter((l) => l.includes('Skipped'));
    expect(skipLines).toHaveLength(1);
    expect(skipLines[0]).toContain('Skipped 2 unreadable folder(s)');
    expect(skipLines[0]).toContain('EPERM');
    expect(log.warn.mock.calls.some((c) => c[0].includes('Failed to scan'))).toBe(false);
  });

  it('keeps walking past a locked folder deep in the tree', async () => {
    const src = path.join(tmp, 'src');
    tree(src, ['A/B/locked/secret.mp4', 'A/B/ok.mp4', 'A/sibling.mp4', 'Z/last.mp4']);
    const r = await scanLibrary(src, {}, { log: quietLog(), readdir: denying(path.join(src, 'A', 'B', 'locked')) });
    expect(names(r.videos)).toEqual(['last.mp4', 'ok.mp4', 'sibling.mp4']);
    expect(r.skippedPaths).toEqual([path.join(src, 'A', 'B', 'locked')]);
  });

  // Absence is never destructive: a root we cannot read is a failed source,
  // and the prune guards rely on that. Only the SUBfolder case changed.
  it('still fails the source when the ROOT cannot be read, and scans the others', async () => {
    const dead = path.join(tmp, 'dead');
    const live = path.join(tmp, 'live');
    tree(dead, ['gone.mp4']);
    tree(live, ['here.mp4']);
    const log = quietLog();

    const r = await scanLibrary([dead, live], {}, { log, readdir: denying(dead) });

    expect(r.failedPaths).toEqual([dead]);
    expect(r.skippedPaths).toEqual([]);
    expect(names(r.videos)).toEqual(['here.mp4']);
    expect(log.warn.mock.calls.some((c) => c[0].includes(`Failed to scan ${dead}`))).toBe(true);
  });

  it('fails a source whose folder does not exist (disconnected drive)', async () => {
    const missing = path.join(tmp, 'not-here');
    const r = await scanLibrary(missing, {}, { log: quietLog() });
    expect(r.failedPaths).toEqual([missing]);
    expect(r.videos).toEqual([]);
  });

  it('does not list drive-root system folders, readable or not', async () => {
    const src = path.join(tmp, 'drive');
    tree(src, ['movie.mp4', '$RECYCLE.BIN/S-1-5-21-1/$R1A2B3C.mp4', 'System Volume Information/x.mp4']);
    const r = await scanLibrary(src, {}, { log: quietLog() });
    expect(names(r.videos)).toEqual(['movie.mp4']);
    expect(r.skippedPaths).toEqual([]);
  });

  // First-match-wins pairing depends on entry order. The per-folder walk must
  // list a healthy tree exactly as the recursive readdir it replaced did.
  it('lists a healthy tree in the same order as recursive readdir', async () => {
    const src = path.join(tmp, 'order');
    tree(src, [
      'b.mp4', 'a.funscript', 'Sub1/c.mp4', 'Sub1/Deeper/d.mp4', 'Sub1/Deeper/e.funscript',
      'Sub2/f.mp4', 'Sub2/g.srt', 'Sub3/Inner/h.mp4', 'z.mp4',
    ]);
    const asPaths = (dirents) => dirents.map((d) => path.join(d.parentPath || d.path, d.name));

    const recursive = await fs.promises.readdir(src, { withFileTypes: true, recursive: true });
    const { entries, skipped } = await walkSource(src);

    expect(skipped).toEqual([]);
    expect(asPaths(entries)).toEqual(asPaths(recursive));
  });

  // The real thing: a Windows deny ACL, as in the fixture for forum #360.
  // Proves the shape the fake above stands in for (recursive readdir rejects,
  // the root still lists the locked folder) on this platform's actual fs.
  it.runIf(process.platform === 'win32')('scans past a folder with a real deny ACL (Windows)', async () => {
    const src = path.join(tmp, 'aclsrc');
    tree(src, ['Visible.mp4', 'Locked Sub/Hidden.mp4']);
    const locked = path.join(src, 'Locked Sub');
    const user = process.env.USERNAME;
    execFileSync('icacls', [locked, '/deny', `${user}:(OI)(CI)(RX)`], { stdio: 'ignore' });
    try {
      // Only meaningful if the deny actually took (an elevated shell with
      // backup privilege can still list it).
      const denied = await fs.promises.readdir(locked).then(() => false, () => true);
      if (!denied) return;
      await expect(fs.promises.readdir(src, { withFileTypes: true, recursive: true })).rejects.toThrow();

      const r = await scanLibrary(src, {}, { log: quietLog() });

      expect(names(r.videos)).toEqual(['Visible.mp4']);
      expect(r.failedPaths).toEqual([]);
      expect(r.skippedPaths).toEqual([locked]);
    } finally {
      execFileSync('icacls', [locked, '/remove:d', user], { stdio: 'ignore' });
    }
  });
});

describe('V34: companion axis files are matched, not offered to other videos', () => {
  it('a video with .roll/.pitch/.twist companions leaves nothing unmatched', async () => {
    const src = path.join(tmp, 'lib');
    tree(src, [
      'Companion Clip.mp4', 'Companion Clip.funscript',
      'Companion Clip.roll.funscript', 'Companion Clip.pitch.funscript', 'Companion Clip.twist.funscript',
      'Variant Clip.mp4', 'Variant Clip.funscript', 'Variant Clip (Soft).funscript',
    ]);

    const r = await scanLibrary(src, {}, { log: quietLog() });

    expect(r.unmatchedFunscripts).toEqual([]);
    // Companion detection reads allFunscripts, so the axis files must still be there.
    expect(names(r.allFunscripts)).toEqual(expect.arrayContaining([
      'Companion Clip.roll.funscript', 'Companion Clip.pitch.funscript', 'Companion Clip.twist.funscript',
    ]));
    // And claiming them does not turn them into variants of their video.
    const companion = r.videos.find((v) => v.name === 'Companion Clip.mp4');
    expect(companion.funscriptPath).toBe(path.join(src, 'Companion Clip.funscript'));
    expect(companion.variants.map((v) => v.name)).toEqual(['Companion Clip.funscript']);
  });

  it('an orphan axis file (no such video) stays unmatched', async () => {
    const src = path.join(tmp, 'lib');
    tree(src, ['Real.mp4', 'Real.funscript', 'Nobody.roll.funscript']);
    const r = await scanLibrary(src, {}, { log: quietLog() });
    expect(names(r.unmatchedFunscripts)).toEqual(['Nobody.roll.funscript']);
  });

  it('claims companions that sit in another folder from their video', async () => {
    const src = path.join(tmp, 'lib');
    tree(src, ['Videos/Clip.mp4', 'Scripts/Clip.funscript', 'Scripts/Clip.surge.funscript']);
    const r = await scanLibrary(src, {}, { log: quietLog() });
    expect(r.unmatchedFunscripts).toEqual([]);
  });

  it('prefers same-folder companions when two folders share a name', async () => {
    const src = path.join(tmp, 'lib');
    tree(src, ['A/Clip.mp4', 'A/Clip.roll.funscript', 'B/Clip.roll.funscript']);
    const r = await scanLibrary(src, {}, { log: quietLog() });
    // B has no Clip video of its own, and A's video found its companion
    // locally, so B's file is left for the user to see.
    expect(r.unmatchedFunscripts.map((f) => f.path)).toEqual([path.join(src, 'B', 'Clip.roll.funscript')]);
  });
});

// FT-047 (also in v0.9.2): the scan knew ten axis names, the player
// (renderer/js/multi-axis.js) twenty-five. `Clip.suck.funscript` or
// `Clip.R0.funscript`, axis files the player loads as Suck and Twist, were
// classified as dot-VARIANTS of Clip by the scan, so the variant menu offered
// them as stroke scripts and picking one played twist data as strokes.
describe('FT-047: the scan knows every axis name the player knows', () => {
  it('the exported set is exactly the union of the player\'s axis spellings', async () => {
    const { AXIS_SUFFIXES } = require_('../../electron/library-scan.js');
    const { AXIS_DEFINITIONS, axisSuffixVariants } = await import('../../renderer/js/multi-axis.js');
    const player = new Set(AXIS_DEFINITIONS.flatMap((a) => axisSuffixVariants(a).map((s) => s.toLowerCase())));
    expect([...AXIS_SUFFIXES].sort()).toEqual([...player].sort());
  });

  it('Clip.suck / .R0 / .yaw / .a1 are axis files, not variants, and nothing is unmatched', async () => {
    const src = path.join(tmp, 'lib');
    tree(src, [
      'Clip.mp4', 'Clip.funscript',
      'Clip.suck.funscript', 'Clip.R0.funscript', 'Clip.yaw.funscript', 'Clip.a1.funscript',
    ]);

    const r = await scanLibrary(src, {}, { log: quietLog() });

    const clip = r.videos.find((v) => v.name === 'Clip.mp4');
    expect(clip.funscriptPath).toBe(path.join(src, 'Clip.funscript'));
    expect(clip.variants.map((v) => v.label)).toEqual(['Default']);
    expect(r.unmatchedFunscripts).toEqual([]);
    // Companion detection reads allFunscripts: every axis file is still listed.
    expect(names(r.allFunscripts).sort()).toEqual([
      'Clip.a1.funscript', 'Clip.funscript', 'Clip.R0.funscript', 'Clip.suck.funscript', 'Clip.yaw.funscript',
    ].sort());
  });

  it('an axis file under an alias never becomes the MAIN script of its video', async () => {
    // No Clip.funscript: before FT-047 the lone `.R0` was an ambiguous
    // dot-variant, demoted to a primary and fuzzy-paired with Clip.mp4, so
    // the video played a twist script as its stroke.
    const src = path.join(tmp, 'lib');
    tree(src, ['Clip.mp4', 'Clip.R0.funscript']);
    const r = await scanLibrary(src, {}, { log: quietLog() });
    const clip = r.videos.find((v) => v.name === 'Clip.mp4');
    expect(clip.hasFunscript).toBe(false);
    expect(clip.variants).toEqual([]);
    expect(r.unmatchedFunscripts).toEqual([]);   // claimed as Clip's companion
  });
});

// Stash S1 Round 2 (2026-11-18): every video carries its size in bytes, from
// the stat the scan already makes for dateAdded. The Stash trust check
// (renderer/js/stash-tags.js) shows a video's Stash data only while its size
// is the one it was matched with; an unknown size (null) is trusted.
describe('size on each video (Stash trust check)', () => {
  it('is the file size from the same stat as dateAdded', async () => {
    const src = path.join(tmp, 'lib');
    tree(src, ['Small.mp4', 'Sub/Big.mkv']);
    fs.writeFileSync(path.join(src, 'Sub', 'Big.mkv'), Buffer.alloc(4321));
    const r = await scanLibrary(src, {}, { log: quietLog() });
    const byName = Object.fromEntries(r.videos.map((v) => [v.name, v]));
    expect(byName['Small.mp4'].size).toBe(1);
    expect(byName['Big.mkv'].size).toBe(4321);
    expect(byName['Big.mkv'].dateAdded).toBeGreaterThan(0);
  });

  it('is null (unknown) when the stat fails, as dateAdded falls back to 0', async () => {
    const src = path.join(tmp, 'lib');
    tree(src, ['Gone.mp4']);
    const spy = vi.spyOn(fs.promises, 'stat').mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }));
    try {
      const r = await scanLibrary(src, {}, { log: quietLog() });
      expect(r.videos.map((v) => [v.name, v.size, v.dateAdded])).toEqual([['Gone.mp4', null, 0]]);
    } finally {
      spy.mockRestore();
    }
  });
});
