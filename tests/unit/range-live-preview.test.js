/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Live range preview — the device-side half (stingray, 2026-08-24):
//
//   "is it possible when adjusting the range sliders when no video is playing
//    or paused to have the device react in real time? I use the feedback of
//    realtime to determine the position of the device."
//
// The whole value of the feature is that the device lands on the boundary the
// slider is showing. That means the preview MUST go through the same
// invert → range → cutoff stack a scripted position goes through: a preview
// that skipped it would point at a place the script will never take the device,
// which is worse than no preview. Sending 0 or 100 pre-transform is what makes
// the arithmetic come out at exactly the min or max on screen.
//
// The other half of the contract is refusal. These are off-clock sends, so
// they must be impossible while playback owns the device.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TCodeSync } from '../../renderer/js/tcode-sync.js';
import { ButtplugSync } from '../../renderer/js/buttplug-sync.js';

function makeMockPlayer() {
  return {
    currentTime: 0,
    paused: true,
    duration: 120,
    video: {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      currentTime: 0,
      paused: true,
      duration: 120,
    },
  };
}

const makeMockFunscript = (actions = []) => ({
  isLoaded: actions.length > 0,
  getActions: () => actions,
  getRawContent: () => JSON.stringify({ actions }),
});

// --- TCode ---------------------------------------------------------------

function makeTCodeSync() {
  const tcode = { connected: true, sendAxes: vi.fn(), stop: vi.fn() };
  const sync = new TCodeSync({
    videoPlayer: makeMockPlayer(),
    funscriptEngine: makeMockFunscript(),
    tcodeManager: tcode,
  });
  return { sync, tcode };
}

/** The value actually pushed for `axis` by the most recent sendAxes call. */
function lastAxisValue(tcode, axis) {
  const call = tcode.sendAxes.mock.calls.at(-1);
  return call ? call[0][axis] : undefined;
}

describe('TCodeSync.previewAxisPosition', () => {
  let h;
  beforeEach(() => { h = makeTCodeSync(); });

  it('lands on the axis minimum when previewing the min boundary', () => {
    h.sync.setAxisRange('L0', 30, 90);
    expect(h.sync.previewAxisPosition('L0', 0, 250)).toBe(true);
    expect(lastAxisValue(h.tcode, 'L0')).toBe(30);
  });

  it('lands on the axis maximum when previewing the max boundary', () => {
    h.sync.setAxisRange('L0', 30, 90);
    h.sync.previewAxisPosition('L0', 100, 250);
    expect(lastAxisValue(h.tcode, 'L0')).toBe(90);
  });

  it('drives the axis it was asked for, not just L0', () => {
    h.sync.setAxisRange('L1', 20, 60);
    h.sync.previewAxisPosition('L1', 100, 250);
    const [axes] = h.tcode.sendAxes.mock.calls.at(-1);
    expect(axes).toEqual({ L1: 60 });
    expect(axes.L0).toBeUndefined();
  });

  it('honours per-axis invert, so the preview matches what will be felt', () => {
    h.sync.setAxisRange('L0', 0, 100);
    h.sync.setAxisInverted('L0', true);
    h.sync.previewAxisPosition('L0', 0, 250);
    expect(lastAxisValue(h.tcode, 'L0')).toBe(100);
  });

  it('honours the cutoff clamp on top of the range', () => {
    h.sync.setAxisRange('L0', 0, 100);
    h.sync.setAxisCutoff('L0', 40, 80);
    h.sync.previewAxisPosition('L0', 0, 250);
    expect(lastAxisValue(h.tcode, 'L0')).toBe(40);
  });

  it('refuses on a disabled axis', () => {
    h.sync.setAxisEnabled('R1', false);
    expect(h.sync.previewAxisPosition('R1', 100, 250)).toBe(false);
    expect(h.tcode.sendAxes).not.toHaveBeenCalled();
  });

  it('refuses when the device is not connected', () => {
    h.tcode.connected = false;
    expect(h.sync.previewAxisPosition('L0', 100, 250)).toBe(false);
    expect(h.tcode.sendAxes).not.toHaveBeenCalled();
  });

  it('refuses while a video is driving — playback owns the device', () => {
    h.sync._active = true;
    expect(h.sync.previewAxisPosition('L0', 100, 250)).toBe(false);
    expect(h.tcode.sendAxes).not.toHaveBeenCalled();
  });

  it('refuses a missing axis id rather than sending an undefined channel', () => {
    expect(h.sync.previewAxisPosition('', 100, 250)).toBe(false);
    expect(h.sync.previewAxisPosition(null, 100, 250)).toBe(false);
    expect(h.tcode.sendAxes).not.toHaveBeenCalled();
  });

  it('sendPositionNow still behaves as before — it is L0 through this path', () => {
    h.sync.setAxisRange('L0', 10, 50);
    expect(h.sync.sendPositionNow(100, 200)).toBe(true);
    expect(lastAxisValue(h.tcode, 'L0')).toBe(50);
  });
});

// --- Buttplug ------------------------------------------------------------

const linearDev = (index) => ({
  index, name: `linear-${index}`,
  canLinear: true, canVibrate: false, canScalar: false, canRotate: false,
});
const vibeDev = (index) => ({
  index, name: `vibe-${index}`,
  canLinear: false, canVibrate: true, canScalar: false, canRotate: false,
});

function makeButtplugSync(devices) {
  const buttplug = {
    connected: true,
    devices,
    sendLinear: vi.fn(),
    sendVibrate: vi.fn(),
    sendScalar: vi.fn(),
    sendRotate: vi.fn(),
    stopAll: vi.fn(),
  };
  const sync = new ButtplugSync({
    videoPlayer: makeMockPlayer(),
    funscriptEngine: makeMockFunscript(),
    buttplugManager: buttplug,
  });
  return { sync, buttplug };
}

describe('ButtplugSync.previewDevicePosition', () => {
  let h;
  beforeEach(() => { h = makeButtplugSync([linearDev(0), linearDev(1)]); });

  it('lands on that device’s minimum when previewing the min boundary', () => {
    h.sync.setDeviceRange(0, 25, 75);
    expect(h.sync.previewDevicePosition(0, 0, 250)).toBe(true);
    expect(h.buttplug.sendLinear).toHaveBeenCalledWith(0, 25, 250);
  });

  it('lands on that device’s maximum when previewing the max boundary', () => {
    h.sync.setDeviceRange(0, 25, 75);
    h.sync.previewDevicePosition(0, 100, 250);
    expect(h.buttplug.sendLinear).toHaveBeenCalledWith(0, 75, 250);
  });

  it('moves ONLY the device whose slider is being dragged', () => {
    h.sync.setDeviceRange(0, 10, 40);
    h.sync.setDeviceRange(1, 60, 90);
    h.sync.previewDevicePosition(0, 100, 250);
    expect(h.buttplug.sendLinear).toHaveBeenCalledTimes(1);
    expect(h.buttplug.sendLinear).toHaveBeenCalledWith(0, 40, 250);
  });

  it('honours per-device invert', () => {
    h.sync.setInverted(0, true);
    h.sync.previewDevicePosition(0, 0, 250);
    expect(h.buttplug.sendLinear).toHaveBeenCalledWith(0, 100, 250);
  });

  it('honours the per-device cutoff clamp', () => {
    h.sync.setDeviceCutoff(0, 30, 70);
    h.sync.previewDevicePosition(0, 100, 250);
    expect(h.buttplug.sendLinear).toHaveBeenCalledWith(0, 70, 250);
  });

  it('refuses a device that cannot move to a position', () => {
    const v = makeButtplugSync([vibeDev(5)]);
    expect(v.sync.previewDevicePosition(5, 100, 250)).toBe(false);
    expect(v.buttplug.sendLinear).not.toHaveBeenCalled();
    expect(v.buttplug.sendVibrate).not.toHaveBeenCalled();
  });

  it('refuses an index no connected device has', () => {
    expect(h.sync.previewDevicePosition(42, 100, 250)).toBe(false);
    expect(h.buttplug.sendLinear).not.toHaveBeenCalled();
  });

  it('refuses when not connected', () => {
    h.buttplug.connected = false;
    expect(h.sync.previewDevicePosition(0, 100, 250)).toBe(false);
    expect(h.buttplug.sendLinear).not.toHaveBeenCalled();
  });

  it('refuses while a video is driving — playback owns the devices', () => {
    h.sync._active = true;
    expect(h.sync.previewDevicePosition(0, 100, 250)).toBe(false);
    expect(h.buttplug.sendLinear).not.toHaveBeenCalled();
  });
});
