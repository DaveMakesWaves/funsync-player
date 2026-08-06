/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Pins the variant merge + switcher-visibility rule that App._updateVariantSelector
// applies (renderer/js/app.js). Mirrored as pure functions because app.js
// carries DOM/Electron deps that make direct import hostile.
//
// Regression this pins (bug #2): the main-process scan used to drop a lone
// auto-detected variant (`variants.length > 1 ? variants : []`), so a video
// with 1 auto script + 1 manually-associated script showed only ONE combined
// entry and the switcher stayed hidden — even though two real scripts existed.
// Now the single auto variant flows through and combines with the manual one
// to cross the 2-entry threshold. See also the "always emit" change in
// electron/main.js.

import { describe, it, expect } from 'vitest';

// Mirror of app.js:6657-6660 — merge base (auto + loaded) with manual,
// deduping by path so a manual entry that points at an already-listed
// auto script isn't counted twice.
function mergeVariants(baseVariants, manual) {
  const seenPaths = new Set(baseVariants.map((v) => v.path));
  const deduped = manual.filter((v) => !seenPaths.has(v.path));
  return [...baseVariants, ...deduped];
}

// The switcher offers a real choice only when there are 2+ distinct
// variants (app.js:6733 bails from the dropdown when < 2).
const switcherHasChoices = (all) => all.length >= 2;

const V = (label, path) => ({ label, path, name: path.split('/').pop() });

describe('variant merge + switcher visibility', () => {
  it('bug #2: 1 auto + 1 distinct manual → 2 entries → switcher usable', () => {
    const base = [V('Default', '/lib/v.funscript')];
    const manual = [V('Hard', '/lib/alt/v.hard.funscript')];
    const all = mergeVariants(base, manual);
    expect(all).toHaveLength(2);
    expect(switcherHasChoices(all)).toBe(true);
  });

  it('a lone auto variant with no manual stays a single entry (switcher hidden)', () => {
    const all = mergeVariants([V('Default', '/lib/v.funscript')], []);
    expect(all).toHaveLength(1);
    expect(switcherHasChoices(all)).toBe(false);
  });

  it('dedupes a manual entry that points at an already-listed auto script', () => {
    const base = [V('Default', '/lib/v.funscript')];
    const manual = [V('Default', '/lib/v.funscript')]; // same path
    const all = mergeVariants(base, manual);
    expect(all).toHaveLength(1);
    expect(switcherHasChoices(all)).toBe(false);
  });

  it('two auto variants already cross the threshold without any manual', () => {
    const base = [V('Default', '/lib/v.funscript'), V('soft', '/lib/v.soft.funscript')];
    const all = mergeVariants(base, []);
    expect(all).toHaveLength(2);
    expect(switcherHasChoices(all)).toBe(true);
  });

  it('keeps distinct manual variants alongside multiple auto ones', () => {
    const base = [V('Default', '/lib/v.funscript'), V('soft', '/lib/v.soft.funscript')];
    const manual = [V('Custom', '/other/v.custom.funscript')];
    const all = mergeVariants(base, manual);
    expect(all).toHaveLength(3);
  });
});
