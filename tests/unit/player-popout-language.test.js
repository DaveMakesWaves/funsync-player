/**
 * @vitest-environment jsdom
 * jsdom on purpose: this imports the REAL pop-out renderer
 * (renderer/player-popout.js), which builds its VideoPlayer and controls on
 * the DOM of player-popout.html at import time, and i18n.js walks that
 * document (notes/CLAUDE.md "Test environments").
 */
// The detached player window in another language (app test V69 / V50).
//
// setLocale() walks the static data-i18n keys before it emits
// language:changed. The pop-out had no handler, so the walk was the last word
// on everything it paints from state. On open, main's READY handoff sends
// INITIAL_STATE (with the locale), then SET_VOLUME and SET_LOOP, which paint
// while the locale bundle is still loading; the walk then landed on top: a
// looped video's "Loop video" read "Aus" and a muted one's button "Stumm".
// A live switch in the main window (LOCALE) did the same.
//
// Assertions are on what the window shows. Each message is sent the way main
// sends it, and the bundle fetch takes a few ms, like file:// in Electron.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import * as PLAYERWIN from '../../renderer/js/player-popout-protocol.js';
import { getCurrentLocale } from '../../renderer/js/i18n.js';

const bundle = (l) => JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'));
const DE = bundle('de');
const ES = bundle('es');
const JA = bundle('ja');

const html = fs.readFileSync('renderer/player-popout.html', 'utf8');
const bodyInner = html.slice(html.indexOf('>', html.indexOf('<body')) + 1, html.lastIndexOf('</body>'))
  // Scripts are imported below, not executed from the markup.
  .replace(/<script[\s\S]*?<\/script>/g, '');

const up = []; // messages the pop-out sent to main
let onEvent = null;
const $ = (id) => document.getElementById(id);
const fromMain = (type, fields) => onEvent({ type: 'message', payload: PLAYERWIN.makeMessage(type, fields) });
const aria = (id) => $(id).getAttribute('aria-label');
const menuLabel = () => document.querySelector('#btn-loop-video [data-i18n="player.loopVideo.menuLabel"]').textContent;

async function until(fn, ms = 3000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

// jsdom implements no playback: `paused` is always true. Drive it, and fire
// the event the element would.
let playing = false;
function setPlaying(on) {
  playing = on;
  $('video').dispatchEvent(new Event(on ? 'play' : 'pause'));
}

const realFetch = globalThis.fetch;
beforeAll(async () => {
  globalThis.fetch = async (url) => {
    const m = /locales\/(\w+)\.json$/.exec(String(url));
    if (!m) throw new Error(`unexpected fetch ${url}`);
    await new Promise((r) => setTimeout(r, 8));
    return { ok: true, json: async () => bundle(m[1]) };
  };
  document.body.innerHTML = bodyInner;
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
  Object.defineProperty($('video'), 'paused', { configurable: true, get: () => !playing });
  window.funsync = {
    playerPopoutRelay: (direction, payload) => { if (direction === 'to-parent') up.push(payload); },
    onPlayerPopoutEvent: (cb) => { onEvent = cb; },
  };
  await import('../../renderer/player-popout.js');
  onEvent({ type: 'opened' });
  await until(() => up.some((m) => m.type === PLAYERWIN.READY));
}, 20000);

afterAll(() => {
  setPlaying(false); // stops the pop-out's tick timer
  globalThis.fetch = realFetch;
});

describe('the pop-out keeps what it was handed across a language change', () => {
  it('opening on a looped, muted, playing video in German', async () => {
    setPlaying(true);
    // Main's READY handler, back to back.
    fromMain(PLAYERWIN.INITIAL_STATE, { theme: 'dark', uiStyle: 'classic', locale: 'de', backendPort: null, inlineViz: {} });
    fromMain(PLAYERWIN.SET_VOLUME, { volume: 0.5, muted: true });
    fromMain(PLAYERWIN.SET_LOOP, { loop: true });
    // Painted while the German bundle is still loading.
    expect(getCurrentLocale()).toBe('en');

    await until(() => getCurrentLocale() === 'de');
    await new Promise((r) => setTimeout(r, 0));

    expect(menuLabel()).toBe(DE.player.loopVideo.menuLabel);
    // Static key: the Off string. The walk alone said "Aus".
    expect($('loop-video-state').textContent).toBe(DE.player.loopVideo.stateOn);
    // Static key: Mute. The walk alone said "Stumm".
    expect(aria('btn-mute')).toBe(DE.player.unmute);
    // Static key: Play.
    expect(aria('btn-play')).toBe(DE.player.pause);
    expect(aria('center-play-btn')).toBe(DE.player.pause);
  });

  it('a live switch in the main window (LOCALE) re-applies the same state', async () => {
    fromMain(PLAYERWIN.LOCALE, { locale: 'es' });
    await until(() => getCurrentLocale() === 'es');
    await new Promise((r) => setTimeout(r, 0));

    expect(menuLabel()).toBe(ES.player.loopVideo.menuLabel);
    expect($('loop-video-state').textContent).toBe(ES.player.loopVideo.stateOn);
    expect(aria('btn-mute')).toBe(ES.player.unmute);
    expect(aria('btn-play')).toBe(ES.player.pause);
    // No static key: it kept the old language.
    expect($('btn-play').title).toBe(ES.player.pauseTitle);
    // No video loaded here, so the window still shows its waiting line.
    expect($('player-popout-loading').textContent).toBe(ES.player.windowWaiting);
  });

  it('and redraws from the state it has now, not the state it had', async () => {
    fromMain(PLAYERWIN.SET_VOLUME, { volume: 0.8, muted: false });
    fromMain(PLAYERWIN.SET_LOOP, { loop: false });
    setPlaying(false);
    fromMain(PLAYERWIN.LOCALE, { locale: 'ja' });
    await until(() => getCurrentLocale() === 'ja');
    await new Promise((r) => setTimeout(r, 0));

    expect($('loop-video-state').textContent).toBe(JA.player.loopVideo.stateOff);
    expect(aria('btn-mute')).toBe(JA.player.mute);
    expect(aria('btn-play')).toBe(JA.player.play);
    expect($('btn-play').title).toBe(JA.player.playTitle);
  });
});
