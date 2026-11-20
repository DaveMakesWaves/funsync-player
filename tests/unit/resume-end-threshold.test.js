/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// E2-07 (verify-3 of FT-097, cosmetic, also in v0.9.2): a bookmark recorded
// just under the end threshold was stored on it and then never offered.
// Long Two (100 s, threshold 70) paused at about 69.96 s was stored as 70.0:
// `makeResumeEntry` rounded to the nearest tenth while `shouldRecordPosition`
// / `shouldOfferResume` compare `position < endThreshold`. The card showed a
// 70% bar and Last watched, Continue targeted it, and then it opened at 0:00
// with no prompt and no toast.
//
// The REAL app.js resume methods are lifted (helpers/app-methods.js), as in
// resume-session-clocks.test.js, with the REAL resume-position.js rules and
// the REAL playlist-progress.js Continue rule. What is asserted is what lands
// in library.resumePositions and what the user is then offered.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { liftAppClass } from './helpers/app-methods.js';
import * as PLAYERWIN from '../../renderer/js/player-popout-protocol.js';
import {
  shouldRecordPosition, shouldOfferResume, makeResumeEntry, makeFinishedEntry, isFinished, endThreshold,
  formatResumeTime, resumeProgressFraction, RESUME_MIN_DELTA_SECONDS, RESUME_WRITE_INTERVAL_MS,
} from '../../renderer/js/resume-position.js';
import { pickContinueTarget, summarisePlaylistProgress } from '../../renderer/js/playlist-progress.js';

const LONG_TWO = 'C:\\Lib\\Long Two.mp4';
const PLAYLIST = { source: 'playlist', sourceContext: { playlistId: 'pl1' } };

let fakeWindow;
const LiftedApp = liftAppClass([
  '_initResumeTracking', '_resumeClockSource', '_isSessionResumeClock', '_isPlaylistContext',
  '_playlistIdOf', '_resumeMap', 'getResumeEntry', '_writeResumeEntry', '_recordResumePosition',
  '_upNextResumeChoice',
], {
  window: { addEventListener: (...a) => fakeWindow.addEventListener(...a) },
  eventBus: { on() {} },
  PLAYERWIN,
  shouldRecordPosition, shouldOfferResume, makeResumeEntry, makeFinishedEntry, isFinished, endThreshold,
  formatResumeTime, RESUME_MIN_DELTA_SECONDS, RESUME_WRITE_INTERVAL_MS,
  console: { log() {}, info() {}, warn() {}, error() {} },
});

class FakeVideo extends EventTarget {
  constructor() { super(); this.paused = true; this.currentTime = 0; this.duration = 100; }
  play() { this.paused = false; this.dispatchEvent(new Event('play')); }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
}

function build() {
  const store = { 'library.resumePositions': {} };
  const video = new FakeVideo();
  const videoPlayer = {
    video,
    get paused() { return video.paused; },
    get currentTime() { return video.currentTime; },
    get duration() { return video.duration; },
  };
  const app = Object.assign(new LiftedApp(), {
    settings: { get: (k) => store[k], set: (k, v) => { store[k] = v; } },
    videoPlayer,
    upNextEngine: { player: videoPlayer },
    _currentVideoPath: LONG_TWO,
    _currentPlayContext: PLAYLIST,
    _markPlaylistLastWatched() {},
    _onPopoutVideoEnded() {},
  });
  app._initResumeTracking();
  const entry = () => store['library.resumePositions'][LONG_TWO] || null;
  return { app, video, entry };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance', 'Date'] });
  fakeWindow = new EventTarget();
});
afterEach(() => { vi.useRealTimers(); });

describe('a pause just under the end threshold is offered back (E2-07)', () => {
  it('Long Two paused at 69.96 s: stored under 70, and Continue, Up Next and the playlist all resume it', async () => {
    const { app, video, entry } = build();
    video.play();
    video.currentTime = 69.96;
    video.pause();
    await vi.advanceTimersByTimeAsync(0);

    const saved = entry();
    expect(saved).not.toBeNull();
    expect(saved.position).toBeLessThan(endThreshold(100));
    expect(saved.position).toBeCloseTo(69.9, 5);
    // The card's bar and the resume itself now agree.
    expect(resumeProgressFraction(saved, 100)).toBeCloseTo(0.699, 3);
    // Continue lands on it AND resumes it (it used to start it at 0:00).
    expect(pickContinueTarget([LONG_TWO], LONG_TWO, (p) => (p === LONG_TWO ? entry() : null)))
      .toEqual({ path: LONG_TWO, index: 0, resume: true });
    // Up Next offers the resume row.
    expect(app._upNextResumeChoice(LONG_TWO)).toEqual({ label: '1:09', position: saved.position });
    // The playlist counts it in progress, with its tail as time left.
    const summary = summarisePlaylistProgress([LONG_TWO], () => entry(), () => 100);
    expect(summary.inProgress).toBe(1);
    expect(summary.remainingSeconds).toBeCloseTo(30.1, 5);
  });

  it('a pause past the threshold is still a watched video, not a bookmark', async () => {
    const { video, entry } = build();
    video.play();
    video.currentTime = 70.01;
    video.pause();
    await vi.advanceTimersByTimeAsync(0);
    expect(isFinished(entry())).toBe(true);
    expect(entry().position).toBeUndefined();
  });
});
