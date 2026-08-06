// Shared in-flight deduplication for thumbnail capture requests.
//
// Grid rebuilds (duration hydration → _applyFilters → innerHTML='') reset
// cards' loaded state while their first request is still flying, so the
// same video got POSTed to the backend 2-7× during startup (session log,
// 2026-08-03). Any concurrent capture for the same video now shares ONE
// promise; the map entry clears on settle so later captures (e.g. after a
// custom-thumbnail change cleared the cache) fetch fresh.
//
// The map is MODULE-LEVEL on purpose: library, playlists, categories and
// the Up Next resolver all request the same shape ({dataUrl, duration} at
// 320px), so cross-component concurrent requests dedupe too.

/** @type {Map<string, Promise<any>>} */
const _inflight = new Map();

/**
 * Run `fn` once per key at a time: concurrent calls with the same key get
 * the same promise. Rejections propagate to every waiter and clear the
 * entry (so the next call retries).
 *
 * @param {string} key — video path
 * @param {() => Promise<any>} fn — the actual capture
 * @returns {Promise<any>}
 */
export function dedupeThumbRequest(key, fn) {
  const existing = _inflight.get(key);
  if (existing) return existing;
  const p = Promise.resolve().then(fn).finally(() => { _inflight.delete(key); });
  _inflight.set(key, p);
  return p;
}

/** Number of captures currently in flight (diagnostics/tests). */
export function inflightCount() {
  return _inflight.size;
}
