/**
 * @vitest-environment jsdom
 * jsdom: the toast is built as DOM (convert-to-play.js); the stylesheet is
 * read as text (jsdom has no layout). See notes/CLAUDE.md "Test environments".
 */
// Dave, 2026-11-26: "the buttons on these conversion toasts are stuck right
// against the text". The toasts' row (.toast__row) had no rule at all, so
// the button sat flush against the line. Now a flex row with a gap that
// wraps the buttons under a long line.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { offerConversion } from '../../renderer/js/convert-to-play.js';

const CSS = fs.readFileSync('renderer/styles/player.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function rule(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&');
  const m = new RegExp(`(?:^|})\\s*${esc}\\s*\\{([^}]*)\\}`).exec(CSS);
  return m ? Object.fromEntries(m[1].split(';').map((d) => d.split(':').map((x) => x.trim())).filter(([k, v]) => k && v)) : null;
}

describe('a toast with buttons keeps them apart from its text', () => {
  it('the row is a wrapping flex row with a gap', () => {
    const row = rule('.toast__row');
    expect(row).not.toBeNull();
    expect(row.display).toBe('flex');
    expect(row['flex-wrap']).toBe('wrap');
    const gaps = String(row.gap || '').split(/\s+/).map((g) => parseFloat(g));
    expect(gaps.length).toBeGreaterThan(0);
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(8);
  });

  it('the convert offer is built as that row: its text and its button side by side in it', () => {
    let body = null;
    offerConversion({ codec: 'MPEG4', onConvert: () => {}, t: (k) => k, showToast: (b) => { body = b; return { dismiss() {} }; } });
    expect(body.classList.contains('toast__row')).toBe(true);
    expect(body.children[0].tagName).toBe('SPAN');
    expect(body.children[1].classList.contains('toast__action')).toBe(true);
  });

  it('the stream "try lower quality" toast uses the row too', () => {
    const src = fs.readFileSync('renderer/js/app.js', 'utf8');
    const start = src.indexOf('  _onStreamStalling() {');
    const body = src.slice(start, src.indexOf('\n  }\n', start));
    // both of its toasts: every box it builds gets the row class
    expect((body.match(/document\.createElement\('div'\)/g) || []).length)
      .toBe((body.match(/className = 'toast__row'/g) || []).length);
  });
});
