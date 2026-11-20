/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// verify-1 (2026-11-07; the FT-076 check expected "a skip, not a stall"): Up
// Next advanced from a playlist entry onto the next one, whose file had been
// renamed away after the scan, and STOPPED there with "Can't find <name>",
// docked and with the player popped out alike. The next entry existed; the
// user had to press Next. The advance's own walk past missing entries asks
// the library scan, which still listed the file, so only the load found out.
// Play All already walked on in that case (V10); a list context did not.
//
// The REAL _onVideoError / _onCurrentVideoMissing and the REAL UpNextEngine
// run against a fake disk; `_playUpNext` stands in for the load that follows
// (it is the real path's entry point). Asserted: what plays next, the toasts,
// and that nothing is removed from the list.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { liftAppClass } from './helpers/app-methods.js';
import { pathToFileURL } from '../../renderer/js/path-utils.js';
import { UpNextEngine } from '../../renderer/js/up-next.js';

const L = (n) => `C:\\sandbox\\library\\${n}.mp4`;
const [A, B, C, D, E] = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'].map(L);

let toasts;
let onDisk;
let app;
let played;

function build(list, { loop = false } = {}) {
  toasts = [];
  played = [];
  const Lifted = liftAppClass(['_onVideoError', '_onCurrentVideoMissing', '_stopOutputsForVideoError', '_disarmLoadAutoplay', '_onVideoLoadSucceeded'], {
    window: { funsync: { filesExist: async (paths) => paths.map((p) => onDisk.has(p)) } },
    console: { log() {}, warn() {}, error() {} },
    showToast: (text, type) => toasts.push({ text: String(text), type }),
    t: (key, params) => (params?.name ? `${key}:${params.name}` : key),
    pathToFileURL,
  });
  const engine = new UpNextEngine({ videoPlayer: { currentTime: 0, duration: 10, paused: true }, funscriptEngine: {} });
  app = Object.assign(new Lifted(), {
    videoPlayer: { video: { error: null, src: '' } },
    library: { _lastScanKey: 'scan' },
    upNextEngine: engine,
    _playQueue: [],
    _playQueueIndex: -1,
    _videoLoadGen: 0,
    _advanceLoadGen: null,
    _remuxAttemptedForPath: null,
  });
  // What _playFromLibrary does for a video the list reached: context at its
  // index, a new load generation, the advance mark, then the <video> error
  // for a file that is not there.
  app.load = async (path, { advance }) => {
    const index = list.indexOf(path);
    app._currentPlayContext = { source: 'playlist', list: [...list], index, loop };
    engine.setPlayContext(app._currentPlayContext);
    app._currentVideoPath = path;
    app._currentVideoName = path.split('\\').pop();
    app._videoLoadGen++;
    app._advanceLoadGen = advance ? app._videoLoadGen : null;
    played.push(path);
    app.videoPlayer.video.src = pathToFileURL(path);
    if (!onDisk.has(path)) {
      app.videoPlayer.video.error = { code: 4, message: 'MEDIA_ELEMENT_ERROR: Format error' };
      await app._onVideoError();
    } else {
      app.videoPlayer.video.error = null;
      app._onVideoLoadSucceeded();
    }
  };
  app._playUpNext = vi.fn((path) => app.load(path, { advance: true }));
  return app;
}

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };

beforeEach(() => { onDisk = new Set([A, B, C, D, E]); });

describe('Up Next walks past a playlist entry whose file is gone', () => {
  it('B ends, C was renamed away: C is reported once and D plays', async () => {
    onDisk.delete(C);
    build([A, B, C, D]);
    await app.load(C, { advance: true });
    await flush();
    expect(played).toEqual([C, D]);
    expect(toasts).toEqual([{ text: `toast.videoFileMissing:${C.split('\\').pop()}`, type: 'error' }]);
    expect(app._currentPlayContext.list).toEqual([A, B, C, D]); // nothing removed
  });

  it('two gone in a row: one toast, then the walk count once a file plays', async () => {
    onDisk.delete(C);
    onDisk.delete(D);
    build([A, B, C, D, E]);
    await app.load(C, { advance: true });
    await flush();
    expect(played).toEqual([C, D, E]);
    expect(toasts.map((x) => x.text)).toEqual([`toast.videoFileMissing:${C.split('\\').pop()}`, 'toast.playlistSkippedUnavailable']);
  });

  it('the last entry gone: reported, nothing more to play, no loop', async () => {
    onDisk.delete(D);
    build([A, B, C, D]);
    await app.load(D, { advance: true });
    await flush();
    expect(played).toEqual([D]);
    expect(toasts).toHaveLength(1);
  });

  it('a looping list with every file gone stops after one pass', async () => {
    onDisk = new Set();
    build([A, B, C], { loop: true });
    await app.load(B, { advance: true });
    await flush();
    expect(played.length).toBeLessThanOrEqual(3);
    expect(toasts.at(-1)).toEqual({ text: 'toast.playlistAllUnavailable', type: 'warn' });
  });

  it('a gone file the USER opened is reported, not skipped', async () => {
    onDisk.delete(C);
    build([A, B, C, D]);
    await app.load(C, { advance: false });
    await flush();
    expect(played).toEqual([C]);
    expect(app._playUpNext).not.toHaveBeenCalled();
  });
});

describe('UpNextEngine.peekNext', () => {
  it('names the next entry without moving the context or firing', () => {
    const engine = new UpNextEngine({ videoPlayer: {}, funscriptEngine: {} });
    const fired = vi.fn();
    engine.onPlayNext = fired;
    engine.setPlayContext({ source: 'playlist', list: [A, B, C], index: 0 });
    expect(engine.peekNext()).toBe(B);
    expect(engine.peekNext()).toBe(B);
    expect(fired).not.toHaveBeenCalled();
  });
});
