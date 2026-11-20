/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Duplicate detection (pallokala2, EroScripts #330).
//
// This feeds a DELETE button, so the tests are weighted toward the ways it
// could destroy something rather than the ways it could miss something. In
// order of how much they would cost a user:
//
//   - a group that overlaps another group (delete the same file twice, or
//     "keep one" in each of two groups and end up keeping none)
//   - a group whose keeper is the scripted copy being suggested for removal
//   - a weak name-only match presented with the confidence of a byte match
//
// Missing a duplicate just means less disk reclaimed. Deleting the wrong file
// means a user lost a video. The asymmetry drives everything here.
import { describe, it, expect } from 'vitest';
import {
  findDuplicates, pickKeeper, totalReclaimable, formatBytes,
  TIER, DURATION_TOLERANCE_SEC, sameSizeCandidates,
} from '../../renderer/js/duplicate-finder.js';

const v = (name, over = {}) => ({
  path: `C:/lib/${name}`, name, size: 1000, duration: 100, hasFunscript: false, ...over,
});

describe('findDuplicates — strong evidence', () => {
  it('groups byte-identical files under different names', () => {
    const groups = findDuplicates([
      v('holiday.mp4', { size: 5000, contentHash: 'H-holiday' }),
      v('holiday-copy.mp4', { size: 5000, contentHash: 'H-holiday' }),
      v('unrelated.mp4', { size: 9999, duration: 400 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].tier).toBe(TIER.IDENTICAL);
    expect(groups[0].members.map((m) => m.name).sort())
      .toEqual(['holiday-copy.mp4', 'holiday.mp4']);
  });

  it('calls same-duration different-size a re-encode, not identical', () => {
    const groups = findDuplicates([
      v('film-4k.mp4', { size: 8000, duration: 300 }),
      v('film-1080.mp4', { size: 2000, duration: 300 }),
    ]);
    expect(groups[0].tier).toBe(TIER.LIKELY);
  });

  it('tolerates a small duration difference (with a corroborating name)', () => {
    const groups = findDuplicates([
      v('Beach Day 4K.mp4', { size: 10, duration: 300 }),
      v('Beach Day 1080p.mp4', { size: 20, duration: 300 + DURATION_TOLERANCE_SEC }),
    ]);
    expect(groups).toHaveLength(1);
  });

  it('does not group durations beyond the tolerance', () => {
    const groups = findDuplicates([
      v('a.mp4', { size: 10, duration: 300 }),
      v('b.mp4', { size: 20, duration: 300 + DURATION_TOLERANCE_SEC + 5 }),
    ]);
    expect(groups).toHaveLength(0);
  });

  it('ignores missing or zero sizes rather than grouping everything at 0', () => {
    // Every un-probed file having size 0 must not collapse a whole library
    // into one enormous "identical" group.
    const groups = findDuplicates([
      v('a.mp4', { size: 0, duration: 11 }),
      v('b.mp4', { size: 0, duration: 22 }),
      v('c.mp4', { size: undefined, duration: 33 }),
    ]);
    expect(groups).toHaveLength(0);
  });
});

describe('findDuplicates — weak evidence is labelled as weak', () => {
  it('groups similar names as POSSIBLE only', () => {
    const groups = findDuplicates([
      v('Beach Day Extended Cut.mp4', { size: 111, duration: 11 }),
      v('Beach Day Extended Cut 2.mp4', { size: 222, duration: 22 }),
    ]);
    if (groups.length) expect(groups[0].tier).toBe(TIER.POSSIBLE);
  });

  it('does not group plainly different names', () => {
    const groups = findDuplicates([
      v('Beach Day.mp4', { size: 111, duration: 11 }),
      v('Mountain Hike In Winter.mp4', { size: 222, duration: 22 }),
    ]);
    expect(groups).toHaveLength(0);
  });

  it('a group is only as strong as its WEAKEST link', () => {
    // Two byte-identical files plus a third joined by name alone. Reporting
    // this as "identical" would overstate the case for the third member —
    // and the third member is the one someone might wrongly delete.
    const groups = findDuplicates([
      v('Summer Trip Final.mp4', { size: 5000, duration: 100, contentHash: 'H-summer' }),
      v('Summer Trip Final copy.mp4', { size: 5000, duration: 100, contentHash: 'H-summer' }),
      v('Summer Trip Final Cut.mp4', { size: 7777, duration: 900 }),
    ]);
    const big = groups.find((g) => g.members.length === 3);
    if (big) expect(big.tier).toBe(TIER.POSSIBLE);
  });
});

describe('findDuplicates — grouping integrity', () => {
  it('never puts one file in two groups', () => {
    // Overlapping groups in a delete UI let the same file be removed twice,
    // or every copy be removed because each pairing "kept one".
    const groups = findDuplicates([
      v('a.mp4', { size: 100, duration: 50, contentHash: 'H-ab' }),
      v('b.mp4', { size: 100, duration: 50, contentHash: 'H-ab' }),
      v('c.mp4', { size: 200, duration: 50, contentHash: 'H-cd' }),
      v('d.mp4', { size: 200, duration: 50, contentHash: 'H-cd' }),
    ]);
    const seen = new Set();
    for (const g of groups) {
      for (const m of g.members) {
        expect(seen.has(m.path), `${m.path} appeared in two groups`).toBe(false);
        seen.add(m.path);
      }
    }
  });

  it('byte-identical copies join a re-encode group together — one group of three', () => {
    // A and B are byte-identical; C shares their runtime AND enough of the
    // name to corroborate. All three belong to one group. (Only byte
    // identity is transitive — see "no chaining" below.)
    const groups = findDuplicates([
      v('Beach Day.mp4', { size: 100, duration: 50, contentHash: 'H-beach' }),
      v('Beach Day copy.mp4', { size: 100, duration: 50, contentHash: 'H-beach' }),
      v('Beach Day 1080p.mp4', { size: 300, duration: 50 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toHaveLength(3);
  });

  it('every group keeps at least two members', () => {
    const groups = findDuplicates([v('lonely.mp4', { size: 42, duration: 7 })]);
    expect(groups).toHaveLength(0);
  });

  it('handles empty and tiny inputs without throwing', () => {
    expect(findDuplicates([])).toEqual([]);
    expect(findDuplicates(null)).toEqual([]);
    expect(findDuplicates([v('one.mp4')])).toEqual([]);
  });

  it('skips entries with no path rather than grouping them', () => {
    const groups = findDuplicates([{ name: 'x', size: 5 }, v('a.mp4', { size: 5 })]);
    expect(groups).toHaveLength(0);
  });
});

describe('pickKeeper — the scripted copy wins', () => {
  it('prefers the copy that has a funscript', () => {
    const keeper = pickKeeper([
      v('big.mp4', { size: 9999, hasFunscript: false }),
      v('scripted.mp4', { size: 10, hasFunscript: true }),
    ]);
    // Beats even a much larger file: a script is harder to replace than
    // bitrate, and deleting the scripted copy orphans it.
    expect(keeper.name).toBe('scripted.mp4');
  });

  it('falls back to the larger file', () => {
    const keeper = pickKeeper([v('small.mp4', { size: 10 }), v('large.mp4', { size: 9999 })]);
    expect(keeper.name).toBe('large.mp4');
  });

  it('falls back to the longer runtime when sizes match', () => {
    const keeper = pickKeeper([
      v('truncated.mp4', { size: 100, duration: 10 }),
      v('full.mp4', { size: 100, duration: 900 }),
    ]);
    expect(keeper.name).toBe('full.mp4');
  });

  it('is stable — the same input always suggests the same keeper', () => {
    const members = [
      v('aaa.mp4', { size: 100, duration: 50 }),
      v('bbbbbbbb.mp4', { size: 100, duration: 50 }),
    ];
    expect(pickKeeper(members).name).toBe(pickKeeper([...members].reverse()).name);
  });

  it('the suggested keeper is never counted as reclaimable', () => {
    const groups = findDuplicates([
      v('keep.mp4', { size: 5000, hasFunscript: true, contentHash: 'H-keep' }),
      v('dupe.mp4', { size: 5000, contentHash: 'H-keep' }),
    ]);
    expect(groups[0].keeperPath).toContain('keep.mp4');
    expect(groups[0].reclaimable).toBe(5000);   // only the non-keeper
  });
});

describe('reporting', () => {
  it('totals reclaimable bytes across groups', () => {
    const groups = findDuplicates([
      v('a1.mp4', { size: 1000, duration: 10, contentHash: 'H-a' }), v('a2.mp4', { size: 1000, duration: 10, contentHash: 'H-a' }),
      v('b1.mp4', { size: 3000, duration: 90, contentHash: 'H-b' }), v('b2.mp4', { size: 3000, duration: 90, contentHash: 'H-b' }),
    ]);
    expect(totalReclaimable(groups)).toBe(4000);
    expect(totalReclaimable([])).toBe(0);
  });

  it('sorts the biggest win first — the point is disk space', () => {
    const groups = findDuplicates([
      v('small1.mp4', { size: 10, duration: 10, contentHash: 'H-small' }), v('small2.mp4', { size: 10, duration: 10, contentHash: 'H-small' }),
      v('huge1.mp4', { size: 999999, duration: 80, contentHash: 'H-huge' }), v('huge2.mp4', { size: 999999, duration: 80, contentHash: 'H-huge' }),
    ]);
    expect(groups[0].members[0].name).toMatch(/huge/);
  });

  it('formats bytes readably', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB');
    expect(formatBytes(1024 ** 4)).toBe('1.0 TB');
  });
});

// Runtime alone is not evidence.
//
// Found by running this against a real 61-video library before shipping: two
// pairs of completely unrelated videos were grouped as "Likely" duplicates
// purely because their durations landed within the tolerance, offering to
// reclaim 1.8 GB that was not reclaimable. There are only so many minutes a
// video can be, so in a library of a few hundred that stops being a
// coincidence and becomes a steady stream of false pairs — and a delete screen
// that cries wolf is one people stop reading.
describe('duration alone must not group anything', () => {
  it('does NOT group unrelated videos that share a runtime', () => {
    const groups = findDuplicates([
      v('MHBHJ - Britney and Kleio.mp4', { size: 2_000_000_000, duration: 1500 }),
      v('shinaryen20250428XVFree.mp4', { size: 500_000_000, duration: 1500 }),
    ]);
    expect(groups).toEqual([]);
  });

  it('groups same-runtime files when the NAME corroborates it', () => {
    const groups = findDuplicates([
      v('Beach Day 4K.mp4', { size: 900, duration: 600 }),
      v('Beach Day 1080p.mp4', { size: 300, duration: 600 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].tier).toBe(TIER.LIKELY);
  });

  // This test used to assert the opposite: same size AND same runtime with
  // nothing else in common was IDENTICAL. That pinned FT-B01 as correct (two
  // different 720,304-byte, 8 s videos listed as Identical and preselected
  // for the Recycle Bin). Identical now needs the content hash to match.
  it('same size AND same runtime with matching content is identical', () => {
    const groups = findDuplicates([
      v('totally different name.mp4', { size: 777, duration: 600, contentHash: 'H-777' }),
      v('nothing alike here.mp4', { size: 777, duration: 600, contentHash: 'H-777' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].tier).toBe(TIER.IDENTICAL);
  });

  it('same size AND same runtime WITHOUT content proof is not identical (FT-B01)', () => {
    const groups = findDuplicates([
      v('totally different name.mp4', { size: 777, duration: 600 }),
      v('nothing alike here.mp4', { size: 777, duration: 600 }),
    ]);
    expect(groups.filter((g) => g.tier === TIER.IDENTICAL)).toEqual([]);
    // Unrelated names and nothing but size+runtime: not grouped at all.
    expect(groups).toEqual([]);
  });

  it('uses a tight duration window', () => {
    expect(DURATION_TOLERANCE_SEC).toBeLessThanOrEqual(1);
  });
});

// Name matching must not be quadratic on a real library.
//
// The first version compared every name against every other. On a real
// 1,532-video library that measured 95 SECONDS of blocked main thread with a
// motionless "Checking your library…" on screen — the same freeze class as the
// multi-axis eligible-count bug. Token blocking cut it to ~2s with byte-
// identical results (61 groups, same tier split, same 40 GB).
//
// These pin the two things that could regress: the speed, and the recall it
// must not have cost.
describe('name matching scales', () => {
  const makeLibrary = (n) => Array.from({ length: n }, (_, i) => ({
    path: `C:/lib/video ${i}.mp4`,
    name: `Some Unrelated Recording Number ${i}.mp4`,
    size: 1000 + i,
    duration: 100 + i,
    hasFunscript: false,
  }));

  it('handles a large library quickly', () => {
    const t0 = Date.now();
    findDuplicates(makeLibrary(1500));
    // Generous: the real measurement is ~2s for 1,532 REAL names, and CI
    // machines vary. This only needs to fail if the quadratic sweep returns.
    expect(Date.now() - t0).toBeLessThan(20000);
  });

  it('still finds a renamed copy hidden in a large library', () => {
    // Recall is the thing blocking could silently cost, so prove a match that
    // depends ONLY on the name still survives among 1,500 unrelated files.
    const lib = makeLibrary(1500);
    lib.push(
      { path: 'C:/lib/Beach Holiday Footage.mp4', name: 'Beach Holiday Footage.mp4', size: 77, duration: 4242, hasFunscript: false },
      { path: 'C:/lib/Beach Holiday Footage copy.mp4', name: 'Beach Holiday Footage copy.mp4', size: 88, duration: 9999, hasFunscript: false },
    );
    const groups = findDuplicates(lib);
    const found = groups.find((g) => g.members.some((m) => m.name.startsWith('Beach Holiday')));
    expect(found, 'name-only match lost to blocking').toBeTruthy();
    expect(found.members).toHaveLength(2);
  });

  it('does not group on a shared short/common word alone', () => {
    // "the" style tokens are dropped; two files sharing only those must not
    // be paired, or blocking rebuilds the blowup one bucket at a time.
    const groups = findDuplicates([
      { path: 'C:/a.mp4', name: 'The Big One.mp4', size: 5, duration: 11, hasFunscript: false },
      { path: 'C:/b.mp4', name: 'The Small Two.mp4', size: 6, duration: 22, hasFunscript: false },
    ]);
    expect(groups).toEqual([]);
  });
});

// App test V03 (2026-11-02): a numbered series is not a set of re-encodes.
//
// 300 equal-length clips "Bulk 001..300" came back as ONE "Likely" group,
// "300 copies, 6.4 MB recoverable", and "Select spares in Likely" ticked 299
// distinct files for the Recycle Bin. Two holes, each enough on its own:
//
//   - a name that differed only in its episode/part number counted as
//     corroboration ("Episode 01" vs "02" scores 81, "Bulk 001" vs "002"
//     62), when the number is the one token saying they are different videos
//   - groups were whole connected components, so a chain of "likely" pairs
//     offered "Bulk 001" for deletion against a keeper "Bulk 300" it scored
//     51 against: no direct evidence at all
//
// Every pair in these fixtures differs ONLY in the number, and every runtime
// agrees within the tolerance, so nothing but the fix stands between them and
// a delete button.
describe('numbered series are not duplicates (V03)', () => {
  const series = (names, { duration = 1500, jitter = 0.6 } = {}) => names.map((name, i) => ({
    path: `C:/lib/${name}`,
    name,
    size: 800_000_000 + i * 1_234_567,           // distinct: never "identical"
    duration: duration + (i % 2 ? jitter : 0),   // inside DURATION_TOLERANCE_SEC
    hasFunscript: false,
  }));

  it('an 8-episode equal-length series produces no groups', () => {
    const eps = Array.from({ length: 8 }, (_, i) => `Beach Series Episode 0${i + 1}.mp4`);
    expect(findDuplicates(series(eps))).toEqual([]);
  });

  it('Part 1/2/3 splits of the same length produce no groups', () => {
    expect(findDuplicates(series(['Film Part 1.mp4', 'Film Part 2.mp4', 'Film Part 3.mp4']))).toEqual([]);
  });

  it('the app-test fixture: Bulk 001..300, all 4 s, distinct sizes, produces no groups', () => {
    const bulk = Array.from({ length: 300 }, (_, i) => `Bulk ${String(i + 1).padStart(3, '0')}.mp4`);
    expect(findDuplicates(series(bulk, { duration: 4, jitter: 0.05 }))).toEqual([]);
  });

  it.each([
    ['Scene 12.mp4', 'Scene 47.mp4'],
    ['Show E03.mp4', 'Show E04.mp4'],
    ['Show S01E03.mp4', 'Show S01E04.mp4'],
    ['Holiday Part1.mp4', 'Holiday Part2.mp4'],
    ['Sunset Walk.mp4', 'Sunset Walk 2.mp4'],
    // A bare frame height reads as a resolution only on a name with no
    // resolution tag, opposite one that has one ("film-4k" vs "film-1080",
    // pinned above). Two bare numbers in a long series are still two
    // episodes, tagged or not. (Both pairs score 76 on name.)
    ['Beach Series Episode 720.mp4', 'Beach Series Episode 1080.mp4'],
    ['Beach Series Episode 720 4K.mp4', 'Beach Series Episode 1080 4K.mp4'],
  ])('%s and %s of the same length are not grouped', (a, b) => {
    expect(findDuplicates(series([a, b]))).toEqual([]);
  });

  it('a long title differing only in its part number is not even a POSSIBLE', () => {
    // Name alone scores 90 here, over the name-only bar of 82, because
    // everything but the number matches. Different runtimes, so this is the
    // name-only pass, and it needs the same veto.
    const groups = findDuplicates([
      v('Long Descriptive Title Of The Video Part 1.mp4', { size: 111, duration: 1200 }),
      v('Long Descriptive Title Of The Video Part 2.mp4', { size: 222, duration: 1900 }),
    ]);
    expect(groups).toEqual([]);
  });

  it('a real re-encode is still LIKELY: "Film 4K" vs "Film 1080p", same length', () => {
    // Resolution, codec and bit-depth tags carry numbers too, but they
    // describe the encode, not the video. They must not veto.
    const groups = findDuplicates(series(['Film 4K.mp4', 'Film 1080p.mp4']));
    expect(groups).toHaveLength(1);
    expect(groups[0].tier).toBe(TIER.LIKELY);
    expect(groups[0].members).toHaveLength(2);
  });

  it('encode tags with numbers do not veto either (x265 10bit vs 1080p)', () => {
    const groups = findDuplicates(series(['Film Episode 3 x265 10bit.mp4', 'Film Episode 03 1080p.mp4']));
    expect(groups).toHaveLength(1);
    expect(groups[0].tier).toBe(TIER.LIKELY);
  });

  it('byte-identical files are still IDENTICAL whatever their numbers say', () => {
    // Same bytes is the same file; the number veto is about re-encodes.
    const groups = findDuplicates([
      v('Clip 1.mp4', { size: 4242, duration: 30, contentHash: 'H-clip' }),
      v('Clip 2.mp4', { size: 4242, duration: 30, contentHash: 'H-clip' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].tier).toBe(TIER.IDENTICAL);
  });

  // Windows Explorer's batch rename (select files, F2) names them
  // "Clip (1)", "Clip (2)", ... fuzzy-match's normalize() drops a trailing
  // "(n)" (it is the browser duplicate-download marker, and funscript pairing
  // relies on that), so these names score 100 against each other and the
  // number has to be recovered before the veto can see it (V03 review).
  it('a Windows batch rename "Clip (1)".."Clip (8)", equal length, produces no groups', () => {
    const clips = Array.from({ length: 8 }, (_, i) => `Clip (${i + 1}).mp4`);
    expect(findDuplicates(series(clips))).toEqual([]);
  });

  it('the app-test fixture batch-renamed: Bulk (1)..(300), all 4 s, produces no groups', () => {
    // Bulk (180) is in here too: 180 is a VR marker in fuzzy-match's noise
    // list, and must still read as a number here.
    const bulk = Array.from({ length: 300 }, (_, i) => `Bulk (${i + 1}).mp4`);
    expect(findDuplicates(series(bulk, { duration: 4, jitter: 0.05 }))).toEqual([]);
  });

  it('a batch-renamed set of different lengths is not even a POSSIBLE', () => {
    // Different runtimes, so only the name pass sees these, and on name
    // alone each pair scores 100.
    const groups = findDuplicates(Array.from({ length: 8 }, (_, i) => v(
      `Holiday Footage (${i + 1}).mp4`, { size: 1000 + i, duration: 100 + i * 50 },
    )));
    expect(groups).toEqual([]);
  });

  it('a browser re-download "Film (1)" byte for byte is still IDENTICAL', () => {
    const groups = findDuplicates([
      v('Film.mp4', { size: 5555, duration: 90, contentHash: 'H-film' }),
      v('Film (1).mp4', { size: 5555, duration: 90, contentHash: 'H-film' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].tier).toBe(TIER.IDENTICAL);
  });

  // Numbering the noise list eats, and which must still veto. Each pair
  // scores 100 on name without the fix.
  it.each([
    ['Show 1x03.mp4', 'Show 1x04.mp4'],                         // season x episode
    ['Christmas Party 2019.mp4', 'Christmas Party 2020.mp4'],   // a year on both
    ['Long Scene Title 180.mp4', 'Long Scene Title 360.mp4'],   // 180 / 360 on both
    // One-sided, like "Film" vs "Film 2": a different-size "Film (1)" may be
    // a second encode or a different video, and this feeds a delete button.
    ['Film.mp4', 'Film (1).mp4'],
  ])('%s and %s of the same length are not grouped', (a, b) => {
    expect(findDuplicates(series([a, b]))).toEqual([]);
  });

  // ...but the same tokens are still noise where they describe the encode or
  // appear on one name only. These must stay LIKELY.
  it.each([
    ['Film (2019).mp4', 'Film 2019 4K.mp4'],          // same year, one in "(n)" form
    ['Film 2019.mp4', 'Film 4K.mp4'],                  // a year on one name only
    ['Scene 180 3dh.mp4', 'Scene 180 4K.mp4'],         // the same VR marker
    ['Scene_180x180_3dh_LR.mp4', 'Scene 4K.mp4'],      // 180x180 is not an episode
  ])('%s and %s of the same length are still LIKELY', (a, b) => {
    const groups = findDuplicates(series([a, b]));
    expect(groups).toHaveLength(1);
    expect(groups[0].tier).toBe(TIER.LIKELY);
    expect(groups[0].members).toHaveLength(2);
  });
});

// A "likely" or "possible" match is not transitive: A~B and B~C say nothing
// about A and C. Every file a group offers for removal needs direct evidence
// against the file being KEPT.
describe('no chaining: every spare has direct evidence against the keeper (V03)', () => {
  it('a chain A~B~C does not offer A against keeper C', () => {
    // "Sunset Beach Walk" ~ "Sunset Beach Walk Mountain Lake" scores 80,
    // "Sunset Beach Walk Mountain Lake" ~ "Mountain Lake" scores 70, but
    // "Sunset Beach Walk" ~ "Mountain Lake" scores 10. Same runtime, so all
    // three share a pool; C is the biggest file and so the keeper.
    const a = v('Sunset Beach Walk.mp4', { size: 100, duration: 600 });
    const b = v('Sunset Beach Walk Mountain Lake.mp4', { size: 200, duration: 600 });
    const c = v('Mountain Lake.mp4', { size: 900, duration: 600 });
    const groups = findDuplicates([a, b, c]);
    const all = groups.flatMap((g) => g.members.map((m) => m.path));
    expect(all).not.toContain(a.path);
    expect(groups).toHaveLength(1);
    expect(groups[0].keeperPath).toBe(c.path);
    expect(groups[0].members.map((m) => m.path).sort()).toEqual([b.path, c.path].sort());
  });

  it('a renamed byte-copy still travels with its twin', () => {
    // The twin's name says nothing, but its bytes equal a file that does
    // match the keeper: same content, same evidence.
    const twinA = v('Beach Day.mp4', { size: 100, duration: 50, contentHash: 'H-twin' });
    const twinB = v('zz_backup_7731.mp4', { size: 100, duration: 50, contentHash: 'H-twin' });
    const keep = v('Beach Day 1080p.mp4', { size: 300, duration: 50 });
    const groups = findDuplicates([twinA, twinB, keep]);
    expect(groups).toHaveLength(1);
    expect(groups[0].keeperPath).toBe(keep.path);
    expect(groups[0].members).toHaveLength(3);
  });

  it('a name match inside an existing pool is still recorded as direct evidence', () => {
    // A~B by runtime+name; C (different runtime) matches both A and B by
    // name. B is the keeper. If the name pass skipped C~B just because C had
    // already joined the pool through A, C would have no direct evidence
    // against B and be dropped from the group it belongs in.
    const a = v('Holiday Footage Beach.mp4', { size: 10, duration: 100 });
    const b = v('Holiday Footage Beach 4K.mp4', { size: 999, duration: 100 });
    const c = v('Holiday Footage Beach copy.mp4', { size: 20, duration: 500 });
    const groups = findDuplicates([a, b, c]);
    expect(groups).toHaveLength(1);
    expect(groups[0].keeperPath).toBe(b.path);
    expect(groups[0].members).toHaveLength(3);
    expect(groups[0].tier).toBe(TIER.POSSIBLE);
  });

  it('group ids stay unique and no file is in two groups when a pool is cut up', () => {
    const groups = findDuplicates([
      v('Sunset Beach Walk.mp4', { size: 100, duration: 600, contentHash: 'H-sunset' }),
      v('Sunset Beach Walk copy.mp4', { size: 100, duration: 600, contentHash: 'H-sunset' }),
      v('Sunset Beach Walk Mountain Lake.mp4', { size: 200, duration: 600 }),
      v('Mountain Lake.mp4', { size: 900, duration: 600, contentHash: 'H-lake' }),
      v('Mountain Lake copy.mp4', { size: 900, duration: 600, contentHash: 'H-lake' }),
    ]);
    expect(groups.length).toBeGreaterThan(0);
    const ids = groups.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    const seen = new Set();
    for (const g of groups) for (const m of g.members) {
      expect(seen.has(m.path), `${m.path} appeared in two groups`).toBe(false);
      seen.add(m.path);
    }
  });
});

// FT-B01 (2026-11-05, new since v0.9.2): "Identical" was byte size + runtime.
//
// Block A's sandbox had two DIFFERENT videos, "Untagged Wide.mp4" and
// "VR Tagged_180_LR.mp4", both 720,304 bytes and 8 s (md5 differs, first
// difference at byte 14,251). They were listed as IDENTICAL, "Same file size
// and length", and "Select spares in Identical" ticked one, with its own
// funscript, for the Recycle Bin. Identical now needs the main process's
// sampled content hash to match; a pair without it is judged on runtime and
// name like any other pair. Real files are hashed in
// duplicate-content-hash.test.js; these pin the rules on plain objects.
describe('Identical needs content proof (FT-B01)', () => {
  const sandboxPair = (hashA, hashB) => [
    { path: 'C:/sandbox/Untagged Wide.mp4', name: 'Untagged Wide.mp4', size: 720_304, duration: 8, hasFunscript: false, contentHash: hashA },
    { path: 'C:/sandbox/VR Tagged_180_LR.mp4', name: 'VR Tagged_180_LR.mp4', size: 720_304, duration: 8, hasFunscript: true, contentHash: hashB },
  ];

  it('the block A sandbox pair with different hashes is not Identical, and not grouped at all', () => {
    const groups = findDuplicates(sandboxPair('sha-a', 'sha-b'));
    expect(groups.some((g) => g.tier === TIER.IDENTICAL)).toBe(false);
    expect(groups).toEqual([]);
  });

  it('the same pair with no hash at all (unreadable, offline, no IPC) is not Identical either', () => {
    expect(findDuplicates(sandboxPair(null, null))).toEqual([]);
    expect(findDuplicates(sandboxPair('sha-a', null))).toEqual([]);
    expect(findDuplicates(sandboxPair(undefined, undefined))).toEqual([]);
    expect(findDuplicates(sandboxPair('', ''))).toEqual([]);
  });

  it('the same pair with matching hashes IS Identical', () => {
    const groups = findDuplicates(sandboxPair('sha-same', 'sha-same'));
    expect(groups).toHaveLength(1);
    expect(groups[0].tier).toBe(TIER.IDENTICAL);
    // The scripted copy is the keeper; the other is the only spare.
    expect(groups[0].keeperPath).toBe('C:/sandbox/VR Tagged_180_LR.mp4');
  });

  it('same size, different content, same runtime and a corroborating name is LIKELY, not Identical', () => {
    const groups = findDuplicates([
      v('Beach Day.mp4', { size: 5000, duration: 300, contentHash: 'sha-1' }),
      v('Beach Day 1080p.mp4', { size: 5000, duration: 300, contentHash: 'sha-2' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].tier).toBe(TIER.LIKELY);
  });

  it('matching hashes with one duration unknown stay Identical (an un-probed library keeps its byte copies)', () => {
    const groups = findDuplicates([
      v('one.mp4', { size: 5000, duration: undefined, contentHash: 'sha-x' }),
      v('two.mp4', { size: 5000, duration: 300, contentHash: 'sha-x' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].tier).toBe(TIER.IDENTICAL);
  });

  it('a matching hash never joins files of different sizes', () => {
    const groups = findDuplicates([
      v('unrelated one.mp4', { size: 5000, duration: 300, contentHash: 'sha-x' }),
      v('different thing.mp4', { size: 5001, duration: 900, contentHash: 'sha-x' }),
    ]);
    expect(groups).toEqual([]);
  });

  it('a byte-identical pair beside a different-content same-size file: only the twins are Identical', () => {
    const a = v('Clip A.mp4', { size: 4096, duration: 20, contentHash: 'sha-twin' });
    const b = v('Clip A copy.mp4', { size: 4096, duration: 20, contentHash: 'sha-twin' });
    const c = v('Unrelated Other.mp4', { size: 4096, duration: 20, contentHash: 'sha-other' });
    const groups = findDuplicates([a, b, c]);
    const identical = groups.filter((g) => g.tier === TIER.IDENTICAL);
    expect(identical).toHaveLength(1);
    expect(identical[0].members.map((m) => m.path).sort()).toEqual([a.path, b.path].sort());
    expect(groups.flatMap((g) => g.members.map((m) => m.path))).not.toContain(c.path);
  });

  it('sameSizeCandidates names only files that share an exact size', () => {
    expect(sameSizeCandidates([
      { path: 'a', size: 10 }, { path: 'b', size: 10 }, { path: 'c', size: 11 },
      { path: 'd', size: 0 }, { path: 'e', size: 0 }, { path: 'f', size: null }, { path: 'g', size: null },
      { path: 'h', size: 12 }, { path: 'i', size: 12 }, { path: 'j', size: 12 }, { size: 10 }, null,
    ]).sort()).toEqual(['a', 'b', 'h', 'i', 'j']);
    expect(sameSizeCandidates([])).toEqual([]);
    expect(sameSizeCandidates(null)).toEqual([]);
  });
});
