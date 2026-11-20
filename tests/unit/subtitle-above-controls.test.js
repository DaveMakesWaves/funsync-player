// R4-05 (2026-11-06, cosmetic, probably also in v0.9.2): subtitle text was
// drawn over the player's control bar while the controls showed (sandbox
// shot 33-drop-loaded.png: "DROP SUBTITLE LINE" over the bottom bar icons).
// The bar overlays the bottom of the video and the browser draws a cue at
// the bottom of the video box.
//
// jsdom on purpose (no node docblock): VideoPlayer builds on real DOM
// elements and imports i18n.js, which branches on `typeof window`. See
// notes/CLAUDE.md "Test environments".
//
// jsdom has no media pipeline or VTT renderer, so the text tracks and cues
// here are fakes with the TextTrack / VTTCue fields the player sets, and
// layout comes from stubbed offsets (a 1280x720 player, bar top at 596 px:
// the numbers a headless Electron window measured on the real CSS). What is
// asserted is what the browser is told: where each cue goes, and that it
// gets its own placement back. The pixels were checked in that window
// (scratch measurement, see notes/UPDATES.md R4-05).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VideoPlayer } from '../../renderer/js/video-player.js';

class FakeCue {
  constructor(startTime, endTime, text) {
    Object.assign(this, {
      startTime, endTime, text, id: '', pauseOnExit: false,
      line: 'auto', snapToLines: true, position: 'auto', size: 100, align: 'center', vertical: '',
      track: null,
    });
  }
}

class FakeTrack extends EventTarget {
  constructor(cues) {
    super();
    this.mode = 'showing';
    this.cues = [];
    for (const c of cues) this.addCue(c);
    this.activeCues = [this.cues[0]];
  }
  addCue(cue) { cue.track = this; this.cues.push(cue); }
  removeCue(cue) {
    this.cues = this.cues.filter((c) => c !== cue);
    this.activeCues = this.activeCues.filter((c) => c !== cue);
    cue.track = null;
  }
}

function createPlayerDOM() {
  document.body.innerHTML = `
    <div id="player-container">
      <div id="video-wrapper"><video id="video"></video></div>
      <div id="center-play-btn">
        <span class="center-play__icon--play"></span>
        <span class="center-play__icon--pause"></span>
        <span class="center-play__icon--replay" hidden></span>
      </div>
      <div id="player-controls">
        <button id="btn-play"><span class="icon-play"></span><span class="icon-pause"></span><span class="icon-replay" hidden></span></button>
        <button id="btn-mute"><span class="icon-volume"></span><span class="icon-muted"></span></button>
        <input id="volume-slider" type="range" min="0" max="100" value="80" />
        <button id="btn-fullscreen"><span class="icon-expand"></span><span class="icon-compress"></span></button>
        <button id="btn-pip"></button>
        <span id="time-current">0:00</span>
        <span id="time-duration">0:00</span>
        <div id="progress-container" role="slider" aria-valuenow="0">
          <div id="buffered-bar"></div><div id="progress-bar"></div><div id="progress-thumb"></div>
          <div id="progress-tooltip"><span id="tooltip-time"></span></div>
        </div>
      </div>
      <div class="inline-viz" hidden></div>
    </div>
  `;
}

const define = (el, key, value) => Object.defineProperty(el, key, { configurable: true, get: () => value });

let player;
let video;
let container;
let track;
let cue;
let paused;

beforeEach(() => {
  vi.useFakeTimers();
  globalThis.VTTCue = FakeCue;
  createPlayerDOM();
  player = new VideoPlayer({
    videoElement: document.getElementById('video'),
    controlsElement: document.getElementById('player-controls'),
    containerElement: document.getElementById('player-container'),
  });
  video = player.video;
  container = player.container;
  paused = false; // playing: the bar hides 1.5 s after the pointer stops
  define(video, 'paused', undefined);
  Object.defineProperty(video, 'paused', { configurable: true, get: () => paused });
  // The layout a 1280x720 player has (measured): video box 720 px high,
  // control bar from 596 px.
  define(video, 'clientHeight', 720);
  define(player.controls, 'offsetTop', 596);
  cue = new FakeCue(0, 3, 'DROP SUBTITLE LINE');
  track = new FakeTrack([cue, new FakeCue(3, 6, 'LATER LINE')]);
  define(video, 'textTracks', Object.assign([track], { length: 1 }));
});

afterEach(() => {
  vi.useRealTimers();
  delete globalThis.VTTCue;
});

/** Where the bar keeps a cue box: line·H + (1 − line)·box ≤ 596 − 6, for a two-line box. */
const EXPECTED_LINE = 79.48;

function showBar() { player._showControls(); }
function hideBar() { vi.advanceTimersByTime(1600); }

describe('R4-05: subtitle cues stay above the control bar while it shows', () => {
  it('the bar shows: the cue on screen moves above it', () => {
    showBar();
    expect(cue.snapToLines).toBe(false);
    expect(cue.line).toBeCloseTo(EXPECTED_LINE, 1);
    // Its box bottom (anchored proportionally, as Chromium does) clears the bar.
    const H = 720; const box = 0.12 * H;
    expect((cue.line / 100) * H + (1 - cue.line / 100) * box).toBeLessThanOrEqual(596 - 6 + 0.5);
  });

  it('the bar hides: the cue gets its own placement back (a fresh copy, same text and timing)', () => {
    showBar();
    hideBar();
    expect(container.classList.contains('controls-visible')).toBe(false);
    const back = track.cues.find((c) => c.text === 'DROP SUBTITLE LINE');
    expect(back).not.toBe(cue); // replaced: Chromium left an in-place restore a line short
    expect(back.line).toBe('auto');
    expect(back.snapToLines).toBe(true);
    expect([back.startTime, back.endTime]).toEqual([0, 3]);
    expect(track.cues).toHaveLength(2);
  });

  it('show, hide, show again: lifted again, from where the browser put it', () => {
    showBar();
    hideBar();
    const back = track.cues.find((c) => c.text === 'DROP SUBTITLE LINE');
    track.activeCues = [back];
    showBar();
    expect(back.snapToLines).toBe(false);
    expect(back.line).toBeCloseTo(EXPECTED_LINE, 1);
  });

  it('a cue coming up while the bar shows is lifted too (the loaded track\'s cuechange)', async () => {
    // loadSubtitles adds a <track>; its TextTrack is the fake (jsdom has none).
    const createObjectURL = URL.createObjectURL;
    URL.createObjectURL = () => 'blob:subs';
    const desc = Object.getOwnPropertyDescriptor(HTMLTrackElement.prototype, 'track');
    Object.defineProperty(HTMLTrackElement.prototype, 'track', { configurable: true, get: () => track });
    try {
      await player.loadSubtitles({ name: 'drop.srt', textContent: '1\r\n00:00:00,000 --> 00:00:03,000\r\nDROP SUBTITLE LINE\r\n' });
      expect(track.mode).toBe('showing');
      // The browser parses the file into cues (clearSubtitles emptied the fake).
      const later = new FakeCue(3, 6, 'LATER LINE');
      track.addCue(cue);
      track.addCue(later);
      track.activeCues = [cue];
      showBar();
      track.activeCues = [later];
      track.dispatchEvent(new Event('cuechange'));
      expect(later.snapToLines).toBe(false);
      expect(later.line).toBeCloseTo(EXPECTED_LINE, 1);
    } finally {
      URL.createObjectURL = createObjectURL;
      if (desc) Object.defineProperty(HTMLTrackElement.prototype, 'track', desc);
      else delete HTMLTrackElement.prototype.track;
    }
  });

  it('a cue its file places (line 0, the top of the frame) is left where it is', () => {
    cue.line = 0;
    showBar();
    expect(cue.line).toBe(0);
    expect(cue.snapToLines).toBe(true);
  });

  it('the inline heatmap / timeline showing above the bar: the cue goes above that', () => {
    const viz = container.querySelector('.inline-viz');
    viz.hidden = false;
    define(viz, 'offsetHeight', 60);
    define(viz, 'offsetTop', 536);
    showBar();
    const H = 720; const box = 0.12 * H;
    expect((cue.line / 100) * H + (1 - cue.line / 100) * box).toBeLessThanOrEqual(536 - 6 + 0.5);
    expect(cue.line).toBeLessThan(EXPECTED_LINE);
  });

  it('a paused video keeps the bar, and the cue stays lifted', () => {
    paused = true;
    showBar();
    vi.advanceTimersByTime(5000);
    expect(container.classList.contains('controls-visible')).toBe(true);
    expect(cue.snapToLines).toBe(false);
  });

  it('a hidden player (nothing laid out) moves nothing', () => {
    define(video, 'clientHeight', 0);
    showBar();
    expect(cue.line).toBe('auto');
    expect(cue.snapToLines).toBe(true);
  });
});

// R4 fix-up (real-app verifier 1, cosmetic, new since v0.9.2 with R4-03 and
// R4-05 together): with the queue panel open the Up Next card sits left of
// the panel, above the bar, and the cue lifted to just above the bar lay in
// its band: "VTT CUE LINE ONE visible text" was cut off from x 620 at 1280
// wide, and hidden almost entirely at 900. The card counts as something the
// cue goes above while both show; the app places the cues again when the card
// shows or goes (`refreshCuePlacement`, app.js onShowNext / onShowEndOfList /
// onHide).
describe('R4 fix-up: a lifted cue goes above the Up Next card too', () => {
  // The card: `bottom: 100px`, about 116 px tall, in the 720 px player.
  const CARD_TOP = 720 - 100 - 116;
  let card;
  beforeEach(() => {
    card = document.createElement('div');
    card.id = 'up-next-card';
    card.className = 'up-next';
    card.hidden = true;
    container.appendChild(card);
    define(card, 'offsetHeight', 116);
    define(card, 'offsetTop', CARD_TOP);
  });
  const boxBottom = (line) => { const H = 720; const box = 0.12 * H; return (line / 100) * H + (1 - line / 100) * box; };

  it('the card shows while the bar is up: the cue moves above the card, then back above the bar when it goes', () => {
    showBar();
    expect(cue.line).toBeCloseTo(EXPECTED_LINE, 1);
    card.hidden = false; // upNextCard.show(...)
    player.refreshCuePlacement();
    expect(boxBottom(cue.line)).toBeLessThanOrEqual(CARD_TOP - 6 + 0.5);
    expect(cue.line).toBeLessThan(EXPECTED_LINE);
    card.hidden = true; // upNextCard.hide()
    player.refreshCuePlacement();
    expect(cue.line).toBeCloseTo(EXPECTED_LINE, 1);
  });

  it('the bar shows while the card is up: the cue goes straight above the card', () => {
    card.hidden = false;
    showBar();
    expect(boxBottom(cue.line)).toBeLessThanOrEqual(CARD_TOP - 6 + 0.5);
  });

  it('the bar hidden: the card moves nothing (the cue is at the bottom, under the card\'s band)', () => {
    card.hidden = false;
    player.refreshCuePlacement();
    expect(cue.line).toBe('auto');
    expect(cue.snapToLines).toBe(true);
  });
});
