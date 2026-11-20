/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// V18 (app test 2026-11-02): one auto-advance loaded the next video two or
// three times, each with its own script convert and device upload.
//
// The engine fired onPlayNext and only hid itself. The play context changes
// once the next video's load gets past an await (library._playVideo reads the
// funscript first), and every check() in that window — the inline
// 'timeupdate' and 'pause' at the natural end, or a pop-out TIME_TICK and its
// 'ended' — saw the OLD context with the playhead at its end. _show() then
// computed a zero countdown and fired onPlayNext again.
//
// These drive the REAL UpNextEngine through the exact sequences the tester
// logged and count what reaches the app: onPlayNext calls.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { UpNextEngine, TICK_INTERVAL_MS } from '../../renderer/js/up-next.js';

/** The clock the engine reads: currentTime / duration / paused / ended. */
function player({ at = 0, duration = 13, paused = false } = {}) {
  return { currentTime: at, duration, paused, ended: false };
}

function context(index = 0) {
  return {
    source: 'library', sourceLabel: 'Library', sourceContext: {},
    list: ['D:\\Lib\\Alpha.mp4', 'D:\\Lib\\Bravo.mp4', 'D:\\Lib\\Charlie.mp4'],
    index,
  };
}

let clip;
let engine;
let advances;

beforeEach(() => {
  vi.useFakeTimers();
  clip = player({ at: 4 });
  engine = new UpNextEngine({ videoPlayer: clip, funscriptEngine: { isLoaded: false } });
  engine.setSettings('auto', 10);
  advances = [];
  // What app.js does: start the next video's load. Nothing in it changes
  // the context synchronously; that happens after the funscript read.
  engine.onPlayNext = (path) => advances.push(path);
  engine.setPlayContext(context(0));
});

afterEach(() => {
  engine.hide();
  vi.useRealTimers();
});

/** Play to the natural end, the way the element reports it. */
function reachEnd() {
  clip.currentTime = clip.duration;
  clip.ended = true;
  clip.paused = true;
}

describe('V18: one end of video is one advance', () => {
  it('inline: the tick that advances, then the timeupdate and pause at the end, load the next video once', () => {
    clip.currentTime = 9; // into the 10 s trailing window
    engine.check();
    expect(engine.visible).toBe(true);

    reachEnd();
    vi.advanceTimersByTime(TICK_INTERVAL_MS); // _tick: at the end → advance
    // The next video is still loading; the old context is still in place.
    engine.check(); // 'timeupdate'
    engine.check(); // 'pause'

    expect(advances).toEqual(['D:\\Lib\\Bravo.mp4']);
  });

  it('pop-out: a zero-countdown fire from a TIME_TICK, then the relayed ended, advance once', () => {
    // The pop-out's tick lands past the trailing window's start with no time
    // left: _show() fires at once. Its 'ended' arrives a beat later and
    // _onPopoutVideoEnded calls check() again.
    clip.currentTime = clip.duration;
    engine.check();
    engine.check();
    vi.advanceTimersByTime(TICK_INTERVAL_MS * 3);
    engine.check();

    expect(advances).toEqual(['D:\\Lib\\Bravo.mp4']);
  });

  it('clicking Play on the card, then the end arriving, advances once', () => {
    clip.currentTime = 9;
    engine.check();
    engine.playNext();
    reachEnd();
    engine.check();
    vi.advanceTimersByTime(TICK_INTERVAL_MS * 3);
    expect(advances).toEqual(['D:\\Lib\\Bravo.mp4']);
  });

  it('the next video, once its context lands, advances again at ITS end', () => {
    clip.currentTime = clip.duration;
    engine.check();
    expect(advances).toEqual(['D:\\Lib\\Bravo.mp4']);

    // Bravo's load reaches _setUpNextContext; the element restarts at 0.
    engine.setPlayContext(context(1));
    Object.assign(clip, { currentTime: 0, ended: false, paused: false });
    engine.check();
    expect(engine.visible).toBe(false);

    clip.currentTime = clip.duration;
    engine.check();
    expect(advances).toEqual(['D:\\Lib\\Bravo.mp4', 'D:\\Lib\\Charlie.mp4']);
  });

  it('a dismissed card still never advances (the one-shot does not replace dismiss)', () => {
    clip.currentTime = 9;
    engine.check();
    engine.dismiss();
    reachEnd();
    engine.check();
    vi.advanceTimersByTime(TICK_INTERVAL_MS * 3);
    expect(advances).toEqual([]);
  });
});
