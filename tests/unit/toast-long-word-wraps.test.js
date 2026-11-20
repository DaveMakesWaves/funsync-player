/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL showToast builds the toast in a document with
 * the REAL player.css applied, so getComputedStyle reads the cascade the
 * toast text gets (notes/CLAUDE.md "Test environments").
 */
// verify-1 (2026-11-07, cosmetic): a toast whose text has no spaces (a long
// path or URL; the check used showToast('x'.repeat(200), 'error', 0)) ran
// past the right edge of its box, at 1280 and at 900 px wide, over the
// top-right panel button. The body is a flex item (flex: 1), whose min-width
// is auto: it could not shrink below the one long word, and nothing allowed
// a break inside it. jsdom lays nothing out, so what is asserted is the rule
// the toast text gets: it may shrink (min-width 0) and break anywhere.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import { showToast } from '../../renderer/js/toast.js';

const CSS = fs.readFileSync('renderer/styles/player.css', 'utf8');

beforeEach(() => {
  document.head.innerHTML = '';
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  document.body.innerHTML = '<div id="toast-container" class="toast-container"></div>';
});

describe('a toast with no spaces wraps inside its box', () => {
  it('the toast text may shrink and break inside a word', () => {
    showToast('x'.repeat(200), 'error', 0);
    const body = document.querySelector('.toast .toast__body');
    expect(body.textContent).toBe('x'.repeat(200));
    const style = getComputedStyle(body);
    expect(style.overflowWrap).toBe('anywhere');
    expect(style.minWidth).toBe('0px');
  });

  it('the box itself keeps its width cap', () => {
    showToast('C:\\Users\\someone\\Videos\\' + 'a'.repeat(120) + '.mp4', 'info', 0);
    expect(getComputedStyle(document.querySelector('.toast')).maxWidth).toBe('480px');
  });
});
