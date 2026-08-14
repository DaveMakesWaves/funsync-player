// Emoji rendered from BUNDLED TWEMOJI ARTWORK, not from an OS font.
//
// Dave: "these are still some old ass emojis can we not use the same emoji
// pack as eroscripts does for user parity?"
//
// EroScripts is Discourse and Discourse's default emoji set is Twemoji —
// confirmed from the images it serves (`/images/emoji/twitter/heart.png`).
// Font rendering could never match that, because it hands the decision to
// whichever emoji font the OS ships: Segoe UI Emoji on Windows, Noto Color
// Emoji on most Linux desktops, different vintages on different builds.
//
// Bundling the artwork settles every problem the font approach created:
//
//   * PARITY. A category marked 🔥 looks the same in the app as on the
//     forum, and the same on Windows as on Linux.
//   * NO STALE GLYPHS. The set is whatever we vendored, not whatever the
//     system font happens to be from.
//   * NO SUPPORT DETECTION. The old canvas probe measured 737 glyphs on
//     first open — 2,211 GPU readbacks and a 2-3 second freeze before the
//     edit-category modal appeared. If an SVG is bundled it is supported,
//     full stop, so that whole pass is gone.
//   * NO PRESENTATION AMBIGUITY. Text-vs-emoji presentation (U+FE0F) only
//     matters when a font is choosing a glyph. An <img> has no such choice.
//
// Assets live in renderer/assets/emoji/, fetched by scripts/fetch-twemoji.mjs.
// Graphics are CC-BY 4.0 — see the NOTICE beside them.

/** Where the vendored SVGs live, relative to the renderer HTML. */
const ASSET_DIR = 'assets/emoji';

/** Same colour-only stack the rest of the app uses for unbundled emoji. */
const FALLBACK_FONT_STACK =
  '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Twemoji Mozilla", sans-serif';

/**
 * Twemoji's filename convention: lowercase hex code points joined by '-',
 * with U+FE0F stripped. The selector exists to ask a FONT for the colour
 * glyph; Twemoji art is colour by definition, so the filenames omit it.
 *
 * Exception: sequences where the selector is load-bearing keep it, which is
 * why the fallback name is returned too. `emojiAssetPath` prefers the first
 * that we actually bundled.
 *
 * @param {string} emoji
 * @returns {string[]} candidate basenames, best first
 */
export function twemojiNames(emoji) {
  if (typeof emoji !== 'string' || emoji.length === 0) return [];
  const cps = [...emoji].map((c) => c.codePointAt(0).toString(16));
  const stripped = cps.filter((c) => c !== 'fe0f');
  const names = [];
  if (stripped.length) names.push(stripped.join('-'));
  if (stripped.length !== cps.length) names.push(cps.join('-'));
  return names;
}

/**
 * The set of basenames we actually shipped.
 *
 * Populated from the catalogue at module load rather than probing the
 * filesystem, which the renderer cannot do. Anything not in here has no
 * artwork and must fall back rather than render a broken image.
 *
 * @type {Set<string>}
 */
const _available = new Set();

/** Register the basenames that exist. Called once by the catalogue. */
export function registerAvailableAssets(names) {
  for (const n of names) _available.add(n);
}

/**
 * Path to the bundled SVG for an emoji, or null when we have no artwork.
 *
 * @param {string} emoji
 * @returns {string|null}
 */
export function emojiAssetPath(emoji) {
  for (const name of twemojiNames(emoji)) {
    if (_available.size === 0 || _available.has(name)) {
      return `${ASSET_DIR}/${name}.svg`;
    }
  }
  return null;
}

/**
 * Build an <img> for an emoji.
 *
 * Returns null when there is no bundled artwork, so callers can fall back to
 * plain text rather than showing a broken-image icon.
 *
 * @param {string} emoji
 * @param {{size?: number, className?: string, alt?: string}} [opts]
 * @returns {HTMLImageElement|null}
 */
export function createEmojiImage(emoji, opts = {}) {
  const src = emojiAssetPath(emoji);
  if (!src) return null;
  const img = document.createElement('img');
  img.src = src;
  // The emoji IS the label — screen readers should hear the character, and
  // an empty alt would make a category read as unnamed.
  img.alt = opts.alt ?? emoji;
  img.draggable = false;
  if (opts.className) img.className = opts.className;
  const px = opts.size ? `${Math.round(opts.size)}px` : null;
  if (px) {
    img.width = Math.round(opts.size);
    img.height = Math.round(opts.size);
    img.style.width = px;
    img.style.height = px;
  }
  img.style.objectFit = 'contain';
  img.style.flexShrink = '0';
  img.style.verticalAlign = 'middle';

  // The artwork is gitignored and fetched at build time, so a source clone
  // that has not run scripts/fetch-twemoji.mjs has the manifest but not the
  // files. Rather than show a broken-image icon, fall back to rendering the
  // character itself — which is exactly what an emoji with no bundled art
  // already does. Costs nothing when the file is present.
  img.addEventListener('error', () => {
    const span = document.createElement('span');
    if (opts.className) span.className = opts.className;
    span.textContent = emoji;
    span.style.fontFamily = FALLBACK_FONT_STACK;
    if (px) {
      span.style.fontSize = px;
      span.style.width = px;
      span.style.height = px;
    }
    span.style.lineHeight = '1';
    span.style.display = 'inline-flex';
    span.style.alignItems = 'center';
    span.style.justifyContent = 'center';
    span.style.flexShrink = '0';
    img.replaceWith(span);
  }, { once: true });

  return img;
}
