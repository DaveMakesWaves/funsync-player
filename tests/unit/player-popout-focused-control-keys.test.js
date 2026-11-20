/**
 * @vitest-environment jsdom
 * jsdom on purpose: this imports the REAL pop-out renderer
 * (renderer/player-popout.js), which builds its VideoPlayer and controls on
 * the DOM of player-popout.html at import time.
 */
// E-01 (found while C-01, also in v0.9.2): the detached player window's own
// key handler returned for ANY focused <input>. Its volume slider, once Tab
// had focused it, swallowed Space, K, M, F and the arrows: the window's
// playback keys did nothing until the video was clicked. The main window got
// the per-control rule in C-01 (keyboard.js targetOwnsKey: a slider owns its
// stepping keys, nothing else); the pop-out now asks the same function.
//
// The same rule also stops a key being acted on twice: the seek bar handles
// its own arrows (5 s, preventDefault) and the window handler seeked another
// 5 s on top, so one press from the focused seek bar moved 10 s.
//
// Keys are dispatched ON the focused control and bubble to the window, as a
// real key press does. Asserted: what the pop-out's <video> does.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import * as PLAYERWIN from '../../renderer/js/player-popout-protocol.js';

const html = fs.readFileSync('renderer/player-popout.html', 'utf8');
const bodyInner = html.slice(html.indexOf('>', html.indexOf('<body')) + 1, html.lastIndexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '');

const up = [];
let onEvent = null;
const $ = (id) => document.getElementById(id);
const video = () => $('video');

async function until(fn, ms = 3000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A key pressed while `el` has focus: dispatched on it, bubbling up. */
function pressOn(el, key, code = key) {
  el.focus();
  const e = new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
}

beforeAll(async () => {
  document.body.innerHTML = bodyInner;
  HTMLMediaElement.prototype.play = vi.fn(function play() {
    Object.defineProperty(this, 'paused', { value: false, configurable: true });
    return Promise.resolve();
  });
  HTMLMediaElement.prototype.pause = vi.fn(function pause() {
    Object.defineProperty(this, 'paused', { value: true, configurable: true });
  });
  HTMLMediaElement.prototype.load = vi.fn();
  window.funsync = {
    playerPopoutRelay: (direction, payload) => { if (direction === 'to-parent') up.push(payload); },
    onPlayerPopoutEvent: (cb) => { onEvent = cb; },
  };
  await import('../../renderer/player-popout.js');
  onEvent({ type: 'opened' });
  await until(() => up.some((m) => m.type === PLAYERWIN.READY));
  Object.defineProperty(video(), 'duration', { value: 120, configurable: true });
}, 20000);

beforeEach(() => {
  up.length = 0;
  HTMLMediaElement.prototype.play.mockClear();
  HTMLMediaElement.prototype.pause.mockClear();
  Object.defineProperty(video(), 'paused', { value: true, configurable: true });
  video().currentTime = 50;
});

describe('E-01: the focused volume slider keeps only its own keys', () => {
  const slider = () => $('volume-slider');

  it('is the range input the bar shows (precondition)', () => {
    expect(slider()).not.toBeNull();
    expect(slider().type).toBe('range');
  });

  it('Space plays, and Space again pauses', () => {
    pressOn(slider(), ' ', 'Space');
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    pressOn(slider(), ' ', 'Space');
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(1);
  });

  it('K plays / pauses', () => {
    pressOn(slider(), 'k', 'KeyK');
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  });

  it('M mutes', () => {
    const was = video().muted;
    pressOn(slider(), 'm', 'KeyM');
    expect(video().muted).toBe(!was);
    pressOn(slider(), 'm', 'KeyM');
    expect(video().muted).toBe(was);
  });

  it('J / L seek, and N asks main for the next video', () => {
    pressOn(slider(), 'j', 'KeyJ');
    expect(video().currentTime).toBe(40);
    pressOn(slider(), 'l', 'KeyL');
    expect(video().currentTime).toBe(50);
    pressOn(slider(), 'n', 'KeyN');
    expect(up.filter((m) => m.type === PLAYERWIN.LOAD_NEXT)).toHaveLength(1);
  });

  it('its arrows stay the slider\'s: they do not seek the video', () => {
    pressOn(slider(), 'ArrowRight');
    pressOn(slider(), 'ArrowLeft');
    expect(video().currentTime).toBe(50);
  });
});

describe('E-01: a key the focused control already handled is not acted on again', () => {
  it('Right on the focused seek bar moves 5 s, not 10', () => {
    pressOn($('progress-container'), 'ArrowRight');
    expect(video().currentTime).toBe(55);
  });

  it('Right with nothing focused still seeks 5 s (the window\'s own key)', () => {
    document.activeElement?.blur?.();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true }));
    expect(video().currentTime).toBe(55);
  });
});
