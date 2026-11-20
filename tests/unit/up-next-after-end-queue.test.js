/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// R4-01 (2026-11-06, new since v0.9.2): after a video reached an "End of
// list" card, Back, then "Add to queue" on ANY library card switched to the
// player and loaded that video. FT-018 made a queue change call
// `UpNextEngine.refresh()`; the engine was still up with End of list, saw
// the list was no longer at its end, ran hide() then check(), and check()
// fired at once: the old video was still at its end, so the new card's
// countdown was clamped to zero.
//
// The REAL UpNextEngine, a fake player and fake timers. What is asserted is
// what the user gets: whether anything is played (`onPlayNext`), and which
// card shows with which countdown.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UpNextEngine, TICK_INTERVAL_MS } from '../../renderer/js/up-next.js';

const ZULU = 'D:\\Lib\\Zulu Last.mp4';
const COPY = 'D:\\Lib\\Alpha Scene (copy).mp4';
const ECHO = 'D:\\Lib\\Echo.mp4';

let engine;
let player;
let queue;
let shown;
let played;
let inPlayerView;

function build({ countdown = 10 } = {}) {
  player = { currentTime: 112, duration: 120, paused: false, ended: false };
  engine = new UpNextEngine({ videoPlayer: player, funscriptEngine: { isLoaded: false, getActions: () => [] } });
  engine.setSettings('auto', countdown);
  queue = [];
  shown = [];
  played = [];
  inPlayerView = true;
  engine.getPriorityNext = () => queue[0] || null;
  engine.canOfferAfterEnd = () => inPlayerView;
  engine.onShowNext = (p, sec) => shown.push([p, sec]);
  engine.onShowEndOfList = () => shown.push(['END OF LIST']);
  engine.onPlayNext = (p) => played.push(p);
  // Zulu Last is the last of the list (a library Name A-Z, or a Play All's
  // last item): End of list.
  engine.setPlayContext({ source: 'library', sourceLabel: 'library', sourceContext: {}, list: [COPY, ZULU], index: 1 });
  engine.check();
  return engine;
}

/** The video plays to its end under the End-of-list card. */
function ends() {
  player.currentTime = player.duration;
  player.ended = true;
  player.paused = true;
  engine.check();
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { engine?.hide(); vi.useRealTimers(); });

describe('R4-01: a video queued under an End-of-list card of an ENDED video', () => {
  it('never plays it at once (the card fired with a zero countdown)', () => {
    build();
    expect(shown).toEqual([['END OF LIST']]);
    ends();
    inPlayerView = false; // Back: the library is on screen
    queue.push(COPY);
    engine.refresh(); // app.js _persistUserQueue
    vi.advanceTimersByTime(60 * 1000);
    expect(played).toEqual([]);
  });

  it('outside the player view: no card at all, and none on later checks while still at the end', () => {
    build();
    ends();
    inPlayerView = false;
    queue.push(COPY);
    engine.refresh();
    expect(engine.visible).toBe(false);
    expect(shown).toEqual([['END OF LIST']]);
    engine.check(); // a pause / seeked / loadedmetadata event on the ended video
    engine.check();
    vi.advanceTimersByTime(30 * 1000);
    expect(engine.visible).toBe(false);
    expect(played).toEqual([]);
  });

  it('…and once the video is replayed, its next end offers the queued video as usual', () => {
    build();
    ends();
    inPlayerView = false;
    queue.push(COPY);
    engine.refresh();
    // Replay from the start: the playhead leaves the end.
    player.ended = false;
    player.paused = false;
    player.currentTime = 0;
    engine.check();
    player.currentTime = 112;
    engine.check();
    expect(shown.at(-1)).toEqual([COPY, 8]);
  });

  it('in the player view: a fresh card for the queued video with the FULL countdown', () => {
    build({ countdown: 10 });
    ends();
    queue.push(COPY);
    engine.refresh();
    expect(shown.at(-1)).toEqual([COPY, 10]);
    expect(engine.visible).toBe(true);
    expect(engine.endOfListShown).toBe(false);
    // Neither the ended video (it reads paused) nor being at its end stops
    // or fires it: it counts down.
    vi.advanceTimersByTime(5 * 1000);
    expect(played).toEqual([]);
    expect(engine.paused).toBe(false);
    vi.advanceTimersByTime(5 * 1000 + TICK_INTERVAL_MS);
    expect(played).toEqual([COPY]);
  });

  it('in the player view: × cancels that card and nothing plays', () => {
    build();
    ends();
    queue.push(COPY);
    engine.refresh();
    vi.advanceTimersByTime(3 * 1000);
    engine.dismiss();
    vi.advanceTimersByTime(60 * 1000);
    engine.check();
    expect(played).toEqual([]);
    expect(engine.visible).toBe(false);
  });

  it('in the player view: unqueued again before it runs out, the card goes back to End of list', () => {
    build();
    ends();
    queue.push(COPY);
    engine.refresh();
    queue.length = 0;
    engine.refresh();
    expect(shown.at(-1)).toEqual(['END OF LIST']);
    vi.advanceTimersByTime(60 * 1000);
    expect(played).toEqual([]);
  });

  it('in the player view: a replay takes the after-end card down', () => {
    build();
    ends();
    queue.push(COPY);
    engine.refresh();
    player.ended = false;
    player.paused = false;
    player.currentTime = 0;
    engine.check();
    expect(engine.visible).toBe(false);
    vi.advanceTimersByTime(60 * 1000);
    expect(played).toEqual([]);
  });

  it('no `canOfferAfterEnd` wired: offers nothing (the safe default)', () => {
    build();
    engine.canOfferAfterEnd = null;
    ends();
    queue.push(COPY);
    engine.refresh();
    vi.advanceTimersByTime(60 * 1000);
    expect(engine.visible).toBe(false);
    expect(played).toEqual([]);
  });
});

describe('what R4-01 leaves as it was', () => {
  it('End of list while the video still PLAYS its last seconds, then a queued video: the card counts to the end and plays it', () => {
    build();
    expect(shown).toEqual([['END OF LIST']]);
    queue.push(ECHO);
    engine.refresh();
    expect(shown.at(-1)).toEqual([ECHO, 8]);
    player.currentTime = 120;
    player.ended = true;
    vi.advanceTimersByTime(TICK_INTERVAL_MS);
    expect(played).toEqual([ECHO]);
  });

  it('a next-up card that reaches the end still plays at once (the dominant path)', () => {
    build();
    queue.push(ECHO);
    engine.refresh();
    player.currentTime = 120;
    player.ended = true;
    player.paused = true;
    vi.advanceTimersByTime(TICK_INTERVAL_MS);
    expect(played).toEqual([ECHO]);
  });
});
