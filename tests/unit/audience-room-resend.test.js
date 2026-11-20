/**
 * @vitest-environment jsdom
 * jsdom on purpose: this imports the REAL audience pop-out renderer
 * (renderer/audience-room.js), which renders into audience-room.html's DOM
 * at import time, and i18n.js walks that document (notes/CLAUDE.md "Test
 * environments").
 */
// Resend (FT-121) and Test buzz (FT-119) from the audience room window.
//
// FT-121: a viewer whose Handy dropped offline had no way back but Remove and
// Add: no Resend, no Retry, no reconnect. Each row now has Resend, which the
// room sends as RESEND and app.js's relay hands to bridge.resend(key).
// FT-119: Test buzz called a method the real HandyManager does not have, so
// the button did nothing; and the screen flashed for a pulse that never
// went. The flash now goes with the pulse, and the button is off while the
// bridge would refuse it.
//
// Everything here is REAL except the viewer's Handy and the network: the
// pop-out renderer on its own HTML, app.js's relay (_wireAudiencePopoutRelay
// and the flash, lifted), the AudienceBridge, and a broker that ferries
// messages the way main does. Assertions are on what the window shows, what
// it sent, and what the viewer's DEVICE did.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import * as AUDIENCE from '../../renderer/js/audience-popout-protocol.js';
import { AudienceBridge } from '../../renderer/js/audience-bridge.js';
import { eventBus } from '../../renderer/js/event-bus.js';
import { liftAppClass } from './helpers/app-methods.js';
import {
  makeWorld, makeFakeHandyCtor, makeUploader, scriptContent, urlFor, deviceOf, landed, powerCycle,
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
let flashes = 0;               // times the streamer's screen flashed

// Main's broker: one event channel each way, `{ type: 'message', payload }`,
// delivered asynchronously like IPC.
const deliver = (cb, payload) => setTimeout(() => cb?.({ type: 'message', payload }), 0);

const row = () => document.querySelector(`[data-viewer-key="${KEY}"]`);
const rowStatus = () => row()?.querySelector('.audience-room__card-status')?.textContent;
const resendBtn = () => row()?.querySelector('.audience-room__card-resend-btn');
const buzzBtn = () => row()?.querySelector('.audience-room__card-buzz-btn');
const muteBtn = () => row()?.querySelector('.audience-room__card-mute-btn');
const buzzAllBtn = () => document.querySelector('.audience-room__buzz-all-btn');
// The fake's clock sync reports a 50 ms round trip, so a playing row shows it.
const PLAYING = EN.audience.room.statusPlayingWithRtd.replace('{rtd}', '50');
const sentOf = (type) => up.filter((m) => m.type === type);
const hdsp = () => landed(world, KEY, { full: true }).filter((e) => e.kind === 'hdsp');

async function until(fn, ms = 6000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
    ['_wireAudiencePopoutRelay', '_pushAudienceMessage', '_pushAudienceInitialState', '_flashScreenForBuzzCalibration'],
    { window: appWindow, document, eventBus, AUDIENCE, t: (k) => k, showToast: () => {}, console: quiet, setTimeout },
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

  // The flash is the REAL overlay; count each time it lights up.
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.target.id === 'audience-buzz-flash'
          && r.target.classList.contains('audience-buzz-flash--active')
          && !String(r.oldValue || '').includes('audience-buzz-flash--active')) flashes++;
    }
  }).observe(document.body, { attributes: true, attributeOldValue: true, attributeFilter: ['class'], subtree: true });

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

  // A video with its script is loaded, paused; the streamer adds a viewer
  // through the window's own form.
  bridge.setScript(bridge.beginSource({ title: 'a' }), { content: scriptContent('a'), title: 'a' });
  document.getElementById('audience-room-add-key').value = KEY;
  document.getElementById('audience-room-add-label').value = 'Sam';
  document.querySelector('.audience-room__add-form').dispatchEvent(new Event('submit', { cancelable: true }));
  await until(() => rowStatus() === EN.audience.room.statusReady);
}, 20000);

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('Test buzz from the room window (FT-119)', () => {
  it('paused: the row\'s Test buzz moves the device (70 then 20, FW4 0-1) and flashes the screen once; the viewer is set up again', async () => {
    expect(buzzBtn().disabled).toBe(false);
    expect(buzzAllBtn().disabled).toBe(false);
    buzzBtn().click();
    await until(() => hdsp().length === 2);
    expect(hdsp().map((e) => [e.position, Math.round(e.xpt * 100) / 100])).toEqual([[70, 0.7], [20, 0.2]]);
    expect(sentOf(AUDIENCE.TEST_BUZZ)).toEqual([{ type: AUDIENCE.TEST_BUZZ, key: KEY }]);
    expect(flashes).toBe(1);
    // It ends stopped, back in HSSP, with the script set up again.
    await until(() => deviceOf(world, KEY).url === urlFor('a') && rowStatus() === EN.audience.room.statusReady);
    expect(deviceOf(world, KEY)).toMatchObject({ mode: 'hssp', playing: false });

    // The next play follows the script.
    player.playing = true;
    bridge.onPlaying();
    await until(() => deviceOf(world, KEY).playing && rowStatus() === PLAYING);
    expect(deviceOf(world, KEY).playUrl).toBe(urlFor('a'));
  }, 20000);

  it('playing: Test buzz is off, and a buzz sent anyway moves nothing and flashes nothing', async () => {
    expect(rowStatus()).toBe(PLAYING);
    expect(buzzBtn().disabled).toBe(true);
    expect(buzzAllBtn().disabled).toBe(true);
    const before = { moves: hdsp().length, flashes };
    window.funsync.audiencePopoutRelay('to-parent', { type: AUDIENCE.TEST_BUZZ, key: KEY });
    window.funsync.audiencePopoutRelay('to-parent', { type: AUDIENCE.TEST_BUZZ_ALL });
    await wait(300);
    expect(hdsp().length).toBe(before.moves);
    expect(flashes).toBe(before.flashes);
    expect(deviceOf(world, KEY).playing).toBe(true);
  }, 20000);
});

describe('Resend from the room window (FT-121)', () => {
  it('a Handy that dropped while playing reads Disconnected; Resend connects it again and it plays the current video', async () => {
    expect(rowStatus()).toBe(PLAYING);
    // The viewer's Handy is switched off: HandyManager's health check loses
    // it, and the next command the room sends finds it gone.
    powerCycle(world, KEY);
    world.managers[0]._handleDeviceLost();
    player.playing = false;
    bridge.onPaused();
    await until(() => rowStatus() === EN.audience.room.statusDisconnected);
    expect(resendBtn().disabled).toBe(false);
    // Switched back on (HandyManager still has it lost), the video plays
    // again: nothing reaches it on its own.
    player.playing = true;
    bridge.onPlaying();
    await wait(300);
    expect(deviceOf(world, KEY).playing).toBe(false);
    expect(rowStatus()).toBe(EN.audience.room.statusDisconnected);

    // Resend: connect, clock sync, stop, the script, and the play.
    const n = landed(world, KEY).length;
    resendBtn().click();
    await until(() => deviceOf(world, KEY).playing && rowStatus() === PLAYING);
    expect(sentOf(AUDIENCE.RESEND)).toEqual([{ type: AUDIENCE.RESEND, key: KEY }]);
    expect(landed(world, KEY).slice(n)).toEqual(['sync', 'stop', 'setup', 'play']);
    expect(deviceOf(world, KEY).playUrl).toBe(urlFor('a'));
    expect(world.managers.length).toBe(1);      // the same row, the same HandyManager
  }, 20000);

  it('a muted viewer: Resend is off, and a RESEND sent anyway sends its device nothing', async () => {
    muteBtn().click();
    await until(() => !deviceOf(world, KEY).playing && rowStatus() === EN.audience.room.statusMuted);
    expect(resendBtn().disabled).toBe(true);
    const sent = world.sent.length;
    window.funsync.audiencePopoutRelay('to-parent', { type: AUDIENCE.RESEND, key: KEY });
    await wait(300);
    expect(world.sent.length).toBe(sent);
    expect(rowStatus()).toBe(EN.audience.room.statusMuted);

    // Leave the device stopped.
    player.playing = false;
    bridge.onPaused();
  }, 20000);
});
