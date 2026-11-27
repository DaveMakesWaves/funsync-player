/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// A playlist video resumed at its saved position sends the Handy its first
// play AT that position, never one from the script's start (device session
// 2026-11-20, step 43: hsspPlay(0), then 0.25 s later hsspPlay(<resume ms>);
// harmless on the readback, but the Handy may move toward the start).
//
// The cause: the resume seek waits for the video's length (`loadedmetadata`),
// while playback starts when the cloud-upload gate lifts. With the script
// already on the Handy that "upload" is instant, and with the gap filler on it
// waits for the length too, on `durationchange`, which Chromium fires BEFORE
// `loadedmetadata`, in a task of its own. So the video was played from 0, the
// sync engine anchored the Handy at 0, and the seek followed.
//
// What runs is REAL: app.js's load path (helpers/handy-load-app.js) with its
// real Handy upload and length wait, the REAL HandyManager and the REAL
// SyncEngine, on the fake SDK (helpers/fake-handy-sdk.js). The fake <video>
// starts every load with no length (duration NaN, readyState 0) and gets it
// the way Chromium reports it: readyState up, `durationchange`, then
// `loadedmetadata` and `loadeddata`, each on its own task. Nothing reaches the
// cloud; the key is the fake TESTKEY01.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createFakeHandySdk, attachFakeCloud, deferred } from './helpers/fake-handy-sdk.js';

const h = vi.hoisted(() => ({ sdk: null }));
vi.mock('../../node_modules/@ohdoki/handy-sdk/dist/handy.esm.js', () => ({
  init: () => h.sdk,
  getEstimatedServerTime: () => 0,
  // A cloud upload: a round trip, then the script's URL.
  uploadDataToServer: async () => {
    await new Promise((r) => setTimeout(r, 0));
    return 'https://scripts.local/clip.csv';
  },
}));
vi.mock('../../renderer/js/i18n.js', () => ({ t: (k) => k }));

import { HandyManager } from '../../renderer/js/handy-manager.js';
import { SyncEngine } from '../../renderer/js/sync-engine.js';
import { makeLoadAppClass, buildLoadApp, fileItem } from './helpers/handy-load-app.js';

const CLIP = 'C:\\Lib\\Long Clip.mp4';
const CLIP_FS = 'C:\\Lib\\Long Clip.funscript';
const OTHER = 'C:\\Lib\\Other Clip.mp4';
const SCRIPT = JSON.stringify({ actions: Array.from({ length: 40 }, (_, i) => ({ at: i * 2000, pos: i % 2 ? 90 : 10 })) });
const RESUME_S = 43.9;
const RESUME_MS = 43900;

const macrotask = () => new Promise((r) => setTimeout(r, 0));

let Lifted;
let app;
let video;
let manager;
let engine;
let script;   // what the funscript engine holds
let playedAt; // the video's position at each play() the app made

beforeAll(() => {
  Lifted = makeLoadAppClass({
    extra: ['_uploadAndStartSync', '_whenLocalDurationKnown', '_localDurationPending', '_activatePlayerWindow'],
    deps: { shouldOfferResume: (entry) => !!entry && entry.position > 0 },
  });
});

beforeEach(async () => {
  h.sdk = createFakeHandySdk();
  manager = attachFakeCloud(new HandyManager(), h.sdk);
  await manager.init();
  expect(await manager.connect('TESTKEY01')).toBe(true);
  manager._stopHealthCheck();   // no 10 s poll in a unit test
  // Spacings these tests do not exercise (CI timing: a fixed spacing is real time).
  manager._hsspSpacingMs = 0;
  manager._setScriptSpacingMs = 0;
  ({ app, video } = buildLoadApp(Lifted, {
    handyManager: manager,
    // This window's video, as the real one answers for it.
    _uploadDurationMsFor: () => undefined,
  }));
  globalThis.__liftedFunsync.readFunscript = vi.fn(async (p) => (p === CLIP_FS ? SCRIPT : null));
  script = null;
  app.funscriptEngine = { clear() {}, get isLoaded() { return !!script; }, getRawContent: () => script };
  engine = new SyncEngine({ videoPlayer: app.videoPlayer, handyManager: manager, funscriptEngine: app.funscriptEngine });
  app.syncEngine = engine;
  // A script load runs the app's real Handy upload, as loadFunscript does.
  app.loadFunscript = vi.fn(async (fs) => {
    script = fs.textContent;
    await app._uploadAndStartSync();
  });
  // A playlist: the saved position is CLIP's.
  app._isPlaylistContext = () => true;
  app.getResumeEntry = (p) => (p === CLIP ? { position: RESUME_S } : null);
  // A new source has no length until the browser reads it.
  app.videoPlayer.loadSource.mockImplementation((url) => {
    video.readyState = 0;
    video.swapSource(url);
    video.duration = NaN;
  });
  playedAt = [];
  const play = video.play;
  video.play = vi.fn(() => { playedAt.push(video.currentTime); return play(); });
});

afterEach(() => {
  engine.stop();
  manager._stopHealthCheck();
});

/** Chromium reading the file: data first, then each event on its own task. */
async function browserReadsTheFile({ duration = 120 } = {}) {
  video.duration = duration;
  video.readyState = 4;
  video.fire('durationchange');
  await macrotask();
  video.fire('loadedmetadata');
  await macrotask();
  video.fire('loadeddata');
}

/** Every position the Handy was told to play from, in order. */
const handyPlays = () => h.sdk.sent('hsspPlay').map(([, at]) => at);

/** The Handy already holds this script (the video was watched before, then left). */
async function scriptAlreadyOnTheHandy() {
  expect(await manager.uploadAndSetScript(SCRIPT)).toBe(true);
}

/** The playlist video opened, by Play All or by a click on its card (Resume). */
const OPENERS = {
  'Play All': () => {
    app._playQueue = [{ ...fileItem(CLIP), funscriptPath: CLIP_FS }];
    app._playQueueIndex = -1;
    app._playQueueItem(0);
  },
  'a click on the playlist card (Resume chosen)': () => {
    app._maybeOfferResume = async () => RESUME_S;
    app._playFromLibrary({ ...fileItem(CLIP), _autoPlayOnLoad: true }, { name: 'Long Clip.funscript', textContent: SCRIPT, _funscriptPath: CLIP_FS }, null, []);
  },
};

/** The upload is waiting for the video's length (the gap filler fills to its end). */
const waitingForTheLength = () => vi.waitFor(() => expect(app._localDurationWait).toBeTruthy());

describe('a playlist resume starts the Handy at the resume position (step 43)', () => {
  for (const [opener, open] of Object.entries(OPENERS)) {
    it(`${opener}, the script already on the Handy, gap filler on: the first play is at ${RESUME_MS} ms, none from 0`, async () => {
      await scriptAlreadyOnTheHandy();
      app._fillerOptionsForUpload = () => ({ enabled: true });
      open();
      await waitingForTheLength();

      await browserReadsTheFile();
      await vi.waitFor(() => expect(handyPlays().length).toBeGreaterThan(0));
      // Long enough for a play from 0 to have gone out, as it did.
      for (let i = 0; i < 10; i++) await macrotask();

      expect(handyPlays()[0]).toBe(RESUME_MS);
      expect(handyPlays().filter((at) => at < RESUME_MS)).toEqual([]);
      // The video itself starts there too, not from 0.
      expect(playedAt.length).toBeGreaterThan(0);
      expect(playedAt.every((at) => at === RESUME_S)).toBe(true);
    });
  }

  it('no gap filler: a gate that lifts after the browser has data but before loadedmetadata still waits for the seek', async () => {
    await scriptAlreadyOnTheHandy();
    const read = deferred();
    globalThis.__liftedFunsync.readFunscript = vi.fn(() => read.promise);
    OPENERS['Play All']();
    await vi.waitFor(() => expect(globalThis.__liftedFunsync.readFunscript).toHaveBeenCalled());

    // Chromium has the first frames (readyState 4) and has told the length,
    // but has not dispatched loadedmetadata yet: the script arrives now.
    video.duration = 120;
    video.readyState = 4;
    video.fire('durationchange');
    read.resolve(SCRIPT);
    await vi.waitFor(() => expect(app._waitingForScript).toBe(false));
    for (let i = 0; i < 5; i++) await macrotask();
    expect(handyPlays(), 'nothing plays before the resume seek').toEqual([]);

    video.fire('loadedmetadata');
    await macrotask();
    video.fire('loadeddata');
    await vi.waitFor(() => expect(handyPlays().length).toBeGreaterThan(0));
    expect(handyPlays()[0]).toBe(RESUME_MS);
    expect(handyPlays().filter((at) => at < RESUME_MS)).toEqual([]);
    expect(playedAt.every((at) => at === RESUME_S)).toBe(true);
  });

  it('a script that still uploads (the usual case) plays once, at the resume position (unchanged)', async () => {
    app._fillerOptionsForUpload = () => ({ enabled: true });
    OPENERS['Play All']();
    await waitingForTheLength();
    await browserReadsTheFile();
    await vi.waitFor(() => expect(handyPlays().length).toBeGreaterThan(0));
    for (let i = 0; i < 10; i++) await macrotask();
    expect(h.sdk.sent('setScript').length).toBe(1);
    expect(handyPlays()).toEqual([RESUME_MS]);
    expect(playedAt).toEqual([RESUME_S]);
  });
});

describe('what the change leaves alone', () => {
  it('a normal open with no saved position plays from 0, once', async () => {
    await scriptAlreadyOnTheHandy();
    app._fillerOptionsForUpload = () => ({ enabled: true });
    app.getResumeEntry = () => null;
    OPENERS['Play All']();
    await waitingForTheLength();
    await browserReadsTheFile();
    await vi.waitFor(() => expect(handyPlays().length).toBeGreaterThan(0));
    for (let i = 0; i < 10; i++) await macrotask();
    expect(handyPlays()).toEqual([0]);
    expect(playedAt[0]).toBe(0);
  });

  it('outside a playlist nothing resumes: the library click plays from 0', async () => {
    await scriptAlreadyOnTheHandy();
    app._fillerOptionsForUpload = () => ({ enabled: true });
    app._isPlaylistContext = () => false;
    app._playFromLibrary({ ...fileItem(CLIP), _autoPlayOnLoad: true }, { name: 'Long Clip.funscript', textContent: SCRIPT, _funscriptPath: CLIP_FS }, null, []);
    await waitingForTheLength();
    await browserReadsTheFile();
    await vi.waitFor(() => expect(handyPlays().length).toBeGreaterThan(0));
    for (let i = 0; i < 10; i++) await macrotask();
    expect(handyPlays()).toEqual([0]);
    expect(app._pendingResumeSeek ?? null).toBeNull();
  });

  it('a start held back for the seek dies with its video: the next one opens on its own terms', async () => {
    await scriptAlreadyOnTheHandy();
    app._fillerOptionsForUpload = () => ({ enabled: true });
    OPENERS['Play All']();
    await waitingForTheLength();
    // The length is told and the gate lifts, but Next comes before loadedmetadata.
    video.duration = 120;
    video.readyState = 4;
    video.fire('durationchange');
    await vi.waitFor(() => expect(app._waitingForScript).toBe(false));
    app.loadVideo({ ...fileItem(OTHER) }, { skipViewSwitch: true, autoPlay: false });
    await browserReadsTheFile();
    for (let i = 0; i < 10; i++) await macrotask();
    expect(video.currentTime, 'the old resume position is not applied to the next video').toBe(0);
    expect(video.paused, 'opened paused, as asked').toBe(true);
    expect(handyPlays()).toEqual([]);
  });

  it('the player pop-out still gets the play (the held start is the inline video\'s only)', async () => {
    // The pop-out owns playback: a start goes to it, seek pending or not.
    video.duration = 120;
    app._currentVideoPath = CLIP;
    app._currentVideoName = 'Long Clip.mp4';
    app._activatePlayerWindow();
    expect(app._playerWindowActive).toBe(true);
    video.duration = NaN;
    app._applyPendingResumeSeek(RESUME_S);
    expect(app._pendingResumeSeek).toBeTruthy();
    globalThis.__liftedFunsync.playerPopoutRelay.mockClear();
    app._startPlayback();
    const relayed = globalThis.__liftedFunsync.playerPopoutRelay.mock.calls.map(([, msg]) => msg);
    expect(relayed).toContainEqual({ type: 'set-play-state', paused: false });
    expect(video.play).not.toHaveBeenCalled();
  });
});

// v0.10.1 (Dave, 2026-11-21: "Only Resume plays"): with Autoplay on open OFF
// (the default) a click on the question's Resume button plays the video from
// there; before, it opened at 7:05 paused. The answer comes from the REAL
// question (resume-choice-plays.test.js); here it is given as the question
// gives it, and the REAL load path does the rest: the same held start and
// cloud-upload gate as an autoplay.
describe('Resume plays with Autoplay on open off (v0.10.1)', () => {
  /** A deliberate open of the playlist video, the question answered by `answer`. */
  function openWithAnswer(answer) {
    app._maybeOfferResume = async (_p, _d, out) => {
      if (answer === 'resume') { if (out) out.play = true; return RESUME_S; }
      if (answer === 'start-over') return null;
      return RESUME_S; // dismissed: the position is kept
    };
    app._markCloudUploadsPending = vi.fn(app._markCloudUploadsPending);
    // No _autoPlayOnLoad, and player.autoplayOnOpen is not set: a plain click.
    app._playFromLibrary({ ...fileItem(CLIP) }, { name: 'Long Clip.funscript', textContent: SCRIPT, _funscriptPath: CLIP_FS }, null, []);
  }

  it('Resume clicked: the video and the Handy start at the resume position, behind the upload gate', async () => {
    app._fillerOptionsForUpload = () => ({ enabled: true });
    openWithAnswer('resume');
    await waitingForTheLength();
    await browserReadsTheFile();
    await vi.waitFor(() => expect(handyPlays().length).toBeGreaterThan(0));
    for (let i = 0; i < 10; i++) await macrotask();
    expect(app._markCloudUploadsPending).toHaveBeenCalled();
    expect(handyPlays()).toEqual([RESUME_MS]);
    expect(playedAt).toEqual([RESUME_S]);
  });

  it.each([
    ['Start over', 'start-over', 0],
    ['the question dismissed (Escape, X, backdrop)', 'dismissed', RESUME_S],
  ])('%s: loads paused at the right place, nothing plays (unchanged)', async (_label, answer, at) => {
    app._fillerOptionsForUpload = () => ({ enabled: true });
    openWithAnswer(answer);
    await vi.waitFor(() => expect(app.loadFunscript).toHaveBeenCalled());
    await browserReadsTheFile();
    for (let i = 0; i < 20; i++) await macrotask();
    expect(playedAt).toEqual([]);
    expect(handyPlays()).toEqual([]);
    expect(video.currentTime).toBe(at);
  });
});
