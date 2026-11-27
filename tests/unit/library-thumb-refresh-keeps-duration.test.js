/**
 * After "Upload thumbnail image" (or Reset) the card keeps its duration
 * badge (TODO triage 2026-11-23, cosmetic, also in v0.9.2): the refresh
 * removed the badge and an uploaded image carries no duration, so the
 * badge stayed gone until the next reload. When the reload makes its own
 * badge, that one stands (never two).
 * jsdom: DOM (notes/CLAUDE.md "Test environments").
 */
import { describe, it, expect } from 'vitest';
import { Library } from '../../renderer/components/library.js';

function card() {
  const el = document.createElement('div');
  el.innerHTML = '<div class="library__card-thumbnail"><img src="data:old"><span class="library__duration-badge">1:23</span></div>';
  return el;
}

describe('a thumbnail refresh', () => {
  it('an uploaded image (no duration with it): the badge comes back, after the new picture', async () => {
    const l = Object.create(Library.prototype);
    l._loadThumbnail = async (el) => {
      const img = document.createElement('img');
      img.src = 'data:new';
      el.querySelector('.library__card-thumbnail').appendChild(img);
    };
    const el = card();
    await l._refreshCardThumbnail('C:\\V\\a.mp4', el);
    const thumb = el.querySelector('.library__card-thumbnail');
    expect([...thumb.children].map((c) => c.tagName + (c.textContent || ''))).toEqual(['IMG', 'SPAN1:23']);
    expect(thumb.querySelector('img').getAttribute('src')).toBe('data:new');
  });

  it('a reload that makes its own badge: that one, never two', async () => {
    const l = Object.create(Library.prototype);
    l._loadThumbnail = async (el) => {
      const t = el.querySelector('.library__card-thumbnail');
      t.appendChild(document.createElement('img'));
      l._addDurationBadge(t, 95);
    };
    l._formatDuration = () => '1:35';
    const el = card();
    await l._refreshCardThumbnail('C:\\V\\a.mp4', el);
    const badges = el.querySelectorAll('.library__duration-badge');
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toBe('1:35');
  });
});
