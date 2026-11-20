/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL ConnectionPanel's device-settings loader is
 * called, and connection-panel.js imports modules that branch on `window`
 * (notes/CLAUDE.md "Test environments").
 */
// Block C fix-up (2026-11-06), the Buttplug side of the axis-channel fix
// (multi-axis-suffix-channels.test.js). The player now plays a `.suck`
// companion on A1 and lube on A2, as multi-axis.js AXIS_DEFINITIONS says
// (it dropped suck and put lube on pump's V1). Buttplug had followed the old
// table: its axis dropdown offered "Lube/Pump (V1)" and "Suction (V2)" and no
// A1 / A2, and ButtplugSync sent any A channel as a position (linear /
// scalar), so a suction toy (a vibrate motor) moved to A1 would get nothing.
//
// Asserted: what a device is sent over 2 s of the REAL scheduler, and the
// channel a device saved on "Suction (V2)" is put on when its settings load.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ButtplugSync } from '../../renderer/js/buttplug-sync.js';
import { ConnectionPanel } from '../../renderer/components/connection-panel.js';

const SUCK = Array.from({ length: 41 }, (_, i) => ({ at: i * 250, pos: i % 2 ? 90 : 10 }));
const device = (index, name, caps) => ({
  index, name, canLinear: false, canVibrate: false, canRotate: false, canScalar: false, canOscillate: false, ...caps,
});

function makeSync(devices) {
  const sent = [];
  const rec = (kind) => vi.fn((index, value) => { sent.push({ kind, index, value }); return Promise.resolve({ ok: true }); });
  const buttplug = {
    connected: true, devices,
    sendLinear: rec('linear'), sendVibrate: rec('vibrate'), sendRotate: rec('rotate'),
    sendScalar: rec('scalar'), sendOscillate: rec('oscillate'),
    stopAll: vi.fn().mockResolvedValue(undefined),
  };
  const player = { video: { addEventListener() {}, removeEventListener() {} }, currentTime: 0.1, paused: false, duration: 60 };
  const sync = new ButtplugSync({
    buttplugManager: buttplug, videoPlayer: player,
    funscriptEngine: { isLoaded: true, getActions: () => [] },
  });
  for (const d of devices) { sync.setRampUp(d.index, false); sync.setMaxIntensity(d.index, 100); }
  return { sync, sent, player };
}

function play(sync, player) {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance', 'Date'] });
  sync.start();
  for (let i = 0; i < 50; i++) {
    player.currentTime += 0.04;
    vi.advanceTimersByTime(40);
  }
  sync.stop();
}

afterEach(() => { vi.useRealTimers(); });

describe('A1 (suck) and A2 (lube) reach a Buttplug motor as an intensity', () => {
  for (const [tcode, name] of [['A1', 'Suction Toy'], ['A2', 'Lube Pump']]) {
    it(`a vibrate device on ${tcode} gets vibrate commands from that axis`, () => {
      const dev = device(0, name, { canVibrate: true });
      const { sync, sent, player } = makeSync([dev]);
      sync.setAxisAssignment(0, tcode);
      sync.setAxisActions(tcode, SUCK);
      play(sync, player);
      const vib = sent.filter((s) => s.index === 0 && s.kind === 'vibrate');
      expect(vib.length).toBeGreaterThan(0);
      expect(sent.filter((s) => s.kind === 'linear')).toEqual([]);
    });
  }

  it('the valve (A0) is still a position: a linear device on A0 gets strokes', () => {
    const dev = device(0, 'Valve', { canLinear: true });
    const { sync, sent, player } = makeSync([dev]);
    sync.setAxisAssignment(0, 'A0');
    sync.setAxisActions('A0', SUCK);
    play(sync, player);
    expect(sent.filter((s) => s.kind === 'linear').length).toBeGreaterThan(0);
  });
});

describe('a device saved on the old "Suction (V2)" loads on A1, where suction plays now', () => {
  function load(saved) {
    const devices = [device(3, 'Suction Toy', { canVibrate: true })];
    const sync = new ButtplugSync({ buttplugManager: { connected: true, devices }, videoPlayer: {}, funscriptEngine: {} });
    const panel = Object.assign(Object.create(ConnectionPanel.prototype), {
      buttplug: { devices },
      buttplugSync: sync,
      settings: { get: (k) => (k === 'buttplug.deviceSettings' ? saved : undefined) },
      _panel: document.createElement('div'),
    });
    panel._loadButtplugDeviceSettings();
    return sync.getAxisAssignment(3);
  }

  it('V2 becomes A1; every other saved channel is kept', () => {
    expect(load({ '3:Suction Toy': { axisAssignment: 'V2' } })).toBe('A1');
    expect(load({ '3:Suction Toy': { axisAssignment: 'V1' } })).toBe('V1');
    expect(load({ '3:Suction Toy': { axisAssignment: 'R0' } })).toBe('R0');
  });
});
