/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// At 800x600 (or 125% on 1280x720) the Settings rail needed a scrollbar of
// its own beside the content's (FT-039 note): measured 26-80 px over in four
// areas on 2026-11-23. A short window (max-height 680px) gets 28 px area rows
// and 22 px section links, which fit all seven areas with Appearance's six
// links open (measured live: 348/348 in every area); taller windows keep 36 px.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const css = fs.readFileSync('renderer/styles/modal.css', 'utf8').replace(/\r\n/g, '\n');

describe('the Settings rail in a short window', () => {
  it('rows tighten only under 680 px tall; the 36 px rows stay the default', () => {
    const at = css.indexOf('@media (max-height: 680px) {');
    expect(at).toBeGreaterThan(0);
    const block = css.slice(at, css.indexOf('\n}\n', at) + 2);
    expect(block).toMatch(/\.settings-panel__rail-item \{\s+min-height: 28px;\s+padding-top: 4px;\s+padding-bottom: 4px;/);
    expect(block).toMatch(/\.settings-panel__rail-group \{\s+padding-top: 3px;\s+padding-bottom: 3px;/);
    const base = css.slice(css.indexOf('.settings-panel__rail-item {'), css.indexOf('}', css.indexOf('.settings-panel__rail-item {')));
    expect(base).toContain('min-height: 36px;');
  });
});
