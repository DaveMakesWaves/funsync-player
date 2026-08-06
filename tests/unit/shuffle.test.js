/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Tests for the shuffle helpers (playlist/queue random playback).
// See SCOPE-playlist-shuffle-reorder.md §7 for the algorithm-bias rationale.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { shuffle, reshuffleAvoidingRepeat } from '../../renderer/js/shuffle.js';

afterEach(() => vi.restoreAllMocks());

describe('shuffle', () => {
  it('returns a NEW array and does not mutate the input', () => {
    const input = [1, 2, 3, 4, 5];
    const copy = input.slice();
    const out = shuffle(input);
    expect(out).not.toBe(input);
    expect(input).toEqual(copy); // input untouched
  });

  it('is a permutation — same multiset of items, same length', () => {
    const input = ['a', 'b', 'c', 'd', 'e', 'f'];
    const out = shuffle(input);
    expect(out).toHaveLength(input.length);
    expect([...out].sort()).toEqual([...input].sort());
  });

  it('handles empty / single-element / non-array', () => {
    expect(shuffle([])).toEqual([]);
    expect(shuffle([42])).toEqual([42]);
    expect(shuffle(null)).toEqual([]);
    expect(shuffle(undefined)).toEqual([]);
    expect(shuffle('abc')).toEqual([]);
  });

  it('uses the shrinking range [0, i] inclusive (not Sattolo / not full-range bias)', () => {
    let call = 0;
    // r≈1 → floor(r*(i+1)) === i each step → j can equal i (swap with self).
    // Sattolo (j in [0, i-1]) could never produce j === i.
    vi.spyOn(Math, 'random').mockImplementation(() => { call++; return 0.999999; });
    const out = shuffle([1, 2, 3, 4]);
    // 4 elements → exactly 3 draws (i = 3,2,1); each swaps with itself → unchanged.
    expect(call).toBe(3);
    expect(out).toEqual([1, 2, 3, 4]);
  });

  it('over many runs every position is reachable by every element (smoke)', () => {
    // Not a distribution test — just guards against a frozen/degenerate shuffle.
    const input = [0, 1, 2, 3];
    const firstSeen = new Set();
    for (let n = 0; n < 200; n++) firstSeen.add(shuffle(input)[0]);
    expect(firstSeen.size).toBeGreaterThan(1); // not always the same head
  });
});

describe('reshuffleAvoidingRepeat', () => {
  it('returns a permutation', () => {
    const input = ['a', 'b', 'c', 'd'];
    const out = reshuffleAvoidingRepeat(input, 'a');
    expect([...out].sort()).toEqual([...input].sort());
  });

  it('never starts with the avoided item (no immediate repeat across the loop boundary)', () => {
    const input = ['a', 'b', 'c', 'd'];
    for (let n = 0; n < 200; n++) {
      expect(reshuffleAvoidingRepeat(input, 'a')[0]).not.toBe('a');
    }
  });

  it('no-op guard on < 2 items (cannot avoid a repeat)', () => {
    expect(reshuffleAvoidingRepeat(['x'], 'x')).toEqual(['x']);
    expect(reshuffleAvoidingRepeat([], 'x')).toEqual([]);
  });
});

// --- Balance by script (zaikechi #221) ---

import { balancedShuffle, reshuffleBalancedAvoidingRepeat } from '../../renderer/js/shuffle.js';

const V = (path, script) => ({ path, funscriptPath: script });
const keyOf = (v) => v.funscriptPath || null;

describe('balancedShuffle', () => {
  it('collapses same-key items into ONE slot (the weighting fix)', () => {
    // 6 videos on one script + 1 on another → exactly 2 slots.
    const items = [
      V('a1', 's1'), V('a2', 's1'), V('a3', 's1'),
      V('a4', 's1'), V('a5', 's1'), V('a6', 's1'),
      V('b1', 's2'),
    ];
    for (let n = 0; n < 50; n++) {
      const out = balancedShuffle(items, keyOf);
      expect(out.length).toBe(2);
      const keys = out.map(keyOf).sort();
      expect(keys).toEqual(['s1', 's2']);
      // The s1 representative is a member of the group, chosen per draw.
      expect(['a1', 'a2', 'a3', 'a4', 'a5', 'a6']).toContain(out.find(v => keyOf(v) === 's1').path);
    }
  });

  it('keyless items participate individually (scriptless videos unchanged)', () => {
    const items = [V('a', 's1'), V('b', 's1'), V('c', null), V('d', null)];
    const out = balancedShuffle(items, keyOf);
    expect(out.length).toBe(3); // s1-group + c + d
    const paths = out.map(v => v.path);
    expect(paths).toContain('c');
    expect(paths).toContain('d');
  });

  it('representatives vary across draws (randomly chosen per group)', () => {
    const items = [V('a1', 's1'), V('a2', 's1'), V('a3', 's1')];
    const seen = new Set();
    for (let n = 0; n < 200 && seen.size < 3; n++) {
      seen.add(balancedShuffle(items, keyOf)[0].path);
    }
    expect(seen.size).toBe(3);
  });

  it('no groups → behaves like a plain shuffle (same members, same length)', () => {
    const items = [V('a', 's1'), V('b', 's2'), V('c', 's3')];
    const out = balancedShuffle(items, keyOf);
    expect(out.map(v => v.path).sort()).toEqual(['a', 'b', 'c']);
  });

  it('non-array input → empty array', () => {
    expect(balancedShuffle(null, keyOf)).toEqual([]);
  });
});

describe('reshuffleBalancedAvoidingRepeat', () => {
  it('never starts the new cycle on the just-played GROUP (key compare, not identity)', () => {
    const items = [
      V('a1', 's1'), V('a2', 's1'), V('a3', 's1'),
      V('b1', 's2'), V('c1', 's3'),
    ];
    const justPlayed = V('a2', 's1'); // any member of s1
    for (let n = 0; n < 200; n++) {
      const out = reshuffleBalancedAvoidingRepeat(items, keyOf, justPlayed);
      expect(keyOf(out[0])).not.toBe('s1');
    }
  });

  it('redraws from the FULL list, so a different group member can appear next cycle', () => {
    const items = [V('a1', 's1'), V('a2', 's1'), V('b1', 's2')];
    const seen = new Set();
    for (let n = 0; n < 200 && seen.size < 2; n++) {
      const out = reshuffleBalancedAvoidingRepeat(items, keyOf, V('b1', 's2'));
      seen.add(out.find(v => keyOf(v) === 's1').path);
    }
    expect(seen.size).toBe(2);
  });

  it('single-group edge: cannot avoid, still returns a valid draw', () => {
    const items = [V('a1', 's1'), V('a2', 's1')];
    const out = reshuffleBalancedAvoidingRepeat(items, keyOf, V('a1', 's1'));
    expect(out.length).toBe(1);
    expect(keyOf(out[0])).toBe('s1');
  });
});
