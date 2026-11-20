// A headset streaming from FunSync reports FunSync's own URL (app test
// 2026-11-02: V63).
//
// jsdom on purpose (no node docblock): library.js and vr-bridge.js import
// i18n.js, which branches on `typeof window`. See notes/CLAUDE.md
// "Test environments".
//
// FunSync's content server names a video by registry id only:
// `/api/media/stream/{id}` and `/heresphere/{id}`, id = md5(path)[:12]. When
// HereSphere reports one of those as the playing path, name matching sees a
// 12-char hash, finds nothing, and the user is told there is no script for a
// video FunSync itself is serving. The fake backend below mints ids exactly
// as backend/routes/media.py `_path_to_id` does and answers
// `/api/media/video/{id}` from its registry, like the real route.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { funsyncVideoIdFromVRPath, vrDisplayName } from '../../renderer/js/vr-bridge.js';
import { Library } from '../../renderer/components/library.js';
import { liftAppClass } from './helpers/app-methods.js';

const idOf = (p) => crypto.createHash('md5').update(p, 'utf8').digest('hex').slice(0, 12);
const HOST = 'http://192.168.1.20:5123';

const VIDEOS = [
  { path: 'D:/vr/Beach Day_180_LR.mp4', name: 'Beach Day_180_LR.mp4', hasFunscript: true, funscriptPath: 'D:/vr/Beach Day_180_LR.funscript' },
  { path: 'D:/vr/Studio Night_180_LR.mp4', name: 'Studio Night_180_LR.mp4', hasFunscript: true, funscriptPath: 'D:/vr/Studio Night_180_LR.funscript' },
  { path: 'D:/vr/Unscripted.mp4', name: 'Unscripted.mp4', hasFunscript: false },
];

/** The backend: a registry keyed by `_path_to_id`, behind the real route's shape. */
function fakeBackend(videos, { up = true, slow = {} } = {}) {
  const registry = new Map(videos.map((v) => [idOf(v.path), v]));
  const backend = { lookups: [] };
  globalThis.fetch = vi.fn(async (url) => {
    if (!up) throw new TypeError('fetch failed');
    const m = /\/api\/media\/video\/([^/?#]+)$/.exec(String(url));
    if (!m) return { ok: false, status: 404, json: async () => ({}) };
    backend.lookups.push(m[1]);
    if (slow[m[1]]) await slow[m[1]];
    const v = registry.get(m[1]);
    return v
      ? { ok: true, status: 200, json: async () => ({ id: m[1], name: v.name, path: v.path }) }
      : { ok: false, status: 404, json: async () => ({ detail: 'Video not found' }) };
  });
  return backend;
}

function realLibrary(videos) {
  const lib = Object.create(Library.prototype);
  lib._settings = { get: (k) => (k === 'backend.port' ? 5123 : undefined) };
  lib._videos = videos;
  lib.ensureScanned = vi.fn(async () => {});
  return lib;
}

/** What VRBridge hands onVideoChanged: (normalised name, raw path). */
const report = (rawPath) => [rawPath.split('/').pop().toLowerCase(), rawPath];

afterEach(() => { delete globalThis.fetch; });

describe('funsyncVideoIdFromVRPath', () => {
  const id = idOf(VIDEOS[0].path);

  it('reads the id from the stream URL, with or without a query', () => {
    expect(funsyncVideoIdFromVRPath(`${HOST}/api/media/stream/${id}`)).toBe(id);
    expect(funsyncVideoIdFromVRPath(`${HOST}/api/media/stream/${id}?v=abc123`)).toBe(id);
  });

  it('reads the id from the HereSphere and DeoVR scene URLs', () => {
    expect(funsyncVideoIdFromVRPath(`${HOST}/heresphere/${id}`)).toBe(id);
    expect(funsyncVideoIdFromVRPath(`${HOST}/deovr/${id}`)).toBe(id);
  });

  it('is not fooled by file paths or other servers', () => {
    expect(funsyncVideoIdFromVRPath('D:\\vr\\Beach Day_180_LR.mp4')).toBeNull();
    expect(funsyncVideoIdFromVRPath('/storage/emulated/0/VR/Beach Day.mp4')).toBeNull();
    expect(funsyncVideoIdFromVRPath('http://localhost:9999/api/dms/file/123/scene.mp4')).toBeNull();
    // A real file named like an id, in a folder that happens to be "deovr".
    expect(funsyncVideoIdFromVRPath(`/storage/deovr/${id}.mp4`)).toBeNull();
    expect(funsyncVideoIdFromVRPath('')).toBeNull();
    expect(funsyncVideoIdFromVRPath(null)).toBeNull();
  });
});

describe('Library.resolveVRVideo', () => {
  it('finds the video behind a FunSync stream URL', async () => {
    fakeBackend(VIDEOS);
    const lib = realLibrary(VIDEOS);
    const hit = await lib.resolveVRVideo(...report(`${HOST}/api/media/stream/${idOf(VIDEOS[1].path)}`));
    expect(hit?.path).toBe('D:/vr/Studio Night_180_LR.mp4');
  });

  it('finds the video behind a HereSphere scene URL', async () => {
    fakeBackend(VIDEOS);
    const lib = realLibrary(VIDEOS);
    const hit = await lib.resolveVRVideo(...report(`${HOST}/heresphere/${idOf(VIDEOS[0].path)}`));
    expect(hit?.path).toBe('D:/vr/Beach Day_180_LR.mp4');
  });

  it('an id the backend does not know falls back to name matching (and finds nothing)', async () => {
    fakeBackend(VIDEOS);
    const lib = realLibrary(VIDEOS);
    expect(await lib.resolveVRVideo(...report(`${HOST}/api/media/stream/0123456789ab`))).toBeNull();
  });

  it('a backend that cannot answer is no match, not a crash', async () => {
    fakeBackend(VIDEOS, { up: false });
    const lib = realLibrary(VIDEOS);
    expect(await lib.resolveVRVideo(...report(`${HOST}/api/media/stream/${idOf(VIDEOS[0].path)}`))).toBeNull();
  });

  it('a file path still matches by name, without asking the backend', async () => {
    const backend = fakeBackend(VIDEOS);
    const lib = realLibrary(VIDEOS);
    const hit = await lib.resolveVRVideo('studio night 180 lr', 'D:\\vr\\Studio Night_180_LR.mp4');
    expect(hit?.path).toBe('D:/vr/Studio Night_180_LR.mp4');
    expect(backend.lookups).toEqual([]);
  });
});

describe('_onVRVideoChanged with a FunSync URL as the path', () => {
  const toasts = [];
  const Lifted = liftAppClass(['_onVRVideoChanged'], {
    showToast: (msg, type) => toasts.push({ msg, type }),
    t: (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key),
    normalizeAssociation: () => null,
    resolveActiveConfig: () => null,
    funsyncVideoIdFromVRPath,
    vrDisplayName,
  });
  let app;

  beforeEach(() => {
    toasts.length = 0;
    window.funsync = { readFunscript: vi.fn(async () => '{"actions":[{"at":0,"pos":0}]}') };
    app = new Lifted();
    app.library = realLibrary(VIDEOS);
    app.vrBridge = { proxy: new EventTarget(), connected: false };
    app.funscriptEngine = { loadContent: vi.fn(async () => {}), getActions: () => [] };
    app.settings = { get: () => ({}) };
    app._stopVRSync = vi.fn();
    // Since C-06 the headset's script resets custom routing where it takes
    // the engine (it used to happen inside the stubbed _stopVRSync).
    app._resetCustomRoutingState = vi.fn();
    app._pushRemoteDeviceStatus = vi.fn();
  });

  afterEach(() => { delete window.funsync; });

  it('loads that video\'s script and names the file, not the id', async () => {
    fakeBackend(VIDEOS);
    await app._onVRVideoChanged(...report(`${HOST}/api/media/stream/${idOf(VIDEOS[1].path)}`));

    expect(window.funsync.readFunscript).toHaveBeenCalledWith('D:/vr/Studio Night_180_LR.funscript');
    expect(toasts.map((x) => x.msg)).toEqual([
      'toast.vrScriptLoaded {"name":"Studio Night_180_LR.funscript"}',
    ]);
    expect(app.vrBridge.__vrModalLastVideo).toBe('Studio Night_180_LR.mp4');
  });

  it('a resolved video without a script says so by its file name', async () => {
    fakeBackend(VIDEOS);
    await app._onVRVideoChanged(...report(`${HOST}/heresphere/${idOf(VIDEOS[2].path)}`));
    expect(window.funsync.readFunscript).not.toHaveBeenCalled();
    expect(toasts.map((x) => x.msg)).toEqual(['toast.vrNoScript {"name":"Unscripted.mp4"}']);
  });

  it('a newer video reported while the lookup is in flight wins', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const backend = fakeBackend(VIDEOS, { slow: { [idOf(VIDEOS[0].path)]: gate } });
    const first = app._onVRVideoChanged(...report(`${HOST}/api/media/stream/${idOf(VIDEOS[0].path)}`));
    await vi.waitFor(() => expect(backend.lookups).toContain(idOf(VIDEOS[0].path)));
    // The headset moved on while the backend was still answering for the first.
    await app._onVRVideoChanged(...report(`${HOST}/api/media/stream/${idOf(VIDEOS[1].path)}`));
    release();
    await first;
    expect(window.funsync.readFunscript.mock.calls.map((c) => c[0]))
      .toEqual(['D:/vr/Studio Night_180_LR.funscript']);
  });
});
