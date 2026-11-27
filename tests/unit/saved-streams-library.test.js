/**
 * @vitest-environment jsdom
 *
 * Saved streams in the library (2026-11-23, notes/features/SCOPE-saved-streams.md):
 * merged into the video list, a link icon on the card, a picture of their own
 * (never ffmpeg on the key), the Streams / This computer filter, and the app's
 * save / queue / play wiring (read from app.js: the class needs the whole app).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';

const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { Library } = await import('../../renderer/components/library.js');
const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const ES = 'https://erosync.net/embed/abc6d128-7035-44d3-88a4-64dd63a2bc5f';
const KEY = 'stream:erosync.net/videos/abc6d128-7035-44d3-88a4-64dd63a2bc5f';

function lib(store) {
  const l = Object.create(Library.prototype);
  l._settings = { get: (k) => store[k], set: vi.fn((k, v) => { store[k] = v; }) };
  l._videos = [{ path: 'C:\\V\\a.mp4', name: 'a.mp4' }];
  l._videosByPath = new Map(l._videos.map((v) => [v.path, v]));
  return l;
}

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  window.funsync = {};
});

describe('the library list', () => {
  it('saved streams join the scanned files, and are replaced on every change', () => {
    const store = { 'library.streams': [{ key: KEY, pageUrl: ES, title: 'POV', site: 'EroSync', duration: 774, scriptPath: 'C:\\D\\s.funscript', addedAt: 1 }] };
    const l = lib(store);
    l._mergeStreams();
    expect(l._videos.map((v) => v.path)).toEqual(['C:\\V\\a.mp4', KEY]);
    expect(l._videosByPath.get(KEY)).toMatchObject({ _stream: true, name: 'POV', hasFunscript: true, duration: 774 });
    store['library.streams'] = [];
    l._mergeStreams();
    expect(l._videos.map((v) => v.path)).toEqual(['C:\\V\\a.mp4']);   // removed: gone from the list, files kept
  });

  it('a stream card has its own picture or the logo tile, never a frame grab on its key', async () => {
    const store = { 'library.streams': [], 'library.customThumbnails': {} };
    const l = lib(store);
    window.funsync.generateSingleThumbnail = vi.fn();
    window.funsync.readCustomThumbnail = vi.fn(async () => ({ dataUrl: 'data:image/jpeg;base64,AA' }));
    expect(await l._captureVideoFrameUncached(KEY)).toMatchObject({ noVideo: true });
    store['library.customThumbnails'] = { [KEY]: { type: 'image', imagePath: 'C:\\T\\x.jpg' } };
    expect(await l._captureVideoFrameUncached(KEY)).toEqual({ dataUrl: 'data:image/jpeg;base64,AA', duration: 0 });
    expect(window.funsync.generateSingleThumbnail).not.toHaveBeenCalled();
  });

  it('the link icon says where it streams from', () => {
    const l = lib({});
    const b = l._streamBadge({ site: 'EroSync' });
    expect(b.className).toBe('library__stream-badge');
    expect(b.title).toBe(EN.library.streams.badgeSite.replace('{site}', 'EroSync'));
    expect(b.querySelector('svg')).toBeTruthy();
  });

  it('the Streams / This computer filter, the badge on cards and rows, play hands the app the page', () => {
    const src = fs.readFileSync('renderer/components/library.js', 'utf8');
    expect(src).toMatch(/if \(this\._mediaFilter === 'streams'\) out = out\.filter\(\(v\) => v\._stream\);\s+else if \(this\._mediaFilter === 'local'\) out = out\.filter\(\(v\) => !v\._stream\);/);
    expect(src).toMatch(/if \(video\._stream\) badges\.appendChild\(this\._streamBadge\(video, 'library__stream-badge--inline'\)\);/);
    expect(src).toMatch(/if \(video\._stream\) this\._getOrCreateBadgesContainer\(thumbnail\)\.appendChild\(this\._streamBadge\(video\)\);/);
    expect(src).toMatch(/fileData\._stream = true;\s+fileData\.pageUrl = video\.pageUrl;/);
  });
});

describe('removing, pairing, and the guards from the audit (2026-11-23)', () => {
  it('Remove takes it out of the library, its picture, its playlists and its categories; a file key is refused', () => {
    const store = {
      'library.streams': [{ key: KEY, pageUrl: ES, title: 'POV', addedAt: 1 }],
      'library.customThumbnails': { [KEY]: { type: 'image', imagePath: 'x.jpg' }, 'C:\\V\\a.mp4': { seekPct: 5 } },
    };
    const l = lib(store);
    l._applyFilters = vi.fn();
    l._container = null;
    l._settings.getPlaylists = () => [{ id: 'p1', videoPaths: ['C:\\V\\a.mp4', KEY] }, { id: 'p2', videoPaths: ['C:\\V\\a.mp4'] }];
    l._settings.removeVideoFromPlaylist = vi.fn();
    l._settings.getVideoCategories = () => ['c1'];
    l._settings.unassignCategory = vi.fn();
    expect(l.removeStream('C:\\V\\a.mp4')).toBe(false);
    expect(l.removeStream(KEY)).toBe(true);
    expect(store['library.streams']).toEqual([]);
    expect(store['library.customThumbnails']).toEqual({ 'C:\\V\\a.mp4': { seekPct: 5 } });
    expect(l._settings.removeVideoFromPlaylist).toHaveBeenCalledWith('p1', KEY);
    expect(l._settings.removeVideoFromPlaylist).toHaveBeenCalledTimes(1);
    expect(l._settings.unassignCategory).toHaveBeenCalledWith(KEY, 'c1');
  });

  it('a script paired in the dialog (an association under its key) is the one it plays', () => {
    const store = {
      'library.streams': [{ key: KEY, pageUrl: ES, title: 'POV', scriptPath: 'C:\\D\\old.funscript', addedAt: 1 }],
      'library.associations': { [KEY]: 'C:\\D\\paired.funscript' },
    };
    const l = lib(store);
    l._mergeStreams();
    expect(l._videosByPath.get(KEY)).toMatchObject({ funscriptPath: 'C:\\D\\paired.funscript', hasFunscript: true });
  });

  it('a stream is available without asking the disk; rehoming never touches a stream key', async () => {
    const { probeAvailability } = await import('../../renderer/js/playlist-availability.js');
    const api = { filesExist: vi.fn(async (paths) => paths.map(() => false)) };
    const ok = await probeAvailability(['C:\\gone.mp4', KEY], api);
    expect([...ok]).toEqual([KEY]);
    expect(api.filesExist).toHaveBeenCalledWith(['C:\\gone.mp4']);
    const { planAssociationRehome, pickRehomeCandidate } = await import('../../renderer/js/association-rehome.js');
    expect(planAssociationRehome({ storedPaths: ['stream:a.com/x/clip'], scannedPaths: ['C:\\V\\clip'], isProvablyGone: () => true })).toEqual([]);
    expect(pickRehomeCandidate({ storedPaths: ['C:\\Old\\abc'], videoPath: 'stream:x.com/v/abc' })).toBe(null);
  });

  it('streams never reach the phone / VR registration, a headset match, duplicates or Stash', () => {
    const src = fs.readFileSync('renderer/components/library.js', 'utf8');
    expect(src).toMatch(/const videosWithOverride = this\._videos\.filter\(\(v\) => !v\._stream\)\.map\(/);
    expect(src).toMatch(/const files = \(this\._videos \|\| \[\]\)\.filter\(\(v\) => !v\._stream\);\s+if \(!files\.length\) return null;/);
    const app = fs.readFileSync('renderer/js/app.js', 'utf8');
    expect(app).toMatch(/getVideos: \(\) => \(this\.library\?\._videos \|\| \[\]\)\.filter\(\(v\) => !v\._stream\),/);
    expect(app).toMatch(/getStashVideos: \(\) => \(this\.library\?\._videos \|\| \[\]\)\.filter\(\(v\) => !v\._stream\),/);
    // A stream key by a path-only route plays as a stream, never file://.
    expect(app).toMatch(/if \(file\?\._isPathBased && !file\._remote && String\(file\.path \?\? ''\)\.startsWith\('stream:'\)\) \{/);
  });
});

describe('the two gaps (2026-11-23): playlist and category tiles, a library of streams alone', () => {
  it('a stream tile in a playlist or category gets its link icon and its length', async () => {
    const { Playlists } = await import('../../renderer/components/playlists.js');
    const { Categories } = await import('../../renderer/components/categories.js');
    for (const View of [Playlists, Categories]) {
      const v = Object.create(View.prototype);
      v._library = { getVideoByPath: (p) => (p === KEY ? { duration: 774, site: 'EroSync' } : null) };
      const thumb = document.createElement('div');
      v._markStreamTile(thumb, KEY);
      v._markStreamTile(thumb, KEY);                                   // twice: still one of each
      expect(thumb.querySelectorAll('.stream-tile-badge')).toHaveLength(1);
      expect(thumb.querySelector('.stream-tile-badge').title).toBe(EN.library.streams.badgeSite.replace('{site}', 'EroSync'));
      expect(thumb.querySelector('.library__duration-badge')?.textContent).toBe('12:54');
      const file = document.createElement('div');
      v._markStreamTile(file, 'C:\\V\\a.mp4');                          // a file: nothing added
      expect(file.children).toHaveLength(0);
    }
  });

  it('with no source folder switched on, saved streams still show (not the add-a-folder screen)', () => {
    const src = fs.readFileSync('renderer/components/library.js', 'utf8');
    expect(src).toMatch(/if \(noneOn && \(this\._settings\.get\(SETTING_STREAMS\) \|\| \[\]\)\.length\) \{\s+this\._mergeStreams\(\);[\s\S]{0,80}this\._renderWithHeader\(\);\s+this\._applyFilters\(\);\s+return;/);
  });

  it('feeds are checked every 15 minutes (Dave, 2026-11-23)', async () => {
    const { CHECK_EVERY_MS } = await import('../../renderer/js/eroscripts-feeds.js');
    expect(CHECK_EVERY_MS).toBe(15 * 60 * 1000);
  });
});

describe('the app', () => {
  const app = fs.readFileSync('renderer/js/app.js', 'utf8');
  it('a saved stream plays through the library path: its page looked up, the fresh stream loaded under its key', () => {
    expect(app).toMatch(/if \(videoData\?\._stream \|\| String\(videoData\?\.path \?\? ''\)\.startsWith\('stream:'\)\) \{\s+loadData = await this\._prepareSavedStream\(videoData\);\s+if \(!loadData\) return undefined;/);
    expect(app).toMatch(/_streamKey: videoData\.path,/);
    expect(app).toMatch(/showToast\(t\('library\.streams\.unavailable'/);
  });
  it('Load URL and Watch save it (the tick, on by default) and Add to queue saves then queues', () => {
    expect(app).toMatch(/initial: this\.settings\?\.get\?\.\(SETTING_SAVE_STREAMS\) !== false,/);
    expect(app).toMatch(/const entry = await this\._saveStream\(info \|\| \{\}\);[\s\S]{0,120}this\.addToUserQueue\(entry\.key\);/);
    expect(app).toMatch(/map\[entry\.key\] = \{ type: 'image', imagePath: r\.path \};/);
    expect(fs.readFileSync('electron/store.js', 'utf8')).toMatch(/streams: \[\],/);
  });
});
