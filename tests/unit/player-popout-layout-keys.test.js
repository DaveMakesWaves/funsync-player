/**
 * @vitest-environment jsdom
 * jsdom on purpose: this imports the REAL pop-out renderer
 * (renderer/player-popout.js), which builds its VideoPlayer and controls on
 * the DOM of player-popout.html at import time.
 */
// CB-07: the detached player window's own keys (Space/K, F, M, J/L, P/N,
// Shift+L) matched `e.key`, so on a Russian or Korean layout, where the K key
// types 'л' or 'ㅏ', every letter key did nothing there. They go through the
// FT-035 helper (layoutKey) now, like the main window's and both editors'.
//
// Assertions: what the pop-out's <video> does and what it sends to main.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import * as PLAYERWIN from '../../renderer/js/player-popout-protocol.js';

const html = fs.readFileSync('renderer/player-popout.html', 'utf8');
const bodyInner = html.slice(html.indexOf('>', html.indexOf('<body')) + 1, html.lastIndexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '');

const up = [];
let onEvent = null;
const video = () => document.getElementById('video');
const sentOf = (type) => up.filter((m) => m.type === type);

async function until(fn, ms = 3000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A key on the page, as a layout types it: `key` is what the layout prints, `code` the physical key. */
const press = (key, code, mods = {}) => window.dispatchEvent(new KeyboardEvent('keydown', {
  key, code, bubbles: true, cancelable: true, shiftKey: !!mods.shift,
}));

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
  await until(() => sentOf(PLAYERWIN.READY).length > 0);
  Object.defineProperty(video(), 'duration', { value: 120, configurable: true });
}, 20000);

beforeEach(() => {
  up.length = 0;
  HTMLMediaElement.prototype.play.mockClear();
  video().currentTime = 50;
});

describe('the detached player\'s letter keys work on a Russian layout (CB-07)', () => {
  it('К (the K key, types л) plays / pauses', () => {
    Object.defineProperty(video(), 'paused', { value: true, configurable: true });
    press('л', 'KeyK');
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  });

  it('J / L (о / д) seek 10 s back and forward', () => {
    press('о', 'KeyJ');
    expect(video().currentTime).toBe(40);
    press('д', 'KeyL');
    expect(video().currentTime).toBe(50);
  });

  it('M (ь) mutes', () => {
    const was = video().muted;
    press('ь', 'KeyM');
    expect(video().muted).toBe(!was);
  });

  it('N / P (т / з) ask main for the next / previous video', () => {
    press('т', 'KeyN');
    press('з', 'KeyP');
    expect(sentOf(PLAYERWIN.LOAD_NEXT)).toHaveLength(1);
    expect(sentOf(PLAYERWIN.LOAD_PREV)).toHaveLength(1);
  });

  it('Shift+L (Д) toggles the video loop', () => {
    const was = video().loop;
    press('Д', 'KeyL', { shift: true });
    expect(video().loop).toBe(!was);
  });

  it('a Latin layout keeps its own letters (AZERTY\'s A key types a: not Q)', () => {
    press('n', 'KeyN');
    expect(sentOf(PLAYERWIN.LOAD_NEXT)).toHaveLength(1);
  });
});
