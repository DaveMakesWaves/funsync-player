// Shuffle helpers for playlist / queue playback.
//
// Uses the textbook Fisher–Yates (Knuth) shuffle — provably uniform when
// the swap partner is drawn from the *shrinking* range [0, i]. Two classic
// bugs are deliberately avoided (researched 2026-06-09, see
// SCOPE-playlist-shuffle-reorder.md §7):
//   - `arr.sort(() => Math.random() - 0.5)` — non-uniform + engine-dependent.
//   - off-by-one in the range bound → degrades into Sattolo's algorithm
//     (only single-cycle permutations, a biased subset).
//
// We also expose a reshuffle that avoids an immediate repeat across a loop
// boundary — true-random "feels broken" precisely because it allows the
// same item to play twice in a row (the reason Spotify abandoned pure random).

/**
 * Return a NEW array containing the items of `arr` in uniformly-random order.
 * Does not mutate the input. Non-array input → `[]`.
 *
 * @template T
 * @param {T[]} arr
 * @returns {T[]}
 */
export function shuffle(arr) {
  if (!Array.isArray(arr)) return [];
  const out = arr.slice();
  // Backward Fisher–Yates: i from last index down to 1; j in [0, i] INCLUSIVE.
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/**
 * Reshuffle for the next loop cycle, avoiding an immediate repeat: if the
 * freshly-shuffled order would start with `avoidFirst` (the item that just
 * played at the end of the previous cycle), swap it with another element so
 * the cycle boundary doesn't play the same item back-to-back.
 *
 * No-op guard when the list has < 2 items (can't avoid a repeat).
 *
 * @template T
 * @param {T[]} arr
 * @param {T} [avoidFirst] — item that should not land at index 0
 * @returns {T[]} new shuffled array
 */
export function reshuffleAvoidingRepeat(arr, avoidFirst) {
  const out = shuffle(arr);
  if (out.length > 1 && avoidFirst !== undefined && out[0] === avoidFirst) {
    // Swap the head with a random other index [1, len-1].
    const j = 1 + Math.floor(Math.random() * (out.length - 1));
    const tmp = out[0];
    out[0] = out[j];
    out[j] = tmp;
  }
  return out;
}

/**
 * Balanced shuffle (zaikechi #221 — "Balance shuffle by script"): items
 * sharing a key occupy ONE slot in the shuffled order, and a random
 * member of the group is chosen to fill it. Use case: six videos matched
 * to one music script would otherwise weight that track 6× in a shuffled
 * playlist; grouped by script, the track plays as often as any other and
 * the visuals vary between cycles.
 *
 * `keyFor(item)` returns the grouping key; null/undefined/'' means "this
 * item participates individually" (scriptless videos behave exactly like
 * an unbalanced shuffle). Group order is Fisher–Yates uniform; the
 * representative is drawn uniformly within each group.
 *
 * Returns a NEW array of one representative per group. Note the result
 * is SHORTER than the input when groups exist — that's the point.
 *
 * @template T
 * @param {T[]} items
 * @param {(item: T) => string|null|undefined} keyFor
 * @returns {T[]}
 */
export function balancedShuffle(items, keyFor) {
  if (!Array.isArray(items)) return [];
  const groups = new Map();
  let solo = 0;
  for (const item of items) {
    const raw = keyFor ? keyFor(item) : null;
    // Keyless items each get a unique group → behave individually.
    const key = (raw === null || raw === undefined || raw === '') ? `__solo__${solo++}` : `k:${raw}`;
    const members = groups.get(key);
    if (members) members.push(item);
    else groups.set(key, [item]);
  }
  const reps = [];
  for (const members of groups.values()) {
    reps.push(members[Math.floor(Math.random() * members.length)]);
  }
  return shuffle(reps);
}

/**
 * Loop-wrap redraw for a balanced queue: fresh group order AND fresh
 * random representatives (so the next cycle can show different videos for
 * the same scripts), avoiding starting on the same GROUP that just played
 * — comparing by key, not identity, because the new cycle may have drawn
 * a different member of that group.
 *
 * @template T
 * @param {T[]} items — the FULL original list (not the previous draw)
 * @param {(item: T) => string|null|undefined} keyFor
 * @param {T} [justPlayed] — last item of the finished cycle
 * @returns {T[]}
 */
export function reshuffleBalancedAvoidingRepeat(items, keyFor, justPlayed) {
  const out = balancedShuffle(items, keyFor);
  if (out.length > 1 && justPlayed !== undefined && keyFor) {
    const avoidKey = keyFor(justPlayed);
    const headKey = keyFor(out[0]);
    const sameGroup = avoidKey !== null && avoidKey !== undefined && avoidKey !== ''
      ? headKey === avoidKey
      : out[0] === justPlayed; // keyless: fall back to identity
    if (sameGroup) {
      const j = 1 + Math.floor(Math.random() * (out.length - 1));
      const tmp = out[0];
      out[0] = out[j];
      out[j] = tmp;
    }
  }
  return out;
}
