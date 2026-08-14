// Emoji presentation + the category emoji catalogue.
//
// The canvas-based OS support detection this file used to cover is gone.
// Category emoji render from BUNDLED TWEMOJI ARTWORK now (see
// emoji-asset.test.js), which removed the reason it existed: there is no
// longer an OS font making per-machine decisions about which glyph to draw.
// It also removed a 2-3 second freeze before the edit-category modal opened,
// which was 2,211 GPU readbacks measuring 737 glyphs the user had not asked
// to see.
//
// What is still worth pinning here is CANONICAL STORAGE: the same emoji must
// always serialise identically, or it maps to a different asset filename and
// the picker and the card disagree again.
import { describe, it, expect } from 'vitest';
import { EMOJI_FONT_STACK, withEmojiPresentation } from '../../renderer/js/emoji-support.js';
import { normaliseIcon, graphemeCount } from '../../renderer/js/category-icon.js';
import { EMOJI_GROUPS, ALL_EMOJI, QUICK_EMOJI } from '../../renderer/js/emoji-catalog.js';

// Dave: "im seeing 2 different printers here, why is that?"
//
// 🖨 U+1F5A8 has Emoji_Presentation=No, so it defaults to TEXT presentation:
// a monochrome glyph. Absent an explicit selector, which one you get is
// decided by font fallback, so the same character differed between two
// places in the same app.
describe('emoji presentation is pinned, not left to font fallback', () => {
  it('pins colour presentation on a text-default emoji', () => {
    expect([...withEmojiPresentation('🖨')].map((c) => c.codePointAt(0)))
      .toEqual([0x1F5A8, 0xFE0F]);
  });

  it('leaves an already-colour emoji untouched', () => {
    expect(withEmojiPresentation('🔥')).toBe('🔥');
    expect(withEmojiPresentation('🍑')).toBe('🍑');
  });

  it('does not double up an existing variation selector', () => {
    const once = withEmojiPresentation('❤');
    expect(withEmojiPresentation(once)).toBe(once);
  });

  it('leaves skin-tone modifiers and ZWJ sequences alone', () => {
    // Appending to these can break the sequence.
    expect(withEmojiPresentation('👍🏽')).toBe('👍🏽');
    expect(withEmojiPresentation('👨‍👩‍👧')).toBe('👨‍👩‍👧');
  });

  it('is still one grapheme after normalising', () => {
    // The picker truncates by grapheme, so the extra code point must not
    // make the value look like two characters and get chopped.
    expect(graphemeCount(withEmojiPresentation('🖨'))).toBe(1);
  });

  it('is idempotent, so repeated saves are stable', () => {
    for (const e of ALL_EMOJI) {
      const once = withEmojiPresentation(e);
      expect(withEmojiPresentation(once), e).toBe(once);
    }
  });

  it('what is stored equals what the picker offered', () => {
    for (const e of ALL_EMOJI.slice(0, 80)) {
      const offered = withEmojiPresentation(e);
      expect(normaliseIcon({ type: 'emoji', value: offered }).value, e).toBe(offered);
    }
  });

  it('ignores non-emoji text and junk', () => {
    expect(withEmojiPresentation('a')).toBe('a');
    expect(withEmojiPresentation('7')).toBe('7');
    expect(withEmojiPresentation('')).toBe('');
    expect(withEmojiPresentation(null)).toBe('');
    expect(withEmojiPresentation(undefined)).toBe('');
  });
});

describe('the fallback font stack', () => {
  // Only used for characters typed into the free-text field that we have no
  // bundled artwork for.
  it('names the OS colour emoji fonts', () => {
    expect(EMOJI_FONT_STACK).toContain('Segoe UI Emoji');   // Windows
    expect(EMOJI_FONT_STACK).toContain('Noto Color Emoji'); // Linux
  });

  // "Segoe UI Symbol" used to be the last resort here and was half the
  // reason the set looked dated: it is MONOCHROME, so anything missing from
  // the colour font drew as a flat outline.
  it('contains no monochrome fallback font', () => {
    expect(EMOJI_FONT_STACK).not.toContain('Segoe UI Symbol');
    expect(EMOJI_FONT_STACK).not.toContain('Symbola');
  });
});

describe('the catalogue', () => {
  it('is big enough to be worth scrolling', () => {
    expect(ALL_EMOJI.length).toBeGreaterThan(300);
  });

  it('has no duplicates within a group', () => {
    for (const g of EMOJI_GROUPS) {
      expect(new Set(g.emoji).size, g.id).toBe(g.emoji.length);
    }
  });

  it('has no duplicates ACROSS groups either', () => {
    // The same emoji appearing twice reads as a bug when scrolling.
    const seen = new Map();
    const dupes = [];
    for (const g of EMOJI_GROUPS) {
      for (const e of g.emoji) {
        if (seen.has(e)) dupes.push(`${e} (${seen.get(e)} + ${g.id})`);
        else seen.set(e, g.id);
      }
    }
    expect(dupes).toEqual([]);
  });

  it('keeps a usable group shape', () => {
    for (const g of EMOJI_GROUPS) {
      expect(g.id).toBeTruthy();
      expect(g.labelKey.startsWith('emoji.group.')).toBe(true);
      expect(g.emoji.length).toBeGreaterThan(0);
    }
  });

  // Dave: "those are all fairly old looking emojis can we not use the
  // updated ones that the OS whatever it may be uses?"
  it('includes a substantial number of modern (Unicode 12+) emoji', () => {
    const modern = ALL_EMOJI.filter((e) => e.codePointAt(0) >= 0x1FA70);
    expect(modern.length).toBeGreaterThan(60);
  });

  it('includes specific recent additions people would expect to find', () => {
    for (const e of ['🫠', '🫶', '🩷', '🩵', '🫡', '🥹', '🪩', '🛞']) {
      expect(ALL_EMOJI, `${e} missing from the catalogue`).toContain(e);
    }
  });

  it('every quick pick also exists in a browsable group', () => {
    const all = new Set(ALL_EMOJI);
    for (const q of QUICK_EMOJI) {
      expect(all.has(q), `${q} is a quick pick but not in any group`).toBe(true);
    }
  });

  it('contains only non-empty strings', () => {
    for (const e of ALL_EMOJI) {
      expect(typeof e).toBe('string');
      expect(e.length).toBeGreaterThan(0);
    }
  });
});
