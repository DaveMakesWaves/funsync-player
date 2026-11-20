// FT-070 (app test V72 "Found, not fixed"): a click on a video's card in a
// playlist or a category opened it with the script only. Both routes called
// `_onPlayVideo(fileData, funscriptData)` with no subtitle and no variants,
// so the subtitle never showed and the variant picker listed nothing, while
// the same video clicked in the library had both. Categories also put the
// script's path on `path`, not the `_funscriptPath` a library click sets.
//
// The REAL Playlists, Categories and Library click routes over one fake
// bridge; what each hands the app (`_onPlayVideo`'s arguments) is compared
// with a library click on the same video.
//
// jsdom (no docblock): library.js imports i18n.js, which branches on
// `typeof window` — see notes/CLAUDE.md "Test environments".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const showToast = vi.fn();
vi.mock('../../renderer/js/toast.js', () => ({ showToast: (...a) => showToast(...a) }));

const { Library } = await import('../../renderer/components/library.js');
const { Playlists } = await import('../../renderer/components/playlists.js');
const { Categories } = await import('../../renderer/components/categories.js');

const VIDEO = 'C:\\Lib\\Variant Clip.mp4';
const MAIN = 'C:\\Lib\\Variant Clip.funscript';
const SOFT = 'C:\\Lib\\Variant Clip (soft).funscript';
const TWIST = 'C:\\Lib\\Variant Clip.twist.funscript';
const SRT = 'C:\\Lib\\Variant Clip.srt';
const GONE = 'C:\\Removed\\Old Clip.mp4';
const GONE_SCRIPT = 'C:\\Removed\\Old Clip.funscript';

const DISK = {
  [MAIN]: '{"actions":[{"at":0,"pos":0},{"at":400,"pos":100}]}',
  [SOFT]: '{"actions":[{"at":0,"pos":20},{"at":400,"pos":60}]}',
  [SRT]: '1\n00:00:01,000 --> 00:00:02,000\nHello\n',
  [GONE_SCRIPT]: '{"actions":[{"at":0,"pos":0}]}',
};

const multiAxis = { main: MAIN, axes: { twist: TWIST } };
const makeVideo = () => ({
  name: 'Variant Clip.mp4',
  path: VIDEO,
  hasFunscript: true,
  funscriptPath: MAIN,
  hasSubtitle: true,
  subtitlePath: SRT,
  variants: [
    { path: MAIN, name: 'Default', label: 'Default' },
    { path: SOFT, name: 'Variant Clip (soft).funscript', label: 'soft' },
  ],
  _multiAxis: multiAxis,
});

function settingsFor(store) {
  return {
    get: (k) => store[k],
    set: (k, v) => { store[k] = v; },
    getPlaylist: () => null,
    getPlaylists: () => [],
    getCategories: () => [],
    getVideoCategories: () => [],
  };
}

let played;
let lib;
let settings;
beforeEach(() => {
  showToast.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  window.funsync = {
    readFunscript: vi.fn(async (p) => (p in DISK ? DISK[p] : null)),
    filesExist: vi.fn(async (list) => list.map((p) => p in DISK)),
    fileExists: vi.fn(async (p) => p in DISK),
  };
  played = [];
  settings = settingsFor({ 'library.associations': {} });
  const onPlayVideo = (fileData, funscriptData, subtitleData, variants) =>
    played.push({ fileData, funscriptData, subtitleData, variants });
  lib = new Library({ settings, onPlayVideo });
  lib._videos = [makeVideo()];
});
afterEach(() => {
  vi.restoreAllMocks();
  delete window.funsync;
});

const onPlayVideo = (fileData, funscriptData, subtitleData, variants) =>
  played.push({ fileData, funscriptData, subtitleData, variants });

async function libraryClick() {
  await lib._playVideo(lib._videos[0]);
  return played.pop();
}

describe('a playlist or category card click loads what a library click does (FT-070)', () => {
  it('playlist card: same script, companions, subtitle and variants as the library card', async () => {
    const fromLibrary = await libraryClick();
    expect(fromLibrary.subtitleData?.textContent).toContain('Hello');
    expect(fromLibrary.variants).toHaveLength(2);

    const pl = new Playlists({ settings, onPlayVideo, library: lib });
    await pl._playVideoByPath(VIDEO, null);
    const fromPlaylist = played.pop();

    expect(fromPlaylist.fileData.path).toBe(VIDEO);
    expect(fromPlaylist.funscriptData).toEqual(fromLibrary.funscriptData);
    expect(fromPlaylist.subtitleData).toEqual(fromLibrary.subtitleData);
    expect(fromPlaylist.variants).toEqual(fromLibrary.variants);
    expect(fromPlaylist.variants.map((v) => v.label)).toEqual(['Default', 'soft']);
    expect(fromPlaylist.funscriptData._multiAxis).toBe(multiAxis);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('category card: the same, and the script path rides on `_funscriptPath`, not `path`', async () => {
    const fromLibrary = await libraryClick();

    const cats = new Categories({ settings, onPlayVideo, library: lib });
    await cats._playVideo(VIDEO, null);
    const fromCategory = played.pop();

    expect(fromCategory.funscriptData).toEqual(fromLibrary.funscriptData);
    expect(fromCategory.funscriptData._funscriptPath).toBe(MAIN);
    expect(fromCategory.funscriptData).not.toHaveProperty('path');
    expect(fromCategory.subtitleData).toEqual(fromLibrary.subtitleData);
    expect(fromCategory.variants).toEqual(fromLibrary.variants);
  });

  it('an entry whose source was removed (not in the library) keeps the path-only fallback', async () => {
    const pl = new Playlists({ settings, onPlayVideo, library: lib });
    await pl._playVideoByPath(GONE, null);
    const p = played.pop();
    expect(p.funscriptData).toEqual({
      name: 'Old Clip.funscript', textContent: DISK[GONE_SCRIPT], _funscriptPath: GONE_SCRIPT,
    });
    expect(p.subtitleData).toBeNull();
    expect(p.variants).toBeUndefined();

    const cats = new Categories({ settings, onPlayVideo, library: lib });
    await cats._playVideo(GONE, null);
    const c = played.pop();
    expect(c.funscriptData).toEqual({
      name: 'Old Clip.funscript', textContent: DISK[GONE_SCRIPT], _funscriptPath: GONE_SCRIPT,
    });
    expect(showToast).not.toHaveBeenCalled();
  });

  it('a playlist entry with an association whose script is gone still says so', async () => {
    const lost = 'C:\\Scripts\\Lost.funscript';
    lib._videos[0] = {
      ...makeVideo(), funscriptPath: lost, _multiAxis: null, _manualAssociation: true, variants: [],
    };
    const pl = new Playlists({ settings, onPlayVideo, library: lib });
    await pl._playVideoByPath(VIDEO, null);
    const p = played.pop();
    expect(p.funscriptData).toBeNull();
    expect(p.subtitleData?.textContent).toContain('Hello');
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls[0][1]).toBe('warn');
  });

  it('a scriptless record: the guessed `<name>.funscript` is read once, not twice', async () => {
    lib._videos[0] = {
      ...makeVideo(), hasFunscript: false, funscriptPath: null, _multiAxis: null, variants: [],
    };
    const pl = new Playlists({ settings, onPlayVideo, library: lib });
    await pl._playVideoByPath(VIDEO, null);
    const p = played.pop();
    expect(p.funscriptData?.textContent).toBe(DISK[MAIN]);   // the sidecar is there
    const scriptReads = window.funsync.readFunscript.mock.calls.filter((c) => c[0] === MAIN);
    expect(scriptReads).toHaveLength(1);
    expect(showToast).not.toHaveBeenCalled();
  });
});
