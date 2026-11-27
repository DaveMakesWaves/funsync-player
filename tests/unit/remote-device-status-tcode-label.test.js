/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// E-05 (2026-11-07; cosmetic, also in v0.9.2): the phone's Connected devices
// pill called a UDP or WebSocket T-Code device "TCode (serial)", while the
// desktop calls it "TCode (127.0.0.1:18099)". The device-status message built
// its label from `tcodeManager.portPath`, which only a serial link has.
//
// The REAL app.js `_pushRemoteDeviceStatus` (lifted) and a REAL TCodeManager
// connected over each transport through a stubbed IPC (no device, no port);
// asserted on the label in the message the phone is sent.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { liftAppClass } from './helpers/app-methods.js';
import { TCodeManager } from '../../renderer/js/tcode-manager.js';

const Lifted = liftAppClass(['_pushRemoteDeviceStatus', '_pushRemoteOrgasmState', '_connectedDevices'], {});

let savedWindow;
beforeEach(() => {
  savedWindow = globalThis.window;
  globalThis.window = {
    funsync: {
      tcodeConnect: async () => ({ success: true }),
      onTcodeDisconnected: () => () => {},
      tcodeSend: async () => true,
      tcodeDisconnect: async () => {},
    },
  };
});
afterEach(() => { globalThis.window = savedWindow; });

async function phoneLabelFor(kind, opts) {
  const tcodeManager = new TCodeManager();
  expect(await tcodeManager.connect(kind, opts)).toBe(true);
  const sent = [];
  const app = Object.assign(new Lifted(), {
    settings: { get: () => 0 },
    handyManager: null, buttplugManager: null, autoblowManager: null, orgasmSwitch: null,
    tcodeManager,
    sessionTracker: null,
    remoteBridge: { connected: true, sendToPhone: (m) => sent.push(m) },
  });
  app._pushRemoteDeviceStatus();
  const status = sent.find((m) => m.type === 'device-status');
  const label = status.devices.find((d) => d.kind === 'tcode')?.label;
  // What the desktop's own device list calls it (app.js `_registerKnownDevice`).
  return { label, desktop: `TCode (${tcodeManager.endpoint})` };
}

describe('E-05: the phone names a T-Code device by its own endpoint, as the desktop does', () => {
  it('UDP: "TCode (127.0.0.1:18099)", not "TCode (serial)"', async () => {
    const { label, desktop } = await phoneLabelFor('udp', { host: '127.0.0.1', port: 18099 });
    expect(label).toBe('TCode (127.0.0.1:18099)');
    expect(label).toBe(desktop);
  });

  it('WebSocket: the URL', async () => {
    const { label, desktop } = await phoneLabelFor('websocket', { url: 'ws://127.0.0.1:12346' });
    expect(label).toBe('TCode (ws://127.0.0.1:12346)');
    expect(label).toBe(desktop);
  });

  it('serial: the COM port, as before', async () => {
    const { label, desktop } = await phoneLabelFor('serial', { path: 'COM7', baudRate: 115200 });
    expect(label).toBe('TCode (COM7)');
    expect(label).toBe(desktop);
  });
});
