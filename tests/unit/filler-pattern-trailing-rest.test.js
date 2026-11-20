/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Gap Filler with a library pattern on a video longer than its script (the
// trailing gap, FT-113): the fill runs to the video's end and, where the
// pattern leaves time for it, eases to rest "at no more than the join
// speed", at "the pattern's own lowest place" in range mode 'own'.
//   PF-R3 (pf-review 2026-11-19): the travel was timed to the UNROUNDED rest
//   (a catalogue range starting at 72.4) and the point written rounded (72):
//   the last leg ran past the join speed (74 -> 72 in 3 ms = 667 u/s).
//   PF-R4: a REVERSED pattern in its own range plays mirrored (1-28) but
//   rested at the unmirrored bottom (72): it climbed out of its band at the
//   end of the video and stayed there.
// Videos of a spread of lengths, so the pattern's last stroke lands at many
// places before the end and the rest move happens in hundreds of cases.
import { describe, it, expect, afterEach } from 'vitest';
import { buildFillerActions } from '../../renderer/js/filler-engine.js';
import { resolveFillerOptions } from '../../renderer/js/filler-presets.js';
import { normalizePatternChoice } from '../../renderer/js/pattern-choice.js';
import { clearPatternSourceCache, patternSourceLoop } from '../../renderer/js/pattern-source.js';
import { listPatterns, describePattern } from '../../renderer/js/pattern-library.js';
import { buildLibraryGapFiller } from '../../renderer/js/filler-pattern.js';

afterEach(() => clearPatternSourceCache());

// Strokes 0-100 to 3:20; the video runs to about 4:00 (a ~40 s trailing gap).
const SCRIPT = [];
for (let t = 3000; t < 200000; t += 300) SCRIPT.push({ at: t, pos: SCRIPT.length % 2 ? 0 : 100 });
const LENGTHS = Array.from({ length: 12 }, (_, k) => 240000 + k * 97);
const fill = (choice, join, totalDurationMs) => buildFillerActions(SCRIPT, resolveFillerOptions({
  enabled: true, thresholdMs: 10000, totalDurationMs, maxJoinSpeed: join, pattern: normalizePatternChoice(choice),
}));
const speed = (a, b) => (Math.abs(b.pos - a.pos) / (b.at - a.at)) * 1000;
/**
 * The trailing gap's fill as played, the same pattern's body without any rest
 * (buildLibraryGapFiller, restPos null), and the rest move when there is one
 * (one point more than the body: the pattern left time before the end).
 */
const trailing = (choice, join, totalDurationMs) => {
  const last = SCRIPT[SCRIPT.length - 1];
  const f = fill(choice, join, totalDurationMs).filter((a) => a.at > last.at);
  const body = buildLibraryGapFiller({ startMs: last.at, endMs: totalDurationMs }, last.pos, null, {
    pattern: { id: choice.id, speed: null, reversed: choice.reversed === true, min: null, max: null },
    maxJoinSpeed: join, restPos: null,
  });
  const rest = f.length === body.length + 1 ? f[f.length - 1] : null;
  return { f, body, rest, beforeRest: rest ? f[f.length - 2] : null };
};
/** Loopable catalogue patterns whose own range starts or ends on a fraction. */
const FRACTIONAL = listPatterns({ loopable: true })
  .filter((p) => !p.id.startsWith('shape-'))
  .filter((p) => { const r = describePattern(p.id).range; return !Number.isInteger(r[0]) || !Number.isInteger(r[1]); })
  .map((p) => p.id);
/** Where an 'own' pattern rests: the lowest place of its own loop as it plays (mirrored when reversed). */
const ownRest = (id, reversed) => patternSourceLoop({ id, speed: null, reversed, min: null, max: null })
  .actions.reduce((lo, a) => Math.min(lo, a.pos), 100);

describe('the trailing ease to rest of a library pattern', () => {
  it('there are patterns whose own range starts or ends on a fraction (the case under test)', () => {
    expect(FRACTIONAL).toContain('dip-climb-hold-top');
    expect(FRACTIONAL.length).toBeGreaterThan(3);
  });

  it('PF-R3: the move to rest is never faster than the join speed (own range, fractional bottoms, three join speeds)', () => {
    const bad = [];
    let rests = 0;
    for (const id of FRACTIONAL) {
      for (const join of [137, 300, 600]) {
        for (const totalDurationMs of LENGTHS.slice(0, 6)) {
          const t = trailing({ id, rangeMode: 'own' }, join, totalDurationMs);
          if (!t.rest) continue;   // the pattern ran to the end: no time left to rest
          rests++;
          expect(Number.isInteger(t.rest.pos)).toBe(true);
          expect(t.rest.pos).toBe(ownRest(id, false));
          if (speed(t.beforeRest, t.rest) > join) bad.push(`${id} @${join} ${totalDurationMs}: ${t.beforeRest.pos}@${t.beforeRest.at} -> ${t.rest.pos}@${t.rest.at}`);
        }
      }
      clearPatternSourceCache();
    }
    expect(rests).toBeGreaterThan(50);
    expect(bad).toEqual([]);
  }, 60000);

  it('PF-R3: a rest on a fraction (72.4) is timed to the whole position written, never past the join speed', () => {
    const last = SCRIPT[SCRIPT.length - 1];
    const bad = [];
    let rests = 0;
    for (const id of ['dip-climb-hold-top', 'steady-buzz-tip-high', 'quick-full-strokes']) {
      for (const join of [137, 300, 600]) {
        for (const totalDurationMs of LENGTHS) {
          for (const restPos of [72.4, 73.35, 30.6, 5.5, 0.4]) {
            const gap = { startMs: last.at, endMs: totalDurationMs };
            const pattern = { id, speed: null, reversed: false, min: null, max: null };
            const body = buildLibraryGapFiller(gap, last.pos, null, { pattern, maxJoinSpeed: join, restPos: null });
            const f = buildLibraryGapFiller(gap, last.pos, null, { pattern, maxJoinSpeed: join, restPos });
            if (f.length !== body.length + 1) continue;
            rests++;
            const [a, b] = f.slice(-2);
            expect(b.pos).toBe(Math.round(restPos));
            if (speed(a, b) > join) bad.push(`${id} @${join} rest ${restPos}: ${a.pos}@${a.at} -> ${b.pos}@${b.at}`);
          }
        }
      }
      clearPatternSourceCache();
    }
    expect(rests).toBeGreaterThan(100);
    expect(bad).toEqual([]);
  }, 60000);

  it('PF-R4: a reversed pattern rests at the bottom of where it plays (the lowest place of its own loop), never on the far side', () => {
    const bad = [];
    let rests = 0;
    for (const id of FRACTIONAL) {
      for (const totalDurationMs of LENGTHS) {
        const t = trailing({ id, reversed: true, rangeMode: 'own' }, 300, totalDurationMs);
        if (!t.rest) continue;
        rests++;
        const hi = Math.max(...t.body.map((a) => a.pos));
        const lo = Math.min(...t.body.map((a) => a.pos));
        if (t.rest.pos !== ownRest(id, true) || t.rest.pos > lo) bad.push(`${id} ${totalDurationMs}: rests at ${t.rest.pos}, played ${lo}-${hi}`);
      }
      clearPatternSourceCache();
    }
    expect(rests).toBeGreaterThan(20);
    expect(bad).toEqual([]);
  }, 60000);

  it('not reversed, and in an exact band: the rest is the bottom, as before', () => {
    let seen = 0;
    for (const totalDurationMs of LENGTHS) {
      const f = fill({ id: 'quick-full-strokes', reversed: true, rangeMode: 'exact', min: 20, max: 60 }, 300, totalDurationMs);
      const body = f.filter((a) => a.at > 200000);
      expect(Math.min(...body.map((a) => a.pos))).toBeGreaterThanOrEqual(20);
      expect(Math.max(...body.map((a) => a.pos))).toBeLessThanOrEqual(60);
      if (f[f.length - 1].pos === 20) seen++;
    }
    expect(seen).toBeGreaterThan(0);
  });
});
