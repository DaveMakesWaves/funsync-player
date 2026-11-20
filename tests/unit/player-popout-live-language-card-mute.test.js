/**
 * @vitest-environment jsdom
 * jsdom on purpose: this imports the REAL pop-out renderer
 * (renderer/player-popout.js), which builds its controls on the DOM of
 * player-popout.html at import time, and i18n.js walks that document
 * (notes/CLAUDE.md "Test environments").
 */
// The detached player window, after a live language switch in the main window
// (its LOCALE message), both also in v0.9.2:
//
// FT-065: an OPEN shortcut card (? or overflow > Keyboard shortcuts) stayed
//   in the old language. It is built once from t() and has no data-i18n keys
//   for setLocale's walk; retranslateWindow() builds it again now.
// FT-064: the mute button's tooltip was player-popout.html's static English
//   "Mute (M)" in every language and state (VideoPlayer sets it now).
//
// Asserted on what the window shows, in German, then back in English.
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
const press = (key, init = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));

async function until(fn, ms = 3000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}
async function switchTo(locale) {
  fromMain(PLAYERWIN.LOCALE, { locale });
  await until(() => getCurrentLocale() === locale);
  await new Promise((r) => setTimeout(r, 0));
}
/** The open card, row by row (null when closed). */
function card() {
  const el = $('ppo-shortcuts');
  if (!el) return null;
  return {
    title: el.querySelector('h2').textContent,
    rows: [...el.querySelectorAll('.ppo-shortcuts__row')].map((row) => ({
      keys: [...row.querySelectorAll('kbd')].map((k) => k.textContent),
      text: row.lastElementChild.textContent,
    })),
  };
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
  fromMain(PLAYERWIN.INITIAL_STATE, { theme: 'dark', uiStyle: 'classic', locale: 'en', backendPort: null, inlineViz: {} });
  await until(() => getCurrentLocale() === 'en');
}, 20000);

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('an open shortcut card follows a language switch (FT-065)', () => {
  it('opened in English, switched to German in the main window: the card is German, still open', async () => {
    press('?', { shiftKey: true });
    expect(card().title).toBe(EN.player.keyboardShortcuts);
    expect(card().rows[0]).toEqual({ keys: [EN.keys.space, 'K'], text: EN.player.play });

    await switchTo('de');
    const c = card();
    expect(c).not.toBeNull();
    expect(c.title).toBe(DE.player.keyboardShortcuts);
    expect(c.rows[0]).toEqual({ keys: [DE.keys.space, 'K'], text: DE.player.play });
    expect(c.rows[1].text).toBe(DE.kbd.seek5s);
    expect(c.rows).toHaveLength(8);
    expect(document.querySelectorAll('#ppo-shortcuts')).toHaveLength(1);

    await switchTo('en');
    expect(card().title).toBe(EN.player.keyboardShortcuts);
    press('Escape');
    expect(card()).toBeNull();
  });

  it('a closed card stays closed through a switch', async () => {
    $('ppo-shortcuts')?.remove();
    await switchTo('de');
    expect(card()).toBeNull();
    await switchTo('en');
  });
});

describe('the pop-out\'s mute tooltip is in the window\'s language and names the state (FT-064)', () => {
  it('German: mute, then unmute once main mutes it (SET_VOLUME)', async () => {
    await switchTo('de');
    expect(DE.player.muteTitle).toBeTruthy();
    expect($('btn-mute').title).toBe(DE.player.muteTitle);
    fromMain(PLAYERWIN.SET_VOLUME, { volume: 0.5, muted: true });
    expect($('btn-mute').title).toBe(DE.player.unmuteTitle);
    await switchTo('en');
    expect($('btn-mute').title).toBe(EN.player.unmuteTitle);
    fromMain(PLAYERWIN.SET_VOLUME, { volume: 0.5, muted: false });
    expect($('btn-mute').title).toBe('Mute (M)');
  });
});
