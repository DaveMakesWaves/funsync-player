/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Up Next offered a video from a source the user had removed.
//
// `_playContext.list` is a SNAPSHOT of absolute paths taken when playback
// started, and nothing revalidates it. Remove a source mid-session and its
// paths stay in the snapshot. Welliambrisk's log (2026-08-27) caught it side
// on: a single thumbnail request for `F:\Horn\OTHER\[Arg] - Daisuki.mp4` at
// 15:26:12, three minutes after the only library scan, for a folder that
// appears nowhere else in the log — the Up Next card fetching a poster for a
// file that was no longer in the library.
//
// The rule these pin: skip forward past what the library no longer has, but
// treat "I don't know" as playable, because a false negative here silently
// kills the card and that is a far more visible regression than the stale
// entry it exists to skip.
import { describe, it, expect, vi } from 'vitest';
import { UpNextEngine } from '../../renderer/js/up-next.js';

function makeEngine(list, index, { loop = false } = {}) {
  const engine = new UpNextEngine({
    videoPlayer: { currentTime: 0, paused: false, duration: 120, ended: false },
    funscriptEngine: { isLoaded: false, getActions: () => [] },
  });
  engine.setPlayContext({
    source: 'library', sourceLabel: 'library', sourceContext: {}, list, index, loop,
  });
  return engine;
}

const LIST = ['a.mp4', 'F:/removed/Daisuki.mp4', 'c.mp4'];

describe('Up Next skips videos the library no longer has', () => {
  it('walks past a removed-source entry to the next real one', () => {
    const engine = makeEngine(LIST, 0);
    engine.isPlayable = (p) => !p.startsWith('F:/removed/');
    expect(engine._nextPath()).toBe('c.mp4');
  });

  it('offers the stale entry when no predicate is wired at all', () => {
    // Pins the default: the engine is used elsewhere (pop-out, remote) where
    // no library is available, and it must keep working there.
    const engine = makeEngine(LIST, 0);
    expect(engine._nextPath()).toBe('F:/removed/Daisuki.mp4');
  });

  it('reports end-of-list when everything after the current item is gone', () => {
    const engine = makeEngine(['a.mp4', 'F:/removed/x.mp4', 'F:/removed/y.mp4'], 0);
    engine.isPlayable = (p) => !p.startsWith('F:/removed/');
    expect(engine._nextPath()).toBeNull();
    expect(engine._isLastInList()).toBe(true);
  });

  it('is still last-in-list by the ordinary rule when nothing is missing', () => {
    const engine = makeEngine(['a.mp4', 'b.mp4'], 1);
    engine.isPlayable = () => true;
    expect(engine._nextPath()).toBeNull();
    expect(engine._isLastInList()).toBe(true);
  });

  it('is NOT last-in-list when a playable item follows', () => {
    const engine = makeEngine(['a.mp4', 'b.mp4'], 0);
    engine.isPlayable = () => true;
    expect(engine._isLastInList()).toBe(false);
  });
});

describe('loop mode wraps past missing entries without spinning', () => {
  it('wraps to the first PLAYABLE item, not blindly to index 0', () => {
    const engine = makeEngine(['F:/removed/first.mp4', 'b.mp4', 'c.mp4'], 2, { loop: true });
    engine.isPlayable = (p) => !p.startsWith('F:/removed/');
    expect(engine._nextPath()).toBe('b.mp4');
  });

  it('terminates when every entry is missing', () => {
    const engine = makeEngine(['F:/x/1.mp4', 'F:/x/2.mp4'], 1, { loop: true });
    engine.isPlayable = () => false;
    expect(engine._nextPath()).toBeNull();
    expect(engine._isLastInList()).toBe(true);
  });
});

describe('unknown counts as playable', () => {
  it('does not suppress the card when the predicate throws', () => {
    const engine = makeEngine(LIST, 0);
    engine.isPlayable = () => { throw new Error('library still scanning'); };
    expect(engine._nextPath()).toBe('F:/removed/Daisuki.mp4');
  });

  it('treats a non-boolean return as playable', () => {
    const engine = makeEngine(LIST, 0);
    engine.isPlayable = () => undefined;
    expect(engine._nextPath()).toBe('F:/removed/Daisuki.mp4');
  });
});

describe('the user queue is never filtered', () => {
  it('offers a queued item even when the library does not have it', () => {
    // An explicit queue insert is the user's own choice, visible to them in
    // the queue panel. Silently skipping it would be a worse surprise than
    // failing to open it.
    const engine = makeEngine(LIST, 0);
    engine.isPlayable = () => false;
    engine.getPriorityNext = () => 'F:/removed/queued-by-hand.mp4';
    expect(engine._nextPath()).toBe('F:/removed/queued-by-hand.mp4');
    expect(engine._isLastInList()).toBe(false);
  });
});

describe('the predicate is consulted, not assumed', () => {
  it('asks about each candidate in order until one passes', () => {
    const isPlayable = vi.fn((p) => p === 'c.mp4');
    const engine = makeEngine(LIST, 0);
    engine.isPlayable = isPlayable;
    engine._nextPath();
    expect(isPlayable.mock.calls.map((c) => c[0]))
      .toEqual(['F:/removed/Daisuki.mp4', 'c.mp4']);
  });
});
