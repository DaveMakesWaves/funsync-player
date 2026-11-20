/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Orgasm Switch — Handy HSSP engage/release ORDER contract + finisher tiling.
//
// The finisher plays on the Handy via a TILED HSSP upload (the pattern
// repeated back-to-back to ~10 min): HSSP loop mode is NOT used because
// setHsspLoop 404s against the current handyfeeling API (on-device log
// 2026-08-03) — the device would play the finisher once and stop. Engage is
// deliberately minimal (setScript → hsspPlay, no hsspStop) so the main
// script keeps stroking through the handoff and press latency stays at two
// round-trips. These tests assert call ORDER and await sequencing with a
// fake that mirrors the real HandyManager contract — not just call
// presence — because this feature's on-device failures were all sequencing
// races.

import { describe, it, expect, vi } from 'vitest';
import {
  engageHandyFinisher,
  releaseHandyFinisher,
  tileFinisherContent,
  holdFinisherEnd,
  HOLD_END_MS,
  TILE_TARGET_MS,
  TILE_MAX_ACTIONS,
} from '../../renderer/js/orgasm-handy-engage.js';

/** Ordered-recording fake mirroring the HandyManager methods the sequences use. */
function makeFakeHandy(overrides = {}) {
  const calls = [];
  const fake = {
    calls,
    uploadScriptOnly: vi.fn(async (content) => { calls.push(['uploadScriptOnly', content]); return 'https://cloud/x.csv'; }),
    hsspStop: vi.fn(async () => { calls.push(['hsspStop']); }),
    setupScript: vi.fn(async (url) => { calls.push(['setupScript', url]); return true; }),
    hsspPlay: vi.fn(async (t) => { calls.push(['hsspPlay', t]); return true; }),
    ...overrides,
  };
  return fake;
}

const SCRIPT = JSON.stringify({ actions: [
  { at: 0, pos: 10 }, { at: 500, pos: 100 }, { at: 1000, pos: 10 },
] });

describe('engageHandyFinisher — happy path', () => {
  it('runs setScript then hsspPlay(0), NO hsspStop and NO setLoop, and reports looping', async () => {
    const handy = makeFakeHandy();
    const cached = [];
    const status = await engageHandyFinisher({
      handyManager: handy,
      content: SCRIPT,
      cachedUrl: null,
      onUrlCached: (u) => cached.push(u),
      isCurrent: () => true,
    });
    expect(status).toBe('looping');
    expect(handy.calls.map((c) => c[0])).toEqual(['uploadScriptOnly', 'setupScript', 'hsspPlay']);
    expect(handy.hsspPlay).toHaveBeenCalledWith(0);
    // hsspStop deliberately absent: setScript replaces playback itself, and
    // skipping the round-trip keeps the main script stroking through the
    // handoff (latency report, 2026-08-03).
    expect(handy.hsspStop).not.toHaveBeenCalled();
    expect(cached).toEqual(['https://cloud/x.csv']);
  });

  it('uploads the finisher TILED (device loops it without HSSP loop mode)', async () => {
    const handy = makeFakeHandy();
    await engageHandyFinisher({
      handyManager: handy,
      content: SCRIPT,
      cachedUrl: null,
      isCurrent: () => true,
    });
    const uploaded = JSON.parse(handy.uploadScriptOnly.mock.calls[0][0]);
    const last = uploaded.actions[uploaded.actions.length - 1];
    expect(uploaded.actions.length).toBeGreaterThan(3);
    expect(last.at).toBeGreaterThanOrEqual(TILE_TARGET_MS);
  });

  // Device session 2026-11-20, step 37: an HSSP script that reaches its END
  // left Dave's Handy at the last point's RAW position (4 mm with a 35-65
  // stroke zone), not where the ending finished. So an ending's last position
  // is carried on in the upload while the key is held.
  it('uploads an ending (once) NOT tiled, with its last position held for HOLD_END_MS', async () => {
    const handy = makeFakeHandy();
    await engageHandyFinisher({ handyManager: handy, content: SCRIPT, cachedUrl: null, once: true, isCurrent: () => true });
    const uploaded = JSON.parse(handy.uploadScriptOnly.mock.calls[0][0]).actions;
    expect(uploaded.slice(0, 3), 'the ending itself plays once, untouched').toEqual(JSON.parse(SCRIPT).actions);
    expect(uploaded).toHaveLength(4);
    expect(uploaded[3]).toEqual({ at: 1000 + HOLD_END_MS, pos: 10 });
    expect(HOLD_END_MS, 'held as long as a tiled loop lasts').toBe(TILE_TARGET_MS);
  });

  it('the held end goes through invert and the output limit like every other point', async () => {
    const handy = makeFakeHandy();
    await engageHandyFinisher({
      handyManager: handy, content: SCRIPT, cachedUrl: null, once: true, inverted: true,
      cutoff: { min: 20, max: 80 }, isCurrent: () => true,
    });
    const uploaded = JSON.parse(handy.uploadScriptOnly.mock.calls[0][0]).actions;
    const lastTwo = uploaded.slice(-2);
    expect(lastTwo[0].pos, 'inverted (100 - 10 = 90), then held to 80').toBe(80);
    expect(lastTwo[1].pos, 'the hold is at the same, limited position').toBe(lastTwo[0].pos);
  });

  it('skips the upload when a cached cloud URL exists', async () => {
    const handy = makeFakeHandy();
    const status = await engageHandyFinisher({
      handyManager: handy,
      content: SCRIPT,
      cachedUrl: 'https://cloud/cached.csv',
      isCurrent: () => true,
    });
    expect(status).toBe('looping');
    expect(handy.uploadScriptOnly).not.toHaveBeenCalled();
    expect(handy.setupScript).toHaveBeenCalledWith('https://cloud/cached.csv');
  });

  it('AWAITS setupScript before hsspPlay (play must never race the setup)', async () => {
    let releaseSetup;
    const handy = makeFakeHandy();
    handy.setupScript = vi.fn((url) => {
      handy.calls.push(['setupScript', url]);
      return new Promise((res) => { releaseSetup = res; });
    });
    const pending = engageHandyFinisher({
      handyManager: handy,
      content: null,
      cachedUrl: 'https://cloud/cached.csv',
      isCurrent: () => true,
    });
    await Promise.resolve(); await Promise.resolve();
    expect(handy.hsspPlay).not.toHaveBeenCalled();
    releaseSetup(true);
    const status = await pending;
    expect(status).toBe('looping');
    expect(handy.hsspPlay).toHaveBeenCalledWith(0);
  });
});

describe('engageHandyFinisher — output cutoff baked into the upload', () => {
  it('clamps the uploaded (tiled) content to the cutoff', async () => {
    const handy = makeFakeHandy();
    await engageHandyFinisher({
      handyManager: handy,
      content: SCRIPT,
      cachedUrl: null,
      cutoff: { min: 20, max: 80 },
      isCurrent: () => true,
    });
    const uploaded = JSON.parse(handy.uploadScriptOnly.mock.calls[0][0]);
    const positions = uploaded.actions.map((a) => a.pos);
    expect(Math.min(...positions)).toBeGreaterThanOrEqual(20);
    expect(Math.max(...positions)).toBeLessThanOrEqual(80);
  });

  it('leaves positions untouched when no cutoff is set (tiling only)', async () => {
    const handy = makeFakeHandy();
    await engageHandyFinisher({
      handyManager: handy,
      content: SCRIPT,
      cachedUrl: null,
      cutoff: null,
      isCurrent: () => true,
    });
    const uploaded = JSON.parse(handy.uploadScriptOnly.mock.calls[0][0]);
    const positions = new Set(uploaded.actions.map((a) => a.pos));
    expect(positions).toEqual(new Set([10, 100]));
  });
});

describe('engageHandyFinisher — aborts', () => {
  it('touches nothing on the device when upload fails (no-url)', async () => {
    const handy = makeFakeHandy({
      uploadScriptOnly: vi.fn(async () => null),
    });
    const status = await engageHandyFinisher({
      handyManager: handy,
      content: SCRIPT,
      cachedUrl: null,
      isCurrent: () => true,
    });
    expect(status).toBe('no-url');
    expect(handy.setupScript).not.toHaveBeenCalled();
    expect(handy.hsspPlay).not.toHaveBeenCalled();
  });

  it('aborts before touching the device when released during upload', async () => {
    let current = true;
    const handy = makeFakeHandy({
      uploadScriptOnly: vi.fn(async () => { current = false; return 'https://cloud/x.csv'; }),
    });
    const status = await engageHandyFinisher({
      handyManager: handy,
      content: SCRIPT,
      cachedUrl: null,
      isCurrent: () => current,
    });
    expect(status).toBe('stale');
    expect(handy.setupScript).not.toHaveBeenCalled();
  });

  it('stops after a refused setScript (setup-failed) — never plays', async () => {
    const handy = makeFakeHandy();
    handy.setupScript = vi.fn(async (url) => {
      handy.calls.push(['setupScript', url]);
      return false;
    });
    const status = await engageHandyFinisher({
      handyManager: handy,
      content: null,
      cachedUrl: 'https://cloud/cached.csv',
      isCurrent: () => true,
    });
    expect(status).toBe('setup-failed');
    expect(handy.hsspPlay).not.toHaveBeenCalled();
  });

  it('released during setupScript → stale, never plays', async () => {
    let current = true;
    const handy = makeFakeHandy();
    handy.setupScript = vi.fn(async (url) => {
      handy.calls.push(['setupScript', url]);
      current = false; // released while setup was in flight
      return true;
    });
    const status = await engageHandyFinisher({
      handyManager: handy,
      content: null,
      cachedUrl: 'https://cloud/cached.csv',
      isCurrent: () => current,
    });
    expect(status).toBe('stale');
    expect(handy.hsspPlay).not.toHaveBeenCalled();
  });

  it('reports error (and does not throw) when a step throws', async () => {
    const handy = makeFakeHandy({
      setupScript: vi.fn(async () => { throw new Error('boom'); }),
    });
    const status = await engageHandyFinisher({
      handyManager: handy,
      content: null,
      cachedUrl: 'https://cloud/cached.csv',
      isCurrent: () => true,
    });
    expect(status).toBe('error');
  });
});

describe('holdFinisherEnd', () => {
  it('adds one point: the last position, holdMs later; keeps every other field', () => {
    const out = JSON.parse(holdFinisherEnd(JSON.stringify({ version: '1.0', inverted: false, range: 100, actions: [
      { at: 500, pos: 80 }, { at: 0, pos: 20 }, { at: 1200, pos: 2 },
    ] }), 3000));
    expect(out.version).toBe('1.0');
    expect(out.range).toBe(100);
    expect(out.actions, 'sorted, then held').toEqual([
      { at: 0, pos: 20 }, { at: 500, pos: 80 }, { at: 1200, pos: 2 }, { at: 4200, pos: 2 },
    ]);
  });

  it('returns its input unchanged when it cannot help (unparseable, no actions, no hold)', () => {
    expect(holdFinisherEnd('not json')).toBe('not json');
    expect(holdFinisherEnd('')).toBe('');
    const empty = JSON.stringify({ actions: [] });
    expect(holdFinisherEnd(empty)).toBe(empty);
    expect(holdFinisherEnd(SCRIPT, 0)).toBe(SCRIPT);
  });

  it('defaults to HOLD_END_MS', () => {
    const out = JSON.parse(holdFinisherEnd(SCRIPT)).actions;
    expect(out[out.length - 1].at).toBe(1000 + HOLD_END_MS);
  });
});

describe('releaseHandyFinisher', () => {
  it('stops the finisher (hsspStop only — loop mode is never set)', async () => {
    const handy = makeFakeHandy();
    await releaseHandyFinisher({ handyManager: handy });
    expect(handy.calls).toEqual([['hsspStop']]);
  });

  it('resolves (never rejects) when the device throws — restore must proceed', async () => {
    const handy = makeFakeHandy({
      hsspStop: vi.fn(async () => { throw new Error('offline'); }),
    });
    await expect(releaseHandyFinisher({ handyManager: handy })).resolves.toBeUndefined();
  });

  it('the caller can sequence the main-script restore strictly after the stop', async () => {
    const handy = makeFakeHandy();
    const order = [];
    handy.hsspStop = vi.fn(async () => { order.push('hsspStop'); });
    await releaseHandyFinisher({ handyManager: handy }).then(() => order.push('restore'));
    expect(order).toEqual(['hsspStop', 'restore']);
  });
});

describe('tileFinisherContent', () => {
  it('tiles to at least the target length with the loop period preserved', () => {
    const tiled = JSON.parse(tileFinisherContent(SCRIPT, 5000));
    // period = 1000ms → 5 reps. Rep k starts at k*1000 with pos matching
    // the original first action (boundary dup dropped, so the wrap point
    // carries the ORIGINAL start position via at=k*1000 from the previous
    // rep's last action — same pos by construction here).
    const last = tiled.actions[tiled.actions.length - 1];
    expect(last.at).toBeGreaterThanOrEqual(5000);
    // Strictly increasing timestamps — no boundary duplicates.
    for (let i = 1; i < tiled.actions.length; i++) {
      expect(tiled.actions[i].at).toBeGreaterThan(tiled.actions[i - 1].at);
    }
    // Second rep reproduces the pattern's shape offset by one period.
    const rep2 = tiled.actions.filter((a) => a.at > 1000 && a.at <= 2000);
    expect(rep2.map((a) => a.pos)).toEqual([100, 10]);
  });

  it('caps the emitted action count', () => {
    const tiled = JSON.parse(tileFinisherContent(SCRIPT, TILE_TARGET_MS, 10));
    expect(tiled.actions.length).toBeLessThanOrEqual(10);
  });

  it('preserves non-action funscript metadata', () => {
    const src = JSON.stringify({ version: '1.0', inverted: false, actions: [
      { at: 0, pos: 0 }, { at: 100, pos: 100 },
    ] });
    const tiled = JSON.parse(tileFinisherContent(src, 300));
    expect(tiled.version).toBe('1.0');
    expect(tiled.inverted).toBe(false);
  });

  it('returns the input unchanged when it cannot be tiled', () => {
    expect(tileFinisherContent('not json')).toBe('not json');
    expect(tileFinisherContent('')).toBe('');
    const oneAction = JSON.stringify({ actions: [{ at: 0, pos: 50 }] });
    expect(tileFinisherContent(oneAction)).toBe(oneAction);
    const zeroDuration = JSON.stringify({ actions: [{ at: 0, pos: 0 }, { at: 0, pos: 100 }] });
    expect(tileFinisherContent(zeroDuration)).toBe(zeroDuration);
  });

  it('a script already longer than the target passes through as one rep', () => {
    const long = JSON.stringify({ actions: [
      { at: 0, pos: 0 }, { at: TILE_TARGET_MS + 1000, pos: 100 },
    ] });
    const tiled = JSON.parse(tileFinisherContent(long));
    expect(tiled.actions.length).toBe(2);
    expect(tiled.actions[1].at).toBe(TILE_TARGET_MS + 1000);
  });
});
