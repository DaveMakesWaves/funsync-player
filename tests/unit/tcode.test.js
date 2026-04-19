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

  it('does not send when disconnected', () => {
    tcode.connected = false;
    sync.start();
    sync.player.currentTime = 0.5;
    sync.player.paused = false;
    sync._lastSendTime = 0;
    sync._tick();
    expect(tcode.sendAxes).not.toHaveBeenCalled();
  });

  it('rate limits sends', () => {
    sync.start();
    sync.player.currentTime = 0.5;
    sync.player.paused = false;
    sync._lastSendTime = performance.now(); // just sent
    sync._tick();
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
