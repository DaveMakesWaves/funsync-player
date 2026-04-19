// Tests for Phase 17.4: Autoblow Ultra / VacuGlide 2
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AutoblowManager } from '../../renderer/js/autoblow-manager.js';
import { AutoblowSync } from '../../renderer/js/autoblow-sync.js';

// --- AutoblowManager Tests ---

describe('AutoblowManager', () => {
  let mgr;

  beforeEach(() => {
    vi.clearAllMocks();
    mgr = new AutoblowManager();
  });

  it('starts disconnected', () => {
    expect(mgr.connected).toBe(false);
    expect(mgr.deviceType).toBeNull();
    expect(mgr.isUltra).toBe(false);
    expect(mgr.isVacuglide).toBe(false);
  });

  it('connects with Ultra device type', async () => {
    window.funsync.autoblowConnect.mockResolvedValue({
      success: true,
      deviceType: 'autoblow-ultra',
      deviceInfo: { deviceType: 'autoblow-ultra' },
    });
    const success = await mgr.connect('test-token-123');
    expect(success).toBe(true);
    expect(mgr.connected).toBe(true);
    expect(mgr.isUltra).toBe(true);
    expect(mgr.isVacuglide).toBe(false);
    expect(mgr.deviceType).toBe('autoblow-ultra');
  });

  it('connects with VacuGlide device type', async () => {
    window.funsync.autoblowConnect.mockResolvedValue({
      success: true,
      deviceType: 'vacuglide',
      deviceInfo: { deviceType: 'vacuglide' },
    });
    const success = await mgr.connect('test-token-456');
    expect(success).toBe(true);
    expect(mgr.isVacuglide).toBe(true);
    expect(mgr.isUltra).toBe(false);
  });

  it('fires onConnect callback', async () => {
    window.funsync.autoblowConnect.mockResolvedValue({
      success: true, deviceType: 'autoblow-ultra', deviceInfo: {},
    });
    const cb = vi.fn();
    mgr.onConnect = cb;
    await mgr.connect('token');
    expect(cb).toHaveBeenCalled();
  });

  it('handles connection failure', async () => {
    window.funsync.autoblowConnect.mockResolvedValue({
      success: false, error: 'Device not connected',
    });
    const errCb = vi.fn();
    mgr.onError = errCb;
    const success = await mgr.connect('bad-token');
    expect(success).toBe(false);
    expect(mgr.connected).toBe(false);
    expect(errCb).toHaveBeenCalled();
  });

  it('disconnects cleanly', async () => {
    window.funsync.autoblowConnect.mockResolvedValue({
      success: true, deviceType: 'autoblow-ultra', deviceInfo: {},
    });
    await mgr.connect('token');
    expect(mgr.connected).toBe(true);

    await mgr.disconnect();
    expect(mgr.connected).toBe(false);
    expect(mgr.deviceType).toBeNull();
    expect(mgr.scriptUploaded).toBe(false);
  });

  it('fires onDisconnect callback', async () => {
    window.funsync.autoblowConnect.mockResolvedValue({
      success: true, deviceType: 'autoblow-ultra', deviceInfo: {},
    });
    await mgr.connect('token');
    const cb = vi.fn();
    mgr.onDisconnect = cb;
    await mgr.disconnect();
    expect(cb).toHaveBeenCalled();
  });

  it('uploads script', async () => {
    window.funsync.autoblowConnect.mockResolvedValue({
      success: true, deviceType: 'autoblow-ultra', deviceInfo: {},
    });
    await mgr.connect('token');

    window.funsync.autoblowUploadScript.mockResolvedValue({ success: true });
    const ok = await mgr.uploadScript('{"actions":[]}');
    expect(ok).toBe(true);
    expect(mgr.scriptUploaded).toBe(true);
    expect(window.funsync.autoblowUploadScript).toHaveBeenCalledWith('{"actions":[]}');
  });

  it('upload failure sets scriptUploaded false', async () => {
    window.funsync.autoblowConnect.mockResolvedValue({
      success: true, deviceType: 'autoblow-ultra', deviceInfo: {},
    });
    await mgr.connect('token');

    window.funsync.autoblowUploadScript.mockResolvedValue({ success: false, error: 'Upload failed' });
    const ok = await mgr.uploadScript('bad');
    expect(ok).toBe(false);
    expect(mgr.scriptUploaded).toBe(false);
  });

  it('does not upload when disconnected', async () => {
    const ok = await mgr.uploadScript('{"actions":[]}');
    expect(ok).toBe(false);
    expect(window.funsync.autoblowUploadScript).not.toHaveBeenCalled();
  });

  it('syncStart calls IPC', async () => {
    window.funsync.autoblowConnect.mockResolvedValue({
      success: true, deviceType: 'autoblow-ultra', deviceInfo: {},
    });
    await mgr.connect('token');
    window.funsync.autoblowUploadScript.mockResolvedValue({ success: true });
    await mgr.uploadScript('{}'); // must upload first
    await mgr.syncStart(5000);
    expect(window.funsync.autoblowSyncStart).toHaveBeenCalledWith(5000);
  });

  it('syncStop calls IPC', async () => {
    window.funsync.autoblowConnect.mockResolvedValue({
      success: true, deviceType: 'autoblow-ultra', deviceInfo: {},
    });
    await mgr.connect('token');
    await mgr.syncStop();
    expect(window.funsync.autoblowSyncStop).toHaveBeenCalled();
  });

  it('estimateLatency returns value', async () => {
    window.funsync.autoblowConnect.mockResolvedValue({
      success: true, deviceType: 'autoblow-ultra', deviceInfo: {},
    });
    await mgr.connect('token');
    window.funsync.autoblowLatency.mockResolvedValue({ success: true, latency: 42 });
    const lat = await mgr.estimateLatency();
    expect(lat).toBe(42);
  });

  it('estimateLatency returns 0 when disconnected', async () => {
    const lat = await mgr.estimateLatency();
    expect(lat).toBe(0);
  });
});

// --- AutoblowSync Tests ---

function mockPlayer() {
  return {
    video: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    currentTime: 5,
    paused: false,
    duration: 60,
  };
}

function mockAutoblow() {
  return {
    connected: true,
    isUltra: true,
    isVacuglide: false,
    scriptUploaded: true,
    syncStart: vi.fn(),
    syncStop: vi.fn(),
    syncOffset: vi.fn(),
    uploadScript: vi.fn().mockResolvedValue(true),
  };
}

describe('AutoblowSync', () => {
  let sync, ab;

  beforeEach(() => {
    ab = mockAutoblow();
    sync = new AutoblowSync({
      videoPlayer: mockPlayer(),
      autoblowManager: ab,
    });
  });

  it('starts and binds video events', () => {
    sync.start();
    expect(sync._active).toBe(true);
    expect(sync.player.video.addEventListener).toHaveBeenCalled();
  });

  it('stop calls syncStop', () => {
    sync.start();
    sync.stop();
    expect(ab.syncStop).toHaveBeenCalled();
    expect(sync._active).toBe(false);
  });

  it('upload script marks ready', async () => {
    const ok = await sync.uploadScript('{"actions":[]}');
    expect(ok).toBe(true);
    expect(sync.scriptReady).toBe(true);
  });

  it('playing event calls syncStart with current time', () => {
    sync._scriptReady = true;
    sync.start();
    // Find the playing handler
    const playingCall = sync.player.video.addEventListener.mock.calls.find(c => c[0] === 'playing');
    playingCall[1]();
    expect(ab.syncStart).toHaveBeenCalledWith(5000); // 5s * 1000
  });

  it('pause event calls syncStop', () => {
    sync.start();
    const pauseCall = sync.player.video.addEventListener.mock.calls.find(c => c[0] === 'pause');
    pauseCall[1]();
    expect(ab.syncStop).toHaveBeenCalled();
  });

  it('seeked event restarts sync at new position', async () => {
    sync._scriptReady = true;
    sync.start();
    sync.player.currentTime = 10;
    const seekedCall = sync.player.video.addEventListener.mock.calls.find(c => c[0] === 'seeked');
    await seekedCall[1]();
    expect(ab.syncStop).toHaveBeenCalled();
    expect(ab.syncStart).toHaveBeenCalledWith(10000);
  });

  it('ended event calls syncStop', () => {
    sync.start();
    const endedCall = sync.player.video.addEventListener.mock.calls.find(c => c[0] === 'ended');
    endedCall[1]();
    expect(ab.syncStop).toHaveBeenCalled();
  });

  it('does not sync if script not ready', () => {
    sync._scriptReady = false;
    sync.start();
    const playingCall = sync.player.video.addEventListener.mock.calls.find(c => c[0] === 'playing');
    playingCall[1]();
    expect(ab.syncStart).not.toHaveBeenCalled();
  });
});
