import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RemotePlaybackProxy } from '../../renderer/js/remote-playback-proxy.js';

describe('RemotePlaybackProxy — initial state', () => {
  it('starts paused at time 0', () => {
    const p = new RemotePlaybackProxy();
    expect(p.paused).toBe(true);
    expect(p.currentTime).toBe(0);
    expect(p.duration).toBe(0);
    expect(p.playbackRate).toBe(1);
  });
});

describe('RemotePlaybackProxy — updateState', () => {
  it('sets currentTime from `at` (ms → s)', () => {
    const p = new RemotePlaybackProxy();
    p.updateState({ at: 12500, paused: true });
    expect(p.currentTime).toBeCloseTo(12.5, 3);
  });

  it('updates duration', () => {
    const p = new RemotePlaybackProxy();
    p.updateState({ at: 0, duration: 600 });
    expect(p.duration).toBe(600);
  });

  it('transition paused → playing fires playing event', () => {
    const p = new RemotePlaybackProxy();
    const spy = vi.fn();
    p.addEventListener('playing', spy);
    p.updateState({ at: 0, paused: false });
    expect(spy).toHaveBeenCalledOnce();
  });

  it('transition playing → paused fires pause event', () => {
    const p = new RemotePlaybackProxy();
    p.updateState({ at: 0, paused: false });
    const spy = vi.fn();
    p.addEventListener('pause', spy);
    p.updateState({ at: 1000, paused: true });
    expect(spy).toHaveBeenCalledOnce();
  });

  it('does not fire events if state unchanged', () => {
    const p = new RemotePlaybackProxy();
    p.updateState({ at: 0, paused: false });
    const playing = vi.fn();
    const pause = vi.fn();
    p.addEventListener('playing', playing);
    p.addEventListener('pause', pause);
    p.updateState({ at: 500, paused: false });
    expect(playing).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
  });

  it('respects rate updates', () => {
    const p = new RemotePlaybackProxy();
    p.updateState({ at: 0, paused: false, rate: 2 });
    expect(p.playbackRate).toBe(2);
  });

  it('ignores invalid state shapes', () => {
    const p = new RemotePlaybackProxy();
    expect(() => p.updateState(null)).not.toThrow();
    expect(() => p.updateState(undefined)).not.toThrow();
    expect(() => p.updateState('not an object')).not.toThrow();
    expect(p.paused).toBe(true);
  });
});

describe('RemotePlaybackProxy — time interpolation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('interpolates while playing', () => {
    const p = new RemotePlaybackProxy();
    p.updateState({ at: 10000, paused: false }); // 10 s
    vi.advanceTimersByTime(500);
    expect(p.currentTime).toBeCloseTo(10.5, 1);
  });

  it('does not interpolate while paused', () => {
    const p = new RemotePlaybackProxy();
    p.updateState({ at: 10000, paused: true });
    vi.advanceTimersByTime(500);
    expect(p.currentTime).toBeCloseTo(10, 1);
  });

  it('interpolates at playback rate', () => {
    const p = new RemotePlaybackProxy();
    p.updateState({ at: 10000, paused: false, rate: 0.5 });
    vi.advanceTimersByTime(1000);
    expect(p.currentTime).toBeCloseTo(10.5, 1);
  });
});

describe('RemotePlaybackProxy — explicit events', () => {
  it('seek() fires seeked and sets time', () => {
    const p = new RemotePlaybackProxy();
    const spy = vi.fn();
    p.addEventListener('seeked', spy);
    p.seek(45000);
    expect(spy).toHaveBeenCalledOnce();
    expect(p.currentTime).toBeCloseTo(45, 1);
  });

  it('handlePlay fires playing event and unpauses', () => {
    const p = new RemotePlaybackProxy();
    const spy = vi.fn();
    p.addEventListener('playing', spy);
    p.handlePlay();
    expect(spy).toHaveBeenCalledOnce();
    expect(p.paused).toBe(false);
  });

  it('handlePause fires pause event and pauses', () => {
    const p = new RemotePlaybackProxy();
    p.handlePlay();
    const spy = vi.fn();
    p.addEventListener('pause', spy);
    p.handlePause();
    expect(spy).toHaveBeenCalledOnce();
    expect(p.paused).toBe(true);
  });

  it('handleEnded fires ended exactly once', () => {
    const p = new RemotePlaybackProxy();
    const spy = vi.fn();
    p.addEventListener('ended', spy);
    p.handleEnded();
    p.handleEnded(); // should be a no-op
    expect(spy).toHaveBeenCalledOnce();
  });

  it('reset clears position and paused state', () => {
    const p = new RemotePlaybackProxy();
    p.updateState({ at: 50000, paused: false, duration: 120 });
    p.reset();
    expect(p.currentTime).toBe(0);
    expect(p.paused).toBe(true);
    expect(p.duration).toBe(0);
  });
});

describe('RemotePlaybackProxy — asVideoPlayerWrapper', () => {
  it('exposes video / currentTime / paused / duration', () => {
    const p = new RemotePlaybackProxy();
    p.updateState({ at: 10000, paused: true, duration: 60 });
    const wrap = p.asVideoPlayerWrapper();
    expect(wrap.video).toBe(p);
    expect(wrap.currentTime).toBeCloseTo(10, 1);
    expect(wrap.paused).toBe(true);
    expect(wrap.duration).toBe(60);
  });

  it('wrapper.video receives events dispatched on the proxy', () => {
    const p = new RemotePlaybackProxy();
    const wrap = p.asVideoPlayerWrapper();
    const spy = vi.fn();
    wrap.video.addEventListener('seeked', spy);
    p.seek(1000);
    expect(spy).toHaveBeenCalledOnce();
  });
});
