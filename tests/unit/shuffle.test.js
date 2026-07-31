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
