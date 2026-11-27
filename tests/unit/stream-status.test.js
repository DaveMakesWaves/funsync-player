/**
 * @vitest-environment jsdom
 *
 * StreamStatus (renderer/components/stream-status.js): what a stream is doing,
 * over the picture (2026-11-23). And the app's wiring of it: the card for
 * streams only, the recovery of an expired stream, VideoPlayer.swapSource.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { StreamStatus, StallCounter, STALL_SHOW_AFTER_MS } = await import('../../renderer/components/stream-status.js');
const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));

let video; let el; let clock;
const fire = (type) => video.dispatchEvent(new Event(type));
beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  document.body.innerHTML = '<video></video><div id="stream-status" hidden><div class="stream-status__text"></div></div>';
  video = document.querySelector('video');
  el = document.getElementById('stream-status');
  clock = 1_000_000;
  Object.defineProperty(video, 'readyState', { configurable: true, get: () => 2 });
});
afterEach(() => vi.useRealTimers());

const make = (onRepeatedStalls = vi.fn()) => new StreamStatus({ video, el, onRepeatedStalls, now: () => clock });
const text = () => el.querySelector('.stream-status__text').textContent;

describe('StreamStatus', () => {
  it('"Starting the stream…" from the load to the first frame; a local file never sees it', () => {
    vi.useFakeTimers();
    const s = make();
    fire('waiting');
    expect(el.hidden).toBe(true);                         // not a stream: nothing
    s.begin();
    expect(el.hidden).toBe(false);
    expect(text()).toBe(EN.player.stream.starting);
    fire('waiting');                                       // the start's own waits stay "Starting"
    expect(text()).toBe(EN.player.stream.starting);
    fire('playing');
    expect(el.hidden).toBe(true);
    s.end();
    fire('waiting');
    vi.advanceTimersByTime(STALL_SHOW_AFTER_MS + 10);
    expect(el.hidden).toBe(true);
  });

  it('"Loading…" only for a wait longer than 400 ms; ready again hides it', () => {
    vi.useFakeTimers();
    const s = make();
    s.begin(); fire('playing');
    fire('waiting');
    vi.advanceTimersByTime(STALL_SHOW_AFTER_MS - 50);
    expect(el.hidden).toBe(true);
    fire('playing');
    vi.advanceTimersByTime(100);
    expect(el.hidden).toBe(true);                         // a short wait: no flicker
    fire('waiting');
    vi.advanceTimersByTime(STALL_SHOW_AFTER_MS + 10);
    expect(el.hidden).toBe(false);
    expect(text()).toBe(EN.player.stream.loading);
    Object.defineProperty(video, 'paused', { configurable: true, get: () => true });
    fire('canplay');                                       // paused and ready: gone too
    expect(el.hidden).toBe(true);
  });

  it('three stops in a minute offer a lower quality once; the wait of a seek does not count', () => {
    vi.useFakeTimers();
    const offer = vi.fn();
    const s = make(offer);
    s.begin(); fire('playing');
    fire('seeking'); fire('waiting');                      // a seek: not a stall
    clock += 3_000; fire('waiting');
    clock += 10_000; fire('waiting');
    expect(offer).not.toHaveBeenCalled();
    clock += 10_000; fire('waiting');
    expect(offer).toHaveBeenCalledTimes(1);
    clock += 1_000; fire('waiting');
    expect(offer).toHaveBeenCalledTimes(1);                // once per stream
    const c = new StallCounter();
    expect([c.note(0), c.note(30_000), c.note(61_000)]).toEqual([1, 2, 2]);   // older than a minute: gone
  });

  it('"Reconnecting…" while the link is looked up again', () => {
    const s = make();
    s.begin(); fire('playing');
    s.reconnecting();
    expect(text()).toBe(EN.player.stream.reconnecting);
    fire('playing');
    expect(el.hidden).toBe(true);
  });
});

describe('the app wiring', () => {
  const app = fs.readFileSync('renderer/js/app.js', 'utf8');
  it('a failed stream is looked up again from its page, once in 30 s, and carries on where it was', () => {
    expect(app).toMatch(/if \(!noRecover && session\?\.pageUrl && !session\.recovering && Date\.now\(\) - session\.recoveredAt > 30_000\)/);
    expect(app).toMatch(/swapSource\(res\.proxyUrl, \{ isHls: !!res\.isHls, at, play: session\.wantsPlay !== false \}\)/);
    expect(app).toMatch(/this\._onVideoError\(\{ noRecover: true \}\)/);
    expect(fs.readFileSync('electron/main.js', 'utf8')).toMatch(/ok: true, \.\.\.body, pageUrl,\s+proxyUrl:/);
  });
  it('a local file ends the stream session; a stream begins the card', () => {
    expect(app).toMatch(/if \(!file\?\._remote\) \{\s+this\._remoteSession = null;\s+this\.streamStatus\?\.end\(\);/);
    expect(app).toMatch(/this\.streamStatus\?\.begin\(\);/);
    expect(fs.readFileSync('renderer/index.html', 'utf8')).toMatch(/<div id="stream-status" class="stream-status" role="status"/);
  });
});

describe('VideoPlayer.swapSource', () => {
  it('a new address for the same video: back at the same second, playing if it was', async () => {
    const { VideoPlayer } = await import('../../renderer/js/video-player.js');
    const vp = Object.create(VideoPlayer.prototype);
    vp.video = video;
    vp._hls = null;
    video.play = vi.fn(() => Promise.resolve());
    video.load = vi.fn(() => setTimeout(() => video.dispatchEvent(new Event('loadedmetadata')), 5));
    await vp.swapSource('http://localhost:5123/api/media/remote/new/file', { isHls: false, at: 123.5, play: true });
    expect(video.src).toBe('http://localhost:5123/api/media/remote/new/file');
    expect(video.currentTime).toBe(123.5);
    expect(video.play).toHaveBeenCalled();
  });
});
