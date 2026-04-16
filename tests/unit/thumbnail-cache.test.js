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
});
