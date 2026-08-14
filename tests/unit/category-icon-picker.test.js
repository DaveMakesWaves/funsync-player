// The category icon picker (myopiic, thread #270).
//
// Dave, after the first pass shipped only the RENDERING half:
// "for categories i can still only assign a colour."
//
// So the thing these tests actually defend is that a user can SET an icon,
// on new AND existing categories, and that what they set survives the round
// trip. A picker that only appears when creating a category is useless to
// anyone who already has some, which is everyone who would want this.
//
// Needs a DOM: the picker builds real elements, and the SVG-namespace
// behaviour only exists in a browser DOM.
import { describe, it, expect, vi } from 'vitest';
import { createCategoryIconPicker } from '../../renderer/js/category-icon-picker.js';
import { SHAPE_KEYS } from '../../renderer/js/category-icon.js';

vi.mock('../../renderer/js/i18n.js', () => ({
  t: (key) => key,
}));

describe('defaults', () => {
  it('starts on Colour, so behaviour is unchanged unless asked', () => {
    const picker = createCategoryIconPicker({ color: '#f00' });
    expect(picker.getIcon()).toBeNull();
  });

  it('opens on the mode of the icon it was given', () => {
    const shape = createCategoryIconPicker({ initialIcon: { type: 'shape', value: 'star' } });
    expect(shape.getIcon()).toEqual({ type: 'shape', value: 'star' });

    const emoji = createCategoryIconPicker({ initialIcon: { type: 'emoji', value: '🔥' } });
    expect(emoji.getIcon()).toEqual({ type: 'emoji', value: '🔥' });
  });

  it('ignores a stored icon that is no longer valid', () => {
    const picker = createCategoryIconPicker({ initialIcon: { type: 'shape', value: 'wormhole' } });
    expect(picker.getIcon()).toBeNull();
  });
});

describe('choosing a shape', () => {
  it('selecting a shape swatch sets that icon', () => {
    const picker = createCategoryIconPicker({ color: '#0f0' });
    const swatches = picker.element.querySelectorAll('.categories__icon-shape');
    expect(swatches.length).toBe(SHAPE_KEYS.length);
    swatches[2].click();
    expect(picker.getIcon()).toEqual({ type: 'shape', value: SHAPE_KEYS[2] });
  });

  it('renders swatches in the SVG namespace, not the HTML one', () => {
    // Same trap as category-icon.js: HTML-namespaced SVG is invisible but
    // still clickable, so a picker built that way would look empty.
    const picker = createCategoryIconPicker({ color: '#0f0' });
    const svg = picker.element.querySelector('.categories__icon-shape svg');
    expect(svg).toBeTruthy();
    expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
  });

  it('re-tints the swatches when the colour changes', () => {
    const picker = createCategoryIconPicker({ color: '#111111' });
    picker.setColor('#abcdef');
    const path = picker.element.querySelector('.categories__icon-shape svg path');
    expect(path.getAttribute('fill')).toBe('#abcdef');
  });
});

describe('choosing an emoji', () => {
  const typeInto = (picker, value) => {
    const input = picker.element.querySelector('.categories__icon-emoji-input');
    input.value = value;
    input.dispatchEvent(new Event('input'));
    return input;
  };

  it('accepts a single emoji', () => {
    const picker = createCategoryIconPicker({});
    typeInto(picker, '🔥');
    expect(picker.getIcon()).toEqual({ type: 'emoji', value: '🔥' });
  });

  it('truncates a pasted string to ONE grapheme without mojibake', () => {
    const picker = createCategoryIconPicker({});
    const input = typeInto(picker, '🔥🎉🌊');
    expect(picker.getIcon()).toEqual({ type: 'emoji', value: '🔥' });
    expect(input.value).toBe('🔥');
    expect(input.value).not.toContain('�');
  });

  it('keeps a compound emoji whole rather than splitting it', () => {
    // Skin-tone modifier: several code points, one perceived character.
    // maxLength=1 or slice(0,1) would cut this in half.
    const picker = createCategoryIconPicker({});
    typeInto(picker, '👍🏽');
    expect(picker.getIcon().value).toBe('👍🏽');
  });

  it('clearing the field falls back to the colour dot', () => {
    const picker = createCategoryIconPicker({ initialIcon: { type: 'emoji', value: '🔥' } });
    typeInto(picker, '');
    expect(picker.getIcon()).toBeNull();
  });

  it('offers quick-pick suggestions that set the icon', () => {
    const picker = createCategoryIconPicker({});
    const suggestion = picker.element.querySelector('.categories__icon-emoji-suggestion');
    // Buttons show the bundled artwork now, so the emoji lives in the img's
    // alt text rather than the button's textContent.
    const emoji = suggestion.querySelector('img').alt;
    suggestion.click();
    expect(picker.getIcon()).toEqual({ type: 'emoji', value: emoji });
  });
});

describe('modes are mutually exclusive', () => {
  const modeButtons = (picker) => picker.element.querySelectorAll('.categories__icon-mode');

  it('switching back to Colour clears the icon', () => {
    const picker = createCategoryIconPicker({ initialIcon: { type: 'shape', value: 'star' } });
    expect(picker.getIcon()).not.toBeNull();
    modeButtons(picker)[0].click();          // Colour
    expect(picker.getIcon()).toBeNull();
  });

  it('shows only the controls for the active mode', () => {
    const picker = createCategoryIconPicker({});
    const shapes = picker.element.querySelector('.categories__icon-shapes');
    const emoji = picker.element.querySelector('.categories__icon-emoji-row');

    modeButtons(picker)[1].click();          // Shape
    expect(shapes.hidden).toBe(false);
    expect(emoji.hidden).toBe(true);

    modeButtons(picker)[2].click();          // Emoji
    expect(shapes.hidden).toBe(true);
    expect(emoji.hidden).toBe(false);
  });

  it('reports the active mode for assistive tech', () => {
    const picker = createCategoryIconPicker({});
    const [colour, shape] = modeButtons(picker);
    expect(colour.getAttribute('aria-pressed')).toBe('true');
    shape.click();
    expect(shape.getAttribute('aria-pressed')).toBe('true');
    expect(colour.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('onChange', () => {
  it('fires when the selection changes', () => {
    const onChange = vi.fn();
    const picker = createCategoryIconPicker({ onChange });
    picker.element.querySelectorAll('.categories__icon-shape')[0].click();
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls.at(-1)[0]).toEqual({ type: 'shape', value: SHAPE_KEYS[0] });
  });
});

describe('the preview shows the real mark', () => {
  it('previews a shape as SVG and an emoji as its artwork', () => {
    const shape = createCategoryIconPicker({ initialIcon: { type: 'shape', value: 'star' }, color: '#0f0' });
    expect(shape.element.querySelector('.categories__icon-preview svg')).toBeTruthy();

    const emoji = createCategoryIconPicker({ initialIcon: { type: 'emoji', value: '🔥' } });
    const img = emoji.element.querySelector('.categories__icon-preview img');
    expect(img).toBeTruthy();
    expect(img.getAttribute('src')).toContain('1f525.svg');
  });
});
