// Unit tests for HandyManager — imports from real source with mocked SDK
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the SDK dynamic import before importing HandyManager
const mockHandy = {
  connect: vi.fn().mockResolvedValue({ result: 1 }),
  disconnect: vi.fn().mockResolvedValue(undefined),
  sync: vi.fn().mockResolvedValue(undefined),
  getClientServerLatency: vi.fn().mockReturnValue({ avgOffset: 10, avgRtd: 50, lastSyncTime: Date.now() }),
  getState: vi.fn().mockReturnValue({ info: { fwVersion: '3.2.0' }, mode: 1, hssp: { scriptSet: true } }),
  setScript: vi.fn().mockResolvedValue({ result: 1 }),
  hsspPlay: vi.fn().mockResolvedValue({ result: 0 }),
  hsspStop: vi.fn().mockResolvedValue(undefined),
  setOffset: vi.fn().mockResolvedValue(undefined),
  getOffset: vi.fn().mockResolvedValue({ offset: 100 }),
  setStrokeZone: vi.fn().mockResolvedValue(undefined),
  getStrokeZone: vi.fn().mockResolvedValue({ min: 10, max: 90 }),
  setHsspLoop: vi.fn().mockResolvedValue(undefined),
  setMode: vi.fn().mockResolvedValue(undefined),
  setHampVelocity: vi.fn().mockResolvedValue(undefined),
  hampPlay: vi.fn().mockResolvedValue(undefined),
  hampStop: vi.fn().mockResolvedValue(undefined),
  hdsp: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  API: {
    get: {
      connected: vi.fn().mockResolvedValue({ connected: true }),
    },
  },
};

// Mock the SDK module at the exact import path used by source
vi.mock('../../node_modules/@ohdoki/handy-sdk/dist/handy.esm.js', () => ({
  init: vi.fn().mockReturnValue(mockHandy),
  getEstimatedServerTime: vi.fn().mockReturnValue(Date.now()),
  uploadDataToServer: vi.fn().mockResolvedValue('https://scripts01.handyfeeling.com/abc123'),
}));

import { HandyManager } from '../../renderer/js/handy-manager.js';

describe('HandyManager', () => {
  let manager;

  beforeEach(async () => {
    vi.clearAllMocks();
    manager = new HandyManager();
    await manager.init();
  });

  describe('init', () => {
    it('initializes SDK and sets up event handlers', () => {
      expect(mockHandy.on).toHaveBeenCalledWith('state', expect.any(Function));
      expect(mockHandy.on).toHaveBeenCalledWith('connect', expect.any(Function));
      expect(mockHandy.on).toHaveBeenCalledWith('disconnect', expect.any(Function));
    });
  });

  describe('connect', () => {
    it('connects with valid key and returns true', async () => {
      const result = await manager.connect('testKey123');
      expect(result).toBe(true);
      expect(manager.connected).toBe(true);
      expect(manager.connectionKey).toBe('testKey123');
    });

    it('returns false on connection failure', async () => {
      mockHandy.connect.mockResolvedValueOnce({ result: 0 });
      const result = await manager.connect('badKey');
      expect(result).toBe(false);
    });

    it('returns false on connection error', async () => {
      mockHandy.connect.mockRejectedValueOnce(new Error('Network error'));
      const result = await manager.connect('key');
      expect(result).toBe(false);
    });

    it('returns false if SDK not initialized', async () => {
      const fresh = new HandyManager();
      const result = await fresh.connect('key');
      expect(result).toBe(false);
    });

    it('fetches device info on successful connect', async () => {
      await manager.connect('testKey');
      expect(manager.deviceInfo).toBeTruthy();
    });
  });

  describe('disconnect', () => {
    it('disconnects and clears state', async () => {
      await manager.connect('key');
      await manager.disconnect();
      expect(manager.connected).toBe(false);
      expect(manager.deviceInfo).toBeNull();
    });

    it('handles disconnect error gracefully', async () => {
      mockHandy.disconnect.mockRejectedValueOnce(new Error('fail'));
      await manager.connect('key');
      await manager.disconnect(); // should not throw
      expect(manager.connected).toBe(false);
    });

  });

  describe('cloud health check', () => {
    // Regression guard for the "shows WiFi connected after device switched
    // to BT mode" bug. The SDK's internal 'disconnect' event doesn't fire
    // for that transition (SDK → cloud HTTP stays alive, only cloud →
    // device breaks), so we need an explicit poll of handyfeeling's
    // `/connected` endpoint to notice.

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('starts polling /connected after a successful connect', async () => {
      await manager.connect('key');
      mockHandy.API.get.connected.mockClear();
      await vi.advanceTimersByTimeAsync(manager._healthCheckIntervalMs + 10);
      expect(mockHandy.API.get.connected).toHaveBeenCalledWith('key');
    });

    it('flips state to disconnected when cloud reports connected:false', async () => {
      const onDisconnect = vi.fn();
      manager.onDisconnect = onDisconnect;
      await manager.connect('key');
      expect(manager.connected).toBe(true);

      mockHandy.API.get.connected.mockResolvedValueOnce({ connected: false });
      await vi.advanceTimersByTimeAsync(manager._healthCheckIntervalMs + 10);

      expect(manager.connected).toBe(false);
      expect(manager.deviceInfo).toBeNull();
      expect(onDisconnect).toHaveBeenCalled();
    });

    it('stops polling after device lost', async () => {
      await manager.connect('key');
      mockHandy.API.get.connected.mockResolvedValueOnce({ connected: false });
      await vi.advanceTimersByTimeAsync(manager._healthCheckIntervalMs + 10);
      expect(manager.connected).toBe(false);

      // No further polls should happen once state has flipped.
      mockHandy.API.get.connected.mockClear();
      await vi.advanceTimersByTimeAsync(manager._healthCheckIntervalMs * 3);
      expect(mockHandy.API.get.connected).not.toHaveBeenCalled();
    });

    it('preserves state on transient network error (tolerant)', async () => {
      await manager.connect('key');
      mockHandy.API.get.connected.mockRejectedValueOnce(new Error('fetch failed'));
      await vi.advanceTimersByTimeAsync(manager._healthCheckIntervalMs + 10);
      // One flaky poll should NOT disconnect — only an explicit cloud false.
      expect(manager.connected).toBe(true);
    });

    it('stops polling on explicit disconnect', async () => {
      await manager.connect('key');
      await manager.disconnect();
      mockHandy.API.get.connected.mockClear();
      await vi.advanceTimersByTimeAsync(manager._healthCheckIntervalMs * 2);
      expect(mockHandy.API.get.connected).not.toHaveBeenCalled();
    });

    it('tick is a no-op when not connected', async () => {
      // Never connected — health check should not probe the cloud.
      await vi.advanceTimersByTimeAsync(manager._healthCheckIntervalMs * 2);
      expect(mockHandy.API.get.connected).not.toHaveBeenCalled();
    });
  });

  describe('syncTime', () => {
    it('returns sync quality after sync', async () => {
      await manager.connect('key');
      const result = await manager.syncTime(10);
      expect(result.avgRtd).toBe(50);
      expect(result.avgOffset).toBe(10);
      expect(manager.syncQuality).toBeTruthy();
    });

    it('returns null when not connected', async () => {
      const fresh = new HandyManager();
      const result = await fresh.syncTime();
      expect(result).toBeNull();
    });
  });

  describe('setupScript', () => {
    it('sets up script from URL', async () => {
      await manager.connect('key');
      const result = await manager.setupScript('http://localhost:5123/scripts/test.csv');
      expect(result).toBe(true);
      expect(mockHandy.setScript).toHaveBeenCalledWith('http://localhost:5123/scripts/test.csv');
    });

    it('returns false when not connected', async () => {
      const result = await manager.setupScript('http://test.csv');
      expect(result).toBe(false);
    });
  });

  describe('hsspPlay', () => {
    it('starts HSSP playback at given time', async () => {
      await manager.connect('key');
      const result = await manager.hsspPlay(5000);
      expect(result).toBe(true);
      expect(mockHandy.hsspPlay).toHaveBeenCalledWith(5000, expect.any(Number));
    });

    it('returns false when not connected', async () => {
      const result = await manager.hsspPlay(0);
      expect(result).toBe(false);
    });
  });

  describe('hsspStop', () => {
    it('stops HSSP playback', async () => {
      await manager.connect('key');
      await manager.hsspStop();
      expect(mockHandy.hsspStop).toHaveBeenCalled();
    });

    it('handles errors gracefully', async () => {
      mockHandy.hsspStop.mockRejectedValueOnce(new Error('fail'));
      await manager.connect('key');
      await manager.hsspStop(); // should not throw
    });
  });

  describe('setStrokeZone', () => {
    it('sets min/max stroke zone', async () => {
      await manager.connect('key');
      await manager.setStrokeZone(10, 90);
      expect(mockHandy.setStrokeZone).toHaveBeenCalledWith({ min: 10, max: 90 });
    });
  });

  describe('setOffset', () => {
    it('sets HSTP offset', async () => {
      await manager.connect('key');
      await manager.setOffset(50);
      expect(mockHandy.setOffset).toHaveBeenCalledWith(50);
    });
  });

  describe('getOffset', () => {
    it('returns current offset', async () => {
      await manager.connect('key');
      const offset = await manager.getOffset();
      expect(offset).toBe(100);
    });

    it('returns 0 when not connected', async () => {
      const offset = await manager.getOffset();
      expect(offset).toBe(0);
    });
  });

  describe('callbacks', () => {
    it('fires onError callback', async () => {
      const onError = vi.fn();
      manager.onError = onError;
      mockHandy.connect.mockResolvedValueOnce({ result: 0 });
      await manager.connect('badKey');
      expect(onError).toHaveBeenCalled();
    });

    it('fires onConnect via SDK event', async () => {
      const onConnect = vi.fn();
      manager.onConnect = onConnect;
      // Trigger the connect handler that was registered
      const connectHandler = mockHandy.on.mock.calls.find((c) => c[0] === 'connect')[1];
      connectHandler();
      expect(onConnect).toHaveBeenCalled();
      expect(manager.connected).toBe(true);
    });

    it('fires onDisconnect via SDK event', async () => {
      const onDisconnect = vi.fn();
      manager.onDisconnect = onDisconnect;
      const disconnectHandler = mockHandy.on.mock.calls.find((c) => c[0] === 'disconnect')[1];
      disconnectHandler();
      expect(onDisconnect).toHaveBeenCalled();
      expect(manager.connected).toBe(false);
    });
  });
});
