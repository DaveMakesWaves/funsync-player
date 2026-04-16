// Unit tests for VideoPlayer — imports from real source
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { formatTime, VideoPlayer } from '../../renderer/js/video-player.js';

// --- formatTime standalone export ---

describe('formatTime', () => {
  it('formats zero seconds', () => {
    expect(formatTime(0)).toBe('0:00');
  });

  it('formats seconds under a minute', () => {
    expect(formatTime(45)).toBe('0:45');
  });

  it('formats minutes and seconds', () => {
    expect(formatTime(125)).toBe('2:05');
  });

  it('formats hours', () => {
    expect(formatTime(3661)).toBe('1:01:01');
  });

  it('handles NaN', () => {
    expect(formatTime(NaN)).toBe('0:00');
  });

  it('handles Infinity', () => {
    expect(formatTime(Infinity)).toBe('0:00');
  });

  it('handles negative Infinity', () => {
    expect(formatTime(-Infinity)).toBe('0:00');
  });
});

// --- VideoPlayer class (needs full DOM scaffold) ---

function createPlayerDOM() {
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
          <div id="progress-tooltip">
            <span id="tooltip-time"></span>
          </div>
        </div>
        <span id="resolution-badge" hidden></span>
      </div>
    </div>
  `;
}

describe('VideoPlayer', () => {
  let player;

  beforeEach(() => {
    createPlayerDOM();
    player = new VideoPlayer({
      videoElement: document.getElementById('video'),
      controlsElement: document.getElementById('player-controls'),
      containerElement: document.getElementById('player-container'),
    });
  });

  describe('setVolume', () => {
    it('sets video volume', () => {
      player.setVolume(0.6);
      expect(player.video.volume).toBeCloseTo(0.6);
    });

    it('clamps to 0-1', () => {
      player.setVolume(1.5);
      expect(player.video.volume).toBe(1);
      player.setVolume(-0.5);
      expect(player.video.volume).toBe(0);
    });

    it('updates volume slider', () => {
      player.setVolume(0.75);
      expect(player.volumeSlider.value).toBe('75');
    });
  });

  describe('toggleMute', () => {
    it('mutes when unmuted', () => {
      player.video.muted = false;
      player.toggleMute();
      expect(player.video.muted).toBe(true);
    });

    it('unmutes when muted', () => {
      player.video.muted = true;
      player.toggleMute();
      expect(player.video.muted).toBe(false);
    });
  });

  describe('seek', () => {
    it('sets currentTime within bounds', () => {
      Object.defineProperty(player.video, 'duration', { value: 100, configurable: true });
      player.seek(50);
      expect(player.video.currentTime).toBe(50);
    });

    it('ignores out of bounds seek', () => {
      Object.defineProperty(player.video, 'duration', { value: 100, configurable: true });
      player.video.currentTime = 50;
      player.seek(-10);
      expect(player.video.currentTime).toBe(50);
    });

    it('ignores NaN time', () => {
      player.video.currentTime = 10;
      player.seek(NaN);
      expect(player.video.currentTime).toBe(10);
    });
  });

  describe('skip', () => {
    it('skips forward', () => {
      Object.defineProperty(player.video, 'duration', { value: 100, configurable: true });
      player.video.currentTime = 10;
      player.skip(5);
      expect(player.video.currentTime).toBe(15);
    });

    it('skips backward', () => {
      Object.defineProperty(player.video, 'duration', { value: 100, configurable: true });
      player.video.currentTime = 10;
      player.skip(-5);
      expect(player.video.currentTime).toBe(5);
    });
  });

  describe('setFps', () => {
    it('stores valid fps', () => {
      player.setFps(24);
      expect(player._fps).toBe(24);
    });

    it('ignores invalid fps', () => {
      player.setFps(-1);
      expect(player._fps).toBeUndefined();
      player.setFps(0);
      expect(player._fps).toBeUndefined();
      player.setFps(Infinity);
      expect(player._fps).toBeUndefined();
    });

    it('uses stored fps for frame stepping', () => {
      player.setFps(60);
      expect(player._estimateFps()).toBe(60);
    });

    it('defaults to 30fps without setFps', () => {
      expect(player._estimateFps()).toBe(30);
    });
  });

  describe('cycleAspectRatio', () => {
    it('cycles through 4 modes', () => {
      // Default is 'contain' (index 0)
      player.cycleAspectRatio(); // → 'cover' (index 1)
      expect(player.video.style.objectFit).toBe('cover');

      player.cycleAspectRatio(); // → '16 / 9' (index 2)
      expect(player.video.style.aspectRatio).toBe('16 / 9');
      expect(player.video.style.objectFit).toBe('contain');

      player.cycleAspectRatio(); // → '4 / 3' (index 3)
      expect(player.video.style.aspectRatio).toBe('4 / 3');

      player.cycleAspectRatio(); // → 'contain' (index 0)
      expect(player.video.style.objectFit).toBe('contain');
      expect(player.video.style.aspectRatio).toBe('');
    });
  });

  describe('A-B loop', () => {
    it('sets loop point A', () => {
      player.video.currentTime = 10;
      player.setLoopPoint('a');
      expect(player._abLoop.a).toBe(10);
    });

    it('sets loop point B', () => {
      player.video.currentTime = 20;
      player.setLoopPoint('b');
      expect(player._abLoop.b).toBe(20);
    });

    it('clears A-B loop', () => {
      player.setLoopPoint('a');
      player.setLoopPoint('b');
      player.clearAbLoop();
      expect(player._abLoop.a).toBeNull();
      expect(player._abLoop.b).toBeNull();
    });
  });

  describe('_formatTime delegates to formatTime', () => {
    it('returns same result as standalone formatTime', () => {
      expect(player._formatTime(125)).toBe(formatTime(125));
      expect(player._formatTime(3661)).toBe(formatTime(3661));
      expect(player._formatTime(NaN)).toBe(formatTime(NaN));
    });
  });

  describe('paused / currentTime / duration getters', () => {
    it('paused reflects video state', () => {
      expect(player.paused).toBe(true);
    });

    it('currentTime reflects video state', () => {
      player.video.currentTime = 42;
      expect(player.currentTime).toBe(42);
    });
  });
});
