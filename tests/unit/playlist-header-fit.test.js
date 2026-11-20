/**
 * @vitest-environment jsdom
 * jsdom on purpose: playlists.css is parsed by jsdom, so the header's flex
 * rules below are the real stylesheet's (notes/CLAUDE.md "Test environments").
 */
// Found while FT-104 (also in v0.9.2): a playlist's detail header was one
// flex row that never wrapped, and `.playlists` hides what overflows. With
// Continue and Reset showing, at an 800 px window (1,000 px at 125%) the
// view toggle and the queue toggle sat 57-193 px past the right edge, out of
// reach, in en, fr, es, de and ru; FT-104's Select button adds one more. The
// header wraps now, the Library header's FT-099 rule
// (library-header-fit.test.js, whose model this is).
//
// jsdom has no layout, so the header is laid out by a small flexbox model fed
// by the REAL `flex-wrap` and gaps of playlists.css and by each control's
// width as Chromium lays it out: natural (a 1904 px viewport, no wrap) and
// smallest (a 284 px one, what flex-shrink takes it down to). Measured with
// the real player / library / nav-bar / modal / playlists / queue-panel /
// modern CSS on the header markup playlists.js renders, in a hidden Electron
// 41 window (2026-11-07, block E2): the same run showed every control inside
// the header at 800 and 1024 CSS px in 5 locales with the wrap, and the clip
// without it. The count is `flex: 1` (basis 0), so in a wrapping row it
// claims only its smallest width, as the model gives it.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';

const ALL = ['back', 'title', 'count', 'play-all', 'continue', 'reset', 'loop', 'shuffle', 'advanced', 'sort',
  'select', 'view-toggles', 'queue-toggle'];
// Natural and smallest widths with Continue and Reset showing (the order of ALL).
const MEASURED = {
  en: { nat: [40, 134, 34.1, 92.6, 100, 136.2, 36, 36, 36, 36, 66.1, 72, 36], min: [40, 72.2, 34.1, 92.6, 100, 136.2, 36, 36, 36, 36, 66.1, 72, 16] },
  de: { nat: [40, 134, 34.1, 131, 109.4, 186, 36, 36, 36, 36, 93.6, 72, 36], min: [40, 72.2, 34.1, 131, 109.4, 186, 36, 36, 36, 36, 93.6, 72, 16] },
  ru: { nat: [40, 134, 34.1, 164.9, 122.3, 163.1, 36, 36, 36, 36, 82.4, 72, 36], min: [40, 72.2, 34.1, 164.9, 122.3, 163.1, 36, 36, 36, 36, 82.4, 72, 16] },
  fr: { nat: [40, 134, 34.1, 95.5, 104.4, 115.2, 36, 36, 36, 36, 102.3, 72, 36], min: [40, 72.2, 34.1, 95.5, 104.4, 115.2, 36, 36, 36, 36, 102.3, 72, 16] },
  es: { nat: [40, 134, 34.1, 142.5, 104.4, 172.3, 36, 36, 36, 36, 97.9, 72, 36], min: [40, 72.2, 34.1, 142.5, 104.4, 172.3, 36, 36, 36, 36, 97.9, 72, 16] },
};
const ICON_BUTTONS = ['loop', 'shuffle', 'advanced', 'sort', 'queue-toggle'];

/** The header's controls without Continue and Reset (no progress yet). */
function withoutProgress({ nat, min }) {
  const keep = (_, i) => ALL[i] !== 'continue' && ALL[i] !== 'reset';
  return { names: ALL.filter((n) => n !== 'continue' && n !== 'reset'), nat: nat.filter(keep), min: min.filter(keep) };
}

let rules;

beforeAll(() => {
  const style = document.createElement('style');
  style.textContent = fs.readFileSync('renderer/styles/playlists.css', 'utf8');
  document.head.appendChild(style);
  document.body.innerHTML = '<div class="playlists"><div class="playlists__header"></div></div>';
  const cs = getComputedStyle(document.querySelector('.playlists__header'));
  const px = (v) => parseFloat(v) || 0;
  // Every rule for the header, in stylesheet order (the last one says wrap):
  // jsdom's cascade does not carry flex-wrap or the gaps, so they are read
  // from the rules' own text, the last declaration winning.
  const headerRules = [...style.sheet.cssRules].filter((r) => r.selectorText === '.playlists__header');
  const decl = (name) => {
    let value = cs.getPropertyValue(name) || '';
    for (const r of headerRules) {
      const v = r.style?.getPropertyValue(name);
      if (v) value = v;
    }
    return value;
  };
  const gap = [decl('column-gap'), decl('gap')].find((v) => v && v !== 'normal') || '';
  rules = {
    wrap: (decl('flex-wrap') || 'nowrap').trim(),
    columnGap: px(gap.split(' ').pop()),
    padX: px(decl('padding-left') || cs.getPropertyValue('padding-left'))
      + px(decl('padding-right') || cs.getPropertyValue('padding-right'))
      || 2 * px(String(decl('padding')).split(' ').pop()),
  };
});

/**
 * Lay the controls out in a header `cssWidth` wide, as flexbox does with these
 * rules. A wrapping row breaks a line before the control that does not fit at
 * its natural width; one that does not wrap shrinks every control toward its
 * smallest width and overflows by whatever is still too much.
 */
function layout({ names, nat, min }, cssWidth) {
  const avail = cssWidth - rules.padX;
  const boxes = [];
  if (rules.wrap === 'wrap') {
    let x = 0;
    let first = true;
    for (let i = 0; i < nat.length; i++) {
      if (!first && x + rules.columnGap + nat[i] > avail) { x = 0; first = true; }
      if (!first) x += rules.columnGap;
      boxes.push({ name: names[i], left: x, right: x + nat[i], width: nat[i] });
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
    boxes.push({ name: names[i], left: x, right: x + shrinkTo[i], width: shrinkTo[i] });
    x += shrinkTo[i];
  }
  return { avail, boxes };
}

describe('found while FT-104: every playlist header control stays inside the header', () => {
  for (const locale of Object.keys(MEASURED)) {
    for (const progress of [true, false]) {
      for (const cssWidth of [800, 1024, 1280]) {
        it(`${locale}${progress ? ' with Continue and Reset' : ''} at ${cssWidth} CSS px: nothing past the edge, no icon button squeezed`, () => {
          const set = progress ? { names: ALL, ...MEASURED[locale] } : withoutProgress(MEASURED[locale]);
          const { avail, boxes } = layout(set, cssWidth);
          expect(boxes.filter((b) => b.right > avail + 0.5).map((b) => b.name)).toEqual([]);
          expect(boxes.filter((b) => ICON_BUTTONS.includes(b.name) && b.width < 36).map((b) => b.name)).toEqual([]);
        });
      }
    }
  }

  it('the rules the model read are the stylesheet\'s (precondition: 12 px gap, 16 px side padding)', () => {
    expect(rules.columnGap).toBe(12);
    expect(rules.padX).toBe(32);
  });
});
