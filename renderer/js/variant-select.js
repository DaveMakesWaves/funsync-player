// Variant selection at video load (zaikechi, EroScripts #209/#221).
//
// One pure decision: which script variant should a freshly loaded video
// start on? Index 0 is the auto-default that has already loaded; a
// return value > 0 means "switch to that variant".
//
// Precedence: the random toggle BEATS a pinned default while it's on —
// the toggle exists to inject variety, and honoring pins would silently
// exempt exactly the videos the user curated most. Turning the toggle
// off restores pinned behavior untouched.

/**
 * @param {Array<{label?: string}>} variants — resolved variant list,
 *   index 0 = the auto-default already loaded
 * @param {object} opts
 * @param {boolean} [opts.randomOn] — `player.randomVariantOnPlay`
 * @param {string|null} [opts.preferredLabel] — pinned default label, if any
 * @param {() => number} [opts.rng] — injectable RNG for tests
 * @returns {number} index to play (0 = keep the loaded default)
 */
export function pickVariantIndexOnLoad(variants, { randomOn = false, preferredLabel = null, rng = Math.random } = {}) {
  const n = Array.isArray(variants) ? variants.length : 0;
  if (n < 2) return 0;
  if (randomOn) {
    const idx = Math.floor(rng() * n);
    return Math.min(Math.max(idx, 0), n - 1); // clamp a hostile rng
  }
  if (preferredLabel) {
    const idx = variants.findIndex(v => (v?.label || '').trim() === preferredLabel.trim());
    return idx > 0 ? idx : 0; // not found / already default → keep default
  }
  return 0;
}
