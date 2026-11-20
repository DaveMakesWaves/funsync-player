/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Round 2 (2026-11-05), new since CB-01: an Up Next advance asks about
// unsaved editor edits first. After Cancel there, Up Next never fired again
// for that video: the engine's one-shot guard (`_advanced`, V18) stayed set.
// Cancel means "not now": rearm() releases it, and the card comes back on
// the NEXT end, not at once (still at the end, it would count down and ask
// again). The REAL UpNextEngine; what is counted is what reaches the app.
// The app side (Cancel at the real question calls rearm) is in
// editor-unsaved-changes.test.js.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { UpNextEngine } from '../../renderer/js/up-next.js';

let clip;
let engine;
let advances;

beforeEach(() => {
  vi.useFakeTimers();
  clip = { currentTime: 30, duration: 60, paused: false, ended: false };
  engine = new UpNextEngine({ videoPlayer: clip, funscriptEngine: { isLoaded: false } });
  engine.setSettings('auto', 10);
  advances = [];
  engine.onPlayNext = (path) => advances.push(path);
  engine.setPlayContext({
    source: 'library', sourceLabel: 'Library', sourceContext: {},
    list: ['C:\\Lib\\Alpha.mp4', 'C:\\Lib\\Bravo.mp4'],
    index: 0,
  });
});

afterEach(() => {
  engine.hide();
  vi.useRealTimers();
});

const at = (s) => { clip.currentTime = s; clip.ended = s >= clip.duration; engine.check(); };

/** Into the last 10 s: the card shows; Play on it hands the advance over. */
function endAndAdvance() {
  at(55);
  expect(engine.visible).toBe(true);
  engine.playNext();
}

describe('Up Next after a cancelled advance (round 2)', () => {
  it('without rearm the advance is one-shot: the next end shows nothing (V18 guard)', () => {
    endAndAdvance();
    expect(advances).toHaveLength(1);
    at(30);
    at(55);
    expect(engine.visible).toBe(false);
    at(60);
    expect(advances).toHaveLength(1);
  });

  it('rearm: not at once, while still at the end', () => {
    endAndAdvance();
    engine.rearm();
    at(60);
    expect(engine.visible).toBe(false);
    vi.advanceTimersByTime(20_000);
    expect(advances).toHaveLength(1);
  });

  it('rearm: the card comes back on the next end, and its advance fires', () => {
    endAndAdvance();
    engine.rearm();
    at(60);
    at(30); // seeked back: out of the end window
    expect(engine.visible).toBe(false);
    at(55);
    expect(engine.visible).toBe(true);
    engine.playNext();
    expect(advances).toEqual(['C:\\Lib\\Bravo.mp4', 'C:\\Lib\\Bravo.mp4']);
  });

  // R3 fix-up (real-app verifier 1): an 8 s clip with the default 10 s
  // countdown is in the end window from its first second, so it never LEFT
  // it: after a Cancel the card never came back, even after a seek to 0.
  it('a clip shorter than the countdown: a seek back brings the card back, and its advance fires', () => {
    clip.duration = 8;
    at(3);
    expect(engine.visible).toBe(true); // the whole clip is the end window
    engine.playNext();
    engine.rearm(); // Cancel, at 3 s
    at(8);
    at(3); // seeked back
    expect(engine.visible).toBe(true);
    engine.playNext();
    expect(advances).toEqual(['C:\\Lib\\Bravo.mp4', 'C:\\Lib\\Bravo.mp4']);
  });

  it('a clip shorter than the countdown, Cancel at its end: still not at once, but after a seek back', () => {
    clip.duration = 8;
    at(8);
    engine.playNext();
    engine.rearm();
    at(8);
    expect(engine.visible).toBe(false);
    at(7.5); // less than a second back: the playhead jittering at the end
    expect(engine.visible).toBe(false);
    at(2);
    expect(engine.visible).toBe(true);
  });

  it('rearm without an advance handed over changes nothing', () => {
    engine.rearm();
    at(55);
    expect(engine.visible).toBe(true);
  });

  it('a new video starts clean: no wait from a rearm on the old one', () => {
    endAndAdvance();
    engine.rearm();
    engine.setPlayContext({
      source: 'library', sourceLabel: 'Library', sourceContext: {},
      list: ['C:\\Lib\\Alpha.mp4', 'C:\\Lib\\Bravo.mp4', 'C:\\Lib\\Charlie.mp4'],
      index: 1,
    });
    at(55);
    expect(engine.visible).toBe(true);
  });
});
