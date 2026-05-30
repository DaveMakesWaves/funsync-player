// Queue panel data model — history append/cap/dedup/threshold, user
// queue mutations, upcoming derivation.
//
// These tests target the pure / data-shaped contracts in app.js without
// instantiating the full App class (which needs Electron, the DOM, etc.).
// The contracts are simple enough to verify by stubbing the relevant
// methods or testing the algorithms directly.

import { describe, it, expect } from 'vitest';

// --- History semantics (SCOPE-queue-panel.md §3.5) ---

describe('Queue history — append + dedup + cap', () => {
  // Reproduces the in-line logic from App._maybePushCurrentToHistory.
  // Kept here as a pure function so the algorithm can be exercised
  // without booting the full app.
  function pushToHistory(history, path, cap = 50) {
    const next = history.filter((p) => p !== path);
    next.push(path);
    if (next.length > cap) return next.slice(-cap);
    return next;
  }

  it('appends new paths to the end', () => {
    expect(pushToHistory([], 'a.mp4')).toEqual(['a.mp4']);
    expect(pushToHistory(['a.mp4'], 'b.mp4')).toEqual(['a.mp4', 'b.mp4']);
  });

  it('dedups: replaying a path removes the earlier entry and appends', () => {
    expect(pushToHistory(['a.mp4', 'b.mp4'], 'a.mp4')).toEqual(['b.mp4', 'a.mp4']);
  });

  it('preserves insertion order across many ops', () => {
    let h = [];
    h = pushToHistory(h, 'a');
    h = pushToHistory(h, 'b');
    h = pushToHistory(h, 'c');
    h = pushToHistory(h, 'b');  // b re-appears at end
    expect(h).toEqual(['a', 'c', 'b']);
  });

  it('caps from the front when the list exceeds cap', () => {
    let h = [];
    for (let i = 0; i < 60; i++) h = pushToHistory(h, `v${i}.mp4`, 50);
    expect(h.length).toBe(50);
    expect(h[0]).toBe('v10.mp4');           // oldest 10 dropped
    expect(h[h.length - 1]).toBe('v59.mp4'); // newest preserved
  });

  it('cap of 1 keeps only the most recent', () => {
    let h = [];
    h = pushToHistory(h, 'a', 1);
    h = pushToHistory(h, 'b', 1);
    h = pushToHistory(h, 'c', 1);
    expect(h).toEqual(['c']);
  });
});

// --- 5-second threshold (SCOPE §3.5) ---

describe('History threshold — 5 second watch minimum', () => {
  // App._maybePushCurrentToHistory checks video.currentTime * 1000
  // against this._queueHistoryThresholdMs. Reproduced as a simple gate.
  function shouldPush(watchedMs, thresholdMs = 5000) {
    return watchedMs >= thresholdMs;
  }

  it('skips push when watched < threshold', () => {
    expect(shouldPush(0)).toBe(false);
    expect(shouldPush(4999)).toBe(false);
  });

  it('pushes at exactly threshold', () => {
    expect(shouldPush(5000)).toBe(true);
  });

  it('pushes when watched > threshold', () => {
    expect(shouldPush(10000)).toBe(true);
  });
});

// --- User queue mutations (SCOPE §3.2 #3) ---

describe('User queue — add, remove, reorder, clear', () => {
  function addToQueue(queue, path, position = 'end') {
    if (queue.includes(path)) return queue;  // dedup
    if (position === 'next') return [path, ...queue];
    return [...queue, path];
  }
  function removeFromQueue(queue, path) {
    return queue.filter((p) => p !== path);
  }
  function reorder(queue, fromIdx, toIdx) {
    if (fromIdx === toIdx) return queue;
    if (fromIdx < 0 || fromIdx >= queue.length) return queue;
    if (toIdx < 0 || toIdx >= queue.length) return queue;
    const arr = [...queue];
    const [moved] = arr.splice(fromIdx, 1);
    arr.splice(toIdx, 0, moved);
    return arr;
  }

  it('add appends to end by default', () => {
    expect(addToQueue([], 'a.mp4')).toEqual(['a.mp4']);
    expect(addToQueue(['a.mp4'], 'b.mp4')).toEqual(['a.mp4', 'b.mp4']);
  });

  it('add with position="next" inserts at head', () => {
    expect(addToQueue(['a.mp4'], 'b.mp4', 'next')).toEqual(['b.mp4', 'a.mp4']);
    expect(addToQueue(['a.mp4', 'b.mp4'], 'c.mp4', 'next'))
      .toEqual(['c.mp4', 'a.mp4', 'b.mp4']);
  });

  it('add refuses duplicates regardless of position', () => {
    expect(addToQueue(['a.mp4'], 'a.mp4')).toEqual(['a.mp4']);
    expect(addToQueue(['a.mp4'], 'a.mp4', 'next')).toEqual(['a.mp4']);
  });

  it('remove drops the path', () => {
    expect(removeFromQueue(['a.mp4', 'b.mp4'], 'a.mp4')).toEqual(['b.mp4']);
    expect(removeFromQueue(['a.mp4'], 'b.mp4')).toEqual(['a.mp4']);  // no-op
  });

  it('reorder moves an item from one position to another', () => {
    expect(reorder(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(reorder(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(reorder(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c']);   // no-op
  });

  it('reorder is a no-op for out-of-bounds indices', () => {
    expect(reorder(['a', 'b'], -1, 0)).toEqual(['a', 'b']);
    expect(reorder(['a', 'b'], 0, 99)).toEqual(['a', 'b']);
  });
});

// --- Upcoming derivation (SCOPE §3.2 #4 + §3.4) ---

describe('Upcoming derivation — playlist vs library context', () => {
  // App._getUpcoming() returns up to 10 items from whichever context
  // is driving playback. Reproduced here as pure functions for testing.

  function upcomingFromPlayQueue(playQueue, playQueueIndex) {
    const idx = (playQueueIndex ?? -1) + 1;
    return playQueue.slice(idx, idx + 10).map((entry) => entry?.path || entry).filter(Boolean);
  }

  function upcomingFromLibrary(filteredVideos, currentPath) {
    if (!filteredVideos || !currentPath) return [];
    const idx = filteredVideos.findIndex((v) => v?.path === currentPath);
    if (idx < 0) return [];
    return filteredVideos.slice(idx + 1, idx + 11).map((v) => v.path);
  }

  it('playlist context returns remaining queue items, capped at 10', () => {
    const queue = Array.from({ length: 15 }, (_, i) => ({ path: `v${i}.mp4` }));
    const out = upcomingFromPlayQueue(queue, 2);  // currently at index 2
    expect(out.length).toBe(10);
    expect(out[0]).toBe('v3.mp4');     // first item after current
    expect(out[9]).toBe('v12.mp4');    // 10th forward
  });

  it('playlist context near end returns short list', () => {
    const queue = Array.from({ length: 5 }, (_, i) => ({ path: `v${i}.mp4` }));
    const out = upcomingFromPlayQueue(queue, 3);
    expect(out).toEqual(['v4.mp4']);
  });

  it('playlist context past end returns empty', () => {
    const queue = [{ path: 'a.mp4' }];
    expect(upcomingFromPlayQueue(queue, 0)).toEqual([]);
    expect(upcomingFromPlayQueue(queue, 99)).toEqual([]);
  });

  it('library context returns next 10 by filter/sort order', () => {
    const filtered = Array.from({ length: 20 }, (_, i) => ({ path: `v${i}.mp4` }));
    const out = upcomingFromLibrary(filtered, 'v5.mp4');
    expect(out.length).toBe(10);
    expect(out[0]).toBe('v6.mp4');
    expect(out[9]).toBe('v15.mp4');
  });

  it('library context with current at end returns empty', () => {
    const filtered = [{ path: 'a.mp4' }, { path: 'b.mp4' }];
    expect(upcomingFromLibrary(filtered, 'b.mp4')).toEqual([]);
  });

  it('library context with current not in filtered list returns empty', () => {
    // Happens after a filter change that excludes the current video.
    // Per SCOPE §3.4, history is preserved but upcoming derives from
    // current filter — if current falls outside the filter, upcoming
    // is empty until the user picks a new video.
    const filtered = [{ path: 'a.mp4' }, { path: 'b.mp4' }];
    expect(upcomingFromLibrary(filtered, 'c.mp4')).toEqual([]);
  });

  it('library context with null current returns empty', () => {
    const filtered = [{ path: 'a.mp4' }];
    expect(upcomingFromLibrary(filtered, null)).toEqual([]);
  });

  it('library context with no filtered list returns empty', () => {
    expect(upcomingFromLibrary(null, 'a.mp4')).toEqual([]);
    expect(upcomingFromLibrary(undefined, 'a.mp4')).toEqual([]);
  });
});

// --- Queue priority over Play All / library on auto-advance ---

describe('Auto-advance priority — user queue first', () => {
  // The Play All ended listener and _playUpNext both check the user
  // queue first per SCOPE §3.2 #3 (foobar2000 priority insert).
  // Reproduced as pure logic to validate the precedence.

  function nextOnAdvance(userQueue, fallback) {
    if (userQueue.length > 0) {
      return { source: 'user-queue', value: userQueue[0] };
    }
    if (fallback) return { source: 'fallback', value: fallback };
    return null;
  }

  it('user queue head wins when non-empty', () => {
    expect(nextOnAdvance(['a.mp4'], 'b.mp4'))
      .toEqual({ source: 'user-queue', value: 'a.mp4' });
  });

  it('falls back when user queue is empty', () => {
    expect(nextOnAdvance([], 'b.mp4'))
      .toEqual({ source: 'fallback', value: 'b.mp4' });
  });

  it('returns null when both are empty', () => {
    expect(nextOnAdvance([], null)).toBe(null);
  });
});
