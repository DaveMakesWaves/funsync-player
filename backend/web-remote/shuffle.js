// Shuffle helpers — PORT of renderer/js/shuffle.js (desktop) for the phone
// queue (SCOPE-web-remote-2.md F1). Per the search-parity rule, this port
// carries the ALGORITHMS and the call-site semantics: Fisher–Yates bag
// shuffle (uniform, shrinking-range partner) and the balanced variant
// (same-key items collapse to one slot with a random representative —
// zaikechi's weighting fix). Keep in sync with the desktop module when it
// changes.

/** Uniform Fisher–Yates. New array; non-array input → []. */
export function shuffle(arr) {
  if (!Array.isArray(arr)) return [];
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/**
 * Balanced shuffle: items sharing keyFor(item) occupy ONE slot, filled by
 * a random group member. Keyless items participate individually.
 */
export function balancedShuffle(items, keyFor) {
  if (!Array.isArray(items)) return [];
  const groups = new Map();
  let solo = 0;
  for (const item of items) {
    const raw = keyFor ? keyFor(item) : null;
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
