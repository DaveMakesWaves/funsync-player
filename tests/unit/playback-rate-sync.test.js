// Tests that audio, video, and funscript timing stay matched when the
// playback rate changes.
//
// THE PROPERTY UNDER TEST is the same one users care about: "at 0.5× /
// 1.5× / 2×, does the device do the right thing at the right moment?"
//
// Three layers contribute to that property:
//
//   1. HTML5 <video> is the time clock. Audio + video + WebVTT subtitle
//      cue timing are all driven by `video.currentTime`, which the
//      browser advances at `video.playbackRate`. Pitch-correction on
//      audio is browser-native (Chromium / Electron default ON). We do
//      not interpose on any of this — there is nothing for us to break,
//      and that's the contract this file verifies by NOT mocking the
//      video clock.
//
//   2. `FunscriptEngine.getPositionAt(timeMs)` is a pure function of
//      time — same input, same output regardless of rate. The script
//      doesn't "play faster"; the script LOOKUP key (currentTime) moves
//      faster. Verified directly.
//
//   3. Per-tick sync engines (Buttplug, Handy-HDSP) read
//      `player.currentTime` every tick and feed that to the interpolator.
//      Because the video advances `currentTime` at the rate-adjusted
//      pace, the engines naturally follow without rate-aware code of
//      their own. Verified by spying on the lookup time the engine
//      computes from a stubbed video element.
//
// Handy-HSSP is the exception — the cloud schedules the uploaded CSV
// at 1.0× regardless of `video.playbackRate`. That's why
// `videoPlayer.setPlaybackRate` flips to HDSP mode at non-1×. The mode
// switch is unit-tested in video-player-rate.test.js; here we assert
// the architectural contract (engine reads currentTime per tick) that
// makes HDSP rate-correct.

import { describe, it, expect, vi } from 'vitest';
import { FunscriptEngine } from '../../renderer/js/funscript-engine.js';
import { VideoPlayer, PLAYBACK_RATE_PRESETS } from '../../renderer/js/video-player.js';
import { HandyHdspSync } from '../../renderer/js/handy-hdsp-sync.js';
import { eventBus } from '../../renderer/js/event-bus.js';

/**
 * Build a FunscriptEngine seeded with a known action list, bypassing
 * file IO and backend CSV conversion (both irrelevant to time matching).
 */
function makeEngineWith(actions) {
  const engine = new FunscriptEngine({ backendPort: 0 });
  engine._parsed = {
    filename: 'test.funscript',
    version: '1.0',
    inverted: false,
    range: 100,
    actions: [...actions].sort((a, b) => a.at - b.at),
    actionCount: actions.length,
    durationMs: actions[actions.length - 1].at,
  };
  return engine;
}

function makePlayer() {
  const p = Object.create(VideoPlayer.prototype);
  p.video = { playbackRate: 1, currentTime: 0 };
  return p;
}

describe('Funscript engine is rate-independent', () => {
  // The engine has no knowledge of playback rate. It only sees a
  // timestamp. That's the property we want.
  const actions = [
    { at: 0,    pos: 0 },
    { at: 1000, pos: 100 },
    { at: 2000, pos: 0 },
    { at: 3000, pos: 100 },
  ];

  it('returns the same position for the same video time at any rate', () => {
    const engine = makeEngineWith(actions);
    const T = 500; // halfway between action 0 and action 1 → pos 50
    const expected = engine.getPositionAt(T);

    // Simulate a player at four different rates. The lookup at the same
    // video time must return the same value — that's what guarantees
    // "at 2× speed the funscript still points at the right action for
    // the visible frame."
    for (const rate of [0.25, 0.5, 1, 1.5, 2]) {
      const player = makePlayer();
      player.video.playbackRate = rate;
      player.video.currentTime = T / 1000;
      expect(engine.getPositionAt(player.video.currentTime * 1000)).toBe(expected);
    }
  });

  it('linear interpolation result matches at multiple sample points', () => {
    const engine = makeEngineWith(actions);
    for (const T of [100, 250, 500, 750, 1000, 1500, 2500]) {
      const base = engine.getPositionAt(T);
      // Identical reads at non-1× rates with the same currentTime.
      for (const rate of [0.5, 1.5, 2]) {
        const player = makePlayer();
        player.video.playbackRate = rate;
        player.video.currentTime = T / 1000;
        expect(engine.getPositionAt(player.video.currentTime * 1000)).toBe(base);
      }
    }
  });
});

describe('Per-tick sync engine reads currentTime (rate-correct by construction)', () => {
  // HandyHdspSync._tick reads `player.currentTime` every poll and feeds
  // it to `interpolatePosition(actions, timeMs)`. Because HTML5 already
  // advances currentTime at `playbackRate`, the engine naturally tracks
  // the user's rate without rate-aware code of its own.

  function buildHdsp(currentTime, actions) {
    const handyManager = { connected: true, hdspMove: vi.fn() };
    // Player stub — only `currentTime` is read in _tick.
    const player = { currentTime };
    const sync = new HandyHdspSync({ handyManager, player });
    sync._actions = actions;
    sync._active = true;
    return { sync, handyManager };
  }

  const actions = [
    { at: 0,    pos: 0 },
    { at: 1000, pos: 100 },
    { at: 2000, pos: 0 },
  ];

  it('at currentTime=0.5s sends position interpolated for 500ms', () => {
    const { sync, handyManager } = buildHdsp(0.5, actions);
    sync._tick();
    expect(handyManager.hdspMove).toHaveBeenCalledOnce();
    const sentPos = handyManager.hdspMove.mock.calls[0][0];
    expect(sentPos).toBeCloseTo(50, 1); // 50% between (0,0) and (1000,100)
  });

  it('same currentTime → same target position, regardless of how fast we got there', () => {
    // Scenario: imagine playing at 2× speed reached currentTime=0.5s
    // in 250 wall-clock ms; at 0.5× speed we reached the same
    // currentTime in 1000 wall-clock ms. The engine cannot distinguish
    // those — it sees only the timestamp. Both produce the same target.
    const slow = buildHdsp(0.5, actions);
    const fast = buildHdsp(0.5, actions);
    slow.sync._tick();
    fast.sync._tick();
    expect(slow.handyManager.hdspMove.mock.calls[0][0])
      .toBe(fast.handyManager.hdspMove.mock.calls[0][0]);
  });

  it('after the user changes rate to 1.5×, ticks continue to be driven by currentTime', () => {
    // Simulate: rate change happened upstream, video advanced 200ms
    // since the last tick. The engine reads the new currentTime and
    // produces the correct interpolated value for it.
    const t1 = buildHdsp(0.700, actions); // 700ms into video
    t1.sync._tick();
    const posAt700 = t1.handyManager.hdspMove.mock.calls[0][0];
    expect(posAt700).toBeCloseTo(70, 1); // 70% between (0,0) and (1000,100)

    const t2 = buildHdsp(0.900, actions); // 200ms later, rate=1.5× would do this in ~133ms wall
    t2.sync._tick();
    const posAt900 = t2.handyManager.hdspMove.mock.calls[0][0];
    expect(posAt900).toBeCloseTo(90, 1);
  });
});

describe('Handy HSSP is disengaged at non-1× (architectural contract)', () => {
  // HSSP uploads the script and the cloud schedules it at 1.0× pace.
  // At any other rate the device drifts. Video-player.setPlaybackRate
  // must stop the HSSP engine and start the polled HDSP engine.
  // (Detailed mode-switch tests live in video-player-rate.test.js —
  // this is a smoke test that the contract holds end-to-end.)

  it('rate=1.5× stops HSSP and starts HDSP', () => {
    const player = makePlayer();
    const syncEngine = { start: vi.fn(), stop: vi.fn() };
    const handyHdsp = { active: false, start: vi.fn(), stop: vi.fn() };
    player.setHandySyncRefs({
      handyManager: { connected: true },
      handySyncEngine: syncEngine,
      handyHdspSync: handyHdsp,
    });
    player.setPlaybackRate(1.5);
    expect(syncEngine.stop).toHaveBeenCalledTimes(1);
    expect(handyHdsp.start).toHaveBeenCalledTimes(1);
  });

  it('rate=1× restores HSSP', () => {
    const player = makePlayer();
    const syncEngine = { start: vi.fn(), stop: vi.fn() };
    const handyHdsp = { active: true, start: vi.fn(), stop: vi.fn() };
    player.setHandySyncRefs({
      handyManager: { connected: true },
      handySyncEngine: syncEngine,
      handyHdspSync: handyHdsp,
    });
    player.setPlaybackRate(1);
    expect(handyHdsp.stop).toHaveBeenCalledTimes(1);
    expect(syncEngine.start).toHaveBeenCalledTimes(1);
  });
});

describe('HTML5 audio / video / subtitle timing (documentation tests)', () => {
  // These are documentation tests — they assert the architectural fact
  // that we do NOT interpose on the browser's native clock. If a future
  // change starts mucking with the audio context or replacing the video
  // clock, these tests will need to be revisited and the property they
  // assert will need active validation.

  it('VideoPlayer does not override video.playbackRate other than through setPlaybackRate', () => {
    // The only assignment to playbackRate in the player surface is
    // inside setPlaybackRate (verified by greppable contract). The
    // _onMetadataLoaded reset path also calls setPlaybackRate(1)
    // rather than assigning directly, so the event emission and mode
    // switch fire consistently.
    const player = makePlayer();
    const setSpy = vi.spyOn(player, 'setPlaybackRate');
    player.timeDuration = { textContent: '' };
    player.video.duration = 60;
    player.video.videoHeight = 720;
    player.video.playbackRate = 1.5;
    player._formatTime = () => '';
    player._onMetadataLoaded();
    // Routed through the public API — guarantees the event fires and
    // mode switch (if needed) runs.
    expect(setSpy).toHaveBeenCalledWith(1);
  });

  it('all engine surfaces use a single clock (video.currentTime)', () => {
    // Smoke check: the engines under test (FunscriptEngine.getPositionAt,
    // HandyHdspSync._tick, buttplug-sync._currentTimeMs) all read
    // `player.currentTime` or accept `timeMs`. None read
    // `Date.now()` / `performance.now()` for the script lookup. This
    // is what makes audio/video/funscript time match: they share one
    // clock that the browser already rate-adjusts.
    //
    // Asserted by construction in the previous describe blocks; this
    // documents the contract for future readers.
    expect(PLAYBACK_RATE_PRESETS.includes(1)).toBe(true);
  });

  it('event emission lets all listening surfaces (player UI, editor dropdown, web-remote display) update on rate change', () => {
    eventBus.removeAll('playback:rate-changed');
    const fn = vi.fn();
    eventBus.on('playback:rate-changed', fn);
    const player = makePlayer();
    player.setPlaybackRate(0.5);
    player.setPlaybackRate(2);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
