/**
 * @vitest-environment jsdom
 * jsdom: the note on the video is DOM (notes/CLAUDE.md "Test environments").
 */
// Z across a video change (lr_x3, EroScripts #447; Dave 2026-11-26).
// Reported: Z set to toggle, Z on, then another video: the device moved again
// on the new video while the app still thought Z was on, so the next press did
// nothing visible and only a second press stopped the device.
// Dave's rule: by default a new video resets Z (off, its script plays, one
// press stops it). Settings > Edge Hold can keep Z on into the next video:
// the new video's script waits, and a note flashes on the video: "Release Z
// to start the script" (hold) / "Press Z to resume the script" (toggle).
//
// What runs is app.js's own Edge methods (lifted); the sync engines are
// recording fakes with the real classes' start / stop / _active shape.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import { liftAppClass } from './helpers/app-methods.js';
import {
  gateEngineStart, setEdgeCarryNotice, edgeCarriesAcrossVideos, edgeCarryNoticeKey,
} from '../../renderer/js/edge-hold-carry.js';
import * as PLAYERWIN from '../../renderer/js/player-popout-protocol.js';
import { ButtplugSync } from '../../renderer/js/buttplug-sync.js';
import { TCodeSync } from '../../renderer/js/tcode-sync.js';
import { SyncEngine } from '../../renderer/js/sync-engine.js';
import { AutoblowSync } from '../../renderer/js/autoblow-sync.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const CSS = fs.readFileSync('renderer/styles/player.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const t = (k) => k.split('.').reduce((o, p) => o?.[p], EN) ?? k;

const METHODS = [
  '_onEdgeHold', '_installEdgeStartGate', '_edgeOnVideoChange', '_setEdgeCarryNotice', '_dropEdgePattern',
  '_showCarryNotice',
];

function fakeEngine(name, log) {
  return {
    _active: false,
    start() { if (this._active) return; this._active = true; log.push(`${name}:start`); },
    stop() { this._active = false; log.push(`${name}:stop`); },
  };
}

let log;
let app;
let relayed;
function makeApp({ mode = 'toggle', carry = false, popout = false } = {}) {
  const settings = { 'player.edgeHoldMode': mode, 'player.edgeHoldAcrossVideos': carry };
  relayed = [];
  const Lifted = liftAppClass(METHODS, {
    t, document, console: { log() {}, warn() {} }, showToast: () => {},
    window: { funsync: { playerPopoutRelay: (dir, msg) => relayed.push(msg) } },
    PLAYERWIN, gateEngineStart, setEdgeCarryNotice, edgeCarriesAcrossVideos, edgeCarryNoticeKey,
  });
  const a = new Lifted();
  Object.assign(a, {
    settings: { get: (k) => settings[k], set: (k, v) => { settings[k] = v; } },
    buttplugSync: fakeEngine('buttplug', log),
    tcodeSync: fakeEngine('tcode', log),
    syncEngine: fakeEngine('handy', log),
    _playerWindowActive: popout,
    _stopAllDevicesIdle() { log.push('idle'); },
    _pushRemoteEdgeState() { log.push('phone'); },
    _resumeHandyAfterEdge() { a.syncEngine.start(); },
  });
  a._installEdgeStartGate();
  return a;
}
/** What a new video's own load does: its script load starts the engines. */
function newVideoLoads(a) {
  a._edgeOnVideoChange();
  a.buttplugSync.start();
  a.syncEngine.start();
}
const note = () => document.querySelector('#video-wrapper > .player__edge-notice');

beforeEach(() => {
  log = [];
  document.body.innerHTML = '<div id="video-wrapper"><video></video><button id="center-play-btn"></button></div>';
});

describe('the engines the gate wraps have a start() to wrap (the real classes)', () => {
  it.each([['ButtplugSync', ButtplugSync], ['TCodeSync', TCodeSync], ['SyncEngine', SyncEngine], ['AutoblowSync', AutoblowSync]])('%s', (_n, Cls) => {
    expect(typeof Cls.prototype.start).toBe('function');
  });
});

describe('default: a new video resets Z (lr_x3 #447)', () => {
  it('toggle: Z on, another video: the script plays there, and ONE press stops the device', () => {
    app = makeApp({ mode: 'toggle' });
    app.buttplugSync.start(); app.syncEngine.start();
    app._onEdgeHold(true);                       // press: on
    app._onEdgeHold(false);                      // its release: ignored in toggle mode
    expect(app.buttplugSync._active).toBe(false);
    newVideoLoads(app);
    expect(app._edgeActive).toBe(false);
    expect(app.buttplugSync._active).toBe(true); // the new video's script plays
    expect(app.syncEngine._active).toBe(true);
    app._onEdgeHold(true);                       // one press
    expect(app._edgeActive).toBe(true);
    expect(app.buttplugSync._active).toBe(false);
    expect(app.syncEngine._active).toBe(false);
  });

  it('hold: the new video starts with Z off; the release of the key held over it does nothing', () => {
    app = makeApp({ mode: 'hold' });
    app.buttplugSync.start();
    app._onEdgeHold(true);
    newVideoLoads(app);
    expect(app.buttplugSync._active).toBe(true);
    app._onEdgeHold(false);                      // the key comes up
    expect(app.buttplugSync._active).toBe(true);
    expect(app._edgeActive).toBe(false);
  });

  it('no note, and the phone\'s Edge button is told Z is off', () => {
    app = makeApp({ mode: 'toggle' });
    app._onEdgeHold(true);
    log.length = 0;
    app._edgeOnVideoChange();
    expect(note()).toBeNull();
    expect(log).toContain('phone');
  });

  it('a pattern hold ends with Z off, as before', () => {
    app = makeApp({ mode: 'toggle' });
    app._edgeActive = true; app._edgePatternOn = true; app._edgeLoop = { deactivate: vi.fn() };
    app._edgeOnVideoChange();
    expect(app._edgePatternOn).toBe(false);
    expect(app._edgeActive).toBe(false);
    expect(app._edgeLoop.deactivate).toHaveBeenCalled();
  });
});

describe('Settings > Edge Hold "Keep Z on into the next video"', () => {
  it('is off by default: only a literal true keeps Z on', () => {
    expect(edgeCarriesAcrossVideos(undefined)).toBe(false);
    expect(edgeCarriesAcrossVideos('true')).toBe(false);
    expect(edgeCarriesAcrossVideos(true)).toBe(true);
    const store = fs.readFileSync('electron/store.js', 'utf8');
    expect(store).toMatch(/edgeHoldAcrossVideos:\s*false/);
  });

  it('toggle: Z stays on, the new video\'s script waits, the note says press Z; one press starts it', () => {
    app = makeApp({ mode: 'toggle', carry: true });
    app.buttplugSync.start(); app.syncEngine.start();
    app._onEdgeHold(true);
    newVideoLoads(app);
    expect(app._edgeActive).toBe(true);
    expect(app.buttplugSync._active).toBe(false); // waits
    expect(app.syncEngine._active).toBe(false);
    expect(note()?.textContent).toBe(EN.player.edgeCarry.press);
    app._onEdgeHold(true);                       // one press resumes
    expect(app._edgeActive).toBe(false);
    expect(app.buttplugSync._active).toBe(true);
    expect(app.syncEngine._active).toBe(true);
    expect(note()).toBeNull();
  });

  it('hold: the note says release Z; the release starts the new video\'s script', () => {
    app = makeApp({ mode: 'hold', carry: true });
    app.buttplugSync.start();
    app._onEdgeHold(true);
    newVideoLoads(app);
    expect(app.buttplugSync._active).toBe(false);
    expect(note()?.textContent).toBe(EN.player.edgeCarry.release);
    app._onEdgeHold(false);
    expect(app.buttplugSync._active).toBe(true);
    expect(note()).toBeNull();
  });

  it('an engine Z never stopped (no script on the first video) waits too, and starts on the release', () => {
    app = makeApp({ mode: 'toggle', carry: true });
    app._onEdgeHold(true);                       // nothing was running
    newVideoLoads(app);
    expect(app.buttplugSync._active).toBe(false);
    app._onEdgeHold(true);
    expect(app.buttplugSync._active).toBe(true);
    expect(app.syncEngine._active).toBe(true);
  });

  it('a pattern hold: the pattern ends (every device stops on a video change), Z stays on, the note shows', () => {
    app = makeApp({ mode: 'toggle', carry: true });
    app._edgeActive = true; app._edgePatternOn = true; app._edgeLoop = { deactivate: vi.fn() };
    app._edgeOnVideoChange();
    expect(app._edgePatternOn).toBe(false);
    expect(app._edgeActive).toBe(true);
    expect(note()?.textContent).toBe(EN.player.edgeCarry.press);
    app.buttplugSync.start();                    // the new video's load
    expect(app.buttplugSync._active).toBe(false);
  });

  it('two videos on: one note, not two; Z off on a video: no note', () => {
    app = makeApp({ mode: 'toggle', carry: true });
    app._onEdgeHold(true);
    app._edgeOnVideoChange();
    app._edgeOnVideoChange();
    expect(document.querySelectorAll('.player__edge-notice')).toHaveLength(1);
    app._onEdgeHold(true);
    app._edgeOnVideoChange();
    expect(note()).toBeNull();
  });

  it('the player pop-out gets the note, and its removal', () => {
    app = makeApp({ mode: 'toggle', carry: true, popout: true });
    app._onEdgeHold(true);
    app._edgeOnVideoChange();
    app._onEdgeHold(true);
    const notices = relayed.filter((m) => m.type === PLAYERWIN.EDGE_NOTICE);
    expect(notices.map((m) => m.text)).toEqual([EN.player.edgeCarry.press, null]);
  });
});

describe('while Z is on, nothing starts the devices (any video)', () => {
  it('a start from anywhere (a playback-rate change, a session handing back) waits for the release', () => {
    app = makeApp({ mode: 'toggle' });
    app.syncEngine.start();
    app._onEdgeHold(true);
    app.syncEngine.start();                      // e.g. the rate back to 1x
    app.tcodeSync.start();                       // e.g. a phone session ending
    expect(app.syncEngine._active).toBe(false);
    expect(app.tcodeSync._active).toBe(false);
    app._onEdgeHold(true);
    expect(app.syncEngine._active).toBe(true);
    expect(app.tcodeSync._active).toBe(true);
  });

  it('the gate: held while on, through while off, installed once', () => {
    let on = true;
    const held = [];
    const e = { n: 0, start() { this.n += 1; return 'ran'; } };
    expect(gateEngineStart(e, 'x', { held: () => on, onHeld: (n) => held.push(n) })).toBe(true);
    expect(gateEngineStart(e, 'x', { held: () => on, onHeld: (n) => held.push(n) })).toBe(true);
    expect(e.start()).toBeUndefined();
    expect(held).toEqual(['x']);
    on = false;
    expect(e.start()).toBe('ran');
    expect(e.n).toBe(1);
    expect(gateEngineStart(null, 'y', { held: () => true, onHeld() {} })).toBe(false);
  });
});

describe('the note', () => {
  it('sits after the <video> (the play button and controls stay above), says the mode\'s line', () => {
    const w = document.getElementById('video-wrapper');
    const n = setEdgeCarryNotice(w, 'x');
    expect(n.previousElementSibling.tagName).toBe('VIDEO');
    expect(n.nextElementSibling.id).toBe('center-play-btn');
    expect(n.getAttribute('role')).toBe('status');
    expect(edgeCarryNoticeKey('toggle')).toBe('player.edgeCarry.press');
    expect(edgeCarryNoticeKey('hold')).toBe('player.edgeCarry.release');
    expect(edgeCarryNoticeKey(undefined)).toBe('player.edgeCarry.release');
  });

  it('50 % opacity, flashing, clicks pass; steady under reduced motion', () => {
    const rule = /\.player__edge-notice\s*\{([^}]*)\}/.exec(CSS)?.[1] || '';
    expect(rule).toMatch(/opacity:\s*0\.5/);
    expect(rule).toMatch(/pointer-events:\s*none/);
    expect(rule).toMatch(/animation:\s*player-edge-notice-flash/);
    expect(CSS).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.player__edge-notice\s*\{\s*animation:\s*none/);
  });
});

describe('Z from the global hotkey (always a toggle) says press, not release', () => {
  it('hold mode set, Z started by the hotkey and kept on into a new video: "Press Z…"; a held Z still says release', () => {
    app = makeApp({ mode: 'hold', carry: true });
    app._onEdgeHold(true, { force: true });      // what _onGlobalShortcut('edge') does
    app._edgeOnVideoChange();
    expect(note()?.textContent).toBe(EN.player.edgeCarry.press);
    app._onEdgeHold(false, { force: true });
    app._onEdgeHold(true);                       // a held Z key
    app._edgeOnVideoChange();
    expect(note()?.textContent).toBe(EN.player.edgeCarry.release);
  });
});
