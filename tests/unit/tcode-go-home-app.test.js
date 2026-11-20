/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// app.js `_tcodeGoHome` (T-Code Go home, #384 uhntiss, #389 kissenpirat;
// Dave 2026-11-20): a playing video is paused first, or its next keyframe
// takes the axes straight back; the player pop-out is paused through its
// relay; a phone or headset driving playback is refused with a toast. The
// REAL method, lifted out of app.js (helpers/app-methods.js).
import { describe, it, expect, vi } from 'vitest';
import { liftAppClass } from './helpers/app-methods.js';

function make({ connected = true, player = 'local', paused = true, popout = false } = {}) {
  const toasts = [];
  const Lifted = liftAppClass(['_tcodeGoHome'], {
    showToast: (msg, kind) => toasts.push([msg, kind]),
    t: (k) => k,
  });
  const app = new Lifted();
  const video = { paused, pause: vi.fn(function () { this.paused = true; }) };
  app.videoPlayer = { video, get paused() { return video.paused; } };
  const proxy = { paused };
  app.tcodeManager = { connected };
  app.tcodeSync = {
    player: player === 'local' ? app.videoPlayer : proxy,
    goHome: vi.fn(() => ({ sent: true, positions: ['L0'], intensities: [] })),
  };
  app._playerWindowActive = popout;
  app._playerWindowPlayback = vi.fn(() => true);
  return { app, video, proxy, toasts };
}

describe('app.js _tcodeGoHome', () => {
  it('a paused video: straight to goHome, nothing else touched', async () => {
    const { app, video } = make({ paused: true });
    await expect(app._tcodeGoHome()).resolves.toEqual({ sent: true, positions: ['L0'], intensities: [] });
    expect(video.pause).not.toHaveBeenCalled();
    expect(app.tcodeSync.goHome).toHaveBeenCalledTimes(1);
  });

  it('a video playing in this window is paused first, then the axes go home', async () => {
    vi.useFakeTimers();
    const { app, video } = make({ paused: false });
    const p = app._tcodeGoHome();
    expect(video.pause).toHaveBeenCalledTimes(1);
    expect(app.tcodeSync.goHome, 'not before the pause reached the engine').not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    await p;
    expect(app.tcodeSync.goHome).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('the player pop-out playing: paused through its relay', async () => {
    vi.useFakeTimers();
    const { app, video } = make({ player: 'popout', paused: false, popout: true });
    const p = app._tcodeGoHome();
    expect(app._playerWindowPlayback).toHaveBeenCalledWith('pause');
    expect(video.pause).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    await p;
    expect(app.tcodeSync.goHome).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('a phone or headset driving playback: refused with a toast, nothing sent', async () => {
    const { app, toasts } = make({ player: 'remote', paused: false });
    await expect(app._tcodeGoHome()).resolves.toEqual({ sent: false, reason: 'driven-elsewhere' });
    expect(toasts).toEqual([['toast.tcodeGoHomePauseFirst', 'warn']]);
    expect(app.tcodeSync.goHome).not.toHaveBeenCalled();
  });

  it('T-Code not connected: nothing happens', async () => {
    const { app } = make({ connected: false });
    await expect(app._tcodeGoHome()).resolves.toEqual({ sent: false, reason: 'not-connected' });
    expect(app.tcodeSync.goHome).not.toHaveBeenCalled();
  });
});
