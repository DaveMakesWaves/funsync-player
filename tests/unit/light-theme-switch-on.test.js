/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// In the light theme every ON .toggle-switch drew grey, as if off: the light
// OFF track (`:root[data-theme="light"] .toggle-switch::before`, specificity
// 0,2,1) outranked the plain `.toggle-switch--on::before` (0,1,1). Seen on a
// Library folder that was on (full manual test, 2026-11-23; also in v0.9.2).
// Checked live after the fix: on rgb(233, 69, 96) = --accent, off the grey.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const css = fs.readFileSync('renderer/styles/modal.css', 'utf8').replace(/\r\n/g, '\n');

describe('the light theme\'s ON switch', () => {
  it('has an ON rule at least as specific as the light OFF track, after it, in the accent colour', () => {
    const off = css.indexOf(':root[data-theme="light"] .toggle-switch::before,');
    const on = css.indexOf(':root[data-theme="light"] .toggle-switch--on::before,');
    expect(off).toBeGreaterThan(0);
    expect(on).toBeGreaterThan(off);
    const rule = css.slice(on, css.indexOf('}', on));
    expect(rule).toContain(':root[data-theme="light"] .settings-panel__source-toggle--on::before');
    expect(rule).toContain('background: var(--accent);');
  });

  it('Holiday\'s green still wins (holiday.css loads after modal.css)', () => {
    const page = fs.readFileSync('renderer/index.html', 'utf8');
    expect(page.indexOf('styles/holiday.css')).toBeGreaterThan(page.indexOf('styles/modal.css'));
    expect(fs.readFileSync('renderer/styles/holiday.css', 'utf8')).toMatch(/:root\[data-season="holiday"\] \.toggle-switch--on::before/);
  });
});
