/**
 * @vitest-environment jsdom
 * jsdom: the CC menu is DOM and i18n.js branches on `typeof window`
 * (notes/CLAUDE.md "Test environments").
 *
 * Embedded subtitles (#268 thirstyduck500, 2026-11-23): a file's own text
 * subtitle streams load when no subtitle file sits beside it; picture ones
 * (PGS / VobSub) are named as unshowable, never silently dropped.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import { languageName, subtitleTrackLabel, pickEmbeddedTrack, mayHaveEmbeddedSubtitles } from '../../renderer/js/subtitle-tracks.js';
import { liftAppClass } from './helpers/app-methods.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const SRT_EN = { index: 2, codec: 'subrip', language: 'eng', title: '', default: false, forced: false, text: true };
const SRT_JA = { index: 3, codec: 'subrip', language: 'jpn', title: 'Signs', default: true, forced: false, text: true };
const PGS = { index: 4, codec: 'hdmv_pgs_subtitle', language: 'eng', title: '', default: false, forced: false, text: false };

beforeEach(() => _setBundlesForTests('en', EN, EN));

describe('which track, and what to call it', () => {
  it('the default-flagged text track, shown; else forced, shown; else the first, loaded but off; none: null', () => {
    expect(pickEmbeddedTrack([SRT_EN, SRT_JA, PGS])).toEqual({ track: SRT_JA, show: true });
    expect(pickEmbeddedTrack([SRT_EN, { ...SRT_JA, default: false, forced: true }])).toEqual({ track: { ...SRT_JA, default: false, forced: true }, show: true });
    expect(pickEmbeddedTrack([SRT_EN, { ...SRT_JA, default: false }])).toEqual({ track: SRT_EN, show: false });
    expect(pickEmbeddedTrack([PGS])).toBeNull();
    expect(pickEmbeddedTrack([])).toBeNull();
  });

  it('labels: title (language), the language alone, Track N; a picture track says it cannot be shown', () => {
    expect(languageName('eng')).toBe('English');
    expect(languageName('jpn')).toBe('Japanese');
    expect(languageName('und')).toBe('');
    expect(subtitleTrackLabel(SRT_EN, 1, t)).toBe('English');
    expect(subtitleTrackLabel(SRT_JA, 2, t)).toBe('Signs (Japanese)');
    expect(subtitleTrackLabel({ ...SRT_EN, language: '' }, 3, t)).toBe('Track 3');
    expect(subtitleTrackLabel(PGS, 4, t)).toBe("English: pictures, can't be shown");
    expect(languageName('eng', 'de')).toBe('Englisch');
  });

  it('only container files are asked about', () => {
    expect(mayHaveEmbeddedSubtitles('C:\\V\\a.mkv')).toBe(true);
    expect(mayHaveEmbeddedSubtitles('C:\\V\\a.MP4')).toBe(true);
    expect(mayHaveEmbeddedSubtitles('C:\\V\\a.avi')).toBe(false);
    expect(mayHaveEmbeddedSubtitles('stream:x.com/v/1')).toBe(false);
  });
});

describe('the app', () => {
  const toasts = [];
  let App;
  let app;
  beforeEach(() => {
    toasts.length = 0;
    document.body.innerHTML = '<span id="subtitle-badge" hidden></span><div id="subtitle-menu" hidden></div>';
    App = liftAppClass(['_loadEmbeddedSubtitles', '_useEmbeddedSubtitle', '_showSubtitleBadgeForMenu', '_paintSubtitleMenu'], {
      showToast: (msg, kind) => toasts.push([msg, kind]),
      t, getCurrentLocale: () => 'en', subtitleTrackLabel, pickEmbeddedTrack, mayHaveEmbeddedSubtitles,
      document, window,
    });
    app = new App();
    app._videoLoadGen = 1;
    app.videoPlayer = { loadSubtitles: vi.fn(async () => {}), video: { textTracks: [] } };
    window.funsync = {};
  });

  it('loads the default text track as WebVTT, shown; the menu lists every track, the picture one greyed', async () => {
    window.funsync.subtitleTracks = vi.fn(async () => [SRT_EN, SRT_JA, PGS]);
    window.funsync.subtitleTrack = vi.fn(async () => ({ vtt: 'WEBVTT\n\n00:01.000 --> 00:02.000\nhi\n' }));
    await app._loadEmbeddedSubtitles('C:\\V\\film.mkv');
    expect(window.funsync.subtitleTrack).toHaveBeenCalledWith('C:\\V\\film.mkv', 3);
    expect(app.videoPlayer.loadSubtitles).toHaveBeenCalledWith({ name: 'Signs (Japanese).vtt', textContent: expect.stringContaining('WEBVTT') }, { show: true });
    app.videoPlayer.video.textTracks = [{ mode: 'showing' }];
    app._paintSubtitleMenu();
    const items = [...document.querySelectorAll('#subtitle-menu button')];
    expect(items.map((b) => b.textContent)).toEqual(['Off', 'English', 'Signs (Japanese)', "English: pictures, can't be shown"]);
    expect(items[2].getAttribute('aria-checked')).toBe('true');
    expect(items[3].disabled).toBe(true);
    expect(toasts).toEqual([]);
  });

  it('only picture subtitles: the CC button shows (for the menu) and it says so once per file', async () => {
    window.funsync.subtitleTracks = vi.fn(async () => [PGS]);
    window.funsync.subtitleTrack = vi.fn();
    await app._loadEmbeddedSubtitles('C:\\V\\bd.mkv');
    await app._loadEmbeddedSubtitles('C:\\V\\bd.mkv');
    expect(window.funsync.subtitleTrack).not.toHaveBeenCalled();
    expect(document.getElementById('subtitle-badge').hidden).toBe(false);
    expect(toasts).toEqual([[EN.player.subtitles.pictureOnly, 'info']]);
  });

  it('another video loaded meanwhile: nothing lands on it; no tracks or not a container: nothing asked', async () => {
    let release;
    window.funsync.subtitleTracks = vi.fn(() => new Promise((r) => { release = () => r([SRT_EN]); }));
    window.funsync.subtitleTrack = vi.fn();
    const p = app._loadEmbeddedSubtitles('C:\\V\\a.mkv');
    app._videoLoadGen = 2; // the next video
    release();
    await p;
    expect(window.funsync.subtitleTrack).not.toHaveBeenCalled();
    window.funsync.subtitleTracks = vi.fn();
    await app._loadEmbeddedSubtitles('C:\\V\\a.avi');
    expect(window.funsync.subtitleTracks).not.toHaveBeenCalled();
  });

  it('wired: a video with no subtitle file asks for its own; each new video forgets the last one\'s tracks', () => {
    const src = fs.readFileSync('renderer/js/app.js', 'utf8');
    expect(src).toMatch(/\} else if \(!videoData\?\._remote && !videoData\?\._stream\) \{\s+\/\/ No subtitle file beside it[^\n]*\n\s+this\._loadEmbeddedSubtitles\?\.\(videoData\?\.path\);/);
    expect(src).toMatch(/this\.videoPlayer\.clearSubtitles\(\);\s+\/\/ Its subtitle streams[^\n]*\n\s+this\._embeddedSubs = null;/);
    const vp = fs.readFileSync('renderer/js/video-player.js', 'utf8');
    expect(vp).toMatch(/async loadSubtitles\(file, \{ show = true \} = \{\}\)/);
    // The one-track CC toggle turns on the NEWEST track, never a previous
    // video's emptied one still sitting at [0].
    expect(src).toMatch(/tracks\[tracks\.length - 1\]\.mode = 'showing';/);
    expect(src).not.toMatch(/tracks\[0\]\.mode = 'showing';/);
  });
});
