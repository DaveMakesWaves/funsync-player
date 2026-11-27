/**
 * @vitest-environment jsdom
 * jsdom: the REAL ProgressBar builds the strip in the page.
 */
// The frame strip along the seek bar (powerkool #433, 2026-11-23; opt-in,
// player.seekFrameStrip). The REAL ProgressBar with its hidden preview
// <video> faked (jsdom cannot decode): one seek per frame at each frame's
// centre time, the hover's preview always first, a local file only, off
// removes it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ProgressBar } from '../../renderer/js/progress-bar.js';

let container;
let bar;
let seeks;

function fakeVideo(v) {
  seeks = [];
  Object.defineProperty(v, 'duration', { configurable: true, get: () => 16 });
  Object.defineProperty(v, 'videoWidth', { configurable: true, get: () => 1600 });
  Object.defineProperty(v, 'videoHeight', { configurable: true, get: () => 900 });
  Object.defineProperty(v, 'currentTime', { configurable: true, get: () => seeks.at(-1) ?? 0, set: (t) => { seeks.push(t); } });
  v.pause = () => {};
  v.load = () => {};
}
const seeked = () => bar._thumbVideo.dispatchEvent(new Event('seeked'));

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="progress-container"></div><div id="progress-tooltip"></div><div id="tooltip-thumbnail"></div>';
  container = document.getElementById('progress-container');
  container.getBoundingClientRect = () => ({ width: 600, height: 24, left: 0, top: 0, right: 600, bottom: 24 });
  bar = new ProgressBar({ containerElement: container, videoPlayer: {}, backendPort: 0 });
});
afterEach(() => { vi.useRealTimers(); });

function load(src) {
  bar.setVideoSource(src);
  fakeVideo(bar._thumbVideo);
  bar._thumbVideo.dispatchEvent(new Event('loadeddata'));
}

describe('the frame strip', () => {
  it('off by default: nothing is built', () => {
    load('file:///C:/v.mp4');
    expect(container.querySelector('.progress__frame-strip')).toBeNull();
  });

  it('on: as many frames as fit, each drawn from one seek at its centre time, one after another', () => {
    bar.setFrameStrip(true);
    load('file:///C:/v.mp4');
    const frames = container.querySelectorAll('.progress__frame');
    // 600 px / (40 px tall at 16:9 = 71 px) = 8 frames over 16 s: centres 1, 3, 5 ... 15 s.
    expect(frames).toHaveLength(8);
    expect(container.classList.contains('has-frame-strip')).toBe(true);
    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(100);
      expect(seeks.at(-1)).toBeCloseTo(1 + i * 2, 5);
      seeked();
    }
    expect(bar.frameStripState()).toMatchObject({ count: 8, drawn: 8 });
    expect(seeks).toHaveLength(8);
  });

  it('a hover goes first: the strip waits while the user is pointing at the bar', () => {
    bar.setFrameStrip(true);
    load('file:///C:/v.mp4');
    vi.advanceTimersByTime(10);
    seeked(); // frame 1 drawn
    bar.updateThumbnailPreview(9); // the user hovers (the preview's own 150 ms throttle applies)
    vi.advanceTimersByTime(200);
    expect(seeks.at(-1)).toBe(9); // the hover's seek, not the strip's next frame
    seeked();
    vi.advanceTimersByTime(150);
    expect(seeks.at(-1)).toBe(9); // still quiet: inside the 400 ms after the hover
    vi.advanceTimersByTime(300);
    expect(seeks.at(-1)).toBeCloseTo(3, 5); // the strip carries on with frame 2
  });

  it('a stream never gets a strip (it would be downloaded again frame by frame)', () => {
    bar.setFrameStrip(true);
    load('https://example.com/v.mp4');
    expect(container.querySelector('.progress__frame-strip')).toBeNull();
  });

  it('turned off: the strip and its room go at once', () => {
    bar.setFrameStrip(true);
    load('file:///C:/v.mp4');
    bar.setFrameStrip(false);
    expect(container.querySelector('.progress__frame-strip')).toBeNull();
    expect(container.classList.contains('has-frame-strip')).toBe(false);
  });
});
