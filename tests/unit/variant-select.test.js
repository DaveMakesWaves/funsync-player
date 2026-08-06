// Random-script-variation-on-play decision logic (zaikechi #209/#221).
//
// pickVariantIndexOnLoad resolves which variant a freshly loaded video
// starts on: random toggle beats pinned default while on; pins apply
// when it's off; anything else keeps the already-loaded auto-default
// (index 0). Pure + injectable RNG so the whole matrix is testable.

import { describe, it, expect } from 'vitest';
import { pickVariantIndexOnLoad } from '../../renderer/js/variant-select.js';

const VARIANTS = [
  { label: 'Default' },
  { label: 'Soft' },
  { label: 'Intense' },
];

describe('pickVariantIndexOnLoad', () => {
  it('keeps the loaded default with fewer than 2 variants', () => {
    expect(pickVariantIndexOnLoad([], { randomOn: true })).toBe(0);
    expect(pickVariantIndexOnLoad([{ label: 'Only' }], { randomOn: true })).toBe(0);
    expect(pickVariantIndexOnLoad(null, { randomOn: true })).toBe(0);
  });

  it('random ON picks uniformly across ALL variants via the injected rng', () => {
    expect(pickVariantIndexOnLoad(VARIANTS, { randomOn: true, rng: () => 0 })).toBe(0);
    expect(pickVariantIndexOnLoad(VARIANTS, { randomOn: true, rng: () => 0.34 })).toBe(1);
    expect(pickVariantIndexOnLoad(VARIANTS, { randomOn: true, rng: () => 0.99 })).toBe(2);
  });

  it('random ON beats a pinned default (the toggle exists to inject variety)', () => {
    const idx = pickVariantIndexOnLoad(VARIANTS, {
      randomOn: true,
      preferredLabel: 'Intense',
      rng: () => 0.34, // would pick 'Soft'
    });
    expect(idx).toBe(1);
  });

  it('random OFF honors the pinned default', () => {
    expect(pickVariantIndexOnLoad(VARIANTS, { randomOn: false, preferredLabel: 'Intense' })).toBe(2);
  });

  it('pin matching trims whitespace (mirrors _applyPreferredVariant)', () => {
    expect(pickVariantIndexOnLoad(VARIANTS, { preferredLabel: '  Soft  ' })).toBe(1);
  });

  it('missing or already-default pin keeps the loaded default', () => {
    expect(pickVariantIndexOnLoad(VARIANTS, { preferredLabel: 'Deleted Variant' })).toBe(0);
    expect(pickVariantIndexOnLoad(VARIANTS, { preferredLabel: 'Default' })).toBe(0);
    expect(pickVariantIndexOnLoad(VARIANTS, {})).toBe(0);
  });

  it('clamps a hostile rng into range', () => {
    expect(pickVariantIndexOnLoad(VARIANTS, { randomOn: true, rng: () => 1.5 })).toBe(2);
    expect(pickVariantIndexOnLoad(VARIANTS, { randomOn: true, rng: () => -1 })).toBe(0);
  });
});
