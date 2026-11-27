/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Every literal translation key the code uses exists in en.json (block F
// strings stage found the gap; TODO triage 2026-11-23). locale-key-parity
// compares the other 7 bundles with en.json, so a key that is in NO bundle
// passed everything and the UI showed the raw key ("audience.room.resend").
// Scans the desktop renderer and the phone remote for t('a.b'), t("a.b") and
// data-i18n[-attr]="a.b". Keys built at run time (template strings) are not
// seen; their own tests cover them.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const en = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const KEY = String.raw`[A-Za-z]\w*(?:\.\w+)+`;
const PATTERNS = [
  new RegExp(String.raw`\bt\(\s*'(${KEY})'`, 'g'),
  new RegExp(String.raw`\bt\(\s*"(${KEY})"`, 'g'),
  new RegExp(String.raw`data-i18n(?:-[a-z]+)?="(${KEY})"`, 'g'),
];

function hasKey(bundle, key) {
  let o = bundle;
  for (const part of key.split('.')) {
    if (o == null || typeof o !== 'object' || !(part in o)) return false;
    o = o[part];
  }
  return o != null;
}

function missingKeys(source, bundle) {
  const out = [];
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source))) if (!hasKey(bundle, m[1])) out.push(m[1]);
  }
  return out;
}

function sourceFiles() {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { if (!/^(vendor|assets|locales)$/.test(e.name)) walk(f); }
      else if (/\.(js|html)$/.test(e.name)) files.push(f);
    }
  };
  walk('renderer');
  walk('backend/web-remote');
  return files;
}

describe('translation keys used in the code', () => {
  it('the scan finds a key that is not in the bundle (and none that is)', () => {
    const src = `t('player.subtitles.off'); t("no.such.key"); <b data-i18n-title="also.missing"></b> t(\`built.\${x}\`)`;
    expect(missingKeys(src, en)).toEqual(['no.such.key', 'also.missing']);
  });

  it('every literal key in the renderer and the phone remote is in en.json', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(150);
    const missing = files.flatMap((f) => missingKeys(fs.readFileSync(f, 'utf8'), en).map((k) => `${f}: ${k}`));
    expect(missing).toEqual([]);
  });
});
