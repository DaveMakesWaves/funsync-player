// Unit tests for GapSkipEngine — imports from real source
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { GapSkipEngine, DEFAULT_THRESHOLD_MS, LEAD_TIME_MS, COOLDOWN_MS } from '../../renderer/js/gap-skip.js';

function makeActions(times) {
  return times.map((t, i) => ({ at: t, pos: i % 2 === 0 ? 0 : 100 }));
}

function mockVideoPlayer(currentTimeSec = 0, paused = false, duration = 120) {
  const state = { ct: currentTimeSec, paused };
  return {
    get currentTime() { return state.ct; },
    set currentTime(v) { state.ct = v; },
    get paused() { return state.paused; },
    set paused(v) { state.paused = v; },
    duration,
    video: {
      get currentTime() { return state.ct; },
      set currentTime(v) { state.ct = v; },
    },
    _state: state, // for test access
  };
}

function mockFunscriptEngine(actions = []) {
  return {
    isLoaded: actions.length > 0,
    getActions: () => actions,
  };
}

describe('GapSkipEngine', () => {
  let engine, player, funscript;

  beforeEach(() => {
    vi.useFakeTimers();
    player = mockVideoPlayer(0, false, 120);
    funscript = mockFunscriptEngine([]);
    engine = new GapSkipEngine({ videoPlayer: player, funscriptEngine: funscript });
  });

  afterEach(() => {
    engine.stop();
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('starts with mode off', () => {
      expect(engine._mode).toBe('off');
    });

    it('starts with default threshold', () => {
      expect(engine._threshold).toBe(DEFAULT_THRESHOLD_MS);
    });

    it('starts with no gaps', () => {
      expect(engine.gaps).toEqual([]);
    });

    it('starts with zero total skippable', () => {
      expect(engine.totalSkippableMs).toBe(0);
    });
  });

  describe('loadGaps', () => {
    it('detects gaps between actions exceeding threshold', () => {
      const actions = makeActions([0, 500, 1000, 20000, 20500]);
      player = mockVideoPlayer(0, false, 21); // 21s — just past last action, no trailing gap
      funscript = mockFunscriptEngine(actions);
      engine = new GapSkipEngine({ videoPlayer: player, funscriptEngine: funscript });
      engine.loadGaps();

      expect(engine.gaps.length).toBe(1);
      expect(engine.gaps[0].startMs).toBe(1000);
      expect(engine.gaps[0].endMs).toBe(20000);
      expect(engine.gaps[0].durationMs).toBe(19000);
    });

    it('detects multiple gaps', () => {
      const actions = makeActions([0, 500, 15000, 15500, 30000, 30500]);
      player = mockVideoPlayer(0, false, 31); // no trailing gap
      funscript = mockFunscriptEngine(actions);
      engine = new GapSkipEngine({ videoPlayer: player, funscriptEngine: funscript });
      engine.loadGaps();

      expect(engine.gaps.length).toBe(2);
    });

    it('detects trailing gap when video duration exceeds last action', () => {
      const actions = makeActions([0, 500, 1000]);
      player = mockVideoPlayer(0, false, 120); // 120 seconds
      funscript = mockFunscriptEngine(actions);
      engine = new GapSkipEngine({ videoPlayer: player, funscriptEngine: funscript });
      engine.loadGaps();

      const trailing = engine.gaps.find(g => g.endMs === 120000);
      expect(trailing).toBeTruthy();
    });

    it('returns empty when no funscript is loaded', () => {
      engine.loadGaps();
      expect(engine.gaps).toEqual([]);
    });

    it('returns empty when actions have no gaps above threshold', () => {
      const actions = makeActions([0, 500, 1000, 1500, 2000]);
      player = mockVideoPlayer(0, false, 3); // 3s — no trailing gap
      funscript = mockFunscriptEngine(actions);
      engine = new GapSkipEngine({ videoPlayer: player, funscriptEngine: funscript });
      engine.loadGaps();

      expect(engine.gaps.length).toBe(0);
    });

    it('respects custom threshold', () => {
      const actions = makeActions([0, 500, 6000, 6500]); // 5.5s gap
      funscript = mockFunscriptEngine(actions);
      engine = new GapSkipEngine({ videoPlayer: player, funscriptEngine: funscript });

      engine.setSettings('button', 5000); // 5s threshold
      expect(engine.gaps.length).toBeGreaterThanOrEqual(1);
      expect(engine.gaps[0].durationMs).toBe(5500);
    });

    it('recalculates on setSettings', () => {
      const actions = makeActions([0, 500, 8000, 8500]); // 7.5s gap
      funscript = mockFunscriptEngine(actions);
      engine = new GapSkipEngine({ videoPlayer: player, funscriptEngine: funscript });

      engine.setSettings('button', 10000); // 10s threshold — no gap detected
      const countAt10 = engine.gaps.filter(g => g.durationMs < 10000).length === 0;
      expect(countAt10).toBe(true);

      engine.setSettings('button', 5000); // 5s threshold — gap detected
      expect(engine.gaps.some(g => g.durationMs === 7500)).toBe(true);
    });
  });

  describe('totalSkippableMs', () => {
    it('sums all gap durations', () => {
      const actions = makeActions([0, 500, 15000, 15500, 30000, 30500]);
      funscript = mockFunscriptEngine(actions);
      engine = new GapSkipEngine({ videoPlayer: player, funscriptEngine: funscript });
      engine.loadGaps();

      const total = engine.gaps.reduce((s, g) => s + g.durationMs, 0);
      expect(engine.totalSkippableMs).toBe(total);
    });
  });

  describe('skipToNextAction', () => {
    it('skips to next action minus lead time', () => {
      const actions = makeActions([0, 500, 20000, 20500]);
      funscript = mockFunscriptEngine(actions);
      engine = new GapSkipEngine({ videoPlayer: player, funscriptEngine: funscript });
      engine._actions = actions;

      player._state.ct = 2; // 2s, in the gap

      const result = engine.skipToNextAction();
      expect(result).not.toBeNull();
      expect(result.skippedMs).toBeGreaterThan(0);
      // Should seek to (20000 - 1500) / 1000 = 18.5s
      expect(player.video.currentTime).toBeCloseTo(18.5, 1);
    });

    it('returns null when no actions loaded', () => {
      expect(engine.skipToNextAction()).toBeNull();
    });

    it('skips to end when past all actions with valid duration', () => {
      const actions = makeActions([0, 500, 1000]);
      engine._actions = actions;
      player._state.ct = 100; // past all actions, duration is 120s

      const result = engine.skipToNextAction();
      expect(result).not.toBeNull();
      expect(player.video.currentTime).toBe(120); // skipped to end
    });

    it('returns null when past all actions with no valid duration', () => {
      const actions = makeActions([0, 500, 1000]);
      engine._actions = actions;
      player._state.ct = 100;
      engine.player = { ...player, duration: 0, video: player.video, get currentTime() { return 100; } };

      expect(engine.skipToNextAction()).toBeNull();
    });

    it('stores skip origin for undo', () => {
      const actions = makeActions([0, 500, 20000, 20500]);
      engine._actions = actions;
      player._state.ct = 2;
      player._state.ct = 2;

      engine.skipToNextAction();
      expect(engine._skipOrigin).toBe(2000);
    });

    it('calls onSkipped callback', () => {
      const actions = makeActions([0, 500, 20000, 20500]);
      engine._actions = actions;
      player._state.ct = 2;
      player._state.ct = 2;

      const cb = vi.fn();
      engine.onSkipped = cb;
      engine.skipToNextAction();
      expect(cb).toHaveBeenCalledOnce();
      expect(cb.mock.calls[0][0]).toBeGreaterThan(0);
    });
  });

  describe('skipToPreviousAction', () => {
    it('skips back to previous action group', () => {
      const actions = makeActions([0, 500, 1000, 20000, 20500, 21000]);
      engine._actions = actions;
      engine._threshold = DEFAULT_THRESHOLD_MS;
      player._state.ct = 21; // 21000ms, in the second group
      player._state.ct = 21;

      const result = engine.skipToPreviousAction();
      expect(result).not.toBeNull();
      expect(player.video.currentTime).toBeLessThan(21);
    });

    it('returns null when no actions', () => {
      expect(engine.skipToPreviousAction()).toBeNull();
    });

    it('returns null when at the start', () => {
      const actions = makeActions([0, 500, 1000]);
      engine._actions = actions;
      engine._threshold = DEFAULT_THRESHOLD_MS;
      player._state.ct = 0.3;
      player._state.ct = 0.3;

      expect(engine.skipToPreviousAction()).toBeNull();
    });
  });

  describe('undo', () => {
    it('seeks back to skip origin', () => {
      const actions = makeActions([0, 500, 20000, 20500]);
      engine._actions = actions;
      player._state.ct = 2;
      player._state.ct = 2;

      engine.skipToNextAction();
      const seekedTo = player.video.currentTime;
      expect(seekedTo).not.toBe(2);

      engine.undo();
      expect(player.video.currentTime).toBe(2); // back to origin
    });

    it('does nothing if no skip has occurred', () => {
      player._state.ct = 5;
      engine.undo();
      // No crash, currentTime unchanged by undo
    });

    it('clears skip origin after undo', () => {
      engine._skipOrigin = 5000;
      engine.undo();
      expect(engine._skipOrigin).toBeNull();
    });
  });

  describe('_findGapAt', () => {
    it('finds the gap containing the given time', () => {
      engine._gaps = [
        { startMs: 1000, endMs: 5000, durationMs: 4000 },
        { startMs: 10000, endMs: 15000, durationMs: 5000 },
      ];

      expect(engine._findGapAt(2000)).toBe(engine._gaps[0]);
      expect(engine._findGapAt(12000)).toBe(engine._gaps[1]);
    });

    it('returns null when not inside any gap', () => {
      engine._gaps = [
        { startMs: 1000, endMs: 5000, durationMs: 4000 },
      ];

      expect(engine._findGapAt(500)).toBeNull();
      expect(engine._findGapAt(6000)).toBeNull();
    });

    it('includes start boundary, excludes end boundary', () => {
      engine._gaps = [
        { startMs: 1000, endMs: 5000, durationMs: 4000 },
      ];

      expect(engine._findGapAt(1000)).toBe(engine._gaps[0]); // at start — inclusive
      expect(engine._findGapAt(5000)).toBeNull(); // at end — exclusive
    });

    it('returns null when no gaps', () => {
      engine._gaps = [];
      expect(engine._findGapAt(5000)).toBeNull();
    });
  });

  describe('_findNextAction', () => {
    it('finds the first action after the given time', () => {
      const actions = makeActions([0, 500, 1000, 5000, 10000]);
      engine._actions = actions;

      const next = engine._findNextAction(600);
      expect(next).toBe(actions[2]); // at 1000
    });

    it('returns null when past all actions', () => {
      const actions = makeActions([0, 500, 1000]);
      engine._actions = actions;

      expect(engine._findNextAction(2000)).toBeNull();
    });

    it('returns first action when before all', () => {
      const actions = makeActions([1000, 2000]);
      engine._actions = actions;

      expect(engine._findNextAction(0)).toBe(actions[0]);
    });

    it('returns null when no actions', () => {
      engine._actions = null;
      expect(engine._findNextAction(0)).toBeNull();
    });
  });

  describe('setSettings', () => {
    it('updates mode and threshold', () => {
      engine.setSettings('auto', 5000);
      expect(engine._mode).toBe('auto');
      expect(engine._threshold).toBe(5000);
    });

    it('defaults to off when mode is null', () => {
      engine.setSettings(null, 5000);
      expect(engine._mode).toBe('off');
    });

    it('defaults threshold when not provided', () => {
      engine.setSettings('button', null);
      expect(engine._threshold).toBe(DEFAULT_THRESHOLD_MS);
    });
  });

  describe('start / stop', () => {
    it('start creates a check interval', () => {
      engine.setSettings('button', 10000);
      engine.start();
      expect(engine._checkTimer).not.toBeNull();
    });

    it('start does nothing when mode is off', () => {
      engine.setSettings('off', 10000);
      engine.start();
      expect(engine._checkTimer).toBeNull();
    });

    it('stop clears the check interval', () => {
      engine.setSettings('button', 10000);
      engine.start();
      expect(engine._checkTimer).not.toBeNull();

      engine.stop();
      expect(engine._checkTimer).toBeNull();
    });

    it('stop clears countdown if running', () => {
      engine._countdownTimer = setInterval(() => {}, 1000);
      engine.stop();
      expect(engine._countdownTimer).toBeNull();
    });
  });

  describe('_check (auto mode)', () => {
    it('calls onShowOverlay when entering a gap in auto mode', () => {
      const actions = makeActions([0, 500, 20000, 20500]);
      funscript = mockFunscriptEngine(actions);
      engine = new GapSkipEngine({ videoPlayer: player, funscriptEngine: funscript });
      engine.setSettings('auto', 10000);
      engine.loadGaps();

      const showCb = vi.fn();
      engine.onShowOverlay = showCb;

      player._state.ct = 5; // inside the gap
      player._state.paused = false;
      engine._check();

      expect(showCb).toHaveBeenCalledOnce();
      expect(showCb.mock.calls[0][1]).toBe(5); // countdown seconds
    });

    it('calls onHideOverlay when leaving a gap', () => {
      const actions = makeActions([0, 500, 20000, 20500]);
      funscript = mockFunscriptEngine(actions);
      engine = new GapSkipEngine({ videoPlayer: player, funscriptEngine: funscript });
      engine.setSettings('button', 10000);
      engine.loadGaps();

      const hideCb = vi.fn();
      engine.onHideOverlay = hideCb;

      // Enter gap
      player._state.ct = 5;
      engine._check();

      // Leave gap
      player._state.ct = 20.2;
      engine._check();

      expect(hideCb).toHaveBeenCalled();
    });

    it('does not check when paused', () => {
      const actions = makeActions([0, 500, 20000, 20500]);
      funscript = mockFunscriptEngine(actions);
      engine = new GapSkipEngine({ videoPlayer: player, funscriptEngine: funscript });
      engine.setSettings('button', 10000);
      engine.loadGaps();

      const showCb = vi.fn();
      engine.onShowOverlay = showCb;

      player._state.ct = 5;
      player._state.paused = true;
      engine._check();

      expect(showCb).not.toHaveBeenCalled();
    });

    it('does not check when mode is off', () => {
      engine.setSettings('off', 10000);
      engine._gaps = [{ startMs: 0, endMs: 10000, durationMs: 10000 }];

      const showCb = vi.fn();
      engine.onShowOverlay = showCb;
      player._state.ct = 5;
      engine._check();

      expect(showCb).not.toHaveBeenCalled();
    });
  });

  describe('_check (button mode)', () => {
    it('shows skip button without countdown in button mode', () => {
      const actions = makeActions([0, 500, 20000, 20500]);
      funscript = mockFunscriptEngine(actions);
      engine = new GapSkipEngine({ videoPlayer: player, funscriptEngine: funscript });
      engine.setSettings('button', 10000);
      engine.loadGaps();

      const showCb = vi.fn();
      engine.onShowOverlay = showCb;

      player._state.ct = 5;
      engine._check();

      expect(showCb).toHaveBeenCalledOnce();
      expect(showCb.mock.calls[0][1]).toBeNull(); // no countdown
    });
  });

  describe('countdown', () => {
    it('counts down and auto-skips when reaching zero', () => {
      const actions = makeActions([0, 500, 20000, 20500]);
      engine._actions = actions;
      engine._countdownSeconds = 3;

      const tickCb = vi.fn();
      const skippedCb = vi.fn();
      engine.onCountdownTick = tickCb;
      engine.onSkipped = skippedCb;

      player._state.ct = 2;
      player._state.ct = 2;
      engine._startCountdown();

      vi.advanceTimersByTime(1000);
      expect(tickCb).toHaveBeenCalledWith(2);

      vi.advanceTimersByTime(1000);
      expect(tickCb).toHaveBeenCalledWith(1);

      vi.advanceTimersByTime(1000);
      expect(tickCb).toHaveBeenCalledWith(0);
      expect(skippedCb).toHaveBeenCalled();
    });

    it('clears countdown on stop', () => {
      engine._startCountdown();
      expect(engine._countdownTimer).not.toBeNull();

      engine._clearCountdown();
      expect(engine._countdownTimer).toBeNull();
      expect(engine._countdownRemaining).toBe(0);
    });
  });

  describe('exported constants', () => {
    it('has sensible defaults', () => {
      expect(DEFAULT_THRESHOLD_MS).toBe(10000);
      expect(LEAD_TIME_MS).toBe(1500);
      expect(COOLDOWN_MS).toBe(3000);
    });
  });
});
