/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// CB-22 (block B verification, shot funsync-sandbox-blockb-2/shots/22-remote-
// zulu.png): the phone's search field showed TWO clear buttons once it held
// text: Chromium's own cancel cross, drawn inside every type="search" field,
// and the app's #searchClear beside it. `appearance: none` on the input does
// not remove the cross; only the ::-webkit-search-cancel-button rule does.
//
// jsdom draws no pseudo-elements, so this checks the stylesheet against the
// real markup. The drawn result was measured in Electron's Chromium for this
// fix: a focused, hovered search field with text differed from a text field
// by 56 pixels (the cross, x 318-327) with the old stylesheet, and by 0 with
// this one.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const css = fs.readFileSync('backend/web-remote/style.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const html = fs.readFileSync('backend/web-remote/index.html', 'utf8');

/** Declarations of every rule whose selector list includes `selector`. */
function declarationsFor(selector) {
  const out = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(',').map((s) => s.trim());
    if (selectors.includes(selector)) out.push(m[2]);
  }
  return out.join(';');
}

describe('the phone search field has one clear button (CB-22)', () => {
  const input = /<input\b[^>]*id="searchInput"[^>]*>/.exec(html)?.[0] || '';
  const inputClass = /class="([^"]+)"/.exec(input)?.[1].split(/\s+/)[0];

  // Dave, 2026-11-25: "on mobile the search bar has two x" again, on his
  // phone. The rule below hides the cross in Chromium (measured), not in every
  // phone browser. A text field with the search keyboard gets no native cross
  // from any browser; role=searchbox keeps what it is for screen readers.
  it('the field is a text input with the search keyboard (no browser draws a cross in it) and the app\'s own clear button', () => {
    expect(input).toMatch(/type="text"/);
    expect(input).not.toMatch(/type="search"/);
    expect(input).toMatch(/role="searchbox"/);
    expect(input).toMatch(/inputmode="search"/);
    expect(input).toMatch(/enterkeyhint="search"/);
    expect(inputClass).toBe('search-bar__input');
    expect(html).toMatch(/<button[^>]*id="searchClear"/);
  });

  it("the native cancel cross stays hidden on that field's class (were it ever a search field again)", () => {
    const decls = declarationsFor(`.${inputClass}::-webkit-search-cancel-button`);
    expect(decls).toMatch(/(^|;)\s*display\s*:\s*none\s*(;|$)/);
    expect(decls).toMatch(/(^|;)\s*-webkit-appearance\s*:\s*none\s*(;|$)/);
  });
});
