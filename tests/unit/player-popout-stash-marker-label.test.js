/**
 * @vitest-environment jsdom
 * jsdom on purpose: this imports the REAL pop-out renderer
 * (renderer/player-popout.js), which builds its VideoPlayer, ProgressBar and
 * controls on the DOM of player-popout.html at import time.
 */
// The detached player names a Stash marker on hover in its own language,
// worded as the main window does (Stash fix-up 2026-11-19, s1-review-a
// RA-S1-6). Before, the pop-out drew the markers but its hover never named
// any marker (it never asked the bar), and the bar it had kept the English
// fallback "Stash: <title>". Asserted: the hover line a real mousemove over
// the pop-out's seek bar shows, in German and in English.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import * as PLAYERWIN from '../../renderer/js/player-popout-protocol.js';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';

const html = fs.readFileSync('renderer/player-popout.html', 'utf8');
const bodyInner = html.slice(html.indexOf('>', html.indexOf('<body')) + 1, html.lastIndexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '');
const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const DE = JSON.parse(fs.readFileSync('renderer/locales/de.json', 'utf8'));

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

/** Hover the pop-out's seek bar at `x` px of 600. */
function hover(x) {
  $('progress-container').dispatchEvent(new MouseEvent('mousemove', { clientX: x, bubbles: true }));
}
const stashLine = () => $('tooltip-marker-stash');

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
  $('progress-container').getBoundingClientRect = () => ({ left: 0, top: 0, right: 600, bottom: 8, width: 600, height: 8, x: 0, y: 0 });
  send({ chapters: [], bookmarks: [], stashMarkers: [{ startMs: 15000, endMs: null, title: 'Stellungswechsel' }, { startMs: 40000, endMs: null, title: '' }], durationMs: 60000 });
}, 20000);

afterAll(() => _setBundlesForTests('en', EN, EN));

describe('the pop-out\'s Stash marker hover line', () => {
  it('in German: "Stash-Marker: <title>", as the main window says it', () => {
    _setBundlesForTests('de', DE, EN);
    hover(150);
    expect(stashLine().hidden).toBe(false);
    expect(stashLine().textContent).toBe('Stash-Marker: Stellungswechsel');
  });

  it('an untitled marker: the language\'s own words for it', () => {
    _setBundlesForTests('de', DE, EN);
    hover(400);
    expect(stashLine().textContent).toBe(DE.player.stashMarkerUntitled);
  });

  it('the language switching live: the next hover follows it', () => {
    _setBundlesForTests('en', EN, EN);
    hover(150);
    expect(stashLine().textContent).toBe('Stash marker: Stellungswechsel');
  });

  it('away from every marker the line hides', () => {
    hover(300);
    expect(stashLine().hidden).toBe(true);
  });
});
