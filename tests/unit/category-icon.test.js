// Category icons: prefab shapes and emoji (myopiic, thread #270).
//
// Needs a DOM: createCategoryMark builds real elements, and the SVG
// namespace behaviour it defends against only exists in a browser DOM.
import { describe, it, expect } from 'vitest';
import {
  createCategoryMark,
  normaliseIcon,
  graphemeCount,
  firstGrapheme,
  CATEGORY_SHAPES,
  SHAPE_KEYS,
} from '../../renderer/js/category-icon.js';

describe('backwards compatibility', () => {
  // Every category that exists today has no `icon` field. They must look
  // exactly as they always have, with no migration step.
  it('a category with no icon renders the plain colour dot', () => {
    const el = createCategoryMark({ color: '#ff0000' });
    expect(el.tagName.toLowerCase()).toBe('span');
    expect(el.style.background).toBeTruthy();
    expect(el.textContent).toBe('');
  });

  it('keeps the caller-supplied class so existing CSS still applies', () => {
    const el = createCategoryMark({ color: '#f00' }, { className: 'library__card-category-dot' });
    expect(el.getAttribute('class')).toBe('library__card-category-dot');
  });

  it('never returns null, whatever it is handed', () => {
    for (const input of [null, undefined, {}, { icon: 'nonsense' }, { icon: {} }]) {
      expect(createCategoryMark(input)).toBeTruthy();
    }
  });
});

// Dave: "i think either the library cards are showing just the circle by
// default or they dont change when edited."
//
// Cause: every surface styles its dot with a fixed width/height, a border
// and border-radius:50%. Applied to a shape or an emoji that squashes it
// into a bordered circle and the icon is never visible. The mark now carries
// a BEM modifier so the stylesheet can tell the two apart.
describe('an icon mark is distinguishable from a plain dot', () => {
  it('adds a --icon modifier for shapes', () => {
    const el = createCategoryMark(
      { color: '#f00', icon: { type: 'shape', value: 'star' } },
      { className: 'library__card-category-dot' },
    );
    const cls = el.getAttribute('class');
    expect(cls).toContain('library__card-category-dot');
    expect(cls).toContain('library__card-category-dot--icon');
  });

  it('adds a --icon modifier for emoji', () => {
    const el = createCategoryMark(
      { color: '#f00', icon: { type: 'emoji', value: '🔥' } },
      { className: 'library__card-category-dot' },
    );
    expect(el.getAttribute('class')).toContain('library__card-category-dot--icon');
  });

  // The plain dot must NOT gain the modifier, or the stylesheet would strip
  // the very styling that makes it a dot.
  it('does NOT add the modifier to a plain colour dot', () => {
    const el = createCategoryMark(
      { color: '#f00' },
      { className: 'library__card-category-dot' },
    );
    expect(el.getAttribute('class')).toBe('library__card-category-dot');
  });

  it('works without a className', () => {
    expect(() => createCategoryMark({ color: '#f00', icon: { type: 'shape', value: 'star' } })).not.toThrow();
  });

  it('scales with the size option, so it can match a resized dot', () => {
    const small = createCategoryMark({ color: '#f00', icon: { type: 'shape', value: 'star' } }, { size: 8 });
    const big = createCategoryMark({ color: '#f00', icon: { type: 'shape', value: 'star' } }, { size: 12 });
    expect(Number(big.getAttribute('width'))).toBeGreaterThan(Number(small.getAttribute('width')));
  });
});

describe('prefab shapes', () => {
  it('renders every shape in the real SVG namespace', () => {
    // THE TRAP: SVG built via innerHTML lands in the HTML namespace, where
    // it renders invisible but stays clickable. createElementNS is the fix
    // and this is the assertion that proves it was used.
    for (const key of SHAPE_KEYS) {
      const el = createCategoryMark({ color: '#0f0', icon: { type: 'shape', value: key } });
      expect(el.namespaceURI, key).toBe('http://www.w3.org/2000/svg');
      expect(el.tagName.toLowerCase()).toBe('svg');
      const path = el.querySelector('path');
      expect(path, key).toBeTruthy();
      expect(path.namespaceURI).toBe('http://www.w3.org/2000/svg');
      expect(path.getAttribute('d')).toBe(CATEGORY_SHAPES[key]);
    }
  });

  it('fills the shape with the category colour', () => {
    const el = createCategoryMark({ color: '#123456', icon: { type: 'shape', value: 'star' } });
    expect(el.querySelector('path').getAttribute('fill')).toBe('#123456');
  });

  it('an unknown shape key degrades to the colour dot, not a blank', () => {
    const el = createCategoryMark({ color: '#f00', icon: { type: 'shape', value: 'wormhole' } });
    expect(el.tagName.toLowerCase()).toBe('span');
    expect(el.style.background).toBeTruthy();
  });

  it('ships a usable set of shapes', () => {
    expect(SHAPE_KEYS.length).toBeGreaterThanOrEqual(6);
    expect(SHAPE_KEYS).toContain('circle');
    for (const key of SHAPE_KEYS) {
      expect(CATEGORY_SHAPES[key], key).toMatch(/^M/);   // real path data
    }
  });
});

describe('emoji', () => {
  // Emoji render from bundled Twemoji artwork, not from an OS font, so the
  // set matches EroScripts and looks identical on every platform. See
  // emoji-asset.test.js for the artwork contract.
  it('renders as bundled artwork, with the emoji as its label', () => {
    const el = createCategoryMark({ color: '#f00', icon: { type: 'emoji', value: '🔥' } });
    expect(el.tagName.toLowerCase()).toBe('img');
    expect(el.alt).toBe('🔥');
  });

  it('does NOT take the category colour, because emoji carry their own', () => {
    const el = createCategoryMark({ color: '#123456', icon: { type: 'emoji', value: '🔥' } });
    expect(el.style.background).toBe('');
  });

  it('gets a fixed box so it cannot shift row heights', () => {
    const el = createCategoryMark({ color: '#f00', icon: { type: 'emoji', value: '🔥' } }, { size: 10 });
    expect(el.style.width).toBeTruthy();
    expect(el.style.height).toBeTruthy();
    expect(el.width).toBeGreaterThan(0);
  });
});

describe('grapheme handling', () => {
  // THE TRAP: emoji are multi-code-unit. `.slice(0,1)` cuts a surrogate pair
  // in half and produces U+FFFD. Truncation must be grapheme-aware.
  it('counts an emoji as one character, not two code units', () => {
    expect('🔥'.length).toBe(2);          // the thing that misleads
    expect(graphemeCount('🔥')).toBe(1);
  });

  it('counts a compound emoji as one grapheme', () => {
    // Skin-tone modifier: several code points, one perceived character.
    expect(graphemeCount('👍🏽')).toBe(1);
  });

  it('takes the first grapheme without producing mojibake', () => {
    const first = firstGrapheme('🔥🎉');
    expect(first).toBe('🔥');
    expect(first).not.toContain('�');
    expect(first.codePointAt(0)).toBe('🔥'.codePointAt(0));
  });

  it('truncates a pasted multi-emoji string to one', () => {
    const icon = normaliseIcon({ type: 'emoji', value: '🔥🎉🌊' });
    expect(graphemeCount(icon.value)).toBe(1);
    expect(icon.value).toBe('🔥');
  });

  it('handles empty and whitespace input', () => {
    expect(graphemeCount('')).toBe(0);
    expect(firstGrapheme('')).toBe('');
    expect(normaliseIcon({ type: 'emoji', value: '   ' })).toBeNull();
    expect(normaliseIcon({ type: 'emoji', value: '' })).toBeNull();
  });
});

describe('normaliseIcon', () => {
  it('passes a valid shape through', () => {
    expect(normaliseIcon({ type: 'shape', value: 'star' })).toEqual({ type: 'shape', value: 'star' });
  });

  it('rejects an unknown shape rather than storing it', () => {
    expect(normaliseIcon({ type: 'shape', value: 'wormhole' })).toBeNull();
  });

  it('rejects unknown types and junk', () => {
    expect(normaliseIcon({ type: 'sprite', value: 'x' })).toBeNull();
    expect(normaliseIcon(null)).toBeNull();
    expect(normaliseIcon('star')).toBeNull();
    expect(normaliseIcon(undefined)).toBeNull();
  });

  it('round-trips through JSON, as settings storage would', () => {
    const icon = normaliseIcon({ type: 'emoji', value: '🔥' });
    const revived = normaliseIcon(JSON.parse(JSON.stringify(icon)));
    expect(revived).toEqual(icon);
  });
});
