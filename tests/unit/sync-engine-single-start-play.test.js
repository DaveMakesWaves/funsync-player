/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Found while FN-01 (verify-1 live, low): every scripted start sent two
// hsspPlay(0) ~230 ms apart. SyncEngine.start() anchors a video that is
// already playing, and the element's own 'playing' (or app.js's resync()
// right after start()) asked again a moment later at the same position: the
// first play's handler logged "play superseded by a newer play — standing
// down" and the second went out after the 220 ms SDK spacing. One extra
// cloud call per start.
//
// Fixed (2026-11-19, bf-handy): a 'playing' that the anchor play just sent
// already covers (no other play, pause, hold or seek since, not failed,
// under ANCHOR_COVER_MS old, and the device where the picture is within
// STALL_RESYNC_MS) sends nothing. A picture that had not moved yet when
// start() anchored is behind by that wait, and still gets its play.
//
// What runs is the REAL SyncEngine and the REAL HandyManager on the fake SDK
// (helpers/fake-handy-sdk.js). No network; the key is the fake TESTKEY01.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFakeHandySdk, attachFakeCloud } from './helpers/fake-handy-sdk.js';

const h = vi.hoisted(() => ({ sdk: null }));
vi.mock('../../node_modules/@ohdoki/handy-sdk/dist/handy.esm.js', () => ({
  init: () => h.sdk,
  getEstimatedServerTime: () => 0,
  uploadDataToServer: async () => 'https://scripts.local/A.csv',
}));
vi.mock('../../renderer/js/i18n.js', () => ({ t: (k) => k }));

import { HandyManager } from '../../renderer/js/handy-manager.js';
import { SyncEngine, ANCHOR_COVER_MS } from '../../renderer/js/sync-engine.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let m;
let engine;
let video;
let now;   // the engine's wall clock, moved by the test

/** A video element that is playing (not paused, frames ready) at `t` s. */
function makeVideo(t = 0) {
  const v = new EventTarget();
  Object.assign(v, { paused: false, ended: false, seeking: false, error: null, readyState: 4, currentTime: t, playbackRate: 1 });
  v.fire = (type) => v.dispatchEvent(new Event(type));
  return v;
}

const plays = () => h.sdk.sent('hsspPlay').map(([, t]) => t);

beforeEach(async () => {
  h.sdk = createFakeHandySdk();
  m = attachFakeCloud(new HandyManager(), h.sdk);
  await m.init();
  expect(await m.connect('TESTKEY01')).toBe(true);
  m._stopHealthCheck();
  expect(await m.setupScript('https://scripts.local/A.csv')).toBe(true);
  video = makeVideo(0);
  const player = {
    video,
    get paused() { return video.paused; },
    get currentTime() { return video.currentTime; },
  };
  engine = new SyncEngine({ videoPlayer: player, handyManager: m, funscriptEngine: { isLoaded: true } });
  now = 1000;
  engine._now = () => now;
  engine._secondPlayDelay = 60000;   // no 2.5 s correction inside these tests
  engine._scriptReady = true;
});

afterEach(() => {
  engine.stop();
  m._stopHealthCheck();
});

describe('a scripted start sends ONE play', () => {
  it('start() on a video already playing, then its own \'playing\' a moment later: one hsspPlay(0)', async () => {
    engine.start();
    await wait(5);     // the start's play has gone to the device (as in verify-1)
    now += 5;
    video.fire('playing');
    await wait(400);   // past the SDK spacing a second play would have waited out
    expect(plays()).toEqual([0]);
  });

  it('start() then app.js\'s resync() right after it: one play', async () => {
    // (One before the fix too: the start's play was still queued and the
    // resync's superseded it. Pinned so the dedupe keeps it at one.)
    engine.start();
    await engine.resync();
    await wait(400);
    expect(plays()).toEqual([0]);
  });

  it('the first play still out when \'playing\' comes: still one play, and that play\'s handler arms the correction', async () => {
    const out = h.sdk.hold('hsspPlay');
    engine.start();
    await wait(1);     // the start's play is out, unanswered
    now += 3;
    video.fire('playing');
    await wait(10);
    out.resolve({ result: 0 });
    await wait(400);
    expect(plays()).toEqual([0]);
    expect(engine._playingTimer).not.toBe(null);
  });
});

describe('...but a \'playing\' that the last play does not cover still plays', () => {
  it('the picture had not moved yet when start() anchored: \'playing\' 400 ms later at 0 s re-anchors (the device ran 400 ms ahead)', async () => {
    engine.start();
    await wait(5);
    now += 400;
    video.fire('playing');
    await wait(400);
    expect(plays()).toEqual([0, 0]);
  });

  it('the first play failed: \'playing\' sends its own', async () => {
    h.sdk.answer('hsspPlay', new Error('Device timeout'));
    engine.start();
    await wait(20);
    now += 20;
    video.fire('playing');
    await wait(400);
    expect(plays()).toEqual([0, 0]);
  });

  it('a pause and a play in between: the resume plays as always', async () => {
    engine.start();
    await wait(20);
    video.paused = true;
    video.fire('pause');
    await wait(20);
    video.paused = false;
    now += 30;
    video.fire('playing');
    await wait(400);
    expect(plays()).toEqual([0, 0]);
    expect(h.sdk.order().filter((n) => n === 'hsspPlay' || n === 'hsspStop')).toEqual(['hsspPlay', 'hsspStop', 'hsspPlay']);
  });

  it('older than ANCHOR_COVER_MS: plays', async () => {
    engine.start();
    await wait(20);
    now += ANCHOR_COVER_MS + 1;
    video.currentTime = (ANCHOR_COVER_MS + 1) / 1000;   // the picture kept up, but the anchor is old
    video.fire('playing');
    await wait(400);
    expect(plays()).toHaveLength(2);
  });

  it('a stop()/start() in between (a rate change handed to HDSP and back): the new start anchors itself', async () => {
    engine.start();
    await wait(20);
    engine.stop();
    engine._scriptReady = true;
    now += 10;
    engine.start();
    await wait(400);
    expect(plays()).toEqual([0, 0]);
  });
});
