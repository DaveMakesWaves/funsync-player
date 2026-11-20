/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// FN-06 (block F, Dave 2026-11-17: "yes", Audience viewers SHOULD hold
// through a buffering stall like the streamer's own Handy). Found while
// FT-120: app.js forwarded only playing / pause / ended / seeked to the
// AudienceBridge, so while the streamer's video buffered every viewer's
// Handy stroked on by its own clock and was pulled back by the next
// 'playing'.
//
// Now the bridge takes the element's 'waiting' (and a 'stalled' that has run
// out of frames) through onStalled() and uses the streamer's own stall rule
// (playback-stall.js, FN-05): nothing is sent inside the 500 ms grace window
// (a hiccup is not a stop and a play); past it every viewer stops, nothing
// plays them while the picture stands, and 'playing' plays them at the
// picture's time. A seek inside a stall sends its stop and leaves the play to
// that 'playing' (FT-120's one stop and one play per seek). Pause, end and a
// new source stay instant. (app.js has to forward the two events:
// SCRATCH/bf-handy/app-js-request.txt.)
//
// Viewers are the fake HandyManager that mirrors the real contract
// (helpers/fake-viewer-handy.js); assertions read what each viewer's DEVICE
// did. No network, no key.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AudienceBridge, VIEWER_STATUS } from '../../renderer/js/audience-bridge.js';
import { STALL_GRACE_MS } from '../../renderer/js/playback-stall.js';
import {
  makeWorld, makeFakeHandyCtor, makeUploader, scriptContent, urlFor, deviceOf, landed,
} from './helpers/fake-viewer-handy.js';

const KEYS = ['A', 'B'];

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

/** An open room, two viewers playing script s1 from 10 s. */
async function playingRoom() {
  const world = makeWorld();
  const player = { playing: false, timeMs: 0, rate: 1 };
  const up = makeUploader({ latencyFor: () => 0 });
  const bridge = new AudienceBridge({
    settings: { get: () => undefined, set: () => {} },
    eventBus: { emit() {} },
    HandyManagerCtor: makeFakeHandyCtor(world, {}),
    getCurrentVideoTimeMs: () => player.timeMs,
    isVideoPlaying: () => player.playing,
    getPlaybackRate: () => player.rate,
    uploadScript: up.upload,
  });
  bridge.openRoom();
  for (const key of KEYS) {
    const p = bridge.addViewer({ key });
    await vi.runAllTimersAsync();
    await p;
  }
  const token = bridge.beginSource({ title: 's1' });
  bridge.setScript(token, { content: scriptContent('s1'), title: 's1' });
  await vi.runAllTimersAsync();
  player.playing = true;
  player.timeMs = 10000;
  bridge.onPlaying();
  await vi.runAllTimersAsync();
  for (const key of KEYS) expect(deviceOf(world, key)).toMatchObject({ playing: true, playUrl: urlFor('s1') });
  return { world, player, bridge };
}

const marks = (world) => Object.fromEntries(KEYS.map((k) => [k, landed(world, k).length]));
const since = (world, mark, key) => landed(world, key).slice(mark[key]);
/** A video element as the bridge asks it (isPictureStarved). */
const element = (readyState) => ({ paused: false, seeking: false, error: null, readyState });

describe('FN-06: viewers hold through a buffering stall', () => {
  it('a stall past the 500 ms window stops every viewer, nothing plays them while it lasts, and \'playing\' plays them at the picture\'s time', async () => {
    const { world, player, bridge } = await playingRoom();
    const mark = marks(world);
    bridge.onStalled('waiting');
    await vi.advanceTimersByTimeAsync(STALL_GRACE_MS - 50);
    for (const key of KEYS) expect(since(world, mark, key), 'nothing inside the window').toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    for (const key of KEYS) {
      expect(deviceOf(world, key).playing, `${key} held`).toBe(false);
      expect(bridge.getViewerStatus(key)).toBe(VIEWER_STATUS.PAUSED);
    }
    await vi.advanceTimersByTimeAsync(3000);   // a long buffer: still held
    for (const key of KEYS) expect(since(world, mark, key)).toEqual(['stop']);
    player.timeMs = 10600;                     // the picture moves again where it stopped
    bridge.onPlaying();
    await vi.runAllTimersAsync();
    for (const key of KEYS) {
      expect(since(world, mark, key)).toEqual(['stop', 'play']);
      expect(deviceOf(world, key)).toMatchObject({ playing: true, playTimeMs: 10600 });
      expect(bridge.getViewerStatus(key)).toBe(VIEWER_STATUS.PLAYING);
    }
  });

  it('a hiccup inside the window sends no stop (FN-05\'s window)', async () => {
    const { world, player, bridge } = await playingRoom();
    const mark = marks(world);
    bridge.onStalled('waiting');
    await vi.advanceTimersByTimeAsync(200);
    player.timeMs = 10900;
    bridge.onPlaying();
    await vi.runAllTimersAsync();
    for (const key of KEYS) {
      expect(since(world, mark, key)).not.toContain('stop');
      expect(deviceOf(world, key).playing).toBe(true);
    }
  });

  it('a \'stalled\' while the element still has frames is about the network only: nothing', async () => {
    const { world, bridge } = await playingRoom();
    const mark = marks(world);
    bridge.onStalled('stalled', element(4));
    await vi.advanceTimersByTimeAsync(2000);
    for (const key of KEYS) expect(since(world, mark, key)).toEqual([]);
  });

  it('a \'stalled\' that has run out of frames holds like a \'waiting\'', async () => {
    const { world, bridge } = await playingRoom();
    bridge.onStalled('stalled', element(2));
    await vi.advanceTimersByTimeAsync(STALL_GRACE_MS + 100);
    for (const key of KEYS) expect(deviceOf(world, key).playing).toBe(false);
  });

  it('a pause inside the window is instant, and the window then sends nothing more', async () => {
    const { world, player, bridge } = await playingRoom();
    const mark = marks(world);
    bridge.onStalled('waiting');
    await vi.advanceTimersByTimeAsync(100);
    player.playing = false;
    bridge.onPaused();
    await vi.advanceTimersByTimeAsync(2000);
    for (const key of KEYS) {
      expect(since(world, mark, key)).toEqual(['stop']);
      expect(bridge.getViewerStatus(key)).toBe(VIEWER_STATUS.PAUSED);
    }
  });

  it('a paused player\'s \'waiting\' (none in Chromium, but a proxy might) is ignored', async () => {
    const { world, player, bridge } = await playingRoom();
    player.playing = false;
    bridge.onPaused();
    await vi.runAllTimersAsync();
    const mark = marks(world);
    bridge.onStalled('waiting');
    await vi.advanceTimersByTimeAsync(2000);
    for (const key of KEYS) expect(since(world, mark, key)).toEqual([]);
  });

  it('a seek inside a stall that loads slowly: one stop at \'seeked\', and the one play at \'playing\' at the new position (FT-120)', async () => {
    const { world, player, bridge } = await playingRoom();
    const mark = marks(world);
    player.timeMs = 40000;                     // Chromium: 'seeking', then 'waiting'
    bridge.onStalled('waiting');
    await vi.advanceTimersByTimeAsync(100);
    bridge.onSeeked();                         // the new position is still loading
    await vi.advanceTimersByTimeAsync(1500);   // past the window
    for (const key of KEYS) expect(deviceOf(world, key).playing, 'no play into a frozen picture').toBe(false);
    bridge.onPlaying();
    await vi.runAllTimersAsync();
    for (const key of KEYS) {
      expect(since(world, mark, key)).toEqual(['stop', 'play']);
      expect(deviceOf(world, key)).toMatchObject({ playing: true, playTimeMs: 40000 });
    }
  });

  it('control: a seek with no stall is untouched (stop and play at \'seeked\', \'playing\' covered)', async () => {
    const { world, player, bridge } = await playingRoom();
    const mark = marks(world);
    player.timeMs = 40000;
    bridge.onSeeked();
    await vi.advanceTimersByTimeAsync(30);
    bridge.onPlaying();
    await vi.runAllTimersAsync();
    for (const key of KEYS) {
      expect(since(world, mark, key)).toEqual(['stop', 'play']);
      expect(deviceOf(world, key)).toMatchObject({ playing: true, playTimeMs: 40000 });
    }
  });

  it('a new source during a stall ends it: the new video\'s \'playing\' plays its script', async () => {
    const { world, player, bridge } = await playingRoom();
    bridge.onStalled('waiting');
    await vi.advanceTimersByTimeAsync(STALL_GRACE_MS + 100);
    const token = bridge.beginSource({ title: 's2' });
    bridge.setScript(token, { content: scriptContent('s2'), title: 's2' });
    await vi.runAllTimersAsync();
    player.timeMs = 0;
    bridge.onPlaying();
    await vi.runAllTimersAsync();
    for (const key of KEYS) expect(deviceOf(world, key)).toMatchObject({ playing: true, playUrl: urlFor('s2') });
  });

  it('a viewer whose setup lands during a hold does not play until the picture moves', async () => {
    const { world, player, bridge } = await playingRoom();
    bridge.onStalled('waiting');
    await vi.advanceTimersByTimeAsync(STALL_GRACE_MS + 100);
    const p = bridge.addViewer({ key: 'C' });
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    expect(deviceOf(world, 'C').url).toBe(urlFor('s1'));
    expect(deviceOf(world, 'C').playing).toBe(false);
    player.timeMs = 10500;
    bridge.onPlaying();
    await vi.runAllTimersAsync();
    expect(deviceOf(world, 'C')).toMatchObject({ playing: true, playTimeMs: 10500 });
  });
});
