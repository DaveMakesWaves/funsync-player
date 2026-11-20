// FT-069 (notes/UPDATES.md V72 follow-up): a `<name>.funscript` dropped next
// to a video AFTER the last scan played from Play All and from a playlist
// card (both read the guessed sidecar), but a click on the library card
// opened the video with no script: `resolvePlayData` read only when the
// record already said `hasFunscript && funscriptPath`. There is no folder
// watcher, so the record keeps saying "no script" until a Refresh.
//
// Driven through the REAL `_playVideo`, as a card click opens it. What the
// user gets is pinned: the script the app plays (`_onPlayVideo`'s argument),
// whether a toast or warning appears, and which files are read.
//
// jsdom (no docblock): library.js imports i18n.js, which branches on
// `typeof window` — see notes/CLAUDE.md "Test environments".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const showToast = vi.fn();
vi.mock('../../renderer/js/toast.js', () => ({ showToast: (...a) => showToast(...a) }));

const { Library } = await import('../../renderer/components/library.js');
const { buildAssociationEntry } = await import('../../renderer/js/association-shape.js');

const VIDEO = 'C:\\Lib\\Untagged Wide.mp4';
const SIDECAR = 'C:\\Lib\\Untagged Wide.funscript';
const SCRIPT = '{"actions":[{"at":0,"pos":0},{"at":500,"pos":100}]}';

let warn;
let info;
beforeEach(() => {
  showToast.mockClear();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  delete window.funsync;
});

function installBridge(disk = {}) {
  window.funsync = {
    readFunscript: vi.fn(async (p) => (p in disk ? disk[p] : null)),
    filesExist: vi.fn(async (list) => list.map((p) => p in disk)),
    fileExists: vi.fn(async (p) => p in disk),
  };
}

function makeLibrary(associations = {}) {
  const played = [];
  const store = { 'library.associations': associations };
  const lib = new Library({
    settings: { get: (k) => store[k], set: (k, v) => { store[k] = v; } },
    onPlayVideo: (fileData, funscriptData, subtitleData, variants) =>
      played.push({ fileData, funscriptData, subtitleData, variants }),
  });
  return { lib, played, store };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('a library click plays a script added after the last scan (FT-069)', () => {
  it('a scriptless record with `<name>.funscript` now beside it plays that script, quietly', async () => {
    installBridge({ [SIDECAR]: SCRIPT });
    const { lib, played } = makeLibrary();
    const video = { name: 'Untagged Wide.mp4', path: VIDEO, hasFunscript: false, funscriptPath: null };
    lib._videos = [video];

    await lib._playVideo(video);
    await settle();

    expect(played).toHaveLength(1);
    expect(played[0].fileData.path).toBe(VIDEO);
    expect(played[0].funscriptData).toMatchObject({
      name: 'Untagged Wide.funscript',
      textContent: SCRIPT,
      _funscriptPath: SIDECAR,   // the editor's save target is the file that played
    });
    expect(showToast).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    // One info line says where it came from.
    expect(info.mock.calls.filter((c) => String(c[0]).startsWith('[Library]'))).toHaveLength(1);
    // Nothing stored: the record catches up at the next Refresh.
    expect(video.hasFunscript).toBe(false);
    expect(video.funscriptPath).toBeNull();
  });

  it('no sidecar there: no script, no toast, no warning', async () => {
    installBridge({});
    const { lib, played } = makeLibrary();
    const video = { name: 'Untagged Wide.mp4', path: VIDEO, hasFunscript: false, funscriptPath: null };
    lib._videos = [video];

    await lib._playVideo(video);
    await settle();

    expect(played[0].funscriptData).toBeNull();
    expect(window.funsync.readFunscript).toHaveBeenCalledTimes(1);
    expect(window.funsync.readFunscript).toHaveBeenCalledWith(SIDECAR);
    expect(showToast).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('a read that throws is just as quiet', async () => {
    installBridge({});
    window.funsync.readFunscript = vi.fn(async () => { throw new Error('EACCES'); });
    const { lib, played } = makeLibrary();
    const video = { name: 'Untagged Wide.mp4', path: VIDEO, hasFunscript: false, funscriptPath: null };

    await lib._playVideo(video);
    await settle();

    expect(played[0].funscriptData).toBeNull();
    expect(showToast).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('a scripted record is unchanged: it reads its own script and nothing else', async () => {
    const paired = 'C:\\Scripts\\Paired.funscript';
    installBridge({ [paired]: SCRIPT, [SIDECAR]: '{"actions":[]}' });
    const { lib, played } = makeLibrary();
    const video = { name: 'Untagged Wide.mp4', path: VIDEO, hasFunscript: true, funscriptPath: paired };

    await lib._playVideo(video);

    expect(played[0].funscriptData.textContent).toBe(SCRIPT);
    expect(played[0].funscriptData._funscriptPath).toBe(paired);
    expect(window.funsync.readFunscript.mock.calls.map((c) => c[0])).toEqual([paired]);
  });

  it('the user\'s own choice wins: a manual association or custom routing never reads the sidecar', async () => {
    installBridge({ [SIDECAR]: SCRIPT });
    // A multi association with axes only (no main): the record says
    // hasFunscript with no main path; the user picked those files.
    const multi = { main: null, axes: { vib: 'C:\\Lib\\Untagged Wide.vib.funscript' } };
    const { lib, played } = makeLibrary({ [VIDEO]: buildAssociationEntry('multi', null, multi, null) });
    const manual = {
      name: 'Untagged Wide.mp4', path: VIDEO, hasFunscript: true, funscriptPath: null,
      _manualAssociation: true, _multiAxis: multi,
    };
    await lib._playVideo(manual);
    expect(played[0].funscriptData.textContent).toBeNull();
    expect(played[0].funscriptData._multiAxis).toBe(multi);

    const routed = {
      name: 'Untagged Wide.mp4', path: VIDEO, hasFunscript: false, funscriptPath: null,
      _customRouting: [{ role: 'vib', scriptPath: 'C:\\Lib\\x.funscript' }],
    };
    await lib._playVideo(routed);
    expect(played[1].funscriptData.textContent).toBeNull();

    expect(window.funsync.readFunscript).not.toHaveBeenCalled();
  });
});
