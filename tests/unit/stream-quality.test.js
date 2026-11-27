/**
 * @vitest-environment node
 * No DOM required: the pure level rules, and VideoPlayer's quality methods
 * against a fake hls.js instance.
 *
 * Dave, 2026-11-22: "the quality went really poor can we do anything to remedy that?"
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { HLS_QUALITY_CONFIG, normalizeStreamQuality, pickLevelIndex, levelHeights, progressiveMaxHeight, pickProgressiveIndex } from '../../renderer/js/stream-quality.js';

describe('single-file streams (one file per height, 2026-11-23)', () => {
  it('Auto takes 720p unless the line measured 10 Mbit/s or more; a held height is the limit', () => {
    expect(progressiveMaxHeight('auto', 0)).toBe(720);
    expect(progressiveMaxHeight('auto', 9_000_000)).toBe(720);
    expect(progressiveMaxHeight('auto', 12_000_000)).toBe(null);
    expect(progressiveMaxHeight(480, 50_000_000)).toBe(480);
  });
  it('the file for a limit: the tallest under it, else the shortest; no limit, the tallest', () => {
    const files = [{ height: 1080 }, { height: 720 }, { height: 480 }, { height: 360 }];
    expect(pickProgressiveIndex(files, 720)).toBe(1);
    expect(pickProgressiveIndex(files, null)).toBe(0);
    expect(pickProgressiveIndex(files, 240)).toBe(3);
    expect(pickProgressiveIndex([], 720)).toBe(-1);
  });
  it('the app: one lookup with the limit for Load URL, Watch and a reconnect; the chip lists the files and switches at the same second', () => {
    const app = fs.readFileSync('renderer/js/app.js', 'utf8');
    expect(app).toMatch(/return window\.funsync\.resolveRemoteVideo\(url, maxHeight \? \{ maxHeight \} : \{\}\);/);
    expect(app).toMatch(/try \{ res = await this\._resolveStream\(session\.pageUrl\); \}/);
    expect(app).toMatch(/resolve: \(url\) => this\._resolveStream\(url\),/);
    expect(app).toMatch(/resolveStream: \(url\) => this\._resolveStream\(url\),/);
    expect(app).toMatch(/if \(info\.progressive\) this\._switchProgressive\(value\);/);
    expect(app).toMatch(/await this\.videoPlayer\.swapSource\(level\.proxyUrl, \{ isHls: false, at, play \}\);/);
    expect(app).toMatch(/t\('player\.stream\.tryLower', \{ height: lower\.height \}\)/);
    const main = fs.readFileSync('electron/main.js', 'utf8');
    expect(main).toMatch(/levels: \(body\.levels \|\| \[\]\)\.map\(\(l\) => \(\{ height: l\.height, proxyUrl: `http:\/\/localhost:\$\{port\}\$\{l\.proxyUrl\}` \}\)\),/);
    expect(main).toMatch(/&maxHeight=\$\{maxHeight\}/);
    expect(fs.readFileSync('renderer/components/eroscripts-view.js', 'utf8')).toMatch(/res = await this\._resolveStream\(tries\[i\]\.url\);/);
  });
});

const LEVELS = [{ height: 250 }, { height: 480 }, { height: 360 }, { height: 720 }, { height: 1080 }];

describe('stream quality rules', () => {
  it('starts high and buffers further ahead than hls.js would', () => {
    expect(HLS_QUALITY_CONFIG.abrEwmaDefaultEstimate).toBeGreaterThanOrEqual(5_000_000);   // hls.js: 500 kbit/s
    expect(HLS_QUALITY_CONFIG.maxBufferLength).toBeGreaterThanOrEqual(60);                  // hls.js: 30 s
  });
  it('a held height: the tallest at or under it; else the shortest; auto: -1', () => {
    expect(pickLevelIndex(LEVELS, 720)).toBe(3);
    expect(pickLevelIndex(LEVELS, 600)).toBe(1);          // 480
    expect(pickLevelIndex(LEVELS, 100)).toBe(0);          // nothing that low: the shortest
    expect(pickLevelIndex(LEVELS, 'auto')).toBe(-1);
    expect(pickLevelIndex([], 720)).toBe(-1);
    expect(normalizeStreamQuality('720')).toBe(720);
    expect(normalizeStreamQuality('best?')).toBe('auto');
    expect(levelHeights(LEVELS)).toEqual([1080, 720, 480, 360, 250]);
  });
});

describe('VideoPlayer holds the choice on its stream', () => {
  it('setStreamQuality switches the level now and reports it; auto hands it back', async () => {
    const { VideoPlayer } = await import('../../renderer/js/video-player.js');
    const vp = Object.create(VideoPlayer.prototype);
    vp._hls = { levels: LEVELS.map((l) => ({ ...l, bitrate: 1 })), currentLevel: -1, loadLevel: 1, autoLevelEnabled: true };
    const seen = [];
    vp.onStreamLevels = (info) => seen.push(info);
    vp.setStreamQuality(720);
    expect(vp._hls.currentLevel).toBe(3);
    expect(seen.at(-1)).toMatchObject({ current: 3, auto: false });
    vp.setStreamQuality('auto');
    expect(vp._hls.currentLevel).toBe(-1);
    vp._destroyHls = VideoPlayer.prototype._destroyHls;
    vp._hls.destroy = vi.fn();
    vp._destroyHls();
    expect(seen.at(-1)).toBe(null);                       // the button goes with the stream
  });
  it('the player builds hls.js from the quality settings and applies the choice when the levels arrive', () => {
    const src = fs.readFileSync('renderer/js/video-player.js', 'utf8');
    expect(src).toMatch(/new Hls\(\{ \.\.\.HLS_QUALITY_CONFIG \}\)/);
    expect(src).toMatch(/Hls\.Events\.MANIFEST_PARSED, \(\) => this\._applyStreamQuality\(\)/);
  });
});
