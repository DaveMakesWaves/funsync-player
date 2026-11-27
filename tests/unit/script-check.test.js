/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Check script (editor work list 4.2, 2026-11-24): the pure check behind the
// dialog. Each kind is pinned by what it FINDS in a script, and by what it
// must not find (holds, the quiet start and end, a gap counted twice).
import { describe, it, expect } from 'vitest';
import { checkScript, groupIndices, formatCheckTime, CHECK_KINDS } from '../../renderer/js/script-check.js';
import { ActionGraph } from '../../renderer/js/action-graph.js';

const pts = (...pairs) => pairs.map(([at, pos]) => ({ at, pos }));
const group = (report, kind) => report.groups.find((g) => g.kind === kind);
const kinds = (report) => report.groups.map((g) => g.kind);

describe('checkScript', () => {
  it('a clean script has no findings', () => {
    // 0→100 in 500 ms = 200 units/s: inside 33..400.
    const r = checkScript(pts([0, 0], [500, 100], [1000, 0], [1500, 100]));
    expect(r).toEqual({ total: 0, points: 4, groups: [] });
  });

  it('an empty or missing script is no error', () => {
    expect(checkScript([]).total).toBe(0);
    expect(checkScript(null)).toEqual({ total: 0, points: 0, groups: [] });
  });

  it('finds a stroke faster than the max (units/s), with its two points', () => {
    // 0→100 in 200 ms = 500 units/s.
    const r = checkScript(pts([0, 0], [500, 100], [700, 0]));
    const g = group(r, 'tooFast');
    expect(g.findings).toEqual([{ kind: 'tooFast', indices: [1, 2], at: 500, detail: { speed: 500, limit: 400 } }]);
  });

  it('uses the limits it is given, and 0 turns a check off', () => {
    const script = pts([0, 0], [500, 100], [700, 0]);
    expect(group(checkScript(script, { maxSpeed: 600 }), 'tooFast')).toBeUndefined();
    expect(group(checkScript(script, { maxSpeed: 0 }), 'tooFast')).toBeUndefined();
    expect(group(checkScript(script, { maxSpeed: 150 }), 'tooFast').findings).toHaveLength(2);
  });

  it('marks exactly what the timeline marks (ActionGraph.speedMark), at the edges too', () => {
    // 400 units/s exactly is not too fast; 33 exactly is not too slow.
    const atMax = pts([0, 0], [250, 100]);       // 400 units/s
    const atMin = pts([0, 0], [3000, 99]);       // 33 units/s
    const justOver = pts([0, 0], [249, 100]);    // 401.6
    const justUnder = pts([0, 0], [3000, 98]);   // 32.7
    ActionGraph.setSpeedLimits({ max: 400, min: 33 });
    for (const s of [atMax, atMin, justOver, justUnder]) {
      const speed = Math.abs(s[1].pos - s[0].pos) / (s[1].at - s[0].at);
      const mark = ActionGraph.speedMark(speed);
      const r = checkScript(s);
      expect(kinds(r).includes('tooFast')).toBe(mark === 'fast');
      expect(kinds(r).includes('tooSlow')).toBe(mark === 'slow');
    }
  });

  it('finds a moving stroke slower than the min, never a hold', () => {
    // 0→20 over 1000 ms = 20 units/s (slow); 20→20 is a hold.
    const r = checkScript(pts([0, 0], [1000, 20], [5000, 20], [5200, 80]));
    const g = group(r, 'tooSlow');
    expect(g.findings.map((f) => f.indices)).toEqual([[0, 1]]);
    expect(g.findings[0].detail).toEqual({ speed: 20, limit: 33 });
  });

  it('finds points at the same time, once per time, with every point there', () => {
    const r = checkScript(pts([0, 0], [500, 50], [500, 60], [500, 70], [900, 0], [900, 10]));
    expect(group(r, 'sameTime').findings).toEqual([
      { kind: 'sameTime', indices: [1, 2, 3], at: 500, detail: { count: 3 } },
      { kind: 'sameTime', indices: [4, 5], at: 900, detail: { count: 2 } },
    ]);
  });

  it('finds positions outside 0-100, times before 0 and points that are not numbers', () => {
    const r = checkScript([{ at: -40, pos: 50 }, { at: 0, pos: 120 }, { at: 500, pos: -5 }, { at: 'x', pos: 1 }, { at: 900, pos: null }]);
    const found = group(r, 'outOfRange').findings.map((f) => ({ i: f.indices, d: f.detail }));
    expect(found).toEqual(expect.arrayContaining([
      { i: [0], d: { at: -40 } },
      { i: [1], d: { pos: 120 } },
      { i: [2], d: { pos: -5 } },
      { i: [3], d: { invalid: true } },
      { i: [4], d: { invalid: true } },
    ]));
    expect(found).toHaveLength(5);
  });

  it('finds times and positions that are not whole numbers', () => {
    const r = checkScript(pts([0, 0], [500.4, 100], [1000, 49.5], [1500, 0]));
    expect(group(r, 'notWhole').findings.map((f) => f.indices)).toEqual([[1], [2]]);
    expect(group(r, 'notWhole').findings[0].detail).toEqual({ at: 500.4, pos: 100 });
  });

  it('finds a long gap between moving parts, not the quiet start or end, and not also as slow', () => {
    const r = checkScript(pts(
      [0, 50], [20000, 50],          // a held start: no motion before the 20 s, not a gap
      [20300, 0], [20600, 100],      // motion
      [35600, 90],                   // 15 s later, a moving 100→90: a gap, not "slow"
      [35900, 0], [36200, 100],      // motion after
      [60000, 100],                  // a held end: no motion after, not a gap
    ));
    const gaps = group(r, 'longGap').findings;
    expect(gaps).toEqual([{ kind: 'longGap', indices: [3, 4], at: 20600, detail: { gapMs: 15000 } }]);
    expect(group(r, 'tooSlow')).toBeUndefined();
  });

  it('long gap length is configurable; 0 turns it off', () => {
    const script = pts([0, 0], [300, 100], [6300, 0], [6600, 100]);
    expect(group(checkScript(script), 'longGap')).toBeUndefined(); // 6 s < 10 s
    expect(group(checkScript(script, { longGapMs: 5000 }), 'longGap').findings).toHaveLength(1);
    expect(group(checkScript(script, { longGapMs: 0, minSpeed: 0 }), 'longGap')).toBeUndefined();
  });

  it('finds points closer than one frame only when a frame length is given', () => {
    const script = pts([0, 0], [10, 2], [500, 100]);
    expect(group(checkScript(script), 'shortStroke')).toBeUndefined();
    const g = group(checkScript(script, { frameMs: 1000 / 60 }), 'shortStroke');
    expect(g.findings).toEqual([{ kind: 'shortStroke', indices: [0, 1], at: 0, detail: { ms: 10, frameMs: 16.7 } }]);
  });

  it('checks an unsorted array in time order and reports the given indices', () => {
    // Index 0 is the LAST point in time.
    const r = checkScript([{ at: 700, pos: 0 }, { at: 0, pos: 0 }, { at: 500, pos: 100 }]);
    expect(group(r, 'tooFast').findings[0].indices).toEqual([0, 2]);
    expect(group(r, 'tooFast').findings[0].at).toBe(500);
  });

  it('lists the kinds in a fixed order, the findings of each in time order, and counts them', () => {
    const r = checkScript(pts([0, 0], [100, 100], [100, 50], [200, 120], [400, 0.5]));
    expect(kinds(r)).toEqual(CHECK_KINDS.filter((k) => kinds(r).includes(k)));
    for (const g of r.groups) {
      const ats = g.findings.map((f) => f.at);
      expect(ats).toEqual([...ats].sort((a, b) => a - b));
    }
    expect(r.total).toBe(r.groups.reduce((n, g) => n + g.findings.length, 0));
  });

  it('never changes the array it reads', () => {
    const script = pts([0, 0], [100, 100], [100.5, 120]);
    const copy = JSON.parse(JSON.stringify(script));
    checkScript(script, { frameMs: 40 });
    expect(script).toEqual(copy);
  });
});

describe('groupIndices', () => {
  it('every point of a group once, ascending', () => {
    const r = checkScript(pts([0, 0], [200, 100], [400, 0], [600, 100]));
    expect(groupIndices(group(r, 'tooFast'))).toEqual([0, 1, 2, 3]);
    expect(groupIndices(null)).toEqual([]);
  });
});

describe('formatCheckTime', () => {
  it('mm:ss.mmm, h:mm:ss.mmm from an hour, a sign for negatives', () => {
    expect(formatCheckTime(0)).toBe('00:00.000');
    expect(formatCheckTime(5250)).toBe('00:05.250');
    expect(formatCheckTime(754321)).toBe('12:34.321');
    expect(formatCheckTime(3723004)).toBe('1:02:03.004');
    expect(formatCheckTime(-40)).toBe('-00:00.040');
    expect(formatCheckTime(NaN)).toBe('--:--.---');
  });
});
