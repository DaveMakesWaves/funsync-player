/**
 * @vitest-environment node
 * Reads the stylesheet and the page as text; no DOM. See notes/CLAUDE.md
 * "Test environments".
 *
 * The phone remote's polish (2026-11-23, Dave: "do it all"):
 * backend/web-remote/polish.css. Holds the revert path (one <link>) and the
 * promises: every rule under the remote's always-on Modern attribute, and
 * nothing decorative (no gradient, glow or new blur).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const CSS = fs.readFileSync('backend/web-remote/polish.css', 'utf8');
const HTML = fs.readFileSync('backend/web-remote/index.html', 'utf8');

function selectors(css) {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  for (const m of plain.matchAll(/([^{}]+)\{/g)) {
    const head = m[1].trim();
    if (!head || head.startsWith('@')) continue;
    for (const sel of head.split(',')) out.push(sel.trim());
  }
  return out;
}

describe('the phone remote polish', () => {
  it('one <link>, right after style.css, saying how to revert; the header says so too', () => {
    const links = [...HTML.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
    expect(links).toEqual(['./style.css', './polish.css']);
    expect(HTML).toMatch(/polish\.css"><!-- 2026-11-23 polish; delete this line to revert -->/);
    expect(CSS).toMatch(/REVERT: delete the one line/);
  });

  it('the remote always sets data-style="modern", and every rule is under it', () => {
    expect(HTML).toMatch(/<html[^>]*data-style="modern"/);
    const sels = selectors(CSS);
    expect(sels.length).toBeGreaterThan(25);
    for (const s of sels) expect(s, s).toMatch(/^:root\[data-style="modern"\]/);
  });

  it('no gradients, glow or blur; shadows are hairlines, rings or none', () => {
    const plain = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(plain).not.toMatch(/gradient\(|blur\(|drop-shadow/);
    for (const m of plain.matchAll(/box-shadow:\s*([^;]+);/g)) {
      expect(m[1], m[1]).toMatch(/^(none|inset 0 0 0 1px var\(--[a-z-]+\)|0 0 0 2px var\(--polish-ring\))$/);
    }
  });

  it('the same navy as the desktop polish, and neutral focus', () => {
    const desk = fs.readFileSync('renderer/styles/modern-polish.css', 'utf8');
    const navy = /--surface-base: (#[0-9a-f]{6});/.exec(desk)[1];
    expect(CSS).toMatch(new RegExp(`--bg-primary: ${navy};`));
    expect(CSS).toMatch(/--polish-ring: rgba\(228, 231, 239, 0\.72\)/);
  });
});
