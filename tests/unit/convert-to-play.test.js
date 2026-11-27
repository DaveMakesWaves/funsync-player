/**
 * @vitest-environment jsdom
 * jsdom: the offer and progress toasts are DOM; i18n is not used (t records
 * keys). See notes/CLAUDE.md "Test environments".
 */
// Convert to play (Dave, 2026-11-26). His Downloads\2.5.4_variant1.mp4 is
// MPEG-4 Part 2: Windows plays it, the player (Chromium) cannot decode it,
// so it played sound over black with "isn't supported on this system". Now
// the player offers to convert it to H.264, shows the progress with Cancel,
// and plays the copy from where it was; the copy is kept and used at once
// the next time, without asking.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as convert from '../../renderer/js/convert-to-play.js';
import { liftAppClass } from './helpers/app-methods.js';
import { pathToFileURL } from '../../renderer/js/path-utils.js';

const SRC = 'C:\\Users\\user\\Downloads\\2.5.4_variant1.mp4';
const COPY = 'C:\\Temp\\funsync_remux\\ab12.h264.mp4';

let toasts;
const t = (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key);
function showToast(message, type, duration) {
  const entry = { message, type, duration, dismissed: false };
  entry.text = typeof message === 'string' ? message : message.textContent;
  entry.dismiss = () => { entry.dismissed = true; };
  toasts.push(entry);
  return entry;
}
const button = (toast, cls) => toast.message.querySelector(`.${cls}`);
const noSleep = () => Promise.resolve();

beforeEach(() => { toasts = []; document.body.innerHTML = ''; });

/** A bridge whose conversion runs through the given status answers. */
function bridge({ start = { job: 'j1', state: 'running', progress: 0 }, statuses = [], cached = null } = {}) {
  const queue = statuses.slice();
  return {
    transcodeVideo: vi.fn(async (_p, opts) => (opts?.cachedOnly
      ? (cached ? { state: 'done', path: cached } : { state: 'none' })
      : start)),
    transcodeStatus: vi.fn(async () => queue.length > 1 ? queue.shift() : queue[0]),
    transcodeCancel: vi.fn(async () => ({ state: 'running' })),
  };
}

describe('canConvert / convertedCopy', () => {
  it('a local file with a bridge that converts; never a saved stream or a page address', () => {
    const b = bridge();
    expect(convert.canConvert(SRC, b)).toBe(true);
    expect(convert.canConvert('/home/u/v.avi', b)).toBe(true);
    expect(convert.canConvert('\\\\nas\\share\\v.avi', b)).toBe(true);
    expect(convert.canConvert('stream:example.com/x', b)).toBe(false);
    expect(convert.canConvert('https://example.com/v.mp4', b)).toBe(false);
    expect(convert.canConvert(SRC, {})).toBe(false);
  });
  it('the copy made before, asked without starting anything', async () => {
    const b = bridge({ cached: COPY });
    expect(await convert.convertedCopy(SRC, b)).toBe(COPY);
    expect(b.transcodeVideo).toHaveBeenCalledWith(SRC, { cachedOnly: true });
    expect(await convert.convertedCopy(SRC, bridge())).toBe(null);
  });
});

describe('runConversion', () => {
  it('shows the progress, then hands over the copy', async () => {
    const b = bridge({ statuses: [
      { state: 'running', progress: 0.25 }, { state: 'running', progress: 0.5 }, { state: 'done', path: COPY, progress: 1 },
    ] });
    const seen = [];
    const onDone = vi.fn();
    const sleep = () => { if (toasts[0]) seen.push(toasts[0].message.textContent); return Promise.resolve(); };
    expect(await convert.runConversion({ path: SRC, bridge: b, t, showToast, onDone, sleep })).toBe('done');
    expect(onDone).toHaveBeenCalledWith(COPY);
    expect(seen.join('|')).toContain('player.convert.progress {"pct":25}');
    expect(seen.join('|')).toContain('player.convert.progress {"pct":50}');
    expect(toasts[0].dismissed).toBe(true);
    expect(toasts[0].duration).toBe(0); // stays while it runs
  });

  it('Cancel asks the backend to stop; "stopped, nothing kept"', async () => {
    const b = bridge({ statuses: [{ state: 'running', progress: 0.1 }, { state: 'cancelled' }] });
    let clicked = false;
    const sleep = () => {
      if (!clicked && toasts[0]) { clicked = true; button(toasts[0], 'convert-toast__cancel').click(); }
      return Promise.resolve();
    };
    const onDone = vi.fn();
    expect(await convert.runConversion({ path: SRC, bridge: b, t, showToast, onDone, sleep })).toBe('cancelled');
    expect(b.transcodeCancel).toHaveBeenCalledWith('j1');
    expect(onDone).not.toHaveBeenCalled();
    expect(toasts.at(-1).text).toBe('player.convert.cancelled');
  });

  it('ffmpeg failing: says why', async () => {
    const b = bridge({ statuses: [{ state: 'error', error: 'Invalid data found' }] });
    expect(await convert.runConversion({ path: SRC, bridge: b, t, showToast, sleep: noSleep })).toBe('error');
    expect(toasts.at(-1)).toMatchObject({ type: 'error', text: 'player.convert.failed {"error":"Invalid data found"}' });
  });

  it('no H.264 encoder: says so, nothing runs', async () => {
    const b = bridge({ start: { state: 'error', kind: 'noEncoder' } });
    expect(await convert.runConversion({ path: SRC, bridge: b, t, showToast, sleep: noSleep })).toBe('noEncoder');
    expect(b.transcodeStatus).not.toHaveBeenCalled();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].text).toBe('player.convert.noEncoder');
  });

  it('the backend forgot the job (restarted): "interrupted", not a spin forever', async () => {
    const b = bridge({ statuses: [{ state: 'none' }] });
    expect(await convert.runConversion({ path: SRC, bridge: b, t, showToast, sleep: noSleep })).toBe('error');
    expect(toasts.at(-1).text).toContain('player.convert.lost');
  });
});

// --- the player: app.js's hook, lifted ---------------------------------------

const LIFTED = ['_showDecodeErrorWithCodec', '_convertToPlay', '_playConvertedCopy'];
const META = { codec: 'mpeg4', profile: 'Simple Profile', pixFmt: 'yuv420p', width: 1280 };

function makeApp(b) {
  const Lifted = liftAppClass(LIFTED, {
    window: { funsync: { fetchMetadata: async () => META, ...b } },
    console: { log: () => {}, warn: () => {} },
    showToast, t, pathToFileURL,
    describeVideoCodec: () => 'MPEG4 Simple Profile yuv420p',
    canConvert: convert.canConvert, convertedCopy: convert.convertedCopy,
    offerConversion: convert.offerConversion,
    runConversion: (opts) => convert.runConversion({ ...opts, sleep: noSleep }),
  });
  const video = Object.assign(new EventTarget(), { currentTime: 42, paused: false, ended: false, play: vi.fn(() => Promise.resolve()) });
  return Object.assign(new Lifted(), {
    _videoLoadGen: 1,
    _currentVideoPath: SRC,
    _currentVideoName: '2.5.4_variant1.mp4',
    videoPlayer: { video, loadSource: vi.fn() },
    progressBar: { setVideoSource: vi.fn() },
  });
}

describe('the player offers to convert, and plays the copy (Dave\'s MPEG-4 Part 2 file)', () => {
  it('no copy yet: the offer names the codec; Convert to play converts and plays the copy from where it was', async () => {
    const b = bridge({ statuses: [{ state: 'done', path: COPY }] });
    const app = makeApp(b);
    await app._showDecodeErrorWithCodec(SRC, { meta: META, reason: 'video track dropped' });
    expect(toasts).toHaveLength(1);
    expect(toasts[0].text).toContain('player.convert.offer {"codec":"MPEG4 Simple Profile yuv420p"}');
    expect(toasts[0].text).not.toContain('supported on this system');
    expect(app.videoPlayer.loadSource).not.toHaveBeenCalled();

    button(toasts[0], 'convert-toast__go').click();
    await vi.waitFor(() => expect(app.videoPlayer.loadSource).toHaveBeenCalled());
    expect(toasts[0].dismissed).toBe(true);
    expect(app.videoPlayer.loadSource.mock.calls[0][0]).toBe(pathToFileURL(COPY));
    expect(app._remuxedCopy).toEqual({ original: SRC, path: COPY });
    // back where it was, playing as it was
    app.videoPlayer.video.currentTime = 0;
    app.videoPlayer.video.dispatchEvent(new Event('loadedmetadata'));
    expect(app.videoPlayer.video.currentTime).toBe(42);
    expect(app.videoPlayer.video.play).toHaveBeenCalled();
  });

  it('a copy made before: plays at once, no offer, nothing converted', async () => {
    const b = bridge({ cached: COPY });
    const app = makeApp(b);
    await app._showDecodeErrorWithCodec(SRC, { meta: META });
    expect(toasts).toHaveLength(0);
    expect(app.videoPlayer.loadSource).toHaveBeenCalledWith(pathToFileURL(COPY), '2.5.4_variant1.mp4');
    expect(b.transcodeVideo).toHaveBeenCalledTimes(1); // the cached-only question
  });

  it('another video opened while it converted: the copy is kept, "plays next time", the new video untouched', async () => {
    const b = bridge({ statuses: [{ state: 'done', path: COPY }] });
    const app = makeApp(b);
    await app._showDecodeErrorWithCodec(SRC, { meta: META });
    app._currentVideoPath = 'C:\\Lib\\Other.mp4';
    button(toasts[0], 'convert-toast__go').click();
    await vi.waitFor(() => expect(toasts.at(-1).text).toContain('player.convert.readyLater'));
    expect(app.videoPlayer.loadSource).not.toHaveBeenCalled();
  });

  it('B106: a load that meant to play (Continue watching) and failed: the copy that takes its place plays', async () => {
    const LiftedDisarm = liftAppClass(['_disarmLoadAutoplay', '_playConvertedCopy'], {
      console: { log: () => {}, warn: () => {} }, pathToFileURL,
    });
    const video = Object.assign(new EventTarget(), { currentTime: 0, paused: true, ended: false, play: vi.fn(() => Promise.resolve()) });
    const app = Object.assign(new LiftedDisarm(), {
      _currentVideoPath: SRC, _currentVideoName: '2.5.4_variant1.mp4',
      videoPlayer: { video, loadSource: vi.fn() }, progressBar: { setVideoSource: vi.fn() },
      _loadAutoplayListener: () => {},
    });
    // The load errored (an AVI Chromium cannot open): its autoplay is disarmed, remembered.
    app._disarmLoadAutoplay({ remember: true });
    expect(app._playConvertedCopy(SRC, COPY)).toBe(true);
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(video.play).toHaveBeenCalledTimes(1);
    // Used once: a later copy of a load that did not mean to play stays paused.
    video.play.mockClear();
    app._playConvertedCopy(SRC, COPY);
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(video.play).not.toHaveBeenCalled();
  });

  it('B106: a load that was meant to open paused stays paused; a device waiting for its script starts it itself', async () => {
    const LiftedDisarm = liftAppClass(['_disarmLoadAutoplay', '_playConvertedCopy'], {
      console: { log: () => {}, warn: () => {} }, pathToFileURL,
    });
    const video = Object.assign(new EventTarget(), { currentTime: 0, paused: true, ended: false, play: vi.fn(() => Promise.resolve()) });
    const app = Object.assign(new LiftedDisarm(), {
      _currentVideoPath: SRC, videoPlayer: { video, loadSource: vi.fn() }, progressBar: { setVideoSource: vi.fn() },
      _loadAutoplayListener: null, // opened paused: no autoplay was armed
    });
    app._disarmLoadAutoplay({ remember: true });
    app._playConvertedCopy(SRC, COPY);
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(video.play).not.toHaveBeenCalled();
    // Meant to play, but the Handy is still taking its script.
    app._loadAutoplayListener = () => {};
    app._disarmLoadAutoplay({ remember: true });
    app._waitingForScript = true;
    app._playConvertedCopy(SRC, COPY);
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(video.play).not.toHaveBeenCalled();
  });

  it('a saved stream: the old message (worded: FunSync cannot play it), no offer', async () => {
    const app = makeApp(bridge());
    app._currentVideoPath = 'stream:example.com/x';
    await app._showDecodeErrorWithCodec('stream:example.com/x', { meta: META });
    expect(toasts).toHaveLength(1);
    expect(toasts[0].text).toBe('toast.videoErrorDecodeCodec {"codec":"MPEG4 Simple Profile yuv420p"}');
  });
});
