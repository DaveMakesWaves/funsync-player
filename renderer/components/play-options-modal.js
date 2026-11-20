// Play options dialog body — the playlist "Advanced playlist settings" rows
// ("Give every script an equal turn", "Prefer unwatched"), shared with the
// Library / Categories play options (zaikechi #381) so the two dialogs say
// the same thing in the same words (playlists.advanced.* strings). The
// Library version adds a Loop row first: a playlist has its own Loop button
// in its header, the library and categories do not.

import { Modal } from './modal.js';
import { t } from '../js/i18n.js';

/**
 * Build the options section.
 *
 * @param {object} opts
 * @param {{loop?: boolean, balanceByScript?: boolean, preferUnwatched?: boolean}} opts.values
 * @param {boolean} [opts.shuffleOn=true] false disables the two shuffle-only
 *   options and says why (a playlist with Shuffle off): they have no effect
 *   on a fixed order, and a toggle that silently does nothing is worse than
 *   one you can't press.
 * @param {boolean} [opts.includeLoop=false] a Loop row first.
 * @param {string|null} [opts.note] replaces the Shuffle on/off note.
 * @param {(key: 'loop'|'balanceByScript'|'preferUnwatched', on: boolean) => void} opts.onChange
 * @returns {HTMLElement}
 */
export function buildPlayOptionsSection({ values = {}, shuffleOn = true, includeLoop = false, note = null, onChange }) {
  const section = document.createElement('div');
  section.className = 'playlists__advanced-option';

  const addRow = (key, labelKey, { disabled = false, spaced = false } = {}) => {
    const row = document.createElement('label');
    row.className = 'playlists__advanced-row';
    if (spaced) row.style.marginTop = '14px';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.dataset.option = key;
    check.checked = !!values[key];
    check.disabled = disabled;
    const label = document.createElement('span');
    label.className = 'playlists__advanced-label';
    label.textContent = t(labelKey);
    row.appendChild(check);
    row.appendChild(label);
    section.appendChild(row);
    check.addEventListener('change', () => { if (onChange) onChange(key, check.checked); });
    return check;
  };
  const addText = (cls, text) => {
    const p = document.createElement('p');
    p.className = cls;
    p.textContent = text;
    section.appendChild(p);
  };

  // --- Loop (Library / Categories only) ---
  if (includeLoop) {
    addRow('loop', 'library.playOptions.loopLabel');
    addText('playlists__advanced-desc', t('library.playOptions.loopWhy'));
  }

  // --- Balance by script ---
  addRow('balanceByScript', 'playlists.advanced.balanceLabel', { disabled: !shuffleOn, spaced: includeLoop });
  // Plain-language explanation. Two short paragraphs: what goes wrong
  // without it, then what it does about it.
  addText('playlists__advanced-desc', t('playlists.advanced.balanceWhy'));
  addText('playlists__advanced-desc', t('playlists.advanced.balanceHow'));
  addText('playlists__advanced-note', note || (shuffleOn
    ? t('playlists.advanced.balanceNeedsShuffleOn')
    : t('playlists.advanced.balanceNeedsShuffleOff')));

  // --- Prefer unwatched ---
  // Same shuffle-only gating as balance above, for the same reason: it has
  // no meaning on a fixed order.
  addRow('preferUnwatched', 'playlists.advanced.unwatchedLabel', { disabled: !shuffleOn, spaced: true });
  addText('playlists__advanced-desc', t('playlists.advanced.unwatchedWhy'));

  return section;
}

/** The section in a Modal with a Close button. Resolves when it closes. */
export function openPlayOptionsModal({ title, ...sectionOpts }) {
  return Modal.open({
    title,
    onRender: (body, close) => {
      body.appendChild(buildPlayOptionsSection(sectionOpts));
      const done = document.createElement('button');
      done.type = 'button';
      done.className = 'library__assoc-save-btn';
      done.style.marginTop = '12px';
      done.textContent = t('common.close');
      done.addEventListener('click', () => close(null));
      body.appendChild(done);
    },
  });
}
