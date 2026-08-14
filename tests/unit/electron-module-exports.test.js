/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Every name in a main-process `module.exports` must actually exist.
//
// WHY THIS EXISTS, 2026-08-13. A scripted edit added `getHealthDetail` and
// `isBackendMissing` to python-bridge.js's export list but the accompanying
// function-definition edit silently did not match, so the file exported two
// identifiers that were never declared. The app died on launch with
// `ReferenceError: getHealthDetail is not defined`.
//
// It slipped through every check that was run:
//   * `node --check` PASSES — it is valid syntax. An undeclared identifier
//     in an object literal is only an error when the line EXECUTES.
//   * the 3,517-test suite PASSES — nothing under tests/ imports
//     electron/*.js at all, so the main process has no coverage.
//   * grepping the export list "confirmed" the change, because the export
//     was exactly the half that had applied.
//
// A main-process module that cannot even load takes the whole app with it,
// so it is worth a cheap static guard. This deliberately does NOT require()
// the modules — main.js and preload.js need the real Electron runtime
// (`app.getVersion`, `contextBridge`) and would throw for unrelated reasons.
// Reading the export list and checking each name is declared somewhere in
// the file catches the failure mode without needing Electron at all.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ELECTRON_DIR = path.join(ROOT, 'electron');

const files = fs.readdirSync(ELECTRON_DIR).filter((f) => f.endsWith('.js'));

/** Names listed in `module.exports = { … }`, shorthand or `key: value`. */
function exportedNames(src) {
  const m = src.match(/module\.exports\s*=\s*\{([\s\S]*?)\n\};/);
  if (!m) return [];
  return m[1]
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, '').trim())
    .filter((l) => l && !l.startsWith('/*') && !l.startsWith('*'))
    .map((l) => {
      const kv = l.match(/^([A-Za-z_$][\w$]*)\s*:/);      // key: value
      if (kv) return kv[1] === l.replace(/[,\s]+$/, '') ? kv[1] : null;
      const short = l.match(/^([A-Za-z_$][\w$]*)\s*,?$/);  // shorthand
      return short ? short[1] : null;
    })
    .filter(Boolean);
}

/** Is `name` declared anywhere in this file? */
function isDeclared(src, name) {
  const patterns = [
    new RegExp(`\\bfunction\\s+${name}\\b`),
    new RegExp(`\\b(?:const|let|var)\\s+${name}\\b`),
    new RegExp(`\\bclass\\s+${name}\\b`),
    // Destructured from a require, e.g. `const { app } = require('electron')`
    new RegExp(`\\{[^}]*\\b${name}\\b[^}]*\\}\\s*=\\s*require\\(`),
  ];
  return patterns.some((p) => p.test(src));
}

describe('main-process modules export only names they define', () => {
  // The regression: exporting an identifier that was never declared.
  for (const file of files) {
    it(`${file}`, () => {
      const src = fs.readFileSync(path.join(ELECTRON_DIR, file), 'utf8');
      const names = exportedNames(src);
      const undeclared = names.filter((n) => !isDeclared(src, n));
      expect(
        undeclared,
        `${file} exports ${undeclared.join(', ')} but never declares ${undeclared.length > 1 ? 'them' : 'it'} — `
        + 'the app will die on launch with a ReferenceError',
      ).toEqual([]);
    });
  }

  it('actually found modules to check', () => {
    // Guards against the glob silently matching nothing and the whole
    // suite passing vacuously.
    expect(files.length).toBeGreaterThan(5);
  });

  it('finds the export lists it is meant to be reading', () => {
    // If the regex stopped matching, every file would report zero exports
    // and this test would pass while checking nothing.
    const withExports = files.filter((f) => {
      const src = fs.readFileSync(path.join(ELECTRON_DIR, f), 'utf8');
      return exportedNames(src).length > 0;
    });
    expect(withExports.length).toBeGreaterThan(3);
  });
});

describe('the modules that can load outside Electron actually do', () => {
  // python-bridge and store are requireable (they only touch `electron`
  // lazily, inside functions). main.js and preload.js are not — they call
  // app.getVersion() / contextBridge at module scope.
  for (const file of ['python-bridge.js', 'store.js']) {
    it(`${file} loads and every export resolves`, async () => {
      const mod = await import(`file://${path.join(ELECTRON_DIR, file).replace(/\\/g, '/')}`);
      const cjs = mod.default ?? mod;
      const undef = Object.entries(cjs)
        .filter(([, v]) => v === undefined)
        .map(([k]) => k);
      expect(undef, `${file} has undefined exports: ${undef.join(', ')}`).toEqual([]);
    });
  }
});
