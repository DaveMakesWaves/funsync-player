/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Fills and edges in the LIGHT theme (test day 2026-11-24, B030). The
// EroScripts tab and the session card / Session History drew theirs as white
// overlays (rgba(255, 255, 255, a)), made for the dark page. On the light page
// the selected All / Free / Paid had no background, Paste a link… / Downloads
// / Log Out read as plain text, chips and edges vanished, and the history's
// entries had no box. They are drawn in the theme's ink now (--ink-rgb in
// player.css): white on the dark page (the same values as before), black on
// the light one. jsdom resolves neither var() nor this colour syntax, so the
// look itself was checked in the running app; this keeps a new hard-coded
// white overlay out of these sheets.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const read = (f) => fs.readFileSync(`renderer/styles/${f}`, 'utf8').replace(/\r\n/g, '\n');
const player = read('player.css');
const block = (sel) => {
  const at = player.indexOf(`\n${sel} {`);
  return at < 0 ? '' : player.slice(at, player.indexOf('}', at));
};

describe('one ink for fills and edges, white on dark and black on light (B030)', () => {
  it('player.css defines it with the other theme colours', () => {
    expect(block(':root[data-theme="dark"]')).toMatch(/--ink-rgb: 255 255 255;/);
    expect(block(':root[data-theme="light"]')).toMatch(/--ink-rgb: 0 0 0;/);
  });

  it.each(['eroscripts.css', 'session-card.css'])('%s has no hard-coded white overlay', (f) => {
    const left = read(f).split('\n').filter((l) => /rgba\(\s*255\s*,\s*255\s*,\s*255/.test(l));
    expect(left).toEqual([]);
  });

  it('the controls that vanished use the ink', () => {
    const rule = (css, sel) => css.match(new RegExp(`\\n${sel.replace(/[.\-]/g, (c) => `\\${c}`)} \\{([^}]*)\\}`))?.[1] || '';
    const es = read('eroscripts.css');
    for (const sel of ['.es-seg', '.es-seg__btn--on', '.es-view__paste-btn', '.es-view__dl-btn', '.es-feed--on', '.es-taginput__chip']) {
      expect(rule(es, sel), sel).toMatch(/rgb\(var\(--ink-rgb\) \/ [0-9.]+\)/);
    }
    expect(rule(read('session-card.css'), '.session-history__item'), 'history entry').toMatch(/rgb\(var\(--ink-rgb\) \/ [0-9.]+\)/);
  });
});
