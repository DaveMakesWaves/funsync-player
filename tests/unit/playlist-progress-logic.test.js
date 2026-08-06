/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Pure playlist-progress helpers — Continue targeting, summary counts,
// watched partitioning. Imports real source.
import { describe, it, expect } from 'vitest';
import {
  pickContinueTarget,
  summarisePlaylistProgress,
  partitionByWatched,
  formatRemaining,
} from '../../renderer/js/playlist-progress.js';

const LIST = ['a.mp4', 'b.mp4', 'c.mp4', 'd.mp4'];

const partWatched = (position = 600) => ({ position, duration: 3600, updatedAt: 1 });
const finished = () => ({ duration: 3600, updatedAt: 1, finished: true });

function entriesFrom(map) {
  return (path) => map[path] || null;
}

describe('pickContinueTarget', () => {
  it('resumes the marked video when it still has a position', () => {
    const entryOf = entriesFrom({ 'b.mp4': partWatched() });
    expect(pickContinueTarget(LIST, 'b.mp4', entryOf)).toEqual({
      path: 'b.mp4', index: 1, resume: true,
    });
  });

  it('skips PAST a finished marked video to the next unwatched', () => {
    // The gap this whole helper exists for: finishing something is the
    // clearest signal you are done with it, so Continue must not replay it.
    const entryOf = entriesFrom({ 'b.mp4': finished() });
    expect(pickContinueTarget(LIST, 'b.mp4', entryOf)).toEqual({
      path: 'c.mp4', index: 2, resume: false,
    });
  });

  it('skips a run of finished videos', () => {
    const entryOf = entriesFrom({
      'b.mp4': finished(), 'c.mp4': finished(),
    });
    expect(pickContinueTarget(LIST, 'b.mp4', entryOf).path).toBe('d.mp4');
  });

  it('wraps to the start when the tail is all watched', () => {
    const entryOf = entriesFrom({
      'c.mp4': finished(), 'd.mp4': finished(),
    });
    expect(pickContinueTarget(LIST, 'c.mp4', entryOf).path).toBe('a.mp4');
  });

  it('lands on a part-watched video ahead and flags it for resume', () => {
    const entryOf = entriesFrom({
      'b.mp4': finished(), 'c.mp4': partWatched(),
    });
    expect(pickContinueTarget(LIST, 'b.mp4', entryOf)).toEqual({
      path: 'c.mp4', index: 2, resume: true,
    });
  });

  it('plays a marked video that is simply unwatched, rather than skipping it', () => {
    // A marker can outlive its position: play past 10s (marker set,
    // position stored), seek back under 10s, stop (position cleared).
    // Continue must land on that video, not the one after it.
    expect(pickContinueTarget(LIST, 'b.mp4', () => null)).toEqual({
      path: 'b.mp4', index: 1, resume: false,
    });
  });

  it('picks the first unwatched when there is no marker', () => {
    const entryOf = entriesFrom({ 'a.mp4': finished() });
    expect(pickContinueTarget(LIST, null, entryOf).path).toBe('b.mp4');
  });

  it('advances rather than replaying when everything is watched', () => {
    const entryOf = entriesFrom({
      'a.mp4': finished(), 'b.mp4': finished(), 'c.mp4': finished(), 'd.mp4': finished(),
    });
    expect(pickContinueTarget(LIST, 'b.mp4', entryOf)).toEqual({
      path: 'c.mp4', index: 2, resume: false,
    });
  });

  it('wraps at the end when everything is watched', () => {
    const entryOf = entriesFrom({
      'a.mp4': finished(), 'b.mp4': finished(), 'c.mp4': finished(), 'd.mp4': finished(),
    });
    expect(pickContinueTarget(LIST, 'd.mp4', entryOf).path).toBe('a.mp4');
  });

  it('ignores a marker for a video no longer in the playlist', () => {
    const entryOf = entriesFrom({});
    expect(pickContinueTarget(LIST, 'gone.mp4', entryOf).path).toBe('a.mp4');
  });

  it('returns null for an empty playlist', () => {
    expect(pickContinueTarget([], 'a.mp4', () => null)).toBeNull();
    expect(pickContinueTarget(null, null, null)).toBeNull();
  });
});

describe('summarisePlaylistProgress', () => {
  const durationOf = () => 3600;

  it('counts watched, in-progress and total', () => {
    const entryOf = entriesFrom({
      'a.mp4': finished(), 'b.mp4': finished(), 'c.mp4': partWatched(),
    });
    const s = summarisePlaylistProgress(LIST, entryOf, durationOf);
    expect(s.watched).toBe(2);
    expect(s.inProgress).toBe(1);
    expect(s.total).toBe(4);
  });

  it('counts only the UNPLAYED tail of a part-watched video', () => {
    // c is 600s into 3600s → 3000s left, plus d's full 3600s.
    const entryOf = entriesFrom({
      'a.mp4': finished(), 'b.mp4': finished(), 'c.mp4': partWatched(600),
    });
    expect(summarisePlaylistProgress(LIST, entryOf, durationOf).remainingSeconds)
      .toBe(3000 + 3600);
  });

  it('excludes watched videos from the time remaining', () => {
    const entryOf = entriesFrom({ 'a.mp4': finished() });
    expect(summarisePlaylistProgress(LIST, entryOf, durationOf).remainingSeconds)
      .toBe(3 * 3600);
  });

  it('counts an unknown-duration video toward totals but not toward time', () => {
    const s = summarisePlaylistProgress(['x.mp4'], () => null, () => 0);
    expect(s.total).toBe(1);
    expect(s.watched).toBe(0);
    expect(s.remainingSeconds).toBe(0);
  });

  it('falls back to the duration stored on the entry', () => {
    const entryOf = entriesFrom({ 'x.mp4': partWatched(600) });
    // Live duration unknown → stored 3600 used → 3000 remaining.
    expect(summarisePlaylistProgress(['x.mp4'], entryOf, () => 0).remainingSeconds)
      .toBe(3000);
  });

  it('handles an empty playlist', () => {
    expect(summarisePlaylistProgress([], () => null, () => 0)).toEqual({
      watched: 0, inProgress: 0, total: 0, remainingSeconds: 0, unavailable: 0,
    });
  });
});

describe('partitionByWatched', () => {
  it('puts unwatched first, keeping input order within each half', () => {
    const entryOf = entriesFrom({ 'a.mp4': finished(), 'c.mp4': finished() });
    expect(partitionByWatched(LIST, entryOf)).toEqual({
      unwatched: ['b.mp4', 'd.mp4'],
      watched: ['a.mp4', 'c.mp4'],
    });
  });

  it('keeps watched items rather than dropping them (a marathon must still play)', () => {
    const entryOf = entriesFrom({
      'a.mp4': finished(), 'b.mp4': finished(), 'c.mp4': finished(), 'd.mp4': finished(),
    });
    const { unwatched, watched } = partitionByWatched(LIST, entryOf);
    expect(unwatched).toEqual([]);
    expect(watched).toHaveLength(4);
  });

  it('treats a part-watched video as unwatched', () => {
    const entryOf = entriesFrom({ 'a.mp4': partWatched() });
    expect(partitionByWatched(LIST, entryOf).unwatched).toContain('a.mp4');
  });
});

describe('formatRemaining', () => {
  it('formats hours and minutes', () => {
    expect(formatRemaining(8100)).toBe('2h 15m');
    expect(formatRemaining(3600)).toBe('1h');
    expect(formatRemaining(2700)).toBe('45m');
  });

  it('carries rounded minutes instead of printing 60m', () => {
    // 1h 59m 45s rounds the minutes to 60 — must read 2h, not "1h 60m".
    expect(formatRemaining(7185)).toBe('2h');
  });

  it('floors sub-minute remainders to a coarse label', () => {
    expect(formatRemaining(30)).toBe('< 1m');
  });

  it('returns null when there is nothing left, so callers render nothing', () => {
    expect(formatRemaining(0)).toBeNull();
    expect(formatRemaining(-5)).toBeNull();
    expect(formatRemaining(NaN)).toBeNull();
  });
});

describe('partitionByWatched with a key extractor', () => {
  it('partitions objects via pathOf, keeping the objects themselves', () => {
    // app.js shuffles queue ITEMS (objects with .path), not bare paths.
    const items = [{ path: 'a.mp4' }, { path: 'b.mp4' }, { path: 'c.mp4' }];
    const entryOf = (p) => (p === 'b.mp4' ? { finished: true } : null);
    const { unwatched, watched } = partitionByWatched(items, entryOf, (v) => v.path);
    expect(unwatched).toEqual([{ path: 'a.mp4' }, { path: 'c.mp4' }]);
    expect(watched).toEqual([{ path: 'b.mp4' }]);
  });

  it('defaults to identity so bare-path callers are unaffected', () => {
    const entryOf = (p) => (p === 'a.mp4' ? { finished: true } : null);
    expect(partitionByWatched(['a.mp4', 'b.mp4'], entryOf).watched).toEqual(['a.mp4']);
  });
});

describe('short-clip playlists (endThreshold floor regression)', () => {
  it('does not report a freshly-loaded short clip as watched', () => {
    // A 20s loop at position 0 must not summarise as watched.
    const s = summarisePlaylistProgress(['loop.mp4'], () => null, () => 20);
    expect(s.watched).toBe(0);
    expect(s.remainingSeconds).toBe(20);
  });
});
