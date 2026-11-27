/**
 * @vitest-environment node
 * Reads the stylesheet and the pages as text; no DOM. See notes/CLAUDE.md
 * "Test environments".
 *
 * Modern polish (2026-11-23, Dave: "do all 7 leave an easy revert path"):
 * renderer/styles/modern-polish.css. What these hold is the revert path and
 * the promises around it: one <link> per page is the whole switch, Classic
 * never changes, Holiday keeps its colours, and nothing "AI-styled" crept in.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const CSS = fs.readFileSync('renderer/styles/modern-polish.css', 'utf8');
const PAGES = ['index', 'player-popout', 'editor-popout', 'audience-room'];

/** Every selector of every rule (comments out, @media unwrapped, @keyframes steps skipped). */
function selectors(css) {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  const out = [];
  for (const m of plain.matchAll(/([^{}]+)\{/g)) {
    const head = m[1].trim();
    if (!head || head.startsWith('@')) continue;
    for (const sel of head.split(',')) out.push(sel.trim());
  }
  return out;
}

describe('the revert path', () => {
  it('each page links it once, right after modern.css, with the line saying how to revert', () => {
    for (const page of PAGES) {
      const html = fs.readFileSync(`renderer/${page}.html`, 'utf8');
      const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
      expect(links.filter((h) => h === 'styles/modern-polish.css'), page).toHaveLength(1);
      expect(links[links.indexOf('styles/modern.css') + 1], page).toBe('styles/modern-polish.css');
      expect(html, page).toMatch(/modern-polish\.css"><!-- 2026-11-23 Modern polish; delete this line to revert -->/);
    }
  });

  it('nothing else loads it: deleting the four lines is the whole revert (comments may point at it)', () => {
    const refs = [];
    // Code only: a comment saying "styled in modern-polish.css" loads nothing.
    const code = (text, name) => (name.endsWith('.html')
      ? text.replace(/<!--[\s\S]*?-->/g, '')
      : text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''));
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else if (/\.(js|html|css)$/.test(e.name) && e.name !== 'modern-polish.css'
          && code(fs.readFileSync(p, 'utf8'), e.name).includes('modern-polish')) refs.push(p);
      }
    };
    walk('renderer');
    expect(refs.sort()).toEqual(PAGES.map((p) => `renderer/${p}.html`).sort());
  });

  it('what Modern adds to the EroScripts cards is hidden without it (Classic and a revert look as before)', () => {
    expect(fs.readFileSync('renderer/styles/eroscripts.css', 'utf8')).toMatch(/\.es-card__nothumb,\s+\.es-skel \{ display: none; \}/);
  });

  it('the header says how to revert', () => {
    expect(CSS).toMatch(/REVERT: delete the one <link rel="stylesheet" href="styles\/modern-polish\.css">/);
  });
});

describe('Classic never changes, Holiday keeps its colours', () => {
  it('every rule is under :root[data-style="modern"]', () => {
    const sels = selectors(CSS);
    expect(sels.length).toBeGreaterThan(50);
    for (const s of sels) expect(s, s).toMatch(/^:root\[data-style="modern"\]/);
  });

  it('Holiday keeps its green touches: the active filter chips, and switches that are on (also the Settings ones)', () => {
    expect(CSS).toMatch(/:root\[data-style="modern"\]:not\(\[data-season="holiday"\]\) \.filter-chip \{/);
    expect(CSS).not.toMatch(/^:root\[data-style="modern"\] \.filter-chip \{/m);
    expect(CSS).toMatch(/:root\[data-style="modern"\]\[data-season="holiday"\] \.settings-panel__input--checkbox:checked \{\s+background: var\(--holiday-green\);/);
  });

  it('the navy ladder is dark only and skips Holiday', () => {
    expect(CSS).toMatch(/:root\[data-style="modern"\]:not\(\[data-theme="light"\]\):not\(\[data-season="holiday"\]\) \{\s+--surface-base: #151b30;/);
  });
});

describe('polish, not decoration', () => {
  it('no gradients, no glow, no blur', () => {
    const plain = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(plain).not.toMatch(/gradient\(/);
    expect(plain).not.toMatch(/blur\(/);
    expect(plain).not.toMatch(/drop-shadow/);
    // Every box-shadow is a hairline or a ring: no spread of light around anything.
    for (const m of plain.matchAll(/box-shadow:\s*([^;]+);/g)) {
      expect(m[1], m[1]).toMatch(/^(none|inset 0 0 0 1px var\(--[a-z-]+\)|0 0 0 2px var\(--polish-ring\))$/);
    }
  });

  it('focus is neutral; red stays for "on" (switch checked, a pressed control)', () => {
    expect(CSS).toMatch(/--polish-ring: rgba\(228, 231, 239, 0\.72\)/);
    expect(CSS).toMatch(/\.settings-panel__input--checkbox:checked \{\s+background: var\(--accent\);/);
    expect(CSS).toMatch(/\.control-btn\[aria-pressed="true"\] \{\s+color: var\(--accent\);/);
  });

  it('the heat strip canvas is a block: inline, it sat on a text baseline below its 4px band, out of sight (found live 2026-11-23)', () => {
    expect(CSS).toMatch(/:root\[data-style="modern"\] \.progress__heatmap canvas \{\s+display: block;/);
    expect(CSS).toMatch(/:root\[data-style="modern"\] \.progress__heatmap \{\s+top: 2px;\s+height: 4px;/);
  });

  it('round two: EroScripts Download is an outline that fills red only on hover / focus; Free / Paid a dot; status a dot, not a tinted label', () => {
    expect(CSS).toMatch(/\.es-card__btn:not\(\.eroscripts-panel__btn--secondary\) \{\s+background: transparent;/);
    expect(CSS).toMatch(/\.es-card:hover \.es-card__btn:not\(\.eroscripts-panel__btn--secondary\),[\s\S]{0,400}?\{\s+background: var\(--accent\);/);
    expect(CSS).toMatch(/\.es-card__price--free::before \{ background: var\(--state-connected\); \}/);
    expect(CSS).toMatch(/\.nav-bar__eroscripts--connected:not\(\.nav-bar__eroscripts--active\),[\s\S]{0,300}?\{\s+color: var\(--text-secondary\);/);
    expect(CSS).toMatch(/\.nav-bar__vr-btn--waiting::before \{\s+background: var\(--state-warning\);/);
    // The skeleton only breathes (opacity); no sweep, no gradient.
    expect(CSS).toMatch(/@keyframes polish-skel \{\s+from \{ opacity: 0\.5; \}\s+to \{ opacity: 1; \}\s+\}/);
    // Light gets its own ladder, Holiday still keeps its colours.
    expect(CSS).toMatch(/:root\[data-style="modern"\]\[data-theme="light"\]:not\(\[data-season="holiday"\]\) \{\s+--surface-base: #f3f4f8;/);
  });

  it('digits are fixed-width everywhere in Modern', () => {
    expect(CSS).toMatch(/:root\[data-style="modern"\] body \{\s+font-variant-numeric: tabular-nums;/);
  });
});
