/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// e-stim / scalar output — sends the CONCRETE buttplug v4 output type.
//
// Bug found 2026-08-06: sendScalar() sent `DeviceOutput.Scalar`, which does
// not exist in buttplug-js v4. The enum is Vibrate / Rotate / Oscillate /
// Constrict / Inflate / Position / HwPositionWithDuration / Temperature /
// Spray / Led. So `DeviceOutput.Scalar` was `undefined`, `.percent()` threw a
// TypeError, and the catch swallowed it into console.debug — which our
// logging setup does not even forward to main.log. E-stim devices connected,
// appeared routed in the UI, and silently did nothing.
//
// The existing manager tests could not catch it: they only ever exercise the
// `ButtplugSDK === null` early-return, so no send was ever performed. These
// tests load the REAL SDK, which is the only way to pin the command surface.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ButtplugManager } from '../../renderer/js/buttplug-manager.js';

function mockDevice(index, name, outputs) {
  return {
    index,
    name,
    hasOutput: vi.fn((type) => outputs.includes(type)),
    runOutput: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

describe('scalar output type (real SDK)', () => {
  let manager;

  beforeEach(async () => {
    manager = new ButtplugManager();
    // Load the real buttplug SDK so DeviceOutput is the genuine article.
    await manager.init();
  });

  it('the SDK really has no Scalar output type (the root cause)', async () => {
    const SDK = await import('../../node_modules/buttplug/dist/web/buttplug.mjs');
    expect(SDK.DeviceOutput.Scalar).toBeUndefined();
    // ...while the types we now send genuinely exist.
    expect(SDK.DeviceOutput.Constrict).toBeDefined();
    expect(SDK.DeviceOutput.Inflate).toBeDefined();
    expect(SDK.DeviceOutput.Oscillate).toBeDefined();
  });

  it('sends Constrict for a constrict device', async () => {
    const dev = mockDevice(0, 'Coyote', ['Constrict']);
    manager._devices.set(0, dev);

    await manager.sendScalar(0, 50);

    expect(dev.runOutput).toHaveBeenCalledTimes(1);
    const cmd = dev.runOutput.mock.calls[0][0];
    expect(cmd.outputType).toBe('Constrict');
    expect(cmd.value.percent).toBeCloseTo(0.5, 5);
  });

  it('sends Inflate for an inflate-only device', async () => {
    const dev = mockDevice(1, 'Inflatable', ['Inflate']);
    manager._devices.set(1, dev);

    await manager.sendScalar(1, 25);

    const cmd = dev.runOutput.mock.calls[0][0];
    expect(cmd.outputType).toBe('Inflate');
    expect(cmd.value.percent).toBeCloseTo(0.25, 5);
  });

  it('prefers Constrict when a device exposes both', async () => {
    const dev = mockDevice(2, 'Both', ['Constrict', 'Inflate']);
    manager._devices.set(2, dev);

    await manager.sendScalar(2, 100);

    expect(dev.runOutput.mock.calls[0][0].outputType).toBe('Constrict');
  });

  it('clamps out-of-range intensity rather than throwing', async () => {
    // createPercent() throws outside 0..1, which would kill the send.
    const dev = mockDevice(3, 'Coyote', ['Constrict']);
    manager._devices.set(3, dev);

    await manager.sendScalar(3, 500);
    await manager.sendScalar(3, -80);

    expect(dev.runOutput.mock.calls[0][0].value.percent).toBe(1);
    expect(dev.runOutput.mock.calls[1][0].value.percent).toBe(0);
  });

  it('warns once, and does not send, when no concrete scalar type exists', async () => {
    // A device flagged canScalar only via the vestigial `Scalar` probe.
    const dev = mockDevice(4, 'Phantom', ['Scalar']);
    manager._devices.set(4, dev);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await manager.sendScalar(4, 50);
    await manager.sendScalar(4, 60);

    expect(dev.runOutput).not.toHaveBeenCalled();
    // Once, not once per 50ms send tick.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/neither Constrict nor Inflate/);
    warn.mockRestore();
  });

  it('surfaces a send failure as a warning, not a swallowed debug line', async () => {
    const dev = mockDevice(5, 'Coyote', ['Constrict']);
    dev.runOutput.mockRejectedValue(new Error('device gone'));
    manager._devices.set(5, dev);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await manager.sendScalar(5, 50);
    await manager.sendScalar(5, 50);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/Constrict command to "Coyote" failed/);
    warn.mockRestore();
  });

  it('oscillate sends the real Oscillate type (machine path unaffected)', async () => {
    const dev = mockDevice(6, 'Hismith Sex Machine', ['Oscillate']);
    manager._devices.set(6, dev);

    await manager.sendOscillate(6, 40);

    const cmd = dev.runOutput.mock.calls[0][0];
    expect(cmd.outputType).toBe('Oscillate');
    expect(cmd.value.percent).toBeCloseTo(0.4, 5);
  });
});

describe('_scalarOutputType', () => {
  const manager = new ButtplugManager();

  it('returns null when the device exposes neither type', () => {
    expect(manager._scalarOutputType(mockDevice(0, 'x', ['Vibrate']))).toBeNull();
  });

  it('survives a device whose hasOutput throws', () => {
    const dev = {
      index: 0,
      name: 'Flaky',
      hasOutput: vi.fn(() => { throw new Error('driver blew up'); }),
    };
    expect(manager._scalarOutputType(dev)).toBeNull();
  });
});
