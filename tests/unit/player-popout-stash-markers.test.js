/**
 * @vitest-environment jsdom
 * jsdom on purpose: this imports the REAL pop-out renderer
 * (renderer/player-popout.js), which builds its VideoPlayer, ProgressBar and
 * controls on the DOM of player-popout.html at import time.
 */
// Stash S1 (Dave's answer 3: Stash scene markers as seek-bar chapters): the
// detached player window draws its own seek bar, so the playing video's
// Stash markers reach it in the CHAPTERS message (app.js
// _streamPlayerWindowData / _applyStashMarkers) and are drawn next to the
// script's chapters. Asserted: the window's chapter strip.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import fs from 'node:fs';
import * as PLAYERWIN from '../../renderer/js/player-popout-protocol.js';

const html = fs.readFileSync('renderer/player-popout.html', 'utf8');
const bodyInner = html.slice(html.indexOf('>', html.indexOf('<body')) + 1, html.lastIndexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '');

const up = [];
let onEvent = null;
const $ = (id) => document.getElementById(id);

async function until(fn, ms = 3000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const send = (fields) => onEvent({ type: 'message', payload: PLAYERWIN.makeMessage(PLAYERWIN.CHAPTERS, fields) });

beforeAll(async () => {
  document.body.innerHTML = bodyInner;
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
  window.funsync = {
    playerPopoutRelay: (direction, payload) => { if (direction === 'to-parent') up.push(payload); },
    onPlayerPopoutEvent: (cb) => { onEvent = cb; },
  };
  await import('../../renderer/player-popout.js');
  onEvent({ type: 'opened' });
  await until(() => up.some((m) => m.type === PLAYERWIN.READY));
  Object.defineProperty($('video'), 'duration', { value: 60, configurable: true });
}, 20000);

describe('the detached window\'s seek bar shows the Stash markers', () => {
  it('a video with no script but Stash markers: the chapter strip shows', () => {
    send({ chapters: [], bookmarks: [], stashMarkers: [{ startMs: 1000, endMs: null, title: 'Synthetic marker one' }], durationMs: 60000 });
    expect($('chapter-strip-container').hidden).toBe(false);
  });

  it('the markers going away (Stash off, another video) hide it again', () => {
    send({ chapters: [], bookmarks: [], stashMarkers: [], durationMs: 60000 });
    expect($('chapter-strip-container').hidden).toBe(true);
  });

  it('an older message with no stashMarkers field: the script\'s chapters alone, as before', () => {
    send({ chapters: [{ startMs: 0, endMs: 1000, name: 'A', color: '#f00' }], bookmarks: [], durationMs: 60000 });
    expect($('chapter-strip-container').hidden).toBe(false);
    send({ chapters: [], bookmarks: [], durationMs: 60000 });
    expect($('chapter-strip-container').hidden).toBe(true);
  });
});
