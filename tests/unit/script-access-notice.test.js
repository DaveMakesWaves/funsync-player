/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Library, Playlists and Categories import
 * DOM-branching modules (notes/CLAUDE.md "Test environments").
 */
// R3-18 (found while checking FT-002, also in v0.9.2): while a script's
// folder is locked (a deny ACL: `fs.access` on the file fails EPERM while
// the folder answers), opening the video played it with no script and no
// word. `read-funscript` answers null for every failure. Now the open says
// once, per script per session: "Can't read <name>: access denied. Playing
// without sync." A missing script, or a share that does not answer, is not
// "access denied" and gets no such toast. Nothing is pruned.
//
// The REAL Library click route, Playlists card route and Categories card
// route; `files-exist` is a fake per path, the same tri-state main sends
// (true / false / null, path-status.js).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { showToast } = await import('../../renderer/js/toast.js');
const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { Library } = await import('../../renderer/components/library.js');
const { Playlists } = await import('../../renderer/components/playlists.js');
const { Categories } = await import('../../renderer/components/categories.js');
const { _resetUnreadableScriptNotices } = await import('../../renderer/js/script-access-notice.js');

// The words the user reads, pinned here (the strings stage adds the key to
// the 8 locales; a missing key would show raw).
const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const ENX = structuredClone(EN);
ENX.toast.scriptAccessDenied = 'Can\'t read {name}: access denied. Playing without sync.';

const LOCKED_DIR = 'C:\\sandbox\\locked';
const VIDEO = `${LOCKED_DIR}\\Locked Clip.mp4`;
const SCRIPT = `${LOCKED_DIR}\\Locked Clip.funscript`;
const ASSOC = { [VIDEO]: { active: 'single', single: SCRIPT, multi: null, custom: null } };

let status; // path -> what files-exist answers
let store;
let plays;

const settled = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };
const accessToasts = () => showToast.mock.calls.filter(([msg]) => /access denied/.test(msg));

beforeEach(() => {
  _setBundlesForTests('en', ENX, ENX);
  _resetUnreadableScriptNotices();
  showToast.mockClear();
  status = new Map([[SCRIPT, null], [LOCKED_DIR, true]]); // the locked-folder case
  store = { 'library.associations': structuredClone(ASSOC), 'library.sources': [] };
  plays = [];
  window.funsync = {
    readFunscript: vi.fn(async () => null), // EPERM, ENOENT: read-funscript says null for both
    filesExist: vi.fn(async (paths) => paths.map((p) => (status.has(p) ? status.get(p) : false))),
  };
});

afterEach(() => { delete window.funsync; });

function library() {
  const settings = { get: (k) => store[k], set: (k, v) => { store[k] = v; } };
  const lib = new Library({ settings, onPlayVideo: (v, fs) => plays.push([v.path, fs?.textContent ?? null]) });
  lib._videos = [{ name: 'Locked Clip.mp4', path: VIDEO, hasFunscript: true, funscriptPath: SCRIPT }];
  return lib;
}

describe('R3-18: a script that is there but cannot be read says so, once', () => {
  it('a library click on the video: it plays without sync, with one "access denied" toast naming the script', async () => {
    const lib = library();
    await lib._playVideo(lib.getVideoByPath(VIDEO));
    await settled();
    expect(plays).toEqual([[VIDEO, null]]);
    expect(accessToasts()).toEqual([
      ['Can\'t read Locked Clip.funscript: access denied. Playing without sync.', 'warn', 6000],
    ]);
  });

  it('opened again in the same session: no second toast', async () => {
    const lib = library();
    await lib._playVideo(lib.getVideoByPath(VIDEO));
    await settled();
    await lib._playVideo(lib.getVideoByPath(VIDEO));
    await settled();
    expect(accessToasts()).toHaveLength(1);
  });

  it('nothing is pruned or changed: the association still points at the locked script', async () => {
    const lib = library();
    await lib._playVideo(lib.getVideoByPath(VIDEO));
    await settled();
    expect(store['library.associations']).toEqual(ASSOC);
  });

  it('a script that is really missing, or a share that does not answer: no "access denied"', async () => {
    status.set(SCRIPT, false); // ENOENT
    let lib = library();
    await lib._playVideo(lib.getVideoByPath(VIDEO));
    await settled();
    status.set(SCRIPT, null);
    status.set(LOCKED_DIR, null); // the whole share timed out
    lib = library();
    await lib._playVideo(lib.getVideoByPath(VIDEO));
    await settled();
    expect(accessToasts()).toEqual([]);
  });

  it('a script that read fine: no probe, no toast', async () => {
    window.funsync.readFunscript = vi.fn(async () => '{"actions":[]}');
    const lib = library();
    await lib._playVideo(lib.getVideoByPath(VIDEO));
    await settled();
    expect(window.funsync.filesExist).not.toHaveBeenCalled();
    expect(accessToasts()).toEqual([]);
  });

  it('a playlist card (a sidecar, no association) and a category card say it too', async () => {
    store['library.associations'] = {};
    const settings = {
      get: (k) => store[k], set: (k, v) => { store[k] = v; },
      getPlaylists: () => [], getPlaylist: () => null,
    };
    const playlists = new Playlists({ settings, library: null, onPlayVideo: () => {}, onPlayAll: vi.fn() });
    await playlists._playVideoByPath(VIDEO, null);
    await settled();
    expect(accessToasts()).toHaveLength(1);

    _resetUnreadableScriptNotices();
    const cats = new Categories({ settings, onPlayVideo: () => {}, library: null });
    await cats._playVideo(VIDEO, null);
    await settled();
    expect(accessToasts()).toHaveLength(2);
  });
});
