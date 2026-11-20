/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Pattern library strings (next major, 2026-11-17): every pattern and family
// the engine lists has its name and description in en.json, under the keys
// the engine hands out (patterns.<id>.name / .desc and
// patterns.family.<id>.name / .desc). locale-key-parity.test.js then holds
// the other 7 locales to the same keys. No string under patterns.* in any
// locale looks like a path or a file.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { listFamilies, listPatterns, describePattern } from '../../renderer/js/pattern-library.js';

const dir = fileURLToPath(new URL('../../renderer/locales/', import.meta.url));
const bundles = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(dir + f, 'utf8'))]));
const get = (obj, key) => key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);

describe('pattern library strings', () => {
  it('every family has a name and a description in English', () => {
    const missing = [];
    for (const f of listFamilies()) for (const key of [f.nameKey, f.descKey]) if (typeof get(bundles.en, key) !== 'string' || !get(bundles.en, key).trim()) missing.push(key);
    expect(missing).toEqual([]);
  });

  it('every pattern has a name and a description in English, under the keys describePattern gives', () => {
    const missing = [];
    for (const p of listPatterns()) {
      const d = describePattern(p.id);
      expect(d.nameKey).toBe(`patterns.${p.id}.name`);
      for (const key of [d.nameKey, d.descKey]) if (typeof get(bundles.en, key) !== 'string' || !get(bundles.en, key).trim()) missing.push(key);
    }
    expect(missing).toEqual([]);
  });

  it('patterns.* holds no stale ids, and the names in a list are told apart', () => {
    const ids = new Set(listPatterns().map((p) => p.id));
    const famIds = new Set(listFamilies().map((f) => f.id));
    for (const [lc, b] of Object.entries(bundles)) {
      // "ui" is reserved for the picker's own strings
      const stale = Object.keys(b.patterns).filter((k) => k !== 'family' && k !== 'ui' && !ids.has(k));
      expect(stale, lc).toEqual([]);
      expect(Object.keys(b.patterns.family).filter((k) => !famIds.has(k)), lc).toEqual([]);
      const names = [...ids].map((id) => b.patterns[id].name.toLocaleLowerCase(lc));
      expect(new Set(names).size, `${lc}: two patterns share a name`).toBe(names.length);
      const famNames = [...famIds].map((id) => b.patterns.family[id].name.toLocaleLowerCase(lc));
      expect(new Set(famNames).size, `${lc}: two families share a name`).toBe(famNames.length);
    }
  });

  it('no string under patterns.* in any locale looks like a path, a file or a link', () => {
    const bad = [];
    const walk = (v, where) => {
      if (typeof v === 'string') { if (/[A-Za-z]:[\\/]|\\|\/|https?:|funscript|\.(?:json|mp4|mkv|csv)\b/i.test(v)) bad.push(`${where}: ${v}`); return; }
      for (const [k, x] of Object.entries(v)) walk(x, `${where}.${k}`);
    };
    for (const [lc, b] of Object.entries(bundles)) walk(b.patterns, `${lc}.patterns`);
    expect(bad).toEqual([]);
  });
});
