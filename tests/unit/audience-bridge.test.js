/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// AudienceBridge — lifecycle, roster, per-viewer status, fan-out.
// SCOPE: notes/features/SCOPE-audience-broadcast.md §5 + §7.
//
// The fake HandyManager (tests/unit/helpers/fake-viewer-handy.js) mirrors the
// REAL contract: booleans, never a throw, one command at a time per instance,
// latency, deadlines. The fake this file used to carry threw on failure,
// which the real class never does, so the suite tested a path production
// never takes. Assertions read what each viewer's DEVICE did (the landed
// timeline), not which methods were called. The source-change invariants
// (#361) are in audience-source-change.test.js.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { AudienceBridge, VIEWER_STATUS, TEST_BUZZ_PULSE } from '../../renderer/js/audience-bridge.js';
import { HandyManager } from '../../renderer/js/handy-manager.js';
import {
  makeWorld, makeFakeHandyCtor, makeUploader, scriptContent, urlFor, deviceOf, landed, powerCycle,
} from './helpers/fake-viewer-handy.js';

function makeSettings(initial = {}) {
  const store = { ...initial };
  return {
    get: vi.fn((k) => store[k]),
    set: vi.fn((k, v) => { store[k] = v; }),
  };
}

function makeBus() {
  const events = [];
  return { events, emit: (type, payload) => { events.push({ type, payload }); } };
}

function makeBridge({ fakeOpts = {}, player, ownKey = null, uploader } = {}) {
  const world = makeWorld();
  const settings = makeSettings();
  const bus = makeBus();
  const p = player || { playing: false, timeMs: 0, rate: 1 };
  const up = uploader || makeUploader({ latencyFor: () => 0 });
  const bridge = new AudienceBridge({
    settings,
    eventBus: bus,
    // The caller's own object (latency 0 unless it says), so a test can
    // change `failConnect` / `fwVersion` on it later.
    HandyManagerCtor: makeFakeHandyCtor(world, Object.assign(fakeOpts, { latency: fakeOpts.latency ?? 0 })),
    getCurrentVideoTimeMs: () => p.timeMs,
    isVideoPlaying: () => p.playing,
    getPlaybackRate: () => p.rate,
    uploadScript: up.upload,
    getStreamerOwnKey: () => ownKey,
  });
  return { bridge, world, settings, bus, player: p, uploader: up };
}

/** Run every pending timer (and the ones they create), then the promise. */
async function go(promise) {
  await vi.runAllTimersAsync();
  return promise;
}

/** Load a script for the room, the way app.js does on a video change. */
async function loadScript(bridge, label) {
  const token = bridge.beginSource({ title: label });
  bridge.setScript(token, { content: scriptContent(label), title: label });
  await vi.runAllTimersAsync();
  return token;
}

const round3 = (x) => Math.round(x * 1000) / 1000;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('the fake mirrors the real HandyManager contract', () => {
  it('every method the bridge calls exists on the REAL class', () => {
    for (const m of ['init', 'connect', 'disconnect', 'setOffset', 'syncTime', 'setupScript', 'hsspPlay', 'hsspStop', 'hdspMove']) {
      expect(typeof HandyManager.prototype[m], m).toBe('function');
    }
    expect(Object.getOwnPropertyDescriptor(HandyManager.prototype, 'connected')?.get).toBeTypeOf('function');
  });

  // FT-119: the old fake carried an `hdsp()` the real class does not have,
  // so Test buzz passed here and sent nothing in production since it shipped.
  it('every public member of the fake exists on the REAL HandyManager, as the same kind (method or getter)', () => {
    const Fake = makeFakeHandyCtor(makeWorld());
    const fake = new Fake();
    const names = new Set([
      ...Object.getOwnPropertyNames(Fake.prototype),
      ...Object.keys(fake).filter((k) => typeof fake[k] === 'function'),
    ]);
    names.delete('constructor');
    const checked = [];
    for (const name of names) {
      if (name.startsWith('_')) continue;   // the fake's own plumbing
      const real = Object.getOwnPropertyDescriptor(HandyManager.prototype, name);
      expect(real, `HandyManager.prototype.${name}`).toBeTruthy();
      const mine = Object.getOwnPropertyDescriptor(Fake.prototype, name) || Object.getOwnPropertyDescriptor(fake, name);
      expect(typeof real.get, `${name}: getter on one side only`).toBe(typeof mine.get);
      expect(typeof real.value, `${name}: method on one side only`).toBe(typeof mine.value);
      checked.push(name);
    }
    expect(checked).toEqual(expect.arrayContaining(['connected', 'deviceInfo', 'init', 'connect', 'hsspPlay', 'hsspStop', 'setupScript', 'hdspMove']));
    // The one plumbing name a test calls stands for the real one.
    expect(typeof HandyManager.prototype._handleDeviceLost).toBe('function');
  });

  it('every HandyManager member audience-bridge.js uses exists on the REAL class (a scan of its source)', () => {
    const src = fs.readFileSync('renderer/js/audience-bridge.js', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      // Import lines name files ('./handy-manager.js'), not members.
      .replace(/^import .*$/gm, '');
    const used = new Set();
    for (const m of src.matchAll(/\b(?:manager|m)\??\.(\w+)/g)) used.add(m[1]);
    for (const m of src.matchAll(/_call\(\w+,\s*'(\w+)'/g)) used.add(m[1]);
    expect(used.size).toBeGreaterThan(6);
    expect([...used]).toContain('hdspMove');
    for (const name of used) expect(name in HandyManager.prototype, `HandyManager has no ${name}`).toBe(true);
  });

  it('not connected: the REAL class answers stop true, play and setup false, and never throws — and so does the fake', async () => {
    const real = new HandyManager();
    const Fake = makeFakeHandyCtor(makeWorld());
    const fake = new Fake();
    for (const m of [real, fake]) {
      expect(await go(m.hsspStop())).toBe(true);
      expect(await go(m.hsspPlay(1000))).toBe(false);
      expect(await go(m.setupScript('https://x/y.csv'))).toBe(false);
      expect(await go(m.connect('KEY'))).toBe(false); // init() never ran
      expect(await go(m.hdspMove(70, 500))).toBe(undefined);
    }
  });

  it('connected: the REAL hdspMove and the fake answer nothing, send nothing while the firmware is unknown, and send the FW4 0-1 position', async () => {
    // The REAL class on a recording SDK object (no network).
    const sdkCalls = [];
    const real = new HandyManager();
    real._handy = {
      getState: () => ({}),
      setMode: async (mode) => { sdkCalls.push(['setMode', mode]); },
      hdsp: async (...args) => { sdkCalls.push(['hdsp', ...args]); },
    };
    real._connected = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const world = makeWorld();
    const opts = { latency: 0, fwVersion: null };
    const fake = new (makeFakeHandyCtor(world, opts))();
    await go(fake.init());
    await go(fake.connect('K'));

    // Firmware unknown: nothing at all.
    expect(await go(real.hdspMove(70, 500))).toBe(undefined);
    expect(await go(fake.hdspMove(70, 500))).toBe(undefined);
    expect(sdkCalls).toEqual([]);
    expect(world.sent).toEqual([]);

    // FW4: a mode switch, then 0.7 (not 70: that pins the slider at the top).
    real._deviceInfo = { fwVersion: '4.2.1+ca4dd961' };
    opts.fwVersion = '4.2.1+ca4dd961';
    await go(fake.connect('K'));
    expect(await go(real.hdspMove(70, 500))).toBe(undefined);
    expect(await go(fake.hdspMove(70, 500))).toBe(undefined);
    warn.mockRestore();
    expect(sdkCalls.map(([k, a, ...rest]) => [k, k === 'hdsp' ? round3(a) : a, ...rest]))
      .toEqual([['setMode', 2], ['hdsp', 0.7, 500, 'percent', 'time', true, true]]);
    expect(world.sent.map((e) => [e.kind, e.kind === 'hdsp' ? round3(e.xpt) : e.mode]))
      .toEqual([['mode', 2], ['hdsp', 0.7]]);
  });

  it('after HDSP the SDK refuses a play until a setup: the REAL class answers false for a viewer (no cached URL), and so does the fake', async () => {
    const real = new HandyManager();
    real._handy = {
      getState: () => ({ hssp: { scriptSet: false } }),
      hsspPlay: async () => { throw new Error('Script set is required'); },
    };
    real._connected = true;
    real.onError = () => {};
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await go(real.hsspPlay(1000))).toBe(false);
    quiet.mockRestore();
    warn.mockRestore();

    const world = makeWorld();
    const fake = new (makeFakeHandyCtor(world, { latency: 0 }))();
    await go(fake.init());
    await go(fake.connect('K'));
    await go(fake.setupScript(urlFor('a')));
    await go(fake.hdspMove(70, 500));
    expect(await go(fake.hsspPlay(1000))).toBe(false);
    expect(world.sent.filter((e) => e.kind === 'play')).toEqual([]);
    await go(fake.setupScript(urlFor('a')));
    expect(await go(fake.hsspPlay(1000))).toBe(true);
    expect(deviceOf(world, 'K')).toMatchObject({ playing: true, playUrl: urlFor('a'), mode: 'hssp' });
  });
});

describe('AudienceBridge — room lifecycle', () => {
  it('opens and ends a room', async () => {
    const { bridge, bus } = makeBridge();
    expect(bridge.roomActive).toBe(false);
    bridge.openRoom();
    expect(bridge.roomActive).toBe(true);
    expect(bus.events).toContainEqual({ type: 'audience:room-opened', payload: {} });

    await go(bridge.endRoom());
    expect(bridge.roomActive).toBe(false);
    expect(bus.events.some((e) => e.type === 'audience:room-ended')).toBe(true);
  });

  it('endRoom stops every playing device, then disconnects every viewer', async () => {
    const { bridge, world, player } = makeBridge();
    bridge.openRoom();
    await go(bridge.addViewer({ key: 'A', label: 'Alpha' }));
    await go(bridge.addViewer({ key: 'B', label: 'Beta' }));
    await loadScript(bridge, 's1');
    player.playing = true;
    bridge.onPlaying();
    await vi.runAllTimersAsync();
    expect(deviceOf(world, 'A').playing).toBe(true);
    expect(deviceOf(world, 'B').playing).toBe(true);

    await go(bridge.endRoom());
    expect(bridge.viewers.length).toBe(0);
    expect(deviceOf(world, 'A').playing).toBe(false);
    expect(deviceOf(world, 'B').playing).toBe(false);
    for (const m of world.managers) expect(m.connected).toBe(false);
  });

  it('openRoom is idempotent', () => {
    const { bridge, bus } = makeBridge();
    bridge.openRoom();
    bridge.openRoom();
    expect(bus.events.filter((e) => e.type === 'audience:room-opened').length).toBe(1);
  });
});

describe('AudienceBridge — addViewer', () => {
  it('rejects empty / null key', async () => {
    const { bridge } = makeBridge();
    bridge.openRoom();
    await expect(bridge.addViewer({ key: '' })).rejects.toThrow(/key required/);
    await expect(bridge.addViewer({})).rejects.toThrow(/key required/);
  });

  it('connects + persists roster + emits viewer-added', async () => {
    const { bridge, settings, bus } = makeBridge();
    bridge.openRoom();
    const snap = await go(bridge.addViewer({ key: 'A', label: 'Alpha' }));
    expect(snap.key).toBe('A');
    expect(snap.label).toBe('Alpha');
    expect(snap.status).toBe(VIEWER_STATUS.SYNCED);

    // Persisted to settings — the roster never carries runtime fields (S6).
    expect(settings.get('audience.viewers')).toEqual([{ key: 'A', label: 'Alpha', offsetMs: 0 }]);
    expect(bus.events.some((e) => e.type === 'audience:viewer-added')).toBe(true);
  });

  it('calls init() before connect(), and passes the key to connect()', async () => {
    // Regression guard: the real HandyManager needs init() before
    // connect() does anything, and connect() takes the key as an arg —
    // the constructor does not capture it. AudienceBridge previously
    // skipped init() and called connect() with no args, so every viewer
    // silently failed in production while this suite stayed green.
    const { bridge, world } = makeBridge();
    bridge.openRoom();
    const snap = await go(bridge.addViewer({ key: 'KEY1234' }));

    expect(snap.status).not.toBe(VIEWER_STATUS.ERROR);
    const kinds = world.managers[0].calls.map((c) => c.kind);
    expect(kinds.indexOf('init')).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf('init')).toBeLessThan(kinds.indexOf('connect'));
    expect(world.managers[0].calls.find((c) => c.kind === 'connect').key).toBe('KEY1234');
  });

  it('duplicate add updates label only, no second connect', async () => {
    const { bridge, settings, world } = makeBridge();
    bridge.openRoom();
    await go(bridge.addViewer({ key: 'A', label: 'Alpha' }));
    await go(bridge.addViewer({ key: 'A', label: 'New Name' }));
    expect(bridge.viewers.length).toBe(1);
    expect(world.managers.length).toBe(1);
    expect(bridge.viewers[0].label).toBe('New Name');
    expect(settings.get('audience.viewers')[0].label).toBe('New Name');
  });

  it('a viewer joining mid-video is armed from the room source and plays: sync, stop, setup, play', async () => {
    const { bridge, world, player } = makeBridge();
    bridge.openRoom();
    await loadScript(bridge, 'now');
    player.playing = true;
    player.timeMs = 12345;
    const snap = await go(bridge.addViewer({ key: 'A' }));
    expect(snap.status).toBe(VIEWER_STATUS.PLAYING);
    // The SDK's clock sync must be followed by a stop and a play
    // (feedback_handy_sync_needs_hssp_restart).
    expect(landed(world, 'A')).toEqual(['sync', 'stop', 'setup', 'play']);
    const play = landed(world, 'A', { full: true }).find((e) => e.kind === 'play');
    expect(play.url).toBe(urlFor('now'));
    expect(play.timeMs).toBe(12345);
  });

  it('joining while paused sets the script up and does NOT play', async () => {
    const { bridge, world } = makeBridge();
    bridge.openRoom();
    await loadScript(bridge, 'now');
    const snap = await go(bridge.addViewer({ key: 'A' }));
    expect(snap.status).toBe(VIEWER_STATUS.READY);
    expect(deviceOf(world, 'A').url).toBe(urlFor('now'));
    expect(landed(world, 'A')).not.toContain('play');
  });

  it('records error status + lastError on connect failure, and the viewer stays in the room and roster', async () => {
    const { bridge, settings } = makeBridge({ fakeOpts: { failConnect: true } });
    bridge.openRoom();
    const snap = await go(bridge.addViewer({ key: 'A', label: 'Alpha' }));
    expect(snap.status).toBe(VIEWER_STATUS.ERROR);
    expect(snap.lastError).toBeTruthy();
    // Absence is never destructive (S6): only the streamer's Remove takes
    // a viewer out.
    expect(bridge.viewers.map((v) => v.key)).toEqual(['A']);
    expect(settings.get('audience.viewers')).toEqual([{ key: 'A', label: 'Alpha', offsetMs: 0 }]);
  });

  it('rejects self-key collision with SELF_KEY error', async () => {
    const { bridge } = makeBridge({ ownKey: 'FAKEKEY1' });
    bridge.openRoom();
    await expect(bridge.addViewer({ key: 'FAKEKEY1', label: 'Me' }))
      .rejects.toMatchObject({ code: 'SELF_KEY' });
    expect(bridge.viewers.length).toBe(0);
  });

  it('self-key check is whitespace + case insensitive', async () => {
    const { bridge } = makeBridge({ ownKey: 'FAKEKEY1' });
    bridge.openRoom();
    await expect(bridge.addViewer({ key: '  fakekey1  ' }))
      .rejects.toMatchObject({ code: 'SELF_KEY' });
  });

  it('different keys do not trigger SELF_KEY', async () => {
    const { bridge } = makeBridge({ ownKey: 'FAKEKEY1' });
    bridge.openRoom();
    const snap = await go(bridge.addViewer({ key: 'aB3CdEfG' }));
    expect(snap.status).toBe(VIEWER_STATUS.SYNCED);
  });

  it('applies saved offset on connect', async () => {
    const { bridge, world } = makeBridge();
    bridge.openRoom();
    await go(bridge.addViewer({ key: 'A', offsetMs: 120 }));
    expect(world.managers[0].calls).toContainEqual({ kind: 'setOffset', ms: 120 });
  });
});

describe('AudienceBridge — removeViewer', () => {
  it('stops a playing device, disconnects, emits viewer-removed', async () => {
    const { bridge, world, bus, player } = makeBridge();
    bridge.openRoom();
    await go(bridge.addViewer({ key: 'A' }));
    await loadScript(bridge, 's1');
    player.playing = true;
    bridge.onPlaying();
    await vi.runAllTimersAsync();
    expect(deviceOf(world, 'A').playing).toBe(true);

    await go(bridge.removeViewer('A'));
    expect(bridge.viewers.length).toBe(0);
    expect(deviceOf(world, 'A').playing).toBe(false);
    expect(world.managers[0].connected).toBe(false);
    expect(bus.events.some((e) => e.type === 'audience:viewer-removed')).toBe(true);
  });

  it('keeps roster entry by default, drops it when forget: true', async () => {
    const { bridge, settings } = makeBridge();
    bridge.openRoom();
    await go(bridge.addViewer({ key: 'A', label: 'Alpha' }));
    await go(bridge.removeViewer('A'));
    expect(settings.get('audience.viewers')).toEqual([]);

    // Re-add then remove with forget
    await go(bridge.addViewer({ key: 'B', label: 'Beta' }));
    await go(bridge.removeViewer('B', { forget: true }));
    expect(settings.get('audience.viewers')).toEqual([]);
  });

  it('removing an unknown viewer is a no-op', async () => {
    const { bridge } = makeBridge();
    bridge.openRoom();
    await expect(bridge.removeViewer('nope')).resolves.toBeUndefined();
  });
});

describe('AudienceBridge — fan-out (one viewer never aborts the rest)', () => {
  async function room3(fakeOpts) {
    const ctx = makeBridge({ fakeOpts });
    ctx.bridge.openRoom();
    for (const k of ['A', 'B', 'C']) await go(ctx.bridge.addViewer({ key: k }));
    await loadScript(ctx.bridge, 's1');
    return ctx;
  }

  it('playing plays every ready viewer, at the player time read when each play is sent', async () => {
    const { bridge, world, player } = await room3();
    player.playing = true;
    player.timeMs = 5000;
    bridge.onPlaying();
    await vi.runAllTimersAsync();
    for (const k of ['A', 'B', 'C']) {
      const play = landed(world, k, { full: true }).filter((e) => e.kind === 'play').pop();
      expect(play).toMatchObject({ url: urlFor('s1'), timeMs: 5000 });
      expect(bridge.getViewerStatus(k)).toBe(VIEWER_STATUS.PLAYING);
    }
  });

  it('one viewer whose play is refused (false, not a throw) goes Error; the others still play', async () => {
    const { bridge, world, player } = await room3({
      behave: (kind, _args, fake) => (kind === 'play' && fake.connectionKey === 'B' ? { ok: false } : undefined),
    });
    player.playing = true;
    bridge.onPlaying();
    await vi.runAllTimersAsync();
    expect(deviceOf(world, 'A').playing).toBe(true);
    expect(deviceOf(world, 'C').playing).toBe(true);
    expect(deviceOf(world, 'B').playing).toBe(false);
    expect(bridge.getViewerStatus('B')).toBe(VIEWER_STATUS.ERROR);
    expect(bridge.viewers.find((v) => v.key === 'B').errorCode).toBe('play-failed');
    expect(bridge.getViewerStatus('A')).toBe(VIEWER_STATUS.PLAYING);
    expect(bridge.getViewerStatus('C')).toBe(VIEWER_STATUS.PLAYING);
  });

  it('a refused play stays Error through later pauses and plays until a play succeeds (sticky, S3)', async () => {
    let refuse = true;
    const { bridge, player } = await room3({
      behave: (kind, _args, fake) => (kind === 'play' && fake.connectionKey === 'B' && refuse ? { ok: false } : undefined),
    });
    player.playing = true;
    bridge.onPlaying();
    await vi.runAllTimersAsync();
    player.playing = false;
    bridge.onPaused();
    await vi.runAllTimersAsync();
    player.playing = true;
    bridge.onPlaying();
    await vi.runAllTimersAsync();
    // Never turned green by a pause or by the others playing.
    expect(bridge.getViewerStatus('B')).toBe(VIEWER_STATUS.ERROR);
    expect(bridge.aggregateStatus).toBe('error');
    // The next video clears a per-video failure, and a play that lands
    // turns it green again.
    refuse = false;
    await loadScript(bridge, 's2');
    await vi.runAllTimersAsync();
    expect(bridge.getViewerStatus('B')).toBe(VIEWER_STATUS.PLAYING);
  });

  it('hsspStopAll stops every playing device', async () => {
    const { bridge, world, player } = await room3();
    player.playing = true;
    bridge.onPlaying();
    await vi.runAllTimersAsync();
    await go(bridge.hsspStopAll());
    for (const k of ['A', 'B', 'C']) expect(deviceOf(world, k).playing).toBe(false);
  });

  it('setScript sets the script up on every viewer from ONE upload', async () => {
    const { bridge, world, uploader } = await room3();
    for (const k of ['A', 'B', 'C']) expect(deviceOf(world, k).url).toBe(urlFor('s1'));
    expect(uploader.uploads.map((u) => u.label)).toEqual(['s1']);
  });

  it('muted viewers are not played', async () => {
    const { bridge, world, player } = await room3();
    await go(bridge.setMuted('A', true));
    player.playing = true;
    bridge.onPlaying();
    await vi.runAllTimersAsync();
    expect(deviceOf(world, 'A').playing).toBe(false);
    expect(deviceOf(world, 'B').playing).toBe(true);
  });
});

describe('AudienceBridge — setMuted', () => {
  it('mute stops a playing device and shows Muted', async () => {
    const { bridge, world, player } = makeBridge();
    bridge.openRoom();
    await go(bridge.addViewer({ key: 'A' }));
    await loadScript(bridge, 's1');
    player.playing = true;
    bridge.onPlaying();
    await vi.runAllTimersAsync();
    expect(deviceOf(world, 'A').playing).toBe(true);

    await go(bridge.setMuted('A', true));
    expect(deviceOf(world, 'A').playing).toBe(false);
    expect(bridge.getViewerStatus('A')).toBe(VIEWER_STATUS.MUTED);
  });

  it('unmute while playing plays the current script again', async () => {
    const { bridge, world, player } = makeBridge();
    bridge.openRoom();
    await go(bridge.addViewer({ key: 'A' }));
    await loadScript(bridge, 's1');
    player.playing = true;
    player.timeMs = 5000;
    await go(bridge.setMuted('A', true));

    await go(bridge.setMuted('A', false));
    expect(deviceOf(world, 'A')).toMatchObject({ playing: true, playUrl: urlFor('s1') });
    expect(bridge.getViewerStatus('A')).toBe(VIEWER_STATUS.PLAYING);
  });

  // The room window learns `muted` only from viewer-status events (app test
  // 2026-11-04: with no `muted` in them, a muted viewer could not be unmuted
  // from the room). audience-room-mute.test.js drives the window itself.
  it('every mute change reaches the room window with `muted`, even when the status stays the same', async () => {
    const { bridge, bus } = makeBridge();
    bridge.openRoom();
    await go(bridge.addViewer({ key: 'A' }));
    await loadScript(bridge, 's1');
    // HandyManager's health check lost the device: Disconnected, and mute
    // does not change that status.
    bridge._viewers.get('A').manager._connected = false;
    bridge.onPaused();
    await vi.runAllTimersAsync();
    expect(bridge.getViewerStatus('A')).toBe(VIEWER_STATUS.DISCONNECTED);
    const statusEvents = () => bus.events.filter((e) => e.type === 'audience:viewer-status').map((e) => e.payload);
    const before = statusEvents().length;

    await go(bridge.setMuted('A', true));
    expect(statusEvents().slice(before).at(-1)).toMatchObject({ key: 'A', status: VIEWER_STATUS.DISCONNECTED, muted: true });
    await go(bridge.setMuted('A', false));
    expect(statusEvents().at(-1)).toMatchObject({ key: 'A', status: VIEWER_STATUS.DISCONNECTED, muted: false });
  });

  it('unmuting a viewer that never connected puts its error back, not a "muted" row that is not muted', async () => {
    const { bridge, bus } = makeBridge({ fakeOpts: { failConnect: true } });
    bridge.openRoom();
    await go(bridge.addViewer({ key: 'A' }));
    await go(bridge.setMuted('A', true));
    expect(bridge.getViewerStatus('A')).toBe(VIEWER_STATUS.MUTED);
    await go(bridge.setMuted('A', false));
    const last = bus.events.filter((e) => e.type === 'audience:viewer-status').at(-1).payload;
    expect(last).toMatchObject({ status: VIEWER_STATUS.ERROR, muted: false });
    expect(last.lastError).toBeTruthy();
    expect(bridge.viewers[0]).toMatchObject({ status: VIEWER_STATUS.ERROR, muted: false });
  });
});

describe('AudienceBridge — setOffsetForViewer', () => {
  it('clamps to [-500, 500] and persists', async () => {
    const { bridge, settings } = makeBridge();
    bridge.openRoom();
    await go(bridge.addViewer({ key: 'A' }));

    bridge.setOffsetForViewer('A', 9999);
    expect(bridge.viewers[0].offsetMs).toBe(500);
    bridge.setOffsetForViewer('A', -9999);
    expect(bridge.viewers[0].offsetMs).toBe(-500);
    bridge.setOffsetForViewer('A', 120);
    expect(bridge.viewers[0].offsetMs).toBe(120);

    expect(settings.get('audience.viewers')[0].offsetMs).toBe(120);
  });
});

describe('AudienceBridge — aggregate status', () => {
  it('returns "dim" when no room or no viewers', () => {
    const { bridge } = makeBridge();
    expect(bridge.aggregateStatus).toBe('dim');
    bridge.openRoom();
    expect(bridge.aggregateStatus).toBe('dim');
  });

  it('returns "connected" when all viewers are SYNCED', async () => {
    const { bridge } = makeBridge();
    bridge.openRoom();
    await go(bridge.addViewer({ key: 'A' }));
    await go(bridge.addViewer({ key: 'B' }));
    expect(bridge.aggregateStatus).toBe('connected');
  });

  it('returns "error" when any viewer is in error state', async () => {
    const world = makeWorld();
    let i = 0;
    const Good = makeFakeHandyCtor(world, { latency: 0 });
    const Bad = makeFakeHandyCtor(world, { latency: 0, failConnect: true });
    const HandyManagerCtor = function HMC() { return i++ === 1 ? new Bad() : new Good(); };
    const bridge = new AudienceBridge({ settings: makeSettings(), eventBus: makeBus(), HandyManagerCtor });
    bridge.openRoom();
    await go(bridge.addViewer({ key: 'A' }));
    await go(bridge.addViewer({ key: 'B' }));  // this one errors
    expect(bridge.aggregateStatus).toBe('error');
  });
});

// FT-119: Test buzz called `manager.hdsp()`, which the REAL HandyManager does
// not have (it has `hdspMove`), so it sent nothing since it shipped; the old
// fake carried an `hdsp` and the two tests here passed. The fake now mirrors
// the real hdspMove (FW4 0-1 scaling, nothing while the firmware is unknown)
// and the SDK's mode switch, which clears the script setup.
describe('AudienceBridge — Test buzz (FT-119)', () => {
  const hdspOf = (world, key) => landed(world, key, { full: true }).filter((e) => e.kind === 'hdsp');
  /** What reached `key`'s device after its last `kind`. */
  const afterLast = (world, key, kind) => {
    const kinds = landed(world, key);
    return kinds.slice(kinds.lastIndexOf(kind) + 1);
  };

  async function pausedRoom(keys = ['A', 'B'], fakeOpts) {
    const ctx = makeBridge({ fakeOpts });
    ctx.bridge.openRoom();
    for (const k of keys) await go(ctx.bridge.addViewer({ key: k }));
    await loadScript(ctx.bridge, 's1');
    return ctx;
  }

  it('Test buzz moves the targeted viewer via hdspMove: one stroke, 70 then 20 over 500 ms, at the FW4 0-1 scale; the others get nothing', async () => {
    const { bridge, world } = await pausedRoom();
    const onPulse = vi.fn();
    expect(await go(bridge.testBuzz('A', { onPulse }))).toBe(true);
    const moves = hdspOf(world, 'A');
    expect(moves.map((e) => e.position)).toEqual([70, 20]);
    expect(moves.map((e) => round3(e.xpt))).toEqual([0.7, 0.2]);
    expect(moves.every((e) => e.durationMs === 500)).toBe(true);
    expect(moves[1].at - moves[0].at).toBeGreaterThanOrEqual(TEST_BUZZ_PULSE.gapMs);
    expect(onPulse).toHaveBeenCalledTimes(1);
    expect(landed(world, 'B')).not.toContain('hdsp');
    expect(landed(world, 'B')).not.toContain('mode');
  });

  it('a buzz ends on a stop and sets the script up again while paused; a play after it runs setupScript before hsspPlay and follows the script', async () => {
    const { bridge, world, player } = await pausedRoom(['A']);
    await go(bridge.testBuzz('A'));
    // Back in HSSP (the stop's mode switch), stopped, the script set up
    // again, nothing played: the video is paused.
    expect(afterLast(world, 'A', 'hdsp')).toEqual(['mode', 'stop', 'setup']);
    expect(deviceOf(world, 'A')).toMatchObject({ mode: 'hssp', playing: false, url: urlFor('s1') });
    expect(bridge.getViewerStatus('A')).toBe(VIEWER_STATUS.READY);

    player.playing = true;
    player.timeMs = 3000;
    bridge.onPlaying();
    await vi.runAllTimersAsync();
    expect(afterLast(world, 'A', 'hdsp')).toEqual(['mode', 'stop', 'setup', 'play']);
    expect(deviceOf(world, 'A')).toMatchObject({ playing: true, playUrl: urlFor('s1'), playTimeMs: 3000 });
    // No play was refused for want of a setup (the SDK clears it on HDSP).
    expect(world.managers[0].refusedPlays).toBe(0);
    expect(bridge.getViewerStatus('A')).toBe(VIEWER_STATUS.PLAYING);
  });

  it('buzz while playing is refused: no HDSP reaches the device and it keeps playing', async () => {
    const { bridge, world, player } = await pausedRoom(['A']);
    player.playing = true;
    bridge.onPlaying();
    await vi.runAllTimersAsync();
    expect(bridge.getViewerStatus('A')).toBe(VIEWER_STATUS.PLAYING);
    const onPulse = vi.fn();
    expect(await go(bridge.testBuzz('A', { onPulse }))).toBe(false);
    expect(landed(world, 'A')).not.toContain('hdsp');
    expect(landed(world, 'A')).not.toContain('mode');
    expect(deviceOf(world, 'A').playing).toBe(true);
    expect(onPulse).not.toHaveBeenCalled();
  });

  it('a muted viewer, or one HandyManager lost, is refused', async () => {
    const { bridge, world } = await pausedRoom(['A', 'B']);
    await go(bridge.setMuted('A', true));
    world.managers[1]._handleDeviceLost();      // the health check lost B
    expect(await go(bridge.testBuzz('A'))).toBe(false);
    expect(await go(bridge.testBuzz('B'))).toBe(false);
    expect(world.sent.filter((e) => e.kind === 'hdsp' || e.kind === 'mode')).toEqual([]);
  });

  it('the video starting during a buzz: no play passes the gate until the new setup, then the viewer plays', async () => {
    const { bridge, world, player } = await pausedRoom(['A']);
    const buzz = bridge.testBuzz('A');
    await vi.advanceTimersByTimeAsync(100);     // the first move is out
    player.playing = true;
    player.timeMs = 1000;
    bridge.onPlaying();
    await go(buzz);
    expect(world.managers[0].refusedPlays).toBe(0);
    expect(afterLast(world, 'A', 'hdsp')).toEqual(['mode', 'stop', 'setup', 'play']);
    expect(deviceOf(world, 'A')).toMatchObject({ playing: true, playUrl: urlFor('s1') });
    expect(bridge.getViewerStatus('A')).toBe(VIEWER_STATUS.PLAYING);
  });

  it('Remove during a buzz whose move lands late skips the second move and ends on a stop after that move, before the disconnect', async () => {
    const { bridge, world } = await pausedRoom(['A'], {
      behave: (kind) => (kind === 'hdsp' ? { replyMs: 400, landMs: 400 } : undefined),
    });
    const buzz = bridge.testBuzz('A');
    await vi.advanceTimersByTimeAsync(100);     // the first move is out; it lands at +400
    const removing = bridge.removeViewer('A');
    await go(buzz);
    await go(removing);
    expect(hdspOf(world, 'A').map((e) => e.position)).toEqual([70]);
    expect(landed(world, 'A').at(-1)).toBe('stop');
    expect(deviceOf(world, 'A')).toMatchObject({ playing: false, mode: 'hssp' });
    expect(world.managers[0].connected).toBe(false);
    expect(world.dropped).toEqual([]);
  });

  it('a new video during a buzz: its setup waits for the buzz to end, so no mode switch lands after it, and the viewer plays the new video', async () => {
    const { bridge, world, player } = await pausedRoom(['A'], {
      behave: (kind) => (kind === 'hdsp' ? { replyMs: 300, landMs: 300 } : undefined),
    });
    const buzz = bridge.testBuzz('A');
    await vi.advanceTimersByTimeAsync(100);     // the first move is out; it lands at +300
    player.playing = true;
    await loadScript(bridge, 's2');             // the next video, with its script
    await go(buzz);
    const kinds = landed(world, 'A');
    expect(kinds.lastIndexOf('mode')).toBeLessThan(kinds.lastIndexOf('setup'));
    expect(kinds.lastIndexOf('hdsp')).toBeLessThan(kinds.lastIndexOf('setup'));
    expect(deviceOf(world, 'A')).toMatchObject({ playing: true, playUrl: urlFor('s2'), mode: 'hssp' });
    expect(world.managers[0].refusedPlays).toBe(0);
    expect(bridge.getViewerStatus('A')).toBe(VIEWER_STATUS.PLAYING);
  });

  it('a pause during a buzz skips its second move; the viewer is set up again and the next play follows', async () => {
    const { bridge, world, player } = await pausedRoom(['A']);
    const buzz = bridge.testBuzz('A');
    await vi.advanceTimersByTimeAsync(100);
    bridge.onPaused();                          // the room's stop, as on pause
    await go(buzz);
    expect(hdspOf(world, 'A').length).toBe(1);
    expect(deviceOf(world, 'A')).toMatchObject({ playing: false, mode: 'hssp', url: urlFor('s1') });
    player.playing = true;
    bridge.onPlaying();
    await vi.runAllTimersAsync();
    expect(deviceOf(world, 'A')).toMatchObject({ playing: true, playUrl: urlFor('s1') });
    expect(world.managers[0].refusedPlays).toBe(0);
  });

  it('quitting during a buzz whose move lands late: hsspStopAll answers only once a stop has landed after that move', async () => {
    const { bridge, world } = await pausedRoom(['A'], {
      behave: (kind) => (kind === 'hdsp' ? { replyMs: 400, landMs: 400 } : undefined),
    });
    const buzz = bridge.testBuzz('A');
    await vi.advanceTimersByTimeAsync(100);     // the first move is out; it lands at +400
    let results = null;
    const stopping = bridge.hsspStopAll().then((r) => { results = r; world.rendererGone = true; });
    await vi.runAllTimersAsync();
    await stopping;
    await buzz;
    expect(results.map((r) => r.value)).toEqual([true]);
    expect(hdspOf(world, 'A').length).toBe(1);  // the quit ended the pulse
    const kinds = landed(world, 'A');
    expect(kinds.lastIndexOf('stop')).toBeGreaterThan(kinds.lastIndexOf('hdsp'));
    expect(deviceOf(world, 'A').playing).toBe(false);
  });

  // Block F review (2026-11-16): with the firmware unknown no pulse can go,
  // so the buzz is refused before it flashes the streamer's screen, shuts
  // the gate, or stops and re-arms the viewer for nothing.
  it('firmware unknown: refused (no flash, nothing sent, no stop or setup), and the viewer still plays after', async () => {
    const { bridge, world, player } = await pausedRoom(['A'], { fwVersion: null });
    const before = world.sent.length;
    const onPulse = vi.fn();
    expect(await go(bridge.testBuzz('A', { onPulse }))).toBe(false);
    expect(onPulse, 'the streamer\'s screen flashed for a pulse that cannot go').not.toHaveBeenCalled();
    expect(world.sent.slice(before), 'a refused buzz still reached the device').toEqual([]);
    expect(world.sent.filter((e) => e.kind === 'hdsp' || e.kind === 'mode')).toEqual([]);
    player.playing = true;
    bridge.onPlaying();
    await vi.runAllTimersAsync();
    expect(deviceOf(world, 'A')).toMatchObject({ playing: true, playUrl: urlFor('s1') });
  });

  it('testBuzzAll buzzes every viewer that takes one (a muted one is skipped) and flashes once', async () => {
    const { bridge, world } = await pausedRoom(['A', 'B', 'C']);
    await go(bridge.setMuted('C', true));
    const onPulse = vi.fn();
    await go(bridge.testBuzzAll({ onPulse }));
    expect(hdspOf(world, 'A').length).toBe(2);
    expect(hdspOf(world, 'B').length).toBe(2);
    expect(hdspOf(world, 'C')).toEqual([]);
    expect(onPulse).toHaveBeenCalledTimes(1);
    for (const k of ['A', 'B']) {
      expect(bridge.getViewerStatus(k)).toBe(VIEWER_STATUS.READY);
      expect(deviceOf(world, k)).toMatchObject({ mode: 'hssp', url: urlFor('s1'), playing: false });
    }
  });
});

// FT-121: a viewer that dropped offline had no way back but Remove and Add.
describe('AudienceBridge — Resend (FT-121)', () => {
  async function roomWith(keys, fakeOpts) {
    const ctx = makeBridge({ fakeOpts });
    ctx.bridge.openRoom();
    for (const k of keys) await go(ctx.bridge.addViewer({ key: k }));
    await loadScript(ctx.bridge, 's1');
    return ctx;
  }
  const since = (world, key, n) => landed(world, key).slice(n);
  const count = (arr, kind) => arr.filter((k) => k === kind).length;

  it('a viewer whose setup failed: Resend clears the error and sets the script up; paused, it does not play', async () => {
    let refuse = true;
    const { bridge, world } = await roomWith(['A'], {
      behave: (kind) => (kind === 'setup' && refuse ? { ok: false } : undefined),
    });
    expect(bridge.viewers[0].errorCode).toBe('setup-failed');
    refuse = false;
    const n = landed(world, 'A').length;
    expect(await go(bridge.resend('A'))).toBe(true);
    // Asked twice, by the existing SDK-throttle rule: the last setup
    // answered false, so the first ok is not trusted until asked again.
    expect(count(since(world, 'A', n), 'setup')).toBe(2);
    expect(since(world, 'A', n)).not.toContain('play');
    expect(deviceOf(world, 'A').url).toBe(urlFor('s1'));
    expect(bridge.viewers[0]).toMatchObject({ status: VIEWER_STATUS.READY, errorCode: null });
  });

  it('a viewer whose play failed, while the video plays: Resend sends one setup and then plays it', async () => {
    let refuse = true;
    const { bridge, world, player } = await roomWith(['A'], {
      behave: (kind) => (kind === 'play' && refuse ? { ok: false } : undefined),
    });
    player.playing = true;
    player.timeMs = 8000;
    bridge.onPlaying();
    await vi.runAllTimersAsync();
    expect(bridge.viewers[0].errorCode).toBe('play-failed');
    refuse = false;
    const n = landed(world, 'A').length;
    expect(await go(bridge.resend('A'))).toBe(true);
    const tail = since(world, 'A', n);
    expect(count(tail, 'setup')).toBe(1);
    expect(tail.indexOf('setup')).toBeLessThan(tail.indexOf('play'));
    expect(deviceOf(world, 'A')).toMatchObject({ playing: true, playUrl: urlFor('s1'), playTimeMs: 8000 });
    expect(bridge.getViewerStatus('A')).toBe(VIEWER_STATUS.PLAYING);
  });

  it('a Handy switched off and on that HandyManager\'s health check lost: Resend connects it again on the same HandyManager, syncs its clock, stops it, sets it up and plays', async () => {
    const { bridge, world, player } = await roomWith(['A']);
    player.playing = true;
    bridge.onPlaying();
    await vi.runAllTimersAsync();
    powerCycle(world, 'A');
    world.managers[0]._handleDeviceLost();
    const n = landed(world, 'A').length;
    const connects = world.managers[0].calls.filter((c) => c.kind === 'connect').length;
    expect(await go(bridge.resend('A'))).toBe(true);
    expect(world.managers.length).toBe(1);      // the same HandyManager
    expect(world.managers[0].calls.filter((c) => c.kind === 'connect').length).toBe(connects + 1);
    expect(world.managers[0].calls.filter((c) => c.kind === 'init').length).toBe(1);
    expect(since(world, 'A', n)).toEqual(['sync', 'stop', 'setup', 'play']);
    expect(deviceOf(world, 'A')).toMatchObject({ playing: true, playUrl: urlFor('s1') });
    expect(bridge.getViewerStatus('A')).toBe(VIEWER_STATUS.PLAYING);
  });

  it('a row the bridge saw Disconnected while the SDK reconnected on its own: Resend still rejoins it, clock sync included', async () => {
    const { bridge, world, player } = await roomWith(['A']);
    world.managers[0]._handleDeviceLost();
    bridge.onPaused();                          // a stop finds it unreachable
    await vi.runAllTimersAsync();
    expect(bridge.getViewerStatus('A')).toBe(VIEWER_STATUS.DISCONNECTED);
    powerCycle(world, 'A');
    world.managers[0]._connected = true;        // the SDK's own 'connect' event
    const n = landed(world, 'A').length;
    expect(await go(bridge.resend('A'))).toBe(true);
    // The clock sync, then the stop (the join stop, plus the one the bridge
    // sends to prove it when it came inside 250 ms of the last stop: through
    // the SDK throttle the two were one request, sent straight to the cloud
    // since FT-124 both go), then the setup.
    const joined = since(world, 'A', n);
    expect(joined[0]).toBe('sync');
    expect(joined.slice(1, -1).length).toBeGreaterThanOrEqual(1);
    expect(joined.slice(1, -1).every((k) => k === 'stop')).toBe(true);
    expect(joined.at(-1)).toBe('setup');
    expect(bridge.getViewerStatus('A')).toBe(VIEWER_STATUS.READY);
    player.playing = true;
    bridge.onPlaying();
    await vi.runAllTimersAsync();
    expect(deviceOf(world, 'A')).toMatchObject({ playing: true, playUrl: urlFor('s1') });
  });

  it('a Handy switched off and on while paused that nobody noticed: its play fails, and Resend stops it, syncs its clock, stops it again, sets the script up and plays it', async () => {
    const { bridge, world, player } = await roomWith(['A']);
    powerCycle(world, 'A');
    player.playing = true;
    player.timeMs = 4000;
    bridge.onPlaying();
    await vi.runAllTimersAsync();
    expect(deviceOf(world, 'A').playing).toBe(false);   // the device lost its script
    expect(bridge.viewers[0]).toMatchObject({ status: VIEWER_STATUS.ERROR, errorCode: 'play-failed' });
    const n = landed(world, 'A').length;
    expect(await go(bridge.resend('A'))).toBe(true);
    // The health check never noticed, so nothing says the clock sync
    // survived: sync again, then the stop the SDK's sync needs (as Add).
    expect(since(world, 'A', n)).toEqual(['stop', 'sync', 'stop', 'setup', 'play']);
    expect(world.managers[0].calls.filter((c) => c.kind === 'connect').length).toBe(1);   // no reconnect
    expect(deviceOf(world, 'A')).toMatchObject({ playing: true, playUrl: urlFor('s1'), playTimeMs: 4000 });
    expect(bridge.viewers[0]).toMatchObject({ status: VIEWER_STATUS.PLAYING, errorCode: null });
  });

  it('a viewer that never connected: Resend connects it (init once) and arms it', async () => {
    const opts = { failConnect: true };
    const { bridge, world } = await roomWith(['A'], opts);
    expect(bridge.viewers[0].status).toBe(VIEWER_STATUS.ERROR);
    opts.failConnect = false;
    expect(await go(bridge.resend('A'))).toBe(true);
    expect(world.managers.length).toBe(1);
    expect(world.managers[0].calls.filter((c) => c.kind === 'init').length).toBe(1);
    expect(deviceOf(world, 'A').url).toBe(urlFor('s1'));
    expect(bridge.viewers[0]).toMatchObject({ status: VIEWER_STATUS.READY, lastError: null });
  });

  it('a Resend whose connect fails on a Handy the SDK still holds: the next pause still stops it', async () => {
    const opts = {};
    const { bridge, world, player } = await roomWith(['A'], opts);
    player.playing = true;
    bridge.onPlaying();
    await vi.runAllTimersAsync();
    world.managers[0]._handleDeviceLost();      // a cloud blip: the health check loses it,
    bridge.onSeeked();                          // so the seek's stop is never sent
    await vi.runAllTimersAsync();
    expect(bridge.getViewerStatus('A')).toBe(VIEWER_STATUS.DISCONNECTED);
    expect(deviceOf(world, 'A').playing).toBe(true);
    world.managers[0]._connected = true;        // the SDK reconnects on its own
    opts.failConnect = true;                    // and Resend's connect fails
    expect(await go(bridge.resend('A'))).toBe(false);
    player.playing = false;
    bridge.onPaused();
    await vi.runAllTimersAsync();
    expect(deviceOf(world, 'A').playing).toBe(false);
  });

  it('a connect that fails again keeps the viewer in the room and the roster with its error (S6)', async () => {
    const { bridge, settings } = await roomWith(['A'], { failConnect: true });
    expect(await go(bridge.resend('A'))).toBe(false);
    expect(bridge.viewers.map((v) => [v.key, v.status])).toEqual([['A', VIEWER_STATUS.ERROR]]);
    expect(settings.get('audience.viewers').map((v) => v.key)).toEqual(['A']);
  });

  it('a muted viewer: Resend sends nothing, not even a reconnect for one that dropped', async () => {
    const { bridge, world } = await roomWith(['A', 'B']);
    await go(bridge.setMuted('A', true));
    await go(bridge.setMuted('B', true));
    world.managers[1]._handleDeviceLost();
    const n = world.sent.length;
    const connects = world.managers[1].calls.filter((c) => c.kind === 'connect').length;
    expect(await go(bridge.resend('A'))).toBe(false);
    expect(await go(bridge.resend('B'))).toBe(false);
    expect(world.sent.length).toBe(n);
    expect(world.managers[1].calls.filter((c) => c.kind === 'connect').length).toBe(connects);
    expect(bridge.getViewerStatus('A')).toBe(VIEWER_STATUS.MUTED);
  });

  it('a second Resend while the first runs is refused: one reconnect', async () => {
    const { bridge, world } = await roomWith(['A']);
    world.managers[0]._handleDeviceLost();
    const first = bridge.resend('A');
    const second = bridge.resend('A');
    expect(await go(second)).toBe(false);
    expect(await go(first)).toBe(true);
    expect(world.managers[0].calls.filter((c) => c.kind === 'connect').length).toBe(2);   // add + one resend
  });
});
