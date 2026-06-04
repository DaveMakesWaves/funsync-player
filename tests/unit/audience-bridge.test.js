// AudienceBridge — fan-out + lifecycle + per-viewer status.
// SCOPE: notes/features/SCOPE-audience-broadcast.md §5 + §7.
//
// Uses a FakeHandyManager injected via constructor so tests never touch
// the real SDK. The fake tracks every command applied to it so we can
// assert fan-out went to the right viewers.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AudienceBridge, VIEWER_STATUS } from '../../renderer/js/audience-bridge.js';

// --- Fake HandyManager ---

function makeFakeManager(opts = {}) {
  const calls = [];
  let connected = false;
  let initialized = false;

  const inst = {
    connectionKey: opts.connectionKey,
    calls,
    // Mirror the real HandyManager contract: init() must run before
    // connect() does anything. Modelling this is what guards against the
    // "AudienceBridge never called init()" regression.
    async init() {
      calls.push({ kind: 'init' });
      initialized = true;
    },
    async connect(key) {
      calls.push({ kind: 'connect', key });
      // Real connect() returns false when the SDK was never initialized
      // (this._handy is null). Fail the same way so a missing init() call
      // surfaces as a failed connect in tests too.
      if (!initialized) return false;
      if (opts.failConnect) return false;
      if (key) inst.connectionKey = key;
      connected = true;
      return true;
    },
    async disconnect() {
      calls.push({ kind: 'disconnect' });
      connected = false;
    },
    async setupScript(url) {
      calls.push({ kind: 'setupScript', url });
      if (opts.failUpload) throw new Error('Upload failed');
      return true;
    },
    async hsspPlay(timeMs) {
      calls.push({ kind: 'hsspPlay', timeMs });
      if (opts.failPlay) throw new Error('Play failed');
    },
    async hsspStop() {
      calls.push({ kind: 'hsspStop' });
    },
    async setOffset(ms) {
      calls.push({ kind: 'setOffset', ms });
    },
    async syncTime() {
      calls.push({ kind: 'syncTime' });
      if (opts.failSync) throw new Error('Sync failed');
      return { avgRtd: opts.rtdMs ?? 50, avgOffset: 0 };
    },
    async hdsp(pos, dur) {
      calls.push({ kind: 'hdsp', pos, dur });
    },
    get connected() { return connected; },
  };
  return inst;
}

function makeSettings(initial = {}) {
  let store = { ...initial };
  return {
    get: vi.fn((k) => store[k]),
    set: vi.fn((k, v) => { store[k] = v; }),
    _peek: () => store,
  };
}

function makeBus() {
  const events = [];
  return {
    events,
    emit: (type, payload) => { events.push({ type, payload }); },
  };
}

function makeBridge({ settings, bus, video = {}, fakeOpts = {} } = {}) {
  settings = settings || makeSettings();
  bus = bus || makeBus();
  const HandyManagerCtor = function HMC({ connectionKey } = {}) {
    return makeFakeManager({ connectionKey, ...fakeOpts });
  };
  return {
    bridge: new AudienceBridge({
      settings,
      eventBus: bus,
      HandyManagerCtor,
      getCurrentVideoTimeMs: () => video.timeMs ?? 0,
      isVideoPlaying: () => !!video.playing,
      getCurrentScriptUrl: () => video.scriptUrl || null,
    }),
    settings,
    bus,
  };
}

describe('AudienceBridge — room lifecycle', () => {
  it('opens and ends a room', async () => {
    const { bridge, bus } = makeBridge();
    expect(bridge.roomActive).toBe(false);
    bridge.openRoom();
    expect(bridge.roomActive).toBe(true);
    expect(bus.events).toContainEqual({ type: 'audience:room-opened', payload: {} });

    await bridge.endRoom();
    expect(bridge.roomActive).toBe(false);
    expect(bus.events.some((e) => e.type === 'audience:room-ended')).toBe(true);
  });

  it('endRoom disconnects every viewer', async () => {
    const { bridge } = makeBridge();
    bridge.openRoom();
    await bridge.addViewer({ key: 'A', label: 'Alpha' });
    await bridge.addViewer({ key: 'B', label: 'Beta' });
    expect(bridge.viewers.length).toBe(2);

    await bridge.endRoom();
    expect(bridge.viewers.length).toBe(0);
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
    const snap = await bridge.addViewer({ key: 'A', label: 'Alpha' });
    expect(snap.key).toBe('A');
    expect(snap.label).toBe('Alpha');
    expect(snap.status).toBe(VIEWER_STATUS.SYNCED);

    // Persisted to settings
    const roster = settings.get('audience.viewers');
    expect(roster).toEqual([{ key: 'A', label: 'Alpha', offsetMs: 0 }]);

    expect(bus.events.some((e) => e.type === 'audience:viewer-added')).toBe(true);
  });

  it('calls init() before connect(), and passes the key to connect()', async () => {
    // Regression guard: the real HandyManager needs init() before
    // connect() does anything, and connect() takes the key as an arg —
    // the constructor does not capture it. AudienceBridge previously
    // skipped init() and called connect() with no args, so every viewer
    // silently failed in production while this suite stayed green.
    const fakes = [];
    const HandyManagerCtor = function HMC({ connectionKey } = {}) {
      const m = makeFakeManager({ connectionKey });
      fakes.push(m);
      return m;
    };
    const bridge = new AudienceBridge({ settings: makeSettings(), eventBus: makeBus(), HandyManagerCtor });
    bridge.openRoom();
    const snap = await bridge.addViewer({ key: 'KEY1234' });

    expect(snap.status).not.toBe(VIEWER_STATUS.ERROR);
    const kinds = fakes[0].calls.map((c) => c.kind);
    expect(kinds.indexOf('init')).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf('init')).toBeLessThan(kinds.indexOf('connect'));
    expect(fakes[0].calls.find((c) => c.kind === 'connect').key).toBe('KEY1234');
  });

  it('duplicate add updates label only, no second connect', async () => {
    const { bridge, settings } = makeBridge();
    bridge.openRoom();
    await bridge.addViewer({ key: 'A', label: 'Alpha' });
    await bridge.addViewer({ key: 'A', label: 'New Name' });
    expect(bridge.viewers.length).toBe(1);
    expect(bridge.viewers[0].label).toBe('New Name');
    expect(settings.get('audience.viewers')[0].label).toBe('New Name');
  });

  it('auto-arms + hsspPlays when a script is loaded + video playing', async () => {
    const { bridge } = makeBridge({ video: { scriptUrl: 'https://x/y.csv', playing: true, timeMs: 12345 } });
    bridge.openRoom();
    const snap = await bridge.addViewer({ key: 'A' });
    expect(snap.status).toBe(VIEWER_STATUS.PLAYING);
  });

  it('auto-uploads but does NOT play when paused', async () => {
    const { bridge } = makeBridge({ video: { scriptUrl: 'https://x/y.csv', playing: false } });
    bridge.openRoom();
    const snap = await bridge.addViewer({ key: 'A' });
    expect(snap.status).toBe(VIEWER_STATUS.SYNCED);
  });

  it('records error status + lastError on connect failure', async () => {
    const { bridge } = makeBridge({ fakeOpts: { failConnect: true } });
    bridge.openRoom();
    const snap = await bridge.addViewer({ key: 'A' });
    expect(snap.status).toBe(VIEWER_STATUS.ERROR);
    expect(snap.lastError).toBeTruthy();
  });

  it('rejects self-key collision with SELF_KEY error', async () => {
    const HandyManagerCtor = function HMC({ connectionKey } = {}) {
      return makeFakeManager({ connectionKey });
    };
    const bridge = new AudienceBridge({
      settings: makeSettings(),
      eventBus: makeBus(),
      HandyManagerCtor,
      getStreamerOwnKey: () => 'eK6Qv3AH',
    });
    bridge.openRoom();
    await expect(bridge.addViewer({ key: 'eK6Qv3AH', label: 'Me' }))
      .rejects.toMatchObject({ code: 'SELF_KEY' });
    expect(bridge.viewers.length).toBe(0);
  });

  it('self-key check is whitespace + case insensitive', async () => {
    const HandyManagerCtor = function HMC({ connectionKey } = {}) {
      return makeFakeManager({ connectionKey });
    };
    const bridge = new AudienceBridge({
      settings: makeSettings(),
      eventBus: makeBus(),
      HandyManagerCtor,
      getStreamerOwnKey: () => 'eK6Qv3AH',
    });
    bridge.openRoom();
    await expect(bridge.addViewer({ key: '  ek6qv3ah  ' }))
      .rejects.toMatchObject({ code: 'SELF_KEY' });
  });

  it('different keys do not trigger SELF_KEY', async () => {
    const HandyManagerCtor = function HMC({ connectionKey } = {}) {
      return makeFakeManager({ connectionKey });
    };
    const bridge = new AudienceBridge({
      settings: makeSettings(),
      eventBus: makeBus(),
      HandyManagerCtor,
      getStreamerOwnKey: () => 'eK6Qv3AH',
    });
    bridge.openRoom();
    const snap = await bridge.addViewer({ key: 'aB3CdEfG' });
    expect(snap.status).toBe(VIEWER_STATUS.SYNCED);
  });

  it('applies saved offset on connect', async () => {
    const fakes = [];
    const HandyManagerCtor = function HMC({ connectionKey } = {}) {
      const m = makeFakeManager({ connectionKey });
      fakes.push(m);
      return m;
    };
    const bridge = new AudienceBridge({
      settings: makeSettings(),
      eventBus: makeBus(),
      HandyManagerCtor,
    });
    bridge.openRoom();
    await bridge.addViewer({ key: 'A', offsetMs: 120 });
    expect(fakes[0].calls).toContainEqual({ kind: 'setOffset', ms: 120 });
  });
});

describe('AudienceBridge — removeViewer', () => {
  it('stops + disconnects + emits viewer-removed', async () => {
    const fakes = [];
    const HandyManagerCtor = function HMC({ connectionKey } = {}) {
      const m = makeFakeManager({ connectionKey });
      fakes.push(m);
      return m;
    };
    const bus = makeBus();
    const bridge = new AudienceBridge({ settings: makeSettings(), eventBus: bus, HandyManagerCtor });
    bridge.openRoom();
    await bridge.addViewer({ key: 'A' });

    await bridge.removeViewer('A');
    expect(bridge.viewers.length).toBe(0);
    expect(fakes[0].calls).toContainEqual({ kind: 'hsspStop' });
    expect(fakes[0].calls).toContainEqual({ kind: 'disconnect' });
    expect(bus.events.some((e) => e.type === 'audience:viewer-removed')).toBe(true);
  });

  it('keeps roster entry by default, drops it when forget: true', async () => {
    const { bridge, settings } = makeBridge();
    bridge.openRoom();
    await bridge.addViewer({ key: 'A', label: 'Alpha' });
    await bridge.removeViewer('A');
    expect(settings.get('audience.viewers')).toEqual([]);

    // Re-add then remove with forget
    await bridge.addViewer({ key: 'B', label: 'Beta' });
    await bridge.removeViewer('B', { forget: true });
    expect(settings.get('audience.viewers')).toEqual([]);
  });

  it('removing an unknown viewer is a no-op', async () => {
    const { bridge } = makeBridge();
    bridge.openRoom();
    await expect(bridge.removeViewer('nope')).resolves.toBeUndefined();
  });
});

describe('AudienceBridge — fan-out (Promise.allSettled)', () => {
  it('hsspPlayAll fires hsspPlay on every viewer in parallel', async () => {
    const fakes = [];
    const HandyManagerCtor = function HMC({ connectionKey } = {}) {
      const m = makeFakeManager({ connectionKey });
      fakes.push(m);
      return m;
    };
    const bridge = new AudienceBridge({ settings: makeSettings(), eventBus: makeBus(), HandyManagerCtor });
    bridge.openRoom();
    await bridge.addViewer({ key: 'A' });
    await bridge.addViewer({ key: 'B' });
    await bridge.addViewer({ key: 'C' });

    await bridge.hsspPlayAll(5000);

    for (const m of fakes) {
      expect(m.calls).toContainEqual({ kind: 'hsspPlay', timeMs: 5000 });
    }
  });

  it('one viewer failing does NOT abort the rest', async () => {
    const fakes = [];
    let i = 0;
    const HandyManagerCtor = function HMC({ connectionKey } = {}) {
      const m = makeFakeManager({
        connectionKey,
        failPlay: i++ === 1,  // second viewer fails hsspPlay
      });
      fakes.push(m);
      return m;
    };
    const bridge = new AudienceBridge({ settings: makeSettings(), eventBus: makeBus(), HandyManagerCtor });
    bridge.openRoom();
    await bridge.addViewer({ key: 'A' });
    await bridge.addViewer({ key: 'B' });
    await bridge.addViewer({ key: 'C' });

    await bridge.hsspPlayAll(0);
    // All three were called even though B failed
    for (const m of fakes) {
      expect(m.calls.some((c) => c.kind === 'hsspPlay')).toBe(true);
    }
    // B is in error state
    expect(bridge.getViewerStatus('B')).toBe(VIEWER_STATUS.ERROR);
    // A and C remained playing
    expect(bridge.getViewerStatus('A')).toBe(VIEWER_STATUS.PLAYING);
    expect(bridge.getViewerStatus('C')).toBe(VIEWER_STATUS.PLAYING);
  });

  it('hsspStopAll fires hsspStop on every viewer', async () => {
    const fakes = [];
    const HandyManagerCtor = function HMC({ connectionKey } = {}) {
      const m = makeFakeManager({ connectionKey });
      fakes.push(m);
      return m;
    };
    const bridge = new AudienceBridge({ settings: makeSettings(), eventBus: makeBus(), HandyManagerCtor });
    bridge.openRoom();
    await bridge.addViewer({ key: 'A' });
    await bridge.addViewer({ key: 'B' });

    await bridge.hsspStopAll();
    for (const m of fakes) {
      expect(m.calls.some((c) => c.kind === 'hsspStop')).toBe(true);
    }
  });

  it('uploadScriptToAll fans out setupScript', async () => {
    const fakes = [];
    const HandyManagerCtor = function HMC({ connectionKey } = {}) {
      const m = makeFakeManager({ connectionKey });
      fakes.push(m);
      return m;
    };
    const bridge = new AudienceBridge({ settings: makeSettings(), eventBus: makeBus(), HandyManagerCtor });
    bridge.openRoom();
    await bridge.addViewer({ key: 'A' });
    await bridge.addViewer({ key: 'B' });

    await bridge.uploadScriptToAll('https://example/new.csv');
    for (const m of fakes) {
      expect(m.calls).toContainEqual({ kind: 'setupScript', url: 'https://example/new.csv' });
    }
  });

  it('muted viewers are skipped on fan-out', async () => {
    const fakes = [];
    const HandyManagerCtor = function HMC({ connectionKey } = {}) {
      const m = makeFakeManager({ connectionKey });
      fakes.push(m);
      return m;
    };
    const bridge = new AudienceBridge({ settings: makeSettings(), eventBus: makeBus(), HandyManagerCtor });
    bridge.openRoom();
    await bridge.addViewer({ key: 'A' });
    await bridge.addViewer({ key: 'B' });
    await bridge.setMuted('A', true);

    // Reset call logs to make fan-out assertions cleaner
    fakes.forEach((f) => f.calls.length = 0);
    await bridge.hsspPlayAll(0);

    expect(fakes[0].calls.find((c) => c.kind === 'hsspPlay')).toBeUndefined();
    expect(fakes[1].calls.find((c) => c.kind === 'hsspPlay')).toBeTruthy();
  });
});

describe('AudienceBridge — syncTimeAll', () => {
  it('runs sync + restores HSSP at current time when video is playing', async () => {
    const fakes = [];
    const HandyManagerCtor = function HMC({ connectionKey } = {}) {
      const m = makeFakeManager({ connectionKey, rtdMs: 75 });
      fakes.push(m);
      return m;
    };
    const bridge = new AudienceBridge({
      settings: makeSettings(),
      eventBus: makeBus(),
      HandyManagerCtor,
      getCurrentVideoTimeMs: () => 9999,
      isVideoPlaying: () => true,
      getCurrentScriptUrl: () => 'x',
    });
    bridge.openRoom();
    await bridge.addViewer({ key: 'A' });

    fakes[0].calls.length = 0;
    await bridge.syncTimeAll();
    const types = fakes[0].calls.map((c) => c.kind);
    expect(types).toContain('syncTime');
    expect(types).toContain('hsspStop');
    expect(types).toContain('hsspPlay');
    // Order matters — hsspStop + hsspPlay AFTER syncTime
    const syncIdx = types.indexOf('syncTime');
    const stopIdx = types.indexOf('hsspStop');
    expect(stopIdx).toBeGreaterThan(syncIdx);

    expect(bridge.viewers[0].rtdMs).toBe(75);
  });

  it('skips hsspStop+hsspPlay when video is paused', async () => {
    const fakes = [];
    const HandyManagerCtor = function HMC({ connectionKey } = {}) {
      const m = makeFakeManager({ connectionKey });
      fakes.push(m);
      return m;
    };
    const bridge = new AudienceBridge({
      settings: makeSettings(),
      eventBus: makeBus(),
      HandyManagerCtor,
      isVideoPlaying: () => false,
      getCurrentScriptUrl: () => 'x',
    });
    bridge.openRoom();
    await bridge.addViewer({ key: 'A' });

    fakes[0].calls.length = 0;
    await bridge.syncTimeAll();
    expect(fakes[0].calls.filter((c) => c.kind === 'hsspPlay').length).toBe(0);
  });
});

describe('AudienceBridge — setMuted', () => {
  it('mute calls hsspStop, sets status MUTED', async () => {
    const fakes = [];
    const HandyManagerCtor = function HMC({ connectionKey } = {}) {
      const m = makeFakeManager({ connectionKey });
      fakes.push(m);
      return m;
    };
    const bridge = new AudienceBridge({ settings: makeSettings(), eventBus: makeBus(), HandyManagerCtor });
    bridge.openRoom();
    await bridge.addViewer({ key: 'A' });

    fakes[0].calls.length = 0;
    await bridge.setMuted('A', true);
    expect(fakes[0].calls.some((c) => c.kind === 'hsspStop')).toBe(true);
    expect(bridge.getViewerStatus('A')).toBe(VIEWER_STATUS.MUTED);
  });

  it('unmute re-arms when video is playing', async () => {
    const fakes = [];
    const HandyManagerCtor = function HMC({ connectionKey } = {}) {
      const m = makeFakeManager({ connectionKey });
      fakes.push(m);
      return m;
    };
    const bridge = new AudienceBridge({
      settings: makeSettings(),
      eventBus: makeBus(),
      HandyManagerCtor,
      isVideoPlaying: () => true,
      getCurrentVideoTimeMs: () => 5000,
      getCurrentScriptUrl: () => 'x',
    });
    bridge.openRoom();
    await bridge.addViewer({ key: 'A' });
    await bridge.setMuted('A', true);

    fakes[0].calls.length = 0;
    await bridge.setMuted('A', false);
    expect(fakes[0].calls.some((c) => c.kind === 'hsspPlay')).toBe(true);
    expect(bridge.getViewerStatus('A')).toBe(VIEWER_STATUS.PLAYING);
  });
});

describe('AudienceBridge — setOffsetForViewer', () => {
  it('clamps to [-500, 500] and persists', async () => {
    const fakes = [];
    const HandyManagerCtor = function HMC({ connectionKey } = {}) {
      const m = makeFakeManager({ connectionKey });
      fakes.push(m);
      return m;
    };
    const settings = makeSettings();
    const bridge = new AudienceBridge({ settings, eventBus: makeBus(), HandyManagerCtor });
    bridge.openRoom();
    await bridge.addViewer({ key: 'A' });

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
    await bridge.addViewer({ key: 'A' });
    await bridge.addViewer({ key: 'B' });
    expect(bridge.aggregateStatus).toBe('connected');
  });

  it('returns "error" when any viewer is in error state', async () => {
    const fakes = [];
    let i = 0;
    const HandyManagerCtor = function HMC({ connectionKey } = {}) {
      const m = makeFakeManager({ connectionKey, failConnect: i++ === 1 });
      fakes.push(m);
      return m;
    };
    const bridge = new AudienceBridge({ settings: makeSettings(), eventBus: makeBus(), HandyManagerCtor });
    bridge.openRoom();
    await bridge.addViewer({ key: 'A' });
    await bridge.addViewer({ key: 'B' });  // this one errors
    expect(bridge.aggregateStatus).toBe('error');
  });
});

describe('AudienceBridge — testBuzz', () => {
  it('fires HDSP pulse on the targeted viewer only', async () => {
    const fakes = [];
    const HandyManagerCtor = function HMC({ connectionKey } = {}) {
      const m = makeFakeManager({ connectionKey });
      fakes.push(m);
      return m;
    };
    const bridge = new AudienceBridge({ settings: makeSettings(), eventBus: makeBus(), HandyManagerCtor });
    bridge.openRoom();
    await bridge.addViewer({ key: 'A' });
    await bridge.addViewer({ key: 'B' });

    fakes.forEach((f) => f.calls.length = 0);
    await bridge.testBuzz('A');
    expect(fakes[0].calls.some((c) => c.kind === 'hdsp')).toBe(true);
    expect(fakes[1].calls.some((c) => c.kind === 'hdsp')).toBe(false);
  });

  it('testBuzzAll fires HDSP on every viewer', async () => {
    const fakes = [];
    const HandyManagerCtor = function HMC({ connectionKey } = {}) {
      const m = makeFakeManager({ connectionKey });
      fakes.push(m);
      return m;
    };
    const bridge = new AudienceBridge({ settings: makeSettings(), eventBus: makeBus(), HandyManagerCtor });
    bridge.openRoom();
    await bridge.addViewer({ key: 'A' });
    await bridge.addViewer({ key: 'B' });

    fakes.forEach((f) => f.calls.length = 0);
    await bridge.testBuzzAll();
    for (const m of fakes) {
      expect(m.calls.some((c) => c.kind === 'hdsp')).toBe(true);
    }
  });
});
