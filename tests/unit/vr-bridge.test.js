// Tests for VR Companion Mode — VRPlaybackProxy + VRBridge
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VRPlaybackProxy } from '../../renderer/js/vr-playback-proxy.js';

// === VRPlaybackProxy ===

describe('VRPlaybackProxy — Basic State', () => {
  let proxy;

  beforeEach(() => {
    proxy = new VRPlaybackProxy();
  });

  it('starts paused at time 0', () => {
    expect(proxy.paused).toBe(true);
    expect(proxy.currentTime).toBe(0);
    expect(proxy.duration).toBe(0);
  });

  it('play dispatches playing event', () => {
    const handler = vi.fn();
    proxy.addEventListener('playing', handler);
    proxy.play();
    expect(handler).toHaveBeenCalled();
    expect(proxy.paused).toBe(false);
  });

  it('pause dispatches pause event', () => {
    proxy.play();
    const handler = vi.fn();
    proxy.addEventListener('pause', handler);
    proxy.pause();
    expect(handler).toHaveBeenCalled();
    expect(proxy.paused).toBe(true);
  });

  it('play returns a Promise', async () => {
    const result = proxy.play();
    expect(result).toBeInstanceOf(Promise);
    await result;
  });

  it('double play does not fire event twice', () => {
    const handler = vi.fn();
    proxy.addEventListener('playing', handler);
    proxy.play();
    proxy.play();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('double pause does not fire event twice', () => {
    proxy.play();
    const handler = vi.fn();
    proxy.addEventListener('pause', handler);
    proxy.pause();
    proxy.pause();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('VRPlaybackProxy — updateFromVR', () => {
  let proxy;

  beforeEach(() => {
    proxy = new VRPlaybackProxy();
  });

  it('updates duration', () => {
    proxy.updateFromVR({ currentTime: 0, duration: 300, playerState: 1, playbackSpeed: 1 });
    expect(proxy.duration).toBe(300);
  });

  it('updates currentTime', () => {
    proxy.updateFromVR({ currentTime: 45.5, duration: 300, playerState: 1, playbackSpeed: 1 });
    expect(proxy.currentTime).toBeCloseTo(45.5, 0);
  });

  it('transition from paused to playing fires playing event', () => {
    proxy.updateFromVR({ currentTime: 0, duration: 100, playerState: 1, playbackSpeed: 1 }); // paused
    const handler = vi.fn();
    proxy.addEventListener('playing', handler);
    proxy.updateFromVR({ currentTime: 0, duration: 100, playerState: 0, playbackSpeed: 1 }); // playing
    expect(handler).toHaveBeenCalled();
    expect(proxy.paused).toBe(false);
  });

  it('transition from playing to paused fires pause event', () => {
    proxy.updateFromVR({ currentTime: 0, duration: 100, playerState: 0, playbackSpeed: 1 }); // playing
    const handler = vi.fn();
    proxy.addEventListener('pause', handler);
    proxy.updateFromVR({ currentTime: 5, duration: 100, playerState: 1, playbackSpeed: 1 }); // paused
    expect(handler).toHaveBeenCalled();
  });

  it('video end fires ended event', () => {
    const handler = vi.fn();
    proxy.addEventListener('ended', handler);
    proxy.updateFromVR({ currentTime: 0, duration: 100, playerState: 0, playbackSpeed: 1 });
    proxy.updateFromVR({ currentTime: 99.8, duration: 100, playerState: 0, playbackSpeed: 1 });
    expect(handler).toHaveBeenCalled();
  });

  it('does not fire ended when paused near end', () => {
    const handler = vi.fn();
    proxy.addEventListener('ended', handler);
    proxy.updateFromVR({ currentTime: 99.8, duration: 100, playerState: 1, playbackSpeed: 1 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('handles missing fields gracefully', () => {
    proxy.updateFromVR({});
    // Duration defaults to 0, speed defaults to 1
    expect(proxy.duration).toBe(0);
    // playerState undefined → treated as playing (not === 1)
    // This is acceptable — VR players always send playerState
  });

  it('playbackSpeed is stored', () => {
    proxy.updateFromVR({ currentTime: 0, duration: 100, playerState: 0, playbackSpeed: 0.5 });
    expect(proxy.playbackRate).toBe(0.5);
  });
});

describe('VRPlaybackProxy — Interpolation', () => {
  let proxy;

  beforeEach(() => {
    proxy = new VRPlaybackProxy();
  });

  it('interpolates time when playing', async () => {
    proxy.updateFromVR({ currentTime: 10, duration: 100, playerState: 0, playbackSpeed: 1 });
    // Wait a bit and check that currentTime has advanced
    await new Promise(r => setTimeout(r, 100));
    expect(proxy.currentTime).toBeGreaterThan(10);
    expect(proxy.currentTime).toBeLessThan(11);
  });

  it('does not interpolate when paused', async () => {
    proxy.updateFromVR({ currentTime: 10, duration: 100, playerState: 1, playbackSpeed: 1 });
    await new Promise(r => setTimeout(r, 100));
    expect(proxy.currentTime).toBeCloseTo(10, 0);
  });

  it('interpolates at half speed', async () => {
    proxy.updateFromVR({ currentTime: 10, duration: 100, playerState: 0, playbackSpeed: 0.5 });
    await new Promise(r => setTimeout(r, 200));
    const elapsed = proxy.currentTime - 10;
    expect(elapsed).toBeLessThan(0.2); // ~0.1s at 0.5x speed
  });
});

describe('VRPlaybackProxy — Reset', () => {
  it('reset clears all state', () => {
    const proxy = new VRPlaybackProxy();
    proxy.updateFromVR({ currentTime: 50, duration: 200, playerState: 0, playbackSpeed: 1.5 });
    proxy.reset();
    expect(proxy.currentTime).toBe(0);
    expect(proxy.duration).toBe(0);
    expect(proxy.paused).toBe(true);
    expect(proxy.playbackRate).toBe(1);
  });
});

// === VRBridge Path Normalization ===

describe('VRBridge — Path Normalization', () => {
  // Mirrors renderer/js/vr-bridge.js _normalizePath — keep in sync.
  const normalizePath = (rawPath) => {
    let name = rawPath;
    if (name.includes('://')) {
      try { name = new URL(name).pathname; } catch { /* keep */ }
    }
    name = name.split(/[\\/]/).pop() || name;
    try { name = decodeURIComponent(name); } catch { /* keep */ }
    name = name.replace(/\.(?:mp4|mkv|webm|avi|mov|wmv|flv|m4v|mp3|wav|ogg|flac|aac|m4a|3gp|ts|mts|m2ts)$/i, '');
    name = name.toLowerCase().replace(/[_.\-]/g, ' ').replace(/\s+/g, ' ').trim();
    return name;
  };

  it('Windows PCVR path', () => {
    expect(normalizePath('D:\\Videos\\Private\\My Scene.mp4')).toBe('my scene');
  });

  it('Quest Android path', () => {
    expect(normalizePath('/storage/emulated/0/VR/My Scene.mp4')).toBe('my scene');
  });

  it('DLNA URL with encoding', () => {
    expect(normalizePath('http://192.168.1.5:8080/My%20Scene.mp4')).toBe('my scene');
  });

  it('XBVR API URL', () => {
    expect(normalizePath('http://localhost:9999/api/dms/file/123/scene.mp4')).toBe('scene');
  });

  it('path with special characters', () => {
    expect(normalizePath('/storage/emulated/0/Scene_(2024)_[4K].mp4')).toBe('scene (2024) [4k]');
  });

  it('path with underscores and dashes', () => {
    expect(normalizePath('D:\\Videos\\My_Scene-HD.mp4')).toBe('my scene hd');
  });

  it('forward slashes on Windows', () => {
    expect(normalizePath('D:/Videos/Scene.mp4')).toBe('scene');
  });

  it('empty path', () => {
    expect(normalizePath('')).toBe('');
  });

  it('no extension', () => {
    expect(normalizePath('/path/to/Scene')).toBe('scene');
  });

  it('double encoded URL', () => {
    expect(normalizePath('http://host/My%2520Scene.mp4')).toBe('my%20scene');
    // Only single-decode — double encoding stays partially encoded. This is expected.
  });

  // --- Regression: dotted stems (HereSphere often reports without extension)
  it('leading number prefix with dot stays intact', () => {
    // Before fix: `lastIndexOf('.')` stripped to just "2" → nothing matched.
    expect(normalizePath('/storage/emulated/0/Interactive/2.GroVR_30 35_ Lina Laon Amecan Bety2_TMAL'))
      .toBe('2 grovr 30 35 lina laon amecan bety2 tmal');
  });

  it('dotted stem without extension', () => {
    expect(normalizePath('/storage/emulated/0/Interactive/9.VRBTS_46 20_Naie Mars_the_nutcracker_tmal'))
      .toBe('9 vrbts 46 20 naie mars the nutcracker tmal');
  });

  it('dotted stem with real extension strips only the extension', () => {
    expect(normalizePath('/path/2.GroVR_scene.mp4')).toBe('2 grovr scene');
  });

  it('multi-dot filename with extension', () => {
    // e.g. "Studio.Title.2024.1080p.mkv" — only .mkv should be stripped
    expect(normalizePath('/path/Studio.Title.2024.1080p.mkv')).toBe('studio title 2024 1080p');
  });
});

// === VRBridge Connection ===

describe('VRBridge — Connection Lifecycle', () => {
  it('starts disconnected', async () => {
    const { VRBridge } = await import('../../renderer/js/vr-bridge.js');
    const bridge = new VRBridge();
    expect(bridge.connected).toBe(false);
    expect(bridge.currentVideoPath).toBeNull();
  });

  it('connect calls IPC', async () => {
    const { VRBridge } = await import('../../renderer/js/vr-bridge.js');
    const bridge = new VRBridge();
    window.funsync.vrConnect.mockResolvedValue({ success: true });
    const result = await bridge.connect('deovr', '127.0.0.1', 23554);
    expect(result).toBe(true);
    expect(bridge.connected).toBe(true);
    expect(window.funsync.vrConnect).toHaveBeenCalledWith('127.0.0.1', 23554);
  });

  it('failed connect returns false', async () => {
    const { VRBridge } = await import('../../renderer/js/vr-bridge.js');
    const bridge = new VRBridge();
    window.funsync.vrConnect.mockResolvedValue({ success: false, error: 'refused' });
    const result = await bridge.connect('deovr');
    expect(result).toBe(false);
    expect(bridge.connected).toBe(false);
  });

  it('disconnect calls IPC and resets state', async () => {
    const { VRBridge } = await import('../../renderer/js/vr-bridge.js');
    const bridge = new VRBridge();
    window.funsync.vrConnect.mockResolvedValue({ success: true });
    await bridge.connect('deovr');
    await bridge.disconnect();
    expect(bridge.connected).toBe(false);
    expect(bridge.currentVideoPath).toBeNull();
    expect(window.funsync.vrDisconnect).toHaveBeenCalled();
  });

  it('fires onConnect callback', async () => {
    const { VRBridge } = await import('../../renderer/js/vr-bridge.js');
    const bridge = new VRBridge();
    const cb = vi.fn();
    bridge.onConnect = cb;
    window.funsync.vrConnect.mockResolvedValue({ success: true });
    await bridge.connect('deovr');
    expect(cb).toHaveBeenCalled();
  });

  it('fires onDisconnect callback', async () => {
    const { VRBridge } = await import('../../renderer/js/vr-bridge.js');
    const bridge = new VRBridge();
    const cb = vi.fn();
    bridge.onDisconnect = cb;
    window.funsync.vrConnect.mockResolvedValue({ success: true });
    await bridge.connect('deovr');
    await bridge.disconnect();
    expect(cb).toHaveBeenCalled();
  });

  it('seek sends command via IPC', async () => {
    const { VRBridge } = await import('../../renderer/js/vr-bridge.js');
    const bridge = new VRBridge();
    window.funsync.vrConnect.mockResolvedValue({ success: true });
    await bridge.connect('deovr');
    bridge.seek(120.5);
    expect(window.funsync.vrSend).toHaveBeenCalledWith('{"currentTime":120.5}');
  });

  it('seek does nothing when disconnected', async () => {
    vi.clearAllMocks();
    const { VRBridge } = await import('../../renderer/js/vr-bridge.js');
    const bridge = new VRBridge();
    bridge.seek(120);
    expect(window.funsync.vrSend).not.toHaveBeenCalled();
  });
});

// === Edge Cases ===

describe('VRPlaybackProxy — Edge Cases', () => {
  it('handles NaN duration (defaults to 0)', () => {
    const proxy = new VRPlaybackProxy();
    proxy.updateFromVR({ currentTime: 5, duration: NaN, playerState: 0, playbackSpeed: 1 });
    expect(proxy.duration).toBe(0); // NaN || 0 = 0
  });

  it('handles zero duration', () => {
    const proxy = new VRPlaybackProxy();
    proxy.updateFromVR({ currentTime: 0, duration: 0, playerState: 0, playbackSpeed: 1 });
    expect(proxy.duration).toBe(0);
  });

  it('handles negative currentTime', () => {
    const proxy = new VRPlaybackProxy();
    proxy.updateFromVR({ currentTime: -5, duration: 100, playerState: 1, playbackSpeed: 1 });
    expect(proxy.currentTime).toBe(-5);
    // Don't crash — let the sync engine handle clamping
  });

  it('handles playbackSpeed 0 (defaults to 1)', () => {
    const proxy = new VRPlaybackProxy();
    proxy.updateFromVR({ currentTime: 10, duration: 100, playerState: 0, playbackSpeed: 0 });
    expect(proxy.playbackRate).toBe(1); // 0 || 1 = 1 (falsy guard)
  });
});
