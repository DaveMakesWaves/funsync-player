/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Tests for the playback-rate API on VideoPlayer.
//
// VideoPlayer is the single source of truth for rate state. The editor
// dropdown, player-controls speed button, keyboard <  / > shortcuts,
// and (Phase 2) web-remote all route through setPlaybackRate. The HSSP↔
// HDSP mode switch that keeps Handy in sync at non-1× rates lives here.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VideoPlayer, PLAYBACK_RATE_PRESETS } from '../../renderer/js/video-player.js';
import { eventBus } from '../../renderer/js/event-bus.js';

function makePlayer() {
  const player = Object.create(VideoPlayer.prototype);
  player.video = { playbackRate: 1 };
  // Mirrors the constructor. `_currentRate` — not `video.playbackRate` — is
  // what the load-time reset checks, because the browser resets the element
  // itself when a new resource loads.
  player._currentRate = 1;
  return player;
}

describe('PLAYBACK_RATE_PRESETS', () => {
  it('contains the expected sorted preset list', () => {
    expect([...PLAYBACK_RATE_PRESETS]).toEqual([0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]);
  });

  it('is frozen so accidental mutation throws', () => {
    expect(Object.isFrozen(PLAYBACK_RATE_PRESETS)).toBe(true);
  });
});

describe('VideoPlayer.setPlaybackRate', () => {
  let player;

  beforeEach(() => {
    player = makePlayer();
    eventBus.removeAll('playback:rate-changed');
  });

  it('updates video.playbackRate to a preset', () => {
    player.setPlaybackRate(1.5);
    expect(player.video.playbackRate).toBe(1.5);
  });

  it('rejects non-preset values (silent no-op)', () => {
    player.setPlaybackRate(1.37);
    expect(player.video.playbackRate).toBe(1);
  });

  it('emits playback:rate-changed on every accepted set', () => {
    const fn = vi.fn();
    eventBus.on('playback:rate-changed', fn);
    player.setPlaybackRate(0.5);
    player.setPlaybackRate(2);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn.mock.calls[0][0]).toBe(0.5);
    expect(fn.mock.calls[1][0]).toBe(2);
  });

  it('does NOT emit when called with a non-preset value', () => {
    const fn = vi.fn();
    eventBus.on('playback:rate-changed', fn);
    player.setPlaybackRate(3.5);
    expect(fn).not.toHaveBeenCalled();
  });

  it('playbackRate getter reflects video element', () => {
    player.video.playbackRate = 0.75;
    expect(player.playbackRate).toBe(0.75);
  });
});

describe('VideoPlayer.cyclePlaybackRate', () => {
  let player;

  beforeEach(() => {
    player = makePlayer();
    eventBus.removeAll('playback:rate-changed');
  });

  it('steps up to the next preset', () => {
    player.video.playbackRate = 1;
    player.cyclePlaybackRate(+1);
    expect(player.video.playbackRate).toBe(1.25);
  });

  it('steps down to the previous preset', () => {
    player.video.playbackRate = 1;
    player.cyclePlaybackRate(-1);
    expect(player.video.playbackRate).toBe(0.75);
  });

  it('clamps at the top — cannot go above 2×', () => {
    player.video.playbackRate = 2;
    player.cyclePlaybackRate(+1);
    expect(player.video.playbackRate).toBe(2);
  });

  it('clamps at the bottom — cannot go below 0.25×', () => {
    player.video.playbackRate = 0.25;
    player.cyclePlaybackRate(-1);
    expect(player.video.playbackRate).toBe(0.25);
  });

  it('snaps to 1× when current rate is off-preset', () => {
    player.video.playbackRate = 1.37;
    player.cyclePlaybackRate(+1);
    expect(player.video.playbackRate).toBe(1);
  });

  it('walks the full preset list', () => {
    player.video.playbackRate = 0.25;
    const observed = [0.25];
    for (let i = 0; i < PLAYBACK_RATE_PRESETS.length - 1; i++) {
      player.cyclePlaybackRate(+1);
      observed.push(player.video.playbackRate);
    }
    expect(observed).toEqual([...PLAYBACK_RATE_PRESETS]);
  });
});

describe('VideoPlayer Handy HSSP↔HDSP mode switch', () => {
  let player;
  let syncEngine, handyHdsp, handyManager;

  beforeEach(() => {
    player = makePlayer();
    syncEngine = { start: vi.fn(), stop: vi.fn() };
    handyHdsp = { active: false, start: vi.fn(), stop: vi.fn() };
    handyManager = { connected: true };
    player.setHandySyncRefs({
      handyManager,
      handySyncEngine: syncEngine,
      handyHdspSync: handyHdsp,
    });
  });

  it('on non-1× — stops HSSP sync engine and starts HDSP polled engine', () => {
    handyHdsp.active = false;
    player.setPlaybackRate(1.5);
    expect(syncEngine.stop).toHaveBeenCalledTimes(1);
    expect(handyHdsp.start).toHaveBeenCalledTimes(1);
  });

  it('on 1× — stops HDSP and restarts HSSP', () => {
    handyHdsp.active = true;
    player.setPlaybackRate(1);
    expect(handyHdsp.stop).toHaveBeenCalledTimes(1);
    expect(syncEngine.start).toHaveBeenCalledTimes(1);
  });

  it('does not double-start HDSP when already active', () => {
    handyHdsp.active = true;
    player.setPlaybackRate(0.5);
    expect(handyHdsp.start).not.toHaveBeenCalled();
  });

  it('no-op on rate change when Handy is disconnected', () => {
    handyManager.connected = false;
    player.setPlaybackRate(1.5);
    expect(syncEngine.stop).not.toHaveBeenCalled();
    expect(handyHdsp.start).not.toHaveBeenCalled();
  });
});

describe('VideoPlayer reset on new video load', () => {
  it('_onMetadataLoaded resets to 1× when rate is non-1×', () => {
    const player = makePlayer();
    // Minimal stubs for the rest of _onMetadataLoaded
    player.timeDuration = { textContent: '' };
    player.video.duration = 100;
    player.video.videoHeight = 1080;
    // Realistic post-load state: the browser has ALREADY reset the element
    // to 1, and only our tracked rate still remembers the previous video's
    // 1.5. Asserting on `video.playbackRate = 1.5` here described a state
    // that cannot occur, which is why the bug survived this test.
    player._currentRate = 1.5;
    player.video.playbackRate = 1;
    const setSpy = vi.spyOn(player, 'setPlaybackRate');
    player._formatTime = () => '1:40';

    player._onMetadataLoaded();

    expect(setSpy).toHaveBeenCalledWith(1);
  });

  it('does not call setPlaybackRate when already at 1×', () => {
    const player = makePlayer();
    player.timeDuration = { textContent: '' };
    player.video.duration = 100;
    player.video.videoHeight = 1080;
    player.video.playbackRate = 1;
    const setSpy = vi.spyOn(player, 'setPlaybackRate');
    player._formatTime = () => '1:40';

    player._onMetadataLoaded();

    expect(setSpy).not.toHaveBeenCalled();
  });
});

// --- Rate reset on new video load (community report, 2026-08-05) ---
//
// "Playback speed other than 1x appears to persist on screen across videos
// but doesn't really — you have to reselect it for each video for it to
// take effect."
//
// The element's `playbackRate` is reset to `defaultPlaybackRate` by the
// browser as part of loading a new resource, so by the time
// `_onMetadataLoaded` runs it already reads 1. Guarding the reset on the
// ELEMENT therefore never fired, and `playback:rate-changed` was never
// emitted — leaving the speed chip showing the previous video's rate.

function makeLoadedPlayer(trackedRate, elementRate) {
  const player = Object.create(VideoPlayer.prototype);
  // Only the bits `_onMetadataLoaded` touches before the rate block.
  player.video = { playbackRate: elementRate, duration: 120, videoHeight: 1080, videoWidth: 1920 };
  player._currentRate = trackedRate;
  player.timeDuration = { textContent: '' };
  player._formatTime = () => '2:00';
  return player;
}

describe('rate reset on new video load', () => {
  let events;
  let off;

  beforeEach(() => {
    events = [];
    off = (rate) => events.push(rate);
    eventBus.on('playback:rate-changed', off);
  });

  afterEach(() => {
    eventBus.off?.('playback:rate-changed', off);
  });

  it('re-applies the tracked rate when "remember playback speed" is on', () => {
    // The element was reset to 1 by the browser, so remembering still means
    // WRITING the rate back — not simply leaving it alone.
    const player = makeLoadedPlayer(1.5, 1);
    player.setRememberRateProvider(() => true);
    player.setPlaybackRate = vi.fn(function (r) {
      this.video.playbackRate = r;
      this._currentRate = r;
      eventBus.emit('playback:rate-changed', r);
    });

    player._onMetadataLoaded();

    expect(player.setPlaybackRate).toHaveBeenCalledWith(1.5);
    expect(player.video.playbackRate).toBe(1.5);
    expect(events).toContain(1.5);
  });

  it('falls back to resetting when the remember provider throws', () => {
    // 1x is the safe direction — never leave a video stuck at 2x because a
    // settings read blew up.
    const player = makeLoadedPlayer(2, 1);
    player.setRememberRateProvider(() => { throw new Error('settings gone'); });
    player.setPlaybackRate = vi.fn();

    expect(() => player._onMetadataLoaded()).not.toThrow();
    expect(player.setPlaybackRate).toHaveBeenCalledWith(1);
  });

  it('announces the drop to 1x even though the element already reads 1', () => {
    // The regression: tracked rate is 1.5 from the previous video, the
    // element has already been reset to 1 by the browser.
    const player = makeLoadedPlayer(1.5, 1);
    player.setPlaybackRate = vi.fn(function (r) {
      this.video.playbackRate = r;
      this._currentRate = r;
      eventBus.emit('playback:rate-changed', r);
    });

    player._onMetadataLoaded();

    expect(player.setPlaybackRate).toHaveBeenCalledWith(1);
    expect(events).toContain(1);
    expect(player._currentRate).toBe(1);
  });

});
