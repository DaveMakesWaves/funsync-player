// filter-chips — Active-filter chip strip with × to remove each one.
//
// Used by:
//   - backend/web-remote/app.js (mobile)
//   - renderer/components/library.js (desktop, when wired in §4.4 of the
//     SCOPE-desktop-redesign doc)
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
//     (lets host inject Lucide on desktop and the web-remote's icons
//     module on mobile)
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
  const { container, state, defaults, labels, iconFactory, onRemove, order } = opts;
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
 * @returns {number}
 */
export function countActiveFilters(state, defaults) {
  let n = 0;
  for (const key of Object.keys(defaults)) {
    if (state[key] && state[key] !== defaults[key]) n++;
  }
  return n;
}

function _buildChip(key, label, iconFactory, onRemove) {
  const chip = document.createElement('button');
  chip.className = 'filter-chip';
  chip.type = 'button';
  chip.setAttribute('aria-label', `Remove filter: ${label}`);
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
