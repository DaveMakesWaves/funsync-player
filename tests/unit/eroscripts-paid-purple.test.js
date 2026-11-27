/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The EroScripts tab's Paid marker is the forum's own Paid Scripts purple
// (Dave, 2026-11-23: "on the forum the paid colour is purple so can we change
// it to the same purple"). The forum's category colour, read from
// /c/15/show.json: 8D33B5 (Free Scripts is 71b539). It was amber (#b26a00 /
// #d9a441 / --state-warning) in all three places.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

describe('Paid is the forum purple everywhere in the EroScripts tab', () => {
  it('one token, the forum\'s colour, on every theme', () => {
    expect(read('renderer/styles/player.css')).toMatch(/:root \{[^}]*--eroscripts-paid: #8D33B5;/);
  });

  it('the Classic badge, the Modern dot and the list view\'s square all use it', () => {
    const es = read('renderer/styles/eroscripts.css');
    expect(es).toContain('.es-card__price--paid { background: var(--eroscripts-paid); }');
    expect(es).toContain('.es-row__cat--paid::before { background: var(--eroscripts-paid); }');
    expect(read('renderer/styles/modern-polish.css')).toContain(':root[data-style="modern"] .es-card__price--paid::before { background: var(--eroscripts-paid); }');
  });

  it('the list view\'s word stays legible: a lighter purple on dark, the exact one on light', () => {
    const es = read('renderer/styles/eroscripts.css');
    expect(es).toContain('.es-row__cat--paid { color: #c08ae0; }');
    expect(es).toContain(':root[data-theme="light"] .es-row__cat--paid { color: var(--eroscripts-paid); }');
  });

  it('no amber is left on Paid', () => {
    for (const p of ['renderer/styles/eroscripts.css', 'renderer/styles/modern-polish.css']) {
      const css = read(p);
      const paidRules = css.split('}').filter((r) => /price--paid|cat--paid/.test(r)).join('}');
      expect(paidRules, p).not.toMatch(/#b26a00|#d9a441|--state-warning/);
    }
  });
});
