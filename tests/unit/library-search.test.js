import { describe, it, expect } from 'vitest';
import { fuzzySearch, sortVideos, filterVideos } from '../../renderer/js/library-search.js';

const videos = [
  { name: 'Alpha Video.mp4', path: '/v/alpha.mp4', hasFunscript: true, duration: 120, lastPlayed: 1000 },
  { name: 'Beta Clip.mkv', path: '/v/beta.mkv', hasFunscript: false, duration: 60, lastPlayed: 3000 },
  { name: 'Gamma Test.avi', path: '/v/gamma.avi', hasFunscript: true, duration: 300, lastPlayed: 2000 },
  { name: 'Delta Movie.mp4', path: '/v/delta.mp4', hasFunscript: false, duration: 180 },
  { name: 'epsilon short.webm', path: '/v/epsilon.webm', hasFunscript: true, duration: 30, lastPlayed: 500 },
];

describe('library-search', () => {
  describe('fuzzySearch', () => {
    it('returns all videos for empty query', () => {
      expect(fuzzySearch(videos, '')).toEqual(videos);
      expect(fuzzySearch(videos, null)).toEqual(videos);
      expect(fuzzySearch(videos, '   ')).toEqual(videos);
    });

    it('returns empty for empty video list', () => {
      expect(fuzzySearch([], 'test')).toEqual([]);
      expect(fuzzySearch(null, 'test')).toEqual([]);
    });

    it('finds exact name match', () => {
      const results = fuzzySearch(videos, 'Alpha Video.mp4');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].name).toBe('Alpha Video.mp4');
    });

    it('finds substring match', () => {
      const results = fuzzySearch(videos, 'Beta');
      expect(results.length).toBe(1);
      expect(results[0].name).toBe('Beta Clip.mkv');
    });

    it('is case-insensitive', () => {
      const results = fuzzySearch(videos, 'alpha');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].name).toBe('Alpha Video.mp4');
    });

    it('ranks exact match higher than substring', () => {
      const testVideos = [
        { name: 'test clip.mp4', path: '/a', hasFunscript: false },
        { name: 'my test.mp4', path: '/b', hasFunscript: false },
      ];
      const results = fuzzySearch(testVideos, 'test clip.mp4');
      expect(results[0].name).toBe('test clip.mp4');
    });

    it('ranks substring match higher than fuzzy', () => {
      const testVideos = [
        { name: 'xAxBxC.mp4', path: '/a', hasFunscript: false },
        { name: 'ABC.mp4', path: '/b', hasFunscript: false },
      ];
      const results = fuzzySearch(testVideos, 'ABC');
      expect(results[0].name).toBe('ABC.mp4');
    });

    it('fuzzy matches characters in order', () => {
      const results = fuzzySearch(videos, 'gmt');
      // Should match "Gamma Test" (G...a...m...m...a... T...e...s...t)
      expect(results.length).toBeGreaterThan(0);
    });

    it('returns empty when no match', () => {
      const results = fuzzySearch(videos, 'zzzzz');
      expect(results).toEqual([]);
    });

    it('handles special characters in query', () => {
      const results = fuzzySearch(videos, '.mp4');
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('sortVideos', () => {
    it('sorts by name ascending', () => {
      const sorted = sortVideos(videos, 'name', 'asc');
      expect(sorted[0].name).toBe('Alpha Video.mp4');
      // localeCompare is case-insensitive: A, B, D, e, G
      expect(sorted[4].name).toBe('Gamma Test.avi');
    });

    it('sorts by name descending', () => {
      const sorted = sortVideos(videos, 'name', 'desc');
      expect(sorted[0].name).toBe('Gamma Test.avi');
      expect(sorted[4].name).toBe('Alpha Video.mp4');
    });

    it('sorts by duration ascending', () => {
      const sorted = sortVideos(videos, 'duration', 'asc');
      expect(sorted[0].duration).toBe(30);
      expect(sorted[4].duration).toBe(300);
    });

    it('sorts by duration descending', () => {
      const sorted = sortVideos(videos, 'duration', 'desc');
      expect(sorted[0].duration).toBe(300);
    });

    it('sorts by lastPlayed (most recent first)', () => {
      const sorted = sortVideos(videos, 'lastPlayed', 'asc');
      expect(sorted[0].lastPlayed).toBe(3000); // most recent
    });

    it('sorts by hasFunscript (funscript first)', () => {
      const sorted = sortVideos(videos, 'hasFunscript', 'asc');
      expect(sorted[0].hasFunscript).toBe(true);
      expect(sorted[1].hasFunscript).toBe(true);
      expect(sorted[2].hasFunscript).toBe(true);
    });

    it('does not mutate input', () => {
      const copy = [...videos];
      sortVideos(videos, 'name', 'desc');
      expect(videos).toEqual(copy);
    });

    it('returns empty for empty/null input', () => {
      expect(sortVideos([], 'name')).toEqual([]);
      expect(sortVideos(null, 'name')).toEqual([]);
    });

    it('returns copy for unknown sort criterion', () => {
      const sorted = sortVideos(videos, 'unknown');
      expect(sorted.length).toBe(videos.length);
    });

    it('handles missing duration gracefully', () => {
      const vids = [
        { name: 'a.mp4', path: '/a', hasFunscript: false },
        { name: 'b.mp4', path: '/b', hasFunscript: false, duration: 100 },
      ];
      const sorted = sortVideos(vids, 'duration', 'asc');
      expect(sorted[0].name).toBe('a.mp4'); // undefined → 0
    });
  });

  describe('filterVideos', () => {
    it('returns all when no filters', () => {
      expect(filterVideos(videos, {})).toEqual(videos);
    });

    it('filters by hasFunscript', () => {
      const filtered = filterVideos(videos, { hasFunscript: true });
      expect(filtered.length).toBe(3);
      for (const v of filtered) {
        expect(v.hasFunscript).toBe(true);
      }
    });

    it('filters by inPlaylist', () => {
      const playlistVideos = new Set(['/v/alpha.mp4', '/v/gamma.avi']);
      const filtered = filterVideos(videos, { inPlaylist: 'pl1', playlistVideos });
      expect(filtered.length).toBe(2);
      expect(filtered[0].path).toBe('/v/alpha.mp4');
      expect(filtered[1].path).toBe('/v/gamma.avi');
    });

    it('filters by inCategory', () => {
      const videoCategoryMap = {
        '/v/alpha.mp4': ['cat1', 'cat2'],
        '/v/beta.mkv': ['cat2'],
        '/v/gamma.avi': ['cat1'],
      };
      const filtered = filterVideos(videos, { inCategory: 'cat1', videoCategoryMap });
      expect(filtered.length).toBe(2);
    });

    it('combines hasFunscript AND inCategory', () => {
      const videoCategoryMap = {
        '/v/alpha.mp4': ['cat1'],
        '/v/beta.mkv': ['cat1'],
        '/v/gamma.avi': ['cat1'],
      };
      const filtered = filterVideos(videos, {
        hasFunscript: true,
        inCategory: 'cat1',
        videoCategoryMap,
      });
      // Alpha (funscript + cat1) and Gamma (funscript + cat1), Beta has no funscript
      expect(filtered.length).toBe(2);
    });

    it('returns empty when no videos match', () => {
      const filtered = filterVideos(videos, {
        inPlaylist: 'pl1',
        playlistVideos: new Set(['/nonexistent']),
      });
      expect(filtered).toEqual([]);
    });

    it('returns empty for empty/null input', () => {
      expect(filterVideos([], { hasFunscript: true })).toEqual([]);
      expect(filterVideos(null, { hasFunscript: true })).toEqual([]);
    });

    it('ignores inPlaylist without playlistVideos set', () => {
      // No playlistVideos provided — filter is skipped
      const filtered = filterVideos(videos, { inPlaylist: 'pl1' });
      expect(filtered).toEqual(videos);
    });

    it('ignores inCategory without videoCategoryMap', () => {
      const filtered = filterVideos(videos, { inCategory: 'cat1' });
      expect(filtered).toEqual(videos);
    });
  });
});
