/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The inline player's load-failure handling (app test 2026-11-02, forum #368).
//
//   V07  loadVideo added an 'error' listener to the same <video> on EVERY
//        load and never removed it, each closing over its own `file`. One
//        failure after N loads ran N handlers: N toasts naming the codecs of
//        files opened earlier, N stops sent to every device.
//   V08  a decode failure logged nothing: no MediaError, no codec.
//   V09  an undecodable video track (HEVC 4:4:4) played as audio over black
//        with no error, toast or log.
//   V10  a missing (renamed) file was reported as "Video format not
//        supported", sent to the backend for a remux, and stalled Play All;
//        its armed autoplay listener then played the next video the user
//        opened, even one meant to open paused.
//
// app.js self-instantiates on import, so the REAL methods are lifted out of
// it (as recovery-toast.test.js and relaunch-stop.test.js do) into a class
// and run against a fake <video> (a real EventTarget) and recording fakes.
// What is asserted is what the user and the devices see: toasts, stops,
// remux requests, play() calls and log lines.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import { pathToFileURL } from '../../renderer/js/path-utils.js';
import * as loadCheck from '../../renderer/js/video-load-check.js';
import * as PLAYERWIN from '../../renderer/js/player-popout-protocol.js';
import { RemotePlaybackProxy } from '../../renderer/js/remote-playback-proxy.js';
import * as convert from '../../renderer/js/convert-to-play.js';
import { setPlayerAudioTile } from '../../renderer/js/player-audio-tile.js';

const APP_SRC = fs.readFileSync('renderer/js/app.js', 'utf8');

/**
 * Return the full text of a class method (signature + body) from app.js.
 * Skips strings, template literals and comments while matching braces, so
 * a `{` inside a comment or a string can't end the method early.
 */
function liftMethod(src, name) {
  const re = new RegExp(`^  (?:async )?${name}\\(`, 'm');
  const m = re.exec(src);
  expect(m, `${name}() not found in app.js`).not.toBeNull();
  const start = m.index;
  // End of the parameter list (parameters can hold `{ ... } = {}`).
  let i = src.indexOf('(', start);
  let parens = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') parens++;
    else if (src[i] === ')' && --parens === 0) break;
  }
  i = src.indexOf('{', i);
  let depth = 0;
  const templates = []; // brace depth at which each open `${` resumes its template
  for (; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') { i = src.indexOf('\n', i); continue; }
    if (c === '/' && next === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (c === '\'' || c === '"') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '`' || (c === '}' && templates.length && templates[templates.length - 1] === depth)) {
      if (c === '}') templates.pop();
      // Inside a template literal: run to its end or to the next `${`.
      for (i++; i < src.length; i++) {
        if (src[i] === '\\') { i++; continue; }
        if (src[i] === '`') break;
        if (src[i] === '$' && src[i + 1] === '{') { templates.push(depth); i++; break; }
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const LIFTED = [
  'loadVideo',
  '_ensureVideoLoadWatch',
  '_disarmLoadAutoplay',
  '_stopOutputsForVideoError',
  '_onVideoError',
  '_onCurrentVideoMissing',
  '_onVideoLoadSucceeded',
  '_checkVideoTrackDecodes',
  '_reportUndecodedVideoTrack',
  '_showDecodeErrorWithCodec',
  '_tryRemuxFallback',
  '_applyPendingResumeSeek',
  '_onPlayerWindowMessage', // E-10: the pop-out's TIME_TICK feeds the no-frames check
];

const DEPS = [
  'window', 'document', 'console', 'URL', 'pathToFileURL', 'maybeShowHevcGuidance',
  'isAutoMatch', 'showToast', 't',
  'describeVideoCodec', 'hasRealVideoStream', 'isAudioPath', 'playedSeconds', 'NO_FRAMES_GRACE_SEC',
  'PLAYERWIN',
  'canConvert', 'convertedCopy', 'offerConversion', 'runConversion', 'setPlayerAudioTile',
];

// eslint-disable-next-line no-new-func
const makeLiftedClass = new Function(...DEPS,
  `return class LiftedApp {\n${LIFTED.map((n) => liftMethod(APP_SRC, n)).join('\n\n')}\n};`);

/** A <video> stand-in: a real EventTarget plus the fields the app reads. */
class FakeVideo extends EventTarget {
  constructor() {
    super();
    this.src = '';
    this.error = null;
    this.videoWidth = 0;
    this.duration = NaN;
    this.currentTime = 0;
    this.paused = true;
    this.frames = 0;
    this.playedRanges = [];
    this.play = vi.fn(() => { this.paused = false; return Promise.resolve(); });
  }

  get played() {
    const r = this.playedRanges;
    return { length: r.length, start: (i) => r[i][0], end: (i) => r[i][1] };
  }

  getVideoPlaybackQuality() { return { totalVideoFrames: this.frames }; }

  /** The element reports a MediaError, as Chromium does. */
  fail(code, message = '') {
    this.error = { code, message };
    this.dispatchEvent(new Event('error'));
  }

  fire(type) { this.dispatchEvent(new Event(type)); }
}

const CODECS = {
  'D:\\Lib\\Alpha.mp4': { codec: 'h264', profile: 'High', pixFmt: 'yuv420p', width: 1920 },
  'D:\\Lib\\Beta.mp4': { codec: 'hevc', profile: 'Main', pixFmt: 'yuv420p', width: 1920 },
  'D:\\Lib\\Decode Fail.mp4': { codec: 'h264', profile: 'High 4:4:4 Predictive', pixFmt: 'yuv444p', width: 640 },
  'D:\\Lib\\HEVC 444.mp4': { codec: 'hevc', profile: 'Rext', pixFmt: 'yuv444p', width: 640 },
  'D:\\Lib\\Song.mp4': { duration: 200, format: 'mov,mp4,m4a' },
  'D:\\Lib\\Cover Art.mp4': { codec: 'mjpeg', profile: 'Baseline', pixFmt: 'yuvj420p', width: 600 },
  'D:\\Lib\\Old.mkv': { codec: 'mpeg2video', profile: 'Main', pixFmt: 'yuv420p', width: 720 },
};

let toasts;
let warns;
let api;
let app;
let video;

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
const fileData = (path) => ({ name: path.split('\\').pop(), path, _isPathBased: true });
const toastKeys = () => toasts.map((x) => x.key);

function buildApp(overrides = {}) {
  toasts = [];
  warns = [];
  video = new FakeVideo();
  api = {
    filesExist: vi.fn(async (paths) => paths.map(() => true)),
    fetchMetadata: vi.fn(async (p) => CODECS[p] || null),
    remuxVideo: vi.fn(async () => null),
  };
  const fakeWindow = { funsync: api };
  const fakeDocument = {
    visibilityState: 'visible',
    getElementById: () => ({ hidden: false, innerHTML: '', textContent: '', dataset: {} }),
  };
  const fakeConsole = { log: () => {}, warn: (...args) => warns.push(args), error: () => {} };
  const showToast = (message, type, duration) => {
    toasts.push({ key: message.key, params: message.params, type, duration });
    return { dismiss: () => {} };
  };
  // `t` returns the key and params, so assertions name the exact string.
  const t = (key, params) => ({ key, params, toString: () => key });
  const Lifted = makeLiftedClass(
    fakeWindow, fakeDocument, fakeConsole, URL, pathToFileURL, () => {}, () => false, showToast, t,
    loadCheck.describeVideoCodec, loadCheck.hasRealVideoStream, loadCheck.isAudioPath,
    loadCheck.playedSeconds, loadCheck.NO_FRAMES_GRACE_SEC,
    PLAYERWIN,
    convert.canConvert, convert.convertedCopy, convert.offerConversion, convert.runConversion, setPlayerAudioTile,
  );
  const target = Object.assign(new Lifted(), {
    videoPlayer: {
      video,
      loadSource: vi.fn((url) => { video.src = url; video.error = null; }),
      clearSubtitles: vi.fn(),
    },
    progressBar: {
      clearHeatmap: vi.fn(), setGaps: vi.fn(), setMarkers: vi.fn(), setVideoSource: vi.fn(),
    },
    funscriptEngine: { clear: vi.fn(), isLoaded: true },
    settings: { addRecentFile: vi.fn(), get: () => undefined },
    library: { _lastScanKey: 'scan-1' },
    syncEngine: { stop: vi.fn() },
    handyManager: { connected: true, hsspStop: vi.fn() },
    buttplugManager: { connected: true, stopAll: vi.fn() },
    _pendingFunscripts: [],
    _playQueue: [],
    _playQueueIndex: -1,
    // Methods loadVideo calls that are not under test.
    _maybePushCurrentToHistory: vi.fn(),
    _stopGapSkip: vi.fn(),
    _clearCloudUploadGate: vi.fn(),
    _hideScriptLoadingOverlay: vi.fn(),
    _feedInlineViz: vi.fn(),
    _navigateTo: vi.fn(),
    _updateCategoryDots: vi.fn(),
    _updateQueuePanelState: vi.fn(),
    _applyVRFlattenForCurrent: vi.fn(),
    _showScriptLoadingOverlay: vi.fn(),
    _advanceQueueOnEnded: vi.fn(() => true),
    ...overrides,
  });
  return target;
}

/** Device stops sent since the last reset (the error path's, not loadVideo's). */
function resetStops() {
  app.syncEngine.stop.mockClear();
  app.handyManager.hsspStop.mockClear();
  app.buttplugManager.stopAll.mockClear();
}

beforeEach(() => {
  app = buildApp();
});

describe('V07: one error handler per <video>, reading the CURRENT file', () => {
  it('one failure after several loads gives ONE toast, naming the current file, and one stop', async () => {
    app.loadVideo(fileData('D:\\Lib\\Alpha.mp4'));
    app.loadVideo(fileData('D:\\Lib\\Beta.mp4'));
    app.loadVideo(fileData('D:\\Lib\\Decode Fail.mp4'));
    resetStops();

    video.fail(3, 'PIPELINE_ERROR_DECODE: video decode failed');
    await flush();

    expect(toasts).toHaveLength(1);
    expect(toasts[0].key).toBe('toast.videoErrorDecodeCodec');
    expect(toasts[0].params.codec).toBe('H264 High 4:4:4 Predictive yuv444p');
    // Only the current file was probed: no stale closure asked about Alpha or Beta.
    expect(api.fetchMetadata.mock.calls).toEqual([['D:\\Lib\\Decode Fail.mp4']]);
    // One stop per device, not one per accumulated listener.
    expect(app.handyManager.hsspStop).toHaveBeenCalledTimes(1);
    expect(app.buttplugManager.stopAll).toHaveBeenCalledTimes(1);
    expect(app.syncEngine.stop).toHaveBeenCalledTimes(1);
  });

  it("a failed load's armed autoplay does not play the next video opened paused", async () => {
    // Play All loads with autoPlay; the item fails and never reaches loadeddata.
    app.loadVideo(fileData('D:\\Lib\\Alpha.mp4'), { autoPlay: true });
    video.fail(3, 'PIPELINE_ERROR_DECODE');
    await flush();
    // A single click on a card (player.autoplayOnOpen off) loads paused.
    app.loadVideo(fileData('D:\\Lib\\Beta.mp4'), { autoPlay: false });
    video.fire('loadeddata');
    expect(video.play).not.toHaveBeenCalled();
  });

  it('the newest load owns autoplay even when an earlier one never fired', () => {
    app.loadVideo(fileData('D:\\Lib\\Alpha.mp4'), { autoPlay: true });
    app.loadVideo(fileData('D:\\Lib\\Beta.mp4'), { autoPlay: false });
    video.fire('loadeddata');
    expect(video.play).not.toHaveBeenCalled();
  });

  it('a remux still autoplays: the armed listener survives the remux re-load', async () => {
    api.remuxVideo.mockResolvedValueOnce({ path: 'C:\\Temp\\remux\\Clip.mp4' });
    app.loadVideo(fileData('D:\\Lib\\Clip.mkv'), { autoPlay: true });
    video.fail(4, 'MEDIA_ELEMENT_ERROR: Format error');
    await flush();
    expect(api.remuxVideo).toHaveBeenCalledWith('D:\\Lib\\Clip.mkv');
    expect(app.videoPlayer.loadSource).toHaveBeenLastCalledWith(pathToFileURL('C:\\Temp\\remux\\Clip.mp4'), 'Clip.mkv');
    video.fire('loadeddata');
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(toastKeys()).toEqual(['toast.remuxPreparing']);
  });

  // Test day 2026-11-24, B027: an MPEG-2 .mkv. The backend refuses the remux
  // because of the codec, and the toast said only "Video format not
  // supported". It names the codec now, as a decode failure does.
  it('a remux refused for the codec names the codec, once', async () => {
    api.remuxVideo.mockResolvedValueOnce({ path: null, kind: 'codec' });
    app.loadVideo(fileData('D:\\Lib\\Old.mkv'), { autoPlay: true });
    video.fail(4, 'PipelineStatus::DEMUXER_ERROR_NO_SUPPORTED_STREAMS: FFmpegDemuxer: no supported streams');
    await flush();
    expect(toastKeys()).toEqual(['toast.remuxPreparing', 'toast.videoErrorDecodeCodec']);
    expect(toasts[1].params).toEqual({ codec: 'MPEG2VIDEO Main yuv420p' });
    video.fire('loadeddata');
    expect(video.play).not.toHaveBeenCalled();
  });

  it('a remux that failed for another reason keeps "Video format not supported"', async () => {
    api.remuxVideo.mockResolvedValueOnce(null);
    app.loadVideo(fileData('D:\\Lib\\Old.mkv'));
    video.fail(4, 'MEDIA_ELEMENT_ERROR: Format error');
    await flush();
    expect(toastKeys()).toEqual(['toast.remuxPreparing', 'toast.videoErrorFormat']);
  });

  it('a failed remux reports once and disarms autoplay', async () => {
    app.loadVideo(fileData('D:\\Lib\\Clip.mkv'), { autoPlay: true });
    app.loadVideo(fileData('D:\\Lib\\Other.mkv'), { autoPlay: true });
    video.fail(4, 'MEDIA_ELEMENT_ERROR: Format error');
    await flush();
    expect(api.remuxVideo.mock.calls).toEqual([['D:\\Lib\\Other.mkv']]);
    expect(toastKeys()).toEqual(['toast.remuxPreparing', 'toast.videoErrorFormat']);
    app.loadVideo(fileData('D:\\Lib\\Alpha.mp4'), { autoPlay: false });
    video.fire('loadeddata');
    expect(video.play).not.toHaveBeenCalled();
  });
});

describe('V08: every load failure reaches the log', () => {
  it('logs the MediaError code and message, then the probed codec, at warn', async () => {
    app.loadVideo(fileData('D:\\Lib\\Decode Fail.mp4'));
    video.fail(3, 'PIPELINE_ERROR_DECODE: video decode failed');
    await flush();
    const loadError = warns.find((w) => w[0] === '[Video] load error');
    expect(loadError?.[1]).toEqual({
      code: 3, message: 'PIPELINE_ERROR_DECODE: video decode failed', file: 'D:\\Lib\\Decode Fail.mp4',
    });
    const decode = warns.find((w) => String(w[0]).startsWith('[Video] decode failed'));
    expect(decode).toEqual(['[Video] decode failed:', 'D:\\Lib\\Decode Fail.mp4', 'H264 High 4:4:4 Predictive yuv444p']);
  });

  it('says "codec unknown" when ffprobe has no answer', async () => {
    api.fetchMetadata.mockResolvedValue(null);
    app.loadVideo(fileData('D:\\Lib\\Decode Fail.mp4'));
    video.fail(3, 'PIPELINE_ERROR_DECODE');
    await flush();
    expect(warns.some((w) => w[2] === 'codec unknown')).toBe(true);
    expect(toastKeys()).toEqual(['toast.videoErrorDecode']);
  });

  it('a failed remux logs the original MediaError', async () => {
    app.loadVideo(fileData('D:\\Lib\\Clip.mkv'));
    video.fail(4, 'MEDIA_ELEMENT_ERROR: Format error');
    await flush();
    const line = warns.find((w) => w[0] === '[Remux] fallback failed:');
    expect(line.join(' ')).toContain('MEDIA_ELEMENT_ERROR: Format error');
  });
});

describe('V09: a video track that never decodes is reported', () => {
  it('no picture at loadedmetadata, file has a video stream: names the codec', async () => {
    app.loadVideo(fileData('D:\\Lib\\HEVC 444.mp4'));
    video.videoWidth = 0;
    video.fire('loadedmetadata');
    await flush();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].key).toBe('toast.videoErrorDecodeCodec');
    expect(toasts[0].params.codec).toBe('HEVC Rext yuv444p');
    expect(warns.some((w) => String(w[0]).includes('video track dropped') && w[2] === 'HEVC Rext yuv444p')).toBe(true);
  });

  it('a picture size but no frames after 2 s of playback: reported once', async () => {
    app.loadVideo(fileData('D:\\Lib\\HEVC 444.mp4'));
    video.videoWidth = 640;
    video.fire('loadedmetadata');
    video.frames = 0;
    video.playedRanges = [[0, 1.2]];
    video.fire('timeupdate');
    await flush();
    expect(toasts).toHaveLength(0); // not yet: within the grace period

    video.playedRanges = [[0, 2.4]];
    video.fire('timeupdate');
    video.fire('timeupdate');
    await flush();
    expect(toastKeys()).toEqual(['toast.videoErrorDecodeCodec']);
  });

  it('a resume seek is not playback: 2 s of PLAYED time, not currentTime', async () => {
    app.loadVideo(fileData('D:\\Lib\\HEVC 444.mp4'));
    video.videoWidth = 640;
    video.playedRanges = [[600, 600.5]];
    video.fire('timeupdate');
    await flush();
    expect(toasts).toHaveLength(0);
  });

  it('frames decoding: nothing reported', async () => {
    app.loadVideo(fileData('D:\\Lib\\Alpha.mp4'));
    video.videoWidth = 1920;
    video.fire('loadedmetadata');
    video.frames = 48;
    video.playedRanges = [[0, 3]];
    video.fire('timeupdate');
    await flush();
    expect(toasts).toHaveLength(0);
    expect(api.fetchMetadata).not.toHaveBeenCalled();
  });

  it('an audio-only file, or one whose only "video" is cover art, is left alone', async () => {
    for (const path of ['D:\\Lib\\Song.mp4', 'D:\\Lib\\Cover Art.mp4']) {
      app.loadVideo(fileData(path));
      video.videoWidth = 0;
      video.fire('loadedmetadata');
      await flush();
    }
    expect(toasts).toHaveLength(0);
  });

  it('an audio container is not even probed', async () => {
    app.loadVideo(fileData('D:\\Lib\\Track.mp3'));
    video.fire('loadedmetadata');
    await flush();
    expect(api.fetchMetadata).not.toHaveBeenCalled();
    expect(toasts).toHaveLength(0);
  });

  it('a probe that cannot answer is logged, not shown as a broken video', async () => {
    api.fetchMetadata.mockResolvedValue(null);
    app.loadVideo(fileData('D:\\Lib\\HEVC 444.mp4'));
    video.fire('loadedmetadata');
    await flush();
    expect(toasts).toHaveLength(0);
    expect(warns.some((w) => String(w[0]).includes('could not be probed'))).toBe(true);
  });

  it('a result for a video the user already left is dropped', async () => {
    let answer;
    api.fetchMetadata.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
    app.loadVideo(fileData('D:\\Lib\\HEVC 444.mp4'));
    video.fire('loadedmetadata');
    app.loadVideo(fileData('D:\\Lib\\Alpha.mp4'));
    answer(CODECS['D:\\Lib\\HEVC 444.mp4']);
    await flush();
    expect(toasts).toHaveLength(0);
  });

  it('informs only: playback and devices carry on', async () => {
    app.loadVideo(fileData('D:\\Lib\\HEVC 444.mp4'));
    resetStops();
    video.fire('loadedmetadata');
    await flush();
    expect(toasts).toHaveLength(1);
    expect(app.handyManager.hsspStop).not.toHaveBeenCalled();
    expect(app.syncEngine.stop).not.toHaveBeenCalled();
  });
});

// E-10 (found while FT-076, also in v0.9.2): with the player popped out,
// the no-frames check returned at once (the inline copy is paused and hidden
// then), so a track with a picture size and no decodable frames played black
// in the player window with no message. The window's TIME_TICK now carries
// its own <video>'s decoded-frame count, played seconds and visibility, and
// the same check judges those.
describe('E-10: the no-frames check covers the player window', () => {
  /** The player window owns playback (its take-over ran), on `path`. */
  function popOut(path) {
    app.loadVideo(fileData(path));
    video.videoWidth = 640; // the inline copy has the size
    video.fire('loadedmetadata');
    app._playerWinProxy = new RemotePlaybackProxy();
    app._playerWinProxy.updateState({ at: 0, paused: false, duration: 60 });
    app._playerWindowActive = true;
  }
  /** A TIME_TICK from the window, as player-popout.js sends it. */
  const tick = (fields) => app._onPlayerWindowMessage(PLAYERWIN.makeMessage(PLAYERWIN.TIME_TICK, {
    timeMs: 1000, paused: false, rate: 1, loop: false, ...fields,
  }));

  it('no frames after 2 s of playback in the window: reported once, naming the codec', async () => {
    popOut('D:\\Lib\\HEVC 444.mp4');
    tick({ frames: 0, playedSec: 1.2, hidden: false });
    await flush();
    expect(toasts).toHaveLength(0); // within the grace period
    tick({ frames: 0, playedSec: 2.4, hidden: false });
    tick({ frames: 0, playedSec: 2.5, hidden: false });
    await flush();
    expect(toastKeys()).toEqual(['toast.videoErrorDecodeCodec']);
    expect(toasts[0].params.codec).toBe('HEVC Rext yuv444p');
  });

  it('the window decodes frames: nothing reported, nothing probed', async () => {
    popOut('D:\\Lib\\Alpha.mp4');
    tick({ frames: 60, playedSec: 3, hidden: false });
    await flush();
    expect(toasts).toHaveLength(0);
    expect(api.fetchMetadata).not.toHaveBeenCalled();
  });

  it('a minimised (hidden) window is not judged', async () => {
    popOut('D:\\Lib\\HEVC 444.mp4');
    tick({ frames: 0, playedSec: 5, hidden: true });
    await flush();
    expect(toasts).toHaveLength(0);
  });

  it('the hidden inline copy still says nothing while the window plays', async () => {
    popOut('D:\\Lib\\HEVC 444.mp4');
    video.frames = 0;
    video.playedRanges = [[0, 5]];
    video.fire('timeupdate');
    await flush();
    expect(toasts).toHaveLength(0);
  });

  it('informs only: playback and devices carry on', async () => {
    popOut('D:\\Lib\\HEVC 444.mp4');
    resetStops();
    tick({ frames: 0, playedSec: 3, hidden: false });
    await flush();
    expect(toasts).toHaveLength(1);
    expect(app.handyManager.hsspStop).not.toHaveBeenCalled();
    expect(app.syncEngine.stop).not.toHaveBeenCalled();
  });
});

describe('V10: a missing file is reported as missing, not as a format problem', () => {
  const MISSING = 'D:\\Lib\\Bravo Duplicate.mp4';

  beforeEach(() => {
    api.filesExist.mockImplementation(async (paths) => paths.map((p) => p !== MISSING));
  });

  it('says it cannot find the file, names it, and does not remux', async () => {
    app.loadVideo(fileData(MISSING));
    video.fail(4, 'MEDIA_ELEMENT_ERROR: Format error');
    await flush();
    expect(toastKeys()).toEqual(['toast.videoFileMissing']);
    expect(toasts[0].params).toEqual({ name: 'Bravo Duplicate.mp4' });
    expect(api.remuxVideo).not.toHaveBeenCalled();
    expect(app.library._lastScanKey).toBeNull();
    expect(warns.some((w) => String(w[0]).includes('file not found') && w[1] === MISSING)).toBe(true);
  });

  it('a missing file does not leave its autoplay armed', async () => {
    app.loadVideo(fileData(MISSING), { autoPlay: true });
    video.fail(4, 'MEDIA_ELEMENT_ERROR: Format error');
    await flush();
    app.loadVideo(fileData('D:\\Lib\\Zulu Last.mp4'), { autoPlay: false });
    video.fire('loadeddata');
    expect(video.play).not.toHaveBeenCalled();
  });

  it('a Play All queue moves on to the next item instead of stalling', async () => {
    app._playQueue = [{ path: 'D:\\Lib\\Alpha.mp4' }, { path: MISSING }, { path: 'D:\\Lib\\Charlie.mp4' }];
    app._playQueueIndex = 1;
    app.loadVideo(fileData(MISSING), { autoPlay: true });
    video.fail(4, 'MEDIA_ELEMENT_ERROR: Format error');
    await flush();
    expect(app._advanceQueueOnEnded).toHaveBeenCalledTimes(1);
  });

  it('a queue with nothing left to play stops after one pass, with one toast each', async () => {
    const other = 'D:\\Lib\\Also Gone.mp4';
    api.filesExist.mockImplementation(async (paths) => paths.map(() => false));
    app._playQueue = [{ path: MISSING }, { path: other }];
    app._playQueueIndex = 0;
    app._advanceQueueOnEnded.mockImplementation(() => {
      // Looping queue: wrap, like the real _advanceQueueOnEnded.
      app._playQueueIndex = (app._playQueueIndex + 1) % app._playQueue.length;
      app.loadVideo(fileData(app._playQueue[app._playQueueIndex].path), { autoPlay: true });
      return true;
    });
    app.loadVideo(fileData(MISSING), { autoPlay: true });
    video.fail(4, 'MEDIA_ELEMENT_ERROR: Format error');
    await flush();
    video.fail(4, 'MEDIA_ELEMENT_ERROR: Format error');
    await flush();
    expect(app._advanceQueueOnEnded).toHaveBeenCalledTimes(1);
    expect(toastKeys()).toEqual(['toast.videoFileMissing', 'toast.playlistAllUnavailable']);
  });

  it('after skipping several, the next playable video says how many were skipped', async () => {
    const gone2 = 'D:\\Lib\\Gone Too.mp4';
    api.filesExist.mockImplementation(async (paths) => paths.map((p) => p !== MISSING && p !== gone2));
    app._playQueue = [{ path: MISSING }, { path: gone2 }, { path: 'D:\\Lib\\Charlie.mp4' }];
    app._playQueueIndex = 0;
    app._advanceQueueOnEnded.mockImplementation(() => {
      app._playQueueIndex += 1;
      app.loadVideo(fileData(app._playQueue[app._playQueueIndex].path), { autoPlay: true });
      return true;
    });
    app.loadVideo(fileData(MISSING), { autoPlay: true });
    video.fail(4, 'MEDIA_ELEMENT_ERROR: Format error');
    await flush();
    video.fail(4, 'MEDIA_ELEMENT_ERROR: Format error');
    await flush();
    video.fire('loadeddata'); // Charlie plays
    expect(toastKeys()).toEqual(['toast.videoFileMissing', 'toast.playlistSkippedUnavailable']);
    expect(toasts[1].params).toEqual({ count: 2 });
    expect(video.play).toHaveBeenCalledTimes(1);
  });

  it("a missing item's resume seek does not move the next video", async () => {
    // Resume positions are keyed by path and never pruned, so a renamed
    // file's old path can still carry one. _playQueueItem arms the seek right
    // after loadVideo; it waits for loadedmetadata, which a missing file
    // never reaches.
    app._playQueue = [{ path: MISSING }, { path: 'D:\\Lib\\Charlie.mp4' }];
    app._playQueueIndex = 0;
    app._advanceQueueOnEnded.mockImplementation(() => {
      app._playQueueIndex = 1;
      app.loadVideo(fileData('D:\\Lib\\Charlie.mp4'), { autoPlay: true });
      return true;
    });
    app.loadVideo(fileData(MISSING), { autoPlay: true });
    app._applyPendingResumeSeek(300);
    video.fail(4, 'MEDIA_ELEMENT_ERROR: Format error');
    await flush();
    video.duration = 600;
    video.fire('loadedmetadata'); // Charlie
    expect(video.currentTime).toBe(0);
  });

  it("the current video's own resume seek still applies", () => {
    app.loadVideo(fileData('D:\\Lib\\Charlie.mp4'));
    app._applyPendingResumeSeek(120);
    video.duration = 600;
    video.fire('loadedmetadata');
    expect(video.currentTime).toBe(120);
  });

  it('outside a queue there is nothing to advance', async () => {
    app.loadVideo(fileData(MISSING));
    video.fail(4, 'MEDIA_ELEMENT_ERROR: Format error');
    await flush();
    expect(app._advanceQueueOnEnded).not.toHaveBeenCalled();
  });

  it('an existence probe that cannot answer keeps the old path (remux attempt)', async () => {
    api.filesExist.mockResolvedValue([null]);
    app.loadVideo(fileData('D:\\Lib\\Clip.mkv'));
    video.fail(4, 'MEDIA_ELEMENT_ERROR: Format error');
    await flush();
    expect(api.remuxVideo).toHaveBeenCalledTimes(1);
    expect(toastKeys()).not.toContain('toast.videoFileMissing');
  });

  it('a mid-playback disconnect stops the devices BEFORE the existence probe answers', async () => {
    let answer;
    api.filesExist.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
    app.loadVideo(fileData(MISSING));
    resetStops();
    video.fail(2, 'PIPELINE_ERROR_READ');
    expect(app.handyManager.hsspStop).toHaveBeenCalledTimes(1);
    answer([false]);
    await flush();
    expect(app.handyManager.hsspStop).toHaveBeenCalledTimes(1);
    expect(toastKeys()).toEqual(['toast.videoFileMissing']);
  });

  it('the new string exists in English', () => {
    const en = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
    expect(en.toast.videoFileMissing).toMatch(/\{name\}/);
  });
});
