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

    // New tier-0 (exact title) behaviour — regression guard for the
    // "typing the exact title doesn't put it first" bug.
    describe('exact-title precedence', () => {
      const realWorld = [
        { name: 'Klixen HJ177a.mp4', path: '/v/a.mp4', hasFunscript: true },
        { name: 'Klixen HJ177b Shoot Into My Mouth (Part A).mp4', path: '/v/b.mp4', hasFunscript: true },
        { name: 'Klixen HJ177b Shoot Into My Mouth (Part B).mp4', path: '/v/c.mp4', hasFunscript: true },
        { name: 'Klixen HJ177c.mp4', path: '/v/d.mp4', hasFunscript: true },
      ];

      it('puts exact title first when query matches filename verbatim', () => {
        const q = 'Klixen HJ177b Shoot Into My Mouth (Part B).mp4';
        const results = fuzzySearch(realWorld, q);
        expect(results[0].name).toBe('Klixen HJ177b Shoot Into My Mouth (Part B).mp4');
      });

      it('puts exact title first when query omits the extension', () => {
        const q = 'Klixen HJ177b Shoot Into My Mouth (Part B)';
        const results = fuzzySearch(realWorld, q);
        expect(results[0].name).toBe('Klixen HJ177b Shoot Into My Mouth (Part B).mp4');
      });

      it('beats shorter filename that is a substring of the query', () => {
        const vids = [
          { name: 'alpha.mp4', path: '/a' },
          { name: 'alpha video full.mp4', path: '/b' },
        ];
        // Without tier-0, "alpha.mp4" (shorter) can sort first alphabetically.
        const results = fuzzySearch(vids, 'alpha video full');
        expect(results[0].name).toBe('alpha video full.mp4');
      });
    });

    describe('path search', () => {
      it('finds a video by folder name even when not in filename', () => {
        const vids = [
          { name: 'clip.mp4', path: '/media/Klixen/clip.mp4' },
          { name: 'other.mp4', path: '/media/Misc/other.mp4' },
        ];
        const results = fuzzySearch(vids, 'klixen');
        expect(results.length).toBe(1);
        expect(results[0].name).toBe('clip.mp4');
      });

      it('ranks name match above path-only match', () => {
        const vids = [
          { name: 'other clip.mp4', path: '/media/Klixen/other clip.mp4' },
          { name: 'klixen promo.mp4', path: '/media/Misc/klixen promo.mp4' },
        ];
        const results = fuzzySearch(vids, 'klixen');
        expect(results[0].name).toBe('klixen promo.mp4');
        expect(results[1].name).toBe('other clip.mp4');
      });

      it('can be disabled via searchPaths: false', () => {
        const vids = [{ name: 'clip.mp4', path: '/media/Klixen/clip.mp4' }];
        const results = fuzzySearch(vids, 'klixen', { searchPaths: false });
        expect(results.length).toBe(0);
      });
    });

    describe('context map', () => {
      it('matches videos by collection / category name', () => {
        const vids = [
          { name: 'clip.mp4', path: '/a' },
          { name: 'film.mp4', path: '/b' },
        ];
        const contextMap = new Map([
          ['/a', ['Klixen Pack']],
        ]);
        const results = fuzzySearch(vids, 'klixen pack', { contextMap });
        expect(results.length).toBe(1);
        expect(results[0].name).toBe('clip.mp4');
      });

      it('accepts a plain object as contextMap', () => {
        const vids = [{ name: 'clip.mp4', path: '/a' }];
        const results = fuzzySearch(vids, 'favorites', { contextMap: { '/a': ['Favorites'] } });
        expect(results.length).toBe(1);
      });

      it('ranks name > path > context', () => {
        const vids = [
          { name: 'klixen in name.mp4', path: '/a' },
          { name: 'plain.mp4', path: '/media/klixen/plain.mp4' },
          { name: 'contextonly.mp4', path: '/elsewhere/ctx.mp4' },
        ];
        const contextMap = new Map([['/elsewhere/ctx.mp4', ['Klixen Collection']]]);
        const results = fuzzySearch(vids, 'klixen', { contextMap });
        expect(results[0].name).toBe('klixen in name.mp4');
        expect(results[1].name).toBe('plain.mp4');
        expect(results[2].name).toBe('contextonly.mp4');
      });
    });

    describe('ranking survives mixed result sets', () => {
      it('exact match beats alphabetically-earlier partial matches', () => {
        const vids = [
          { name: 'A Klixen Test.mp4', path: '/a' },
          { name: 'B Klixen Test.mp4', path: '/b' },
          { name: 'Klixen Exact.mp4', path: '/c' },
        ];
        const results = fuzzySearch(vids, 'Klixen Exact.mp4');
        expect(results[0].name).toBe('Klixen Exact.mp4');
      });
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

    it('sorts by dateAdded descending (recently added first)', () => {
      const vids = [
        { name: 'old.mp4',    path: '/a', hasFunscript: false, dateAdded: 1000 },
        { name: 'newest.mp4', path: '/b', hasFunscript: false, dateAdded: 5000 },
        { name: 'middle.mp4', path: '/c', hasFunscript: false, dateAdded: 3000 },
      ];
      const sorted = sortVideos(vids, 'dateAdded', 'desc');
      expect(sorted[0].name).toBe('newest.mp4');
      expect(sorted[1].name).toBe('middle.mp4');
      expect(sorted[2].name).toBe('old.mp4');
    });

    it('sorts by dateAdded ascending (oldest first)', () => {
      const vids = [
        { name: 'old.mp4',    path: '/a', hasFunscript: false, dateAdded: 1000 },
        { name: 'newest.mp4', path: '/b', hasFunscript: false, dateAdded: 5000 },
      ];
      const sorted = sortVideos(vids, 'dateAdded', 'asc');
      expect(sorted[0].name).toBe('old.mp4');
      expect(sorted[1].name).toBe('newest.mp4');
    });

    it('dateAdded treats missing values as 0 (sort to oldest end)', () => {
      const vids = [
        { name: 'has-date.mp4', path: '/a', hasFunscript: false, dateAdded: 5000 },
        { name: 'no-date.mp4',  path: '/b', hasFunscript: false },  // missing
      ];
      const sorted = sortVideos(vids, 'dateAdded', 'desc');
      expect(sorted[0].name).toBe('has-date.mp4');
      expect(sorted[1].name).toBe('no-date.mp4');
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
