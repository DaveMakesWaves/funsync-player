// In-flight thumbnail request dedup (startup perf, 2026-08-03).
//
// Grid rebuilds reset cards' loaded state while their first backend
// request is still flying — the same video got POSTed 2-7× during
// startup. Concurrent captures for one path must share ONE promise;
// settled entries must clear so later captures fetch fresh (e.g. after
// a custom-thumbnail change invalidates the cache).
//
// NOTE: the dedup map is module-level (shared across the suite), so every
// test uses its own unique key and always settles what it starts.

import { describe, it, expect, vi } from 'vitest';
import { dedupeThumbRequest, inflightCount } from '../../renderer/js/thumb-inflight.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('dedupeThumbRequest', () => {
  it('concurrent calls for the same key share one invocation and one result', async () => {
    const d = deferred();
    const fn = vi.fn(() => d.promise);
    const p1 = dedupeThumbRequest('share.mp4', fn);
    const p2 = dedupeThumbRequest('share.mp4', fn);
    expect(p1).toBe(p2);
    await Promise.resolve(); // fn is invoked on a microtask
    expect(fn).toHaveBeenCalledTimes(1);
    d.resolve({ dataUrl: 'data:x' });
    await expect(p1).resolves.toEqual({ dataUrl: 'data:x' });
    await expect(p2).resolves.toEqual({ dataUrl: 'data:x' });
  });

  it('different keys run independently', async () => {
    const fn = vi.fn(async () => 'r');
    await Promise.all([
      dedupeThumbRequest('indep-a.mp4', fn),
      dedupeThumbRequest('indep-b.mp4', fn),
    ]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('re-invokes after the previous request settles (no stale memoisation)', async () => {
    // A custom-thumbnail change clears the cache and re-captures — the
    // second capture must actually run, not serve the settled promise.
    const fn = vi.fn(async () => 'r');
    await dedupeThumbRequest('reinvoke.mp4', fn);
    await tick(); // let the .finally() cleanup run
    await dedupeThumbRequest('reinvoke.mp4', fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('propagates rejection to every waiter and clears for retry', async () => {
    const d = deferred();
    const failing = vi.fn(() => d.promise);
    const p1 = dedupeThumbRequest('fail.mp4', failing);
    const p2 = dedupeThumbRequest('fail.mp4', failing);
    d.reject(new Error('boom'));
    await expect(p1).rejects.toThrow('boom');
    await expect(p2).rejects.toThrow('boom');
    await tick(); // let the .finally() cleanup run
    // Entry cleared — a retry invokes again.
    const ok = vi.fn(async () => 'recovered');
    await expect(dedupeThumbRequest('fail.mp4', ok)).resolves.toBe('recovered');
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('tracks and clears the in-flight count', async () => {
    const before = inflightCount();
    const d = deferred();
    const p = dedupeThumbRequest('count.mp4', () => d.promise);
    expect(inflightCount()).toBe(before + 1);
    d.resolve(null);
    await p;
    await tick(); // finally() cleanup runs post-resolution
    expect(inflightCount()).toBe(before);
  });
});
