// Regression test — every key present in en.json must also exist in every
// other shipped locale bundle. If a translator misses a key, ICU MessageFormat
// would silently fall back to English at runtime — but that's a translation
// hole, not a feature. Catching it here keeps the locale bundles in lockstep.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename, extname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const localesDir = resolve(__dirname, '../../renderer/locales');

function loadBundle(code) {
  const raw = readFileSync(resolve(localesDir, `${code}.json`), 'utf8');
  return JSON.parse(raw);
}

// Recursively flatten a nested object into `dotted.path` keys mapped to the
// leaf value. Leaf-only — interior objects are not included so the test
// compares actual translatable strings, not structural noise.
function flatten(obj, prefix = '', acc = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      flatten(v, path, acc);
    } else {
      acc[path] = v;
    }
  }
  return acc;
}

// Discover all shipped locales by listing the locales directory. en is the
// schema; every other JSON file is checked against it.
const SHIPPED = readdirSync(localesDir)
  .filter(f => f.endsWith('.json'))
  .map(f => basename(f, extname(f)));

const NON_EN = SHIPPED.filter(c => c !== 'en');

const en = flatten(loadBundle('en'));

// Extract ICU placeholder NAMES from a message. A placeholder is an
// identifier inside `{...}` that's immediately followed by `}` (simple
// `{name}` interpolation) or `,` (a typed placeholder like
// `{count, plural, ...}`). Walking the string this way correctly
// distinguishes placeholders from plural-form sub-template bodies like
// `{Auto-assigned # videos}` — there `Auto-assigned` is followed by a
// hyphen + space, not `}` or `,`, so it's ignored.
//
// Plural sub-template bodies CAN contain real placeholders too — e.g.
// `{filtered, plural, other {{total} ... }}` — and those should be
// captured. The walker keeps scanning past the first `{`, so it still
// finds `{total}` inside the body.
function extractPlaceholderNames(str) {
  const names = new Set();
  for (let i = 0; i < str.length; i++) {
    if (str[i] !== '{') continue;
    let j = i + 1;
    while (j < str.length && /\s/.test(str[j])) j++;
    let name = '';
    while (j < str.length && /\w/.test(str[j])) {
      name += str[j];
      j++;
    }
    if (!name) continue;
    // Only count as a placeholder if followed by `}` or `,` (possibly
    // after whitespace). Otherwise this is plural-form body text like
    // `{Auto-assigned # videos}` and we should skip it.
    while (j < str.length && /\s/.test(str[j])) j++;
    if (str[j] === '}' || str[j] === ',') {
      names.add(name);
    }
  }
  return names;
}

describe('locale key parity', () => {
  it.each(NON_EN)('%s.json covers every key in en.json', (code) => {
    const other = flatten(loadBundle(code));
    const missing = Object.keys(en).filter(k => !(k in other));
    expect(missing, `${code}.json missing keys: ${missing.join(', ')}`).toEqual([]);
  });

  it.each(NON_EN)('%s.json does not introduce keys absent from en.json', (code) => {
    const other = flatten(loadBundle(code));
    const extras = Object.keys(other).filter(k => !(k in en));
    expect(extras, `${code}.json has keys not in en.json: ${extras.join(', ')}`).toEqual([]);
  });

  it.each(SHIPPED)('%s.json values are all non-empty strings', (code) => {
    const bundle = flatten(loadBundle(code));
    for (const [k, v] of Object.entries(bundle)) {
      expect(typeof v, `${code}.${k} must be a string`).toBe('string');
      expect(v.length, `${code}.${k} must be non-empty`).toBeGreaterThan(0);
    }
  });

  it.each(NON_EN)('%s.json ICU placeholder names match en.json', (code) => {
    const other = flatten(loadBundle(code));
    for (const [k, enVal] of Object.entries(en)) {
      const otherVal = other[k];
      if (typeof otherVal !== 'string') continue;
      const enNames = extractPlaceholderNames(enVal);
      const otherNames = extractPlaceholderNames(otherVal);
      const missing = [...enNames].filter(n => !otherNames.has(n));
      const extra = [...otherNames].filter(n => !enNames.has(n));
      expect(
        missing,
        `${code}.${k} dropped placeholder(s): ${missing.join(', ')} (en="${enVal}", ${code}="${otherVal}")`
      ).toEqual([]);
      expect(
        extra,
        `${code}.${k} added placeholder(s): ${extra.join(', ')} (en="${enVal}", ${code}="${otherVal}")`
      ).toEqual([]);
    }
  });
});
