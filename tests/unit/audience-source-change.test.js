/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// #361 (EroScripts, Priapussucky): audience viewers lost sync on every video
// change, manual or Play All — the new script never reached them, and the
// next play started them on the OLD script at the new video's time.
//
// The hard rule (research note §1): a viewer must never be left running an
// old script on a new video. These tests drive the REAL AudienceBridge
// against fakes that mirror HandyManager's real contract (booleans, latency,
// deadlines, one command at a time, the SDK's 200 ms throttle — see
// tests/unit/helpers/fake-viewer-handy.js) and assert what each viewer's
// DEVICE did:
//   - every play that leaves for the cloud finds the CURRENT script already
//     on the device, the player playing, at 1x (S1);
//   - every setup lands on a stopped device (S2);
//   - after things settle, every device is stopped or playing the current
//     script (the hard rule).
// Research note: notes/features/RESEARCH-audience-video-change.md §4.1, §5.1.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AudienceBridge, VIEWER_STATUS, SDK_THROTTLE_GAP_MS, SOURCE_PLAYER, PLAY_COALESCE_MS,
} from '../../renderer/js/audience-bridge.js';
import {
  makeWorld, makeFakeHandyCtor, makeUploader, scriptContent, urlFor, deviceOf, landed,
} from './helpers/fake-viewer-handy.js';

function makeRoom({ keys = ['A', 'B'], fakeOpts = {}, uploader } = {}) {
  const world = makeWorld();
  const player = { playing: false, timeMs: 0, rate: 1 };
  const events = [];
  const up = uploader || makeUploader();
  const bridge = new AudienceBridge({
    settings: { get: () => undefined, set: () => {} },
    eventBus: { emit: (type, payload) => events.push({ type, payload }) },
    HandyManagerCtor: makeFakeHandyCtor(world, fakeOpts),
    getCurrentVideoTimeMs: () => player.timeMs,
    isVideoPlaying: () => player.playing,
    getPlaybackRate: () => player.rate,
    uploadScript: up.upload,
  });
  // What the room should be playing right now: the URL of the script the
  // last accepted setScript carried, or null (loading / no script).
  const h = { world, bridge, player, events, uploader: up, keys, expected: null };
  world.onSent = (fake, e) => {
    if (e.kind !== 'play') return;
    const dev = deviceOf(world, fake.connectionKey);
    if (!h.expected) world.violations.push({ why: 'play sent with no current script', key: e.key, at: e.at });
    else if (dev.url !== h.expected) {
      world.violations.push({ why: 'play sent before the current script was set up on the device', key: e.key, have: dev.url, want: h.expected, deferred: e.deferred });
    }
    if (!player.playing) world.violations.push({ why: 'play sent while the player is paused', key: e.key });
    if (player.rate !== 1) world.violations.push({ why: `play sent at rate ${player.rate}`, key: e.key });
  };
  world.onLanded = (fake, e) => {
    if (e.kind === 'setup' && e.whileMoving) world.violations.push({ why: 'setup landed on a moving device', key: e.key, url: e.url });
  };
  return h;
}

const settle = () => vi.runAllTimersAsync();

async function open(h) {
  h.bridge.openRoom();
  for (const k of h.keys) {
    const p = h.bridge.addViewer({ key: k });
    await settle();
    await p;
  }
}

function begin(h, label = '', player) {
  h.expected = null;
  return h.bridge.beginSource({ title: label, ...(player ? { player } : {}) });
}

function script(h, token, label, opts) {
  const ok = h.bridge.setScript(token, { content: scriptContent(label, opts), title: label });
  if (ok) h.expected = urlFor(label);
  return ok;
}

function noScript(h, token) {
  const ok = h.bridge.setNoScript(token, { reason: 'test' });
  if (ok) h.expected = null;
  return ok;
}

function play(h, timeMs = h.player.timeMs) {
  h.player.playing = true;
  h.player.timeMs = timeMs;
  h.bridge.onPlaying();
}

function pause(h) {
  h.player.playing = false;
  h.bridge.onPaused();
}

/** The hard rule, after everything has settled. */
function expectSettledState(h, { muted = [] } = {}) {
  for (const k of h.keys) {
    const dev = deviceOf(h.world, k);
    const shouldPlay = !!h.expected && h.player.playing && h.player.rate === 1 && !muted.includes(k);
    if (shouldPlay) {
      expect({ key: k, playing: dev.playing, url: dev.playUrl }).toEqual({ key: k, playing: true, url: h.expected });
    } else {
      expect({ key: k, playing: dev.playing }).toEqual({ key: k, playing: false });
    }
  }
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('#361 — a video change reaches every viewer', () => {
  it('playing A, then a new video B: every viewer is stopped first, then plays B after its own setup for B', async () => {
    const h = makeRoom({ keys: ['A', 'B', 'C'] });
    await open(h);
    script(h, begin(h, 'a'), 'a');
    play(h, 1000);
    await settle();
    expectSettledState(h);

    // Next video (library click, Play All, Up Next): beginSource stops all.
    const tB = begin(h, 'b');
    await vi.advanceTimersByTimeAsync(100);
    for (const k of h.keys) expect(deviceOf(h.world, k).playing).toBe(false);
    for (const k of h.keys) expect(h.bridge.getViewerStatus(k)).toBe(VIEWER_STATUS.WAITING);

    play(h, 0);  // the new video starts before its script is on any viewer
    script(h, tB, 'b');
    await settle();
    expectSettledState(h);
    for (const k of h.keys) {
      // stop for the change, setup for b, then the play — never a play of b
      // before b's setup on that device.
      const kinds = landed(h.world, k).slice(-3);
      expect(kinds).toEqual(['stop', 'setup', 'play']);
    }
    expect(h.world.violations).toEqual([]);
  });

  it('works with no streamer Handy: the bridge uploads the script itself, once for every viewer', async () => {
    const h = makeRoom({ keys: ['A', 'B', 'C', 'D', 'E'] });
    await open(h);
    script(h, begin(h, 'solo'), 'solo');
    await settle();
    expect(h.uploader.uploads.map((u) => u.label)).toEqual(['solo']);
    for (const k of h.keys) expect(deviceOf(h.world, k).url).toBe(urlFor('solo'));
    // The same content again (Play All repeat) reuses the URL.
    script(h, begin(h, 'solo'), 'solo');
    await settle();
    expect(h.uploader.uploads.length).toBe(1);
  });

  it('rapid A -> B -> C with out-of-order setup and upload results: no play ever sent with a stale script, everyone ends on C', async () => {
    const setupMs = { [urlFor('a')]: 2600, [urlFor('b')]: 90, [urlFor('c')]: 700 };
    const h = makeRoom({
      keys: ['A', 'B', 'C'],
      uploader: makeUploader({ latencyFor: (label) => ({ a: 400, b: 1800, c: 60 })[label] }),
      fakeOpts: {
        behave: (kind, args, fake) => {
          if (kind === 'setup') return { replyMs: setupMs[args.url] + (fake.connectionKey === 'B' ? 500 : 0), landMs: setupMs[args.url] };
          if (kind === 'play') return { replyMs: fake.connectionKey === 'C' ? 900 : 40 };
          return undefined;
        },
      },
    });
    await open(h);
    play(h, 0);
    const tA = begin(h, 'a');
    script(h, tA, 'a');
    await vi.advanceTimersByTimeAsync(1200);   // A's setups in flight
    const tB = begin(h, 'b');
    await vi.advanceTimersByTimeAsync(150);
    script(h, tB, 'b');                         // B's upload is slow
    await vi.advanceTimersByTimeAsync(300);
    const tC = begin(h, 'c');
    expect(script(h, tA, 'a')).toBe(false);     // a stale token is dropped
    await vi.advanceTimersByTimeAsync(50);
    script(h, tC, 'c');
    await settle();

    expect(h.world.violations).toEqual([]);
    expectSettledState(h);
    for (const k of h.keys) expect(h.bridge.getViewerStatus(k)).toBe(VIEWER_STATUS.PLAYING);
    // A result that belonged to an old generation set nothing up for play:
    // the only script any device was ever played with is c.
    const playedUrls = new Set(h.world.timeline.filter((e) => e.kind === 'play').map((e) => e.url));
    expect([...playedUrls]).toEqual([urlFor('c')]);
  });

  it('a slow setup for A that answers after B began writes no status and starts no play', async () => {
    const h = makeRoom({
      keys: ['A'],
      fakeOpts: { behave: (kind, args) => (kind === 'setup' && args.url === urlFor('a') ? { replyMs: 3000, landMs: 2900 } : undefined) },
    });
    await open(h);
    play(h, 0);
    script(h, begin(h, 'a'), 'a');
    await vi.advanceTimersByTimeAsync(1000);
    const tB = begin(h, 'b');
    await vi.advanceTimersByTimeAsync(2500);    // A's setup answers ok now
    expect(h.bridge.getViewerStatus('A')).toBe(VIEWER_STATUS.WAITING);
    expect(deviceOf(h.world, 'A').playing).toBe(false);
    script(h, tB, 'b');
    await settle();
    expect(h.world.violations).toEqual([]);
    expectSettledState(h);
  });

  it('a FAILED setup for A that answers after B began writes no error: a stale result writes nothing (S3)', async () => {
    const h = makeRoom({
      keys: ['A'],
      fakeOpts: {
        behave: (kind, args) => {
          if (kind === 'setup' && args.url === urlFor('a')) return { replyMs: 3000, ok: false };
          if (kind === 'setup' && args.url === urlFor('b')) return { replyMs: 4000, landMs: 3900 };
          return undefined;
        },
      },
    });
    await open(h);
    script(h, begin(h, 'a'), 'a');
    await vi.advanceTimersByTimeAsync(1000);
    const tB = begin(h, 'b');
    script(h, tB, 'b');
    await vi.advanceTimersByTimeAsync(2100);    // A's refusal answers now; B's setup is out
    const v = h.bridge.viewers[0];
    expect(v.errorCode).toBe(null);
    expect(v.status).not.toBe(VIEWER_STATUS.ERROR);
    await settle();
    expect(h.bridge.getViewerStatus('A')).toBe(VIEWER_STATUS.READY);
  });

  it('a setup never lands on a device that a late play restarted: it waits for that play to answer (S2)', async () => {
    let lateLanding = true;
    const h = makeRoom({
      keys: ['A'],
      fakeOpts: {
        behave: (kind) => {
          if (kind === 'play' && lateLanding) return { landMs: 300, replyMs: 2000 };
          if (kind === 'setup') return { replyMs: 400, landMs: 400 };
          return undefined;
        },
      },
    });
    await open(h);
    script(h, begin(h, 'a'), 'a');
    await settle();
    play(h, 0);
    await vi.advanceTimersByTimeAsync(100);    // play out, not landed yet
    lateLanding = false;
    script(h, begin(h, 'b'), 'b');             // stop pre-empts; the play lands after it
    await settle();
    expect(h.world.violations).toEqual([]);
    expectSettledState(h);
  });

  it('a randomised run of changes, no-script videos, plays, pauses, seeks, rate changes and mutes keeps S1, S2 and the hard rule', async () => {
    let totalPlays = 0;
    let totalSetups = 0;
    // Two random streams per seed (one until 2026-11-20): `rnd` picks the ops,
    // `rndDev` the uploads' and the fake devices' answer times. With one
    // stream, a change in WHEN a command goes out (a stop no longer waiting
    // for a running setup, Dave 2026-11-20) moved every later op, so each seed
    // became another run: the 12 seeds then asked for 32 plays instead of 44,
    // every one of which landed, as before. Now a seed is the same run of ops
    // whatever the device timing does: 11 of the 12 run identically under the
    // old and the new stop; seed 12 asks for 8 plays instead of 10, because
    // under the old rule viewer A played the PREVIOUS video's script and was
    // stopped four times, and under the new one it plays the current script
    // straight away. 16 seeds keep the "not vacuous" floor where it was.
    for (let seed = 1; seed <= 16; seed++) {
      let x = seed * 7919;
      const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
      let y = seed * 104729;
      const rndDev = () => { y = (y * 1103515245 + 12345) % 2147483648; return y / 2147483648; };
      const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
      const h = makeRoom({
        keys: ['A', 'B', 'C'],
        uploader: makeUploader({ latencyFor: () => 20 + Math.floor(rndDev() * 900) }),
        fakeOpts: {
          behave: () => {
            const replyMs = 10 + Math.floor(rndDev() * 1200);
            return { replyMs, landMs: Math.floor(replyMs * rndDev()) };
          },
        },
      });
      await open(h);
      const muted = new Set();
      let n = 0;
      for (let step = 0; step < 40; step++) {
        const op = pick(['change', 'change', 'play', 'pause', 'seek', 'rate', 'mute', 'wait']);
        if (op === 'change') {
          const label = `s${seed}-${n++}`;
          const token = begin(h, label);
          const how = pick(['now', 'later', 'none', 'never']);
          const lateMs = Math.floor(rnd() * 1500);
          if (how === 'now') script(h, token, label);
          else if (how === 'later') setTimeout(() => script(h, token, label), lateMs);
          else if (how === 'none') setTimeout(() => noScript(h, token), lateMs);
        } else if (op === 'play') {
          play(h, Math.floor(rnd() * 60000));
        } else if (op === 'pause') {
          pause(h);
        } else if (op === 'seek') {
          h.player.timeMs = Math.floor(rnd() * 60000);
          h.bridge.onSeeked();
        } else if (op === 'rate') {
          h.player.rate = pick([1, 1.5, 0.5, 1]);
          h.bridge.onPlaybackRateChanged(h.player.rate);
        } else if (op === 'mute') {
          const k = pick(h.keys);
          const m = !muted.has(k);
          if (m) muted.add(k); else muted.delete(k);
          h.bridge.setMuted(k, m);
        }
        await vi.advanceTimersByTimeAsync(Math.floor(rnd() * 1500));
      }
      await settle();
      expect({ seed, violations: h.world.violations }).toEqual({ seed, violations: [] });
      expectSettledState(h, { muted: [...muted] });
      totalPlays += h.world.timeline.filter((e) => e.kind === 'play').length;
      totalSetups += h.world.timeline.filter((e) => e.kind === 'setup').length;
    }
    // Not vacuous: the run really did set up and play viewers many times.
    console.info(`randomised run: ${totalSetups} setups, ${totalPlays} plays landed`);
    expect(totalSetups).toBeGreaterThan(40);
    expect(totalPlays).toBeGreaterThan(40);
  });
});

describe('#361 — no-script videos, seeks and rate', () => {
  it('a video with no script stops every viewer, and they stay stopped through play and seek', async () => {
    const h = makeRoom();
    await open(h);
    script(h, begin(h, 'a'), 'a');
    play(h, 0);
    await settle();
    expectSettledState(h);

    noScript(h, begin(h, 'nothing'));
    await settle();
    for (const k of h.keys) expect(h.bridge.getViewerStatus(k)).toBe(VIEWER_STATUS.NO_SCRIPT);
    play(h, 3000);
    h.player.timeMs = 9000;
    h.bridge.onSeeked();
    await settle();
    expect(h.world.violations).toEqual([]);
    for (const k of h.keys) expect(deviceOf(h.world, k).playing).toBe(false);
  });

  it('a script with fewer than 2 actions counts as no script, not as an upload', async () => {
    const h = makeRoom();
    await open(h);
    const t = begin(h, 'tiny');
    h.bridge.setScript(t, { content: scriptContent('tiny', { n: 1 }) });
    play(h, 0);
    await settle();
    expect(h.bridge.source.kind).toBe('no-script');
    expect(h.uploader.uploads).toEqual([]);
    for (const k of h.keys) expect(deviceOf(h.world, k).playing).toBe(false);
  });

  it('a seek while paused sends no play', async () => {
    const h = makeRoom();
    await open(h);
    script(h, begin(h, 'a'), 'a');
    play(h, 0);
    await settle();
    pause(h);
    await settle();
    const before = h.world.sent.filter((e) => e.kind === 'play').length;
    for (const ms of [5000, 12000, 30000]) {
      h.player.timeMs = ms;
      h.bridge.onSeeked();
      await settle();
    }
    expect(h.world.sent.filter((e) => e.kind === 'play').length).toBe(before);
    for (const k of h.keys) expect(deviceOf(h.world, k).playing).toBe(false);
  });

  it('a seek while playing re-anchors once at the new time', async () => {
    const h = makeRoom({ keys: ['A'] });
    await open(h);
    script(h, begin(h, 'a'), 'a');
    play(h, 0);
    await settle();
    h.player.timeMs = 42000;
    h.bridge.onSeeked();
    await settle();
    expect(landed(h.world, 'A').slice(-2)).toEqual(['stop', 'play']);
    expect(deviceOf(h.world, 'A').playTimeMs).toBe(42000);
  });

  it('rate 1.5 stops every viewer; back at 1x they play again only once ready', async () => {
    const h = makeRoom({
      fakeOpts: { behave: (kind, args, fake) => (kind === 'setup' && fake.connectionKey === 'B' && args.url === urlFor('b') ? { replyMs: 4000, landMs: 3900 } : undefined) },
    });
    await open(h);
    script(h, begin(h, 'a'), 'a');
    play(h, 0);
    await settle();

    h.player.rate = 1.5;
    h.bridge.onPlaybackRateChanged(1.5);
    await settle();
    for (const k of h.keys) {
      expect(deviceOf(h.world, k).playing).toBe(false);
      expect(h.bridge.getViewerStatus(k)).toBe(VIEWER_STATUS.SPEED);
    }
    expect(h.bridge.viewers.every((v) => v.rate === 1.5)).toBe(true);
    // A play at 1.5x (or a seek) reaches nobody.
    h.bridge.onPlaying();
    h.bridge.onSeeked();
    await settle();
    expect(h.world.violations).toEqual([]);

    // A new video arrives at 1.5x; B's setup is slow.
    script(h, begin(h, 'b'), 'b');
    await vi.advanceTimersByTimeAsync(500);
    h.player.rate = 1;
    h.bridge.onPlaybackRateChanged(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(deviceOf(h.world, 'A')).toMatchObject({ playing: true, playUrl: urlFor('b') });
    expect(deviceOf(h.world, 'B').playing).toBe(false);   // not ready yet
    await settle();
    expectSettledState(h);
    expect(h.world.violations).toEqual([]);
  });
});

describe('#361 — muted viewers', () => {
  it('a muted viewer is stopped by a change but gets no setup; unmute while paused sets up and does not play', async () => {
    const h = makeRoom();
    await open(h);
    script(h, begin(h, 'a'), 'a');
    play(h, 0);
    await settle();
    const m = h.bridge.setMuted('A', true);
    await settle();
    await m;
    expect(deviceOf(h.world, 'A').playing).toBe(false);

    script(h, begin(h, 'b'), 'b');
    await settle();
    // Muted: no setup for b reached it.
    expect(deviceOf(h.world, 'A').url).toBe(urlFor('a'));
    expect(deviceOf(h.world, 'A').playing).toBe(false);
    expect(deviceOf(h.world, 'B')).toMatchObject({ playing: true, playUrl: urlFor('b') });

    pause(h);
    await settle();
    const p = h.bridge.setMuted('A', false);
    await settle();
    await p;
    expect(deviceOf(h.world, 'A')).toMatchObject({ url: urlFor('b'), playing: false });
    expect(h.bridge.getViewerStatus('A')).toBe(VIEWER_STATUS.READY);
    expect(h.world.violations).toEqual([]);
  });
});

describe('#361 — late commands, failures, throttle', () => {
  it('a play whose success arrives after a stop is stopped again (S5)', async () => {
    let slowPlays = true;
    const h = makeRoom({
      keys: ['A'],
      fakeOpts: { behave: (kind) => (kind === 'play' && slowPlays ? { replyMs: 3000, landMs: 2500 } : undefined) },
    });
    await open(h);
    script(h, begin(h, 'a'), 'a');
    await settle();
    play(h, 0);
    await vi.advanceTimersByTimeAsync(500);
    pause(h);                                   // its stop lands long before the play
    await vi.advanceTimersByTimeAsync(2200);    // the play lands at 2.5 s: device moving
    expect(deviceOf(h.world, 'A').playing).toBe(true);
    slowPlays = false;
    await settle();                             // the play answers at 3 s -> stop again
    expect(deviceOf(h.world, 'A').playing).toBe(false);
    expect(landed(h.world, 'A').slice(-2)).toEqual(['play', 'stop']);
  });

  it('removing a viewer whose play is still out stops it again after that play answers', async () => {
    const h = makeRoom({
      keys: ['A'],
      fakeOpts: { behave: (kind) => (kind === 'play' ? { replyMs: 2000, landMs: 1500 } : undefined) },
    });
    await open(h);
    script(h, begin(h, 'a'), 'a');
    await settle();
    play(h, 0);
    await vi.advanceTimersByTimeAsync(200);
    const r = h.bridge.removeViewer('A');
    await settle();
    await r;
    expect(deviceOf(h.world, 'A').playing).toBe(false);
    expect(h.bridge.viewers).toEqual([]);
  });

  it('ending the room with a play still out leaves every device stopped', async () => {
    const h = makeRoom({
      fakeOpts: { behave: (kind) => (kind === 'play' ? { replyMs: 2000, landMs: 1500 } : undefined) },
    });
    await open(h);
    script(h, begin(h, 'a'), 'a');
    await settle();
    play(h, 0);
    await vi.advanceTimersByTimeAsync(200);
    const r = h.bridge.endRoom();
    await settle();
    await r;
    for (const k of h.keys) expect(deviceOf(h.world, k).playing).toBe(false);
  });

  it('upload failure: one retry, then viewers stay stopped with an honest status and one toast event', async () => {
    const h = makeRoom({ uploader: makeUploader({ failFor: () => true }) });
    await open(h);
    script(h, begin(h, 'a'), 'a');
    play(h, 0);
    await settle();
    expect(h.uploader.uploads.length).toBe(2);
    for (const k of h.keys) {
      expect(h.bridge.getViewerStatus(k)).toBe(VIEWER_STATUS.SCRIPT_FAILED);
      expect(deviceOf(h.world, k).playing).toBe(false);
    }
    expect(h.bridge.aggregateStatus).toBe('error');
    expect(h.events.filter((e) => e.type === 'audience:script-upload-failed').length).toBe(1);
    h.bridge.onPlaying();
    await settle();
    expect(h.world.sent.filter((e) => e.kind === 'play')).toEqual([]);
  });

  it('an upload that fails once and then works sets every viewer up', async () => {
    const h = makeRoom({ uploader: makeUploader({ failFor: (_l, attempt) => attempt === 1 }) });
    await open(h);
    script(h, begin(h, 'a'), 'a');
    play(h, 0);
    await settle();
    expect(h.uploader.uploads.length).toBe(2);
    expectSettledState(h);
  });

  it('a setup the device refuses: that viewer shows Error and is never played; the next video retries', async () => {
    let refuse = true;
    const h = makeRoom({
      fakeOpts: { behave: (kind, _a, fake) => (kind === 'setup' && fake.connectionKey === 'B' && refuse ? { ok: false } : undefined) },
    });
    await open(h);
    script(h, begin(h, 'a'), 'a');
    play(h, 0);
    await settle();
    expect(h.bridge.getViewerStatus('B')).toBe(VIEWER_STATUS.ERROR);
    expect(h.bridge.viewers.find((v) => v.key === 'B').errorCode).toBe('setup-failed');
    expect(deviceOf(h.world, 'B').playing).toBe(false);
    expect(deviceOf(h.world, 'A').playing).toBe(true);
    refuse = false;
    script(h, begin(h, 'b'), 'b');
    await settle();
    expectSettledState(h);
  });

  it('a stop that fails shows Error (the device may still be moving) and blocks plays until a stop succeeds', async () => {
    let failStops = false;
    const h = makeRoom({
      keys: ['A'],
      fakeOpts: { behave: (kind) => (kind === 'stop' && failStops ? { ok: false } : undefined) },
    });
    await open(h);
    script(h, begin(h, 'a'), 'a');
    play(h, 0);
    await settle();
    failStops = true;
    pause(h);
    await settle();
    expect(h.bridge.getViewerStatus('A')).toBe(VIEWER_STATUS.ERROR);
    expect(h.bridge.viewers[0].errorCode).toBe('stop-failed');
    expect(h.bridge.viewers.length).toBe(1);        // stays in the room (S6)
    const plays = h.world.sent.filter((e) => e.kind === 'play').length;
    play(h, 1000);
    await settle();
    expect(h.world.sent.filter((e) => e.kind === 'play').length).toBe(plays);
    failStops = false;
    pause(h);
    await settle();
    expect(h.bridge.getViewerStatus('A')).toBe(VIEWER_STATUS.PAUSED);
  });

  it('two setups on one viewer are spaced past the SDK throttle, so a result is never the previous call\'s', async () => {
    const h = makeRoom({ keys: ['A'], fakeOpts: { latency: 30 } });
    await open(h);
    play(h, 0);
    // Back-to-back changes: each setup would otherwise go out right after
    // the previous one answered.
    for (const label of ['a', 'b', 'c', 'd']) {
      script(h, begin(h, label), label);
      await vi.advanceTimersByTimeAsync(45);
    }
    await settle();
    const fake = h.world.managers[0];
    expect(fake.throttled).toEqual([]);
    const sends = h.world.sent.filter((e) => e.kind === 'setup' && !e.deferred);
    const replies = h.world.replies.filter((e) => e.kind === 'setup');
    for (let i = 1; i < sends.length; i++) {
      expect(sends[i].at - replies[i - 1].at).toBeGreaterThanOrEqual(SDK_THROTTLE_GAP_MS);
    }
    expect(h.world.violations).toEqual([]);
    expectSettledState(h);
  });

  it('a stale setScript / setNoScript token is dropped, and a token settles only once', async () => {
    const h = makeRoom({ keys: ['A'] });
    await open(h);
    const t1 = begin(h, 'a');
    const t2 = begin(h, 'b');
    expect(h.bridge.setScript(t1, { content: scriptContent('a') })).toBe(false);
    expect(h.bridge.setNoScript(t1)).toBe(false);
    expect(script(h, t2, 'b')).toBe(true);
    expect(h.bridge.setNoScript(t2)).toBe(false);
    await settle();
    expect(h.uploader.uploads.map((u) => u.label)).toEqual(['b']);
  });
});

// Review of #361 (2026-11-04). Each of these was a scratch test the
// reviewer wrote against the stopgap, and each failed as predicted.
describe('#361 review — a source belongs to its player', () => {
  it('a VR or phone source is set up but never played, even with the local player playing at 1x', async () => {
    for (const player of [SOURCE_PLAYER.VR, SOURCE_PLAYER.PHONE]) {
      const h = makeRoom({ keys: ['A'] });
      await open(h);
      play(h, 1000);
      script(h, begin(h, `x-${player}`, player), `x-${player}`);
      await settle();
      h.bridge.onPlaying();
      h.bridge.onSeeked();
      await settle();
      expect(deviceOf(h.world, 'A').url).toBe(urlFor(`x-${player}`));
      expect(h.world.sent.filter((e) => e.kind === 'play')).toEqual([]);
      // Not READY (green): a phone's or headset's script is never played by viewers, and "Ready" read as "will play" (verify-2, 2026-11-07).
      expect(h.bridge.getViewerStatus('A')).toBe(VIEWER_STATUS.REMOTE_HELD);
    }
  });

  it('endSource ends only that player\'s source: viewers stop and read "No script"; a late setScript for it is dropped', async () => {
    const h = makeRoom();
    await open(h);
    script(h, begin(h, 'local'), 'local');
    play(h, 0);
    await settle();
    // Not the source's player: nothing happens.
    expect(h.bridge.endSource(SOURCE_PLAYER.VR)).toBe(false);
    await settle();
    expectSettledState(h);

    // A VR source, set up; the headset goes away.
    script(h, begin(h, 'scene', SOURCE_PLAYER.VR), 'scene');
    await settle();
    expect(h.bridge.endSource(SOURCE_PLAYER.VR, { reason: 'vr-ended' })).toBe(true);
    h.expected = null;
    await settle();
    for (const k of h.keys) {
      expect(h.bridge.getViewerStatus(k)).toBe(VIEWER_STATUS.NO_SCRIPT);
      expect(deviceOf(h.world, k).playing).toBe(false);
    }
    h.bridge.onPlaying();
    await settle();
    expect(h.world.violations).toEqual([]);
    for (const k of h.keys) expect(deviceOf(h.world, k).playing).toBe(false);

    // A phone source still loading when the phone goes away.
    const tPhone = begin(h, 'phone', SOURCE_PLAYER.PHONE);
    expect(h.bridge.endSource(SOURCE_PLAYER.PHONE)).toBe(true);
    expect(h.bridge.setScript(tPhone, { content: scriptContent('phone') })).toBe(false);
    await settle();
    expect(h.uploader.uploads.map((u) => u.label)).not.toContain('phone');
  });
});

describe('#361 review — the SDK throttle under HandyManager', () => {
  it('a setup past HandyManager\'s 15 s deadline, then a new video: no play is sent before the new script is on the device', async () => {
    const h = makeRoom({
      keys: ['A'],
      fakeOpts: {
        behave: (kind, args) => {
          if (kind === 'setup' && args.url === urlFor('a')) return { replyMs: 20000, landMs: 20000 };
          if (kind === 'setup' && args.url === urlFor('b')) return { replyMs: 6000, landMs: 6000 };
          return undefined;
        },
      },
    });
    await open(h);
    play(h, 1000);
    script(h, begin(h, 'a'), 'a');
    await vi.advanceTimersByTimeAsync(5000);    // a's setup is slow
    const tB = begin(h, 'b');                   // the streamer moves on
    script(h, tB, 'b');
    await settle();
    expect(h.world.violations).toEqual([]);
    expectSettledState(h);
    // The deadline really did hand the next setup a's answer: the fake
    // throttled that call, so the bridge had to ask once more.
    expect(h.world.managers[0].throttled).toContain('setup');
    expect(h.world.sent.filter((e) => e.kind === 'setup' && e.url === urlFor('b') && !e.deferred).length).toBe(1);
  });

  // Since FT-124 (2026-11-19) HandyManager sends a stop straight to the
  // cloud while the SDK is in HSSP mode, so the SDK throttle no longer meets
  // a stop there. It still does after a Test buzz (the SDK in HDSP mode
  // switches back first), and the bridge must stay safe then: these tests
  // send every stop through the SDK (`sdkStops`), as all of them went before.
  it('a source change right after a seek: the stop inside the throttle window is not trusted, and the setup waits for a stop of its own (S2)', async () => {
    const h = makeRoom({ keys: ['A'], fakeOpts: { sdkStops: true } });
    await open(h);
    script(h, begin(h, 'a'), 'a');
    play(h, 0);
    await settle();
    h.player.timeMs = 5000;
    h.bridge.onSeeked();                         // stop + play, both answer fast
    await vi.advanceTimersByTimeAsync(100);
    expect(deviceOf(h.world, 'A').playing).toBe(true);
    script(h, begin(h, 'b'), 'b');               // its stop gets the seek stop's answer
    await settle();
    expect(h.world.managers[0].throttled).toContain('stop');
    expect(h.world.violations).toEqual([]);     // no setup landed on a moving device
    expectSettledState(h);
  });

  it('rapid seeks while playing: the device ends playing at the last seek, not stopped by a stop that left late', async () => {
    const h = makeRoom({ keys: ['A'], fakeOpts: { sdkStops: true } });
    await open(h);
    script(h, begin(h, 'a'), 'a');
    play(h, 0);
    await settle();
    await vi.advanceTimersByTimeAsync(1000);    // past every spacing window
    // Seek 1 at T: its stop answers at T+20, its play at T+40.
    h.player.timeMs = 5000;
    h.bridge.onSeeked();
    await vi.advanceTimersByTimeAsync(150);
    // Seek 2 at T+150, inside the window of seek 1's stop: the SDK hands it
    // that stop's answer and sends its own request at T+350. Its play may go
    // at T+290 (250 ms after seek 1's play answered) — before that request,
    // which would then stop the device under a row that reads Playing.
    h.player.timeMs = 9000;
    h.bridge.onSeeked();
    await settle();
    expect(h.world.managers[0].throttled).toContain('stop');
    expect(h.world.violations).toEqual([]);
    expectSettledState(h);
    expect(deviceOf(h.world, 'A').playTimeMs).toBe(9000);
    expect(h.bridge.getViewerStatus('A')).toBe(VIEWER_STATUS.PLAYING);
  });
});

// Review of #361, round 2 (2026-11-04): a stop made inside the SDK throttle
// window is handed the previous stop's answer, and its own request is a
// renderer timer 200 ms later. Two things kill that timer's request: the
// renderer going away (quit, relaunch) and a disconnect (Remove, End room —
// the SDK has no key after it). A stop like that must never be the last
// word on a device.
describe('#361 review — the last stop before the app or the viewer goes away', () => {
  /** Playing, then a seek: its stop answers at +20 and its play lands at
   *  +40. Returns at +60, inside that stop's throttle window. */
  async function playingJustAfterASeek(h) {
    await open(h);
    script(h, begin(h, 'a'), 'a');
    play(h, 0);
    await settle();
    await vi.advanceTimersByTimeAsync(1000);    // past every spacing window
    h.player.timeMs = 5000;
    h.bridge.onSeeked();
    await vi.advanceTimersByTimeAsync(60);
    expect(deviceOf(h.world, 'A')).toMatchObject({ playing: true, playTimeMs: 5000 });
  }

  /** What quitting does: hsspStopAll, then the renderer is gone the moment
   *  it resolves (main closes the window), so nothing it would still send
   *  leaves. Requests already sent still land. */
  async function quitNow(h) {
    let results = null;
    const done = h.bridge.hsspStopAll().then((r) => { results = r; h.world.rendererGone = true; });
    await settle();
    await done;
    return results.map((r) => r.value);
  }

  it('quitting right after a seek: hsspStopAll answers only once a stop with its own answer is out, so the device is stopped when the app is gone', async () => {
    // Stops through the SDK (`sdkStops`): see the note above the throttle tests.
    const h = makeRoom({ keys: ['A'], fakeOpts: { sdkStops: true } });
    await playingJustAfterASeek(h);
    h.player.playing = false;
    expect(await quitNow(h)).toEqual([true]);
    expect(h.world.managers[0].throttled).toContain('stop');
    expect(deviceOf(h.world, 'A').playing).toBe(false);
  });

  it('a pause inside the window just before quitting: the viewer is "known stopped" by a stop that has not left yet, and that is not enough', async () => {
    const h = makeRoom({ keys: ['A'] });
    await playingJustAfterASeek(h);
    pause(h);                                    // its stop is handed the seek stop's answer
    await vi.advanceTimersByTimeAsync(20);
    expect(await quitNow(h)).toEqual([true]);
    expect(deviceOf(h.world, 'A').playing).toBe(false);
  });

  it('a play still out at quit is stopped again once it answers, before hsspStopAll answers (S5)', async () => {
    const h = makeRoom({
      keys: ['A'],
      fakeOpts: { behave: (kind) => (kind === 'play' ? { replyMs: 600, landMs: 500 } : undefined) },
    });
    await open(h);
    script(h, begin(h, 'a'), 'a');
    await settle();
    play(h, 0);
    await vi.advanceTimersByTimeAsync(100);     // the play is out; it lands at +500
    h.player.playing = false;
    expect(await quitNow(h)).toEqual([true]);
    expect(deviceOf(h.world, 'A').playing).toBe(false);
  });

  it('removing a viewer right after a seek: the stop before the disconnect has its own answer, so the device does not keep playing', async () => {
    const h = makeRoom({ keys: ['A'] });
    await playingJustAfterASeek(h);
    const removing = h.bridge.removeViewer('A');
    await settle();
    await removing;
    expect(h.world.dropped).toEqual([]);
    expect(deviceOf(h.world, 'A').playing).toBe(false);
  });

  it('ending the room right after a seek leaves every device stopped', async () => {
    const h = makeRoom({ keys: ['A', 'B'] });
    await playingJustAfterASeek(h);
    const ending = h.bridge.endRoom();
    await settle();
    await ending;
    for (const k of h.keys) expect(deviceOf(h.world, k).playing).toBe(false);
  });
});

describe('#361 review — stop errors, failed loads, lazy content', () => {
  it('the change\'s stop fails, the stop before the setup succeeds: the error clears and the viewer plays the new video', async () => {
    let failStops = 0;
    const h = makeRoom({
      keys: ['A'],
      fakeOpts: { behave: (kind) => { if (kind === 'stop' && failStops > 0) { failStops--; return { ok: false }; } return undefined; } },
    });
    await open(h);
    play(h, 1000);
    script(h, begin(h, 'a'), 'a');
    await settle();
    expect(deviceOf(h.world, 'A').playing).toBe(true);
    failStops = 2;                               // both of HandyManager's attempts
    const tB = begin(h, 'b');
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.bridge.viewers[0].errorCode).toBe('stop-failed');
    script(h, tB, 'b');
    await settle();
    expect(h.bridge.viewers[0].errorCode).toBe(null);
    expect(h.world.violations).toEqual([]);
    expectSettledState(h);
    expect(h.bridge.getViewerStatus('A')).toBe(VIEWER_STATUS.PLAYING);
  });

  it('setNoScript with failed: true reads "Couldn\'t load the script" (red), not "No script"', async () => {
    const h = makeRoom();
    await open(h);
    h.bridge.setNoScript(begin(h, 'bad'), { reason: 'variant-failed', failed: true });
    await settle();
    for (const k of h.keys) expect(h.bridge.getViewerStatus(k)).toBe(VIEWER_STATUS.SCRIPT_FAILED);
    expect(h.bridge.aggregateStatus).toBe('error');
    h.bridge.setNoScript(begin(h, 'none'), { reason: 'no-script' });
    await settle();
    for (const k of h.keys) expect(h.bridge.getViewerStatus(k)).toBe(VIEWER_STATUS.NO_SCRIPT);
  });

  it('content given as a function is built once, only when a viewer needs it; a throw there reads "Couldn\'t load the script"', async () => {
    const h = makeRoom({ keys: ['A'] });
    const build = vi.fn(() => scriptContent('lazy'));
    // No room, no viewers: nothing is built.
    const t1 = begin(h, 'lazy');
    expect(h.bridge.setScript(t1, { content: build })).toBe(true);
    h.expected = urlFor('lazy');
    await settle();
    expect(build).not.toHaveBeenCalled();
    await open(h);                               // the viewer joins mid-video
    expect(build).toHaveBeenCalledTimes(1);
    expect(deviceOf(h.world, 'A').url).toBe(urlFor('lazy'));

    const t2 = begin(h, 'boom');
    expect(h.bridge.setScript(t2, { content: () => { throw new Error('filler'); } })).toBe(true);
    await settle();
    expect(h.bridge.getViewerStatus('A')).toBe(VIEWER_STATUS.SCRIPT_FAILED);
    expect(h.uploader.uploads.map((u) => u.label)).toEqual(['lazy']);
  });
});

// FT-120 (new since v0.9.2): a seek while the local video played sent each
// viewer a stop and usually two plays: Chromium fires `seeked` and then
// `playing`, and both asked for one. The second also made up for the first
// being anchored too early: HandyManager queues a play behind the stop and
// reads the server time only when it runs, while the bridge had read the
// video time before the stop's round trip. So the fix has two halves: a play
// waits for the stop still out and reads the video time when it leaves, and a
// request the last play already covers is dropped, unless the video stalled
// since (then the device needs the new anchor).
describe('FT-120 — one play per seek', () => {
  /** The local video's clock: while running its time moves with the wall
   *  clock (plays only go at 1x). Every play sent records the video time at
   *  that moment (`videoAtSend`), so its anchor can be checked. */
  function clocked(h) {
    let base = 0;
    let since = Date.now();
    let running = false;
    const now = () => (running ? base + (Date.now() - since) : base);
    const rebase = (ms, run) => { base = ms; since = Date.now(); running = run; };
    Object.defineProperty(h.player, 'timeMs', { get: now, set: (ms) => rebase(ms, running), configurable: true });
    const onSent = h.world.onSent;
    h.world.onSent = (fake, e) => {
      if (e.kind === 'play') e.videoAtSend = now();
      onSent(fake, e);
    };
    return {
      now,
      play() { rebase(now(), true); h.player.playing = true; h.bridge.onPlaying(); },
      seek(ms) { rebase(ms, running); h.bridge.onSeeked(); },
      stall() { rebase(now(), false); },
      resume() { rebase(now(), true); },
      pause() { rebase(now(), false); h.player.playing = false; h.bridge.onPaused(); },
    };
  }

  /** A playing room whose stops take 300 ms to answer (plays 20 ms), past
   *  every spacing window. */
  async function playingRoom(keys = ['A', 'B']) {
    const h = makeRoom({ keys, fakeOpts: { behave: (kind) => (kind === 'stop' ? { replyMs: 300, landMs: 280 } : undefined) } });
    const vid = clocked(h);
    await open(h);
    script(h, begin(h, 'a'), 'a');
    vid.play();
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    for (const k of keys) expect(deviceOf(h.world, k).playing).toBe(true);
    return { h, vid, n: h.world.sent.length };
  }

  const sentSince = (h, n, key) => h.world.sent.slice(n).filter((e) => e.key === key);
  const anchorErr = (e) => Math.abs(e.videoAtSend - e.timeMs);

  it('a seek while playing sends each viewer one stop and one play, anchored at the video time it leaves at', async () => {
    const { h, vid, n } = await playingRoom();
    vid.seek(42000);
    await vi.advanceTimersByTimeAsync(5);
    h.bridge.onPlaying();                        // Chromium: `playing` right after `seeked`
    await settle();
    for (const k of h.keys) {
      const after = sentSince(h, n, k);
      expect(after.map((e) => e.kind)).toEqual(['stop', 'play']);
      expect(anchorErr(after[1])).toBeLessThanOrEqual(5);
      expect(after[1].timeMs).toBeGreaterThanOrEqual(42000);
      expect(deviceOf(h.world, k)).toMatchObject({ playing: true, playUrl: urlFor('a') });
      expect(h.bridge.getViewerStatus(k)).toBe(VIEWER_STATUS.PLAYING);
    }
    expect(h.world.violations).toEqual([]);
  });

  it('`playing` arriving after the seek\'s play has answered, the video where that play put it: still one play', async () => {
    const { h, vid, n } = await playingRoom(['A']);
    vid.seek(42000);
    await vi.advanceTimersByTimeAsync(330);      // stop answered at 300, the play at ~320
    const plays = () => sentSince(h, n, 'A').filter((e) => e.kind === 'play');
    expect(plays().length).toBe(1);
    h.bridge.onPlaying();
    await settle();
    expect(plays().length).toBe(1);
    expect(anchorErr(plays()[0])).toBeLessThanOrEqual(5);
    expect(deviceOf(h.world, 'A').playing).toBe(true);
  });

  it('a video that stalled after the seek gets a second play, anchored where it resumed', async () => {
    const { h, vid, n } = await playingRoom(['A']);
    vid.seek(42000);
    vid.stall();                                 // buffering at the new spot
    await vi.advanceTimersByTimeAsync(550);      // the seek's play went at ~300 with 42000
    const answered = h.world.replies.filter((r) => r.kind === 'play').at(-1).at;
    expect(Date.now() - answered).toBeLessThan(PLAY_COALESCE_MS);   // inside the window: the anchor check decides
    vid.resume();
    h.bridge.onPlaying();
    await settle();
    const plays = sentSince(h, n, 'A').filter((e) => e.kind === 'play');
    expect(plays.length).toBe(2);
    expect(plays.every((e) => anchorErr(e) <= 5)).toBe(true);
    expect(deviceOf(h.world, 'A').playing).toBe(true);
  });

  it('a pause and a play right after a seek still end playing, at the right time (a request after a stop is never dropped)', async () => {
    const { h, vid, n } = await playingRoom(['A']);
    vid.seek(42000);
    h.bridge.onPlaying();
    await vi.advanceTimersByTimeAsync(50);
    vid.pause();
    await vi.advanceTimersByTimeAsync(50);
    vid.play();
    await settle();
    const plays = sentSince(h, n, 'A').filter((e) => e.kind === 'play');
    expect(plays.length).toBeGreaterThanOrEqual(1);
    expect(anchorErr(plays.at(-1))).toBeLessThanOrEqual(5);
    expect(deviceOf(h.world, 'A')).toMatchObject({ playing: true, playUrl: urlFor('a') });
    expect(h.bridge.getViewerStatus('A')).toBe(VIEWER_STATUS.PLAYING);
    expect(h.world.violations).toEqual([]);
  });

  it('a pause and a play inside the coalescing window: the play after the pause\'s stop is never dropped (S5)', async () => {
    const { h, vid, n } = await playingRoom(['A']);
    vid.seek(42000);
    await vi.advanceTimersByTimeAsync(330);      // the seek's play answered at ~320
    vid.pause();                                 // its stop answers at +300
    await vi.advanceTimersByTimeAsync(10);
    vid.play();                                  // 10 ms later: the video is where that play anchored it
    await settle();
    const after = sentSince(h, n, 'A').map((e) => e.kind);
    // The pause's stop came inside the throttle window of the seek's, so
    // the play first gets a stop with its own answer (existing rule).
    expect(after.filter((k) => k === 'play').length).toBe(2);
    expect(after.slice(-2)).toEqual(['stop', 'play']);
    expect(anchorErr(sentSince(h, n, 'A').at(-1))).toBeLessThanOrEqual(5);
    expect(deviceOf(h.world, 'A')).toMatchObject({ playing: true, playUrl: urlFor('a') });
    expect(h.bridge.getViewerStatus('A')).toBe(VIEWER_STATUS.PLAYING);
    expect(h.world.violations).toEqual([]);
  });

  it('five seeks a second apart, each `seeked` then `playing`: five stops and five plays per viewer', async () => {
    const { h, vid, n } = await playingRoom(['A', 'B']);
    for (let i = 1; i <= 5; i++) {
      vid.seek(i * 10000);
      await vi.advanceTimersByTimeAsync(3);
      h.bridge.onPlaying();
      await vi.advanceTimersByTimeAsync(1000);
    }
    await settle();
    for (const k of h.keys) {
      const kinds = sentSince(h, n, k).map((e) => e.kind);
      expect(kinds.filter((x) => x === 'stop').length).toBe(5);
      expect(kinds.filter((x) => x === 'play').length).toBe(5);
      expect(deviceOf(h.world, k).playing).toBe(true);
    }
    expect(h.world.violations).toEqual([]);
  });
});
