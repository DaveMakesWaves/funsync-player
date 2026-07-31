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
