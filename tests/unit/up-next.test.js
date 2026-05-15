// Unit tests for UpNextEngine — imports from real source
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { UpNextEngine, MIN_TRAILING_GAP_MS, TICK_INTERVAL_MS } from '../../renderer/js/up-next.js';

function makeActions(times) {
  return times.map((t, i) => ({ at: t, pos: i % 2 === 0 ? 0 : 100 }));
}

function mockVideoPlayer({ currentTime = 0, paused = false, duration = 120, ended = false } = {}) {
  const state = { ct: currentTime, paused, ended };
  return {
    get currentTime() { return state.ct; },
    set currentTime(v) { state.ct = v; },
    get paused() { return state.paused; },
    set paused(v) { state.paused = v; },
    get ended() { return state.ended; },
    set ended(v) { state.ended = v; },
    duration,
    _state: state,
  };
}

function mockFunscriptEngine(actions = null) {
  return {
    isLoaded: !!actions && actions.length > 0,
    getActions: () => actions || [],
  };
}

function makeContext({
  source = 'library',
  list = ['a.mp4', 'b.mp4', 'c.mp4'],
  index = 0,
  sourceLabel = 'library',
  sourceContext = {},
} = {}) {
  return { source, sourceLabel, sourceContext, list, index };
}

function makeEngine({ player, funscript } = {}) {
  return new UpNextEngine({
    videoPlayer: player || mockVideoPlayer(),
    funscriptEngine: funscript || mockFunscriptEngine(),
  });
}

describe('UpNextEngine', () => {
  let engine;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    if (engine) engine.hide();
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('starts with mode auto by default after setSettings', () => {
      engine = makeEngine();
      engine.setSettings('auto', 10);
      expect(engine.mode).toBe('auto');
      expect(engine.countdownSec).toBe(10);
    });

    it('starts hidden', () => {
      engine = makeEngine();
      expect(engine.visible).toBe(false);
    });

    it('starts with no play context', () => {
      engine = makeEngine();
      expect(engine._playContext).toBe(null);
    });
  });

  describe('setSettings', () => {
    it('hides the card when mode flips to off', () => {
      const player = mockVideoPlayer({ currentTime: 118, duration: 120 });
      engine = makeEngine({ player });
      engine.setSettings('auto', 10);
      engine.setPlayContext(makeContext());
      engine.check();
      expect(engine.visible).toBe(true);

      engine.setSettings('off', 10);
      expect(engine.visible).toBe(false);
    });

    it('rejects non-positive countdown values', () => {
      engine = makeEngine();
      engine.setSettings('auto', 10);
      engine.setSettings('auto', 0);
      expect(engine.countdownSec).toBe(10);
      engine.setSettings('auto', -3);
      expect(engine.countdownSec).toBe(10);
    });
  });

  describe('setPlayContext', () => {
    it('clears the dismiss flag', () => {
      const player = mockVideoPlayer({ currentTime: 118, duration: 120 });
      engine = makeEngine({ player });
      engine.setSettings('auto', 10);
      engine.setPlayContext(makeContext());
      engine.check();
      engine.dismiss();
      expect(engine.visible).toBe(false);

      engine.setPlayContext(makeContext({ list: ['x.mp4', 'y.mp4'], index: 0 }));
      engine.check();
      expect(engine.visible).toBe(true);
    });

    it('hides the current card when context changes', () => {
      const player = mockVideoPlayer({ currentTime: 118, duration: 120 });
      engine = makeEngine({ player });
      engine.setSettings('auto', 10);
      engine.setPlayContext(makeContext());
      engine.check();
      expect(engine.visible).toBe(true);

      engine.setPlayContext(makeContext({ index: 0 }));
      expect(engine.visible).toBe(false);
    });

    it('null context disables Up Next', () => {
      const player = mockVideoPlayer({ currentTime: 118, duration: 120 });
      engine = makeEngine({ player });
      engine.setSettings('auto', 10);
      engine.setPlayContext(null);
      engine.check();
      expect(engine.visible).toBe(false);
    });
  });

  describe('trigger conditions', () => {
    it('shows during a trailing gap when script has dead tail', () => {
      const actions = makeActions([1000, 5000, 10000]);  // last action at 10s
      const player = mockVideoPlayer({ currentTime: 11, duration: 120 });  // 110s tail
      const funscript = mockFunscriptEngine(actions);
      engine = makeEngine({ player, funscript });
      engine.setSettings('auto', 10);
      engine.setPlayContext(makeContext());
      engine.check();
      expect(engine.visible).toBe(true);
      expect(engine.endOfListShown).toBe(false);
    });

    it('does NOT show before the trailing gap is entered', () => {
      const actions = makeActions([1000, 5000, 10000]);
      const player = mockVideoPlayer({ currentTime: 5, duration: 120 });  // mid-action
      const funscript = mockFunscriptEngine(actions);
      engine = makeEngine({ player, funscript });
      engine.setSettings('auto', 10);
      engine.setPlayContext(makeContext());
      engine.check();
      expect(engine.visible).toBe(false);
    });

    it('shows in last-N-seconds window when script has no trailing gap', () => {
      const actions = makeActions([1000, 60000, 119000]);  // last action 1s before end
      const player = mockVideoPlayer({ currentTime: 117, duration: 120 });
      const funscript = mockFunscriptEngine(actions);
      engine = makeEngine({ player, funscript });
      engine.setSettings('auto', 10);
      engine.setPlayContext(makeContext());
      engine.check();
      expect(engine.visible).toBe(true);
    });

    it('shows in last-N-seconds window when no script is loaded', () => {
      const player = mockVideoPlayer({ currentTime: 116, duration: 120 });
      engine = makeEngine({ player, funscript: mockFunscriptEngine() });
      engine.setSettings('auto', 10);
      engine.setPlayContext(makeContext());
      engine.check();
      expect(engine.visible).toBe(true);
    });

    it('does NOT show before the trigger window with no script', () => {
      const player = mockVideoPlayer({ currentTime: 100, duration: 120 });  // 20s remaining > 10s window
      engine = makeEngine({ player });
      engine.setSettings('auto', 10);
      engine.setPlayContext(makeContext());
      engine.check();
      expect(engine.visible).toBe(false);
    });

    it('trigger window aligns with countdownSec setting', () => {
      // 8s remaining + countdownSec=10 → in window, shows.
      // 8s remaining + countdownSec=5 → out of window, doesn't show.
      const player = mockVideoPlayer({ currentTime: 112, duration: 120 });
      engine = makeEngine({ player });
      engine.setPlayContext(makeContext());

      engine.setSettings('auto', 10);
      engine.check();
      expect(engine.visible).toBe(true);

      engine.hide();
      engine.setSettings('auto', 5);
      engine.check();
      expect(engine.visible).toBe(false);
    });

    it('does not show with no play context', () => {
      const player = mockVideoPlayer({ currentTime: 118, duration: 120 });
      engine = makeEngine({ player });
      engine.setSettings('auto', 10);
      engine.check();
      expect(engine.visible).toBe(false);
    });

    it('does not show when mode is off', () => {
      const player = mockVideoPlayer({ currentTime: 118, duration: 120 });
      engine = makeEngine({ player });
      engine.setSettings('off', 10);
      engine.setPlayContext(makeContext());
      engine.check();
      expect(engine.visible).toBe(false);
    });

    it('does not show when suppressed', () => {
      const player = mockVideoPlayer({ currentTime: 118, duration: 120 });
      engine = makeEngine({ player });
      engine.setSettings('auto', 10);
      engine.setPlayContext(makeContext());
      engine.setSuppressed(true);
      engine.check();
      expect(engine.visible).toBe(false);
    });

    it('hides immediately when suppression is enabled mid-card', () => {
      const player = mockVideoPlayer({ currentTime: 118, duration: 120 });
      engine = makeEngine({ player });
      engine.setSettings('auto', 10);
      engine.setPlayContext(makeContext());
      engine.check();
      expect(engine.visible).toBe(true);
      engine.setSuppressed(true);
      expect(engine.visible).toBe(false);
    });

    it('hides when seeking back out of the trigger zone', () => {
      const player = mockVideoPlayer({ currentTime: 118, duration: 120 });
      engine = makeEngine({ player });
      engine.setSettings('auto', 10);
      engine.setPlayContext(makeContext());
      engine.check();
      expect(engine.visible).toBe(true);

      player._state.ct = 50;
      engine.check();
      expect(engine.visible).toBe(false);
    });

    it('does not show with zero or unknown duration', () => {
      const player = mockVideoPlayer({ currentTime: 0, duration: 0 });
      engine = makeEngine({ player });
      engine.setSettings('auto', 10);
      engine.setPlayContext(makeContext());
      engine.check();
      expect(engine.visible).toBe(false);
    });
  });

  describe('end-of-list state', () => {
    it('fires onShowEndOfList when current is the last item', () => {
      const onEnd = vi.fn();
      const onShow = vi.fn();
      const player = mockVideoPlayer({ currentTime: 118, duration: 120 });
      engine = makeEngine({ player });
      engine.onShowEndOfList = onEnd;
      engine.onShowNext = onShow;
      engine.setSettings('auto', 10);
      engine.setPlayContext(makeContext({ list: ['only.mp4'], index: 0 }));
      engine.check();

      expect(engine.visible).toBe(true);
      expect(engine.endOfListShown).toBe(true);
      expect(onEnd).toHaveBeenCalledTimes(1);
      expect(onShow).not.toHaveBeenCalled();
    });

    it('passes sourceLabel and sourceContext to onShowEndOfList', () => {
      const onEnd = vi.fn();
      const player = mockVideoPlayer({ currentTime: 118, duration: 120 });
      engine = makeEngine({ player });
      engine.onShowEndOfList = onEnd;
      engine.setSettings('auto', 10);
      engine.setPlayContext(makeContext({
        list: ['only.mp4'],
        index: 0,
        sourceLabel: 'playlist "Mix"',
        sourceContext: { playlistId: 'p1' },
      }));
      engine.check();
      expect(onEnd).toHaveBeenCalledWith('playlist "Mix"', { playlistId: 'p1' });
    });

    it('end-of-list state ignores hover/video pause', () => {
      const onEnd = vi.fn();
      const player = mockVideoPlayer({ currentTime: 118, duration: 120 });
      engine = makeEngine({ player });
      engine.onShowEndOfList = onEnd;
      engine.setSettings('auto', 10);
      engine.setPlayContext(makeContext({ list: ['only.mp4'], index: 0 }));
      engine.check();

      engine.pauseCountdown();
      expect(engine.paused).toBe(false);  // end-of-list is never "paused"
    });
  });

  describe('countdown', () => {
    it('fires onShowNext with the next path and clamped countdown', () => {
      const onShow = vi.fn();
      const player = mockVideoPlayer({ currentTime: 118, duration: 120 });  // 2s remaining
      engine = makeEngine({ player });
      engine.onShowNext = onShow;
      engine.setSettings('auto', 10);
      engine.setPlayContext(makeContext({
        list: ['cur.mp4', 'next.mp4'],
        index: 0,
      }));
      engine.check();

      expect(onShow).toHaveBeenCalledTimes(1);
      const [path, countdownSec] = onShow.mock.calls[0];
      expect(path).toBe('next.mp4');
      expect(countdownSec).toBe(2);  // clamped to time remaining
    });

    it('fires onTick at every interval until 0, then fires onPlayNext', () => {
      const onTick = vi.fn();
      const onPlayNext = vi.fn();
      // Use real timers for this one — the engine relies on
      // performance.now() (not faked by default), so fake timers don't
      // advance elapsed time. Test it with a tiny real countdown.
      vi.useRealTimers();
      const player = mockVideoPlayer({ currentTime: 119.7, duration: 120 });
      engine = makeEngine({ player });
      engine.onTick = onTick;
      engine.onPlayNext = onPlayNext;
      engine.setSettings('auto', 1);
      engine.setPlayContext(makeContext({
        list: ['cur.mp4', 'next.mp4'],
        index: 0,
      }));
      engine.check();
      expect(engine.visible).toBe(true);

      return new Promise((resolve) => {
        setTimeout(() => {
          expect(onPlayNext).toHaveBeenCalledWith('next.mp4');
          expect(engine.visible).toBe(false);
          resolve();
        }, 1500);
      });
    });

    it('fires onPlayNext immediately when video ends mid-countdown (no stuck countdown)', () => {
      const onPlayNext = vi.fn();
      const player = mockVideoPlayer({ currentTime: 117, duration: 120 });
      engine = makeEngine({ player });
      engine.onPlayNext = onPlayNext;
      engine.setSettings('auto', 10);
      engine.setPlayContext(makeContext({
        list: ['cur.mp4', 'next.mp4'],
        index: 0,
      }));
      engine.check();
      expect(engine.visible).toBe(true);

      // Simulate video ending — paused becomes true, ended becomes
      // true. Without the fix, the engine would freeze the countdown
      // on whatever number it was at.
      player._state.ct = 120;
      player._state.paused = true;
      player._state.ended = true;
      vi.advanceTimersByTime(TICK_INTERVAL_MS + 10);

      expect(onPlayNext).toHaveBeenCalledWith('next.mp4');
      expect(engine.visible).toBe(false);
    });

    it('fires onPlayNext when currentTime crosses duration even without ended flag', () => {
      // Defensive — some video pipelines don't reliably set .ended.
      const onPlayNext = vi.fn();
      const player = mockVideoPlayer({ currentTime: 117, duration: 120 });
      engine = makeEngine({ player });
      engine.onPlayNext = onPlayNext;
      engine.setSettings('auto', 10);
      engine.setPlayContext(makeContext({
        list: ['cur.mp4', 'next.mp4'],
        index: 0,
      }));
      engine.check();
      player._state.ct = 120;
      player._state.paused = true;
      // ended stays false
      vi.advanceTimersByTime(TICK_INTERVAL_MS + 10);
      expect(onPlayNext).toHaveBeenCalledWith('next.mp4');
    });

    it('fires onPlayNext immediately when countdown clamps to 0', () => {
      const onPlayNext = vi.fn();
      // Trigger zone but no time remaining (e.g., past video end)
      const player = mockVideoPlayer({ currentTime: 120, duration: 120 });
      engine = makeEngine({ player });
      engine.onPlayNext = onPlayNext;
      engine.setSettings('auto', 10);
      engine.setPlayContext(makeContext({
        list: ['cur.mp4', 'next.mp4'],
        index: 0,
      }));
      engine.check();
      expect(onPlayNext).toHaveBeenCalledWith('next.mp4');
      expect(engine.visible).toBe(false);
    });
  });

  describe('hover pause / resume', () => {
    it('pauseCountdown sets paused', () => {
      const player = mockVideoPlayer({ currentTime: 118, duration: 120 });
      engine = makeEngine({ player });
      engine.setSettings('auto', 10);
      engine.setPlayContext(makeContext());
      engine.check();
      engine.pauseCountdown();
      expect(engine.paused).toBe(true);
      expect(engine.pauseReasons).toContain('hover');
    });

    it('resumeCountdown clears paused if no other reasons', () => {
      const player = mockVideoPlayer({ currentTime: 118, duration: 120 });
      engine = makeEngine({ player });
      engine.setSettings('auto', 10);
      engine.setPlayContext(makeContext());
      engine.check();
      engine.pauseCountdown();
      engine.resumeCountdown();
      expect(engine.paused).toBe(false);
    });

    it('paused countdown does not progress', () => {
      const onPlayNext = vi.fn();
      const player = mockVideoPlayer({ currentTime: 117, duration: 120 });
      engine = makeEngine({ player });
      engine.onPlayNext = onPlayNext;
      engine.setSettings('auto', 3);
      engine.setPlayContext(makeContext({
        list: ['cur.mp4', 'next.mp4'],
        index: 0,
      }));
      engine.check();
      expect(engine.visible).toBe(true);
      engine.pauseCountdown();

      vi.advanceTimersByTime(5000);
      expect(onPlayNext).not.toHaveBeenCalled();
      expect(engine.visible).toBe(true);
    });

    it('hover and video pause stack — hover stays paused after video resumes', () => {
      const player = mockVideoPlayer({ currentTime: 117, paused: true, duration: 120 });
      engine = makeEngine({ player });
      engine.setSettings('auto', 5);
      engine.setPlayContext(makeContext({
        list: ['cur.mp4', 'next.mp4'],
        index: 0,
      }));
      engine.check();
      expect(engine.visible).toBe(true);
      // _show() picked up player.paused → 'video' is in reasons.
      expect(engine.pauseReasons).toContain('video');

      engine.pauseCountdown();  // hover added
      expect(engine.pauseReasons).toEqual(expect.arrayContaining(['video', 'hover']));

      // Video resumes — tick should remove 'video' but 'hover' remains.
      player._state.paused = false;
      vi.advanceTimersByTime(TICK_INTERVAL_MS + 10);
      expect(engine.paused).toBe(true);
      expect(engine.pauseReasons).toContain('hover');
      expect(engine.pauseReasons).not.toContain('video');

      engine.resumeCountdown();
      expect(engine.paused).toBe(false);
    });
  });

  describe('dismiss', () => {
    it('hides and stays dismissed for the same context', () => {
      const player = mockVideoPlayer({ currentTime: 118, duration: 120 });
      engine = makeEngine({ player });
      engine.setSettings('auto', 10);
      engine.setPlayContext(makeContext());
      engine.check();
      engine.dismiss();
      expect(engine.visible).toBe(false);

      engine.check();
      expect(engine.visible).toBe(false);
    });

    it('new context clears the dismiss flag', () => {
      const player = mockVideoPlayer({ currentTime: 118, duration: 120 });
      engine = makeEngine({ player });
      engine.setSettings('auto', 10);
      engine.setPlayContext(makeContext());
      engine.check();
      engine.dismiss();

      engine.setPlayContext(makeContext({ list: ['x.mp4', 'y.mp4'], index: 0 }));
      engine.check();
      expect(engine.visible).toBe(true);
    });
  });

  describe('playNext', () => {
    it('fires onPlayNext immediately and hides', () => {
      const onPlayNext = vi.fn();
      const player = mockVideoPlayer({ currentTime: 118, duration: 120 });
      engine = makeEngine({ player });
      engine.onPlayNext = onPlayNext;
      engine.setSettings('auto', 10);
      engine.setPlayContext(makeContext({
        list: ['cur.mp4', 'next.mp4'],
        index: 0,
      }));
      engine.check();
      engine.playNext();
      expect(onPlayNext).toHaveBeenCalledWith('next.mp4');
      expect(engine.visible).toBe(false);
    });

    it('does nothing when not visible', () => {
      const onPlayNext = vi.fn();
      engine = makeEngine();
      engine.onPlayNext = onPlayNext;
      engine.playNext();
      expect(onPlayNext).not.toHaveBeenCalled();
    });

    it('does nothing on the end-of-list state', () => {
      const onPlayNext = vi.fn();
      const player = mockVideoPlayer({ currentTime: 118, duration: 120 });
      engine = makeEngine({ player });
      engine.onPlayNext = onPlayNext;
      engine.setSettings('auto', 10);
      engine.setPlayContext(makeContext({ list: ['only.mp4'], index: 0 }));
      engine.check();
      engine.playNext();
      expect(onPlayNext).not.toHaveBeenCalled();
    });
  });

  describe('advancePastMissing', () => {
    it('walks the index forward and returns the next path', () => {
      engine = makeEngine();
      engine.setPlayContext(makeContext({
        list: ['a.mp4', 'b.mp4', 'c.mp4', 'd.mp4'],
        index: 0,
      }));
      const next = engine.advancePastMissing();
      expect(next).toBe('c.mp4');  // index 0 → walked to 1 → next is at 2
    });

    it('returns null when walking past the end', () => {
      engine = makeEngine();
      engine.setPlayContext(makeContext({
        list: ['a.mp4', 'b.mp4'],
        index: 0,
      }));
      const next = engine.advancePastMissing();
      expect(next).toBe(null);
    });
  });

  describe('hide', () => {
    it('clears all internal state', () => {
      const onHide = vi.fn();
      const player = mockVideoPlayer({ currentTime: 118, duration: 120 });
      engine = makeEngine({ player });
      engine.onHide = onHide;
      engine.setSettings('auto', 10);
      engine.setPlayContext(makeContext());
      engine.check();
      engine.pauseCountdown();
      engine.hide();
      expect(engine.visible).toBe(false);
      expect(engine.endOfListShown).toBe(false);
      expect(engine.paused).toBe(false);
      expect(onHide).toHaveBeenCalledTimes(1);
    });

    it('hide on already-hidden is a no-op', () => {
      const onHide = vi.fn();
      engine = makeEngine();
      engine.onHide = onHide;
      engine.hide();
      expect(onHide).not.toHaveBeenCalled();
    });
  });
});
