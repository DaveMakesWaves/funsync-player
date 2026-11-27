/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// ButtplugManager.stopSustainedOutputs sends every zero at once (FN-02 note,
// TODO triage 2026-11-23): awaited one after another, a device with vibrate
// AND rotate stopped its second motor one Intiface round trip late, and a
// failed first zero skipped the rest. The real method; only the four
// senders are fakes that answer when the test says.
import { describe, it, expect } from 'vitest';
import { ButtplugManager } from '../../renderer/js/buttplug-manager.js';

function manager(devices) {
  const m = new ButtplugManager();
  m._client = {};
  m._connected = true;
  Object.defineProperty(m, 'devices', { get: () => devices });
  const started = [];
  const pending = [];
  const fake = (name) => (index) => new Promise((resolve, reject) => {
    started.push(`${name}:${index}`);
    pending.push({ resolve, reject, name, index });
  });
  m.sendVibrate = fake('vibrate');
  m.sendOscillate = fake('oscillate');
  m.sendRotate = fake('rotate');
  m.sendScalar = fake('scalar');
  return { m, started, pending };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('stopSustainedOutputs', () => {
  it('both motors of a vibrate + rotate device (and every device) get their zero before any answers', async () => {
    const { m, started, pending } = manager([
      { index: 0, canVibrate: true, canRotate: true },
      { index: 1, canOscillate: true, canLinear: true },
    ]);
    const done = m.stopSustainedOutputs();
    await tick();
    expect(started).toEqual(['vibrate:0', 'rotate:0', 'oscillate:1']);
    pending.forEach((p) => p.resolve());
    await expect(done).resolves.toBeUndefined();
  });

  it('a zero that fails still lets the others go, and the failure is reported after', async () => {
    const { m, started, pending } = manager([{ index: 0, canVibrate: true, canRotate: true, canScalar: true }]);
    const done = m.stopSustainedOutputs();
    await tick();
    expect(started).toEqual(['vibrate:0', 'rotate:0', 'scalar:0']);
    pending[0].reject(new Error('device busy'));
    pending[1].resolve();
    pending[2].resolve();
    await expect(done).rejects.toThrow('device busy');
  });

  it('not connected: nothing is sent', async () => {
    const { m, started } = manager([{ index: 0, canVibrate: true }]);
    m._connected = false;
    await m.stopSustainedOutputs();
    expect(started).toEqual([]);
  });
});
