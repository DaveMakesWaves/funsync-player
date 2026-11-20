// A freshly loaded video starts paused and not ended (app test V12).
//
// jsdom on purpose (no node docblock): VideoPlayer builds on real DOM
// elements and imports i18n.js, which branches on `typeof window`. See
// notes/CLAUDE.md "Test environments".
//
// loadSource() used to reset only the centre overlay. Two visible results:
//   - after a clip ENDED, the next video showed Replay on the bar button, and
//     Space called replay(), which seeks to 0 and throws away the seek the
//     user had just made;
//   - when Up Next swapped the src on a PLAYING element, `load()` fired no
//     'pause', so the bar kept the Pause icon on a paused video.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VideoPlayer } from '../../renderer/js/video-player.js';
import { t } from '../../renderer/js/i18n.js';

function createPlayerDOM() {
  document.body.innerHTML = `
    <div id="player-container">
      <video id="video"></video>
      <div id="center-play-btn">
        <span class="center-play__icon--play"></span>
        <span class="center-play__icon--pause"></span>
        <span class="center-play__icon--replay" hidden></span>
      </div>
      <div id="player-controls">
        <button id="btn-play">
          <span class="icon-play"></span>
          <span class="icon-pause"></span>
          <span class="icon-replay" hidden></span>
        </button>
        <button id="btn-mute"><span class="icon-volume"></span><span class="icon-muted"></span></button>
        <input id="volume-slider" type="range" min="0" max="100" value="80" />
        <button id="btn-fullscreen"><span class="icon-expand"></span><span class="icon-compress"></span></button>
        <button id="btn-pip"></button>
        <span id="time-current">0:00</span>
        <span id="time-duration">0:00</span>
        <div id="progress-container" role="slider" aria-valuenow="0">
          <div id="buffered-bar"></div>
          <div id="progress-bar"></div>
          <div id="progress-thumb"></div>
          <div id="progress-tooltip"><span id="tooltip-time"></span></div>
        </div>
      </div>
    </div>
  `;
}

describe('VideoPlayer.loadSource resets the play state (V12)', () => {
  let player;
  let video;
  let btn;

  beforeEach(() => {
    createPlayerDOM();
    player = new VideoPlayer({
      videoElement: document.getElementById('video'),
      controlsElement: document.getElementById('player-controls'),
      containerElement: document.getElementById('player-container'),
    });
    video = player.video;
    btn = document.getElementById('btn-play');
    // jsdom implements no media pipeline: stub what loadSource/togglePlay call.
    video.load = vi.fn();
    video.play = vi.fn(() => Promise.resolve());
    video.pause = vi.fn();
    Object.defineProperty(video, 'paused', { configurable: true, get: () => true });
  });

  const visible = (sel) => !document.querySelector(sel).hidden;

  it('after the previous clip ended, the new video shows Play, not Replay', () => {
    video.dispatchEvent(new Event('ended'));
    expect(btn.getAttribute('aria-label')).toBe(t('player.replay'));

    player.loadSource('file:///D:/Lib/Alpha.mp4', 'Alpha.mp4');

    expect(btn.getAttribute('aria-label')).toBe(t('player.play'));
    expect(visible('#btn-play .icon-play')).toBe(true);
    expect(visible('#btn-play .icon-replay')).toBe(false);
    expect(visible('#btn-play .icon-pause')).toBe(false);
    expect(visible('.center-play__icon--replay')).toBe(false);
  });

  it("Space on the new video plays from the user's seek instead of replaying from 0", () => {
    video.dispatchEvent(new Event('ended'));
    player.loadSource('file:///D:/Lib/Alpha.mp4', 'Alpha.mp4');
    video.currentTime = 5; // the user's ArrowRight

    player.togglePlay();

    expect(video.play).toHaveBeenCalledTimes(1);
    expect(video.currentTime).toBe(5);
  });

  // R3 fix-up (real-app verifier 2, also in v0.9.2): after the end, a seek
  // back (ArrowLeft, the seek bar) and Space restarted from 0:00, and the
  // bar still said Replay: `_ended` was cleared only by play, a load or
  // replay, never by a seek.
  it('a seek back after the end: the bar says Play, and Space plays from the seek', () => {
    let ended = true;
    Object.defineProperty(video, 'ended', { configurable: true, get: () => ended });
    video.dispatchEvent(new Event('ended'));
    expect(btn.getAttribute('aria-label')).toBe(t('player.replay'));

    ended = false;
    video.currentTime = 2;
    video.dispatchEvent(new Event('seeked'));
    expect(btn.getAttribute('aria-label')).toBe(t('player.play'));
    expect(visible('#btn-play .icon-replay')).toBe(false);
    expect(visible('.center-play__icon--replay')).toBe(false);

    player.togglePlay();
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(video.currentTime).toBe(2);
  });

  it('a seek that lands on the end again keeps Replay', () => {
    Object.defineProperty(video, 'ended', { configurable: true, get: () => true });
    video.dispatchEvent(new Event('ended'));
    video.dispatchEvent(new Event('seeked'));
    expect(btn.getAttribute('aria-label')).toBe(t('player.replay'));
  });

  it('a src swap on a playing element (Up Next) shows Play, not Pause', () => {
    video.dispatchEvent(new Event('play'));
    expect(btn.getAttribute('aria-label')).toBe(t('player.pause'));

    // load() fires no 'pause', so nothing else would reset the button.
    player.loadSource('file:///D:/Lib/Bravo.mp4', 'Bravo.mp4');

    expect(btn.getAttribute('aria-label')).toBe(t('player.play'));
    expect(visible('#btn-play .icon-play')).toBe(true);
    expect(visible('#btn-play .icon-pause')).toBe(false);
  });
});
