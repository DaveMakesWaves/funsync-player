/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Handy invert toggle (#276 alvinchris, promised in #277 on 2026-08-13; asked
// again in #390 lonelyuber). Buttplug and T-Code already flip per tick; the
// Handy plays an UPLOADED script (HSSP), so the flip has to be baked into the
// upload, and per tick only at non-1x rates (HDSP).
//
// The invariant that matters: whatever the Handy is sent must equal what the
// per-tick stack (applyDeviceStack: extender -> invert -> range -> cutoff)
// would send. Inverting after the output-limits clamp breaks the floor: with a
// floor of 20, a 0 is clamped to 20 and then flipped to 80 (should be 100),
// and a 100 is flipped to 0, BELOW the floor. Every assertion here is on the
// value the device would get, not on the script.
import { describe, it, expect, beforeEach } from 'vitest';
import { liftAppClass } from './helpers/app-methods.js';
import {
  extendRawScriptContent, clampRawScriptContent, invertRawScriptContent,
  applyDeviceStack, computeNaturalRange,
} from '../../renderer/js/device-transform-stack.js';
import { fillRawScriptContent } from '../../renderer/js/filler-engine.js';
import { HandyHdspSync } from '../../renderer/js/handy-hdsp-sync.js';
import { engageHandyFinisher } from '../../renderer/js/orgasm-handy-engage.js';

const script = (actions, extra = {}) => JSON.stringify({ version: '1.0', inverted: false, range: 100, ...extra, actions });
const posOf = (content) => JSON.parse(content).actions.map((a) => a.pos);
const ZIGZAG = [0, 100, 10, 90, 25, 75, 50, 0, 100].map((pos, i) => ({ at: i * 250, pos }));
const NARROW = [40, 60, 45, 55, 40, 60].map((pos, i) => ({ at: i * 300, pos }));

describe('invertRawScriptContent — the upload-time flip', () => {
  it('flips every action (pos -> 100 - pos) and keeps everything else', () => {
    const raw = script(ZIGZAG, { metadata: { title: 'x' } });
    const out = JSON.parse(invertRawScriptContent(raw, true));
    expect(out.actions.map((a) => a.pos)).toEqual(ZIGZAG.map((a) => 100 - a.pos));
    expect(out.actions.map((a) => a.at)).toEqual(ZIGZAG.map((a) => a.at));
    expect(out.metadata).toEqual({ title: 'x' });
  });

  it('returns the same string when off, invalid, or with no actions', () => {
    const raw = script(ZIGZAG);
    expect(invertRawScriptContent(raw, false)).toBe(raw);
    expect(invertRawScriptContent(raw, undefined)).toBe(raw);
    expect(invertRawScriptContent('not json', true)).toBe('not json');
    const empty = script([]);
    expect(invertRawScriptContent(empty, true)).toBe(empty);
    expect(invertRawScriptContent('', true)).toBe('');
  });

  it('flipping twice is the identity', () => {
    const raw = script(ZIGZAG);
    expect(posOf(invertRawScriptContent(invertRawScriptContent(raw, true), true))).toEqual(ZIGZAG.map((a) => a.pos));
  });
});

// ── The real app.js methods, lifted ─────────────────────────────────────────

const LIFTED = [
  '_uploadAndStartSync', '_handyUploadContent', '_cutoffFromSettings', '_handyInverted',
  '_onHandyInvertChanged', '_handyOnLocalMain', '_stageHandyMainScript', '_onHandyRateBackToOne',
  '_rearmHandyIfInvertStale', '_restoreHandyAfterOrgasm',
  '_uploadDurationMsFor', '_sessionTimelineMs', // FT-113: the timeline an upload plays on
];

let Lifted;
let toasts;
const makeApp = ({ settings = {}, actions = ZIGZAG, filler = null } = {}) => {
  toasts = [];
  Lifted = liftAppClass(LIFTED, {
    extendRawScriptContent, clampRawScriptContent, invertRawScriptContent, fillRawScriptContent,
    showToast: (msg, kind) => toasts.push({ msg, kind }),
    t: (k) => k,
  });
  const app = new Lifted();
  const store = new Map(Object.entries(settings));
  app.settings = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };
  const video = { paused: false, currentTime: 12 };
  app.videoPlayer = { video, playbackRate: 1 };
  const raw = script(actions);
  app.funscriptEngine = { isLoaded: true, getRawContent: () => raw };
  app._fillerOptionsForUpload = () => filler;
  app._resolveCloudUpload = () => {};
  const log = [];
  let n = 0;
  app.handyManager = {
    connected: true,
    _lastCloudUrl: null,
    uploads: [],
    async uploadAndSetScript(content) {
      this.uploads.push(content);
      this._lastCloudUrl = `https://cloud/${++n}.csv`;
      log.push('upload');
      return true;
    },
    async setupScript(url) { log.push(`setup ${url}`); return true; },
    staged: [],
    stageGate: null, // a promise to hold the staging upload in flight
    async stageScript(content) {
      if (this.stageGate) await this.stageGate;
      this.staged.push(content);
      this._lastCloudUrl = `https://cloud/staged-${++n}.csv`;
      log.push('stage');
      return this._lastCloudUrl;
    },
  };
  app.syncEngine = {
    player: video,
    _scriptReady: false,
    start() { log.push('start'); },
    stop() { log.push('stop'); },
    async resync() { log.push('resync'); },
  };
  app.handyHdspSync = { active: false, inv: null, setInverted(v) { this.inv = v; }, start() {} };
  app._orgasmHandyEngaged = false;
  app.log = log;
  return app;
};

describe('_uploadAndStartSync — what the Handy is sent', () => {
  const CUTOFFS = [null, { min: 20, max: 100 }, { min: 0, max: 80 }, { min: 20, max: 70 }];
  for (const cutoff of CUTOFFS) {
    for (const ext of [false, true]) {
      it(`matches the per-tick stack: invert on, cutoff ${JSON.stringify(cutoff)}, extender ${ext}`, async () => {
        const actions = ext ? NARROW : ZIGZAG;
        const app = makeApp({
          settings: { 'handy.inverted': true, 'handy.cutoff': cutoff, 'player.rangeExtender.enabled': ext },
          actions,
        });
        await app._uploadAndStartSync();
        const sent = posOf(app.handyManager.uploads[0]);
        const natural = computeNaturalRange(actions);
        const expected = actions.map((a) => applyDeviceStack(a.pos, {
          natural, extender: { enabled: ext }, inverted: true, range: null, cutoff,
        }));
        sent.forEach((p, i) => expect(p).toBeCloseTo(expected[i], 6));
      });
    }
  }

  it('a floor still holds on the flipped script (0 -> 100, 100 -> the floor, never below)', async () => {
    const app = makeApp({ settings: { 'handy.inverted': true, 'handy.cutoff': { min: 20, max: 100 } } });
    await app._uploadAndStartSync();
    const sent = posOf(app.handyManager.uploads[0]);
    expect(Math.min(...sent)).toBeGreaterThanOrEqual(20);
    expect(sent[0]).toBe(100); // authored 0
    expect(sent[1]).toBe(20);  // authored 100, flipped to 0, pinned to the floor
  });

  it('invert off uploads exactly what it did before', async () => {
    const app = makeApp({ settings: { 'handy.cutoff': { min: 20, max: 100 } } });
    await app._uploadAndStartSync();
    expect(app.handyManager.uploads[0]).toBe(clampRawScriptContent(script(ZIGZAG), { min: 20, max: 100 }));
  });

  it('a missing or non-boolean setting is off', async () => {
    for (const v of [undefined, 'true', 1, null]) {
      const app = makeApp({ settings: { 'handy.inverted': v } });
      await app._uploadAndStartSync();
      expect(posOf(app.handyManager.uploads[0])).toEqual(ZIGZAG.map((a) => a.pos));
    }
  });

  it('the gap filler is flipped too (invert after the filler, as the per-tick devices do)', async () => {
    const gap = [{ at: 0, pos: 10 }, { at: 500, pos: 90 }, { at: 1000, pos: 10 }, { at: 21000, pos: 90 }, { at: 21500, pos: 10 }];
    const filler = { enabled: true, thresholdMs: 5000, pattern: 'sine', bpm: 20, depthPct: 100 };
    const off = makeApp({ actions: gap, filler });
    await off._uploadAndStartSync();
    const on = makeApp({ actions: gap, filler, settings: { 'handy.inverted': true } });
    await on._uploadAndStartSync();
    const a = posOf(off.handyManager.uploads[0]);
    const b = posOf(on.handyManager.uploads[0]);
    expect(a.length).toBeGreaterThan(gap.length); // filler really ran
    expect(b).toEqual(a.map((p) => 100 - p));
  });
});

describe('toggling invert', () => {
  let app;
  beforeEach(() => { app = makeApp(); });

  it('while the local player plays the main script: re-arms now (stop, upload flipped, start)', async () => {
    await app._uploadAndStartSync();
    app.log.length = 0;
    app.settings.set('handy.inverted', true);
    expect(await app._onHandyInvertChanged()).toBe('rearmed');
    expect(app.log).toEqual(['stop', 'upload', 'start']);
    expect(posOf(app.handyManager.uploads[1])).toEqual(ZIGZAG.map((a) => 100 - a.pos));
    expect(app.handyHdspSync.inv).toBe(true);
    // Same value again: nothing to do.
    expect(await app._onHandyInvertChanged()).toBe('idle');
    expect(app.handyManager.uploads).toHaveLength(2);
  });

  it('at a non-1x rate (HDSP driving): flips HDSP live and STAGES the flipped script, device untouched', async () => {
    await app._uploadAndStartSync();
    app.log.length = 0;
    app.handyHdspSync.active = true;
    app.settings.set('handy.inverted', true);
    expect(await app._onHandyInvertChanged()).toBe('hdsp-live');
    expect(app.handyHdspSync.inv).toBe(true);
    expect(app.log).toEqual(['stage']); // no stop, no setScript, no start
    expect(app.handyManager.uploads).toHaveLength(1);
    expect(posOf(app.handyManager.staged[0])).toEqual(ZIGZAG.map((a) => 100 - a.pos));
    // The staged URL is now the cached one the 1x restart re-sets.
    expect(app._scriptCloudUrl).toBe(app.handyManager._lastCloudUrl);
    expect(app._scriptCloudUrlInverted).toBe(true);
    // Back at 1x: nothing more to do — re-arming here raced the restart's
    // own setScript on Dave's Handy (2026-11-04).
    app.handyHdspSync.active = false;
    expect(await app._onHandyRateBackToOne()).toBe('staged');
    expect(app.log).toEqual(['stage']);
    expect(await app._onHandyRateBackToOne()).toBe('idle');
  });

  it('back at 1x while the staging upload is still in flight: re-arms once it lands', async () => {
    await app._uploadAndStartSync();
    let release;
    app.handyManager.stageGate = new Promise((r) => { release = r; });
    app.handyHdspSync.active = true;
    app.settings.set('handy.inverted', true);
    const toggled = app._onHandyInvertChanged();
    app.handyHdspSync.active = false;
    const back = app._onHandyRateBackToOne(); // the restart already re-set the OLD URL
    app.log.length = 0;
    release();
    expect(await toggled).toBe('hdsp-live');
    expect(await back).toBe('rearmed');
    expect(app.log).toEqual(['stage', 'stop', 'upload', 'start']);
    expect(posOf(app.handyManager.uploads.at(-1))).toEqual(ZIGZAG.map((a) => 100 - a.pos));
  });

  it('a stale cache with no toggle during HDSP still re-arms at 1x (e.g. staging failed)', async () => {
    await app._uploadAndStartSync();
    app.handyManager.stageScript = async () => null; // upload failed
    app.handyHdspSync.active = true;
    app.settings.set('handy.inverted', true);
    await app._onHandyInvertChanged();
    app.handyHdspSync.active = false;
    expect(await app._onHandyRateBackToOne()).toBe('rearmed');
    expect(posOf(app.handyManager.uploads.at(-1))).toEqual(ZIGZAG.map((a) => 100 - a.pos));
  });

  it('also re-arms when the local player is the VideoPlayer wrapper (the shape after a proxy restore)', async () => {
    // Found on Dave's Handy 2026-11-04: init() gives SyncEngine the <video>,
    // but `const localPlayer = this.videoPlayer` paths hand it the wrapper,
    // and a toggle then silently fell back to "next load".
    await app._uploadAndStartSync();
    app.syncEngine.player = app.videoPlayer;
    app.settings.set('handy.inverted', true);
    expect(await app._onHandyInvertChanged()).toBe('rearmed');
    expect(posOf(app.handyManager.uploads[1])).toEqual(ZIGZAG.map((a) => 100 - a.pos));
  });

  it('VR / phone / pop-out player: no re-upload of the local script, next load picks it up', async () => {
    await app._uploadAndStartSync();
    app.syncEngine.player = { paused: false, currentTime: 3 }; // a proxy
    app.settings.set('handy.inverted', true);
    expect(await app._onHandyInvertChanged()).toBe('next-load');
    expect(app.handyManager.uploads).toHaveLength(1);
  });

  it('Orgasm Switch holding: does not clobber the finisher', async () => {
    await app._uploadAndStartSync();
    app._orgasmHandyEngaged = true;
    app.settings.set('handy.inverted', true);
    expect(await app._onHandyInvertChanged()).toBe('next-load');
    expect(app.handyManager.uploads).toHaveLength(1);
  });

  it('Handy on a custom-routing route (last upload was not the main script): next load', async () => {
    await app._uploadAndStartSync();
    app.handyManager._lastCloudUrl = 'https://cloud/route.csv';
    app.settings.set('handy.inverted', true);
    expect(await app._onHandyInvertChanged()).toBe('next-load');
    expect(app.handyManager.uploads).toHaveLength(1);
  });

  it('no device or no script: idle, HDSP still told', async () => {
    app.handyManager.connected = false;
    app.settings.set('handy.inverted', true);
    expect(await app._onHandyInvertChanged()).toBe('idle');
    expect(app.handyHdspSync.inv).toBe(true);
    expect(app.handyManager.uploads).toHaveLength(0);
  });

  it('Orgasm Switch release after a toggle re-uploads instead of restoring the old direction', async () => {
    await app._uploadAndStartSync();
    const oldUrl = app._scriptCloudUrl;
    app._orgasmHandyEngaged = true;
    app.settings.set('handy.inverted', true);
    await app._onHandyInvertChanged(); // next-load while the finisher holds
    app._orgasmHandyEngaged = false;
    app.log.length = 0;
    await app._restoreHandyAfterOrgasm();
    expect(app.log).not.toContain(`setup ${oldUrl}`);
    expect(posOf(app.handyManager.uploads.at(-1))).toEqual(ZIGZAG.map((a) => 100 - a.pos));
  });

  it('Orgasm Switch release with no toggle still restores the cached URL (unchanged path)', async () => {
    await app._uploadAndStartSync();
    const url = app._scriptCloudUrl;
    app.log.length = 0;
    await app._restoreHandyAfterOrgasm();
    expect(app.log[0]).toBe(`setup ${url}`);
    expect(app.handyManager.uploads).toHaveLength(1);
  });
});

describe('HDSP (non-1x rates) flips per tick, before the cutoff', () => {
  const run = ({ inverted, cutoff, pos }) => {
    const sent = [];
    const video = { currentTime: 0 };
    const s = new HandyHdspSync({ handyManager: { hdspMove: (p) => sent.push(p) }, player: video });
    s.setTimerImpl(() => 1, () => {});
    s.setActions([{ at: 0, pos }, { at: 10000, pos }]);
    s.setCutoff(cutoff);
    s.setInverted(inverted);
    s.start();
    s._tick();
    return { s, sent, video };
  };

  it('sends the flipped position', () => {
    expect(run({ inverted: true, cutoff: null, pos: 30 }).sent).toEqual([70]);
    expect(run({ inverted: false, cutoff: null, pos: 30 }).sent).toEqual([30]);
  });

  it('a floor holds on the flipped value', () => {
    expect(run({ inverted: true, cutoff: { min: 20, max: 100 }, pos: 100 }).sent).toEqual([20]);
    expect(run({ inverted: true, cutoff: { min: 20, max: 100 }, pos: 0 }).sent).toEqual([100]);
  });

  it('toggling mid-hold sends the flipped position on the next tick', () => {
    const { s, sent } = run({ inverted: false, cutoff: null, pos: 30 });
    s._tick();
    expect(sent).toEqual([30]); // unchanged → suppressed
    s.setInverted(true);
    s._tick();
    expect(sent).toEqual([30, 70]);
  });

  it('start() works with the DEFAULT timers in a browser (receiver-checked setInterval)', () => {
    // Chromium's window.setInterval throws "Illegal invocation" unless called
    // with window (or no receiver). The engine stored it bare and called it
    // as `this._setIntervalImpl(...)`, so start() threw in every real build
    // from v0.8.0 to v0.9.2 and the Handy stopped at any rate but 1x. Node's
    // timers don't check, so emulate the browser here.
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    const calls = [];
    globalThis.setInterval = function (fn, ms) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      calls.push(ms);
      return 42;
    };
    globalThis.clearInterval = function (id) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      calls.push(`clear ${id}`);
    };
    try {
      const s = new HandyHdspSync({ handyManager: { hdspMove() {} }, player: { currentTime: 0 } });
      expect(() => s.start()).not.toThrow();
      expect(s.active).toBe(true);
      expect(() => s.stop()).not.toThrow();
      expect(calls).toEqual([expect.any(Number), 'clear 42']);
    } finally {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
    }
  });

  it('only a strict true turns it on', () => {
    expect(run({ inverted: 'yes', cutoff: null, pos: 30 }).sent).toEqual([30]);
  });
});

describe('Orgasm Switch finisher upload', () => {
  const finisher = script([{ at: 0, pos: 0 }, { at: 400, pos: 100 }, { at: 800, pos: 0 }]);
  const engage = async (opts) => {
    const uploaded = [];
    await engageHandyFinisher({
      handyManager: {
        uploadScriptOnly: async (c) => { uploaded.push(c); return 'https://cloud/fin.csv'; },
        setupScript: async () => true,
        hsspPlay: async () => {},
      },
      content: finisher,
      cachedUrl: null,
      isCurrent: () => true,
      ...opts,
    });
    return posOf(uploaded[0]);
  };

  it('is flipped before the clamp, so a floor holds', async () => {
    const plain = await engage({ cutoff: { min: 20, max: 100 } });
    const flipped = await engage({ cutoff: { min: 20, max: 100 }, inverted: true });
    expect(Math.min(...flipped)).toBeGreaterThanOrEqual(20);
    expect(plain[0]).toBe(20);   // authored 0 → floor
    expect(flipped[0]).toBe(100); // authored 0 → flipped 100
    expect(flipped[1]).toBe(20);  // authored 100 → flipped 0 → floor
  });

  it('defaults to not inverted', async () => {
    const sent = await engage({ cutoff: null });
    expect(sent.slice(0, 3)).toEqual([0, 100, 0]);
  });
});
