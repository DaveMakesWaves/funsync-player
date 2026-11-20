/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// V81 perf guard. On Dave's library a sort click spent 10-40 ms in
// `_applyFilters`' pure pipeline and 6-12 s rendering (see
// library-large-library-speed.test.js). This keeps the pipeline itself from
// becoming the problem: the steps a sort click runs, on 20,000 synthetic
// videos, for every sort option, stay well inside a generous bound, and the
// order each produces is the order it promises.
import { describe, it, expect } from 'vitest';
import { sortVideos, dedupeByName, compareNames } from '../../renderer/js/library-search.js';

const N = 20000;
let seed = 11;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const videos = Array.from({ length: N }, (_, i) => {
  const dir = i % 3 === 0 ? 'E:\\Other' : 'D:\\funsc';
  // Every 20th name repeats in the other folder, as "hide duplicate names" sees.
  const name = `${['Alpha', 'beta', 'Gamma', 'delta', 'Épsilon'][i % 5]} scene ${i % 20 === 0 ? i - 1 : i}.mp4`;
  return {
    name,
    path: `${dir}\\${name}`,
    hasFunscript: rnd() > 0.3,
    duration: Math.floor(rnd() * 7200),
    dateAdded: 1.7e12 + Math.floor(rnd() * 1e10),
    avgSpeed: Math.floor(rnd() * 500),
    maxSpeed: Math.floor(rnd() * 900),
  };
});

describe('filtering and sorting 20,000 videos (V81 perf guard)', () => {
  it('runs every sort option over the Matched + hide-duplicates pipeline in well under a second each', () => {
    const fields = [['name', 'asc'], ['name', 'desc'], ['dateAdded', 'desc'], ['duration', 'asc'], ['avgSpeed', 'desc'], ['maxSpeed', 'desc']];
    const times = {};
    for (const [field, dir] of fields) {
      const t0 = performance.now();
      const shown = sortVideos(dedupeByName(videos.filter((v) => v.hasFunscript)), field, dir);
      times[`${field}:${dir}`] = performance.now() - t0;

      expect(shown.length).toBeGreaterThan(N * 0.6);
      for (let i = 1; i < shown.length; i++) {
        const a = shown[i - 1];
        const b = shown[i];
        const c = field === 'name' ? compareNames(a.name, b.name) : (a[field] || 0) - (b[field] || 0);
        expect(dir === 'asc' ? c <= 0 : c >= 0).toBe(true);
      }
    }
    for (const ms of Object.values(times)) expect(ms).toBeLessThan(1000);
  });
});
