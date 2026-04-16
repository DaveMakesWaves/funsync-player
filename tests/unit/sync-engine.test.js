// Unit tests for SyncEngine — imports from real source
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SyncEngine } from '../../renderer/js/sync-engine.js';

function createMockVideoPlayer() {
  const video = document.createElement('video');
  return {
    video,
    get currentTime() { return video.currentTime; },
    get paused() { return video.paused; },
    get duration() { return 300; },
  };
}

function createMockHandyManager() {
  return {
    connected: true,
    syncQuality: { avgRtd: 50, avgOffset: 10 },
    hsspPlay: vi.fn().mockResolvedValue(true),
    hsspStop: vi.fn().mockResolvedValue(undefined),
    setupScript: vi.fn().mockResolvedValue(true),
    syncTime: vi.fn().mockResolvedValue({ avgRtd: 50 }),
  };
}

function createMockFunscriptEngine() {
  return {
    isLoaded: true,
    getActions: () => [
      { at: 0, pos: 50 },
      { at: 500, pos: 100 },
      { at: 1000, pos: 0 },
    ],
  };
}

describe('SyncEngine', () => {
  let player, handy, funscript, engine;

  beforeEach(() => {
    player = createMockVideoPlayer();
    handy = createMockHandyManager();
    funscript = createMockFunscriptEngine();
    engine = new SyncEngine({
      videoPlayer: player,
      handyManager: handy,
      funscriptEngine: funscript,
    });
  });

  afterEach(() => {
    engine.stop();
  });

  describe('start / stop', () => {
    it('binds video events on start', () => {
      const spy = vi.spyOn(player.video, 'addEventListener');
      engine.start();
      expect(spy).toHaveBeenCalledWith('playing', expect.any(Function));
      expect(spy).toHaveBeenCalledWith('pause', expect.any(Function));
      expect(spy).toHaveBeenCalledWith('seeked', expect.any(Function));
      expect(spy).toHaveBeenCalledWith('ended', expect.any(Function));
    });

    it('unbinds video events on stop', () => {
      engine.start();
      const spy = vi.spyOn(player.video, 'removeEventListener');
      engine.stop();
      expect(spy).toHaveBeenCalledWith('playing', expect.any(Function));
      expect(spy).toHaveBeenCalledWith('pause', expect.any(Function));
      expect(spy).toHaveBeenCalledWith('seeked', expect.any(Function));
      expect(spy).toHaveBeenCalledWith('ended', expect.any(Function));
    });

    it('does not double-start', () => {
      const spy = vi.spyOn(player.video, 'addEventListener');
      engine.start();
      const count1 = spy.mock.calls.length;
      engine.start();
      expect(spy.mock.calls.length).toBe(count1);
    });
  });

  describe('setupScript', () => {
    it('sets up script on handy', async () => {
      const result = await engine.setupScript('http://localhost:5123/scripts/test.csv');
      expect(result).toBe(true);
      expect(handy.setupScript).toHaveBeenCalledWith('http://localhost:5123/scripts/test.csv');
    });

    it('returns false when handy not connected', async () => {
      handy.connected = false;
      const result = await engine.setupScript('http://test.csv');
      expect(result).toBe(false);
    });
  });

  describe('video event → Handy call mapping', () => {
    it('playing event triggers hsspPlay', async () => {
      engine.start();
      engine._scriptReady = true;
      player.video.dispatchEvent(new Event('playing'));
      // Give async handler time to run
      await vi.waitFor(() => expect(handy.hsspPlay).toHaveBeenCalled());
    });

    it('pause event triggers hsspStop', async () => {
      engine.start();
      engine._scriptReady = true;
      player.video.dispatchEvent(new Event('pause'));
      await vi.waitFor(() => expect(handy.hsspStop).toHaveBeenCalled());
    });

    it('seeked event triggers stop then play if not paused', async () => {
      engine.start();
      engine._scriptReady = true;
      // Simulate video not paused
      Object.defineProperty(player.video, 'paused', { value: false, configurable: true });
      player.video.dispatchEvent(new Event('seeked'));
      await vi.waitFor(() => {
        expect(handy.hsspStop).toHaveBeenCalled();
        expect(handy.hsspPlay).toHaveBeenCalled();
      });
    });

    it('seeked event only stops if video is paused', async () => {
      engine.start();
      engine._scriptReady = true;
      Object.defineProperty(player.video, 'paused', { value: true, configurable: true });
      player.video.dispatchEvent(new Event('seeked'));
      await vi.waitFor(() => expect(handy.hsspStop).toHaveBeenCalled());
      expect(handy.hsspPlay).not.toHaveBeenCalled();
    });

    it('ended event triggers hsspStop', async () => {
      engine.start();
      engine._scriptReady = true;
      player.video.dispatchEvent(new Event('ended'));
      await vi.waitFor(() => expect(handy.hsspStop).toHaveBeenCalled());
    });
  });

  describe('does not call Handy when inactive', () => {
    it('playing event ignored when engine not started', () => {
      engine._scriptReady = true;
      player.video.dispatchEvent(new Event('playing'));
      expect(handy.hsspPlay).not.toHaveBeenCalled();
    });

    it('playing event ignored when handy not connected', async () => {
      handy.connected = false;
      engine.start();
      engine._scriptReady = true;
      player.video.dispatchEvent(new Event('playing'));
      // Small delay to let any async handler run
      await new Promise((r) => setTimeout(r, 10));
      expect(handy.hsspPlay).not.toHaveBeenCalled();
    });

    it('playing event ignored when script not ready', async () => {
      engine.start();
      // _scriptReady defaults to false
      player.video.dispatchEvent(new Event('playing'));
      await new Promise((r) => setTimeout(r, 10));
      expect(handy.hsspPlay).not.toHaveBeenCalled();
    });
  });

  describe('time calculation', () => {
    it('converts currentTime to milliseconds for hsspPlay', async () => {
      engine.start();
      engine._scriptReady = true;
      Object.defineProperty(player.video, 'currentTime', { value: 5.5, configurable: true });
      player.video.dispatchEvent(new Event('playing'));
      await vi.waitFor(() => expect(handy.hsspPlay).toHaveBeenCalledWith(5500));
    });
  });

  describe('onSyncStatus callback', () => {
    it('fires synced status on play', async () => {
      const onStatus = vi.fn();
      engine.onSyncStatus = onStatus;
      engine.start();
      engine._scriptReady = true;
      player.video.dispatchEvent(new Event('playing'));
      await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith('synced'));
    });
  });
});
