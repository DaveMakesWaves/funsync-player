/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL VideoPlayer is built on the player bar's markup
 * and listens for `fullscreenchange` on `document`; i18n.js branches on
 * `typeof window` (notes/CLAUDE.md "Test environments").
 */
// Block C fix-up (2026-11-06, real-app verifier 1; also in v0.9.2): in
// fullscreen the Fullscreen button's visible label and its tooltip still read
// "Fullscreen". Only the icon and the aria-label switched to "Exit
// fullscreen" (video-player.js _updateFullscreenButton never touched
// .control-btn__label or title). Asserted on what the user reads and hovers,
// in English and German, and after a language switch while in fullscreen.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests, translatePage } from '../../renderer/js/i18n.js';
import { VideoPlayer } from '../../renderer/js/video-player.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const DE = JSON.parse(fs.readFileSync('renderer/locales/de.json', 'utf8'));

let added = [];
let realAdd;
let fsElement = null;
beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  added = [];
  realAdd = document.addEventListener.bind(document);
  vi.spyOn(document, 'addEventListener').mockImplementation((type, fn, opts) => {
    added.push([type, fn, opts]);
    realAdd(type, fn, opts);
  });
  fsElement = null;
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fsElement });
  // The bar as index.html builds it (the parts VideoPlayer reads).
  document.body.innerHTML = `
    <div id="player-container">
      <video id="video"></video>
      <div id="center-play-btn"><span class="center-play__icon--play"></span><span class="center-play__icon--pause"></span></div>
      <div id="player-controls">
        <div id="progress-container" role="slider" tabindex="0"><div id="buffered-bar"></div><div id="progress-bar"></div><div id="progress-thumb"></div><div id="progress-tooltip"><span id="tooltip-time"></span></div></div>
        <button id="btn-play"><span class="icon-play"></span><span class="icon-pause"></span></button>
        <button id="btn-mute"><span class="icon-volume"></span><span class="icon-muted"></span></button>
        <input type="range" id="volume-slider" min="0" max="100" value="100">
        <span id="time-current">0:00</span><span id="time-duration">0:00</span>
        <button id="btn-pip"></button>
        <button id="btn-fullscreen" class="control-btn control-btn--labelled" data-i18n-aria-label="player.fullscreen" data-i18n-title="player.fullscreen" aria-label="Fullscreen" title="Fullscreen (F)">
          <span class="icon-expand"></span>
          <span class="icon-compress" hidden></span>
          <span class="control-btn__label" data-i18n="player.fullscreen">Fullscreen</span>
        </button>
        <span id="resolution-badge" hidden></span>
      </div>
    </div>`;
});
afterEach(() => {
  for (const [type, fn, opts] of added) document.removeEventListener(type, fn, opts);
  vi.restoreAllMocks();
  delete document.fullscreenElement;
  _setBundlesForTests('en', EN, EN);
});

function makePlayer() {
  return new VideoPlayer({
    videoElement: document.getElementById('video'),
    controlsElement: document.getElementById('player-controls'),
    containerElement: document.getElementById('player-container'),
  });
}

const btn = () => document.getElementById('btn-fullscreen');
const shown = () => ({
  label: btn().querySelector('.control-btn__label').textContent,
  title: btn().getAttribute('title'),
  aria: btn().getAttribute('aria-label'),
});
function goFullscreen(on) {
  fsElement = on ? document.getElementById('player-container') : null;
  document.dispatchEvent(new Event('fullscreenchange'));
}

describe('the Fullscreen button says what it will do', () => {
  it('in fullscreen: "Exit fullscreen" on the label, the tooltip and the aria-label; back out: "Fullscreen"', () => {
    makePlayer();
    goFullscreen(true);
    expect(shown()).toEqual({ label: EN.player.exitFullscreen, title: EN.player.exitFullscreen, aria: EN.player.exitFullscreen });
    goFullscreen(false);
    expect(shown()).toEqual({ label: EN.player.fullscreen, title: EN.player.fullscreen, aria: EN.player.fullscreen });
  });

  it('in German too, and a language switch while in fullscreen keeps "Exit fullscreen"', () => {
    makePlayer();
    goFullscreen(true);
    _setBundlesForTests('de', DE, EN);
    translatePage(document);
    expect(shown()).toEqual({ label: DE.player.exitFullscreen, title: DE.player.exitFullscreen, aria: DE.player.exitFullscreen });
    goFullscreen(false);
    expect(shown().label).toBe(DE.player.fullscreen);
  });
});
