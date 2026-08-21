/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Pins the RemotePlaybackProxy liveness watchdog (2026-08-18). The
// currentTime getter extrapolates `lastKnown + elapsed` with no cap, so a
// phone that goes silent WITHOUT sending a pause (dead socket before the
// backend's grace fires, hidden page with timeupdate starved) left the sync
// engines driving devices along a timeline the video had already left —
// indefinitely. No state for STALE_LIMIT_MS while unpaused must synthesize
// a pause; fresh state must resume through the normal transition. The
// pop-out player proxy shares this class at a 100ms tick cadence, so the
// 2s limit must never trip under healthy update rates.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RemotePlaybackProxy } from '../../renderer/js/remote-playback-proxy.js';

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('RemotePlaybackProxy — stale watchdog', () => {
  it('synthesizes a pause after STALE_LIMIT_MS of silence while playing', () => {
    const p = new RemotePlaybackProxy();
    const pauseSpy = vi.fn();
    p.addEventListener('pause', pauseSpy);
    p.updateState({ at: 10000, paused: false });
    vi.advanceTimersByTime(RemotePlaybackProxy.STALE_LIMIT_MS + 600);
    expect(p.paused).toBe(true);
    expect(pauseSpy).toHaveBeenCalledOnce();
  });

  it('stops extrapolating currentTime once the stale pause fires', () => {
    const p = new RemotePlaybackProxy();
    p.updateState({ at: 10000, paused: false });
    vi.advanceTimersByTime(RemotePlaybackProxy.STALE_LIMIT_MS + 600);
    const frozen = p.currentTime;
    vi.advanceTimersByTime(30000);
    expect(p.currentTime).toBe(frozen);
  });

  it('never trips while healthy state keeps arriving (250ms phone cadence)', () => {
    const p = new RemotePlaybackProxy();
    const pauseSpy = vi.fn();
    p.addEventListener('pause', pauseSpy);
    p.updateState({ at: 0, paused: false });
    for (let i = 1; i <= 40; i++) { // 10s of healthy updates
      vi.advanceTimersByTime(250);
      p.updateState({ at: i * 250, paused: false });
    }
    expect(p.paused).toBe(false);
    expect(pauseSpy).not.toHaveBeenCalled();
  });

  it('resumes through the normal transition when fresh unpaused state arrives', () => {
    const p = new RemotePlaybackProxy();
    const playingSpy = vi.fn();
    p.updateState({ at: 10000, paused: false });
    vi.advanceTimersByTime(RemotePlaybackProxy.STALE_LIMIT_MS + 600);
    expect(p.paused).toBe(true);
    p.addEventListener('playing', playingSpy);
    p.updateState({ at: 14000, paused: false });
    expect(p.paused).toBe(false);
    expect(playingSpy).toHaveBeenCalledOnce();
    // and the re-armed watchdog still works for a second silence
    const pauseSpy = vi.fn();
    p.addEventListener('pause', pauseSpy);
    vi.advanceTimersByTime(RemotePlaybackProxy.STALE_LIMIT_MS + 600);
    expect(pauseSpy).toHaveBeenCalledOnce();
  });

  it('an explicit phone pause disarms it (no double pause event)', () => {
    const p = new RemotePlaybackProxy();
    const pauseSpy = vi.fn();
    p.addEventListener('pause', pauseSpy);
    p.updateState({ at: 10000, paused: false });
    p.handlePause();
    expect(pauseSpy).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(60000);
    expect(pauseSpy).toHaveBeenCalledOnce();
  });

  it('reset() disarms it', () => {
    const p = new RemotePlaybackProxy();
    const pauseSpy = vi.fn();
    p.addEventListener('pause', pauseSpy);
    p.updateState({ at: 10000, paused: false });
    p.reset();
    vi.advanceTimersByTime(60000);
    expect(pauseSpy).not.toHaveBeenCalled();
  });

  it('play() arms it too (pop-out handlePlay path)', () => {
    const p = new RemotePlaybackProxy();
    const pauseSpy = vi.fn();
    p.addEventListener('pause', pauseSpy);
    p.handlePlay();
    vi.advanceTimersByTime(RemotePlaybackProxy.STALE_LIMIT_MS + 600);
    expect(pauseSpy).toHaveBeenCalledOnce();
    expect(p.paused).toBe(true);
  });
});
