/**
 * @vitest-environment node
 * Node: reads the renderer's sources as text. See notes/CLAUDE.md
 * "Test environments".
 */
// Test day 2026-11-26 (B107): 21 toasts were written in English in the code
// (the script editor's: "Stroke repeated", "No video loaded", "Heatmap
// exported"...; the embedded-axes extract's), so a German user read them in
// English (also in v0.10.0). They go through t() now. This keeps any new one
// from being written in a language: a toast given a string literal or a
// template with words in it.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const DE = JSON.parse(fs.readFileSync('renderer/locales/de.json', 'utf8'));

function sources(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['vendor', 'node_modules', 'locales'].includes(e.name)) out.push(...sources(p)); }
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

describe('toasts are in the language chosen (B107)', () => {
  it('no toast is given words in a string literal or template', () => {
    const hits = [];
    for (const file of sources('renderer')) {
      fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
        const m = /showToast\(\s*(['"`])((?:\\.|(?!\1).)*)\1/.exec(line);
        if (!m) return;
        // Words outside ${...}: a toast that only shows a name (the editor's
        // "▶ <bookmark name>") has nothing to translate.
        const words = m[2].replace(/\$\{[^}]*\}/g, '').replace(/[^\p{L}]+/gu, '');
        if (words.length > 0) hits.push(`${file}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('the strings exist in English and German', () => {
    for (const k of ['strokeRepeated', 'heatmapExported', 'multiBandLoaded', 'voiceDetected', 'stackedNeedsMulti']) {
      expect(typeof EN.editor.toast[k], k).toBe('string');
      expect(DE.editor.toast[k], k).not.toBe(EN.editor.toast[k]);
    }
    for (const k of ['extractMissingPaths', 'extractNoAxes', 'extractFailed']) {
      expect(typeof DE.toast[k], k).toBe('string');
    }
  });
});
