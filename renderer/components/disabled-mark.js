// The look of a disabled video (zaikechi #381: "It keeps it visible in the
// library and playlist (maybe grayed out?)"): the card or row dimmed, a
// "no entry" mark on its picture (inline before the title on a list row,
// which has no picture), and words for the hover and screen readers. One
// helper for the library, playlists and categories, so they look the same.
// renderer/js/disabled-videos.js holds the rule; this only paints.

import { icon, Ban } from '../js/icons.js';
import { t } from '../js/i18n.js';

const CLASS = 'is-disabled-video';
const MARK = 'disabled-mark';

/**
 * Paint `el` as disabled or not. `thumb` is the picture to badge (null on a
 * list row: the mark goes before `title` instead). Idempotent.
 */
export function applyDisabledMark(el, on, { thumb = null, title = null } = {}) {
  if (!el) return;
  el.classList.toggle(CLASS, !!on);
  const old = el.querySelector(`.${MARK}`);
  if (!on) {
    old?.remove();
    if (el.dataset.disabledVideo) {
      delete el.dataset.disabledVideo;
      el.removeAttribute('aria-description');
    }
    return;
  }
  el.dataset.disabledVideo = 'true';
  el.setAttribute('aria-description', t('library.disabled.cardDescription'));
  if (old) return;
  const mark = document.createElement('span');
  mark.className = MARK;
  mark.title = t('library.disabled.cardTitle');
  mark.appendChild(icon(Ban, { width: 14, height: 14, 'stroke-width': 2.5 }));
  if (thumb) {
    thumb.appendChild(mark);
  } else if (title?.parentNode) {
    mark.classList.add(`${MARK}--inline`);
    title.parentNode.insertBefore(mark, title);
  } else {
    el.appendChild(mark);
  }
}
