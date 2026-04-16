// ThumbnailCache — In-memory cache for video thumbnail data URLs
// Keyed by video path + modification time to detect stale entries

/**
 * @typedef {Object} CacheEntry
 * @property {string} dataUrl — thumbnail data URL (image/jpeg)
 * @property {number} mtime — file modification time (ms since epoch)
 * @property {number} cachedAt — when this entry was cached (ms since epoch)
 */

/** @type {Map<string, CacheEntry>} */
const _cache = new Map();

/**
 * Generate a cache key from a video path and modification time.
 * @param {string} videoPath
 * @param {number} mtime — file modification time in ms
 * @returns {string}
 */
export function cacheKey(videoPath, mtime) {
  return `${videoPath}|${mtime}`;
}

/**
 * Get a cached thumbnail data URL.
 * Returns null on cache miss or if the file has been modified since caching.
 *
 * @param {string} videoPath
 * @param {number} mtime — current file modification time in ms
 * @returns {string|null} data URL or null
 */
export function get(videoPath, mtime) {
  if (!videoPath) return null;

  const key = cacheKey(videoPath, mtime);
  const entry = _cache.get(key);
  if (!entry) return null;

  // Validate mtime matches (double-check against stale key collisions)
  if (entry.mtime !== mtime) return null;

  return entry.dataUrl;
}

/**
 * Store a thumbnail data URL in the cache.
 *
 * @param {string} videoPath
 * @param {number} mtime — file modification time in ms
 * @param {string} dataUrl — thumbnail data URL
 */
export function set(videoPath, mtime, dataUrl) {
  if (!videoPath || !dataUrl) return;

  const key = cacheKey(videoPath, mtime);
  _cache.set(key, {
    dataUrl,
    mtime,
    cachedAt: Date.now(),
  });
}

/**
 * Check if a thumbnail is cached for the given path and mtime.
 *
 * @param {string} videoPath
 * @param {number} mtime
 * @returns {boolean}
 */
export function has(videoPath, mtime) {
  return get(videoPath, mtime) !== null;
}

/**
 * Remove a specific cache entry.
 * @param {string} videoPath
 * @param {number} mtime
 */
export function remove(videoPath, mtime) {
  _cache.delete(cacheKey(videoPath, mtime));
}

/**
 * Evict entries older than the given threshold.
 * @param {number} maxAgeMs — max age in milliseconds (e.g. 24 * 60 * 60 * 1000 for 1 day)
 * @returns {number} number of entries evicted
 */
export function evictOlderThan(maxAgeMs) {
  const cutoff = Date.now() - maxAgeMs;
  let evicted = 0;

  for (const [key, entry] of _cache) {
    if (entry.cachedAt < cutoff) {
      _cache.delete(key);
      evicted++;
    }
  }

  return evicted;
}

/**
 * Get the number of entries in the cache.
 * @returns {number}
 */
export function size() {
  return _cache.size;
}

/**
 * Clear all cached thumbnails.
 */
export function clear() {
  _cache.clear();
}
