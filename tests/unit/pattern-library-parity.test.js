/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Pattern library parity (next major, 2026-11-17).
//
// renderer/js/pattern-library.js is a port of a private reference generator.
// tests/fixtures/pattern-library-parity.json holds THAT generator's output for
// every pattern id under 10 option cases (780 renders: the action count, a
// hash of the actions, a hash of the buzz flags and the warnings as codes)
// plus 12 whole renders. The port must reproduce every one exactly: same
// actions, same buzz flags, same warnings. The fixture is generated output
// only, keyed by the library's ids; it carries none of the generator's data.
//
// Every case passes an explicit seed, so the port's default seed (1, the
// generator's was built from its own pattern codes) never matters here.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { renderPattern, describePattern, listPatterns, PATTERN_ENGINE_VERSION } from '../../renderer/js/pattern-library.js';

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/pattern-library-parity.json', import.meta.url)), 'utf8'));

const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const actionsHash = (acts) => hash(acts.map((a) => `${a.at},${a.pos}`).join(';'));
const vibHash = (vib) => hash(vib.map((v) => (v ? '1' : '0')).join(''));

/** A case template with "lo" / "hi" replaced by the ends of the pattern's speed range. */
function optsFor(template, [lo, hi]) {
  const v = (x) => (x === 'lo' ? lo : x === 'hi' ? hi : x);
  const o = JSON.parse(JSON.stringify(template));
  if (o.speed !== undefined) o.speed = v(o.speed);
  if (o.ramp) o.ramp = { to: v(o.ramp.to) };
  return o;
}

// 790 renders in all: a few seconds idle, longer under a loaded full suite.
describe('pattern library parity with the reference generator', { timeout: 60000 }, () => {
  it('covers every pattern of the library once, in order, with 10 cases each', () => {
    // the catalogue: the simple shapes (2026-11-19) are generatePattern's, not the reference generator's
    expect(fixture.patterns.map((p) => p.id)).toEqual(listPatterns().filter((p) => p.family !== 'simple-shapes').map((p) => p.id));
    expect(fixture.caseTemplates).toHaveLength(10);
    for (const p of fixture.patterns) expect(p.r).toHaveLength(10);
    // a change to the engine's output must come with a new version (cache keys) AND a new fixture
    expect(fixture.engineVersion).toBe(PATTERN_ENGINE_VERSION);
  });

  it("resolves 'lo' and 'hi' to the same speed range the app shows", () => {
    for (const p of fixture.patterns) expect(describePattern(p.id).speedRange, p.id).toEqual(p.speedRange);
  });

  it.each(fixture.patterns.map((p) => [p.id, p]))('%s: all 10 cases render exactly as the reference does', (id, p) => {
    const diffs = [];
    fixture.caseTemplates.forEach((template, i) => {
      const opts = optsFor(template, p.speedRange);
      const res = renderPattern(id, opts);
      const got = [res.actions.length, actionsHash(res.actions), vibHash(res.vib), res.warnings.map((w) => w.code)];
      const want = p.r[i];
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        diffs.push(`case ${i + 1} ${JSON.stringify(opts)}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}; first actions ${JSON.stringify(res.actions.slice(0, 4))}`);
      }
    });
    expect(diffs).toEqual([]);
  });

  it.each(fixture.full.map((f) => [`${f.id} case ${f.case}`, f]))('%s: the whole render is identical', (_label, f) => {
    const p = fixture.patterns.find((x) => x.id === f.id);
    const res = renderPattern(f.id, optsFor(fixture.caseTemplates[f.case - 1], p.speedRange));
    expect(res.actions.map((a) => [a.at, a.pos])).toEqual(f.actions);
    expect(res.vib.map((v) => (v ? '1' : '0')).join('')).toBe(f.vib);
  });

  it('the new options leave the output untouched at their defaults (variation 1, no startDir)', () => {
    const template = fixture.caseTemplates[7]; // a ramp, a start position and a speed cap
    for (const p of fixture.patterns) {
      const opts = optsFor(template, p.speedRange);
      const res = renderPattern(p.id, { ...opts, variation: 1, startDir: 0 });
      expect([res.actions.length, actionsHash(res.actions), vibHash(res.vib)], p.id).toEqual(p.r[7].slice(0, 3));
    }
  });
});
