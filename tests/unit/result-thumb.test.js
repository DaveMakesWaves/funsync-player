/**
 * @vitest-environment jsdom
 * Needs a DOM: builds a real <img> via document.createElement.
 * Do NOT switch this to `node` — see notes/CLAUDE.md "Test environments".
 */
// Shared EroScripts result thumbnail.
//
// Extracted so the standalone panel and the Associate-modal search use one
// implementation. The listener-before-src ordering is the load-bearing part
// and was a live bug (2026-08-05): a synchronous failure — CSP block,
// cached 404 — fires before a listener attached afterwards exists, leaving
// Chromium's broken-image glyph on screen permanently.
import { describe, it, expect } from 'vitest';
import { createResultThumb } from '../../renderer/components/result-thumb.js';

const THUMB = 'https://cdn.example/preview.jpeg';
const AVATAR = 'https://discuss.example/avatar/90.png';

describe('createResultThumb', () => {
  it('prefers the thumbnail', () => {
    const img = createResultThumb({ thumbnail: THUMB, avatar: AVATAR });
    expect(img.src).toBe(THUMB);
    expect(img.style.display).not.toBe('none');
  });

  it('uses the avatar when there is no thumbnail', () => {
    const img = createResultThumb({ thumbnail: null, avatar: AVATAR });
    expect(img.src).toBe(AVATAR);
  });

  it('attaches the error handler BEFORE assigning src', () => {
    // The regression. If the handler were attached afterwards, a
    // synchronously-failing src would never reach it.
    const img = createResultThumb({ thumbnail: THUMB, avatar: AVATAR });
    img.dispatchEvent(new Event('error'));
    expect(img.src).toBe(AVATAR);
    expect(img.style.display).not.toBe('none');
  });

  it('hides only after the avatar fails too', () => {
    const img = createResultThumb({ thumbnail: THUMB, avatar: AVATAR });
    img.dispatchEvent(new Event('error')); // thumbnail failed -> avatar
    img.dispatchEvent(new Event('error')); // avatar failed too
    expect(img.style.display).toBe('none');
  });

  it('hides immediately when a failing thumbnail has no avatar to fall back on', () => {
    const img = createResultThumb({ thumbnail: THUMB, avatar: null });
    img.dispatchEvent(new Event('error'));
    expect(img.style.display).toBe('none');
  });

  it('does not loop when the thumbnail and avatar are the same url', () => {
    const img = createResultThumb({ thumbnail: THUMB, avatar: THUMB });
    img.dispatchEvent(new Event('error'));
    expect(img.style.display).toBe('none');
  });

  it('hides when there is nothing to show at all', () => {
    const img = createResultThumb({ thumbnail: null, avatar: null });
    expect(img.style.display).toBe('none');
  });

  it('is decorative — the result title carries the meaning', () => {
    expect(createResultThumb({ thumbnail: THUMB, avatar: null }).alt).toBe('');
  });

  it('applies the caller class so panel and modal can size differently', () => {
    const img = createResultThumb({ thumbnail: THUMB, avatar: null, className: 'x__thumb' });
    expect(img.className).toBe('x__thumb');
  });
});
