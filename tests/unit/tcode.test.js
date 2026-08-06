// Tests for Phase 17.3: TCode Serial (OSR2/SR6)
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TCodeManager } from '../../renderer/js/tcode-manager.js';
import { TCodeSync } from '../../renderer/js/tcode-sync.js';

// --- TCodeManager Tests ---

describe('TCodeManager', () => {
  let mgr;

  beforeEach(() => {
    vi.clearAllMocks();
    mgr = new TCodeManager();
  });

  it('starts disconnected', () => {
    expect(mgr.connected).toBe(false);
    expect(mgr.portPath).toBe('');
  });

  it('lists ports via IPC', async () => {
    window.funsync.tcodeListPorts.mockResolvedValue([
      { path: 'COM3', manufacturer: 'Arduino' },
      { path: 'COM5', manufacturer: '' },
    ]);
    const ports = await mgr.listPorts();
    expect(ports).toHaveLength(2);
    expect(ports[0].path).toBe('COM3');
    expect(ports[0].manufacturer).toBe('Arduino');
  });

  it('returns empty array when list fails', async () => {
    window.funsync.tcodeListPorts.mockRejectedValue(new Error('fail'));
    const ports = await mgr.listPorts();
    expect(ports).toEqual([]);
  });

  it('connects via IPC', async () => {
    window.funsync.tcodeConnect.mockResolvedValue({ success: true });
    const success = await mgr.connect('COM3', 115200);
    expect(success).toBe(true);
    expect(mgr.connected).toBe(true);
    expect(mgr.portPath).toBe('COM3');
    expect(mgr.baudRate).toBe(115200);
  });

  it('fires onConnect callback', async () => {
    window.funsync.tcodeConnect.mockResolvedValue({ success: true });
    const cb = vi.fn();
    mgr.onConnect = cb;
    await mgr.connect('COM3');
    expect(cb).toHaveBeenCalled();
  });

  it('handles connection failure', async () => {
    window.funsync.tcodeConnect.mockResolvedValue({ success: false, error: 'Port busy' });
    const success = await mgr.connect('COM3');
    expect(success).toBe(false);
    expect(mgr.connected).toBe(false);
  });

  it('disconnects', async () => {
    window.funsync.tcodeConnect.mockResolvedValue({ success: true });
    await mgr.connect('COM3');
    expect(mgr.connected).toBe(true);

    await mgr.disconnect();
    expect(mgr.connected).toBe(false);
  });

  it('sends raw command', async () => {
    window.funsync.tcodeConnect.mockResolvedValue({ success: true });
    await mgr.connect('COM3');
    await mgr.send('L0500\n');
    expect(window.funsync.tcodeSend).toHaveBeenCalledWith('L0500\n');
  });

  it('does not send when disconnected', async () => {
    const result = await mgr.send('L0500\n');
    expect(result).toBe(false);
    expect(window.funsync.tcodeSend).not.toHaveBeenCalled();
  });
});

describe('TCodeManager — sendAxes', () => {
  let mgr;

  beforeEach(async () => {
    vi.clearAllMocks();
    window.funsync.tcodeConnect.mockResolvedValue({ success: true });
    mgr = new TCodeManager();
    await mgr.connect('COM3');
  });

  it('formats single axis as TCode', () => {
    mgr.sendAxes({ L0: 50 });
    const sent = window.funsync.tcodeSend.mock.calls[0][0];
    // 50/100 * 999 = 499.5 → rounds to 500
    expect(sent).toMatch(/^L0\d{3}\n$/);
    expect(sent).toBe('L0500\n');
  });

  it('formats position 0 as 000', () => {
    mgr.sendAxes({ L0: 0 });
    expect(window.funsync.tcodeSend).toHaveBeenCalledWith('L0000\n');
  });

  it('formats position 100 as 999', () => {
    mgr.sendAxes({ L0: 100 });
    expect(window.funsync.tcodeSend).toHaveBeenCalledWith('L0999\n');
  });

  it('clamps values to 0-100', () => {
    mgr.sendAxes({ L0: 150 });
    expect(window.funsync.tcodeSend).toHaveBeenCalledWith('L0999\n');

    mgr.sendAxes({ L0: -10 });
    expect(window.funsync.tcodeSend).toHaveBeenCalledWith('L0000\n');
  });

  it('formats multi-axis as space-separated', () => {
    mgr.sendAxes({ L0: 50, R0: 75 });
    const sent = window.funsync.tcodeSend.mock.calls[0][0];
    expect(sent).toContain('L0');
    expect(sent).toContain('R0');
    expect(sent).toContain(' ');
    expect(sent.endsWith('\n')).toBe(true);
  });

  it('adds interval suffix with durationMs', () => {
    mgr.sendAxes({ L0: 50 }, 100);
    const sent = window.funsync.tcodeSend.mock.calls[0][0];
    expect(sent).toContain('I100');
  });

  it('does not send empty axes', () => {
    mgr.sendAxes({});
    expect(window.funsync.tcodeSend).not.toHaveBeenCalled();
  });

  it('stop sends DSTOP', () => {
    mgr.stop();
    expect(window.funsync.tcodeSend).toHaveBeenCalledWith('DSTOP\n');
  });

  it('serial stop sends ONLY DSTOP — no violent 50% recenter frame', () => {
    // Regression (OSR2+ report): a bare neutral-50% frame after DSTOP made the
    // device slam to center on pause. Serial firmware halts in place on DSTOP,
    // so nothing else must be sent.
    mgr.stop(); // mgr connected via 'COM3' (serial) in beforeEach
    const sends = window.funsync.tcodeSend.mock.calls.map((c) => c[0]);
    expect(sends).toEqual(['DSTOP\n']);
    expect(sends.some((s) => s.includes('500'))).toBe(false);
  });

  it('non-serial (ws) stop still sends the neutral frame for MFP consumers', async () => {
    vi.clearAllMocks();
    window.funsync.tcodeConnect.mockResolvedValue({ success: true });
    const wsMgr = new TCodeManager();
    await wsMgr.connect('websocket', { url: 'ws://restim.local:81' });
    wsMgr.stop();
    const sends = window.funsync.tcodeSend.mock.calls.map((c) => c[0]);
    expect(sends[0]).toBe('DSTOP\n');
    // restim/Howl need explicit axis values → the neutral frame is preserved.
    expect(sends.some((s) => s.includes('L0500'))).toBe(true);
  });
});

// --- TCodeSync Tests ---

function mockPlayer() {
  return {
    video: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    currentTime: 0,
    paused: true,
    duration: 60,
  };
}

function mockFunscript(actions) {
  return {
    isLoaded: true,
    getActions: () => actions || [
      { at: 0, pos: 0 },
      { at: 1000, pos: 100 },
      { at: 2000, pos: 0 },
      { at: 3000, pos: 100 },
    ],
  };
}

function mockTCode() {
  return {
    connected: true,
    sendAxes: vi.fn(),
    stop: vi.fn(),
    send: vi.fn(),
  };
}

describe('TCodeSync', () => {
  let sync, tcode;

  beforeEach(() => {
    tcode = mockTCode();
    sync = new TCodeSync({
      videoPlayer: mockPlayer(),
      tcodeManager: tcode,
      funscriptEngine: mockFunscript(),
    });
  });

  it('starts and caches actions', () => {
    sync.start();
    expect(sync._active).toBe(true);
    expect(sync._actions).not.toBeNull();
  });

  it('stops and sends DSTOP', () => {
    sync.start();
    sync.stop();
    expect(sync._active).toBe(false);
    expect(tcode.stop).toHaveBeenCalled();
  });

  describe('setUpdateRate', () => {
    it('defaults to ~60Hz (17ms tick)', () => {
      expect(sync._tickIntervalMs).toBe(Math.round(1000 / 60));
    });

    it('converts Hz to a tick interval', () => {
      sync.setUpdateRate(50);
      expect(sync._tickIntervalMs).toBe(20); // 1000/50
      sync.setUpdateRate(60);
      expect(sync._tickIntervalMs).toBe(17); // round(1000/60)
    });

    it('clamps to the 15–60Hz range', () => {
      sync.setUpdateRate(500);
      expect(sync._tickIntervalMs).toBe(Math.round(1000 / 60)); // ceiling
      sync.setUpdateRate(1);
      expect(sync._tickIntervalMs).toBe(Math.round(1000 / 15)); // floor
    });

    it('coerces garbage to the 60Hz default', () => {
      sync.setUpdateRate('nonsense');
      expect(sync._tickIntervalMs).toBe(Math.round(1000 / 60));
    });

    it('keeps the scheduler live (restarted) when the rate changes mid-run', () => {
      sync._startScheduler();
      expect(sync._intervalId).not.toBeNull();
      sync.setUpdateRate(50);
      expect(sync._tickIntervalMs).toBe(20);
      expect(sync._intervalId).not.toBeNull(); // still scheduled at the new rate
      sync._stopScheduler();
    });

    it('does not start a scheduler if none was running', () => {
      expect(sync._intervalId).toBeNull();
      sync.setUpdateRate(50);
      expect(sync._intervalId).toBeNull();
    });
  });

  it('tick sends L0 position via sendAxes', () => {
    sync.start();
    sync.player.currentTime = 0.5; // 500ms
    sync.player.paused = false;
    sync._lastSendTime = 0;
    sync._tick();
    expect(tcode.sendAxes).toHaveBeenCalled();
    const axes = tcode.sendAxes.mock.calls[0][0];
    expect(axes.L0).toBeDefined();
    expect(axes.L0).toBeGreaterThanOrEqual(0);
    expect(axes.L0).toBeLessThanOrEqual(100);
  });

  it('sends a per-axis interval (I-suffix) so the device paces the move', () => {
    // The tick must pass a move interval per axis (3rd sendAxes arg) so the
    // firmware interpolates instead of snapping.
    sync.start();
    sync.player.currentTime = 0.5;
    sync.player.paused = false;
    sync._lastSendTime = 0;
    sync._tick();
    expect(tcode.sendAxes).toHaveBeenCalled();
    const axisIntervals = tcode.sendAxes.mock.calls[0][2];
    expect(axisIntervals.L0).toBeGreaterThan(0);
  });

  it('steady-state interval tracks the time to the next keyframe', () => {
    // After the first-send snap, the move interval should be the actual time to
    // the next keyframe (keyframe-driven), NOT a fixed tick-length window.
    sync.start();
    sync.player.paused = false;
    // First tick consumes the post-start snap (short, one-tick interval).
    sync.player.currentTime = 0.2; // 200ms — inside [0,1000]
    sync._tick();
    // Second tick, well before the next keyframe at 1000ms.
    sync.player.currentTime = 0.3; // 300ms → 700ms to next keyframe
    sync._tick();
    const call = tcode.sendAxes.mock.calls.at(-1);
    expect(call[2].L0).toBeGreaterThan(150); // far bigger than any old cap
    expect(call[2].L0).toBeCloseTo(700, -1); // ≈ 1000 - 300
  });

  it('preserves fast low-amplitude "vibration" peaks (evicol/SR6 regression)', () => {
    // Fast oscillation: peaks/troughs every 20ms. The keyframe-driven output
    // must send the actual peak position (100), not an aliased mid-value.
    const vib = mockFunscript([
      { at: 0, pos: 0 },
      { at: 20, pos: 100 },
      { at: 40, pos: 0 },
      { at: 60, pos: 100 },
      { at: 80, pos: 0 },
    ]);
    sync = new TCodeSync({ videoPlayer: mockPlayer(), tcodeManager: tcode, funscriptEngine: vib });
    sync.start();
    sync.player.paused = false;
    // First tick at t=0 consumes the snap (interpolated ~0).
    sync.player.currentTime = 0;
    sync._tick();
    // Now just inside [0,20] heading to the pos=100 peak — must target 100.
    sync.player.currentTime = 0.001; // 1ms
    sync._tick();
    const call = tcode.sendAxes.mock.calls.at(-1);
    expect(call[0].L0).toBeCloseTo(100, 5); // the peak reaches the device
    expect(call[2].L0).toBeGreaterThan(0);  // over a short (~19ms) interval
  });

  it('does not send when disconnected', () => {
    tcode.connected = false;
    sync.start();
    sync.player.currentTime = 0.5;
    sync.player.paused = false;
    sync._lastSendTime = 0;
    sync._tick();
    expect(tcode.sendAxes).not.toHaveBeenCalled();
  });

  it('suppresses re-sending an unchanged target (one send per keyframe)', () => {
    // Within a single keyframe interval the target is the same endpoint, so
    // after it is sent once, repeat ticks at the same time must not re-send.
    sync.start();
    sync.player.paused = false;
    sync.player.currentTime = 0.3; // 300ms, inside [0,1000]
    sync._tick(); // first-send snap
    sync._tick(); // heads to the 1000ms keyframe → sends target
    tcode.sendAxes.mockClear();
    sync._tick(); // same time, same target → suppressed
    expect(tcode.sendAxes).not.toHaveBeenCalled();
  });
});

describe('TCodeSync — Multi-Axis', () => {
  let sync, tcode;

  beforeEach(() => {
    tcode = mockTCode();
    sync = new TCodeSync({
      videoPlayer: mockPlayer(),
      tcodeManager: tcode,
      funscriptEngine: mockFunscript(),
    });

    sync.setAxisActions('R0', [
      { at: 0, pos: 0 },
      { at: 1000, pos: 100 },
    ]);
    sync.setAxisActions('V0', [
      { at: 0, pos: 20 },
      { at: 1000, pos: 80 },
    ]);
  });

  it('sends multiple axes in one command', () => {
    sync.start();
    sync.player.currentTime = 0.5;
    sync.player.paused = false;
    sync._lastSendTime = 0;
    sync._tick();

    expect(tcode.sendAxes).toHaveBeenCalled();
    const axes = tcode.sendAxes.mock.calls[0][0];
    // Should have L0, R0, and V0
    expect(Object.keys(axes).length).toBeGreaterThanOrEqual(2);
  });

  it('respects axis enabled/disabled', () => {
    sync.setAxisEnabled('R0', false);
    sync.start();
    sync.player.currentTime = 0.5;
    sync.player.paused = false;
    sync._lastSendTime = 0;
    sync._tick();

    const axes = tcode.sendAxes.mock.calls[0]?.[0] || {};
    expect(axes.R0).toBeUndefined();
  });

  it('applies axis range', () => {
    sync.setAxisRange('L0', 20, 80); // clamp output to 20-80
    sync.start();
    sync.player.currentTime = 0.5; // ~50% position
    sync.player.paused = false;
    sync._lastSendTime = 0;
    sync._tick();

    const axes = tcode.sendAxes.mock.calls[0][0];
    if (axes.L0 !== undefined) {
      expect(axes.L0).toBeGreaterThanOrEqual(20);
      expect(axes.L0).toBeLessThanOrEqual(80);
    }
  });

  it('clearAxisActions removes all', () => {
    sync.clearAxisActions();
    expect(sync._axisActions.size).toBe(0);
  });

  it('set/get axis enabled', () => {
    sync.setAxisEnabled('L0', false);
    expect(sync.isAxisEnabled('L0')).toBe(false);
    sync.setAxisEnabled('L0', true);
    expect(sync.isAxisEnabled('L0')).toBe(true);
  });

  it('set/get axis range', () => {
    sync.setAxisRange('R0', 10, 90);
    const range = sync.getAxisRange('R0');
    expect(range.min).toBe(10);
    expect(range.max).toBe(90);
  });

  it('default range is 0-100', () => {
    const range = sync.getAxisRange('L2');
    expect(range.min).toBe(0);
    expect(range.max).toBe(100);
  });
});

describe('TCodeSync — Video Events', () => {
  let sync, tcode;

  beforeEach(() => {
    tcode = mockTCode();
    sync = new TCodeSync({
      videoPlayer: mockPlayer(),
      tcodeManager: tcode,
      funscriptEngine: mockFunscript(),
    });
    sync.start(); // binds video events, creating _onPause/_onEnded
  });

  it('pause sends stop', () => {
    // Find the pause handler from addEventListener calls
    const pauseCall = sync.player.video.addEventListener.mock.calls.find(c => c[0] === 'pause');
    expect(pauseCall).toBeDefined();
    pauseCall[1](); // fire the handler
    expect(tcode.stop).toHaveBeenCalled();
  });

  it('ended sends stop', () => {
    const endedCall = sync.player.video.addEventListener.mock.calls.find(c => c[0] === 'ended');
    expect(endedCall).toBeDefined();
    endedCall[1]();
    expect(tcode.stop).toHaveBeenCalled();
  });
});
