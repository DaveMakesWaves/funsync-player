import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as cache from '../../renderer/js/thumbnail-cache.js';

describe('thumbnail-cache', () => {
  beforeEach(() => {
    cache.clear();
  });

  describe('cacheKey', () => {
    it('generates key from path and mtime', () => {
      const key = cache.cacheKey('/v/test.mp4', 1000);
      expect(key).toBe('/v/test.mp4|1000');
    });

    it('different mtimes produce different keys', () => {
      const k1 = cache.cacheKey('/v/test.mp4', 1000);
      const k2 = cache.cacheKey('/v/test.mp4', 2000);
      expect(k1).not.toBe(k2);
    });
  });

  describe('get/set', () => {
    it('returns null on cache miss', () => {
      expect(cache.get('/v/test.mp4', 1000)).toBeNull();
    });

    it('returns data URL on cache hit', () => {
      cache.set('/v/test.mp4', 1000, 'data:image/jpeg;base64,abc');
      expect(cache.get('/v/test.mp4', 1000)).toBe('data:image/jpeg;base64,abc');
    });

    it('returns null for wrong mtime (file modified)', () => {
      cache.set('/v/test.mp4', 1000, 'data:image/jpeg;base64,abc');
      expect(cache.get('/v/test.mp4', 2000)).toBeNull();
    });

    it('returns null for null path', () => {
      expect(cache.get(null, 1000)).toBeNull();
    });

    it('does not store null path', () => {
      cache.set(null, 1000, 'data:url');
      expect(cache.size()).toBe(0);
    });

    it('does not store null dataUrl', () => {
      cache.set('/v/test.mp4', 1000, null);
      expect(cache.size()).toBe(0);
    });

    it('overwrites existing entry', () => {
      cache.set('/v/test.mp4', 1000, 'old');
      cache.set('/v/test.mp4', 1000, 'new');
      expect(cache.get('/v/test.mp4', 1000)).toBe('new');
      expect(cache.size()).toBe(1);
    });
  });

  describe('has', () => {
    it('returns false on miss', () => {
      expect(cache.has('/v/test.mp4', 1000)).toBe(false);
    });

    it('returns true on hit', () => {
      cache.set('/v/test.mp4', 1000, 'data:url');
      expect(cache.has('/v/test.mp4', 1000)).toBe(true);
    });

    it('returns false for wrong mtime', () => {
      cache.set('/v/test.mp4', 1000, 'data:url');
      expect(cache.has('/v/test.mp4', 2000)).toBe(false);
    });
  });

  describe('remove', () => {
    it('removes a specific entry', () => {
      cache.set('/v/a.mp4', 1000, 'data:a');
      cache.set('/v/b.mp4', 2000, 'data:b');
      cache.remove('/v/a.mp4', 1000);
      expect(cache.has('/v/a.mp4', 1000)).toBe(false);
      expect(cache.has('/v/b.mp4', 2000)).toBe(true);
    });

    it('no-op for non-existent entry', () => {
      cache.remove('/v/x.mp4', 9999);
      expect(cache.size()).toBe(0);
    });
  });

  describe('evictOlderThan', () => {
    it('does not evict recently cached entries with large maxAge', () => {
      cache.set('/v/recent.mp4', 100, 'data:recent');
      const evicted = cache.evictOlderThan(60000); // 60s — entry was just cached
      expect(evicted).toBe(0);
      expect(cache.size()).toBe(1);
    });

    it('preserves all entries with Infinity maxAge', () => {
      cache.set('/v/a.mp4', 1, 'a');
      cache.set('/v/b.mp4', 2, 'b');
      const evicted = cache.evictOlderThan(Infinity);
      expect(evicted).toBe(0);
      expect(cache.size()).toBe(2);
    });

    it('returns 0 for empty cache', () => {
      expect(cache.evictOlderThan(1000)).toBe(0);
    });
  });

  describe('size', () => {
    it('returns 0 for empty cache', () => {
      expect(cache.size()).toBe(0);
    });

    it('returns correct count', () => {
      cache.set('/v/a.mp4', 1, 'a');
      cache.set('/v/b.mp4', 2, 'b');
      expect(cache.size()).toBe(2);
    });
  });

  describe('clear', () => {
    it('removes all entries', () => {
      cache.set('/v/a.mp4', 1, 'a');
      cache.set('/v/b.mp4', 2, 'b');
      cache.clear();
      expect(cache.size()).toBe(0);
    });
  });

  describe('LRU bound (large-library memory guard)', () => {
    it('never grows past MAX_ENTRIES', () => {
      for (let i = 0; i < cache.MAX_ENTRIES + 250; i++) {
        cache.set(`/v/${i}.mp4`, 1, `data-${i}`);
      }
      expect(cache.size()).toBe(cache.MAX_ENTRIES);
    });

    it('evicts the least-recently-used entry first', () => {
      // Fill to the cap, then add one more — the very first insert should go.
      for (let i = 0; i < cache.MAX_ENTRIES; i++) {
        cache.set(`/v/${i}.mp4`, 1, `data-${i}`);
      }
      cache.set('/v/overflow.mp4', 1, 'overflow');
      expect(cache.get('/v/0.mp4', 1)).toBeNull();          // oldest evicted
      expect(cache.get('/v/overflow.mp4', 1)).toBe('overflow');
    });

    it('get() refreshes recency so a hot entry survives eviction', () => {
      for (let i = 0; i < cache.MAX_ENTRIES; i++) {
        cache.set(`/v/${i}.mp4`, 1, `data-${i}`);
      }
      // Touch the oldest so it becomes the newest.
      expect(cache.get('/v/0.mp4', 1)).toBe('data-0');
      // Next insert should now evict entry 1 (the new oldest), not entry 0.
      cache.set('/v/overflow.mp4', 1, 'overflow');
      expect(cache.get('/v/0.mp4', 1)).toBe('data-0');       // survived
      expect(cache.get('/v/1.mp4', 1)).toBeNull();           // evicted instead
    });
  });

  // --- Cross-view sharing (ProfKiwi, EroScripts #225) ------------------
  //
  // Thumbnails built up in the Library used to be invisible to the
  // Playlists and Categories views: only library.js imported this module,
  // so those two re-fetched every tile on each view switch. They now read
  // through the same cache, which only works because all three key on
  // mtime 0 — hence the explicit key-agreement test below.
  describe('getEntry — duration carried alongside the image', () => {
    it('returns dataUrl and duration together', () => {
      cache.set('/v/a.mp4', 0, 'data:image/jpeg;base64,AAA', 123.5);
      expect(cache.getEntry('/v/a.mp4', 0)).toEqual({
        dataUrl: 'data:image/jpeg;base64,AAA', duration: 123.5,
      });
    });

    it('reports duration 0 when none was stored', () => {
      cache.set('/v/b.mp4', 0, 'data:image/jpeg;base64,BBB');
      expect(cache.getEntry('/v/b.mp4', 0).duration).toBe(0);
    });

    it('does NOT erase a known duration when re-set without one', () => {
      // The playlists/categories views can cache a tile they fetched
      // without a duration. That must not wipe the duration the library
      // already stored, or the badge would vanish on the next view switch.
      cache.set('/v/c.mp4', 0, 'data:image/jpeg;base64,CCC', 42);
      cache.set('/v/c.mp4', 0, 'data:image/jpeg;base64,CCC');
      expect(cache.getEntry('/v/c.mp4', 0).duration).toBe(42);
    });

    it('ignores a non-finite or zero duration', () => {
      cache.set('/v/d.mp4', 0, 'data:image/jpeg;base64,DDD', NaN);
      expect(cache.getEntry('/v/d.mp4', 0).duration).toBe(0);
      cache.set('/v/e.mp4', 0, 'data:image/jpeg;base64,EEE', 0);
      expect(cache.getEntry('/v/e.mp4', 0).duration).toBe(0);
    });

    it('misses on a different mtime, like get()', () => {
      cache.set('/v/f.mp4', 0, 'data:image/jpeg;base64,FFF', 10);
      expect(cache.getEntry('/v/f.mp4', 99)).toBeNull();
      expect(cache.getEntry('', 0)).toBeNull();
    });
  });

  describe('get() keeps its string contract', () => {
    it('still returns a bare data URL, not the entry object', () => {
      // library.js has ~11 call sites expecting a string; getEntry was
      // added rather than changing this return type.
      cache.set('/v/g.mp4', 0, 'data:image/jpeg;base64,GGG', 7);
      expect(cache.get('/v/g.mp4', 0)).toBe('data:image/jpeg;base64,GGG');
    });
  });

  describe('all three views share one entry (mtime key 0)', () => {
    it('a tile cached under key 0 is readable by every view', () => {
      // If any view drifted to a different mtime key the sharing would
      // silently stop and each view would re-fetch again.
      cache.set('/v/shared.mp4', 0, 'data:image/jpeg;base64,SHARED', 60);
      expect(cache.get('/v/shared.mp4', 0)).toBe('data:image/jpeg;base64,SHARED');
      expect(cache.getEntry('/v/shared.mp4', 0).duration).toBe(60);
      // Library invalidation (custom thumb / pin change) clears it for all.
      cache.remove('/v/shared.mp4', 0);
      expect(cache.getEntry('/v/shared.mp4', 0)).toBeNull();
    });
  });
});
