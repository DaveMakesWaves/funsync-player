// Category emoji render from BUNDLED TWEMOJI ARTWORK.
//
// Dave: "can we not use the same emoji pack as eroscripts does for user
// parity?"
//
// EroScripts is Discourse, and Discourse's default emoji set is Twemoji —
// confirmed from the images it serves: /images/emoji/twitter/heart.png.
// Font rendering could never match that, because it hands the choice to
// whichever emoji font the OS ships, which is also why the set looked dated
// and differed between machines.
//
// The invariant worth defending: WE ONLY EVER POINT AT ARTWORK WE SHIPPED.
// A missing file renders as a broken-image icon, which is worse than the
// text fallback, so `emojiAssetPath` must return null rather than guess.
import { describe, it, expect } from 'vitest';
import {
  twemojiNames,
  emojiAssetPath,
  createEmojiImage,
  registerAvailableAssets,
} from '../../renderer/js/emoji-asset.js';
import { BUNDLED_EMOJI_ASSETS } from '../../renderer/js/emoji-assets-manifest.js';
import { ALL_EMOJI, EMOJI_GROUPS } from '../../renderer/js/emoji-catalog.js';
import { createCategoryMark } from '../../renderer/js/category-icon.js';

// Importing the catalogue registers the manifest as a side effect; do it
// explicitly too so this file does not depend on import order.
registerAvailableAssets(BUNDLED_EMOJI_ASSETS);

describe('Twemoji filename convention', () => {
  it('lowercases code points and joins them with a dash', () => {
    expect(twemojiNames('🔥')).toContain('1f525');
  });

  // U+FE0F asks a FONT for the colour glyph. Twemoji art is colour by
  // definition, so its filenames omit it.
  it('strips the variation selector', () => {
    expect(twemojiNames('❤️')[0]).toBe('2764');
  });

  it('offers the unstripped name as a fallback', () => {
    // Some sequences keep the selector in their filename.
    expect(twemojiNames('❤️‍🔥')).toEqual(
      expect.arrayContaining(['2764-200d-1f525', '2764-fe0f-200d-1f525']),
    );
  });

  it('handles junk without throwing', () => {
    expect(twemojiNames('')).toEqual([]);
    expect(twemojiNames(null)).toEqual([]);
    expect(twemojiNames(undefined)).toEqual([]);
  });
});

describe('every catalogue emoji has bundled artwork', () => {
  // The whole point of vendoring: if it is offered in the picker, the file
  // exists. Anything missing here would render as a broken image.
  it('resolves a path for all of them', () => {
    const missing = ALL_EMOJI.filter((e) => !emojiAssetPath(e));
    expect(missing, `no artwork for: ${missing.join(' ')}`).toEqual([]);
  });

  it('every resolved path points at a manifest entry', () => {
    const shipped = new Set(BUNDLED_EMOJI_ASSETS);
    for (const e of ALL_EMOJI) {
      const name = emojiAssetPath(e).replace('assets/emoji/', '').replace('.svg', '');
      expect(shipped.has(name), `${e} -> ${name} not in manifest`).toBe(true);
    }
  });

  it('the manifest covers the catalogue exactly, with nothing stale', () => {
    const used = new Set(
      ALL_EMOJI.map((e) => emojiAssetPath(e).replace('assets/emoji/', '').replace('.svg', '')),
    );
    const orphans = BUNDLED_EMOJI_ASSETS.filter((n) => !used.has(n));
    expect(orphans, `bundled but unused: ${orphans.join(' ')}`).toEqual([]);
  });

  it('ships one asset per catalogue entry', () => {
    expect(BUNDLED_EMOJI_ASSETS.length).toBe(ALL_EMOJI.length);
  });

  it('returns null for an emoji we did not bundle', () => {
    // A rare character typed into the free-text field.
    expect(emojiAssetPath('🯰')).toBeNull();
  });
});

describe('createEmojiImage', () => {
  it('builds an img pointing at the bundled SVG', () => {
    const img = createEmojiImage('🔥', { size: 20 });
    expect(img.tagName.toLowerCase()).toBe('img');
    expect(img.getAttribute('src')).toBe('assets/emoji/1f525.svg');
  });

  it('uses the emoji itself as alt text', () => {
    // The emoji IS the label; an empty alt makes a category read as unnamed.
    expect(createEmojiImage('🔥').alt).toBe('🔥');
  });

  it('applies the requested size', () => {
    const img = createEmojiImage('🔥', { size: 24 });
    expect(img.width).toBe(24);
    expect(img.style.width).toBe('24px');
  });

  it('returns null rather than a broken image when unbundled', () => {
    expect(createEmojiImage('🯰')).toBeNull();
  });
});

describe('category marks use the artwork', () => {
  it('renders an emoji category as an img, not a font glyph', () => {
    const el = createCategoryMark(
      { color: '#f00', icon: { type: 'emoji', value: '🔥' } },
      { className: 'library__card-category-dot', size: 12 },
    );
    expect(el.tagName.toLowerCase()).toBe('img');
    expect(el.getAttribute('src')).toContain('1f525.svg');
  });

  it('still carries the --icon modifier so CSS can undo the dot styling', () => {
    const el = createCategoryMark(
      { color: '#f00', icon: { type: 'emoji', value: '🔥' } },
      { className: 'library__card-category-dot' },
    );
    expect(el.getAttribute('class')).toContain('library__card-category-dot--icon');
  });

  it('falls back to text for an emoji with no artwork', () => {
    const el = createCategoryMark({ color: '#f00', icon: { type: 'emoji', value: '🯰' } });
    expect(el.tagName.toLowerCase()).toBe('span');
    expect(el.textContent).toBe('🯰');
  });

  it('a text-default emoji resolves to artwork despite the added selector', () => {
    // 🖨 gets U+FE0F appended when stored; the filename has it stripped.
    // If those two disagreed, the printer would silently fall back to text.
    const el = createCategoryMark({ color: '#f00', icon: { type: 'emoji', value: '🖨' } });
    expect(el.tagName.toLowerCase()).toBe('img');
    expect(el.getAttribute('src')).toBe('assets/emoji/1f5a8.svg');
  });

  it('every group renders every entry as artwork', () => {
    for (const g of EMOJI_GROUPS) {
      for (const e of g.emoji) {
        const el = createCategoryMark({ color: '#f00', icon: { type: 'emoji', value: e } });
        expect(el.tagName.toLowerCase(), `${g.id}: ${e} fell back to text`).toBe('img');
      }
    }
  });
});
