// FT-052 (2026-11-06, also in v0.9.2): the phone's Autoblow offset slider
// saved `autoblow.offset` and never reached the device. app.js
// `_applyRemoteOffset` called `this.autoblowSync?.setOffsetMs?.(ms)`, a method
// AutoblowSync never had, and the optional chain turned the missing method
// into silence. The Devices slider calls `autoblowManager.syncOffset`.
//
// jsdom on purpose (no node docblock): autoblow-manager.js and
// handy-manager.js import i18n.js, which branches on `typeof window` (see
// notes/CLAUDE.md "Test environments"), and the REAL AutoblowManager talks
// to `window.funsync` (the IPC stub from tests/setup.js). The REAL
// `_applyRemoteOffset` is lifted out of app.js (helpers/app-methods.js).
// What is asserted is what the device is sent and what is saved.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { liftAppClass } from './helpers/app-methods.js';
import { AutoblowManager } from '../../renderer/js/autoblow-manager.js';
import { AutoblowSync } from '../../renderer/js/autoblow-sync.js';
import { HandyManager } from '../../renderer/js/handy-manager.js';
import { ButtplugSync } from '../../renderer/js/buttplug-sync.js';
import { TCodeSync } from '../../renderer/js/tcode-sync.js';

const LiftedApp = liftAppClass(['_applyRemoteOffset'], {});

function fakeSettings(initial = {}) {
  const store = { ...initial };
  return { store, get: (k) => store[k], set: vi.fn((k, v) => { store[k] = v; }) };
}

function makeApp(parts) {
  return Object.assign(new LiftedApp(), {
    settings: fakeSettings(),
    handyManager: null, buttplugSync: null, tcodeSync: null,
    autoblowManager: null, autoblowSync: null,
    _pushRemoteDeviceStatus: vi.fn(),
  }, parts);
}

/** A REAL AutoblowManager connected through the IPC stub, as app.js builds it. */
async function connectedAutoblow(settings) {
  const ab = new AutoblowManager({
    savedOffsetState: () => ({ globalMs: settings.get('autoblow.offset') || 0, videoOffsetsInUse: false }),
  });
  window.funsync.autoblowConnect.mockResolvedValueOnce({ success: true, deviceType: 'autoblow-ultra', deviceInfo: {} });
  await ab.connect('not-a-real-token');
  return ab;
}

const autoblowSent = () => window.funsync.autoblowSyncOffset.mock.calls.map((c) => c[0]);
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => { vi.clearAllMocks(); });

describe('FT-052: the phone\'s Autoblow offset reaches the device', () => {
  it('the phone sends 1500: 1000 is saved (clamped) and sent to the connected Autoblow, as the Devices slider sends it', async () => {
    const settings = fakeSettings({ 'autoblow.offset': 0 });
    const autoblowManager = await connectedAutoblow(settings);
    const autoblowSync = new AutoblowSync({ videoPlayer: { video: new EventTarget() }, autoblowManager });
    window.funsync.autoblowSyncOffset.mockClear();
    const app = makeApp({ settings, autoblowManager, autoblowSync });

    app._applyRemoteOffset('autoblow', 1500);
    await settle();

    expect(settings.get('autoblow.offset')).toBe(1000);
    expect(autoblowSent()).toEqual([1000]);
    // The Devices slider (connection-panel.js) calls syncOffset with the
    // value it stores: the same call, so the same value on the wire.
    window.funsync.autoblowSyncOffset.mockClear();
    await autoblowManager.syncOffset(1000);
    expect(autoblowSent()).toEqual([1000]);
    expect(app._pushRemoteDeviceStatus).toHaveBeenCalled();
  });

  it('the playing video\'s own delta stays on: the phone moves the global only', async () => {
    const settings = fakeSettings({ 'autoblow.offset': 0 });
    const autoblowManager = await connectedAutoblow(settings);
    await autoblowManager.setVideoOffset(30, 0);          // this video: 30 ms later
    window.funsync.autoblowSyncOffset.mockClear();
    const app = makeApp({ settings, autoblowManager });

    app._applyRemoteOffset('autoblow', 200);
    await settle();
    expect(autoblowSent()).toEqual([170]);                  // global 200 - delta 30 (the Autoblow runs the other way)
  });

  it('disconnected: saved, nothing sent; the next connect sends the saved value', async () => {
    const settings = fakeSettings({ 'autoblow.offset': 0 });
    const autoblowManager = new AutoblowManager({
      savedOffsetState: () => ({ globalMs: settings.get('autoblow.offset') || 0, videoOffsetsInUse: false }),
    });
    const app = makeApp({ settings, autoblowManager });

    app._applyRemoteOffset('autoblow', -250);
    await settle();
    expect(settings.get('autoblow.offset')).toBe(-250);
    expect(autoblowSent()).toEqual([]);

    window.funsync.autoblowConnect.mockResolvedValueOnce({ success: true, deviceType: 'autoblow-ultra', deviceInfo: {} });
    await autoblowManager.connect('not-a-real-token');
    expect(autoblowSent()).toEqual([-250]);
  });
});

// The guard: every method `_applyRemoteOffset` calls on a device object must
// exist on that object's REAL class, so `?.` can never hide a missing one
// again. Each device object is a recorder that answers ANY method name, so a
// call to a method the real class lacks is still seen, then checked against
// the real prototype.
describe('FT-052 guard: each _applyRemoteOffset branch calls a method its real class has', () => {
  const REAL = {
    handyManager: HandyManager,
    buttplugSync: ButtplugSync,
    tcodeSync: TCodeSync,
    autoblowManager: AutoblowManager,
    autoblowSync: AutoblowSync,
  };

  function recorder(field, calls) {
    return new Proxy({ connected: true }, {
      get(target, key) {
        if (key in target) return target[key];
        if (typeof key !== 'string' || key === 'then') return undefined;
        return (...args) => { calls.push({ field, method: key, args }); };
      },
    });
  }

  for (const device of ['handy', 'buttplug', 'tcode', 'autoblow']) {
    it(`${device}: reaches a device, through methods that exist`, async () => {
      const calls = [];
      const parts = Object.fromEntries(Object.keys(REAL).map((f) => [f, recorder(f, calls)]));
      const app = makeApp(parts);
      app._applyRemoteOffset(device, 120);
      await settle();
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) {
        expect(typeof REAL[c.field].prototype[c.method], `${c.field}.${c.method}`).toBe('function');
      }
      expect(calls.some((c) => c.args[0] === 120)).toBe(true);
    });
  }
});
