/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Generated secondary-axis motion (dio_likes_jojo, EroScripts #306).
//
// MultiFunPlayer and XTPlayer both drive twist/roll/pitch when the scripter
// only wrote a stroke track. This covers FunSync's version end to end at the
// engine seam: what reaches tcode.sendAxes and with what interval.
//
// The invariants worth defending, in rough order of how much damage breaking
// them would do:
//   1. OFF unless the user opts in, per axis.
//   2. A real script for the axis always wins over generated motion.
//   3. Generated values pass through the same invert/range/cutoff stack as
//      scripted ones — Safety Cap and Ceiling must apply to motion the app
//      invented, or this feature becomes a way to bypass the safety limits.
//   4. One send per MAIN keyframe, not per tick (serial economy: 60Hz × 3
//      generated axes would drown the scripted ones at 115200 baud).
//   5. No clock (gap / end of script / no script) means hold, not wander.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TCodeSync } from '../../renderer/js/tcode-sync.js';

function makeMockPlayer() {
  const state = { ct: 0, paused: false };
  return {
    get currentTime() { return state.ct; },
    set currentTime(v) { state.ct = v; },
    get paused() { return state.paused; },
    set paused(v) { state.paused = v; },
    duration: 600,
    video: {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      get currentTime() { return state.ct; },
      get paused() { return state.paused; },
      duration: 600,
    },
  };
}

// A plain 1Hz stroke script: 0 → 100 → 0 …, one keyframe every 500ms.
function strokeScript(count = 40) {
  return Array.from({ length: count }, (_, i) => ({ at: i * 500, pos: i % 2 === 0 ? 0 : 100 }));
}

function makeSync({ actions = strokeScript() } = {}) {
  const tcode = { connected: true, sendAxes: vi.fn(), stop: vi.fn() };
  const player = makeMockPlayer();
  const sync = new TCodeSync({
    videoPlayer: player,
    funscriptEngine: { isLoaded: actions.length > 0, getActions: () => actions },
    tcodeManager: tcode,
  });
  sync._cacheActions();
  sync._resetIndices();
  return { sync, tcode, player, actions };
}

/** Advance media time and run one tick; returns the axis map that was sent. */
function tickAt(sync, tcode, player, seconds) {
  player.currentTime = seconds;
  tcode.sendAxes.mockClear();
  sync._tick();
  return tcode.sendAxes.mock.calls[0]?.[0] || null;
}

/** Every generated value R0 received across a sweep of the script. */
function sweep(sync, tcode, player, { from = 0.1, to = 6, step = 0.1, axis = 'R0' } = {}) {
  const seen = [];
  for (let s = from; s <= to; s += step) {
    const sent = tickAt(sync, tcode, player, Number(s.toFixed(3)));
    if (sent && sent[axis] !== undefined) seen.push(sent[axis]);
  }
  return seen;
}

describe('generated axes — opt-in', () => {
  it('sends nothing extra when no axis is configured', () => {
    const { sync, tcode, player } = makeSync();
    const seen = sweep(sync, tcode, player);
    expect(seen).toEqual([]);
  });

  it('refuses to generate the main axis — it is the clock everything follows', () => {
    const { sync } = makeSync();
    sync.setAxisMotion('L0', { mode: 'random' });
    expect(sync.getAxisMotion('L0')).toBeNull();
  });

  it('setAxisMotion(null) clears a configured axis back to scripted', () => {
    const { sync, tcode, player } = makeSync();
    sync.setAxisMotion('R0', { mode: 'link' });
    expect(sync.getAxisMotion('R0')).toBeTruthy();
    sync.setAxisMotion('R0', null);
    expect(sync.getAxisMotion('R0')).toBeNull();
    expect(sweep(sync, tcode, player)).toEqual([]);
  });

  it('a disabled axis generates nothing', () => {
    const { sync, tcode, player } = makeSync();
    sync.setAxisMotion('R0', { mode: 'link' });
    sync.setAxisEnabled('R0', false);
    expect(sweep(sync, tcode, player)).toEqual([]);
  });
});

describe('generated axes — link mode', () => {
  let ctx;
  beforeEach(() => {
    ctx = makeSync();
    ctx.sync.setAxisMotion('R0', { mode: 'link' });
  });

  it('traces the main script — R0 lands on L0 keyframe positions', () => {
    const { sync, tcode, player } = ctx;
    const seen = sweep(sync, tcode, player);
    expect(seen.length).toBeGreaterThan(4);
    for (const v of seen) expect([0, 100]).toContain(v);
    expect(new Set(seen).size).toBe(2);   // it actually alternates, not stuck
  });

  it('travels over the main keyframe interval, so it moves with the stroke', () => {
    const { sync, tcode, player } = ctx;
    player.currentTime = 0.1;
    sync._tick();
    const [values, , intervals] = tcode.sendAxes.mock.calls[0];
    expect(values.R0).toBeDefined();
    // 400ms to the next keyframe at 500ms. (L0's own first send snaps over a
    // single tick instead, so only the generated axis is asserted here.)
    expect(intervals.R0).toBe(400);
  });

  it('depth scales around centre — 50% never reaches the ends', () => {
    const { sync, tcode, player } = ctx;
    sync.setAxisMotion('R0', { mode: 'link', depth: 50 });
    const seen = sweep(sync, tcode, player);
    expect(seen.length).toBeGreaterThan(4);
    for (const v of seen) {
      expect(v).toBeGreaterThanOrEqual(25);
      expect(v).toBeLessThanOrEqual(75);
    }
  });

  it('half restricts travel to one side of centre', () => {
    const { sync, tcode, player } = ctx;
    sync.setAxisMotion('R0', { mode: 'link', half: 'top' });
    for (const v of sweep(sync, tcode, player)) {
      expect(v).toBeGreaterThanOrEqual(50);
    }
  });
});

describe('generated axes — random mode', () => {
  it('wanders instead of holding still', () => {
    const { sync, tcode, player } = makeSync();
    sync.setAxisMotion('R0', { mode: 'random' });
    const seen = sweep(sync, tcode, player, { to: 12 });
    expect(seen.length).toBeGreaterThan(8);
    expect(new Set(seen).size).toBeGreaterThan(4);
    expect(Math.max(...seen) - Math.min(...seen)).toBeGreaterThan(10);
  });

  it('stays inside the axis travel', () => {
    const { sync, tcode, player } = makeSync();
    sync.setAxisMotion('R0', { mode: 'random' });
    for (const v of sweep(sync, tcode, player, { to: 15 })) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it('gives each axis its own path — R0/R1/R2 must not move as one', () => {
    const { sync, tcode, player } = makeSync();
    for (const axis of ['R0', 'R1', 'R2']) sync.setAxisMotion(axis, { mode: 'random' });
    const r0 = [], r1 = [], r2 = [];
    for (let s = 0.1; s <= 10; s += 0.1) {
      const sent = tickAt(sync, tcode, player, Number(s.toFixed(3)));
      if (!sent) continue;
      if (sent.R0 !== undefined) r0.push(sent.R0);
      if (sent.R1 !== undefined) r1.push(sent.R1);
      if (sent.R2 !== undefined) r2.push(sent.R2);
    }
    expect(r0.length).toBeGreaterThan(4);
    expect(r0).not.toEqual(r1);
    expect(r1).not.toEqual(r2);
  });
});

describe('generated axes — a real script always wins', () => {
  it('a scripted axis is never overwritten by its motion config', () => {
    const { sync, tcode, player } = makeSync();
    // R0 has its own (constant-ish) track: 20 → 30 → 20 …
    sync.setAxisActions('R0', Array.from({ length: 20 },
      (_, i) => ({ at: i * 500, pos: i % 2 === 0 ? 20 : 30 })));
    sync.setAxisMotion('R0', { mode: 'link' });   // would emit 0/100 if it won
    sync._resetIndices();
    const seen = sweep(sync, tcode, player);
    expect(seen.length).toBeGreaterThan(4);
    for (const v of seen) {
      expect(v).toBeGreaterThanOrEqual(20);
      expect(v).toBeLessThanOrEqual(30);
    }
  });

  it('generation resumes if the script for that axis is cleared', () => {
    const { sync, tcode, player } = makeSync();
    sync.setAxisActions('R0', Array.from({ length: 20 },
      (_, i) => ({ at: i * 500, pos: i % 2 === 0 ? 20 : 30 })));
    sync.setAxisMotion('R0', { mode: 'link' });
    sync._resetIndices();
    sync.clearAxisActions();
    sync._resetIndices();
    const seen = sweep(sync, tcode, player);
    for (const v of seen) expect([0, 100]).toContain(v);
  });
});

describe('generated axes — safety limits apply', () => {
  it('respects the per-axis range (values are remapped, not raw)', () => {
    const { sync, tcode, player } = makeSync();
    sync.setAxisMotion('R0', { mode: 'link' });
    sync.setAxisRange('R0', 40, 60);
    for (const v of sweep(sync, tcode, player)) {
      expect(v).toBeGreaterThanOrEqual(40);
      expect(v).toBeLessThanOrEqual(60);
    }
  });

  it('respects the cutoff floor/ceiling (Safety Cap parity)', () => {
    const { sync, tcode, player } = makeSync();
    sync.setAxisMotion('R0', { mode: 'random' });
    sync.setAxisCutoff('R0', 30, 70);
    for (const v of sweep(sync, tcode, player, { to: 15 })) {
      expect(v).toBeGreaterThanOrEqual(30);
      expect(v).toBeLessThanOrEqual(70);
    }
  });

  it('respects per-axis invert', () => {
    const a = makeSync();
    a.sync.setAxisMotion('R0', { mode: 'link' });
    const plain = sweep(a.sync, a.tcode, a.player);

    const b = makeSync();
    b.sync.setAxisMotion('R0', { mode: 'link' });
    b.sync.setAxisInverted('R0', true);
    const inverted = sweep(b.sync, b.tcode, b.player);

    expect(inverted.length).toBe(plain.length);
    expect(inverted).toEqual(plain.map((v) => 100 - v));
  });
});

describe('generated axes — send cadence', () => {
  it('emits once per MAIN keyframe, not once per tick', () => {
    const { sync, tcode, player } = makeSync();
    sync.setAxisMotion('R0', { mode: 'random' });

    // Four ticks inside the SAME keyframe interval (0-500ms).
    const sends = [0.10, 0.15, 0.20, 0.25]
      .map((s) => tickAt(sync, tcode, player, s))
      .filter((sent) => sent && sent.R0 !== undefined);
    expect(sends.length).toBe(1);

    // Crossing into the next keyframe interval emits again.
    const next = tickAt(sync, tcode, player, 0.6);
    expect(next?.R0).toBeDefined();
  });
});

describe('generated axes — no clock means hold', () => {
  it('says nothing across a gap longer than the engine drives', () => {
    // 6s gap: beyond MAX_GAP_MS (5s), so neither L0 nor a generated axis
    // should be crawling toward the far keyframe.
    const actions = [
      { at: 0, pos: 0 }, { at: 500, pos: 100 },
      { at: 7000, pos: 0 }, { at: 7500, pos: 100 },
    ];
    const { sync, tcode, player } = makeSync({ actions });
    sync.setAxisMotion('R0', { mode: 'random' });
    // Only while the next keyframe is further out than MAX_GAP_MS (5s) — from
    // ~2s on, 7000 is back in range and the engine legitimately drives again.
    const inGap = sweep(sync, tcode, player, { from: 1.0, to: 1.9, step: 0.1 });
    expect(inGap).toEqual([]);
  });

  it('generates nothing at all with no script loaded', () => {
    const { sync, tcode, player } = makeSync({ actions: [] });
    sync.setAxisMotion('R0', { mode: 'random' });
    expect(sweep(sync, tcode, player)).toEqual([]);
  });

  it('re-anchors after a backward seek', () => {
    const { sync, tcode, player } = makeSync();
    sync.setAxisMotion('R0', { mode: 'link' });
    sweep(sync, tcode, player, { from: 0.1, to: 4 });
    player.currentTime = 0.1;
    sync._resetIndices();
    const sent = tickAt(sync, tcode, player, 0.1);
    expect(sent?.R0).toBeDefined();
    expect([0, 100]).toContain(sent.R0);
  });
});

describe('generated axes — pattern mode', () => {
  it('traverses the axis instead of holding a value', () => {
    const { sync, tcode, player } = makeSync();
    sync.setAxisMotion('R0', { mode: 'pattern', pattern: 'sine' });
    const seen = sweep(sync, tcode, player, { to: 15 });
    expect(seen.length).toBeGreaterThan(8);
    expect(Math.max(...seen) - Math.min(...seen)).toBeGreaterThan(40);
  });

  it('different shapes produce different motion', () => {
    const run = (pattern) => {
      const { sync, tcode, player } = makeSync();
      sync.setAxisMotion('R0', { mode: 'pattern', pattern });
      return sweep(sync, tcode, player, { to: 12 });
    };
    expect(run('sine')).not.toEqual(run('saw'));
  });

  it('square only ever sends the two ends', () => {
    // A shape whose output is exactly two values is the clearest check that
    // the waveform reaches the wire unsmoothed.
    const { sync, tcode, player } = makeSync();
    sync.setAxisMotion('R0', { mode: 'pattern', pattern: 'square' });
    const seen = sweep(sync, tcode, player, { to: 15 });
    expect(seen.length).toBeGreaterThan(2);
    expect([...new Set(seen)].sort((a, b) => a - b)).toEqual([0, 100]);
  });

  it('obeys depth, range and cutoff like every other source', () => {
    const { sync, tcode, player } = makeSync();
    sync.setAxisMotion('R0', { mode: 'pattern', pattern: 'square', depth: 50 });
    sync.setAxisCutoff('R0', 30, 70);
    for (const v of sweep(sync, tcode, player, { to: 12 })) {
      expect(v).toBeGreaterThanOrEqual(30);
      expect(v).toBeLessThanOrEqual(70);
    }
  });

  it('speed changes how fast the shape cycles', () => {
    const run = (speed) => {
      const { sync, tcode, player } = makeSync();
      sync.setAxisMotion('R0', { mode: 'pattern', pattern: 'sine', speed });
      return sweep(sync, tcode, player, { to: 12 });
    };
    const slow = run(0.25);
    const fast = run(3);
    const travel = (vals) => vals.slice(1)
      .reduce((sum, v, i) => sum + Math.abs(v - vals[i]), 0);
    expect(travel(fast)).toBeGreaterThan(travel(slow));
  });

  it('still holds when there is no clock', () => {
    const { sync, tcode, player } = makeSync({ actions: [] });
    sync.setAxisMotion('R0', { mode: 'pattern', pattern: 'sine' });
    expect(sweep(sync, tcode, player)).toEqual([]);
  });
});
