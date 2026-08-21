/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
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

    // Dave mashed X and Z: the stacked engage/release cycles timed out against
    // the cloud, the device lost its HSSP setup, and `_mode` stayed at 1 — so
    // every later call skipped the re-setup it needed and the Handy stopped
    // following the video until the video was reloaded (2026-08-21).
    it('drops the mode cache when a play fails', async () => {
      await manager.connect('key');
      manager._mode = 1;
      mockHandy.hsspPlay.mockRejectedValueOnce(new Error('Device timeout'));
      const result = await manager.hsspPlay(1000);
      expect(result).toBe(false);
      expect(manager._mode, 'a stale mode makes the next call skip its setup').toBeNull();
    });

    it('self-heals "mode specific setup required", not just "script set is required"', async () => {
      await manager.connect('key');
      manager._lastCloudUrl = 'http://cached.csv';
      mockHandy.hsspPlay
        .mockRejectedValueOnce(new Error('Illegal state. Mode specific setup required first.'))
        .mockResolvedValueOnce({ result: 0 });
      mockHandy.setScript.mockResolvedValueOnce({ result: 0 });
      const result = await manager.hsspPlay(2000);
      expect(mockHandy.setScript, 'must re-establish the script').toHaveBeenCalledWith('http://cached.csv');
      expect(result).toBe(true);
      expect(manager._mode).toBe(1);
    });
  });

  // Mashing X and Z fired an engage/release pair per press, putting several
  // 200-750ms cloud calls in flight at once. Under that pile-up the cloud
  // returned "Device timeout" and the device lost its mode setup, so it
  // stopped following the video (Dave, 2026-08-21).
  describe('HSSP call serialisation', () => {
    it('never runs two HSSP calls at once', async () => {
      await manager.connect('key');
      let inFlight = 0, maxInFlight = 0;
      const track = () => new Promise((res) => {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        setTimeout(() => { inFlight--; res({ result: 0 }); }, 15);
      });
      mockHandy.hsspPlay.mockImplementation(track);
      mockHandy.hsspStop.mockImplementation(track);
      await Promise.all([
        manager.hsspPlay(1), manager.hsspStop(), manager.hsspPlay(2),
        manager.hsspStop(), manager.hsspPlay(3),
      ]);
      expect(maxInFlight, 'the device has ONE state machine').toBe(1);
    });

    it('sends only the newest of a burst of plays', async () => {
      // Three plays issued back-to-back: the first two are already wrong by
      // the time they would reach the device, and sending them is exactly the
      // pile-up that caused the timeouts. Only the newest position matters.
      await manager.connect('key');
      mockHandy.hsspPlay.mockImplementation(() => new Promise(r => setTimeout(() => r({ result: 0 }), 15)));
      await Promise.all([manager.hsspPlay(100), manager.hsspPlay(200), manager.hsspPlay(300)]);
      const times = mockHandy.hsspPlay.mock.calls.map(c => c[0]);
      expect(times).toEqual([300]);
    });

    it('a play already in flight is never dropped', async () => {
      // Only QUEUED plays are droppable — one that already reached the device
      // has to be allowed to finish, and the sync engine's own supersede
      // handling deals with the result.
      await manager.connect('key');
      mockHandy.hsspPlay.mockImplementation(() => new Promise(r => setTimeout(() => r({ result: 0 }), 25)));
      const inFlight = manager.hsspPlay(100);
      await new Promise(r => setTimeout(r, 5));      // let it start
      const later = manager.hsspPlay(500);
      await Promise.all([inFlight, later]);
      const times = mockHandy.hsspPlay.mock.calls.map(c => c[0]);
      expect(times).toEqual([100, 500]);
    });

    it('NEVER drops a stop, however stale', async () => {
      await manager.connect('key');
      mockHandy.hsspPlay.mockImplementation(() => new Promise(r => setTimeout(() => r({ result: 0 }), 15)));
      const play = manager.hsspPlay(100);
      const stop = manager.hsspStop();
      const after = manager.hsspPlay(400);
      await Promise.all([play, stop, after]);
      expect(mockHandy.hsspStop, 'a skipped stop leaves hardware running').toHaveBeenCalled();
    });

    it('one failure does not wedge every later call', async () => {
      await manager.connect('key');
      mockHandy.hsspPlay.mockRejectedValueOnce(new Error('Device timeout'));
      await manager.hsspPlay(1);
      mockHandy.hsspPlay.mockResolvedValueOnce({ result: 0 });
      const ok = await manager.hsspPlay(2);
      expect(ok, 'the chain must survive a rejected link').toBe(true);
    });
  });

  describe('hsspStop', () => {
    it('stops HSSP playback', async () => {
      await manager.connect('key');
      await manager.hsspStop();
      expect(mockHandy.hsspStop).toHaveBeenCalled();
    });

    it('drops the mode cache when a stop fails', async () => {
      await manager.connect('key');
      manager._mode = 1;
      mockHandy.hsspStop.mockRejectedValueOnce(new Error('Illegal state. Mode specific setup required first.'));
      await manager.hsspStop();
      expect(manager._mode).toBeNull();
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

  describe('hdspMove — HDSP mode handling', () => {
    beforeEach(async () => { await manager.connect('key'); });

    it('switches the device into HDSP mode (2) before the first send', async () => {
      await manager.hdspMove(50, 100);
      expect(mockHandy.setMode).toHaveBeenCalledWith(2);
      expect(mockHandy.hdsp).toHaveBeenCalledWith(50, 100, 'percent', 'time', true, true);
    });

    it('enterHdsp() explicitly switches to mode 2 and primes the cache', async () => {
      const ok = await manager.enterHdsp();
      expect(ok).toBe(true);
      expect(mockHandy.setMode).toHaveBeenCalledWith(2);
      // A following hdspMove sees mode 2 already set → no redundant switch.
      mockHandy.setMode.mockClear();
      await manager.hdspMove(50, 100);
      expect(mockHandy.setMode).not.toHaveBeenCalled();
    });

    it('enterHdsp() returns false when the mode switch fails', async () => {
      mockHandy.setMode.mockRejectedValueOnce(new Error('offline'));
      const ok = await manager.enterHdsp();
      expect(ok).toBe(false);
    });

    it('does not re-switch mode on subsequent sends (cached)', async () => {
      await manager.hdspMove(50, 100);
      mockHandy.setMode.mockClear();
      await manager.hdspMove(60, 100);
      expect(mockHandy.setMode).not.toHaveBeenCalled();
      expect(mockHandy.hdsp).toHaveBeenCalledTimes(2);
    });

    it('re-enters HDSP mode after an HSSP setup switched the device to mode 1', async () => {
      await manager.hdspMove(50, 100);              // device now in HDSP (mode 2)
      await manager.setupScript('http://x/s.csv');  // setScript → HSSP (mode 1)
      mockHandy.setMode.mockClear();
      await manager.hdspMove(70, 100);
      expect(mockHandy.setMode).toHaveBeenCalledWith(2); // must re-switch, else "just stops"
    });

    it('forces a mode re-check after a failed send', async () => {
      await manager.hdspMove(50, 100);             // mode → 2
      mockHandy.hdsp.mockRejectedValueOnce(new Error('device busy'));
      await manager.hdspMove(60, 100);             // fails → _mode reset to null
      mockHandy.setMode.mockClear();
      await manager.hdspMove(70, 100);             // must re-switch mode
      expect(mockHandy.setMode).toHaveBeenCalledWith(2);
    });
  });

  describe('hsspPlay — self-heal on lost scriptSet', () => {
    beforeEach(async () => {
      await manager.connect('key');
      manager._lastCloudUrl = 'http://cached/s.csv'; // as if a script was uploaded
    });

    it('re-sets the cached script and retries when scriptSet was cleared (HDSP/Orgasm)', async () => {
      mockHandy.hsspPlay
        .mockRejectedValueOnce(new Error('Script set is required'))
        .mockResolvedValueOnce({ result: 0 });
      const ok = await manager.hsspPlay(1000);
      expect(mockHandy.setScript).toHaveBeenCalledWith('http://cached/s.csv');
      expect(mockHandy.hsspPlay).toHaveBeenCalledTimes(2);
      expect(ok).toBe(true);
    });

    it('does NOT retry for unrelated errors', async () => {
      mockHandy.hsspPlay.mockRejectedValueOnce(new Error('network down'));
      const ok = await manager.hsspPlay(1000);
      expect(mockHandy.setScript).not.toHaveBeenCalled();
      expect(ok).toBe(false);
    });
  });

  describe('uploadScriptOnly (Orgasm Switch finisher)', () => {
    it('uploads to the cloud and returns the URL without setting the script', async () => {
      await manager.connect('key');
      const url = await manager.uploadScriptOnly('{"actions":[{"at":0,"pos":0},{"at":100,"pos":100}]}');
      expect(url).toBe('https://scripts01.handyfeeling.com/abc123'); // from the mocked uploadDataToServer
      expect(mockHandy.setScript).not.toHaveBeenCalled(); // upload-only — main script untouched
    });
  });
});
