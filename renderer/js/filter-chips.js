import { t } from './i18n.js';

// filter-chips — Active-filter chip strip with × to remove each one.
//
// Used by renderer/components/library.js (the desktop Library). The phone
// has its own chip code, backend/web-remote/filter-chips.js; this header used
// to say the phone used this one, which it never did (FT-063).
//
// Pure rendering helper. No DOM lookups, no global state. The host
// supplies:
//   * the chip container element
//   * the current filter state object (read via `state[key]`)
//   * a `defaults` map (`{ tab: 'all', vr: 'all' }`) that defines what
//     "no filter" means per key — values matching default are NOT shown
//   * a `labels` map (`{ tab: { matched: 'Matched' }, ... }`) for
//     value → human label per key
//   * an `iconFactory(name, size)` returning a DOM node for the X icon
//     (the host injects its Lucide icons)
//   * an `onRemove(key)` callback fired when a chip's × is clicked.
//     Host updates state, re-runs filters, and (optionally) re-renders
//     the chip strip. We don't auto-rerender — host owns the lifecycle.
//
// Returns nothing; mutates the container.
//
// See SCOPE-web-remote-redesign.md §3.2 (web-remote) and
// SCOPE-desktop-redesign.md §4.4 (desktop) for design rationale —
// Nielsen #6 recognition over recall + #8 minimalist design +
// Shneiderman #6 reversibility.

/**
 * @typedef {Object} FilterChipsOptions
 * @property {HTMLElement} container — where chips are rendered
 * @property {Record<string, string>} state — current filter values, keyed by filter id
 * @property {Record<string, string>} defaults — "no filter" value per key (chips hidden when value === default)
 * @property {Record<string, Record<string, string>>} labels — display labels: labels[key][value] = "Matched"
 * @property {(name: string, size: number) => Node} iconFactory — produces the X icon for the chip
 * @property {(key: string) => void} onRemove — callback when a chip's × is clicked
 * @property {string[]} [order] — optional render order of keys; defaults to Object.keys(defaults)
 * @property {Array<{key: string, label: string}>} [extra] — chips that are not
 *   one value per key (the library's Tags filter, 2026-11-18: one chip per
 *   selected tag, keyed `tag:<key>`). Rendered AFTER the keyed chips, in the
 *   order given, one chip each (a repeated or empty key is dropped); the ×
 *   calls `onRemove(chip.key)`. Without it the strip is exactly as before.
 */

/**
 * Render the active-filter chip strip into `container`. Empty state
 * (no active filters) clears the container and adds a `[hidden]`
 * attribute so its CSS can collapse the row.
 *
 * @param {FilterChipsOptions} opts
 * @returns {number} count of active filters rendered
 */
export function renderFilterChips(opts) {
  const { container, state, defaults, labels, iconFactory, onRemove, order, extra } = opts;
  if (!container) return 0;

  const keys = order || Object.keys(defaults);
  const active = [];
  for (const key of keys) {
    const value = state[key];
    if (value && value !== defaults[key]) {
      const label = labels[key]?.[value] || value;
      active.push({ key, label });
    }
  }
  active.push(...extraChips(extra, active));

  // Clear in-place. Empty container → host's CSS hides via [hidden].
  while (container.firstChild) container.removeChild(container.firstChild);
  if (active.length === 0) {
    container.hidden = true;
    return 0;
  }
  container.hidden = false;

  for (const { key, label } of active) {
    container.appendChild(_buildChip(key, label, iconFactory, onRemove));
  }
  return active.length;
}

/**
 * Count active filters without re-rendering — host uses this for the
 * "Filters [N]" badge.
 *
 * @param {Record<string, string>} state
 * @param {Record<string, string>} defaults
 * @param {Array<{key: string, label: string}>} [extra] — as renderFilterChips:
 *   each chip counts once, so the badge and the strip agree
 * @returns {number}
 */
export function countActiveFilters(state, defaults, extra) {
  let n = 0;
  const keyed = [];
  for (const key of Object.keys(defaults)) {
    if (state[key] && state[key] !== defaults[key]) {
      n++;
      keyed.push({ key });
    }
  }
  return n + extraChips(extra, keyed).length;
}

// The extra chips worth drawing: a string key and a label each, no key twice
// (nor one of the keyed chips' keys). The label falls back to the key.
function extraChips(extra, taken) {
  if (!Array.isArray(extra) || extra.length === 0) return [];
  const seen = new Set(taken.map((c) => c.key));
  const out = [];
  for (const chip of extra) {
    const key = chip?.key;
    if (typeof key !== 'string' || !key || seen.has(key)) continue;
    seen.add(key);
    const label = typeof chip.label === 'string' && chip.label ? chip.label : key;
    out.push({ key, label });
  }
  return out;
}

function _buildChip(key, label, iconFactory, onRemove) {
  const chip = document.createElement('button');
  chip.className = 'filter-chip';
  chip.type = 'button';
  chip.setAttribute('aria-label', t('filterChip.removeAria', { label }));
  chip.dataset.filterKey = key;

  const text = document.createElement('span');
  text.textContent = label;
  chip.appendChild(text);

  const close = document.createElement('span');
  close.className = 'filter-chip__close';
  close.appendChild(iconFactory('x', 12));
  chip.appendChild(close);

  chip.addEventListener('click', () => onRemove(key));
  return chip;
}
