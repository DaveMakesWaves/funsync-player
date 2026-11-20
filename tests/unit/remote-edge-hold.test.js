/**
 * @vitest-environment node
 * No DOM required — the REAL RemoteBridge over a fake observer socket and
 * the REAL app.js methods lifted over recording fakes. See notes/CLAUDE.md
 * "Test environments".
 */
// The phone's Edge button (next major, Dave 2026-11-17: "yes"), the
// desktop's half. The phone sends 'edge-hold' { active } as its Orgasm
// button sends 'orgasm-hold' (web-remote-edge-button.test.js has the phone);
// the backend relays every phone message to the observer unchanged
// (backend/tests/test_remote_sync.py pins 'edge-hold' through it). Here:
//   - RemoteBridge routes 'edge-hold' to onPhoneEdgeHold, a literal true only;
//   - _wireRemoteBridge hands it to _onEdgeHold, the keyboard-Z path, so hold
//     or toggle and X over Z apply;
//   - the desktop tells the phone Z's state ('edge-state' { active, mode }) on
//     every change, whichever surface made it, and with the device status;
//   - a phone that disconnects lets go of a held Edge (toggle mode stays), as
//     it lets go of a held Orgasm Switch.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RemoteBridge } from '../../renderer/js/remote-bridge.js';
import { liftAppClass } from './helpers/app-methods.js';

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this._listeners = { open: [], message: [], close: [], error: [] };
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type, fn) { (this._listeners[type] || []).push(fn); }
  send(data) { this.sent.push(data); }
  close() { this.readyState = FakeWebSocket.CLOSED; }
  _fire(type, evt) { for (const fn of this._listeners[type] || []) fn(evt); }
  simulateOpen() { this.readyState = FakeWebSocket.OPEN; this._fire('open', {}); }
  simulateMessage(obj) { this._fire('message', { data: JSON.stringify(obj) }); }
}
FakeWebSocket.instances = [];
const socket = () => FakeWebSocket.instances.at(-1);
const toPhone = () => socket().sent.map((s) => JSON.parse(s));
const edgeStates = () => toPhone().filter((m) => m.type === 'edge-state');
const fromPhone = (msg) => socket().simulateMessage({ from: 'phone', ip: '192.168.1.5', ...msg });

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('RemoteBridge routes the phone\'s Edge button', () => {
  it('edge-hold reaches onPhoneEdgeHold with the press and the release', () => {
    const b = new RemoteBridge();
    const spy = vi.fn();
    b.onPhoneEdgeHold = spy;
    b.connect();
    socket().simulateOpen();
    fromPhone({ type: 'edge-hold', active: true });
    fromPhone({ type: 'edge-hold', active: false });
    expect(spy.mock.calls).toEqual([[true, '192.168.1.5'], [false, '192.168.1.5']]);
  });

  it('only a literal true is a press (untrusted LAN input); no handler is no error', () => {
    const b = new RemoteBridge();
    const spy = vi.fn();
    b.onPhoneEdgeHold = spy;
    b.connect();
    socket().simulateOpen();
    fromPhone({ type: 'edge-hold', active: 'true' });
    fromPhone({ type: 'edge-hold', active: 1 });
    expect(spy.mock.calls.map((c) => c[0])).toEqual([false, false]);
    b.onPhoneEdgeHold = null;
    expect(() => fromPhone({ type: 'edge-hold', active: true })).not.toThrow();
  });

  it('the Orgasm button\'s route is unchanged', () => {
    const b = new RemoteBridge();
    const orgasm = vi.fn();
    const edge = vi.fn();
    b.onPhoneOrgasmHold = orgasm;
    b.onPhoneEdgeHold = edge;
    b.connect();
    socket().simulateOpen();
    fromPhone({ type: 'orgasm-hold', active: true });
    expect(orgasm).toHaveBeenCalledWith(true, '192.168.1.5');
    expect(edge).not.toHaveBeenCalled();
  });
});

describe('the desktop: the phone\'s Edge button is Z', () => {
  let app;
  let settings;
  let events;

  function build() {
    const Lifted = liftAppClass([
      '_wireRemoteBridge', '_onEdgeHold', '_pushRemoteEdgeState', '_pushRemoteOrgasmState',
      '_onRemotePhoneDisconnected', '_dropEdgePattern',
    ], {
      console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
      showToast: () => {}, t: (k) => k,
      SOURCE_PLAYER: { PHONE: 'phone' },
    });
    app = new Lifted();
    const engine = (name) => ({
      _active: true,
      player: null,
      stop: vi.fn(function stop() { this._active = false; events.push(`${name}:stop`); }),
      start: vi.fn(function start() { this._active = true; events.push(`${name}:start`); }),
    });
    Object.assign(app, {
      settings: { get: (k) => settings[k] },
      remoteBridge: new RemoteBridge(),
      buttplugSync: engine('bp'),
      tcodeSync: engine('tc'),
      buttplugManager: {
        connected: true,
        stopSustainedOutputs: vi.fn(() => { events.push('bp:stopSustained'); }),
        stopAll: vi.fn(() => { events.push('bp:stopAll'); }),
      },
      orgasmSwitch: { active: false, configured: true, deactivate: vi.fn() },
      _stopAllDevicesIdle: () => { events.push('idle'); },
      _remotePhoneEpoch: 0,
    });
    app._wireRemoteBridge();
    app.remoteBridge.connect();
    socket().simulateOpen();
  }

  beforeEach(() => {
    settings = { 'player.edgeHoldMode': 'hold', 'player.orgasmSwitchMode': 'hold' };
    events = [];
    build();
  });

  it('a press stops the devices, a release restarts what it stopped; the phone hears each change', () => {
    fromPhone({ type: 'edge-hold', active: true });
    expect(app._edgeActive).toBe(true);
    expect(events).toEqual(['bp:stop', 'tc:stop', 'idle', 'bp:stopSustained']);
    expect(edgeStates()).toEqual([{ type: 'edge-state', active: true, mode: 'hold' }]);
    events.length = 0;
    fromPhone({ type: 'edge-hold', active: false });
    expect(app._edgeActive).toBe(false);
    expect(events).toEqual(['bp:start', 'tc:start']);
    expect(edgeStates().at(-1)).toEqual({ type: 'edge-state', active: false, mode: 'hold' });
  });

  it('toggle mode (as set): the release is ignored, the next tap resumes; the state says toggle', () => {
    settings['player.edgeHoldMode'] = 'toggle';
    fromPhone({ type: 'edge-hold', active: true });
    fromPhone({ type: 'edge-hold', active: false });
    expect(app._edgeActive).toBe(true);
    fromPhone({ type: 'edge-hold', active: true });
    expect(app._edgeActive).toBe(false);
    expect(edgeStates()).toEqual([
      { type: 'edge-state', active: true, mode: 'toggle' },
      { type: 'edge-state', active: false, mode: 'toggle' },
    ]);
  });

  it('Z refused while X is on: nothing changes, and no state is sent', () => {
    app.orgasmSwitch.active = true;
    fromPhone({ type: 'edge-hold', active: true });
    expect(app._edgeActive).toBeFalsy();
    expect(events).toEqual([]);
    expect(edgeStates()).toEqual([]);
  });

  it('the keyboard\'s Z (the same handler) reaches the phone too', () => {
    app._onEdgeHold(true);
    expect(edgeStates()).toEqual([{ type: 'edge-state', active: true, mode: 'hold' }]);
  });

  it('an Edge pattern ended by a video change tells the phone Z is off', () => {
    app._edgeActive = true;
    app._edgePatternOn = true;
    app._dropEdgePattern('the video changed');
    expect(edgeStates().at(-1)).toEqual({ type: 'edge-state', active: false, mode: 'hold' });
  });

  it('the Orgasm Switch state still goes as before, and the Edge state can go with it', () => {
    app._pushRemoteOrgasmState();
    app._pushRemoteEdgeState();
    expect(toPhone()).toEqual([
      { type: 'orgasm-state', configured: true, active: false, mode: 'hold' },
      { type: 'edge-state', active: false, mode: 'hold' },
    ]);
  });

  it('a phone that disconnects with Edge held lets it go before the session ends', () => {
    fromPhone({ type: 'edge-hold', active: true });
    events.length = 0;
    app._onRemotePhoneDisconnected('192.168.1.5');
    expect(app._edgeActive).toBe(false);
    // Z's release restarts what it stopped, then the session's teardown
    // stops every engine and device, as for any phone that goes.
    expect(events.slice(0, 2)).toEqual(['bp:start', 'tc:start']);
    expect(events).toContain('bp:stopAll');
  });

  it('a toggled Edge survives a disconnect (a deliberate state, as for X)', () => {
    settings['player.edgeHoldMode'] = 'toggle';
    fromPhone({ type: 'edge-hold', active: true });
    app._onRemotePhoneDisconnected('192.168.1.5');
    expect(app._edgeActive).toBe(true);
  });
});
