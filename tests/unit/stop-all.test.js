/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Stop all (design review, 2026-11-23; DESIGN.md §1.6 S1 / S2, §2.15). How
// the devices stopped depended on what drove them: Space for a video, ✕ for
// the script player, a second X for a toggled finisher, Stop in the pattern
// drawer, the phone's own controls. Escape stopped nothing, and nothing in
// the app said "stop all devices". Now one call, App.stopEverything, stops
// all of it, from Shift+Space, the Stop buttons, the optional global hotkey,
// the pop-out's Shift+Space and the phone's Stop.
//
// The REAL DeviceGate (device-gate.js) holds a phone or headset that keeps
// playing after the pause (S2: a stop never undoes itself).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { liftAppClass } from './helpers/app-methods.js';
import { DeviceGate, installDeviceGate } from '../../renderer/js/device-gate.js';
import * as PLAYERWIN from '../../renderer/js/player-popout-protocol.js';

const toasts = [];
const App = liftAppClass(
  ['stopEverything', '_stopAllDrivingSource', '_holdDevicesAfterStopAll', '_releaseStopAllHold'],
  {
    t: (k) => k,
    showToast: (msg, type) => toasts.push([msg, type]),
    PLAYERWIN,
    STOP_ALL_HOLD_OWNER: 'stop-all-hold',
  },
);

class FakeProxy extends EventTarget {
  constructor(paused = false) { super(); this.paused = paused; }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
}

function rig({ driving = 'local', proxyPaused = false } = {}) {
  const calls = [];
  const log = (name) => (...a) => { calls.push(name); return a.length ? undefined : undefined; };
  const video = { paused: false, pause: vi.fn(function pause() { this.paused = true; calls.push('video.pause'); }) };
  const proxy = new FakeProxy(proxyPaused);
  const tcode = { connected: true, stop: vi.fn(() => { calls.push('tcode.stop'); return []; }), sendAxes: vi.fn(() => calls.push('tcode.sendAxes')) };
  const handy = { connected: true, hsspStop: vi.fn(async () => { calls.push('handy.hsspStop'); return true; }), hsspPlay: vi.fn(async () => { calls.push('handy.hsspPlay'); return true; }) };
  const buttplug = { connected: true, devices: [{}], stopAll: vi.fn(async () => { calls.push('buttplug.stopAll'); }) };
  const autoblow = { connected: true, syncStop: vi.fn(async () => { calls.push('autoblow.syncStop'); }) };
  // The originals, before the gate wraps them: what actually reached a device.
  const sent = { sendAxes: tcode.sendAxes, hsspPlay: handy.hsspPlay, stop: tcode.stop, hsspStop: handy.hsspStop };
  const gate = new DeviceGate();
  installDeviceGate(gate, 'tcode', tcode);
  installDeviceGate(gate, 'handy', handy);
  const app = Object.assign(new App(), {
    videoPlayer: { video },
    handyManager: handy,
    buttplugManager: buttplug,
    tcodeManager: tcode,
    autoblowManager: autoblow,
    audienceBridge: { roomActive: true, hsspStopAll: vi.fn(async () => { calls.push('audience.hsspStopAll'); }) },
    deviceGate: gate,
    funscriptEngine: { isLoaded: true },
    _getConnectedDeviceCount: () => 4,
    remoteBridge: { connected: true, sendToPhone: vi.fn((m) => calls.push(`phone:${m.type}`)) },
    vrBridge: { proxy: driving === 'headset' ? proxy : null, pause: vi.fn(() => { calls.push('headset.pause'); return true; }) },
    _remoteProxy: driving === 'phone' ? proxy : null,
    _remoteActive: driving === 'phone',
  });
  const player = { video: driving === 'local' ? video : proxy };
  app.tcodeSync = { player, _active: true };
  app.buttplugSync = { player, _active: true };
  app.syncEngine = { player, _active: true, start: vi.fn() };
  return { app, calls, video, proxy, tcode, handy, buttplug, autoblow, gate, sent };
}

beforeEach(() => { toasts.length = 0; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('Stop all: one call stops whatever drives the devices', () => {
  it('a playing video: paused first, then every connected device stopped, connections kept', () => {
    const { app, calls, video } = rig();
    const done = app.stopEverything({ source: 'key' });
    expect(video.paused).toBe(true);
    expect(calls[0]).toBe('video.pause');
    for (const c of ['handy.hsspStop', 'buttplug.stopAll', 'tcode.stop', 'autoblow.syncStop', 'audience.hsspStopAll']) {
      expect(calls, c).toContain(c);
    }
    expect(done).toEqual(['video', 'handy', 'buttplug', 'tcode', 'autoblow', 'audience']);
    expect(toasts).toEqual([['toast.stopAllDone', 'info']]);
  });

  it('every driver on its own clock ends: the script player, a toggled X, Edge Hold, a pattern Test', () => {
    const { app, calls } = rig();
    const order = [];
    app.scriptPlayer = { active: true, stop: vi.fn(() => order.push('script player')) };
    app.orgasmSwitch = { active: true };
    app._finishOrgasm = vi.fn(() => order.push('orgasm'));
    app._edgeActive = true;
    app._onEdgeHold = vi.fn((active, opts) => order.push(`edge ${active} ${JSON.stringify(opts)}`));
    app._fillerTest = { running: true, stop: vi.fn(() => order.push('test')) };
    const realStop = app.tcodeManager.stop;
    app.tcodeManager.stop = vi.fn((...a) => { order.push('devices'); return realStop(...a); });
    app.stopEverything({ source: 'button' });
    expect(order).toEqual([
      'script player',
      'orgasm',
      'edge false {"force":true,"skipHandyResume":true}',
      'test',
      'devices', // the device stops go last, so nothing above lands after them
    ]);
    expect(calls).toContain('tcode.stop');
  });

  it('the pop-out is told to pause; the phone and the headset are told too', () => {
    const relay = vi.fn();
    globalThis.window = { funsync: { playerPopoutRelay: relay } };
    try {
      const pop = rig();
      pop.app._playerWindowActive = true;
      pop.app.stopEverything({ source: 'popout' });
      expect(relay).toHaveBeenCalledWith('to-popout', expect.objectContaining({ type: PLAYERWIN.SET_PLAY_STATE, paused: true }));

      const phone = rig({ driving: 'phone' });
      phone.app.stopEverything({ source: 'key' });
      expect(phone.calls).toContain('phone:stop-all');

      const vr = rig({ driving: 'headset' });
      vr.app.stopEverything({ source: 'key' });
      expect(vr.calls).toContain('headset.pause');
      expect(vr.app.vrBridge.pause).toHaveBeenCalledTimes(1);
    } finally {
      delete globalThis.window;
    }
  });

  it('no device connected: the video still pauses, and the toast says so', () => {
    const { app } = rig();
    app._getConnectedDeviceCount = () => 0;
    app.audienceBridge.roomActive = false;
    app.handyManager.connected = false; app.buttplugManager.connected = false;
    app.tcodeManager.connected = false; app.autoblowManager.connected = false;
    expect(app.stopEverything()).toEqual(['video']);
    expect(toasts).toEqual([['toast.stopAllNoDevices', 'info']]);
  });

  it('one step that throws never skips the device stops (DESIGN.md §4.9)', () => {
    const { app, calls } = rig();
    app.scriptPlayer = { active: true, stop: () => { throw new Error('boom'); } };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    app.stopEverything();
    expect(calls).toEqual(expect.arrayContaining(['handy.hsspStop', 'tcode.stop', 'buttplug.stopAll']));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('S2: a phone or headset still playing is held at once, never resumed by itself', () => {
  it('the device stops go out first: the hold never blocks Stop all\'s own stops', () => {
    const { app, sent, gate } = rig({ driving: 'phone' });
    app.stopEverything();
    expect(sent.stop).toHaveBeenCalledTimes(1);
    expect(sent.hsspStop).toHaveBeenCalledTimes(1);
    expect(gate.closed).toBe(true);
  });

  it('the phone obeys: held at once, lifted by its pause a moment later, no warning', () => {
    const { app, proxy, gate } = rig({ driving: 'phone' });
    app.stopEverything();
    expect(gate.owner).toBe('stop-all-hold');
    proxy.pause();
    expect(gate.closed).toBe(false);
    vi.advanceTimersByTime(1600);
    expect(toasts.map(([, type]) => type)).toEqual(['info']);
    expect(app._stopAllHold).toBeFalsy();
  });

  it('a source already paused is not held', () => {
    const { app, gate } = rig({ driving: 'phone', proxyPaused: true });
    app.stopEverything();
    expect(gate.closed).toBe(false);
  });

  it('the phone plays on: nothing it sends reaches a device, at once and for good, until it pauses', () => {
    const { app, proxy, gate, tcode, handy, sent } = rig({ driving: 'phone' });
    app.stopEverything();
    // Its engines tick right after the stop (live: 56 ms): nothing reaches a device.
    tcode.sendAxes({ L0: 80 });
    handy.hsspPlay();
    expect(sent.sendAxes).not.toHaveBeenCalled();
    expect(sent.hsspPlay).not.toHaveBeenCalled();
    expect(gate.blocked).toBe(2);
    vi.advanceTimersByTime(1600);
    expect(toasts.at(-1)).toEqual(['toast.stopAllPhoneKeptPlaying', 'warn']);
    // It never lifts by itself.
    vi.advanceTimersByTime(60_000);
    expect(gate.closed).toBe(true);
    // The phone pauses: the hold lifts, and its next play drives the devices.
    proxy.pause();
    expect(gate.closed).toBe(false);
    tcode.sendAxes({ L0: 20 });
    expect(sent.sendAxes).toHaveBeenCalledTimes(1);
  });

  it('a headset that plays on gets the same hold, with its own warning', () => {
    const { app, gate } = rig({ driving: 'headset' });
    app.stopEverything();
    expect(gate.closed).toBe(true);
    vi.advanceTimersByTime(1600);
    expect(toasts.at(-1)).toEqual(['toast.stopAllHeadsetKeptPlaying', 'warn']);
  });

  it('this window\'s own video is never held (its pause is certain)', () => {
    const { app, gate } = rig({ driving: 'local' });
    app.stopEverything();
    expect(gate.closed).toBe(false);
  });

  it('X, Z, a Test, this window\'s play, the phone leaving or the headset session ending lift it', () => {
    const src = fs.readFileSync('renderer/js/app.js', 'utf8').replace(/\r\n/g, '\n');
    const body = (name) => src.slice(src.indexOf(`  ${name}(`), src.indexOf(`  ${name}(`) + 600);
    expect(body('_onOrgasmHold')).toContain("if (active) this._releaseStopAllHold?.('X');");
    expect(body('_onEdgeHold')).toContain("if (active) this._releaseStopAllHold?.('Z');");
    expect(body('_startFillerTest')).toContain("this._releaseStopAllHold?.('a pattern Test');");
    expect(body('_onRemotePhoneDisconnected')).toContain("this._releaseStopAllHold?.('the phone left')");
    expect(body('_stopVRSync')).toContain("this._releaseStopAllHold?.('the headset session ended')");
    expect(src).toContain("this.videoPlayer?.video?.addEventListener?.('play', () => this._releaseStopAllHold?.('this window played'));");
  });

  it('a gate the script player already holds is left alone (no second owner)', () => {
    const { app, gate, proxy } = rig({ driving: 'phone' });
    gate.close('script-player');
    app._holdDevicesAfterStopAll({ kind: 'phone', proxy });
    expect(gate.owner).toBe('script-player');
    expect(app._stopAllHold).toBeFalsy();
  });

  it('a hold only ever opens its own gate', () => {
    const { app, gate } = rig({ driving: 'phone' });
    app.stopEverything();
    vi.advanceTimersByTime(1600);
    gate.close('script-player'); // the script player started meanwhile
    app._releaseStopAllHold('test');
    expect(gate.owner).toBe('script-player');
  });
});

describe('the triggers all call the one stop', () => {
  const src = fs.readFileSync('renderer/js/app.js', 'utf8').replace(/\r\n/g, '\n');
  it('Shift+Space, the buttons, the global hotkey, the pop-out, the editor pop-out and the phone', () => {
    expect(src).toContain("this._keyboard.onStopAll = () => this.stopEverything({ source: 'key' });");
    expect(src).toContain("onStopAll: () => this.stopEverything({ source: 'button' }),");
    expect(src).toContain("document.getElementById('btn-player-stop-all')?.addEventListener('click', () => this.stopEverything({ source: 'button' }));");
    expect(src).toContain("} else if (action === 'stopAll') {\n      this.stopEverything({ source: 'hotkey' });");
    expect(src).toContain("if (type === PLAYERWIN.STOP_ALL) { this.stopEverything({ source: 'popout' }); return; }");
    expect(src).toContain("this.remoteBridge.onPhoneStopAll = () => this.stopEverything({ source: 'phone' });");
    expect(src).toContain("this.scriptEditor.onStopAll = () => this.stopEverything({ source: 'editor' });");
  });
});
