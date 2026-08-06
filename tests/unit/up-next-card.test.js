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

// --- Resume choice row (playlists only; provider returns null elsewhere) ---

describe('UpNextCard resume choice', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('renders no resume row when the provider returns null', () => {
    // This is the library / category / no-saved-position case, i.e. the
    // card exactly as it was before the feature.
    const { el, card } = makeCard({ getResumeChoice: () => null });
    card.show(PATH, 10);
    expect(el.querySelector('.up-next__resume')).toBeNull();
  });

  it('renders no resume row when no provider is wired at all', () => {
    const { el, card } = makeCard();
    card.show(PATH, 10);
    expect(el.querySelector('.up-next__resume')).toBeNull();
  });

  it('renders both choices when a saved position exists', () => {
    const { el, card } = makeCard({ getResumeChoice: () => ({ label: '12:34' }) });
    card.show(PATH, 10);

    const btns = el.querySelectorAll('.up-next__resume-btn');
    expect(btns).toHaveLength(2);
    expect(btns[0].textContent).toContain('12:34');
    expect(btns[0].dataset.resume).toBe('resume');
    expect(btns[1].dataset.resume).toBe('start-over');
  });

  it('Resume plays next immediately, without waiting out the countdown', () => {
    let played = 0;
    const { el, card } = makeCard({
      getResumeChoice: () => ({ label: '12:34' }),
      onPlayNext: () => { played += 1; },
    });
    card.show(PATH, 10);
    el.querySelector('[data-resume="resume"]').click();
    expect(played).toBe(1);
  });

  it('Start over fires its own callback, not the plain play path', () => {
    let played = 0;
    let startedOver = 0;
    const { el, card } = makeCard({
      getResumeChoice: () => ({ label: '12:34' }),
      onPlayNext: () => { played += 1; },
      onStartOver: () => { startedOver += 1; },
    });
    card.show(PATH, 10);
    el.querySelector('[data-resume="start-over"]').click();
    expect(startedOver).toBe(1);
    expect(played).toBe(0);
  });

  it('a resume click does not also trigger the card-body play handler', () => {
    // The buttons sit outside .up-next__body, but a stray bubble would
    // double-fire the advance — guard it explicitly.
    let played = 0;
    const { el, card } = makeCard({
      getResumeChoice: () => ({ label: '12:34' }),
      onPlayNext: () => { played += 1; },
      onStartOver: () => {},
    });
    card.show(PATH, 10);
    el.querySelector('[data-resume="start-over"]').click();
    expect(played).toBe(0);
  });

  it('survives a throwing provider rather than blanking the card', () => {
    const { el, card } = makeCard({
      getResumeChoice: () => { throw new Error('settings unavailable'); },
    });
    expect(() => card.show(PATH, 10)).not.toThrow();
    expect(el.querySelector('.up-next__title')).not.toBeNull();
    expect(el.querySelector('.up-next__resume')).toBeNull();
  });

  it('omits the row in mini-player mode (deliberately minimal)', () => {
    const { el, card } = makeCard({ getResumeChoice: () => ({ label: '12:34' }) });
    card.setMini(true);
    card.show(PATH, 10);
    expect(el.querySelector('.up-next__resume')).toBeNull();
  });
});
