// N-05 (Dave 2026-11-08: "audio files just show up as black screens in the
// libary so could we possibly have like a muted gray version of the apps logo
// and possibly the title appear on the thumbnail"; also in v0.9.2).
//
// The backend's single-frame grab fails for a file with no video stream, and
// the Library fell back to a hidden <video>: `seeked` fired with videoWidth 0,
// nothing was drawn, and the blank 320x180 canvas encoded to a BLACK JPEG,
// which was cached and shown as the tile. Now the fallback answers "no
// video", and the card and the list row show the app logo in grey with the
// file's title (the list row's thumb shows the logo only; the title is right
// beside it). A poster the user uploads replaces it, and nothing is stored.
//
// REAL Library card / list rendering, `_loadThumbnail` and the <video>
// fallback (jsdom's <video> has no decoder: videoWidth stays 0, as Chromium's
// does for an audio file, and the test fires its media events). Fakes: the
// backend thumbnail call (it fails, as it does for audio) and settings.
//
// jsdom (no docblock): DOM rendering, and library.js imports i18n.js, which
// branches on `typeof window`. See notes/CLAUDE.md "Test environments".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Library } from '../../renderer/components/library.js';
import * as thumbCache from '../../renderer/js/thumbnail-cache.js';
import { t } from '../../renderer/js/i18n.js';

// (2026-11-26) An .mp3 / .m4a now gets its audio tile at once, without ffmpeg or
// a <video> (audio-file-tile.test.js). This file keeps the generic path: a
// file with no picture whose extension does not say so (an audio-only .mp4).
const AUDIO = 'C:\\Lib\\Audio Only.mp4';
const VIDEO = 'C:\\Lib\\Real Clip.mp4';

let lib;
let store;
let writes;
let drawn;

function audioMedia() {
  // What Chromium reports for an audio-only file: metadata with a duration
  // and no picture (videoWidth / videoHeight 0).
  const created = [];
  const realCreate = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag, opts) => {
    const el = realCreate(tag, opts);
    if (String(tag).toLowerCase() === 'video') {
      Object.defineProperty(el, 'duration', { value: 30, configurable: true });
      created.push(el);
    }
    return el;
  });
  return created;
}

beforeEach(() => {
  thumbCache.clear?.();
  thumbCache.remove(AUDIO, 0);
  thumbCache.remove(VIDEO, 0);
  store = { 'library.viewMode': 'grid', 'library.customThumbnails': {} };
  writes = [];
  drawn = 0;
  const settings = {
    get: (k) => store[k],
    set: (k, v) => { writes.push(k); store[k] = v; },
    getVideoCategories: () => [],
    getCategories: () => [],
  };
  lib = new Library({ settings });
  const videos = [
    { name: 'Audio Only.mp4', path: AUDIO, hasFunscript: false, variants: [] },
    { name: 'Real Clip.mp4', path: VIDEO, hasFunscript: false, variants: [] },
  ];
  lib._videos = videos;
  lib._videosByPath = new Map(videos.map((v) => [v.path, v]));
  lib._queueThumbnail = () => {};
  window.funsync = {
    // The backend's ffmpeg grab fails for a file with no video stream.
    generateSingleThumbnail: vi.fn(async () => { throw new Error('Output file does not contain any stream'); }),
    readCustomThumbnail: vi.fn(async () => ({ dataUrl: 'data:image/png;base64,UE9TVEVS' })),
  };
  // A canvas that records whether anything was encoded from it.
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => { drawn++; return 'data:image/jpeg;base64,QkxBQ0s='; });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete window.funsync;
  document.body.innerHTML = '';
});

/** Run `_loadThumbnail` on `el` and play the audio file's media events. */
async function loadAudioThumb(el) {
  const media = audioMedia();
  const done = lib._loadThumbnail(el, AUDIO);
  await vi.waitFor(() => expect(media.length).toBe(1));
  media[0].dispatchEvent(new Event('loadedmetadata'));
  media[0].dispatchEvent(new Event('seeked'));
  await done;
}

const tileOf = (el) => el.querySelector('.library__thumb-novideo');

describe('N-05: a file with no video track gets the grey logo tile, not a black frame', () => {
  it('the <video> fallback answers "no video" and encodes nothing', async () => {
    const media = audioMedia();
    const p = lib._captureVideoFrameViaVideoElement(AUDIO);
    media[0].dispatchEvent(new Event('loadedmetadata'));
    await expect(p).resolves.toEqual({ dataUrl: null, duration: 30, noVideo: true });
    expect(drawn).toBe(0);
  });

  it('a card shows the logo and the title, sized as a thumbnail, and stops loading', async () => {
    const card = lib._createCard(lib._videosByPath.get(AUDIO));
    document.body.appendChild(card);
    await loadAudioThumb(card);

    const tile = tileOf(card);
    expect(tile).not.toBeNull();
    expect(tile.parentElement.classList.contains('library__card-thumbnail')).toBe(true);
    expect(tile.querySelector('.library__thumb-novideo-logo')).not.toBeNull();
    expect(tile.querySelector('.library__thumb-novideo-title').textContent).toBe('Audio Only');
    expect(tile.getAttribute('aria-label')).toBe(t('library.noVideoTrack'));
    expect(card.dataset.loaded).toBe('true');
    // No black picture: no image in the tile area, none encoded, none cached.
    expect(card.querySelector('.library__card-thumbnail img')).toBeNull();
    expect(card.querySelector('.library__card-placeholder')).toBeNull();
    expect(drawn).toBe(0);
    expect(thumbCache.get(AUDIO, 0)).toBeFalsy();
    // Its length is still shown.
    expect(card.querySelector('.library__duration-badge')?.textContent).toBe('0:30');
    expect(writes).toEqual([]);
  });

  it('a list row shows the logo tile in its thumb, the row keeps its own title', async () => {
    const row = lib._createListItem(lib._videosByPath.get(AUDIO));
    document.body.appendChild(row);
    await loadAudioThumb(row);
    const tile = tileOf(row);
    expect(tile?.parentElement.classList.contains('library__list-thumb')).toBe(true);
    expect(row.querySelector('.library__list-title').textContent).toBe('Audio Only');
    expect(row.dataset.loaded).toBe('true');
    expect(row.querySelector('.library__list-thumb img')).toBeNull();
  });

  it('a card or row built again (scroll, re-render) shows the tile at once, with no new capture', async () => {
    const card = lib._createCard(lib._videosByPath.get(AUDIO));
    await loadAudioThumb(card);
    window.funsync.generateSingleThumbnail.mockClear();
    const again = lib._createCard(lib._videosByPath.get(AUDIO));
    expect(tileOf(again)).not.toBeNull();
    expect(again.dataset.loaded).toBe('true');
    const row = lib._createListItem(lib._videosByPath.get(AUDIO));
    expect(tileOf(row)).not.toBeNull();
    expect(window.funsync.generateSingleThumbnail).not.toHaveBeenCalled();
  });

  it('a poster the user uploads replaces the tile; the tile never stores anything', async () => {
    const card = lib._createCard(lib._videosByPath.get(AUDIO));
    await loadAudioThumb(card);
    expect(tileOf(card)).not.toBeNull();

    store['library.customThumbnails'] = { [AUDIO]: { type: 'image', imagePath: 'C:\\ud\\custom-thumbs\\a.png' } };
    await lib._refreshCardThumbnail(AUDIO, card);
    expect(tileOf(card)).toBeNull();
    expect(card.querySelector('.library__card-thumbnail img').src).toBe('data:image/png;base64,UE9TVEVS');
    // Built again: the poster, not the tile.
    expect(tileOf(lib._createCard(lib._videosByPath.get(AUDIO)))).toBeNull();
    expect(writes).toEqual([]);
  });

  // Fix-up review 2026-11-16 (nit): the session's no-picture memory was
  // never checked again, so a file replaced by a real video kept the logo
  // tile until a relaunch. The header's Refresh now looks again.
  it('Refresh looks again: a file replaced by a real video during the session gets its frame', async () => {
    const card = lib._createCard(lib._videosByPath.get(AUDIO));
    await loadAudioThumb(card);
    expect(tileOf(lib._createCard(lib._videosByPath.get(AUDIO)))).not.toBeNull();

    // The user drops a real video at the same path and presses Refresh.
    store['library.sources'] = [{ path: 'C:\\Lib', name: 'Lib' }];
    lib._scanDirectory = vi.fn(async () => {});
    await lib.refresh();
    expect(lib._scanDirectory).toHaveBeenCalledTimes(1);

    const again = lib._createCard(lib._videosByPath.get(AUDIO));
    expect(tileOf(again), 'the logo tile outlived a Refresh').toBeNull();
    window.funsync.generateSingleThumbnail = vi.fn(async () => ({ dataUrl: 'data:image/jpeg;base64,TkVX', duration: 9 }));
    await lib._loadThumbnail(again, AUDIO);
    expect(tileOf(again)).toBeNull();
    expect(again.querySelector('.library__card-thumbnail img').src).toBe('data:image/jpeg;base64,TkVX');
    expect(writes).toEqual([]);
  });

  it('a real video is unaffected: its frame is the tile', async () => {
    window.funsync.generateSingleThumbnail = vi.fn(async () => ({ dataUrl: 'data:image/jpeg;base64,RlJBTUU=', duration: 12 }));
    const card = lib._createCard(lib._videosByPath.get(VIDEO));
    await lib._loadThumbnail(card, VIDEO);
    expect(tileOf(card)).toBeNull();
    expect(card.querySelector('.library__card-thumbnail img').src).toBe('data:image/jpeg;base64,RlJBTUU=');
  });
});

describe('N-05: the grey logo ships with the app and the tile has a look in both themes', () => {
  // The tile's look lives in its own sheet since 2026-11-23 (shared with
  // Playlists, Categories, the queue panel and Up Next, also in the pop-out).
  const css = fs.readFileSync('renderer/styles/no-video-tile.css', 'utf8');

  it('the sheet is linked by the main window and the player pop-out', () => {
    for (const page of ['renderer/index.html', 'renderer/player-popout.html']) {
      expect(fs.readFileSync(page, 'utf8'), page).toContain('<link rel="stylesheet" href="styles/no-video-tile.css">');
    }
    expect(fs.readFileSync('renderer/styles/library.css', 'utf8')).not.toMatch(/^\.library__thumb-novideo \{/m);
  });

  it('the logo the CSS points at is a PNG inside renderer/ (electron-builder packs renderer/**)', () => {
    const m = css.match(/\.library__thumb-novideo-logo\s*{[^}]*url\('([^']+)'\)/);
    expect(m).not.toBeNull();
    const file = path.resolve('renderer/styles', m[1]);
    expect(file.startsWith(path.resolve('renderer'))).toBe(true);
    expect(fs.readFileSync(file).subarray(1, 4).toString()).toBe('PNG');
  });

  it('the light theme gives the tile its own background', () => {
    expect(css).toMatch(/:root\[data-theme="light"\] \.library__thumb-novideo\s*{[^}]*--novideo-bg:/);
  });
});
