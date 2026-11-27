/**
 * @vitest-environment jsdom
 * jsdom: the tiles are DOM; i18n.js branches on `typeof window`
 * (notes/CLAUDE.md "Test environments").
 */
// Dave's log, 2026-11-26: every launch asked ffmpeg for a frame of each of
// the ~15 .mp3 / .m4a files in his Downloads source, and each came back 500
// ("Output file does not contain any stream"), then a hidden <video> tried
// too. An audio file now gets its tile at once ("Audio" chip), in every view,
// and nothing asks ffmpeg for a picture it does not have.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { buildNoVideoTile } = await import('../../renderer/js/no-video-tile.js');
const { Library } = await import('../../renderer/components/library.js');
const { Playlists } = await import('../../renderer/components/playlists.js');
const { Categories } = await import('../../renderer/components/categories.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const SONG = 'C:\\Users\\user\\Downloads\\Airport Lounge.mp3';

let api;
beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  api = {
    generateSingleThumbnail: vi.fn(async () => { throw new Error('Backend returned 500'); }),
    readCustomThumbnail: vi.fn(async () => null),
  };
  window.funsync = api;
});
afterEach(() => { delete window.funsync; });

describe('the audio tile', () => {
  it('an audio file name gets the "Audio" chip and its label', () => {
    const tile = buildNoVideoTile('Airport Lounge.mp3');
    expect(tile.classList.contains('library__thumb-novideo--audio')).toBe(true);
    expect(tile.querySelector('.library__thumb-novideo-mark').textContent).toBe(EN.library.audioTile.mark);
    expect(tile.getAttribute('aria-label')).toBe(EN.library.audioTile.label);
    expect(tile.querySelector('.library__thumb-novideo-title').textContent).toBe('Airport Lounge');
  });
  it('not for a video without a picture, a saved stream or a script', () => {
    expect(buildNoVideoTile('Clip.mp4').classList.contains('library__thumb-novideo--audio')).toBe(false);
    expect(buildNoVideoTile('Remote.mp3', { stream: true }).classList.contains('library__thumb-novideo--audio')).toBe(false);
    expect(buildNoVideoTile('Loop', { script: true }).querySelector('.library__thumb-novideo-mark').textContent).toBe(EN.library.scripts.mark);
  });
  it('a caller can say so when its name has no extension (the queue, Up Next)', () => {
    expect(buildNoVideoTile('Airport Lounge', { audio: true }).classList.contains('library__thumb-novideo--audio')).toBe(true);
  });
});

describe('no frame is asked for an audio file', () => {
  it('the library: the tile at once, never ffmpeg or a <video>', async () => {
    const ctx = Object.assign(Object.create(Library.prototype), {
      _settings: { get: () => ({}) },
      _videosByPath: new Map([[SONG, { duration: 180 }]]),
      _captureVideoFrameViaVideoElement: vi.fn(),
    });
    const result = await ctx._captureVideoFrameUncached(SONG);
    expect(result).toEqual({ noVideo: true, audio: true, duration: 180 });
    expect(api.generateSingleThumbnail).not.toHaveBeenCalled();
    expect(ctx._captureVideoFrameViaVideoElement).not.toHaveBeenCalled();
  });

  it('its length when the scan has none: ffprobe\'s (metadata), for the badge; never a frame', async () => {
    api.fetchMetadata = vi.fn(async () => ({ duration: 212.4 }));
    const ctx = Object.assign(Object.create(Library.prototype), {
      _settings: { get: () => ({}) },
      _videosByPath: new Map([[SONG, {}]]),
    });
    expect(await ctx._captureVideoFrameUncached(SONG)).toEqual({ noVideo: true, audio: true, duration: 212.4 });
    expect(api.fetchMetadata).toHaveBeenCalledWith(SONG);
    expect(api.generateSingleThumbnail).not.toHaveBeenCalled();
  });

  it('a poster you set for it still wins', async () => {
    api.readCustomThumbnail = vi.fn(async () => ({ dataUrl: 'data:image/jpeg;base64,AA' }));
    const ctx = Object.assign(Object.create(Library.prototype), {
      _settings: { get: (k) => (k === 'library.customThumbnails' ? { [SONG]: { type: 'image', imagePath:'C:\\thumbs\\p.jpg' } } : {}) },
      _videosByPath: new Map(),
    });
    expect(await ctx._captureVideoFrameUncached(SONG)).toEqual({ dataUrl: 'data:image/jpeg;base64,AA', duration: 0 });
    expect(api.generateSingleThumbnail).not.toHaveBeenCalled();
  });

  for (const [label, Cls] of [['a playlist', Playlists], ['a category', Categories]]) {
    it(`${label}: the tile, never ffmpeg`, async () => {
      const ctx = Object.assign(Object.create(Cls.prototype), {
        _settings: { get: () => ({}) },
        _library: { getVideoByPath: () => ({ duration: 180 }) },
        _captureFrameViaVideoElement: vi.fn(),
      });
      const result = await ctx._captureFrameUncached(SONG);
      expect(result).toEqual({ noVideo: true, audio: true, name: 'Airport Lounge.mp3', duration: 180 });
      expect(api.generateSingleThumbnail).not.toHaveBeenCalled();
      expect(ctx._captureFrameViaVideoElement).not.toHaveBeenCalled();
    });
  }

  it('a video still asks ffmpeg (nothing else changed)', async () => {
    api.generateSingleThumbnail = vi.fn(async () => ({ dataUrl: 'data:image/jpeg;base64,BB', duration: 9 }));
    const ctx = Object.assign(Object.create(Library.prototype), { _settings: { get: () => ({}) }, _videosByPath: new Map() });
    expect(await ctx._captureVideoFrameUncached('C:\\Lib\\Clip.mp4')).toEqual({ dataUrl: 'data:image/jpeg;base64,BB', duration: 9 });
    expect(api.generateSingleThumbnail).toHaveBeenCalledTimes(1);
  });
});
