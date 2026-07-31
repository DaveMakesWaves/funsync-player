// UpNextCard — view tests. Focus on setThumbnail(), the public frame-inject
// method the player pop-out uses (it streams the thumbnail from main rather
// than re-capturing it locally). Race guards mirror the internal loader.
import { describe, it, expect, beforeEach } from 'vitest';
import { UpNextCard } from '../../renderer/components/up-next-card.js';

const PATH = '/videos/next.mp4';
const DATA_URL = 'data:image/png;base64,AAAA';

function makeCard(overrides = {}) {
  const el = document.createElement('div');
  el.id = 'up-next-card';
  el.hidden = true;
  document.body.appendChild(el);
  const card = new UpNextCard({
    element: el,
    library: { getVideoByPath: () => ({ name: 'Next', duration: 60, hasFunscript: true }) },
    captureFrame: null, // pop-out mode: thumbnail arrives via setThumbnail
    ...overrides,
  });
  return { el, card };
}

describe('UpNextCard.setThumbnail', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('injects an <img> into the shown card for the matching path', () => {
    const { el, card } = makeCard();
    card.show(PATH, 10);
    expect(el.querySelector('.up-next__thumb-img')).toBeNull();

    card.setThumbnail(PATH, DATA_URL);

    const img = el.querySelector('.up-next__thumb-img');
    expect(img).not.toBeNull();
    expect(img.src).toContain('data:image/png');
  });

  it('ignores a thumbnail for a stale path (card moved on)', () => {
    const { el, card } = makeCard();
    card.show(PATH, 10);
    card.setThumbnail('/videos/OTHER.mp4', DATA_URL);
    expect(el.querySelector('.up-next__thumb-img')).toBeNull();
  });

  it('ignores a thumbnail once the card is hidden', () => {
    const { el, card } = makeCard();
    card.show(PATH, 10);
    card.hide();
    card.setThumbnail(PATH, DATA_URL);
    expect(el.querySelector('.up-next__thumb-img')).toBeNull();
  });

  it('does not double-inject when called twice', () => {
    const { el, card } = makeCard();
    card.show(PATH, 10);
    card.setThumbnail(PATH, DATA_URL);
    card.setThumbnail(PATH, DATA_URL);
    expect(el.querySelectorAll('.up-next__thumb-img')).toHaveLength(1);
  });

  it('is a no-op for a falsy data URL', () => {
    const { el, card } = makeCard();
    card.show(PATH, 10);
    card.setThumbnail(PATH, '');
    expect(el.querySelector('.up-next__thumb-img')).toBeNull();
  });
});
