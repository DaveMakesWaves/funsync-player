/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The REAL library scan's last pairing pass (electron/library-scan.js): a
// video no name rule paired gets a script whose title has the same words
// (Jaccard index of the word sets >= 98%).
//
// V82 (Dave, 2026-11-03): Recheck and Refresh were slow. Profiled in the
// app's main process on his library (1,547 videos, 2,463 scripts): this pass
// was 3.3 s of a 5.1 s scan, synchronous, because it re-tokenised BOTH titles
// for every (video, script) pair, about 650,000 pairs. It now tokenises each
// title once and skips pairs whose word counts alone rule out 98%. The pairs
// it makes must not change, so the threshold arithmetic is pinned here at
// its edges, along with the order and the time.
//
// The folders are fake (an injected readdir), under a path that does not
// exist, so nothing here touches a real drive.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const { scanLibrary } = require_('../../electron/library-scan.js');

const ROOT = path.join(os.tmpdir(), 'funsync-fuzzy-pairing-does-not-exist');
const quiet = { info() {}, warn() {} };

const file = (name) => ({ name, parentPath: ROOT, isFile: () => true, isDirectory: () => false });
/** A one-folder source listing exactly these file names, in this order. */
const listing = (names) => async (dir) => {
  if (dir !== ROOT) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return names.map(file);
};
const scan = (names) => scanLibrary(ROOT, { [ROOT]: 'Test' }, { log: quiet, readdir: listing(names) });
const byName = (r, name) => r.videos.find((v) => v.name === name);
const words = (n, prefix = 'w') => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ');

describe('fuzzy pairing finds the same scripts (V82)', () => {
  it('pairs a title whose words are the same in another order and brackets', async () => {
    const r = await scan(['Scene (Final) Name.mp4', 'Name Scene Final.funscript']);
    const v = byName(r, 'Scene (Final) Name.mp4');
    expect(v.hasFunscript).toBe(true);
    expect(v.funscriptPath).toBe(path.join(ROOT, 'Name Scene Final.funscript'));
    expect(r.unmatchedFunscripts).toEqual([]);
  });

  it('does not pair titles that share only some of their words', async () => {
    const r = await scan(['Alpha Beta Gamma Delta.mp4', 'Alpha Beta Gamma Epsilon.funscript']);
    expect(byName(r, 'Alpha Beta Gamma Delta.mp4').hasFunscript).toBe(false);
    expect(r.unmatchedFunscripts.map((f) => f.name)).toEqual(['Alpha Beta Gamma Epsilon.funscript']);
  });

  it('the 98% edge: 40 of 41 words pairs (97.6 rounds up), 30 of 31 does not (96.8)', async () => {
    const r = await scan([
      `${words(40, 'a')}.mp4`, `${words(40, 'a')} extra.funscript`,
      `${words(30, 'b')}.mp4`, `${words(30, 'b')} extra.funscript`,
    ]);
    expect(byName(r, `${words(40, 'a')}.mp4`).hasFunscript).toBe(true);
    expect(byName(r, `${words(30, 'b')}.mp4`).hasFunscript).toBe(false);
  });

  it('when two scripts tie, the first one listed wins and both become variants', async () => {
    const r = await scan(['Scene (Final) Name.mp4', 'Final Name Scene.funscript', 'Name Scene Final.funscript']);
    const v = byName(r, 'Scene (Final) Name.mp4');
    expect(v.funscriptPath).toBe(path.join(ROOT, 'Final Name Scene.funscript'));
    expect(v.variants.map((x) => x.name).sort()).toEqual(['Final Name Scene.funscript', 'Name Scene Final.funscript']);
  });

  it('a script already paired is not paired again', async () => {
    const r = await scan(['Scene (Final) Name.mp4', 'Final (Scene) Name.mp4', 'Name Scene Final.funscript']);
    const paired = r.videos.filter((v) => v.hasFunscript);
    expect(paired).toHaveLength(1);
  });
});

describe('scan result order (V82: one collator instead of one per comparison)', () => {
  it('lists videos and scripts in the same order localeCompare gave', async () => {
    const names = ['Zebra.mp4', 'clip 2.mp4', 'Clip 10.mp4', 'Clip 9.mp4', 'Ärger.mp4', 'apple.mp4', 'Apple.mkv', 'éclair.mp4', 'Eclair.mp4'];
    const scripts = ['zz.funscript', 'Aa.funscript', 'ää.funscript', 'b 10.funscript', 'b 9.funscript'];
    const r = await scan([...names, ...scripts]);
    const ref = (list) => [...list].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    expect(r.videos.map((v) => v.name)).toEqual(ref(r.videos.map((v) => v.name)));
    expect(r.videos.map((v) => v.name)).toEqual(ref(names));
    expect(r.allFunscripts.map((f) => f.name)).toEqual(ref(scripts));
    expect(r.unmatchedFunscripts.map((f) => f.name)).toEqual(ref(scripts));
  });
});

describe('fuzzy pairing on a large library stays fast (V82 perf guard)', () => {
  it('1,000 unpaired videos against 4,000 scripts scans well under 3 s', async () => {
    // Titles of 3-12 made-up words, none sharing a word set, so every video
    // reaches the fuzzy pass and none pairs: the worst case for it.
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const title = (tag, i) => Array.from({ length: 3 + Math.floor(rnd() * 10) }, (_, k) => `${tag}${i}x${k}${Math.floor(rnd() * 50)}`).join(' ');
    const names = [];
    for (let i = 0; i < 1000; i++) names.push(`${title('v', i)}.mp4`);
    for (let i = 0; i < 4000; i++) names.push(`${title('s', i)}.funscript`);

    const t0 = performance.now();
    const r = await scan(names);
    const ms = performance.now() - t0;

    expect(r.videos).toHaveLength(1000);
    expect(r.videos.filter((v) => v.hasFunscript)).toHaveLength(0);
    expect(ms).toBeLessThan(3000);
  });
});
