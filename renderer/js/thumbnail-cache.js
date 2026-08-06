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

// Hard cap on retained thumbnails. Each entry is a base64 data URL
// (~15–40 KB for a 320px JPEG). Without a cap the cache grew unbounded as
// the user scrolled a large library — thousands of entries × tens of KB
// exhausted renderer memory and the app "stopped working" (community report,
// large multi-drive libraries). 600 entries ≈ 12–24 MB, comfortably more
// than any viewport needs; evicted thumbnails re-fetch from the backend's
// on-disk cache (near-free). Map preserves insertion order, so the oldest
// key is always at the front — get() re-inserts to make this a true LRU.
export const MAX_ENTRIES = 600;

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
  const entry = getEntry(videoPath, mtime);
  return entry ? entry.dataUrl : null;
}

/**
 * Get the whole cached entry, including the video duration when one was
 * stored with it.
 *
 * `get()` deliberately still returns just the data URL — it has a dozen
 * call sites in library.js that expect a string. This exists because the
 * playlists and categories views render a duration badge from the same
 * capture result: without the duration, a cache hit would draw the tile but
 * silently drop its badge, so cached tiles would look different from
 * freshly-fetched ones.
 *
 * @param {string} videoPath
 * @param {number} mtime — current file modification time in ms
 * @returns {{dataUrl: string, duration: number}|null}
 */
export function getEntry(videoPath, mtime) {
  if (!videoPath) return null;

  const key = cacheKey(videoPath, mtime);
  const entry = _cache.get(key);
  if (!entry) return null;

  // Validate mtime matches (double-check against stale key collisions)
  if (entry.mtime !== mtime) return null;

  // LRU touch — move to the newest position so hot (on-screen) thumbnails
  // survive eviction while stale off-screen ones age out.
  _cache.delete(key);
  _cache.set(key, entry);

  return { dataUrl: entry.dataUrl, duration: entry.duration || 0 };
}

/**
 * Store a thumbnail data URL in the cache.
 *
 * @param {string} videoPath
 * @param {number} mtime — file modification time in ms
 * @param {string} dataUrl — thumbnail data URL
 * @param {number} [duration] — video duration in seconds, when the capture
 *   reported one. Stored so the playlists/categories duration badge survives
 *   a cache hit (see getEntry).
 */
export function set(videoPath, mtime, dataUrl, duration) {
  if (!videoPath || !dataUrl) return;

  const key = cacheKey(videoPath, mtime);
  // Preserve a previously-stored duration when a later write doesn't carry
  // one, so re-caching from a view that has no duration can't erase it.
  const prev = _cache.get(key);
  const dur = Number.isFinite(duration) && duration > 0
    ? duration
    : (prev && prev.mtime === mtime ? prev.duration : undefined);
  // Refresh LRU position on re-set so the newest write is treated as hot.
  if (_cache.has(key)) _cache.delete(key);
  _cache.set(key, {
    dataUrl,
    duration: dur,
    mtime,
    cachedAt: Date.now(),
  });
  // Evict the least-recently-used entries (front of insertion order) once
  // over the cap. Bounds renderer memory regardless of library size.
  while (_cache.size > MAX_ENTRIES) {
    const oldestKey = _cache.keys().next().value;
    _cache.delete(oldestKey);
  }
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
