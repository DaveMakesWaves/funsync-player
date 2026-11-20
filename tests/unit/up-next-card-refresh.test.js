/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// FT-018 follow-up (2026-11-05, verifier 2): the Up Next card named what came
// next when it appeared, and nothing re-read it. With the card already up,
// removing the source of the video it named, or queueing a video, changed
// what would play and left the card saying the old name: it named 'Bulk 001'
// (removed source) while the engine's next was the queued 'Bulk 005'. The
// End-of-list card had no ticker at all, so a video queued under it never
// turned it back into a next-up card.
//
// The REAL UpNextEngine, a fake player near its end and fake timers. What is
// asserted is what the card is told to show (`onShowNext` /
// `onShowEndOfList`), and that the countdown keeps running rather than
// starting over.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UpNextEngine, TICK_INTERVAL_MS } from '../../renderer/js/up-next.js';

const A1 = 'D:\\Lib\\Alpha.mp4';
const B1 = 'E:\\Bulk\\Bulk 001.mp4';
const A2 = 'D:\\Lib\\Charlie.mp4';
const Q5 = 'E:\\Bulk\\Bulk 005.mp4';

let engine;
let shown;
let removed;
let queue;
let player;

function build({ list = [A1, B1, A2], index = 0, paused = false } = {}) {
  player = { currentTime: 112, duration: 120, paused, ended: false };
  engine = new UpNextEngine({ videoPlayer: player, funscriptEngine: { isLoaded: false, getActions: () => [] } });
  engine.setSettings('auto', 10);
  removed = new Set();
  queue = [];
  engine.isPlayable = (p) => !removed.has(p);
  engine.getPriorityNext = () => queue[0] || null;
  shown = [];
  engine.onShowNext = (p, sec) => shown.push([p, sec]);
  engine.onShowEndOfList = () => shown.push(['END OF LIST']);
  engine.setPlayContext({ source: 'playlist', sourceLabel: 'P', sourceContext: {}, list, index });
  engine.check();
  return engine;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { engine?.hide(); vi.useRealTimers(); });

describe('a visible Up Next card follows what will really play', () => {
  it('the source of the named video is removed: the card renames to the next playable one, countdown kept', () => {
    build();
    expect(shown).toEqual([[B1, 8]]);
    vi.advanceTimersByTime(3 * 1000);

    removed.add(B1); // Settings > Sources > remove B; app.js calls refresh()
    engine.refresh();

    expect(shown.at(-1)).toEqual([A2, 5]);
    expect(engine.visible).toBe(true);
    expect(engine.endOfListShown).toBe(false);
  });

  it('the next tick picks the change up on its own, also while paused', () => {
    build({ paused: true });
    removed.add(B1);
    vi.advanceTimersByTime(TICK_INTERVAL_MS);
    expect(shown.at(-1)[0]).toBe(A2);
  });

  it('a video queued while the card is up: the card names the queued one', () => {
    build();
    queue.push(Q5);
    engine.refresh();
    expect(shown.at(-1)[0]).toBe(Q5);
  });

  it('nothing playable left after the removal: the card turns into End of list', () => {
    build({ list: [A1, B1] });
    removed.add(B1);
    engine.refresh();
    expect(shown.at(-1)).toEqual(['END OF LIST']);
    expect(engine.endOfListShown).toBe(true);
  });

  it('End of list, then a video is queued: the card turns into a next-up card for it', () => {
    build({ list: [A1], index: 0 });
    expect(shown).toEqual([['END OF LIST']]);
    queue.push(Q5);
    engine.refresh(); // app.js: _persistUserQueue
    expect(shown.at(-1)[0]).toBe(Q5);
    expect(engine.endOfListShown).toBe(false);
  });

  it('nothing changed: no re-show (the card is not rebuilt every tick)', () => {
    build();
    vi.advanceTimersByTime(TICK_INTERVAL_MS * 5);
    engine.refresh();
    expect(shown).toEqual([[B1, 8]]);
  });

  it('a hidden card is left alone', () => {
    build();
    engine.hide();
    queue.push(Q5);
    engine.refresh();
    expect(shown).toEqual([[B1, 8]]);
    expect(engine.visible).toBe(false);
  });
});
