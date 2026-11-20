/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// A MERGE import never lets a backup's null, missing or wrongly shaped block
// replace this machine's block (fixup-data 2026-11-18; found by 1b-tagdata;
// also in v0.9.2). `_deepMerge` copied any non-object over a plain object,
// so a hand-edited or damaged backup with `"library": null` wiped every
// association, variant, thumbnail and resume entry here. Absence is never
// destructive (notes/DESIGN.md; Dave's rule after the 2026-08-11 loss).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const { mergeConfig } = require_('../../electron/data-export.js');

const LIBRARY = Object.freeze({
  sources: [{ path: 'C:/Videos', enabled: true }],
  associations: { 'C:/Videos/a.mp4': { single: 'C:/Videos/a.funscript', active: 'single' } },
  manualVariants: { 'C:/Videos/a.mp4': ['C:/Videos/a (soft).funscript'] },
  resume: { 'C:/Videos/a.mp4': 123 },
  userTags: { 'C:/Videos/a.mp4': ['pov'] },
});
const local = () => ({
  settings: { library: structuredClone(LIBRARY), player: { volume: 0.5, theme: 'dark' }, handy: { key: 'LOCALKEY' } },
  playlists: [], categories: [], videoCategories: {},
});
const merge = (settings) => mergeConfig(local(), { settings, playlists: [], categories: [] }, 'merge').settings;

describe('merge import: a null, missing or wrongly shaped block changes nothing here', () => {
  for (const [label, value] of [['null', null], ['a list', []], ['a string', 'x'], ['a number', 0], ['true', true]]) {
    it(`settings.library is ${label}: this machine's library block is byte-identical`, () => {
      const merged = merge({ library: value, player: { volume: 0.9 } });
      expect(JSON.stringify(merged.library)).toBe(JSON.stringify(LIBRARY));
      // The rest of the backup still merges.
      expect(merged.player).toEqual({ volume: 0.9, theme: 'dark' });
    });
  }

  it('a block inside the block (associations: null, sources: null or an object) is kept too', () => {
    const merged = merge({ library: { associations: null, sources: { not: 'a list' }, manualVariants: 'x', resume: { 'C:/Videos/b.mp4': 5 } } });
    expect(merged.library.associations).toEqual(LIBRARY.associations);
    expect(merged.library.sources).toEqual(LIBRARY.sources);
    expect(merged.library.manualVariants).toEqual(LIBRARY.manualVariants);
    // A well-shaped block still merges as before.
    expect(merged.library.resume).toEqual({ 'C:/Videos/a.mp4': 123, 'C:/Videos/b.mp4': 5 });
  });

  it('settings itself not an object: nothing here changes', () => {
    for (const settings of ['x', [], 42]) {
      expect(JSON.stringify(merge(settings))).toBe(JSON.stringify(local().settings));
    }
  });

  it('well-shaped values still win as before: a list replaces a list, a value replaces a value, a block fills a null', () => {
    const merged = mergeConfig(
      { settings: { library: { sources: [{ path: 'C:/A' }], lastScan: null }, player: { volume: 0.5 } } },
      { settings: { library: { sources: [{ path: 'D:/B' }], lastScan: { at: 1 } }, player: { volume: 0.7 } } },
      'merge',
    ).settings;
    expect(merged.library.sources).toEqual([{ path: 'D:/B' }]);
    expect(merged.library.lastScan).toEqual({ at: 1 });
    expect(merged.player.volume).toBe(0.7);
  });
});
