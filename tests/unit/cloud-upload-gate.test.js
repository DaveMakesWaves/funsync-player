/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// FT-112 (also in v0.9.2): autoplay and Play All never waited for the cloud
// script upload. The gate was marked BEFORE loadVideo, and loadVideo clears
// any earlier gate, so by `loadeddata` nothing was waiting and the video ran
// ahead of a Handy / Autoblow that had no script yet: the first strokes out
// of sync. Now marked right after loadVideo.
//
// Making the gate real means every load that marks it has to release it
// when no upload will come, or autoplay sits out the 8 s fallback and its
// "upload timed out" toast: a Handy on a custom route (its own script,
// uploaded by _loadCustomRouting), a Play All item whose script cannot be
// read, a script that fails to load.
//
// The REAL app.js load path (helpers/handy-load-app.js) on a fake <video>;
// the cloud devices are fakes with the surface loadVideo and the gate read
// (`connected`, `hsspMayBeRunning`, `hsspStop`). Assertions are on whether,
// and when, the video plays, and on what the pop-out is told.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import * as PLAYERWIN from '../../renderer/js/player-popout-protocol.js';
import { makeLoadAppClass, buildLoadApp, fileItem } from './helpers/handy-load-app.js';

const SCRIPT = JSON.stringify({ actions: [{ at: 0, pos: 10 }, { at: 600, pos: 90 }] });
const A = 'C:\\Lib\\Alpha.mp4';
const B = 'C:\\Lib\\Bravo.mp4';

let Lifted;
let app;
let video;
let relayed;
let toasts;
const tick = () => new Promise((r) => setTimeout(r, 0));
let playings;   // () => 'playing' events: the video really started, however often play() was asked

beforeAll(() => {
  Lifted = makeLoadAppClass({ extra: ['loadFunscript', '_isDeviceOnMainRoute', '_uploadAndStartSync', '_tryStartAutoblowSync'] });
});

beforeEach(() => {
  ({ app, video, relayed, toasts } = buildLoadApp(Lifted, {
    // The real HandyManager's surface that loadVideo and the gate read: a
    // connected Handy last told to stop (nothing playing before the click).
    handyManager: { connected: true, hsspMayBeRunning: false, hsspStop: vi.fn(async () => true) },
    autoblowManager: { connected: false },
  }));
  // Counted on THIS test's video: an earlier test's element may still fire
  // a queued 'playing' after its test ended.
  const seen = { n: 0 };
  video.addEventListener('playing', () => { seen.n++; });
  playings = () => seen.n;
});

afterEach(() => {
  vi.useRealTimers();
});

const clickWithAutoplay = (path = A) => {
  app._settingsMap.set('player.autoplayOnOpen', true);
  return app._playFromLibrary(fileItem(path), { name: 'a.funscript', textContent: SCRIPT }, null, []);
};

describe('a library click with player.autoplayOnOpen', () => {
  it('waits for the Handy upload: loadeddata does not play, the upload finishing does', async () => {
    await clickWithAutoplay();
    expect(app._waitingForScript).toBe(true);

    video.fire('loadeddata');
    expect(video.play).not.toHaveBeenCalled();

    app._resolveCloudUpload('handy');
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(app._waitingForScript).toBe(false);
  });

  it('waits for EVERY connected cloud device', async () => {
    app.autoblowManager.connected = true;
    await clickWithAutoplay();
    video.fire('loadeddata');

    app._resolveCloudUpload('handy');
    expect(video.play).not.toHaveBeenCalled();
    app._resolveCloudUpload('autoblow');
    expect(video.play).toHaveBeenCalledTimes(1);
  });

  it('an upload that beats loadeddata opens the gate: the video plays, once', async () => {
    await clickWithAutoplay();
    app._resolveCloudUpload('handy');   // play() on a loading element starts it when it can
    video.fire('loadeddata');
    await tick();   // the element fires 'playing' on a later task
    expect(video.paused).toBe(false);
    expect(playings()).toBe(1);
    expect(app._waitingForScript).toBe(false);
  });

  it('a stalled upload still plays after the 8 s fallback, with the timeout toast', async () => {
    vi.useFakeTimers();
    await clickWithAutoplay();
    video.fire('loadeddata');
    vi.advanceTimersByTime(7900);
    expect(video.play).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(toasts().map((x) => x.key)).toContain('toast.handyUploadTimeout');
  });

  it('with no cloud device connected nothing waits', async () => {
    app.handyManager.connected = false;
    await clickWithAutoplay();
    video.fire('loadeddata');
    expect(video.play).toHaveBeenCalledTimes(1);
  });

  it('a plain click (autoplayOnOpen off) is not gated and does not play', async () => {
    await app._playFromLibrary(fileItem(A), { name: 'a.funscript', textContent: SCRIPT }, null, []);
    expect(app._waitingForScript).toBe(false);
    video.fire('loadeddata');
    expect(video.play).not.toHaveBeenCalled();
  });
});

describe('a Play All advance', () => {
  beforeEach(() => {
    app._playQueue = [
      { ...fileItem(A), funscriptPath: 'C:\\Lib\\Alpha.funscript' },
      { ...fileItem(B), funscriptPath: 'C:\\Lib\\Bravo.funscript' },
    ];
    app._playQueueIndex = 0;
    globalThis.__liftedFunsync.readFunscript = vi.fn(async () => SCRIPT);
  });

  it('waits for the upload before playing the next item', async () => {
    app._playQueueItem(1);
    expect(app._waitingForScript).toBe(true);
    await vi.waitFor(() => expect(app.loadFunscript).toHaveBeenCalled());

    video.fire('loadeddata');
    expect(video.play).not.toHaveBeenCalled();

    app._resolveCloudUpload('handy');
    expect(video.play).toHaveBeenCalledTimes(1);
  });

  it('an item whose script cannot be read plays at once, not after 8 s', async () => {
    globalThis.__liftedFunsync.readFunscript = vi.fn(async () => null);
    app._playQueueItem(1);
    await vi.waitFor(() => expect(app._waitingForScript).toBe(false));

    video.fire('loadeddata');
    await tick();   // the element fires 'playing' on a later task
    expect(video.paused).toBe(false);
    expect(playings()).toBe(1);
    expect(app.loadFunscript).not.toHaveBeenCalled();
  });
});

describe('the player pop-out is held the same way', () => {
  it('a library click with autoplay loads the pop-out paused, and the upload finishing plays it', async () => {
    app._playerWindowActive = true;
    app._settingsMap.set('player.autoplayOnOpen', true);
    await app._playFromLibrary(fileItem(B), { name: 'b.funscript', textContent: SCRIPT }, null, []);

    const loads = relayed.filter((m) => m.type === PLAYERWIN.LOAD_VIDEO);
    expect(loads.at(-1)).toMatchObject({ autoplay: false });
    expect(video.play).not.toHaveBeenCalled();   // never the hidden inline copy

    const before = relayed.length;
    app._resolveCloudUpload('handy');
    expect(relayed.slice(before)).toContainEqual({ type: PLAYERWIN.SET_PLAY_STATE, paused: false });
    expect(video.play).not.toHaveBeenCalled();
  });
});

describe('loads that upload nothing release the gate (the REAL loadFunscript)', () => {
  beforeEach(() => {
    app.loadFunscript = Lifted.prototype.loadFunscript;
    Object.assign(app, {
      _currentVideoName: 'Alpha.mp4',
      funscriptEngine: {
        clear() {}, isLoaded: true,
        loadContent: vi.fn(async () => ({ actionCount: 2 })),
        getActions: () => [], getChapters: () => [], getBookmarks: () => [], getRawContent: () => SCRIPT,
      },
      _feedEmbeddedMultiAxis() {},
      _showFunscriptBadge() {},
      _refreshEditorScriptList() {},
      _tryStartButtplugSync() {},
      _tryStartTCodeSync() {},
      _startGapSkip() {},
      _uploadAndStartSync: vi.fn(async () => {}),
      _tryStartAutoblowSync: vi.fn(async () => {}),
    });
  });

  it('a Handy on a custom route (not main) does not hold autoplay', async () => {
    // Main goes to a Buttplug device; the Handy plays a route script that
    // _loadCustomRouting has already uploaded and set.
    const routes = [
      { role: 'main', deviceId: 'buttplug:0:Toy', scriptPath: 'C:\\Lib\\Alpha.funscript' },
      { role: 'route', deviceId: 'handy', scriptPath: 'C:\\Lib\\Alpha.twist.funscript' },
    ];
    app._loadCustomRouting = vi.fn(async (r) => { app._currentCustomRoutes = r; });
    app._settingsMap.set('player.autoplayOnOpen', true);
    await app._playFromLibrary(fileItem(A), { name: 'a.funscript', textContent: SCRIPT, _customRouting: routes }, null, []);
    await vi.waitFor(() => expect(app._waitingForScript).toBe(false));

    expect(app._uploadAndStartSync).not.toHaveBeenCalled();
    video.fire('loadeddata');
    await tick();   // the element fires 'playing' on a later task
    expect(video.paused).toBe(false);
    expect(playings()).toBe(1);
    expect(toasts().map((x) => x.key)).not.toContain('toast.handyUploadTimeout');
  });

  it('a script that fails to load does not hold autoplay', async () => {
    app.funscriptEngine.loadContent = vi.fn(async () => { throw new Error('backend busy'); });
    await clickWithAutoplay();
    await vi.waitFor(() => expect(app._waitingForScript).toBe(false));

    video.fire('loadeddata');
    await tick();   // the element fires 'playing' on a later task
    expect(video.paused).toBe(false);
    expect(playings()).toBe(1);
  });

  it('the main Handy upload holds it until it lands (the REAL _uploadAndStartSync)', async () => {
    let finish;
    app._uploadAndStartSync = Lifted.prototype._uploadAndStartSync;
    app.handyManager.uploadAndSetScript = vi.fn(() => new Promise((r) => { finish = r; }));
    app.syncEngine = { _active: false, _scriptReady: false, stop() {}, start: vi.fn(), player: app.videoPlayer };
    await clickWithAutoplay();
    await vi.waitFor(() => expect(app.handyManager.uploadAndSetScript).toHaveBeenCalled());

    video.fire('loadeddata');
    expect(video.play).not.toHaveBeenCalled();
    finish(true);
    await vi.waitFor(() => expect(video.play).toHaveBeenCalledTimes(1));
    expect(app.syncEngine.start).toHaveBeenCalled();
  });
});
