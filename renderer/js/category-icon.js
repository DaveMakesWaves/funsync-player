import { EMOJI_FONT_STACK, withEmojiPresentation } from './emoji-support.js';
import { createEmojiImage } from './emoji-asset.js';

// Category icons — prefab shapes and emoji.
//
// myopiic, thread #270: "For the categories, it would be cool to select a
// symbol and a color instead of just a color. Or maybe give the option to
// chose an emoji instead?"
//
// Model: categories are `{ id, name, color }` and gain ONE optional field.
// Absent means "plain colour dot", i.e. exactly today's appearance, so every
// existing category keeps working with no migration.
//
//   icon?: { type: 'shape' | 'emoji', value: string }
//
// Emoji are stored as the character itself rather than a shortcode, which
// avoids shipping a name table and keeps them locale-independent.
//
// Two traps this file exists to contain:
//
//   1. SVG built through innerHTML lands in the HTML namespace. It renders
//      invisible while remaining clickable, which is a genuinely confusing
//      bug to chase. Everything here uses createElementNS.
//   2. Emoji are multi-code-unit. Slicing by `.length` cuts surrogate pairs
//      in half and produces mojibake, so length checks and truncation go
//      through Intl.Segmenter / the spread operator, never `.slice()`.

/**
 * Prefab shapes. Geometric primitives only — deliberately NOT named after
 * Lucide icons, because Lucide path data must be fetched from the lucide
 * repo rather than hand-written, and hand-typed paths have shipped wrong
 * glyphs here before. Adding a named icon means curling its real SVG.
 *
 * Each entry draws inside a 24x24 viewBox and is filled with the category
 * colour, so shape and colour carry the same identity.
 */
export const CATEGORY_SHAPES = {
  circle: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z',
  square: 'M3 3h18v18H3z',
  triangle: 'M12 2 22 21H2z',
  diamond: 'M12 1.5 22.5 12 12 22.5 1.5 12z',
  star: 'M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.3 5.9 20.6l1.4-6.8L2.2 9.1l6.9-.8z',
  heart: 'M12 21s-7.5-4.7-9.4-9A5.3 5.3 0 0 1 12 6.7a5.3 5.3 0 0 1 9.4 5.3C19.5 16.3 12 21 12 21z',
  hexagon: 'M12 2l8.7 5v10L12 22l-8.7-5V7z',
  droplet: 'M12 2.7 6.3 9.9a7.2 7.2 0 1 0 11.4 0z',
};

export { withEmojiPresentation };

export const SHAPE_KEYS = Object.keys(CATEGORY_SHAPES);
export const DEFAULT_SHAPE = 'circle';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Count user-perceived characters, not code units.
 * A flag or a skin-toned emoji is several code points and one grapheme.
 */
export function graphemeCount(str) {
  if (typeof str !== 'string' || str.length === 0) return 0;
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    return [...new Intl.Segmenter().segment(str)].length;
  }
  return [...str].length;   // code points; still never splits a surrogate pair
}

/**
 * Take the first grapheme of a string.
 * Never `.slice(0, 1)` — that cuts a surrogate pair in half and yields U+FFFD.
 */
export function firstGrapheme(str) {
  if (typeof str !== 'string' || str.length === 0) return '';
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const first = [...new Intl.Segmenter().segment(str)][0];
    return first ? first.segment : '';
  }
  return [...str][0] || '';
}

/**
 * Normalise arbitrary user input into a storable icon, or null for
 * "plain colour dot".
 *
 * Unknown shape keys fall back to null rather than rendering blank, so a
 * config written by a newer version degrades to today's appearance instead
 * of an invisible category.
 */
export function normaliseIcon(icon) {
  if (!icon || typeof icon !== 'object') return null;
  if (icon.type === 'shape') {
    return SHAPE_KEYS.includes(icon.value) ? { type: 'shape', value: icon.value } : null;
  }
  if (icon.type === 'emoji') {
    // Presentation is pinned at STORE time, so the value that lands in
    // config.json is exactly the string every surface will render. Doing it
    // only at render time would leave the stored value ambiguous and let the
    // two drift apart again.
    const one = withEmojiPresentation(firstGrapheme(String(icon.value || '').trim()));
    return one ? { type: 'emoji', value: one } : null;
  }
  return null;
}

/**
 * Build the visual for a category.
 *
 * @param {{color?: string, icon?: object}} category
 * @param {{size?: number, className?: string}} [opts]
 * @returns {HTMLElement} always an element, never null
 */
export function createCategoryMark(category, opts = {}) {
  const size = opts.size || 8;
  const color = category?.color || 'currentColor';
  const icon = normaliseIcon(category?.icon);

  // Surfaces style the plain dot with a fixed width/height, a border and a
  // 50% radius. Applied to a shape or an emoji that squashes it into a
  // bordered circle and the icon is never seen — reported as "the library
  // cards are showing just the circle". So an icon mark carries a BEM
  // modifier alongside the caller's class, and each surface neutralises the
  // dot styling for it.
  const cls = icon && opts.className
    ? `${opts.className} ${opts.className}--icon`
    : opts.className;

  if (icon && icon.type === 'emoji') {
    // Prefer the BUNDLED TWEMOJI ARTWORK — the same set EroScripts uses, so
    // a category looks identical in the app, on the forum, and across
    // Windows and Linux. Font rendering is only the fallback, for characters
    // typed into the free-text field that we have no artwork for.
    const img = createEmojiImage(icon.value, {
      className: cls,
      size: Math.round(size * 1.4),
    });
    if (img) return img;

    const span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = icon.value;
    // THE SAME font stack the picker uses. Without this the span inherited
    // the app's UI font, so a character could resolve to a monochrome glyph
    // here and a colour one in the picker — the "2 different printers"
    // report. Measuring, picking and displaying must all name one stack.
    span.style.fontFamily = EMOJI_FONT_STACK;
    // Emoji ignore the category colour by nature — they carry their own.
    // Fixed box so a tall glyph cannot shift the row height.
    span.style.fontSize = `${Math.round(size * 1.4)}px`;
    span.style.lineHeight = '1';
    span.style.width = `${Math.round(size * 1.4)}px`;
    span.style.height = `${Math.round(size * 1.4)}px`;
    span.style.display = 'inline-flex';
    span.style.alignItems = 'center';
    span.style.justifyContent = 'center';
    span.style.flexShrink = '0';
    return span;
  }

  if (icon && icon.type === 'shape') {
    // createElementNS, NOT innerHTML — see the header note.
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(Math.round(size * 1.4)));
    svg.setAttribute('height', String(Math.round(size * 1.4)));
    svg.setAttribute('aria-hidden', 'true');
    svg.style.flexShrink = '0';
    if (cls) svg.setAttribute('class', cls);
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', CATEGORY_SHAPES[icon.value]);
    path.setAttribute('fill', color);
    svg.appendChild(path);
    return svg;
  }

  // Default: the colour dot exactly as it has always been.
  const dot = document.createElement('span');
  if (opts.className) dot.className = opts.className;
  dot.style.background = color;
  return dot;
}
