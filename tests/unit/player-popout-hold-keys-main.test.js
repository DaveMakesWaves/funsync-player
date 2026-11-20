/**
 * @vitest-environment node
 * No DOM required — the REAL app.js methods are lifted over recording
 * fakes. See notes/CLAUDE.md "Test environments".
 */
// X and Z in the popped-out player (next major, Dave 2026-11-17), the main
// window's half. The pop-out sends 'orgasm-hold' / 'edge-hold' with
// active true on the press and false on the release
// (player-popout-hold-keys.test.js). Main hands them to the handlers its own
// keyboard calls (keyboard.onOrgasmHold -> _onOrgasmHold, onEdgeHold ->
// _onEdgeHold), so hold or toggle, X over Z and every other rule apply as
// for a key pressed in the main window. A window that closes with a key
// still held lets go of it (its key-up can never come).
//
// REAL lifted: _initPlayerWindow, _onPlayerWindowMessage,
// _releasePopoutHoldKeys, _onOrgasmHold, _finishOrgasm,
// _maybeToastOrgasmDemotion, _onEdgeHold. REAL OrgasmSwitch (its loop on a
// manual timer) over a fake Buttplug manager with the real method names.
// Asserted: what the devices are sent and which engines stop and start.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as PLAYERWIN from '../../renderer/js/player-popout-protocol.js';
import { OrgasmSwitch } from '../../renderer/js/orgasm-switch.js';
import { ButtplugManager } from '../../renderer/js/buttplug-manager.js';
import { liftAppClass } from './helpers/app-methods.js';

let playerEvent;
let app;
let bp;
let settings;
let events;
let toasts;
let ticks;

const fromWindow = (type, fields) => playerEvent({ type: 'message', payload: PLAYERWIN.makeMessage(type, fields) });
const FINISHER = JSON.stringify({ actions: [{ at: 0, pos: 0 }, { at: 500, pos: 100 }, { at: 1000, pos: 0 }] });

function build() {
  const window = {
    funsync: {
      onPlayerPopoutEvent: (cb) => { playerEvent = cb; },
      playerPopoutRelay: () => {},
    },
  };
  const Lifted = liftAppClass([
    '_initPlayerWindow', '_onPlayerWindowMessage', '_releasePopoutHoldKeys',
    '_onOrgasmHold', '_finishOrgasm', '_maybeToastOrgasmDemotion', '_onEdgeHold',
  ], {
    window, PLAYERWIN, console,
    t: (k) => k,
    showToast: (msg) => { toasts.push(msg); },
    document: { getElementById: () => null },
  });
  app = new Lifted();
  // The fake manager has the real ButtplugManager's method names (checked below).
  bp = {
    connected: true,
    devices: [{ index: 0, name: 'Stroker', canLinear: true }],
    sendLinear: vi.fn((i, pos) => { events.push(`linear:${pos}`); }),
    sendVibrate: vi.fn(),
    sendRotate: vi.fn(),
    stopSustainedOutputs: vi.fn(() => { events.push('bp:stopSustained'); }),
  };
  const buttplugSync = {
    _active: true,
    stop: vi.fn(function stop() { this._active = false; events.push('bpSync:stop'); }),
    start: vi.fn(function start() { this._active = true; events.push('bpSync:start'); }),
  };
  Object.assign(app, {
    settings: { get: (k) => settings[k] },
    buttplugManager: bp,
    buttplugSync,
    _stopAllDevicesIdle: () => { events.push('idle'); },
    _updatePlayerWindowButton: () => {},
    _deactivatePlayerWindow: () => { events.push('foldBack'); },
    _currentView: () => 'library',
    _navigateTo: () => {},
  });
  app.orgasmSwitch = new OrgasmSwitch({
    buttplugManager: bp,
    onActivate: () => { events.push('orgasm:on'); if (buttplugSync._active) buttplugSync.stop(); },
    onDeactivate: () => { events.push('orgasm:off'); bp.stopSustainedOutputs(); buttplugSync.start(); },
  });
  app.orgasmSwitch.setTimerImpl((fn) => { ticks.push(fn); return ticks.length; }, () => {});
  app.orgasmSwitch.loadScript(FINISHER);
  app._initPlayerWindow();
  playerEvent({ type: 'opened' });
}

beforeEach(() => {
  settings = { 'player.orgasmSwitchMode': 'hold', 'player.edgeHoldMode': 'hold' };
  events = [];
  toasts = [];
  ticks = [];
  build();
});

describe('the fakes mirror the real Buttplug manager', () => {
  it('every method the switch and the release call exists on ButtplugManager', () => {
    for (const m of ['sendLinear', 'sendVibrate', 'sendRotate', 'stopSustainedOutputs']) {
      expect(typeof ButtplugManager.prototype[m], m).toBe('function');
    }
  });
});

describe('X held in the player window', () => {
  it('the press starts the Orgasm loop on the devices, the release hands them back', () => {
    fromWindow(PLAYERWIN.ORGASM_HOLD, { active: true });
    expect(app.orgasmSwitch.active).toBe(true);
    expect(events.slice(0, 2)).toEqual(['orgasm:on', 'bpSync:stop']);
    expect(bp.sendLinear).toHaveBeenCalled(); // the first tick drove the stroker
    events.length = 0;
    fromWindow(PLAYERWIN.ORGASM_HOLD, { active: false });
    expect(app.orgasmSwitch.active).toBe(false);
    expect(events).toEqual(['orgasm:off', 'bp:stopSustained', 'bpSync:start']);
  });

  it('toggle mode (as set): a press starts, the release is ignored, the next press finishes', () => {
    settings['player.orgasmSwitchMode'] = 'toggle';
    fromWindow(PLAYERWIN.ORGASM_HOLD, { active: true });
    fromWindow(PLAYERWIN.ORGASM_HOLD, { active: false });
    expect(app.orgasmSwitch.active).toBe(true);
    fromWindow(PLAYERWIN.ORGASM_HOLD, { active: true });
    expect(app.orgasmSwitch.active).toBe(false);
    // Finish: the engines are NOT handed back (the toggle's own rule).
    expect(app._orgasmFinishStop).toBe(true);
  });

  it('with no finisher set, X says so, as in the main window', () => {
    app.orgasmSwitch.loadPlan(null);
    fromWindow(PLAYERWIN.ORGASM_HOLD, { active: true });
    expect(toasts).toEqual(['toast.orgasmNotConfigured']);
  });
});

describe('Z held in the player window', () => {
  it('the press stops the devices, the release restarts what it stopped', () => {
    fromWindow(PLAYERWIN.EDGE_HOLD, { active: true });
    expect(app._edgeActive).toBe(true);
    expect(events).toEqual(['bpSync:stop', 'idle', 'bp:stopSustained']);
    events.length = 0;
    fromWindow(PLAYERWIN.EDGE_HOLD, { active: false });
    expect(app._edgeActive).toBe(false);
    expect(events).toEqual(['bpSync:start']);
  });

  it('toggle mode (as set): the release is ignored, the next press resumes', () => {
    settings['player.edgeHoldMode'] = 'toggle';
    fromWindow(PLAYERWIN.EDGE_HOLD, { active: true });
    fromWindow(PLAYERWIN.EDGE_HOLD, { active: false });
    expect(app._edgeActive).toBe(true);
    fromWindow(PLAYERWIN.EDGE_HOLD, { active: true });
    expect(app._edgeActive).toBe(false);
    expect(events.at(-1)).toBe('bpSync:start');
  });

  it('X pressed while Z is held lets Z go first (the main window\'s rule)', () => {
    fromWindow(PLAYERWIN.EDGE_HOLD, { active: true });
    fromWindow(PLAYERWIN.ORGASM_HOLD, { active: true });
    expect(app._edgeActive).toBe(false);
    expect(app.orgasmSwitch.active).toBe(true);
  });

  it('Z is refused while X is on (the main window\'s rule)', () => {
    fromWindow(PLAYERWIN.ORGASM_HOLD, { active: true });
    fromWindow(PLAYERWIN.EDGE_HOLD, { active: true });
    expect(app._edgeActive).toBeFalsy();
  });

  it('a payload without a literal true is a release, never a press', () => {
    fromWindow(PLAYERWIN.EDGE_HOLD, { active: 'yes' });
    fromWindow(PLAYERWIN.ORGASM_HOLD, {});
    expect(app._edgeActive).toBeFalsy();
    expect(app.orgasmSwitch.active).toBe(false);
  });
});

describe('the player window closes with a key still held', () => {
  it('a held X and Z are let go before playback folds back', () => {
    fromWindow(PLAYERWIN.EDGE_HOLD, { active: true });
    // X takes over from Z (X's rule lets Z go): only X is on when the window
    // goes, with both keys still down in it.
    fromWindow(PLAYERWIN.ORGASM_HOLD, { active: true });
    events.length = 0;
    playerEvent({ type: 'closed' });
    expect(app.orgasmSwitch.active).toBe(false);
    expect(events).toEqual(['orgasm:off', 'bp:stopSustained', 'bpSync:start', 'foldBack']);
  });

  it('a held Z alone is let go too', () => {
    fromWindow(PLAYERWIN.EDGE_HOLD, { active: true });
    events.length = 0;
    playerEvent({ type: 'closed' });
    expect(app._edgeActive).toBe(false);
    expect(events).toEqual(['bpSync:start', 'foldBack']);
  });

  it('keys already let go, or a toggle left on, are left as they are', () => {
    fromWindow(PLAYERWIN.ORGASM_HOLD, { active: true });
    fromWindow(PLAYERWIN.ORGASM_HOLD, { active: false });
    settings['player.edgeHoldMode'] = 'toggle';
    fromWindow(PLAYERWIN.EDGE_HOLD, { active: true });
    fromWindow(PLAYERWIN.EDGE_HOLD, { active: false }); // the toggle's release: ignored
    events.length = 0;
    playerEvent({ type: 'closed' });
    expect(app._edgeActive).toBe(true); // a toggle is a deliberate state
    expect(events).toEqual(['foldBack']);
  });
});
