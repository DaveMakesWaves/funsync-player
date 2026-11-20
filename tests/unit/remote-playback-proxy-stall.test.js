/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// N-01, the player pop-out half (reproduced 2026-11-16, row P): the window's
// TIME_TICKs said `paused: false` with a frozen time through a 12 s stall, so
// main's RemotePlaybackProxy kept "playing" at 79.98 s while the Handy ran to
// 91.95 s, and when the picture moved again nothing re-anchored it: the
// device stayed 12 s ahead until the next seek.
//
// The window now ticks `stalled` beside `paused`. REAL RemotePlaybackProxy;
// assertions on the events the sync engines bind to and the clock they read.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RemotePlaybackProxy } from '../../renderer/js/remote-playback-proxy.js';

let proxy;
let events;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'] });
  proxy = new RemotePlaybackProxy();
  events = [];
  for (const type of ['playing', 'pause', 'seeked', 'ended']) {
    proxy.addEventListener(type, () => events.push(type));
  }
  proxy.updateState({ at: 70_000, paused: false, stalled: false });
});
afterEach(() => {
  proxy.reset();
  vi.useRealTimers();
});

describe('a stalled tick reaches the engines as a pause, and its end as a playing', () => {
  it('stalled: the engines get "pause", and the clock stops at the reported time', () => {
    events.length = 0;
    proxy.updateState({ at: 79_980, paused: false, stalled: true });
    expect(events).toEqual(['pause']);
    expect(proxy.paused).toBe(true);
    vi.advanceTimersByTime(12_000);
    // The engines read this: no extrapolation through the stall.
    expect(proxy.currentTime).toBeCloseTo(79.98, 3);
  });

  it('the ticks that keep coming during the stall fire nothing more', () => {
    proxy.updateState({ at: 79_980, paused: false, stalled: true });
    events.length = 0;
    for (let i = 0; i < 120; i++) proxy.updateState({ at: 79_980, paused: false, stalled: true });
    expect(events).toEqual([]);
  });

  it('the stall ends: "playing" at the frozen time, which is what re-anchors the Handy', () => {
    // The window keeps ticking every 100 ms through the stall, so the stale
    // watchdog (no ticks at all) never fires: only `stalled` tells.
    events.length = 0;
    for (let t = 0; t < 12_000; t += 100) {
      proxy.updateState({ at: 79_980, paused: false, stalled: true });
      vi.advanceTimersByTime(100);
    }
    expect(events).toEqual(['pause']);
    events.length = 0;
    proxy.updateState({ at: 79_990, paused: false, stalled: false });
    expect(events).toEqual(['playing']);
    expect(proxy.currentTime).toBeCloseTo(79.99, 2);
  });

  it('the stale watchdog (no ticks at all) still synthesizes a pause after a stall ends', () => {
    proxy.updateState({ at: 80_000, paused: false, stalled: true });
    proxy.updateState({ at: 80_000, paused: false, stalled: false });
    events.length = 0;
    vi.advanceTimersByTime(RemotePlaybackProxy.STALE_LIMIT_MS + 600);
    expect(events).toEqual(['pause']);
  });
});

describe('the source\'s own paused flag stays readable for a Play/Pause toggle', () => {
  it('during a stall `paused` is true for the engines but `sourcePaused` is false: the video is playing', () => {
    proxy.updateState({ at: 79_980, paused: false, stalled: true });
    expect(proxy.paused).toBe(true);
    expect(proxy.sourcePaused).toBe(false);
    expect(proxy.stalled).toBe(true);
  });

  it('a real pause during a stall: sourcePaused true, and no second "pause" event', () => {
    proxy.updateState({ at: 79_980, paused: false, stalled: true });
    events.length = 0;
    proxy.handlePause();
    expect(proxy.sourcePaused).toBe(true);
    expect(events).toEqual([]);
  });
});

describe('a Play on a picture that cannot move yet starts nothing', () => {
  it('the window ticks "stalled" before its "play": handlePlay then does not fire "playing"', () => {
    proxy.updateState({ at: 30_000, paused: true, stalled: false });
    events.length = 0;
    proxy.updateState({ at: 30_000, paused: false, stalled: true });   // the tick the window sends first
    proxy.handlePlay();                                                // its 'play' VIDEO_EVENT
    expect(events).toEqual([]);
    expect(proxy.paused).toBe(true);
    proxy.updateState({ at: 30_000, paused: false, stalled: false });  // 'playing' in the window
    expect(events).toEqual(['playing']);
  });

  it('a Play on a buffered position fires "playing" once', () => {
    proxy.updateState({ at: 30_000, paused: true, stalled: false });
    events.length = 0;
    proxy.updateState({ at: 30_000, paused: false, stalled: false });
    proxy.handlePlay();
    expect(events).toEqual(['playing']);
  });
});

describe('the phone, which never sends `stalled`, behaves as before', () => {
  it('paused flips drive pause / playing, and sourcePaused follows paused', () => {
    const phone = new RemotePlaybackProxy();
    const seen = [];
    phone.addEventListener('playing', () => seen.push('playing'));
    phone.addEventListener('pause', () => seen.push('pause'));
    phone.updateState({ at: 1000, paused: false });
    phone.updateState({ at: 2000, paused: true });
    phone.updateState({ at: 2000, paused: false });
    phone.handlePause();
    phone.handlePlay();
    expect(seen).toEqual(['playing', 'pause', 'playing', 'pause', 'playing']);
    expect(phone.sourcePaused).toBe(false);
    expect(phone.stalled).toBe(false);
    phone.reset();
  });
});

describe('ended and reset clear a stall', () => {
  it('ended: no stall left behind for the next video', () => {
    proxy.updateState({ at: 100_000, paused: false, stalled: true });
    proxy.handleEnded();
    expect(proxy.stalled).toBe(false);
    expect(proxy.sourcePaused).toBe(true);
  });

  it('reset: a fresh slate', () => {
    proxy.updateState({ at: 100_000, paused: false, stalled: true });
    proxy.reset();
    expect(proxy.stalled).toBe(false);
    expect(proxy.sourcePaused).toBe(true);
    expect(proxy.paused).toBe(true);
  });
});
