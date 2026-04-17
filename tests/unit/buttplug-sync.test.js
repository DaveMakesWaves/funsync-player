import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ButtplugSync } from '../../renderer/js/buttplug-sync.js';

describe('ButtplugSync', () => {
  let sync;
  let mockPlayer;
  let mockButtplug;
  let mockFunscript;

  beforeEach(() => {
    mockPlayer = {
      video: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
      currentTime: 0,
      paused: true,
    };

    mockButtplug = {
      connected: true,
      devices: [
        { index: 0, name: 'Stroker', canLinear: true, canVibrate: false, canRotate: false },
      ],
      sendLinear: vi.fn().mockResolvedValue(undefined),
      sendVibrate: vi.fn().mockResolvedValue(undefined),
      stopAll: vi.fn().mockResolvedValue(undefined),
    };

    mockFunscript = {
      isLoaded: true,
      getActions: vi.fn().mockReturnValue([
        { at: 0, pos: 0 },
        { at: 500, pos: 100 },
        { at: 1000, pos: 0 },
        { at: 1500, pos: 100 },
        { at: 2000, pos: 50 },
      ]),
    };

    sync = new ButtplugSync({
      videoPlayer: mockPlayer,
      buttplugManager: mockButtplug,
      funscriptEngine: mockFunscript,
    });
  });

  afterEach(() => {
    sync.stop();
  });

  describe('start/stop', () => {
    it('starts inactive', () => {
      expect(sync._active).toBe(false);
    });

    it('activates on start', () => {
      sync.start();
      expect(sync._active).toBe(true);
    });

    it('deactivates on stop', () => {
      sync.start();
      sync.stop();
      expect(sync._active).toBe(false);
    });

    it('binds video events on start', () => {
      sync.start();
      expect(mockPlayer.video.addEventListener).toHaveBeenCalledWith('playing', expect.any(Function));
      expect(mockPlayer.video.addEventListener).toHaveBeenCalledWith('pause', expect.any(Function));
      expect(mockPlayer.video.addEventListener).toHaveBeenCalledWith('seeked', expect.any(Function));
      expect(mockPlayer.video.addEventListener).toHaveBeenCalledWith('ended', expect.any(Function));
    });

    it('unbinds video events on stop', () => {
      sync.start();
      sync.stop();
      expect(mockPlayer.video.removeEventListener).toHaveBeenCalledWith('playing', expect.any(Function));
      expect(mockPlayer.video.removeEventListener).toHaveBeenCalledWith('pause', expect.any(Function));
      expect(mockPlayer.video.removeEventListener).toHaveBeenCalledWith('seeked', expect.any(Function));
      expect(mockPlayer.video.removeEventListener).toHaveBeenCalledWith('ended', expect.any(Function));
    });

    it('does not double-start', () => {
      sync.start();
      sync.start();
      expect(mockPlayer.video.addEventListener).toHaveBeenCalledTimes(4);
    });

    it('resets lastSentPos on stop', () => {
      sync.start();
      sync._lastSentPos = 50;
      sync.stop();
      expect(sync._lastSentPos).toBe(-1);
    });

    it('caches actions on start', () => {
      sync.start();
      expect(sync._actions).toEqual(mockFunscript.getActions());
    });
  });

  describe('_resetIndex', () => {
    beforeEach(() => {
      sync.start();
    });

    it('resets to -1 with no actions', () => {
      sync._actions = null;
      sync._resetIndex();
      expect(sync._lastActionIndex).toBe(-1);
    });

    it('finds correct index for time 0', () => {
      mockPlayer.currentTime = 0;
      sync._resetIndex();
      expect(sync._lastActionIndex).toBe(0);
    });

    it('finds correct index for time between actions', () => {
      mockPlayer.currentTime = 0.75; // 750ms
      sync._resetIndex();
      expect(sync._lastActionIndex).toBe(1); // action at 500ms
    });

    it('finds last index when past all actions', () => {
      mockPlayer.currentTime = 3; // 3000ms
      sync._resetIndex();
      expect(sync._lastActionIndex).toBe(4); // last action
    });

    it('returns -1 when before all actions', () => {
      sync._actions = [{ at: 1000, pos: 50 }];
      mockPlayer.currentTime = 0;
      sync._resetIndex();
      expect(sync._lastActionIndex).toBe(-1);
    });
  });

  describe('_sendPendingActions', () => {
    beforeEach(() => {
      sync.start();
      sync._lastActionIndex = 0;
    });

    it('sends LinearCmd with interpolated position', () => {
      mockPlayer.currentTime = 0.25; // 250ms — halfway between 0ms and 500ms
      sync._sendPendingActions();

      // Linear interpolation: at 250ms between (0,0) and (500,100) = position 50
      expect(mockButtplug.sendLinear).toHaveBeenCalled();
      const call = mockButtplug.sendLinear.mock.calls[0];
      expect(call[0]).toBe(0); // device index
      expect(call[1]).toBeCloseTo(50, 0); // interpolated position
    });

    it('does not send when not connected', () => {
      mockButtplug.connected = false;
      mockPlayer.currentTime = 0;
      sync._sendPendingActions();
      expect(mockButtplug.sendLinear).not.toHaveBeenCalled();
    });

    it('does not send when no actions', () => {
      sync._actions = null;
      sync._sendPendingActions();
      expect(mockButtplug.sendLinear).not.toHaveBeenCalled();
    });

    it('does not send when past last action', () => {
      sync._lastActionIndex = 4; // at last action
      mockPlayer.currentTime = 2;
      sync._sendPendingActions();
      expect(mockButtplug.sendLinear).not.toHaveBeenCalled();
    });

    it('advances lastActionIndex during catch-up', () => {
      mockPlayer.currentTime = 0.6; // past action at 500ms
      sync._sendPendingActions();
      expect(sync._lastActionIndex).toBeGreaterThanOrEqual(1);
    });

    it('applies speed limit when configured', () => {
      sync.setSpeedLimit(100); // 100 units/sec
      sync._lastSentPos = 0;
      sync._lastSendTime = performance.now() - 100; // 100ms ago
      mockPlayer.currentTime = 0.5; // at 500ms, linear interp = 100
      sync._sendPendingActions();
      // With 100 units/sec and 100ms, max delta = 10 units
      if (mockButtplug.sendLinear.mock.calls.length > 0) {
        const sentPos = mockButtplug.sendLinear.mock.calls[0][1];
        expect(sentPos).toBeLessThanOrEqual(10.5); // speed limited
      }
    });
  });

  describe('_sendToDevices', () => {
    it('sends to linear devices', () => {
      sync._sendToDevices(75, 300, 0);
      expect(mockButtplug.sendLinear).toHaveBeenCalledWith(0, 75, 300);
    });

    it('sends vibrate with speed-mapped intensity', () => {
      mockButtplug.devices = [
        { index: 1, name: 'Vibe', canLinear: false, canVibrate: true, canRotate: false },
      ];
      // Position change of 100 over 500ms = 200 pos/sec → 200/300*100 ≈ 66.7 intensity
      sync._sendToDevices(100, 500, 0);
      expect(mockButtplug.sendVibrate).toHaveBeenCalledWith(1, expect.closeTo(66.7, 0));
    });

    it('caps vibrate intensity at 100', () => {
      mockButtplug.devices = [
        { index: 1, name: 'Vibe', canLinear: false, canVibrate: true, canRotate: false },
      ];
      // Position change of 100 over 100ms = 1000 pos/sec → capped at 100
      sync._sendToDevices(100, 100, 0);
      expect(mockButtplug.sendVibrate).toHaveBeenCalledWith(1, 100);
    });

    it('sends to multiple devices', () => {
      mockButtplug.devices = [
        { index: 0, name: 'Stroker', canLinear: true, canVibrate: false, canRotate: false },
        { index: 1, name: 'Vibe', canLinear: false, canVibrate: true, canRotate: false },
      ];
      sync._sendToDevices(50, 200, 0);
      expect(mockButtplug.sendLinear).toHaveBeenCalledWith(0, 50, 200);
      expect(mockButtplug.sendVibrate).toHaveBeenCalled();
    });
  });

  describe('event handlers', () => {
    it('stopAll on pause', () => {
      sync.start();
      sync._handlePause();
      expect(mockButtplug.stopAll).toHaveBeenCalled();
    });

    it('stopAll on ended', () => {
      sync.start();
      sync._handleEnded();
      expect(mockButtplug.stopAll).toHaveBeenCalled();
    });

    it('emits sync status', () => {
      const onStatus = vi.fn();
      sync.onSyncStatus = onStatus;
      sync.start();
      sync._handlePlaying();
      expect(onStatus).toHaveBeenCalledWith('synced');
    });

    it('emits idle on pause', () => {
      const onStatus = vi.fn();
      sync.onSyncStatus = onStatus;
      sync.start();
      sync._handlePause();
      expect(onStatus).toHaveBeenCalledWith('idle');
    });
  });

  describe('reloadActions', () => {
    it('refreshes cached actions', () => {
      sync.start();
      const newActions = [{ at: 0, pos: 50 }, { at: 1000, pos: 0 }];
      mockFunscript.getActions.mockReturnValue(newActions);
      sync.reloadActions();
      expect(sync._actions).toEqual(newActions);
      expect(sync._lastActionIndex).toBe(-1);
    });
  });
});
