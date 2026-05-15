// Pins the funscript variant-classification logic in
// electron/main.js::scan-directory. The classifier is currently inline
// in main.js (CJS + Electron deps make direct import hostile); this
// file mirrors the algorithm 1:1 so behavioural regressions surface
// here. If you change the classifier in main.js, mirror the change
// here AND verify the assertions still hold.
//
// Specific regression this pins: dotted filenames like S01.E03.funscript
// or Title.2024.funscript were being misclassified as variants of a
// non-existent base ("S01" / "Title"), leaving them in
// `unmatchedFunscripts` even when the matching video sat in the same
// folder. Fix: ambiguous dot-variants are demoted to primary when no
// sibling primary exists with the dot-stripped base.

import { describe, it, expect } from 'vitest';

const AXIS_SUFFIXES = new Set([
  'surge', 'sway', 'twist', 'roll', 'pitch', 'vib', 'lube', 'pump', 'suction', 'valve',
]);

const normalizeName = (name) =>
  name.toLowerCase().replace(/[_.\-]/g, ' ').replace(/\s+/g, ' ').trim();

// Mirror of `funscriptList` build + post-pass from main.js scan-directory.
function classify(funscriptFilenames, dir = '/lib') {
  const funscriptList = [];
  for (const filename of funscriptFilenames) {
    const nameNoExt = filename.replace(/\.funscript$/i, '');
    const dotIdx = nameNoExt.lastIndexOf('.');
    const dotSuffix = dotIdx >= 0 ? nameNoExt.slice(dotIdx + 1).toLowerCase() : null;
    const isAxis = dotSuffix && AXIS_SUFFIXES.has(dotSuffix);
    const parenMatch = nameNoExt.match(/^(.+?)\s*\(([^)]+)\)\s*$/);

    let videoBase, variantLabel;
    let isAmbiguousDotVariant = false;
    if (isAxis) {
      videoBase = normalizeName(nameNoExt.slice(0, dotIdx));
      variantLabel = null;
    } else if (parenMatch) {
      videoBase = normalizeName(parenMatch[1]);
      variantLabel = parenMatch[2].trim();
    } else if (dotSuffix && dotIdx > 0) {
      videoBase = normalizeName(nameNoExt.slice(0, dotIdx));
      variantLabel = dotSuffix;
      isAmbiguousDotVariant = true;
    } else {
      videoBase = normalizeName(nameNoExt);
      variantLabel = null;
    }

    funscriptList.push({
      name: filename,
      dir,
      videoBase,
      variantLabel,
      isAxis,
      axisSuffix: isAxis ? dotSuffix : null,
      isAmbiguousDotVariant,
      fullNormalisedBase: normalizeName(nameNoExt),
    });
  }

  // Post-pass: demote ambiguous dot-variants if no real sibling exists.
  const siblingBasesLocal = new Set();
  const siblingBasesGlobal = new Set();
  for (const fs of funscriptList) {
    if (fs.isAxis || fs.isAmbiguousDotVariant) continue;
    siblingBasesLocal.add(fs.dir + '\0' + fs.videoBase);
    siblingBasesGlobal.add(fs.videoBase);
  }
  for (const fs of funscriptList) {
    if (!fs.isAmbiguousDotVariant) continue;
    const localKey = fs.dir + '\0' + fs.videoBase;
    if (siblingBasesLocal.has(localKey) || siblingBasesGlobal.has(fs.videoBase)) {
      fs.isAmbiguousDotVariant = false;
      continue;
    }
    fs.videoBase = fs.fullNormalisedBase;
    fs.variantLabel = null;
    fs.isAmbiguousDotVariant = false;
  }

  return funscriptList;
}

describe('Funscript variant classifier — dot-disambiguation', () => {
  it('S01.E03.funscript with same-name video gets demoted to primary', () => {
    const result = classify(['S01.E03.funscript']);
    expect(result).toHaveLength(1);
    expect(result[0].videoBase).toBe('s01 e03');
    expect(result[0].variantLabel).toBe(null);
    expect(result[0].isAmbiguousDotVariant).toBe(false);
  });

  it('Title.2024.funscript is treated as primary (year-in-filename pattern)', () => {
    const result = classify(['Title.2024.funscript']);
    expect(result[0].videoBase).toBe('title 2024');
    expect(result[0].variantLabel).toBe(null);
  });

  it('Author.SceneName.funscript matches Author.SceneName.mp4', () => {
    const result = classify(['Author.SceneName.funscript']);
    expect(result[0].videoBase).toBe('author scenename');
    expect(result[0].variantLabel).toBe(null);
    // Sanity: same normalisation as the video would get
    expect(result[0].videoBase).toBe(normalizeName('Author.SceneName.mp4'.replace(/\.mp4$/i, '')));
  });

  it('foo.funscript + foo.intense.funscript: intense IS a real variant', () => {
    // When a sibling primary "foo.funscript" exists, "foo.intense" is
    // a legitimate variant — keep it classified as such.
    const result = classify(['foo.funscript', 'foo.intense.funscript']);
    const primary = result.find((r) => r.name === 'foo.funscript');
    const variant = result.find((r) => r.name === 'foo.intense.funscript');
    expect(primary.videoBase).toBe('foo');
    expect(primary.variantLabel).toBe(null);
    expect(variant.videoBase).toBe('foo');
    expect(variant.variantLabel).toBe('intense');
    expect(variant.isAmbiguousDotVariant).toBe(false); // demotion cleared the flag
  });

  it('foo.twist.funscript is always treated as axis (sacred)', () => {
    const result = classify(['foo.twist.funscript']);
    expect(result[0].isAxis).toBe(true);
    expect(result[0].axisSuffix).toBe('twist');
    expect(result[0].videoBase).toBe('foo');
  });

  it('parenthesized variant "Title (Soft).funscript" is unambiguous', () => {
    // Parens are explicit variant syntax — not affected by demotion path.
    const result = classify(['Title.funscript', 'Title (Soft).funscript']);
    const variant = result.find((r) => r.name === 'Title (Soft).funscript');
    expect(variant.variantLabel).toBe('Soft');
    expect(variant.videoBase).toBe('title');
  });

  it('parenthesized variant survives even when no primary exists', () => {
    const result = classify(['Title (Soft).funscript']);
    expect(result[0].variantLabel).toBe('Soft');
    expect(result[0].videoBase).toBe('title');
    expect(result[0].isAmbiguousDotVariant).toBe(false);
  });

  it('mixed: primary, variant, axis, dotted-filename all coexist correctly', () => {
    const result = classify([
      'S01.E03.funscript',          // dotted filename — should be primary
      'foo.funscript',              // bare primary
      'foo.intense.funscript',      // real variant of foo
      'foo.twist.funscript',        // axis of foo
      'bar.2024.funscript',         // another dotted filename — primary
    ]);
    const map = Object.fromEntries(result.map((r) => [r.name, r]));
    expect(map['S01.E03.funscript'].variantLabel).toBe(null);
    expect(map['S01.E03.funscript'].videoBase).toBe('s01 e03');
    expect(map['foo.funscript'].variantLabel).toBe(null);
    expect(map['foo.intense.funscript'].variantLabel).toBe('intense');
    expect(map['foo.twist.funscript'].isAxis).toBe(true);
    expect(map['bar.2024.funscript'].variantLabel).toBe(null);
    expect(map['bar.2024.funscript'].videoBase).toBe('bar 2024');
  });

  it('two dotted-filename siblings without a bare primary stay as primaries', () => {
    // "Series.E01.funscript" and "Series.E02.funscript" should both be
    // primaries (different episodes), not a primary + variant of "Series".
    const result = classify(['Series.E01.funscript', 'Series.E02.funscript']);
    expect(result[0].variantLabel).toBe(null);
    expect(result[1].variantLabel).toBe(null);
    expect(result[0].videoBase).toBe('series e01');
    expect(result[1].videoBase).toBe('series e02');
  });

  it('separate dirs WITHOUT a sibling primary anywhere → ambiguous variant gets demoted', () => {
    // Real production code uses both local AND global sibling sets, so
    // a primary anywhere in the library saves a variant from demotion.
    // When the only file in a scan is a dotted-name with no sibling at
    // all, it should be treated as a primary.
    const result = classify(['foo.intense.funscript'], '/B');
    expect(result[0].variantLabel).toBe(null);
    expect(result[0].videoBase).toBe('foo intense');
    expect(result[0].isAmbiguousDotVariant).toBe(false);
  });
});
