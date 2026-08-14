// Emoji text helpers.
//
// The canvas-based OS support detection that used to live here is GONE.
// Category emoji now render from BUNDLED TWEMOJI ARTWORK (see
// emoji-asset.js), so "can this machine draw it?" is answered by "did we
// ship the SVG?" — a set lookup, rather than 2,211 GPU readbacks and the
// 2-3 second freeze that used to precede the edit-category modal opening.
//
// Bundling also removed the reason the detection existed: there is no longer
// an OS font making per-machine decisions about which glyph to draw.
//
// What remains is needed for the free-text emoji field, where a user can
// type any character, including ones we have no artwork for.

/**
 * Fallback font stack, used only for emoji WITHOUT bundled artwork.
 *
 * Colour fonts only. "Segoe UI Symbol" used to sit at the end of this list
 * and was actively harmful: it is a MONOCHROME symbol font, so anything
 * missing from the colour font fell through to it and drew as a flat
 * outline, which is what made the set look a decade old.
 */
export const EMOJI_FONT_STACK =
  '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Twemoji Mozilla", sans-serif';

/**
 * Force COLOUR (emoji) presentation by appending U+FE0F where needed.
 *
 * Two reasons this still matters even though most emoji now render as
 * images: the font fallback path above still has a glyph choice to make, and
 * STORED values need to be canonical so the same emoji always serialises
 * identically and maps to exactly one asset filename.
 *
 * Many emoji have `Emoji_Presentation=No` and default to TEXT presentation,
 * i.e. a monochrome glyph. U+1F5A8 (printer) is one, and so are around 60
 * others in the catalogue. Absent an explicit selector, which one you get is
 * decided by font fallback — which is why the same emoji could look
 * different in two places in the same app.
 *
 * Left alone: anything already carrying a variation selector, ZWJ sequences,
 * skin-tone modifiers and flags. Appending to those can break the sequence.
 *
 * @param {string} ch
 * @returns {string}
 */
export function withEmojiPresentation(ch) {
  if (typeof ch !== 'string' || ch.length === 0) return '';
  if (/[︎️‍]/.test(ch)) return ch;            // already explicit / ZWJ
  if (/[\u{1F3FB}-\u{1F3FF}]/u.test(ch)) return ch;          // skin-tone modifier
  if (/[\u{1F1E6}-\u{1F1FF}]/u.test(ch)) return ch;          // regional indicator (flag)
  if ([...ch].length !== 1) return ch;                       // multi-codepoint sequence
  if (!/\p{Extended_Pictographic}/u.test(ch)) return ch;     // not an emoji
  if (/\p{Emoji_Presentation}/u.test(ch)) return ch;         // already colour by default
  return `${ch}️`;
}
