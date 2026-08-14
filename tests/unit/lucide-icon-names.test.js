/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Every `data-lucide="x"` placeholder must resolve to a registered icon.
//
// Found 2026-08-13 by actually launching the app and reading the boot log:
//
//   <i data-lucide="repeat-1"> icon name was not found in the provided icons object.
//   <i data-lucide="rectangle-goggles"> icon name was not found ...
//
// Both rendered as NOTHING — an empty button with a tooltip. Two different
// causes, one shared root:
//
//   * `repeat-1` was registered in the player pop-out but not in the main
//     window, so the loop button was blank in the main window only.
//   * `rectangle-goggles` was registered under our import alias `Goggles`.
//     createIcons resolves `icons[toPascalCase(attr)]`, so the attribute
//     `rectangle-goggles` looks for the key `RectangleGoggles` and never
//     matched. The name it is imported AS is irrelevant; only the KEY counts.
//
// Lucide only warns to the console, so a missing icon is invisible in tests
// and easy to miss by eye — a blank button looks like a styling choice.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Which JS file calls createIcons for which HTML document. */
const PAIRS = [
  { html: 'renderer/index.html', js: 'renderer/js/app.js' },
  { html: 'renderer/player-popout.html', js: 'renderer/player-popout.js' },
];

/** lucide's own conversion: kebab attribute → PascalCase key. */
function toPascalCase(str) {
  const camel = str.replace(/[-_]([a-z0-9])/g, (_, c) => c.toUpperCase());
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

/**
 * `data-lucide` names that are actually in the DOM.
 *
 * HTML comments are stripped first: the Load-from-URL button is commented
 * out on purpose (a documented anti-goal), so its `data-lucide="link"` never
 * reaches the DOM and must not be treated as a missing icon.
 */
function usedIconNames(htmlPath) {
  const raw = fs.readFileSync(path.join(ROOT, htmlPath), 'utf8');
  const live = raw.replace(/<!--[\s\S]*?-->/g, '');
  return [...new Set(
    [...live.matchAll(/data-lucide="([^"]+)"/g)].map((m) => m[1]),
  )].sort();
}

/** Keys of the object literal passed as `icons:` to createIcons. */
function registeredIconKeys(jsPath) {
  const src = fs.readFileSync(path.join(ROOT, jsPath), 'utf8');
  const start = src.indexOf('createIcons({');
  if (start < 0) return [];
  const iconsAt = src.indexOf('icons: {', start);
  if (iconsAt < 0) return [];
  // Walk braces so nested/aliased entries and comments are handled.
  let depth = 0;
  let end = iconsAt + 'icons: '.length;
  for (let i = end; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  const body = src.slice(iconsAt + 'icons: {'.length, end);
  return body
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, '').trim())
    .filter(Boolean)
    .flatMap((l) => l.split(','))
    .map((entry) => {
      const t = entry.trim();
      if (!t) return null;
      const alias = t.match(/^([A-Za-z_$][\w$]*)\s*:/);   // Key: Value
      if (alias) return alias[1];
      const short = t.match(/^([A-Za-z_$][\w$]*)$/);       // shorthand
      return short ? short[1] : null;
    })
    .filter(Boolean);
}

describe.each(PAIRS)('$html icons resolve via $js', ({ html, js }) => {
  const used = usedIconNames(html);
  const keys = new Set(registeredIconKeys(js));

  it('parsed both sides (guards against a vacuous pass)', () => {
    // If either extraction silently returned nothing, the comparison below
    // would pass while checking nothing at all.
    expect(used.length, `no data-lucide attributes found in ${html}`).toBeGreaterThan(3);
    expect(keys.size, `no icons registered in ${js}`).toBeGreaterThan(3);
  });

  it('every placeholder has a matching PascalCase key', () => {
    const missing = used.filter((name) => !keys.has(toPascalCase(name)));
    expect(
      missing,
      `${html} uses ${missing.map((n) => `"${n}" (needs key ${toPascalCase(n)})`).join(', ')} `
      + `but ${js} does not register ${missing.length > 1 ? 'them' : 'it'} — `
      + 'the icon renders as nothing and lucide only warns to the console',
    ).toEqual([]);
  });
});

describe('toPascalCase matches lucide', () => {
  // If this drifts, the check above silently stops matching reality.
  it('converts the cases we actually rely on', () => {
    expect(toPascalCase('repeat-1')).toBe('Repeat1');
    expect(toPascalCase('rectangle-goggles')).toBe('RectangleGoggles');
    expect(toPascalCase('volume-2')).toBe('Volume2');
    expect(toPascalCase('picture-in-picture-2')).toBe('PictureInPicture2');
    expect(toPascalCase('play')).toBe('Play');
  });
});

describe('commented-out markup is excluded', () => {
  // The Load-from-URL button is disabled on purpose and lives inside an HTML
  // comment. Counting it would produce a permanent false failure.
  it('ignores data-lucide inside HTML comments', () => {
    const raw = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');
    expect(raw).toContain('data-lucide="link"');       // present in the file
    expect(usedIconNames('renderer/index.html')).not.toContain('link'); // not in the DOM
  });
});
