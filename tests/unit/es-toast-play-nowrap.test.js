/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The EroScripts tab's "Downloaded … and its script" toast: its Play button
// never shrinks or wraps (Dave, 2026-11-23: it showed "Pl / ay" beside a
// long post title in the sneak-peek recording).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

describe('the downloaded toast Play button', () => {
  it('keeps its size and its one line', () => {
    const css = fs.readFileSync('renderer/styles/eroscripts.css', 'utf8').replace(/\r\n/g, '\n');
    const rule = css.match(/\n\.es-toast__play \{([^}]*)\}/)?.[1] || '';
    expect(rule).toMatch(/flex-shrink: 0;/);
    expect(rule).toMatch(/white-space: nowrap;/);
  });
});
