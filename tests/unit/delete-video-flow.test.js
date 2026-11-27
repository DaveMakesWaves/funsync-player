/**
 * @vitest-environment jsdom
 * jsdom: library.js and toast.js branch on `typeof window`.
 */
// The delete flow (2026-11-23, EroScripts #434; DESIGN.md §2.18), in the REAL
// Library methods with main and the dialog faked: the player lets go BEFORE
// anything is deleted, a deleted video is forgotten (only when it really
// went), every failure is said, the library rescans; Cancel deletes nothing;
// a saved stream is never offered. And the app's release step.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';

const dialog = vi.hoisted(() => ({ answer: null, seen: null }));
vi.mock('../../renderer/components/delete-files-dialog.js', () => ({
  openDeleteDialog: vi.fn(async (o) => { dialog.seen = o; return dialog.answer; }),
}));

import { Library } from '../../renderer/components/library.js';
import { liftAppClass } from './helpers/app-methods.js';

const V = 'C:\\Lib\\Clip.mp4';
const S = 'C:\\Lib\\Clip.funscript';
const order = [];

function lib({ results }) {
  const store = {
    'library.associations': { [V]: S },
    'library.resumePositions': { [V]: { t: 3 } },
  };
  const l = Object.create(Library.prototype);
  l._settings = {
    get: (k) => store[k],
    set: vi.fn((k, v) => { store[k] = v; }),
    getPlaylists: () => [],
    getVideoCategories: () => [],
  };
  l._videos = [{ name: 'Clip.mp4', path: V, funscriptPath: S }];
  l.onBeforeDelete = vi.fn(async () => { order.push('release'); });
  l.ensureScanned = vi.fn(async () => { order.push('rescan'); });
  window.funsync = {
    platform: 'win32',
    listVideoFiles: vi.fn(async () => [{ path: V, kind: 'video', size: 100 }, { path: S, kind: 'script', size: 10 }]),
    deleteVideoFiles: vi.fn(async (paths, opts) => { order.push(`delete ${opts.permanent ? 'permanent' : 'bin'}`); return results(paths); }),
  };
  return { l, store };
}

beforeEach(() => { order.length = 0; document.body.innerHTML = '<div id="toast-container"></div>'; dialog.answer = null; dialog.seen = null; });

describe('Library.deleteVideo', () => {
  it('the dialog gets the plan; the player lets go first; the video is forgotten; the library rescans', async () => {
    const { l, store } = lib({ results: (paths) => paths.map((p) => ({ path: p, ok: true, size: 10 })) });
    dialog.answer = { paths: [V, S], permanent: true };
    const gone = await l.deleteVideo({ name: 'Clip.mp4', path: V, funscriptPath: S });
    expect(gone).toBe(true);
    expect(dialog.seen.rows.map((r) => [r.name, r.checked])).toEqual([['Clip.mp4', true], ['Clip.funscript', true]]);
    expect(order).toEqual(['release', 'delete permanent', 'rescan']);
    expect(l.onBeforeDelete).toHaveBeenCalledWith([V, S]);
    expect(store['library.associations']).toEqual({});
    expect(store['library.resumePositions']).toEqual({});
    expect(document.body.textContent).toMatch(/Deleted 2 files \(.+\) permanently\./);
  });

  it('a video that could not be deleted is NOT forgotten, and the toast says why', async () => {
    const { l, store } = lib({ results: (paths) => paths.map((p) => (p === V ? { path: p, ok: false, reason: 'in-use' } : { path: p, ok: true, size: 10 })) });
    dialog.answer = { paths: [V, S], permanent: false };
    expect(await l.deleteVideo({ name: 'Clip.mp4', path: V })).toBe(false);
    expect(store['library.associations']).toEqual({ [V]: S });
    expect(document.body.textContent).toContain('1 file was not deleted: in use (close whatever is playing it, then try again).');
  });

  it('Cancel deletes nothing and releases nothing', async () => {
    const { l } = lib({ results: () => [] });
    dialog.answer = null;
    expect(await l.deleteVideo({ name: 'Clip.mp4', path: V })).toBe(false);
    expect(order).toEqual([]);
    expect(window.funsync.deleteVideoFiles).not.toHaveBeenCalled();
  });

  it('a saved stream is never offered (Remove from library does that)', async () => {
    const { l } = lib({ results: () => [] });
    expect(await l.deleteVideo({ name: 'x', path: 'stream:example.com/v.mp4', _stream: true })).toBe(false);
    expect(dialog.seen).toBeNull();
  });
});

describe('the entry points', () => {
  it('Video options ▸ File has a danger-styled Delete on its own row; the host and the loose list are wired', () => {
    const vo = fs.readFileSync('renderer/components/video-options-dialog.js', 'utf8');
    expect(vo).toContain("className: 'modal-btn modal-btn--danger video-options__btn video-options__delete'");
    expect(vo).toContain("if (await host.deleteVideo(v)) ui.close?.();");
    expect(fs.readFileSync('renderer/components/library.js', 'utf8')).toContain('deleteVideo: (video) => this.deleteVideo(video),');
    const app = fs.readFileSync('renderer/js/app.js', 'utf8');
    // A delete from the scripts window redraws the Scripts filter too (B094, 2026-11-26).
    expect(app).toContain('onDelete: (sc) => Promise.resolve(lib.deleteLooseScript?.(sc) ?? false)');
    expect(app).toContain('this.library.onBeforeDelete = (paths) => this._releaseVideoForDelete(paths);');
  });
});

describe('App._releaseVideoForDelete', () => {
  const App = liftAppClass(['_releaseVideoForDelete'], {});
  function app(current) {
    const video = { removeAttribute: vi.fn(), load: vi.fn(), pause: vi.fn() };
    return Object.assign(new App(), {
      _currentVideoPath: current,
      _currentVideoName: 'Clip.mp4',
      videoPlayer: { video },
      scriptEditor: { hide: vi.fn() },
      _currentView: () => 'player',
      _navigateTo: vi.fn(),
      _clearMiniplayer: vi.fn(),
      _getViewEl: () => ({ hidden: false }),
      _teardownPlayback: vi.fn(),
    });
  }

  it('lets go of the playing video when it is going (case-insensitive), flushing the editor first', async () => {
    const a = app(V);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await a._releaseVideoForDelete(['c:/lib/clip.mp4'])).toBe(true);
    expect(a.scriptEditor.hide).toHaveBeenCalled();
    expect(a._navigateTo).toHaveBeenCalledWith('library');
    expect(a._teardownPlayback).toHaveBeenCalled();
    expect(a.videoPlayer.video.removeAttribute).toHaveBeenCalledWith('src');
    expect(a._currentVideoPath).toBeNull();
  });

  it('leaves the player alone when its video is not going', async () => {
    const a = app('C:\\Lib\\Other.mp4');
    expect(await a._releaseVideoForDelete([V])).toBe(false);
    expect(a._teardownPlayback).not.toHaveBeenCalled();
    expect(a._currentVideoPath).toBe('C:\\Lib\\Other.mp4');
  });
});

// Dave, 2026-11-25: "if i delete a video and funscript from the libary using
// the new delete feature, on the eroscripts tab its still showing the video
// and funscript as downloaded ... give the user the option to delete that too
// and make it greyed out again on the eroscripts tab as if it were never
// downloaded".
describe('a deleted video downloaded from an EroScripts post', () => {
  const POST = { video: V, script: S, scriptUrl: 'https://discuss.eroscripts.com/uploads/a.funscript', title: 'Post A', at: 1 };
  const okAll = (paths) => paths.map((p) => ({ path: p, ok: true, size: 10 }));

  it('the dialog offers to forget the download, ticked, naming the post; ticked, the post is forgotten and the tab told', async () => {
    const { eventBus } = await import('../../renderer/js/event-bus.js');
    const told = vi.fn();
    eventBus.on('library:filesDeleted', told);
    const { l, store } = lib({ results: okAll });
    store['eroscripts.downloaded'] = { 7: { ...POST }, 8: { video: 'C:/Lib/Other.mp4', title: 'Other', at: 1 } };
    dialog.answer = { paths: [V, S], permanent: false, forget: true };
    await l.deleteVideo({ name: 'Clip.mp4', path: V, funscriptPath: S });
    expect(dialog.seen.forget).toMatchObject({ checked: true });
    expect(dialog.seen.forget.hint).toContain('Post A');
    expect(store['eroscripts.downloaded']).toEqual({ 8: { video: 'C:/Lib/Other.mp4', title: 'Other', at: 1 } });
    expect(told).toHaveBeenCalledWith({ paths: [V, S] });
    eventBus.off?.('library:filesDeleted', told);
  });

  it('unticked: the record stays (the tab still asks the disk again)', async () => {
    const { l, store } = lib({ results: okAll });
    store['eroscripts.downloaded'] = { 7: { ...POST } };
    dialog.answer = { paths: [V, S], permanent: false, forget: false };
    await l.deleteVideo({ name: 'Clip.mp4', path: V, funscriptPath: S });
    expect(store['eroscripts.downloaded']).toEqual({ 7: POST });
  });

  it('a video not from a post: no offer', async () => {
    const { l } = lib({ results: okAll });
    dialog.answer = null;
    await l.deleteVideo({ name: 'Clip.mp4', path: V, funscriptPath: S });
    expect(dialog.seen.forget).toBeNull();
  });
});
