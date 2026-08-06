// Resume progress bar — the thin "how far you got" strip along the bottom
// of a thumbnail (the Netflix / YouTube convention).
//
// Rendered INSIDE the thumbnail, absolutely positioned, so it costs zero
// layout: a card with a bar and a card without stay exactly the same height.
// That's the difference from the card heatmap, which needs its own row and
// therefore has to be uniform across the grid.
//
// Community request, EroScripts 2026-08-05.

import { resumeProgressFraction } from '../js/resume-position.js';
import { t } from '../js/i18n.js';

/**
 * Build the bar, or return null when there's nothing to show — callers
 * append only on a truthy result, so "no entry" renders no element at all.
 *
 * @param {{position: number, duration?: number}|null} entry
 * @param {number} [duration] live duration, preferred over the stored one
 * @returns {HTMLElement|null}
 */
export function createResumeBar(entry, duration, { inline = false } = {}) {
  const frac = resumeProgressFraction(entry, duration);
  if (frac <= 0) return null;

  const percent = Math.round(frac * 100);

  const wrap = document.createElement('div');
  // Inline variant flows in normal layout, for list rows that have no
  // thumbnail to overlay. Same fill, different positioning.
  wrap.className = inline ? 'resume-bar resume-bar--inline' : 'resume-bar';
  // Decorative duplicate of information already available from the card,
  // but a screen reader has no other way to reach it, so label it.
  wrap.setAttribute('role', 'img');
  wrap.setAttribute('aria-label', t('resume.progressLabel', { percent }));

  const fill = document.createElement('div');
  fill.className = 'resume-bar__fill';
  fill.style.width = `${percent}%`;
  wrap.appendChild(fill);

  return wrap;
}

/**
 * Attach to a thumbnail element, replacing any bar already there so a
 * re-render (or a returning viewer) doesn't stack two.
 */
export function applyResumeBar(thumbnailEl, entry, duration) {
  if (!thumbnailEl) return null;
  const existing = thumbnailEl.querySelector(':scope > .resume-bar');
  if (existing) existing.remove();
  const bar = createResumeBar(entry, duration);
  if (bar) thumbnailEl.appendChild(bar);
  return bar;
}
