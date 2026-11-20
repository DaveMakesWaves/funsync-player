/**
 * @vitest-environment jsdom
 * jsdom on purpose: library.css is run through jsdom's cascade, so the
 * header's flex rules below are the real stylesheet's (notes/CLAUDE.md
 * "Test environments").
 */
// FT-099, the library-header half (the nav-bar half was CB-20): below about
// 1030 CSS px (an 800 px window, or a 1024 px one at 125%) the Library
// header's last controls (Select, the queue toggle; Refresh too in Russian)
// sat past its right edge, out of reach, and the icon buttons were squeezed
// to 16 px. The header was a flex row that never wrapped. It wraps now.
//
// jsdom has no layout, so the header is laid out here by a small flexbox
// model fed by the REAL computed `flex-wrap` and gaps from library.css, and
// by each control's width as Chromium lays it out: natural (unshrunk, from a
// 2560 px window) and smallest (what flex-shrink takes it down to). Both were
// measured with the real library.css + player.css + modern.css on the
// header markup library.js renders, in a hidden Electron 41 window
// (2026-11-07, block E1; the same run showed every control inside the header
// in 5 locales at 800 x 600, 1024 x 768 at 100 % and 125 %, and 1280 x 800 at
// 100 % and 125 %, and the clip before the change). The folder path's flex
// basis is 0 (flex: 1, min-width: 0), so it never forces a wrap.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';

const NAMES = ['title', 'dir-path', 'video-count', 'search', 'sort', 'filters', 'view-toggles',
  'folder', 'shuffle', 'play-options', 'refresh', 'select', 'queue-toggle'];
const MEASURED = {
  en: { nat: [48.9, 0, 64, 180, 67.5, 77.9, 72, 36, 36, 36, 36, 66.1, 36], min: [48.9, 0, 64, 180, 67.5, 77.9, 72, 16, 16, 16, 16, 66.1, 16] },
  de: { nat: [71.8, 0, 65.7, 180, 96.1, 72.4, 72, 36, 36, 36, 36, 93.6, 36], min: [71.8, 0, 65.7, 180, 96.1, 72.4, 72, 16, 16, 16, 16, 93.6, 16] },
  ru: { nat: [87.5, 0, 63, 180, 115.4, 96.6, 72, 36, 36, 36, 36, 82.4, 36], min: [87.5, 0, 63, 180, 115.4, 96.6, 72, 16, 16, 16, 16, 82.4, 16] },
};
const ICON_BUTTONS = ['folder', 'shuffle', 'play-options', 'refresh', 'queue-toggle'];

let rules;

beforeAll(() => {
  const style = document.createElement('style');
  style.textContent = fs.readFileSync('renderer/styles/library.css', 'utf8');
  document.head.appendChild(style);
  document.body.innerHTML = '<div class="library"><div class="library__header"></div></div>';
  const cs = getComputedStyle(document.querySelector('.library__header'));
  const px = (v) => parseFloat(v) || 0;
  // jsdom's cascade does not carry the gap properties; read them from the
  // header's own rule in the parsed stylesheet instead.
  const rule = [...style.sheet.cssRules].find((r) => r.selectorText === '.library__header');
  const fromText = (name) => {
    const text = String(rule?.cssText || '');
    const at = text.search(new RegExp(`(^|[;{\\s])${name}\\s*:`));
    if (at < 0) return '';
    const from = text.indexOf(':', at) + 1;
    return text.slice(from, text.indexOf(';', from)).trim();
  };
  const decl = (name) => cs.getPropertyValue(name) || rule?.style?.getPropertyValue(name) || fromText(name);
  // jsdom reports column-gap as 'normal' (its default) whatever `gap` says.
  const gap = [decl('column-gap'), decl('gap')].find((v) => v && v !== 'normal') || '';
  rules = {
    wrap: (decl('flex-wrap') || 'nowrap').trim(),
    columnGap: px(gap.split(' ').pop()),
    padX: px(cs.getPropertyValue('padding-left')) + px(cs.getPropertyValue('padding-right')),
  };
});

/**
 * Lay the controls out in a header `cssWidth` wide: every control's left and
 * right edge and its width, as flexbox does with these rules. A wrapping row
 * breaks a line before the control that does not fit at its natural width.
 * One that does not wrap shrinks every control toward its smallest width and
 * overflows by whatever is still too much.
 */
function layout({ nat, min }, cssWidth) {
  const avail = cssWidth - rules.padX;
  const boxes = [];
  if (rules.wrap === 'wrap') {
    let x = 0;
    let first = true;
    for (let i = 0; i < nat.length; i++) {
      if (!first && x + rules.columnGap + nat[i] > avail) { x = 0; first = true; }
      if (!first) x += rules.columnGap;
      boxes.push({ name: NAMES[i], left: x, right: x + nat[i], width: nat[i] });
      x += nat[i];
      first = false;
    }
    return { avail, boxes };
  }
  const gaps = rules.columnGap * (nat.length - 1);
  const natural = nat.reduce((a, b) => a + b, 0) + gaps;
  const shrinkTo = natural <= avail ? nat : min;
  let x = 0;
  for (let i = 0; i < shrinkTo.length; i++) {
    if (i) x += rules.columnGap;
    boxes.push({ name: NAMES[i], left: x, right: x + shrinkTo[i], width: shrinkTo[i] });
    x += shrinkTo[i];
  }
  return { avail, boxes };
}

describe('FT-099: every Library header control stays inside the header', () => {
  for (const locale of Object.keys(MEASURED)) {
    for (const cssWidth of [800, 819, 1024, 1280]) {
      it(`${locale} at ${cssWidth} CSS px: nothing past the edge, no icon button squeezed`, () => {
        const { avail, boxes } = layout(MEASURED[locale], cssWidth);
        const outside = boxes.filter((b) => b.right > avail + 0.5).map((b) => b.name);
        expect(outside).toEqual([]);
        const squeezed = boxes.filter((b) => ICON_BUTTONS.includes(b.name) && b.width < 36).map((b) => b.name);
        expect(squeezed).toEqual([]);
      });
    }
  }

  it('the rules the model read are the stylesheet\'s (precondition: 12 px gap, 16 px side padding)', () => {
    expect(rules.columnGap).toBe(12);
    expect(rules.padX).toBe(32);
  });
});
