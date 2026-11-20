/**
 * @vitest-environment jsdom
 * jsdom on purpose: this imports the REAL audience pop-out renderer
 * (renderer/audience-room.js), which renders into audience-room.html's DOM
 * at import time, and i18n.js walks that document (notes/CLAUDE.md "Test
 * environments").
 */
// Block F decision 5 (Dave, 2026-11-19: "5 yes"; also in v0.9.2): the
// Audience room's "Hide keys" is ON by default. The room showed every
// viewer's Handy key in plain text unless the streamer had pressed Hide keys,
// so a stream or a screen share of the room showed them. `audience.hideKeys`
// had no default (absent read as false). Now store.js defaults it to true,
// the app reads an absent value as hidden, and the room starts masked.
//
// What a stored value means: the only writer is the room's Hide keys button
// and its first press stores true, so absent = never touched (now hidden)
// and a stored false = a press that chose to show them (kept, no migration).
//
// The REAL app relay (_wireAudiencePopoutRelay, _pushAudienceInitialState),
// the REAL AudienceBridge and the REAL room renderer, as in
// audience-room-mute.test.js; store.js's real DEFAULTS and applyDefaults.
// No network; the viewer key is a fake.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import * as AUDIENCE from '../../renderer/js/audience-popout-protocol.js';
import { AudienceBridge } from '../../renderer/js/audience-bridge.js';
import { eventBus } from '../../renderer/js/event-bus.js';
import { liftAppClass } from './helpers/app-methods.js';
import { makeWorld, makeFakeHandyCtor, makeUploader, scriptContent } from './helpers/fake-viewer-handy.js';
import { applyDefaults, DEFAULTS } from '../../electron/store.js';

const html = fs.readFileSync('renderer/audience-room.html', 'utf8');
const bodyInner = html.slice(html.indexOf('>', html.indexOf('<body')) + 1, html.lastIndexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '');

const KEY = 'VIEWERKEY77';
const world = makeWorld();
const player = { playing: false, timeMs: 0, rate: 1 };
const uploader = makeUploader({ latencyFor: () => 10 });
const stored = new Map();      // the streamer's saved settings (nothing about Hide keys yet)
const up = [];
let toPopout = null;
let toApp = null;
let app = null;
let bridge = null;
let bootAddKeyType = null;     // the add field as the room first paints, before main's state

const deliver = (cb, payload) => setTimeout(() => cb?.({ type: 'message', payload }), 0);
const row = () => document.querySelector(`[data-viewer-key="${KEY}"]`);
const shownKey = () => row()?.querySelector('.audience-room__card-key')?.textContent;
const addKeyInput = () => document.getElementById('audience-room-add-key');
const hideKeysBtn = () => document.querySelector('.audience-room__hide-keys-btn');

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
  app = new App();
  app.settings = { get: (k) => stored.get(k), set: (k, v) => { stored.set(k, v); } };
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
  // The room paints once on its own (i18n ready) before main's INITIAL_STATE.
  await until(() => addKeyInput());
  bootAddKeyType = addKeyInput().type;
  bridge.openRoom();
  toPopout({ type: 'opened' });
  await until(() => document.querySelector('.audience-room__add-form'));
}, 20000);

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('store.js: Hide keys defaults to on, and a stored choice stays', () => {
  it('the default is hidden', () => {
    expect(DEFAULTS.settings.audience?.hideKeys).toBe(true);
  });

  it('an install that never touched it reads hidden; its saved viewers are kept', () => {
    expect(applyDefaults({ player: {} }, DEFAULTS.settings).audience.hideKeys).toBe(true);
    const viewers = [{ key: 'VIEWERA1', label: 'Alice', offsetMs: 0 }];
    const read = applyDefaults({ audience: { viewers } }, DEFAULTS.settings).audience;
    expect(read.hideKeys).toBe(true);
    expect(read.viewers).toEqual(viewers);
  });

  it('a stored false (the streamer pressed it to show the keys) is a choice and stays; a stored true stays', () => {
    expect(applyDefaults({ audience: { hideKeys: false } }, DEFAULTS.settings).audience.hideKeys).toBe(false);
    expect(applyDefaults({ audience: { hideKeys: true } }, DEFAULTS.settings).audience.hideKeys).toBe(true);
  });
});

describe('the room masks every key for a streamer who never touched Hide keys', () => {
  it('its first paint, before main has said anything, is masked', () => {
    expect(bootAddKeyType).toBe('password');
  });

  it('a viewer added from the room shows dots, the add field is masked, and Hide keys reads pressed', async () => {
    expect(stored.has('audience.hideKeys')).toBe(false);
    bridge.setScript(bridge.beginSource({ title: 'a' }), { content: scriptContent('a'), title: 'a' });
    expect(addKeyInput().type).toBe('password');
    addKeyInput().value = KEY;
    document.getElementById('audience-room-add-label').value = 'Sam';
    document.querySelector('.audience-room__add-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await until(() => !!row());
    expect(shownKey()).toBe('••••••••');
    expect(row().textContent).not.toContain(KEY);
    expect(hideKeysBtn().getAttribute('aria-pressed')).toBe('true');
  });

  it('Hide keys pressed off: the keys show and false is saved; a reopened room keeps them shown', async () => {
    hideKeysBtn().click();
    await until(() => shownKey() === KEY);
    expect(stored.get('audience.hideKeys')).toBe(false);
    expect(up.filter((m) => m.type === AUDIENCE.SET_HIDE_KEYS).map((m) => m.hideKeys)).toEqual([false]);
    // The room is opened again: its state comes from the saved setting.
    app._pushAudienceInitialState();
    await new Promise((r) => setTimeout(r, 30));
    expect(shownKey()).toBe(KEY);
    expect(addKeyInput().type).toBe('text');
  });

  it('pressed on again: masked again, and true is saved', async () => {
    hideKeysBtn().click();
    await until(() => shownKey() === '••••••••');
    expect(stored.get('audience.hideKeys')).toBe(true);
  });

  it('a room state that does not say (no hideKeys field) is read as hidden', async () => {
    hideKeysBtn().click();
    await until(() => shownKey() === KEY);
    toPopout({ type: 'message', payload: { type: AUDIENCE.INITIAL_STATE, roomActive: true, viewers: bridge.viewers, theme: 'dark', locale: 'en' } });
    await until(() => shownKey() === '••••••••');
  });
});
