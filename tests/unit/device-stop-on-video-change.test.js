/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Devices must stop when the video SOURCE changes — and must re-arm for the
// new video.
//
// Gap found while tracing the stop paths for the flywheel-machine work
// (2026-08-06). `loadSource()` does `video.src = url; video.load()`. The HTML
// media load algorithm sets `paused = true` WITHOUT firing a `pause` event,
// and the video didn't end, so `ended` doesn't fire either. Neither handler
// ran, and `_tryStartButtplugSync()` took its `_active` branch into
// `reloadActions()` — which restarts the scheduler but never stops the device.
//
// With a script on the new video the next tick overwrote the value within
// ~50ms. WITHOUT one, `_tryStartButtplugSync()` bails at its `isLoaded` check
// and the device held its last commanded value indefinitely. That is the
// unfixed half of the community "kept buzzing after switching videos" report:
// adding stopAll to stop() only ever covered `ended` (natural end / Play All).
//
// The hook is `emptied`, which the load algorithm fires whenever an
// already-loaded source is torn down.
//
// The RESUME half is as important as the stop: `_active` must survive, or the
// device goes quiet until the user reconnects.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ButtplugSync } from '../../renderer/js/buttplug-sync.js';
import { TCodeSync } from '../../renderer/js/tcode-sync.js';

// A real EventTarget, so dispatchEvent drives the genuine listener wiring
// rather than a hand-rolled fake that could diverge from it.
function makePlayer({ paused = false } = {}) {
  return { video: new EventTarget(), currentTime: 0, paused };
}

const ACTIONS = [
  { at: 0, pos: 0 },
  { at: 500, pos: 100 },
  { at: 1000, pos: 0 },
];

describe('ButtplugSync — stop on video source change', () => {
  let sync, buttplug, player;

  beforeEach(() => {
    player = makePlayer();
    buttplug = {
      connected: true,
      devices: [{
        index: 0,
        name: 'Hismith Sex Machine',
        canLinear: false,
        canVibrate: false,
        canRotate: false,
        canScalar: false,
        canOscillate: true,
      }],
      sendLinear: vi.fn(),
      sendVibrate: vi.fn(),
      sendRotate: vi.fn(),
      sendScalar: vi.fn(),
      sendOscillate: vi.fn(),
      stopAll: vi.fn().mockResolvedValue(undefined),
    };
    sync = new ButtplugSync({
      buttplugManager: buttplug,
      videoPlayer: player,
      funscriptEngine: { isLoaded: true, getActions: () => ACTIONS },
    });
    sync.start();
    buttplug.stopAll.mockClear();
  });

  afterEach(() => { try { sync.stop(); } catch { /* already stopped */ } });

  it('stops the device when the source is replaced', () => {
    player.video.dispatchEvent(new Event('emptied'));
    expect(buttplug.stopAll).toHaveBeenCalledTimes(1);
  });

  it('halts the scheduler so nothing is sent during the swap', () => {
    expect(sync._intervalId).not.toBeNull();
    player.video.dispatchEvent(new Event('emptied'));
    expect(sync._intervalId).toBeNull();
  });

  // The regression that matters most: a video with NO script. Nothing
  // downstream will overwrite the held value, so if the stop doesn't fire
  // here the device runs forever.
  it('stops even when the next video has no script to take over', () => {
    sync.funscript = { isLoaded: false, getActions: () => [] };
    player.video.dispatchEvent(new Event('emptied'));
    expect(buttplug.stopAll).toHaveBeenCalledTimes(1);
  });

  describe('re-arms for the new video', () => {
    beforeEach(() => { player.video.dispatchEvent(new Event('emptied')); });

    it('keeps the engine active — clearing it would silence the device', () => {
      expect(sync._active).toBe(true);
    });

    it('restarts the scheduler when the new video plays', () => {
      expect(sync._intervalId).toBeNull();
      player.video.dispatchEvent(new Event('playing'));
      expect(sync._intervalId).not.toBeNull();
    });

    it('resumes sending commands on the new video', () => {
      vi.useFakeTimers();
      try {
        player.video.dispatchEvent(new Event('playing'));
        player.currentTime = 0.75; // between the 500ms and 1000ms keyframes
        vi.advanceTimersByTime(200);
        expect(buttplug.sendOscillate).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps listening, so a second video change also stops', () => {
      player.video.dispatchEvent(new Event('playing'));
      buttplug.stopAll.mockClear();
      player.video.dispatchEvent(new Event('emptied'));
      expect(buttplug.stopAll).toHaveBeenCalledTimes(1);
    });

    it('re-arms the ramp so the new video eases in from zero', () => {
      // A flywheel has real inertia — resuming at the old video's intensity
      // is exactly what the ramp exists to prevent.
      expect(sync._rampUpStartTime).toBeGreaterThan(0);
      player.video.dispatchEvent(new Event('playing'));
      const capped = sync._applyScalarSafety(0, 100);
      expect(capped).toBeLessThan(70); // below even the cap, mid-ramp
    });
  });

  // The `emptied` hook is new. If it breaks a setup that worked before, the
  // user's main.log has to show whether the stop fired and whether the engine
  // came back — so the log pair is pinned like any other behaviour.
  describe('diagnostic logging', () => {
    let logs;

    beforeEach(() => {
      logs = [];
      vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
    });
    afterEach(() => { vi.restoreAllMocks(); });

    it('logs the stop, then a matching RE-ARMED when the new video plays', () => {
      player.video.dispatchEvent(new Event('emptied'));
      expect(logs.some((l) => l.includes('Video source changed'))).toBe(true);
      expect(logs.some((l) => l.includes('RE-ARMED'))).toBe(false);

      player.video.dispatchEvent(new Event('playing'));
      expect(logs.some((l) => l.includes('RE-ARMED'))).toBe(true);
    });

    it('does not emit a bogus RE-ARMED after a real stop()', () => {
      player.video.dispatchEvent(new Event('emptied'));
      sync.stop();
      sync._active = true; // simulate a later unrelated start
      sync._handlePlaying();
      expect(logs.some((l) => l.includes('RE-ARMED'))).toBe(false);
    });

    it('warns when re-arming would drive the previous video\'s actions', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      player.video.dispatchEvent(new Event('emptied'));
      // New video has no script, so app.js never calls reloadActions().
      sync.funscript = { isLoaded: false, getActions: () => [] };
      player.video.dispatchEvent(new Event('playing'));
      expect(warn).toHaveBeenCalled();
      expect(warn.mock.calls[0][0]).toMatch(/no funscript loaded for the new video/);
    });
  });

  it('unbinds the listener on stop()', () => {
    sync.stop();
    buttplug.stopAll.mockClear();
    player.video.dispatchEvent(new Event('emptied'));
    expect(buttplug.stopAll).not.toHaveBeenCalled();
  });

  it('ignores the event when the engine was never started', () => {
    const fresh = new ButtplugSync({
      buttplugManager: buttplug,
      videoPlayer: player,
      funscriptEngine: { isLoaded: true, getActions: () => ACTIONS },
    });
    buttplug.stopAll.mockClear();
    fresh._handleSourceChange();
    expect(buttplug.stopAll).not.toHaveBeenCalled();
  });
});

describe('TCodeSync — stop on video source change', () => {
  let sync, tcode, player;

  beforeEach(() => {
    player = makePlayer();
    tcode = {
      connected: true,
      stop: vi.fn(),
      sendMove: vi.fn(),
      sendAxisMove: vi.fn(),
    };
    sync = new TCodeSync({
      videoPlayer: player,
      tcodeManager: tcode,
      funscriptEngine: { isLoaded: true, getActions: () => ACTIONS },
    });
    sync.start();
    tcode.stop.mockClear();
  });

  afterEach(() => { try { sync.stop(); } catch { /* already stopped */ } });

  it('stops the axes when the source is replaced', () => {
    player.video.dispatchEvent(new Event('emptied'));
    expect(tcode.stop).toHaveBeenCalledTimes(1);
    expect(sync._intervalId).toBeNull();
  });

  it('stays active and restarts on the new video', () => {
    player.video.dispatchEvent(new Event('emptied'));
    expect(sync._active).toBe(true);
    player.video.dispatchEvent(new Event('playing'));
    expect(sync._intervalId).not.toBeNull();
  });

  it('unbinds the listener on stop()', () => {
    sync.stop();
    tcode.stop.mockClear();
    player.video.dispatchEvent(new Event('emptied'));
    expect(tcode.stop).not.toHaveBeenCalled();
  });
});
