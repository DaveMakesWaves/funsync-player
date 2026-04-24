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

    it('sends LinearCmd with interpolated position (legacy interpolated strategy)', () => {
      sync.setLinearStrategy('interpolated');
      mockPlayer.currentTime = 0.25; // 250ms — halfway between 0ms and 500ms
      sync._sendPendingActions();

      // Linear interpolation: at 250ms between (0,0) and (500,100) = position 50
      expect(mockButtplug.sendLinear).toHaveBeenCalled();
      const call = mockButtplug.sendLinear.mock.calls[0];
      expect(call[0]).toBe(0); // device index
      expect(call[1]).toBeCloseTo(50, 0); // interpolated position
    });

    it('sends LinearCmd with NEXT action position + full stroke duration (action-boundary strategy)', () => {
      // Default strategy is action-boundary. At t=0 we've just crossed the
      // first action (at 0ms, pos=0) — fire ONE command targeting the next
      // action (at 500ms, pos=100) with duration 500ms.
      sync._lastActionIndex = 0;
      sync._lastLinearSentForIdx = -1;
      mockPlayer.currentTime = 0; // at first action boundary
      sync._sendPendingActions();

      expect(mockButtplug.sendLinear).toHaveBeenCalled();
      const call = mockButtplug.sendLinear.mock.calls[0];
      expect(call[0]).toBe(0);        // device index
      expect(call[1]).toBe(100);      // NEXT action's position, not interpolated midpoint
      expect(call[2]).toBe(500);      // full stroke duration, not remaining-to-next
    });

    it('action-boundary mode dispatches only once per action, not every tick', () => {
      sync._lastActionIndex = 0;
      sync._lastLinearSentForIdx = -1;
      mockPlayer.currentTime = 0;
      sync._sendPendingActions(); // fires command for action 0→1
      sync._sendPendingActions(); // should be a no-op (still on same boundary)
      sync._sendPendingActions();
      expect(mockButtplug.sendLinear).toHaveBeenCalledTimes(1);
    });

    it('action-boundary mode fires new command when video crosses next action', () => {
      sync._lastActionIndex = 0;
      sync._lastLinearSentForIdx = -1;
      mockPlayer.currentTime = 0;
      sync._sendPendingActions(); // action 0→1

      // Advance past the second action (at 500ms) plus lookahead.
      mockPlayer.currentTime = 0.6;
      sync._sendPendingActions(); // action 1→2

      expect(mockButtplug.sendLinear).toHaveBeenCalledTimes(2);
      const [first, second] = mockButtplug.sendLinear.mock.calls;
      expect(first[1]).toBe(100);  // first target: action[1].pos
      expect(second[1]).toBe(0);   // second target: action[2].pos
    });

    it('action-boundary lookahead fires command before action wall-clock time', () => {
      // With 60ms lookahead and the second action at 500ms, the dispatcher
      // should trigger at t = 440ms, not t = 500ms.
      sync.setLinearLookaheadMs(60);
      sync._lastActionIndex = 0;
      sync._lastLinearSentForIdx = 1; // already dispatched for first boundary (0→1)

      mockPlayer.currentTime = 0.439; // 439ms — before the lookahead window
      sync._sendPendingActions();
      expect(mockButtplug.sendLinear).not.toHaveBeenCalled();

      mockPlayer.currentTime = 0.44; // 440ms — at the lookahead edge
      sync._sendPendingActions();
      expect(mockButtplug.sendLinear).toHaveBeenCalledTimes(1);
    });

    it('action-boundary mode stretches sub-minStroke strokes up to the floor', () => {
      // Close-spaced actions: 0→30ms stroke is below the 60ms floor.
      // Disable lookahead for this test so the dispatcher lands on the 0→1
      // boundary (not pre-crossed by the lookahead window).
      sync._actions = [
        { at: 0, pos: 0 },
        { at: 30, pos: 100 },
        { at: 200, pos: 0 },
      ];
      sync.setLinearLookaheadMs(0);
      sync.setMinStrokeMs(60);
      sync._lastActionIndex = 0;
      sync._lastLinearSentForIdx = -1;
      mockPlayer.currentTime = 0;
      sync._sendPendingActions();

      const call = mockButtplug.sendLinear.mock.calls[0];
      expect(call[1]).toBe(100);   // still targets action[1].pos
      expect(call[2]).toBe(60);    // duration clamped up to min-stroke floor
    });

    it('setLinearStrategy resets boundary tracking so the next tick dispatches', () => {
      sync._lastActionIndex = 0;
      sync._lastLinearSentForIdx = 99; // pretend we'd already sent way ahead
      sync.setLinearStrategy('action-boundary');
      mockPlayer.currentTime = 0;
      sync._sendPendingActions();
      expect(mockButtplug.sendLinear).toHaveBeenCalled();
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

  describe('clearDeviceState', () => {
    it('removes all per-device entries for the given index', () => {
      sync.setAxisAssignment(0, 'L1');
      sync.setInverted(0, true);
      sync.setVibeMode(0, 'intensity');
      sync.setScalarMode(0, 'speed');
      sync.setRotateMode(0, 'position');
      sync.setMaxIntensity(0, 45);
      sync.setRampUp(0, false);

      sync.clearDeviceState(0);

      // Getters return the documented defaults once state is cleared
      expect(sync.getAxisAssignment(0)).toBe('L0');
      expect(sync.isInverted(0)).toBe(false);
      expect(sync.getVibeMode(0)).toBe('speed');
      expect(sync.getScalarMode(0)).toBe('position');
      expect(sync.getRotateMode(0)).toBe('speed');
      expect(sync.getMaxIntensity(0)).toBe(70);
      expect(sync.getRampUp(0)).toBe(true);

      // Underlying maps should no longer contain the index either
      expect(sync._axisAssignmentMap.has(0)).toBe(false);
      expect(sync._invertedDevices.has(0)).toBe(false);
      expect(sync._vibeModeMap.has(0)).toBe(false);
      expect(sync._scalarModeMap.has(0)).toBe(false);
      expect(sync._rotateModeMap.has(0)).toBe(false);
      expect(sync._maxIntensityMap.has(0)).toBe(false);
      expect(sync._rampUpMap.has(0)).toBe(false);
    });

    it('leaves other device indices untouched', () => {
      sync.setAxisAssignment(0, 'L1');
      sync.setAxisAssignment(1, 'V0');
      sync.setInverted(1, true);
      sync.setMaxIntensity(1, 30);

      sync.clearDeviceState(0);

      expect(sync.getAxisAssignment(0)).toBe('L0');
      expect(sync.getAxisAssignment(1)).toBe('V0');
      expect(sync.isInverted(1)).toBe(true);
      expect(sync.getMaxIntensity(1)).toBe(30);
    });

    it('is safe to call for an index with no recorded state', () => {
      expect(() => sync.clearDeviceState(42)).not.toThrow();
      expect(sync.getAxisAssignment(42)).toBe('L0');
    });
  });
});
