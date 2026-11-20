/**
 * @vitest-environment jsdom
 * jsdom on purpose: video-player.js imports i18n.js and toast.js, which branch
 * on `typeof window` (notes/CLAUDE.md "Test environments").
 */
// D-02 real-app check (verify-1, 2026-11-07; also in v0.9.2): at 30 fps, from
// 30.000 s, Right, Right, Left, Left in the docked and the popped-out editor
// showed frames 901, 901, 900, 900: two of four presses showed NO new frame.
// A step added n / 30 s and so landed exactly ON the next frame's start, or a
// float hair before it (30 + 1/30 + 1/30 = 30.0666...63), and Chromium shows
// the frame before. With the player popped out the step was also rounded to
// whole ms (30.033 s < 30.0333 s): the burned-in counter read 900 there.
//
// What is asserted is the frame each press SHOWS. A frame shows from its
// start; real containers put frame k's start at k / fps (to the µs) or, when
// they count in whole ms (Matroska), up to 0.5 ms after it. So a press shows
// frame k for every container only if it lands at least 0.5 ms past k / fps
// and before frame k + 1. The REAL VideoPlayer.stepFrame / stepFrames (the
// docked editor, and the pop-out with the player docked) and the REAL app.js
// player-window path (the player popped out) are run.
import { describe, it, expect, vi } from 'vitest';
import { VideoPlayer, PLAYBACK_RATE_PRESETS, frameStepTime, FRAME_STEP_MARGIN_SEC } from '../../renderer/js/video-player.js';
import * as PLAYERWIN from '../../renderer/js/player-popout-protocol.js';
import { liftAppClass } from './helpers/app-methods.js';

const WORST_LATE_START_SEC = 0.0005; // a whole-ms container's rounding

/** The frame a time shows in EVERY container, or null when some would show another. */
function frameShownEverywhere(t, fps) {
  const k = Math.floor(t * fps + 1e-9);
  const fromStart = t - k / fps;
  const toNext = (k + 1) / fps - t;
  return fromStart >= WORST_LATE_START_SEC && toNext > 1e-6 ? k : null;
}

/** The REAL VideoPlayer step methods over a fake <video>. */
function inlinePlayer(startSec, { fps = 30, duration = 90 } = {}) {
  const video = { currentTime: startSec, duration, paused: false, pause: vi.fn(function () { this.paused = true; }) };
  const player = Object.create(VideoPlayer.prototype);
  Object.assign(player, { video, _fps: fps === 30 ? undefined : fps });
  return player;
}

function playerWindow(startSec) {
  const relays = [];
  const Lifted = liftAppClass(['_playerWindowPlayback'], {
    window: { funsync: { playerPopoutRelay: (dir, p) => { if (dir === 'to-popout') relays.push(p); } } },
    PLAYERWIN, PLAYBACK_RATE_PRESETS, frameStepTime, performance,
  });
  const app = new Lifted();
  Object.assign(app, {
    _playerWindowActive: true,
    _playerWinProxy: { currentTime: startSec, paused: true, duration: 90, playbackRate: 1 },
    videoPlayer: { _estimateFps: () => 30, video: { volume: 1, muted: false } },
  });
  const step = (frames) => {
    app._playerWindowPlayback('stepFrames', frames);
    const seek = relays.filter((m) => m.type === PLAYERWIN.SEEK).at(-1);
    return seek.timeMs / 1000; // what the player window is sent
  };
  return { step, relays };
}

describe('a frame step shows a new frame on every press (D-02, verify-1)', () => {
  it('docked: from 30.000 s, Right, Right, Left, Left shows 901, 902, 901, 900', () => {
    const p = inlinePlayer(30);
    const shown = [];
    for (const d of [1, 1, -1, -1]) { p.stepFrame(d); shown.push(frameShownEverywhere(p.video.currentTime, 30)); }
    expect(shown).toEqual([901, 902, 901, 900]);
    expect(p.video.paused).toBe(true);
  });

  it('docked: Ctrl (6 frames) from 30.000 s and back lands on 906 then 900', () => {
    const p = inlinePlayer(30);
    p.stepFrames(6);
    expect(frameShownEverywhere(p.video.currentTime, 30)).toBe(906);
    p.stepFrames(-6);
    expect(frameShownEverywhere(p.video.currentTime, 30)).toBe(900);
  });

  it('docked: a run of 60 presses never repeats a frame and comes back exactly', () => {
    const p = inlinePlayer(12.3456);
    const start = frameShownEverywhere(frameStepTime(12.3456, 0, 30), 30);
    let expected = start;
    for (let i = 0; i < 30; i++) { p.stepFrame(1); expected++; expect(frameShownEverywhere(p.video.currentTime, 30)).toBe(expected); }
    for (let i = 0; i < 30; i++) { p.stepFrame(-1); expected--; expect(frameShownEverywhere(p.video.currentTime, 30)).toBe(expected); }
  });

  it('docked: paused mid-frame by playback, Right is the next frame and Left the one before', () => {
    let p = inlinePlayer(30.05); // inside frame 901
    p.stepFrame(1);
    expect(frameShownEverywhere(p.video.currentTime, 30)).toBe(902);
    p = inlinePlayer(30.05);
    p.stepFrame(-1);
    expect(frameShownEverywhere(p.video.currentTime, 30)).toBe(900);
  });

  it('player popped out (whole-ms seeks): Right, Right, Left, Left shows 901, 902, 901, 900', () => {
    const w = playerWindow(30);
    const shown = [1, 1, -1, -1].map((d) => frameShownEverywhere(w.step(d), 30));
    expect(shown).toEqual([901, 902, 901, 900]);
    // Each press pauses the window first.
    expect(w.relays[0]).toEqual(PLAYERWIN.makeMessage(PLAYERWIN.SET_PLAY_STATE, { paused: true }));
  });

  it('the step is still 1/30 s: at 60 fps a press moves two frames (Dave\'s call, unchanged)', () => {
    const p = inlinePlayer(30);
    p.stepFrame(1);
    expect(frameShownEverywhere(p.video.currentTime, 60)).toBe(1802);
  });

  it('never steps before 0 or past the end', () => {
    const p = inlinePlayer(0.01, { duration: 5 });
    p.stepFrames(-6);
    expect(p.video.currentTime).toBeCloseTo(FRAME_STEP_MARGIN_SEC, 9);
    p.video.currentTime = 4.99;
    p.stepFrames(6);
    expect(p.video.currentTime).toBe(5);
  });
});
