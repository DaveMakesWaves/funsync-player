/**
 * @vitest-environment jsdom
 * jsdom on purpose: this imports the REAL pop-out renderer
 * (renderer/player-popout.js), which builds its controls on the DOM of
 * player-popout.html at import time, and i18n.js walks that document
 * (notes/CLAUDE.md "Test environments").
 */
// R3-24 (found while CB-08): the detached player window's own shortcut card
// (overflow menu > Keyboard shortcuts) wrote its chords in English in every
// language ("Space / K", "← / →", "Shift + L") while the main window's ?
// overlay renders them through the keys.* names (CB-08). The card now uses
// the same localizeChordPart, and the same kbd.* descriptions for the seeks.
// Asserted on what the card shows, in German and in English.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import * as PLAYERWIN from '../../renderer/js/player-popout-protocol.js';
import { getCurrentLocale } from '../../renderer/js/i18n.js';

const bundle = (l) => JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'));
const DE = bundle('de');
const EN = bundle('en');

const html = fs.readFileSync('renderer/player-popout.html', 'utf8');
const bodyInner = html.slice(html.indexOf('>', html.indexOf('<body')) + 1, html.lastIndexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '');

const up = [];
let onEvent = null;
const $ = (id) => document.getElementById(id);
const fromMain = (type, fields) => onEvent({ type: 'message', payload: PLAYERWIN.makeMessage(type, fields) });

async function until(fn, ms = 3000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Open the card from the overflow menu and read it, row by row. */
function readCard() {
  $('btn-help').click();
  const card = $('ppo-shortcuts');
  const rows = [...card.querySelectorAll('.ppo-shortcuts__row')].map((row) => ({
    keys: [...row.querySelectorAll('kbd')].map((k) => k.textContent),
    text: row.lastElementChild.textContent,
  }));
  card.click(); // closes it
  return rows;
}

const realFetch = globalThis.fetch;
beforeAll(async () => {
  globalThis.fetch = async (url) => {
    const m = /locales\/(\w+)\.json$/.exec(String(url));
    if (!m) throw new Error(`unexpected fetch ${url}`);
    return { ok: true, json: async () => bundle(m[1]) };
  };
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
}, 20000);

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('the detached player\'s shortcut card speaks the window\'s language (R3-24)', () => {
  it('in German: Leertaste, Pfeil links / rechts, Umschalt+L, and the seek rows in German', async () => {
    fromMain(PLAYERWIN.INITIAL_STATE, { theme: 'dark', uiStyle: 'classic', locale: 'de', backendPort: null, inlineViz: {} });
    await until(() => getCurrentLocale() === 'de');
    await new Promise((r) => setTimeout(r, 0));
    const rows = readCard();
    expect(rows[0]).toEqual({ keys: [DE.keys.space, 'K'], text: DE.player.play });
    expect(rows[1]).toEqual({ keys: [DE.keys.arrowLeft, DE.keys.arrowRight], text: DE.kbd.seek5s });
    expect(rows[2]).toEqual({ keys: ['J', 'L'], text: DE.kbd.seek10s });
    expect(rows.find((r) => r.text === DE.player.loopVideo.menuLabel).keys).toEqual([`${DE.keys.shift}+L`]);
    // Nothing English left in the chord column.
    const chords = rows.flatMap((r) => r.keys).join(' ');
    expect(chords).not.toMatch(/Space|Shift|←|→/);
  });

  it('in English: the same names the main window\'s ? overlay uses', async () => {
    fromMain(PLAYERWIN.LOCALE, { locale: 'en' });
    await until(() => getCurrentLocale() === 'en');
    await new Promise((r) => setTimeout(r, 0));
    const rows = readCard();
    expect(rows[0].keys).toEqual([EN.keys.space, 'K']);
    expect(rows[1].keys).toEqual([EN.keys.arrowLeft, EN.keys.arrowRight]);
    expect(rows.find((r) => r.text === EN.player.loopVideo.menuLabel).keys).toEqual(['Shift+L']);
    expect(rows.map((r) => r.keys.join(' / '))).toEqual([
      'Space / K', 'Left Arrow / Right Arrow', 'J / L', 'M', 'F', '< / >', 'Shift+L', 'P / N',
    ]);
  });

  // R3 fix-up (real-app verifier 1): ? did nothing in the detached window,
  // the card opened only from its overflow menu.
  it('? opens the card, as in the main window; Escape closes it', () => {
    const press = (key, init = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
    expect($('ppo-shortcuts')).toBeNull();
    press('?', { shiftKey: true });
    expect($('ppo-shortcuts')).not.toBeNull();
    expect($('ppo-shortcuts').querySelectorAll('.ppo-shortcuts__row').length).toBe(8);
    press('Escape');
    expect($('ppo-shortcuts')).toBeNull();
  });
});
