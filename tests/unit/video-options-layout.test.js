/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The video options dialog's layout rules (renderer/styles/video-options.css),
// fixup-ui 2026-11-18. jsdom lays nothing out, so these read the rules the
// stylesheet gives; the rendered result was checked by screenshots at
// Interface size 100 / 140 / 175 / 200 % (the fixup-ui report).
//
// verify-1: below 620 CSS px (Interface size 140% and up at the 800 px window
// minimum) the wide layout's fixed rows left the section 0-137 px tall: the
// rail wrapped to two rows, the header grew, and the body never scrolls.
// Also: tag chip names and the post line inherited the page's 16 px, and the
// toast sat over the dialog's lower edge.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const CSS = fs.readFileSync('renderer/styles/video-options.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The text inside the first `@media (<query>) { … }` block. */
function mediaBlock(query) {
  const at = CSS.indexOf(`@media (${query})`);
  if (at < 0) return '';
  let i = CSS.indexOf('{', at) + 1;
  const start = i;
  for (let depth = 1; depth > 0 && i < CSS.length; i++) {
    if (CSS[i] === '{') depth++;
    else if (CSS[i] === '}') depth--;
  }
  return CSS.slice(start, i - 1);
}

/** Declarations of `selector` in `text` (top-level rules only), merged. */
function decls(text, selector) {
  const out = {};
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(text))) {
    const sels = m[1].split(',').map((s) => s.trim());
    if (!sels.includes(selector)) continue;
    for (const d of m[2].split(';')) {
      const k = d.indexOf(':');
      if (k > 0) out[d.slice(0, k).trim()] = d.slice(k + 1).trim();
    }
  }
  return out;
}

const topLevel = () => {
  // Drop every @media / @keyframes block, keep the plain rules.
  let s = CSS;
  for (;;) {
    const at = s.search(/@(media|keyframes)[^{]*\{/);
    if (at < 0) return s;
    let i = s.indexOf('{', at) + 1;
    for (let depth = 1; depth > 0 && i < s.length; i++) {
      if (s[i] === '{') depth++;
      else if (s[i] === '}') depth--;
    }
    s = s.slice(0, at) + s.slice(i);
  }
};

describe('below 620 px the dialog stays usable (verify-1 fail 2)', () => {
  const narrow = mediaBlock('max-width: 620px');

  it('the body scrolls and the section keeps its full height (no inner scroll box to squeeze)', () => {
    expect(decls(narrow, '.modal-panel--video-options .modal-body.video-options')).toMatchObject({ 'overflow-y': 'auto', display: 'block' });
    expect(decls(narrow, '.video-options__layout')).toMatchObject({ display: 'block' });
    expect(decls(narrow, '.video-options__content')).toMatchObject({ overflow: 'visible' });
  });

  it('the rail is one row that scrolls sideways and stays at the top; the live line (Undo) stays at the bottom', () => {
    expect(decls(narrow, '.video-options__rail')).toMatchObject({
      position: 'sticky', top: '0', 'flex-direction': 'row', 'flex-wrap': 'nowrap', 'overflow-x': 'auto',
    });
    expect(decls(narrow, '.video-options__rail-item')).toMatchObject({ flex: 'none', 'white-space': 'nowrap' });
    expect(decls(narrow, '.video-options__live')).toMatchObject({ position: 'sticky', bottom: '0' });
    // Sticky needs something to cover what scrolls under it.
    expect(decls(narrow, '.video-options__rail').background).toBe('var(--surface-card)');
    expect(decls(narrow, '.video-options__live').background).toBe('var(--surface-card)');
    // A line that has said nothing yet takes no room at the foot.
    expect(decls(narrow, '.video-options__live--empty')).toMatchObject({ 'min-height': '0', padding: '0', 'border-top': 'none' });
  });

  it('the header compacts and the dialog takes the window\'s height less a small margin', () => {
    expect(decls(narrow, '.video-options__thumb')).toMatchObject({ width: '96px', height: '54px' });
    expect(decls(narrow, '.modal-panel.modal-panel--video-options')).toMatchObject({ 'min-width': '0', height: 'min(600px, calc(100vh - 24px))' });
    expect(decls(mediaBlock('max-width: 480px'), '.video-options__thumb')).toMatchObject({ display: 'none' });
  });
});

describe('short windows get the compact layout too (verify-2 fail)', () => {
  // 1280 x 800 at 175 / 200 % is 731 x 457 / 640 x 400 CSS px: wide, but the
  // wide layout left the section 95 / 36 px. 571 px tall still leaves it
  // about 200 px (verify-2 measured 209 at 914 x 571), so the compact layout
  // takes over below that.
  it('the compact block applies below 621 px wide OR below 571 px tall', () => {
    expect(CSS).toContain('@media (max-width: 620px), (max-height: 570px) {');
    expect(decls(mediaBlock('max-width: 620px), (max-height: 570px'), '.modal-panel--video-options .modal-body.video-options'))
      .toMatchObject({ 'overflow-y': 'auto' });
  });
});

describe('the theme and Locate (followUp3)', () => {
  const plain = topLevel();
  it('native scroll bars in the dialog follow the theme', () => {
    expect(decls(plain, 'html[data-theme="dark"] .modal-panel--video-options')).toMatchObject({ 'color-scheme': 'dark' });
    expect(decls(plain, 'html[data-theme="light"] .modal-panel--video-options')).toMatchObject({ 'color-scheme': 'light' });
  });
  it('"Script not found" as a control looks like one (underline, a focus ring), and a missing card badge is red', () => {
    expect(decls(plain, '.video-options__locate')).toMatchObject({ 'text-decoration': 'underline', cursor: 'pointer' });
    expect(decls(plain, '.video-options__locate:focus-visible').outline).toBe('2px solid var(--accent)');
    expect(decls(plain, '.library__funscript-badge--missing').color).toBe('var(--state-error)');
  });
  it('a grid card\'s red badge takes the click (its row is click-through, so it fell to the play overlay: verify-3)', () => {
    const lib = fs.readFileSync('renderer/styles/library.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    // The premise: the row is click-through and stacked above the overlay.
    expect(decls(lib, '.library__card-badges')).toMatchObject({ 'pointer-events': 'none', 'z-index': '1' });
    expect(decls(lib, '.library__card-overlay')['z-index']).toBeUndefined();
    // Only the missing badge opts back in.
    expect(decls(plain, '.library__card-badges .library__funscript-badge--missing')).toMatchObject({ 'pointer-events': 'auto' });
  });
});

describe('cosmetics (verify-1)', () => {
  const plain = topLevel();

  it('the Tags section is 13 px like the rest of the dialog (chip names, the post line)', () => {
    expect(decls(plain, '.video-options-tags')['font-size']).toBe('13px');
    // Nothing in it sets a bigger size of its own.
    for (const sel of ['.video-options-tags__chip', '.video-options-tags__chip-label', '.video-options-tags__post']) {
      expect(decls(plain, sel)['font-size'], sel).toBeUndefined();
    }
  });

  it('toasts sit in a band under the dialog while it is open, not over its edge', () => {
    // 60 px under the centred dialog (120 / 2); a toast with its Undo is 48 px tall, 8 px up.
    expect(decls(plain, '.modal-panel.modal-panel--video-options').height).toBe('min(600px, calc(100vh - 120px))');
    expect(decls(plain, 'body.video-options-open .toast-container')).toMatchObject({ bottom: '8px' });
    // A short narrow dialog has no band: the toast goes to the top there.
    expect(decls(mediaBlock('max-width: 620px'), 'body.video-options-open .toast-container')).toMatchObject({ top: '4px', bottom: 'auto' });
  });
});
