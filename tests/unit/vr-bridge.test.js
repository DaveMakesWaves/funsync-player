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

// === Connection-reliability pass (2026-04-28) ===

describe('VRBridge — linkState (three-state UI)', () => {
  it('returns disconnected when not connected', async () => {
    const { VRBridge } = await import('../../renderer/js/vr-bridge.js');
    const bridge = new VRBridge();
    expect(bridge.linkState).toBe('disconnected');
  });

  it('returns receiving immediately after connect (seeded _lastArrivalMs)', async () => {
    const { VRBridge } = await import('../../renderer/js/vr-bridge.js');
    const bridge = new VRBridge();
    window.funsync.vrConnect.mockResolvedValue({ success: true });
    await bridge.connect('deovr');
    // _lastArrivalMs is seeded to Date.now() on connect, so linkState
    // is 'receiving' (within the 5 s threshold).
    expect(bridge.linkState).toBe('receiving');
    bridge._stopLivenessWatchdog();
  });

  it('flips to waiting when no packet arrives for >5s', async () => {
    const { VRBridge } = await import('../../renderer/js/vr-bridge.js');
    const bridge = new VRBridge();
    window.funsync.vrConnect.mockResolvedValue({ success: true });
    await bridge.connect('deovr');
    // Backdate the last arrival to 6 s ago
    bridge._lastArrivalMs = Date.now() - 6000;
    expect(bridge.linkState).toBe('waiting');
    bridge._stopLivenessWatchdog();
  });

  it('returns to receiving when a fresh packet arrives', async () => {
    const { VRBridge } = await import('../../renderer/js/vr-bridge.js');
    const bridge = new VRBridge();
    window.funsync.vrConnect.mockResolvedValue({ success: true });
    await bridge.connect('deovr');
    bridge._lastArrivalMs = Date.now() - 6000;
    expect(bridge.linkState).toBe('waiting');
    // A fresh packet arrives — handler bumps _lastArrivalMs
    bridge._handleStateUpdate({
      currentTime: 10, duration: 100, playerState: 0, playbackSpeed: 1,
      _arrivalMs: Date.now(),
    });
    expect(bridge.linkState).toBe('receiving');
    bridge._stopLivenessWatchdog();
  });
});

describe('VRBridge — connect() coalescing', () => {
  it('short-circuits a second connect() while one is in flight', async () => {
    const { VRBridge } = await import('../../renderer/js/vr-bridge.js');
    const bridge = new VRBridge();
    let resolveFirst;
    window.funsync.vrConnect.mockImplementation(() =>
      new Promise(r => { resolveFirst = r; })
    );
    // Don't await — kick off a "slow" connect
    const p1 = bridge.connect('deovr', '1.2.3.4', 23554);
    // Immediately try again — should short-circuit and return false
    const p2 = bridge.connect('deovr', '1.2.3.4', 23554);
    expect(await p2).toBe(false);
    // First one still resolves normally
    resolveFirst({ success: true });
    expect(await p1).toBe(true);
    bridge._stopLivenessWatchdog();
  });
});

describe('VRBridge — no self-retry on disconnect', () => {
  it('socket close does NOT trigger _attemptReconnect', async () => {
    // After the connection-reliability pass, the bridge no longer
    // self-retries — activity poll is sole driver. Pre-pass this would
    // call _attemptReconnect which would schedule a setTimeout.
    const { VRBridge } = await import('../../renderer/js/vr-bridge.js');
    const bridge = new VRBridge();
    window.funsync.vrConnect.mockResolvedValue({ success: true });
    await bridge.connect('deovr');
    // The _attemptReconnect method should not exist anymore.
    expect(bridge._attemptReconnect).toBeUndefined();
    expect(bridge._reconnectTimer).toBeUndefined();
    bridge._stopLivenessWatchdog();
  });
});

// === Smoothing pass (2026-04-28) ===

describe('VRPlaybackProxy — smoothing (Stage A: drift-clamped EMA)', () => {
  let proxy;
  beforeEach(() => { proxy = new VRPlaybackProxy(); });

  it('first packet is hard-snapped (no prior anchor to blend with)', () => {
    proxy.updateFromVR({ currentTime: 10, duration: 100, playerState: 0, playbackSpeed: 1 });
    // Internal anchor === reported value on first packet
    expect(proxy._lastReportedTime).toBe(10);
  });

  it('sub-threshold packet is EMA-blended, not hard-snapped', async () => {
    // Arm a steady-state anchor at t=10 playing at 1×.
    proxy.updateFromVR({ currentTime: 10, duration: 100, playerState: 0, playbackSpeed: 1 });
    await new Promise(r => setTimeout(r, 100));
    // VR reports t=10.05 — we expected ~10.1 (100ms elapsed at 1×),
    // so the packet is 50ms BEHIND expected. With α=0.20, the
    // anchor blends to expected + 0.20 × (-0.05) = ~10.09.
    proxy.updateFromVR({ currentTime: 10.05, duration: 100, playerState: 0, playbackSpeed: 1 });
    // Anchor should be near 10.09, NOT 10.05 (which would be a hard snap).
    expect(proxy._lastReportedTime).toBeGreaterThan(10.07);
    expect(proxy._lastReportedTime).toBeLessThan(10.11);
  });

  it('seek > 1 s threshold hard-snaps and dispatches seeked', async () => {
    proxy.updateFromVR({ currentTime: 10, duration: 100, playerState: 0, playbackSpeed: 1 });
    await new Promise(r => setTimeout(r, 50));
    const handler = vi.fn();
    proxy.addEventListener('seeked', handler);
    // Jump to t=50 — way beyond the 1 s threshold.
    proxy.updateFromVR({ currentTime: 50, duration: 100, playerState: 0, playbackSpeed: 1 });
    expect(handler).toHaveBeenCalled();
    expect(proxy._lastReportedTime).toBe(50);
  });

  it('drift just below 1 s does NOT dispatch seeked (EMA absorbs)', async () => {
    proxy.updateFromVR({ currentTime: 10, duration: 100, playerState: 0, playbackSpeed: 1 });
    await new Promise(r => setTimeout(r, 50));
    const handler = vi.fn();
    proxy.addEventListener('seeked', handler);
    // 0.8 s drift — under the threshold.
    proxy.updateFromVR({ currentTime: 10.85, duration: 100, playerState: 0, playbackSpeed: 1 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('pause→play transition hard-snaps even at sub-threshold drift', () => {
    proxy.updateFromVR({ currentTime: 10, duration: 100, playerState: 1, playbackSpeed: 1 });
    proxy.updateFromVR({ currentTime: 10.05, duration: 100, playerState: 0, playbackSpeed: 1 });
    // State transition forced a hard snap — anchor === packet value.
    expect(proxy._lastReportedTime).toBe(10.05);
  });
});

describe('VRPlaybackProxy — smoothing (Stage B: slew-rate clamp)', () => {
  let proxy;
  beforeEach(() => { proxy = new VRPlaybackProxy(); });

  it('consumer-visible time never decreases between reads (monotonicity)', async () => {
    proxy.updateFromVR({ currentTime: 10, duration: 100, playerState: 0, playbackSpeed: 1 });
    let prev = -Infinity;
    // 1000 reads with random small jitter on the underlying anchor.
    for (let i = 0; i < 1000; i++) {
      // Inject some jitter into the anchor as a hostile EMA convergence.
      if (i % 100 === 0) {
        proxy._lastReportedTime += (Math.random() - 0.5) * 0.05;
      }
      const t = proxy.currentTime;
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
      // Tick microtask so performance.now advances slightly.
      await Promise.resolve();
    }
  });

  it('consumer advance is bounded by ±10 % of expected per read', async () => {
    proxy.updateFromVR({ currentTime: 10, duration: 100, playerState: 0, playbackSpeed: 1 });
    proxy.currentTime; // prime the slew state
    const before = performance.now();
    await new Promise(r => setTimeout(r, 100));
    const after = performance.now();
    // Force the underlying anchor far ahead so the slew clamp engages.
    proxy._lastReportedTime += 5; // way more than the 10% would allow
    const t = proxy.currentTime;
    const wallElapsed = (after - before) / 1000;
    // Consumer advance ≈ 1.1 × wallElapsed × 1 (speed) — bounded.
    // Allow generous tolerance: < 1.5 × expected (would be ~6 s without clamp).
    expect(t).toBeLessThan(10 + wallElapsed * 1.5);
  });
});

describe('VRPlaybackProxy — smoothing (anchor reset paths)', () => {
  let proxy;
  beforeEach(() => { proxy = new VRPlaybackProxy(); });

  it('programmatic seek resets slew state and adopts new value instantly', async () => {
    proxy.updateFromVR({ currentTime: 10, duration: 100, playerState: 0, playbackSpeed: 1 });
    proxy.currentTime; // prime
    await new Promise(r => setTimeout(r, 50));
    proxy.currentTime = 75;
    // Next read returns the new value (paused getter would, but it's playing).
    // Slew is reset, so first read after the seek primes from raw.
    const t = proxy.currentTime;
    expect(t).toBeGreaterThanOrEqual(75);
    expect(t).toBeLessThan(75.1); // hasn't had time to advance
  });

  it('reset() clears slew state', () => {
    proxy.updateFromVR({ currentTime: 10, duration: 100, playerState: 0, playbackSpeed: 1 });
    proxy.currentTime; // prime
    expect(proxy._consumerLastReadAt).toBeGreaterThan(0);
    proxy.reset();
    expect(proxy._consumerLastReadAt).toBe(0);
    expect(proxy._consumerLastValue).toBe(0);
  });
});

describe('VRBridge — liveness watchdog', () => {
  it('synthesises a disconnect when no packet arrives within timeout', async () => {
    vi.useFakeTimers();
    try {
      const { VRBridge } = await import('../../renderer/js/vr-bridge.js');
      const bridge = new VRBridge();
      const onDisconnect = vi.fn();
      bridge.onDisconnect = onDisconnect;
      window.funsync.vrConnect.mockResolvedValue({ success: true });
      await bridge.connect('deovr');
      // Backdate the last arrival so the watchdog sees an over-timeout gap.
      // (The watchdog reads Date.now(), which fake timers DON'T advance —
      // we have to fake the gap by writing the field directly.)
      bridge._lastArrivalMs = Date.now() - 9000;
      // Advance the watchdog interval (1 s) — its tick should detect the
      // 9 s gap and tear down.
      vi.advanceTimersByTime(1100);
      expect(bridge.connected).toBe(false);
      expect(onDisconnect).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT tear down while packets are arriving', async () => {
    vi.useFakeTimers();
    try {
      const { VRBridge } = await import('../../renderer/js/vr-bridge.js');
      const bridge = new VRBridge();
      const onDisconnect = vi.fn();
      bridge.onDisconnect = onDisconnect;
      window.funsync.vrConnect.mockResolvedValue({ success: true });
      await bridge.connect('deovr');
      // Simulate a packet arriving every 100 ms for several seconds —
      // _lastArrivalMs stays fresh.
      for (let i = 0; i < 30; i++) {
        bridge._lastArrivalMs = Date.now();
        vi.advanceTimersByTime(100);
      }
      expect(bridge.connected).toBe(true);
      expect(onDisconnect).not.toHaveBeenCalled();
      bridge._stopLivenessWatchdog();
    } finally {
      vi.useRealTimers();
    }
  });
});
