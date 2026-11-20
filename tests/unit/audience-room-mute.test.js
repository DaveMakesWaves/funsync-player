/**
 * @vitest-environment jsdom
 * jsdom on purpose: this imports the REAL audience pop-out renderer
 * (renderer/audience-room.js), which renders into audience-room.html's DOM
 * at import time, and i18n.js walks that document (notes/CLAUDE.md "Test
 * environments").
 */
// Mute / Unmute from the audience room window (app test, 2026-11-04).
//
// The room window is a mirror: it draws each row, and its Mute / Unmute
// button, from the viewer's `muted` flag. Nothing ever updated that flag
// after INITIAL_STATE: VIEWER_STATUS carried no `muted`, and the pop-out's
// handler did not read one. So after Mute the row showed the raw status
// "muted" with a green LED, the button still said "Mute", and pressing it
// sent mute AGAIN: a muted viewer could not be unmuted from the room (same
// code since v0.9.2).
//
// Everything here is REAL except the viewer's Handy and the network: the
// pop-out renderer on its own HTML, app.js's relay (_wireAudiencePopoutRelay,
// lifted), the AudienceBridge, and a broker that ferries messages the way
// main does. Assertions are on what the window shows, what it sent, and what
// the viewer's DEVICE did.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import * as AUDIENCE from '../../renderer/js/audience-popout-protocol.js';
import { AudienceBridge } from '../../renderer/js/audience-bridge.js';
import { eventBus } from '../../renderer/js/event-bus.js';
import { liftAppClass } from './helpers/app-methods.js';
import {
  makeWorld, makeFakeHandyCtor, makeUploader, scriptContent, urlFor, deviceOf, landed,
} from './helpers/fake-viewer-handy.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const html = fs.readFileSync('renderer/audience-room.html', 'utf8');
const bodyInner = html.slice(html.indexOf('>', html.indexOf('<body')) + 1, html.lastIndexOf('</body>'))
  // Scripts are imported below, not executed from the markup.
  .replace(/<script[\s\S]*?<\/script>/g, '');

const KEY = 'viewer-key-1';
const world = makeWorld();
const player = { playing: false, timeMs: 0, rate: 1 };
const uploader = makeUploader({ latencyFor: () => 10 });
const up = [];                 // every message the pop-out sent to main
let toPopout = null;           // the pop-out's onAudiencePopoutEvent listener
let toApp = null;              // the app's onAudiencePopoutEvent listener
let bridge = null;

// Main's broker: one event channel each way, `{ type: 'message', payload }`,
// delivered asynchronously like IPC.
const deliver = (cb, payload) => setTimeout(() => cb?.({ type: 'message', payload }), 0);

const row = () => document.querySelector(`[data-viewer-key="${KEY}"]`);
const rowStatus = () => row()?.querySelector('.audience-room__card-status')?.textContent;
const rowDot = () => row()?.querySelector('.audience-room__card-dot')?.className || '';
const muteBtn = () => row()?.querySelector('.audience-room__card-mute-btn');
// The fake's clock sync reports a 50 ms round trip, so a playing row shows it.
const PLAYING = EN.audience.room.statusPlayingWithRtd.replace('{rtd}', '50');
const muteMessages = () => up.filter((m) => m.type === AUDIENCE.SET_MUTED).map((m) => m.muted);

async function until(fn, ms = 4000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const realFetch = globalThis.fetch;
beforeAll(async () => {
  globalThis.fetch = async (url) => {
    const m = /locales\/(\w+)\.json$/.exec(String(url));
    if (!m) throw new Error(`unexpected fetch ${url}`);
    await new Promise((r) => setTimeout(r, 5));
    return { ok: true, json: async () => JSON.parse(fs.readFileSync(`renderer/locales/${m[1]}.json`, 'utf8')) };
  };
  document.body.innerHTML = bodyInner;

  // The main renderer's side: the REAL relay, the REAL bridge.
  const appWindow = {
    funsync: {
      onAudiencePopoutEvent: (cb) => { toApp = cb; },
      audiencePopoutRelay: (dir, payload) => { if (dir === 'to-popout') deliver(toPopout, payload); },
      audiencePopoutClose: async () => {},
    },
  };
  const quiet = { log() {}, warn() {}, error() {}, debug() {} };
  const App = liftAppClass(
    ['_wireAudiencePopoutRelay', '_pushAudienceMessage', '_pushAudienceInitialState'],
    { window: appWindow, document, eventBus, AUDIENCE, t: (k) => k, showToast: () => {}, console: quiet },
  );
  const app = new App();
  app.settings = { get: () => undefined, set: () => {} };
  bridge = new AudienceBridge({
    settings: app.settings,
    eventBus,
    HandyManagerCtor: makeFakeHandyCtor(world),
    getCurrentVideoTimeMs: () => player.timeMs,
    isVideoPlaying: () => player.playing,
    getPlaybackRate: () => player.rate,
    uploadScript: uploader.upload,
  });
  app.audienceBridge = bridge;
  app._wireAudiencePopoutRelay();

  // The pop-out's side.
  window.funsync = {
    onAudiencePopoutEvent: (cb) => { toPopout = cb; },
    audiencePopoutRelay: (dir, payload) => {
      if (dir !== 'to-parent') return;
      up.push(payload);
      deliver(toApp, payload);
    },
    updateWindowChrome: () => {},
  };
  window.confirm = () => true;
  await import('../../renderer/audience-room.js');
  bridge.openRoom();
  toPopout({ type: 'opened' });
  await until(() => document.querySelector('.audience-room__add-form'));
}, 20000);

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('Mute / Unmute from the room window', () => {
  it('a viewer muted from its row can be unmuted from the same button', async () => {
    // A video with its script is loaded, paused.
    bridge.setScript(bridge.beginSource({ title: 'a' }), { content: scriptContent('a'), title: 'a' });

    // The streamer adds a viewer through the window's own form.
    document.getElementById('audience-room-add-key').value = KEY;
    document.getElementById('audience-room-add-label').value = 'Sam';
    document.querySelector('.audience-room__add-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await until(() => rowStatus() === EN.audience.room.statusReady);
    expect(deviceOf(world, KEY).url).toBe(urlFor('a'));

    // Playing.
    player.playing = true;
    bridge.onPlaying();
    await until(() => deviceOf(world, KEY).playing && rowStatus() === PLAYING);

    // Mute: the device stops and the row says so, in words.
    muteBtn().click();
    await until(() => !deviceOf(world, KEY).playing);
    await until(() => rowStatus() === EN.audience.room.statusMuted);
    expect(muteBtn().getAttribute('aria-pressed')).toBe('true');
    expect(muteBtn().textContent).toBe(EN.audience.room.unmute);
    expect(rowDot()).toContain('--muted');          // grey, not green
    expect(muteMessages()).toEqual([true]);

    // Paused; the next video comes in while the viewer is muted: its device
    // gets nothing for it.
    player.playing = false;
    bridge.onPaused();
    bridge.setScript(bridge.beginSource({ title: 'b' }), { content: scriptContent('b'), title: 'b' });
    await new Promise((r) => setTimeout(r, 400));
    expect(deviceOf(world, KEY).url).toBe(urlFor('a'));
    expect(rowStatus()).toBe(EN.audience.room.statusMuted);

    // Unmute from the SAME button: it asks for unmute (it used to ask for
    // mute again), the device gets the current video's script, and nothing
    // plays while the video is paused.
    muteBtn().click();
    await until(() => deviceOf(world, KEY).url === urlFor('b'));
    await until(() => rowStatus() === EN.audience.room.statusReady);
    expect(muteMessages()).toEqual([true, false]);
    expect(muteBtn().getAttribute('aria-pressed')).toBe('false');
    expect(muteBtn().textContent).toBe(EN.audience.room.mute);
    expect(deviceOf(world, KEY).playing).toBe(false);

    // And the next play reaches it, on b.
    player.playing = true;
    bridge.onPlaying();
    await until(() => deviceOf(world, KEY).playing);
    expect(deviceOf(world, KEY).playUrl).toBe(urlFor('b'));
    expect(landed(world, KEY).slice(-2)).toEqual(['setup', 'play']);
    await until(() => rowStatus() === PLAYING);

    // Leave the device stopped.
    player.playing = false;
    bridge.onPaused();
    await until(() => !deviceOf(world, KEY).playing);
  }, 20000);
});

// verify-2, 2026-11-07 (new since v0.9.2): while the phone drove playback,
// a viewer set up with the phone's script read a green "Ready". Viewers never
// play a phone's or a headset's script (the stopgap), so the row said it
// would play when it never would.
describe('a viewer set up for a phone\'s or headset\'s script', () => {
  it('reads "not followed" with a grey dot, and Ready (green) again once this window\'s script is back', async () => {
    for (const p of ['phone', 'vr']) {
      bridge.setScript(bridge.beginSource({ title: `remote-${p}`, player: p }), { content: scriptContent(`remote-${p}`), title: `remote-${p}` });
      await until(() => deviceOf(world, KEY).url === urlFor(`remote-${p}`));
      await until(() => rowStatus() === EN.audience.room.statusRemoteHeld);
      expect(rowDot()).toContain('--muted');
      expect(rowDot()).not.toContain('--connected');
      expect(deviceOf(world, KEY).playing).toBe(false);
    }
    bridge.setScript(bridge.beginSource({ title: 'local' }), { content: scriptContent('local'), title: 'local' });
    await until(() => rowStatus() === EN.audience.room.statusReady);
    expect(rowDot()).not.toContain('--muted');
  }, 20000);
});
