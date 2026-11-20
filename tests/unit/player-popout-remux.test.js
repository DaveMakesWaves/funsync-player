/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// FT-076 (block D real-app check, verify-1, 2026-11-07; also in v0.9.2): with
// the player popped out, a file whose container Chromium cannot open (an
// H.264 .avi in the sandbox) never played. Main remuxed it and loaded the
// playable copy into the HIDDEN inline <video> only, logged "[Remux] playing
// remuxed copy" as a success, and the pop-out kept the original: black at
// 0:00 / 0:00, Space did nothing, no toast anywhere.
//
// The REAL app.js methods run against a fake inline <video> (a real
// EventTarget) and a recording relay; what is asserted is what reaches the
// player window: the LOAD_VIDEO messages, their src and their autoplay.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { liftAppClass } from './helpers/app-methods.js';
import { pathToFileURL } from '../../renderer/js/path-utils.js';
import * as PLAYERWIN from '../../renderer/js/player-popout-protocol.js';

const ORIGINAL = 'C:\\Sandbox\\library\\AVI H264.avi';
const REMUXED = 'C:\\Temp\\funsync_remux\\fc4c5b6bef7a.mp4';

class FakeVideo extends EventTarget {
  constructor() {
    super();
    this.src = '';
    this.error = null;
    this.currentTime = 0;
    this.paused = true;
    this.duration = 60;
    this.play = vi.fn(() => { this.paused = false; return Promise.resolve(); });
    this.pause = vi.fn(() => { this.paused = true; });
  }

  fail(code, message = '') {
    this.error = { code, message };
    this.dispatchEvent(new Event('error'));
  }
}

let relayed;
let toasts;
let api;
let video;
let app;

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
const loads = () => relayed.filter((m) => m.type === PLAYERWIN.LOAD_VIDEO);

function build({ popout = true, waitingForScript = false } = {}) {
  relayed = [];
  toasts = [];
  video = new FakeVideo();
  api = {
    filesExist: vi.fn(async (paths) => paths.map(() => true)),
    remuxVideo: vi.fn(async () => ({ path: REMUXED })),
    playerPopoutRelay: vi.fn((dir, payload) => { if (dir === 'to-popout') relayed.push(payload); }),
    playerPopoutReveal: vi.fn(),
  };
  const Lifted = liftAppClass([
    '_onVideoError', '_tryRemuxFallback', '_disarmLoadAutoplay', '_stopOutputsForVideoError',
    '_onCurrentVideoMissing', '_currentPopoutVideo', '_sendLoadVideoToPopout',
    '_routeLoadedVideoToPlayerWindow',
  ], {
    window: { funsync: api },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    pathToFileURL,
    PLAYERWIN,
    showToast: (message, type) => { toasts.push({ key: String(message), type }); return { dismiss: () => {} }; },
    t: (key) => key,
  });
  const target = Object.assign(new Lifted(), {
    videoPlayer: {
      video,
      loadSource: vi.fn((url) => { video.src = url; video.error = null; }),
    },
    progressBar: { setVideoSource: vi.fn() },
    library: { _lastScanKey: 'scan-1' },
    _currentVideoPath: ORIGINAL,
    _currentVideoName: 'AVI H264.avi',
    _currentIsRemote: false,
    _videoLoadGen: 1,
    _remuxAttemptedForPath: null,
    _remuxedCopy: null,
    _playerWindowActive: popout,
    _waitingForScript: waitingForScript,
    _autoAdvancing: false,
    _activatePlayerWindow: vi.fn(),
    _showScriptLoadingOverlay: vi.fn(),
    _streamPlayerWindowData: vi.fn(),
    _navigateTo: vi.fn(),
  });
  video.src = pathToFileURL(ORIGINAL);
  video.addEventListener('error', () => { target._onVideoError(); });
  return target;
}

describe('FT-076: a remuxed container reaches the player window', () => {
  beforeEach(() => { app = build(); });

  it('the pop-out is sent the remuxed copy, with the autoplay it was first sent', async () => {
    await app._routeLoadedVideoToPlayerWindow(true);
    expect(loads()).toHaveLength(1);
    expect(loads()[0].src).toBe(pathToFileURL(ORIGINAL));

    video.fail(4, 'MEDIA_ELEMENT_ERROR: Format error');
    await flush();

    expect(api.remuxVideo).toHaveBeenCalledWith(ORIGINAL);
    expect(loads()).toHaveLength(2);
    expect(loads()[1]).toMatchObject({ src: pathToFileURL(REMUXED), autoplay: true, timeMs: 0 });
    // Nothing failed, so nothing to say.
    expect(toasts.map((x) => x.key)).toEqual(['toast.remuxPreparing']);
  });

  it('a click that loads paused (autoplayOnOpen off) stays paused on the copy', async () => {
    await app._routeLoadedVideoToPlayerWindow(false);
    video.fail(4);
    await flush();
    expect(loads()[1]).toMatchObject({ src: pathToFileURL(REMUXED), autoplay: false });
  });

  it('a load gated on a cloud upload that has since finished plays the copy', async () => {
    app = build({ waitingForScript: true });
    await app._routeLoadedVideoToPlayerWindow(true);
    expect(loads()[0].autoplay).toBe(false); // gated: the upload starts it
    // The upload finished while the remux ran: its play went to the broken original.
    app._waitingForScript = false;
    video.fail(4);
    await flush();
    expect(loads()[1]).toMatchObject({ src: pathToFileURL(REMUXED), autoplay: true });
  });

  it('a load still gated when the copy is ready waits for the upload', async () => {
    app = build({ waitingForScript: true });
    await app._routeLoadedVideoToPlayerWindow(true);
    video.fail(4);
    await flush();
    expect(loads()[1]).toMatchObject({ src: pathToFileURL(REMUXED), autoplay: false });
  });

  it('popping out a video already playing from its remuxed copy sends the copy', async () => {
    app = build({ popout: false });
    video.fail(4);
    await flush();
    expect(app.videoPlayer.loadSource).toHaveBeenLastCalledWith(pathToFileURL(REMUXED), 'AVI H264.avi');
    expect(loads()).toHaveLength(0); // docked: nothing goes to a player window

    // The take-over's first send (player window opened over the inline copy).
    app._playerWindowActive = true;
    app._sendLoadVideoToPopout(true);
    expect(loads()).toHaveLength(1);
    expect(loads()[0].src).toBe(pathToFileURL(REMUXED));
  });

  it('a remux that lands after another video was opened sends nothing', async () => {
    await app._routeLoadedVideoToPlayerWindow(true);
    let finish;
    api.remuxVideo.mockImplementationOnce(() => new Promise((r) => { finish = r; }));
    video.fail(4);
    await flush();
    app._currentVideoPath = 'C:\\Sandbox\\library\\Zulu Last.mp4';
    finish({ path: REMUXED });
    await flush();
    expect(loads()).toHaveLength(1);
  });
});
