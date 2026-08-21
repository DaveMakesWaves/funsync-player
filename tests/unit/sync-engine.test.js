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

    it('rapid seeks: superseded handler does not issue stale hsspPlay', async () => {
      // Regression guard for the race where handler 1's slow hsspStop
      // resolves AFTER handler 2's hsspPlay has already landed — the old
      // handler would then fire hsspPlay(oldTime) and silently override
      // the newer position until drift monitor caught up.
      engine.start();
      engine._scriptReady = true;
      Object.defineProperty(player.video, 'paused', { value: false, configurable: true });

      // Hold both hsspStop calls on manual promises so we can interleave.
      let resolveStop1, resolveStop2;
      handy.hsspStop
        .mockReturnValueOnce(new Promise((r) => { resolveStop1 = r; }))
        .mockReturnValueOnce(new Promise((r) => { resolveStop2 = r; }));

      // First seek at 1s
      player.video.currentTime = 1;
      player.video.dispatchEvent(new Event('seeked'));
      await Promise.resolve();

      // Second seek at 2s before the first stop resolves
      player.video.currentTime = 2;
      player.video.dispatchEvent(new Event('seeked'));
      await Promise.resolve();

      // Resolve the older stop LAST — this is the order that would have
      // caused the bug (old handler wakes up late and fires hsspPlay).
      resolveStop2();
      resolveStop1();

      await vi.waitFor(() => {
        expect(handy.hsspPlay).toHaveBeenCalledWith(2000);
      });

      // The superseded first handler must NOT have called hsspPlay at its
      // stale 1000ms timestamp.
      const playCalls = handy.hsspPlay.mock.calls;
      expect(playCalls.some(args => args[0] === 1000)).toBe(false);
    });

    it('seek generation counter increments per seeked event', async () => {
      engine.start();
      engine._scriptReady = true;
      Object.defineProperty(player.video, 'paused', { value: true, configurable: true });
      expect(engine._seekGen).toBe(0);
      player.video.dispatchEvent(new Event('seeked'));
      await vi.waitFor(() => expect(engine._seekGen).toBe(1));
      player.video.dispatchEvent(new Event('seeked'));
      await vi.waitFor(() => expect(engine._seekGen).toBe(2));
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

  // Re-anchor after the Orgasm Switch releases. `start()` only anchors when
  // player.paused reads false at that instant, which is unreliable straight
  // after a release (in a web-remote session the proxy can still report
  // paused while the phone buffers). The logs showed "Sync engine started"
  // with no following hsspPlay, leaving the Handy where the finisher left
  // it. Buttplug never showed this because its per-tick engine re-reads
  // currentTime every frame.
  describe('resync — forced re-anchor', () => {
    it('anchors at the CURRENT player time even when start() skipped it', async () => {
      engine._scriptReady = true;
      engine.start();
      handy.hsspPlay.mockClear();
      player.video.currentTime = 42;
      await engine.resync();
      expect(handy.hsspPlay).toHaveBeenCalledWith(42000);
    });

    it('does nothing when the engine is stopped', async () => {
      engine._scriptReady = true;
      engine.stop();
      handy.hsspPlay.mockClear();
      expect(await engine.resync()).toBe(false);
      expect(handy.hsspPlay).not.toHaveBeenCalled();
    });

    it('does nothing when no script is set up', async () => {
      engine._scriptReady = false;
      engine.start();
      handy.hsspPlay.mockClear();
      expect(await engine.resync()).toBe(false);
      expect(handy.hsspPlay).not.toHaveBeenCalled();
    });

    it('does nothing when the Handy is disconnected', async () => {
      engine._scriptReady = true;
      engine.start();
      handy.connected = false;
      handy.hsspPlay.mockClear();
      expect(await engine.resync()).toBe(false);
      expect(handy.hsspPlay).not.toHaveBeenCalled();
    });
  });
});

// x0193143, thread #288: "if I manually connect Handy via connection key
// after program started, when I paused the video Handy would keep working
// about 15 seconds".
//
// His log is the proof. hsspPlay is a CLOUD round trip and it is SLOW:
//   16:50:47.448  hsspPlay(7508) issued
//   16:50:56.103  ...result            (8.7s)
//   16:51:27.097  correction hsspPlay(4865) issued
//   16:51:44.435  ...result            (17.3s)
//
// Pause inside that window and the ordering inverts: hsspStop goes out and
// reaches the device, the pending hsspPlay lands AFTER it, and the device
// happily resumes with nothing left to stop it.
//
// _handleSeeked already guarded exactly this with a generation token, and
// its comment names the hazard — "a slow Stop from an earlier handler can
// resolve AFTER a newer handler's Play". The pause path never got the same
// protection.
describe('pause during an in-flight hsspPlay (thread #288)', () => {
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
    engine._active = true;
    engine._scriptReady = true;
  });

  afterEach(() => { engine.stop?.(); });

  /** hsspPlay that does not resolve until we say so. */
  function deferPlay() {
    let release;
    handy.hsspPlay = vi.fn(() => new Promise((res) => { release = () => res(true); }));
    return () => release();
  }

  it('re-sends the stop when a play resolves after a pause', async () => {
    const releasePlay = deferPlay();

    const playing = engine._handlePlaying();          // hangs on the cloud call
    await Promise.resolve();

    // User pauses while the play is still travelling.
    Object.defineProperty(player.video, 'paused', { value: true, configurable: true });
    await engine._handlePause();
    expect(handy.hsspStop).toHaveBeenCalledTimes(1);

    releasePlay();                                     // the slow play finally lands
    await playing;

    // THE FIX: without this the device is left playing after a pause.
    expect(
      handy.hsspStop.mock.calls.length,
      'a play that resolved after a pause left the device running',
    ).toBeGreaterThanOrEqual(2);
  });

  it('does not schedule the correction play after a pause', async () => {
    vi.useFakeTimers();
    try {
      const releasePlay = deferPlay();
      const playing = engine._handlePlaying();
      await Promise.resolve();

      Object.defineProperty(player.video, 'paused', { value: true, configurable: true });
      await engine._handlePause();

      releasePlay();
      await playing;

      handy.hsspPlay.mockClear();
      await vi.advanceTimersByTimeAsync(10000);
      expect(handy.hsspPlay, 'correction play fired after a pause').not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // The ordinary path must not regress: a play that is NOT superseded should
  // leave the device playing and send no stop of its own.
  it('leaves a normal play alone', async () => {
    await engine._handlePlaying();
    expect(handy.hsspPlay).toHaveBeenCalledTimes(1);
    expect(handy.hsspStop).not.toHaveBeenCalled();
  });
});

// Two plays close together must NOT stop the device (Dave's Handy, 2026-08-21).
//
// `_playGen` is bumped by BOTH _handlePlaying and _handlePause, so the first
// of two rapid plays saw the generation move and concluded a PAUSE had
// superseded it — then sent hsspStop, silencing the device immediately after
// the newer play had started it. The orgasm-switch restore produces exactly
// this shape: an explicit start() plus the element's own `playing` event, and
// the log showed the two hsspPlay calls 1ms apart followed by a stop.
describe('SyncEngine — supersede: pause vs another play', () => {
  let player, handy, funscript, engine;

  beforeEach(() => {
    player = createMockVideoPlayer();
    handy = createMockHandyManager();
    funscript = createMockFunscriptEngine();
    engine = new SyncEngine({ videoPlayer: player, handyManager: handy, funscriptEngine: funscript });
    engine._active = true;
    engine._scriptReady = true;
  });

  afterEach(() => { engine._stopDriftMonitor?.(); vi.clearAllTimers?.(); });

  it('a second play does not make the first send a stop', async () => {
    let releaseFirst;
    handy.hsspPlay.mockImplementationOnce(() => new Promise((res) => { releaseFirst = () => res(true); }));
    const first = engine._handlePlaying();      // hangs mid-flight
    const second = engine._handlePlaying();     // lands while the first is in flight
    releaseFirst();
    await Promise.all([first, second]);
    expect(handy.hsspPlay).toHaveBeenCalledTimes(2);
    expect(handy.hsspStop, 'a newer PLAY must not stop the device').not.toHaveBeenCalled();
  });

  it('a pause DOES make an in-flight play undo itself', async () => {
    // The behaviour the guard exists for — x0193143 #292, verified on
    // hardware 2026-08-21.
    let releasePlay;
    handy.hsspPlay.mockImplementationOnce(() => new Promise((res) => { releasePlay = () => res(true); }));
    const playing = engine._handlePlaying();
    await engine._handlePause();
    releasePlay();
    await playing;
    expect(handy.hsspStop.mock.calls.length, 'once for the pause, once for the late play')
      .toBeGreaterThanOrEqual(2);
  });

  it('ended also makes an in-flight play undo itself', async () => {
    let releasePlay;
    handy.hsspPlay.mockImplementationOnce(() => new Promise((res) => { releasePlay = () => res(true); }));
    const playing = engine._handlePlaying();
    await engine._handleEnded();
    releasePlay();
    await playing;
    expect(handy.hsspStop.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('an undisturbed play never stops the device', async () => {
    await engine._handlePlaying();
    expect(handy.hsspPlay).toHaveBeenCalledTimes(1);
    expect(handy.hsspStop).not.toHaveBeenCalled();
  });
});
