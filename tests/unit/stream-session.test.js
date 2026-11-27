/**
 * @vitest-environment node
 * No DOM required: the pure stream helpers (renderer/js/stream-session.js)
 * and the app's use of them, read from its source.
 *
 * 2026-11-23, the streaming UX pass: a stream keeps its own sync offset, and
 * a script made for another cut of the video is said out loud.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { streamOffsetKey, streamCutWarning, metaDurationSeconds, clockText } from '../../renderer/js/stream-session.js';

describe('streamOffsetKey', () => {
  it('one key per video page: no query, no fragment, no www, no trailing slash', () => {
    expect(streamOffsetKey('https://www.pmvhaven.com/video/cook_6aac134b1d82327005594a39?from=profile-favorites'))
      .toBe('stream:pmvhaven.com/video/cook_6aac134b1d82327005594a39');
    expect(streamOffsetKey('https://faptap.net/v/2107858395183714305/#t=10')).toBe('stream:faptap.net/v/2107858395183714305');
    expect(streamOffsetKey('https://cdn.example/clip.mp4?sig=abc&exp=1')).toBe('stream:cdn.example/clip.mp4');
  });
  it('the query picks the video on some sites: kept, sorted, tracking and signatures left out (audit 2026-11-23)', () => {
    expect(streamOffsetKey('https://www.youtube.com/watch?v=abc&t=42&utm_source=x'))
      .toBe('stream:youtube.com/watch?v=abc');
    expect(streamOffsetKey('https://www.pornhub.com/view_video.php?viewkey=64e8791e46f17'))
      .not.toBe(streamOffsetKey('https://www.pornhub.com/view_video.php?viewkey=other'));
    expect(streamOffsetKey('https://x.com/v?b=2&a=1')).toBe('stream:x.com/v?a=1&b=2');
    expect(streamOffsetKey('https://s3.example/v.mp4?X-Amz-Signature=s&X-Amz-Expires=9')).toBe('stream:s3.example/v.mp4');
  });
  it('EroSync: the embed and the video page are the same video', () => {
    const id = 'abc6d128-7035-44d3-88a4-64dd63a2bc5f';
    expect(streamOffsetKey(`https://erosync.net/embed/${id}`)).toBe(streamOffsetKey(`https://erosync.net/videos/${id}`));
  });
  it('nothing for what is not a web page', () => {
    expect(streamOffsetKey('')).toBe(null);
    expect(streamOffsetKey('file:///C:/a.mp4')).toBe(null);
    expect(streamOffsetKey('not a url')).toBe(null);
  });
});

describe('streamCutWarning', () => {
  it('a script that runs more than a second past the end of the stream', () => {
    expect(streamCutWarning({ scriptEndMs: 790_000, videoDurationS: 774 })).toEqual({ kind: 'pastEnd', scriptS: 790, videoS: 774 });
    expect(streamCutWarning({ scriptEndMs: 774_800, videoDurationS: 774 })).toBe(null);   // within a second
  });
  it('a recorded length more than 3 s from the stream (seconds, or milliseconds when too large for seconds)', () => {
    expect(streamCutWarning({ scriptEndMs: 700_000, metaDurationS: 816, videoDurationS: 774 })).toEqual({ kind: 'length', diffS: -42 });
    expect(streamCutWarning({ scriptEndMs: 700_000, metaDurationS: 776, videoDurationS: 774 })).toBe(null);
    expect(metaDurationSeconds(964_000)).toBe(964);
    expect(metaDurationSeconds('964')).toBe(964);
    expect(metaDurationSeconds(0)).toBe(null);
  });
  it('unknown lengths say nothing', () => {
    expect(streamCutWarning({ scriptEndMs: 900_000, videoDurationS: NaN })).toBe(null);
    expect(streamCutWarning({ scriptEndMs: null, metaDurationS: null, videoDurationS: 774 })).toBe(null);
  });
  it('clockText', () => {
    expect([clockText(74), clockText(-42), clockText(3725)]).toEqual(['1:14', '0:42', '1:02:05']);
  });
});

describe('the app', () => {
  const app = fs.readFileSync('renderer/js/app.js', 'utf8');
  it('a stream offers its own "This video" offset, kept under its page, never re-homed', () => {
    expect(app).toMatch(/if \(!this\._currentVideoPath && this\._remoteSession\?\.offsetKey\) return this\._remoteSession\.offsetKey;/);
    expect(app).toMatch(/offsetKey: streamOffsetKey\(pageUrl\),/);
    expect(app).toMatch(/if \(String\(videoPath\)\.startsWith\('stream:'\)\) return 0;/);
  });
  it('the cut is checked once both the length and the script are known', () => {
    expect(app).toMatch(/addEventListener\('loadedmetadata', \(\) => \{ if \(this\._remoteSession\) this\._checkStreamCut\(\); \}\)/);
    expect(app).toMatch(/await this\.loadFunscript\(\{ name, textContent: content, path: scriptPath \}\);\s+this\._checkStreamCut\(\);/);
    expect(app).toMatch(/if \(!s \|\| s\.cutChecked \|\| !this\.funscriptEngine\?\.isLoaded \|\| !\(video\?\.duration > 0\)\) return;/);
  });
});
