// A file with no video track (an audio file) gets the grey logo tile on
// every surface that shows a thumbnail, not only the Library (N-05, TODO
// triage 2026-11-23, also in v0.9.2):
//   - Playlists / Categories drew a BLANK canvas in their <video> fallback,
//     a black JPEG that went into the SHARED thumbnail cache (the Library
//     reads it first, so its own tile could turn black too);
//   - the queue panel and the Up Next card (also in the player pop-out)
//     kept their loading skeleton for good.
// One builder (renderer/js/no-video-tile.js), one sheet (no-video-tile.css).
//
// REAL components and their <video> fallbacks: jsdom's <video> has no
// decoder, so videoWidth stays 0 as Chromium's does for an audio file, and
// the test fires the media event. Fakes: the backend grab (it fails for
// audio, as it does in the app) and settings.
//
// jsdom (no docblock): DOM, and the components import i18n.js.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import { buildNoVideoTile, fileNameOf } from '../../renderer/js/no-video-tile.js';
import { Playlists } from '../../renderer/components/playlists.js';
import { Categories } from '../../renderer/components/categories.js';
import { QueuePanel } from '../../renderer/components/queue-panel.js';
import { UpNextCard } from '../../renderer/components/up-next-card.js';
import * as thumbCache from '../../renderer/js/thumbnail-cache.js';
import { liftAppClass } from './helpers/app-methods.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
// (2026-11-26) An .mp3 / .m4a now gets its audio tile at once, without ffmpeg or
// a <video> (audio-file-tile.test.js). This file keeps the generic path: a
// file with no picture whose extension does not say so (an audio-only .mp4).
const AUDIO = 'C:\\Lib\\Audio Only.mp4';
const STREAM = 'stream:xvideos.com/video.abc/clip';
let drawn;

function audioMedia() {
  const created = [];
  const realCreate = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag, opts) => {
    const el = realCreate(tag, opts);
    if (String(tag).toLowerCase() === 'video') {
      Object.defineProperty(el, 'duration', { value: 30, configurable: true });
      el.load = () => {};
      created.push(el);
    }
    return el;
  });
  return created;
}

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  document.body.innerHTML = '';
  thumbCache.remove(AUDIO, 0);
  drawn = 0;
  window.funsync = {
    generateSingleThumbnail: vi.fn(async () => { throw new Error('Output file does not contain any stream'); }),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => { drawn++; return 'data:image/jpeg;base64,QkxBQ0s='; });
});
afterEach(() => { vi.restoreAllMocks(); delete window.funsync; });

describe('the builder', () => {
  it('logo + title without its extension, labelled; a stream keeps its title and says Stream; compact is the logo only', () => {
    const tile = buildNoVideoTile('Audio Only.mp4');
    expect(tile.className).toBe('library__thumb-novideo');
    expect(tile.getAttribute('role')).toBe('img');
    expect(tile.getAttribute('aria-label')).toBe(t('library.noVideoTrack'));
    expect(tile.querySelector('.library__thumb-novideo-title').textContent).toBe('Audio Only');
    const stream = buildNoVideoTile('My.Stream', { stream: true, compact: true });
    expect(stream.className).toBe('library__thumb-novideo library__thumb-novideo--compact');
    expect(stream.getAttribute('aria-label')).toBe(t('library.streams.badge'));
    expect(stream.querySelector('.library__thumb-novideo-title').textContent).toBe('My.Stream');
    expect(fileNameOf('C:\\a\\b.mp3')).toBe('b.mp3');
    expect(fileNameOf('/x/y.flac')).toBe('y.flac');
  });

  it('the compact look hides the title (CSS)', () => {
    const css = fs.readFileSync('renderer/styles/no-video-tile.css', 'utf8');
    expect(css).toMatch(/\.library__thumb-novideo--compact \.library__thumb-novideo-title \{\s+display: none;/);
  });
});

for (const [View, prefix] of [[Playlists, 'playlists'], [Categories, 'categories']]) {
  describe(`${View.name}: a playlist / category tile of an audio file`, () => {
    function view() {
      const v = Object.create(View.prototype);
      v._settings = { get: () => ({}), set: () => {} };
      return v;
    }
    function tileEls() {
      const card = document.createElement('div');
      const thumb = document.createElement('div');
      thumb.innerHTML = `<div class="${prefix}__video-placeholder"></div>`;
      card.appendChild(thumb);
      document.body.appendChild(card);
      return { card, thumb };
    }

    it('the <video> fallback answers "no video" and encodes nothing', async () => {
      const media = audioMedia();
      const p = view()._captureFrameViaVideoElement(AUDIO);
      media[0].dispatchEvent(new Event('loadedmetadata'));
      await expect(p).resolves.toEqual({ dataUrl: null, duration: 30, noVideo: true, name: 'Audio Only.mp4' });
      expect(drawn).toBe(0);
    });

    it('the tile shows the grey logo and the title, its length, not "broken"; nothing goes in the shared cache; not asked again', async () => {
      const media = audioMedia();
      const v = view();
      const { card, thumb } = tileEls();
      const load = v._loadVideoThumbnail(card, thumb, AUDIO);
      await vi.waitFor(() => expect(media.length).toBe(1));
      media[0].dispatchEvent(new Event('loadedmetadata'));
      await load;
      const tile = thumb.querySelector('.library__thumb-novideo');
      expect(tile).not.toBeNull();
      expect(tile.querySelector('.library__thumb-novideo-title').textContent).toBe('Audio Only');
      expect(thumb.querySelector(`.${prefix}__video-placeholder`)).toBeNull();
      expect(thumb.querySelector('img')).toBeNull();
      expect(thumb.querySelector('.library__duration-badge')?.textContent).toBe('0:30');
      expect(card.classList.contains(`${prefix}__video-card--broken`)).toBe(false);
      expect(drawn).toBe(0);
      expect(thumbCache.get(AUDIO, 0)).toBeFalsy();
      // A re-render: known, no new backend call, no new <video>.
      const calls = window.funsync.generateSingleThumbnail.mock.calls.length;
      await expect(v._captureFrame(AUDIO)).resolves.toMatchObject({ noVideo: true });
      expect(window.funsync.generateSingleThumbnail.mock.calls.length).toBe(calls);
      expect(media.length).toBe(1);
    });
  });
}

describe('the queue panel', () => {
  function row() {
    const el = document.createElement('div');
    el.innerHTML = '<div class="queue-panel__thumb" data-queue-thumb><div class="queue-panel__thumb-skel"></div></div>';
    return el;
  }
  const panel = (result) => Object.assign(Object.create(QueuePanel.prototype), {
    _library: { _captureVideoFrame: vi.fn(async () => result) },
  });

  it('an audio file: the compact logo tile replaces the skeleton', async () => {
    const r = row();
    await panel({ dataUrl: null, duration: 30, noVideo: true })._loadThumbnail(r, AUDIO);
    const tile = r.querySelector('[data-queue-thumb] .library__thumb-novideo');
    expect(tile?.classList.contains('library__thumb-novideo--compact')).toBe(true);
    expect(tile.getAttribute('aria-label')).toBe(t('library.noVideoTrack'));
    expect(r.querySelector('.queue-panel__thumb-skel')).toBeNull();
  });

  it('a saved stream with no picture says Stream; a real frame is still a picture; a failure keeps the skeleton', async () => {
    const s = row();
    await panel({ noVideo: true, duration: 0 })._loadThumbnail(s, STREAM);
    expect(s.querySelector('.library__thumb-novideo').getAttribute('aria-label')).toBe(t('library.streams.badge'));
    const v = row();
    await panel({ dataUrl: 'data:image/jpeg;base64,QQ==' })._loadThumbnail(v, 'C:\\Lib\\Clip.mp4');
    expect(v.querySelector('.queue-panel__thumb-img')).not.toBeNull();
    expect(v.querySelector('.library__thumb-novideo')).toBeNull();
    const f = row();
    await panel(null)._loadThumbnail(f, 'C:\\Lib\\Gone.mp4');
    expect(f.querySelector('.queue-panel__thumb-skel')).not.toBeNull();
  });
});

describe('the Up Next card', () => {
  function card(captureFrame) {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const c = new UpNextCard({ element: el, library: { getVideoByPath: () => ({ name: 'Audio Only.mp4', duration: 30 }) }, captureFrame });
    return { c, el };
  }

  it('an audio file: the compact logo tile replaces the skeleton', async () => {
    const { c, el } = card(async () => ({ noVideo: true }));
    c.show(AUDIO, 10);
    await vi.waitFor(() => expect(el.querySelector('.up-next__thumb .library__thumb-novideo')).not.toBeNull());
    expect(el.querySelector('.up-next__thumb .library__thumb-novideo').classList.contains('library__thumb-novideo--compact')).toBe(true);
    expect(el.querySelector('.up-next__thumb-skeleton')).toBeNull();
    expect(el.querySelector('.up-next__thumb-img')).toBeNull();
    c.hide();
  });

  it('a card that moved on, or already has a picture, is left alone (the pop-out is sent it too)', () => {
    const { c, el } = card(null);
    c.show(AUDIO, 10);
    c.setNoVideoThumbnail('C:\\Lib\\Other.mp3');
    expect(el.querySelector('.library__thumb-novideo')).toBeNull();
    c.setThumbnail(AUDIO, 'data:image/jpeg;base64,QQ==');
    c.setNoVideoThumbnail(AUDIO);
    expect(el.querySelector('.library__thumb-novideo')).toBeNull();
    c.hide();
    const src = fs.readFileSync('renderer/player-popout.js', 'utf8');
    expect(src).toContain('if (payload.thumbNoVideo) upNextCard.setNoVideoThumbnail(payload.path, { stream: !!payload.thumbStream });');
    expect(fs.readFileSync('renderer/js/app.js', 'utf8')).toContain("else if (r?.noVideo) this._relayUpNext({ action: 'thumb', path, thumbNoVideo: true, thumbStream: !!r.stream });");
  });

  it('app.js asks once and says "no video" (a stream says so too); a real frame is still a picture', async () => {
    const App = liftAppClass(['_captureUpNextThumb'], {
      customThumbImagePath: () => null,
      thumbRequestOpts: () => ({ seekPct: 0.1, exact: false }),
    });
    const app = Object.assign(new App(), {
      library: { _captureVideoFrame: vi.fn(async (p) => (p === AUDIO || p === STREAM ? { dataUrl: null, noVideo: true } : { dataUrl: 'data:x' })) },
    });
    await expect(app._captureUpNextThumb(AUDIO)).resolves.toEqual({ noVideo: true, stream: false });
    await expect(app._captureUpNextThumb(STREAM)).resolves.toEqual({ noVideo: true, stream: true });
    await expect(app._captureUpNextThumb('C:\\Lib\\Clip.mp4')).resolves.toEqual({ dataUrl: 'data:x' });
    expect(window.funsync.generateSingleThumbnail).not.toHaveBeenCalled();
  });
});
