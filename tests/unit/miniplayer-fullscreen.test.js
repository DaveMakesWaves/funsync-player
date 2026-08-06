// Regression: the "stuck player, had to kill the app" bug.
//
// Reported by zaikechi (EroScripts #229, 2026-08-05): "I couldn't actually
// exit the play view and go back to the folder/lib view. I hit the back
// arrow but the player went to fully screen mode I think? and the back
// arrow went away, but then there was the X in the upper right, hit that
// and the back arrow appeared again, and it would then just keep flip
// flopping between the modes. I believe I had to exit the app to reset it."
//
// MECHANISM. Nothing in the navigation path ever exited OS fullscreen — the
// only exitFullscreen() call was the user-initiated toggle. So leaving the
// player while fullscreen left the container as `document.fullscreenElement`
// while the mini-player docked on top of it. A fullscreen element fills the
// display regardless of its CSS box, so the corner overlay rendered full
// screen, `.player-container--mini` hid `.player__top-bar` (taking the back
// arrow with it), and only the mini's expand/close buttons remained. Expand
// restored the arrow, Back re-docked the mini and removed it again: the
// two-state loop, over a library the fullscreen element was covering.
//
// Two independent routes in, so two guards and two sets of tests:
//   1. Leaving the player view      → exitFullscreenForNav()
//   2. Pressing F while mini docked → toggleFullscreen() refuses
//      (the keyboard handler has NO view gating, so F fires while the user
//      is browsing the library with a video docked in the corner)

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { exitFullscreenForNav } from '../../renderer/js/miniplayer.js';
import { VideoPlayer } from '../../renderer/js/video-player.js';

const MINI = 'player-container--mini';

describe('exitFullscreenForNav — route 1: leaving the player view', () => {
  it('exits when the document is in fullscreen', () => {
    const exitFullscreen = vi.fn(() => Promise.resolve());
    const doc = { fullscreenElement: {}, exitFullscreen };
    expect(exitFullscreenForNav(doc)).toBe(true);
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when not fullscreen (the common case)', () => {
    const exitFullscreen = vi.fn();
    const doc = { fullscreenElement: null, exitFullscreen };
    expect(exitFullscreenForNav(doc)).toBe(false);
    expect(exitFullscreen).not.toHaveBeenCalled();
  });

  it('swallows a rejected exit — navigation must not break on it', async () => {
    // exitFullscreen() rejects if the document is not actually fullscreen.
    // This runs on a teardown path, so an unhandled rejection here would
    // surface as a broken Back button.
    const doc = { fullscreenElement: {}, exitFullscreen: () => Promise.reject(new Error('not fullscreen')) };
    expect(() => exitFullscreenForNav(doc)).not.toThrow();
    await Promise.resolve();
  });

  it('swallows a synchronous throw', () => {
    const doc = { fullscreenElement: {}, exitFullscreen: () => { throw new Error('denied'); } };
    expect(exitFullscreenForNav(doc)).toBe(false);
  });

  it('tolerates a document with no exitFullscreen at all', () => {
    expect(exitFullscreenForNav({ fullscreenElement: {} })).toBe(false);
    expect(exitFullscreenForNav(null)).toBe(false);
  });
});

describe('toggleFullscreen — route 2: F pressed while the mini-player is docked', () => {
  let player;
  let container;
  let requestFullscreen;

  beforeEach(() => {
    // Mirrors the scaffold in video-player.test.js — VideoPlayer caches all
    // of these in its constructor and throws on a missing one.
    document.body.innerHTML = `
      <div id="player-container">
        <video id="video"></video>
        <div id="center-play-btn">
          <span class="center-play__icon--play"></span>
          <span class="center-play__icon--pause"></span>
        </div>
        <div id="player-controls">
          <button id="btn-play">
            <span class="icon-play"></span>
            <span class="icon-pause"></span>
          </button>
          <button id="btn-mute">
            <span class="icon-volume"></span>
            <span class="icon-muted"></span>
          </button>
          <input id="volume-slider" type="range" min="0" max="100" value="80" />
          <button id="btn-fullscreen">
            <span class="icon-expand"></span>
            <span class="icon-compress"></span>
          </button>
          <button id="btn-pip"></button>
          <span id="time-current">0:00</span>
          <span id="time-duration">0:00</span>
          <div id="progress-container" role="slider" aria-valuenow="0">
            <div id="buffered-bar"></div>
            <div id="progress-bar"></div>
            <div id="progress-thumb"></div>
            <div id="progress-tooltip"><span id="tooltip-time"></span></div>
          </div>
          <span id="resolution-badge" hidden></span>
        </div>
      </div>`;
    container = document.getElementById('player-container');
    requestFullscreen = vi.fn(() => Promise.resolve());
    container.requestFullscreen = requestFullscreen;
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true, writable: true, value: null,
    });
    player = new VideoPlayer({
      videoElement: document.getElementById('video'),
      controlsElement: document.getElementById('player-controls'),
      containerElement: container,
    });
  });

  it('REFUSES to fullscreen while docked as the mini-player', async () => {
    container.classList.add(MINI);
    await player.toggleFullscreen();
    // The whole bug: this call used to succeed, blowing the corner overlay
    // up to full screen with its top bar (and back arrow) hidden.
    expect(requestFullscreen).not.toHaveBeenCalled();
    expect(document.fullscreenElement).toBeNull();
  });

  it('still fullscreens normally when NOT docked', async () => {
    await player.toggleFullscreen();
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
  });

  it('can still EXIT fullscreen even if the mini class is somehow set', async () => {
    // The guard must only block ENTERING. Blocking the exit too would trap
    // the user in exactly the state this fix exists to prevent.
    const exitFullscreen = vi.fn(() => Promise.resolve());
    document.fullscreenElement = container;
    document.exitFullscreen = exitFullscreen;
    container.classList.add(MINI);
    await player.toggleFullscreen();
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
  });
});
