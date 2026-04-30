// Tests for filter-chips — the shared chip-strip helper used by both
// web-remote (mobile) and (planned) desktop library. The interesting
// behaviours to pin:
//
//   1. countActiveFilters skips defaults; counts non-default values.
//   2. renderFilterChips clears + repopulates the container; hides
//      it when no chips active.
//   3. Each chip has accessible label + dataset key + X click triggers
//      onRemove with the right key.
//   4. iconFactory is called per chip — host swappable.
//   5. Custom render order via `order` param.

import { describe, it, expect, vi } from 'vitest';
import { renderFilterChips, countActiveFilters } from '../../renderer/js/filter-chips.js';

const DEFAULTS = { tab: 'all', vr: 'all' };
const LABELS = {
  tab: { matched: 'Matched', unmatched: 'Unmatched' },
  vr:  { vr: 'VR only', flat: 'Non-VR' },
};

function fakeIconFactory() {
  // Host-supplied — return a span we can detect in assertions.
  return (name, size) => {
    const el = document.createElement('span');
    el.dataset.icon = name;
    el.dataset.size = String(size);
    return el;
  };
}

function makeContainer() {
  const c = document.createElement('div');
  c.className = 'filter-chips';
  document.body.appendChild(c);
  return c;
}

describe('countActiveFilters', () => {
  it('returns 0 when all filters are at default', () => {
    expect(countActiveFilters({ tab: 'all', vr: 'all' }, DEFAULTS)).toBe(0);
  });

  it('counts each non-default filter', () => {
    expect(countActiveFilters({ tab: 'matched', vr: 'all' }, DEFAULTS)).toBe(1);
    expect(countActiveFilters({ tab: 'matched', vr: 'vr' }, DEFAULTS)).toBe(2);
  });

  it('treats empty / undefined as default', () => {
    expect(countActiveFilters({}, DEFAULTS)).toBe(0);
    expect(countActiveFilters({ tab: undefined, vr: '' }, DEFAULTS)).toBe(0);
  });
});

describe('renderFilterChips', () => {
  it('hides container and renders nothing when no filters active', () => {
    const c = makeContainer();
    const onRemove = vi.fn();
    const n = renderFilterChips({
      container: c, state: { tab: 'all', vr: 'all' },
      defaults: DEFAULTS, labels: LABELS,
      iconFactory: fakeIconFactory(), onRemove,
    });
    expect(n).toBe(0);
    expect(c.children.length).toBe(0);
    expect(c.hidden).toBe(true);
  });

  it('shows one chip per non-default filter, with the right label', () => {
    const c = makeContainer();
    renderFilterChips({
      container: c,
      state: { tab: 'matched', vr: 'vr' },
      defaults: DEFAULTS, labels: LABELS,
      iconFactory: fakeIconFactory(), onRemove: () => {},
    });
    expect(c.hidden).toBe(false);
    expect(c.children.length).toBe(2);
    expect(c.children[0].textContent).toContain('Matched');
    expect(c.children[1].textContent).toContain('VR only');
  });

  it('chip has aria-label, data-filter-key, and an X icon from the factory', () => {
    const c = makeContainer();
    const factory = fakeIconFactory();
    renderFilterChips({
      container: c,
      state: { tab: 'matched', vr: 'all' },
      defaults: DEFAULTS, labels: LABELS,
      iconFactory: factory, onRemove: () => {},
    });
    const chip = c.children[0];
    expect(chip.getAttribute('aria-label')).toBe('Remove filter: Matched');
    expect(chip.dataset.filterKey).toBe('tab');
    const xIcon = chip.querySelector('[data-icon="x"]');
    expect(xIcon).toBeTruthy();
  });

  it('clicking the chip fires onRemove with the right key', () => {
    const c = makeContainer();
    const onRemove = vi.fn();
    renderFilterChips({
      container: c,
      state: { tab: 'matched', vr: 'vr' },
      defaults: DEFAULTS, labels: LABELS,
      iconFactory: fakeIconFactory(), onRemove,
    });
    c.children[1].click();
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith('vr');
  });

  it('honours custom `order` of filter keys', () => {
    const c = makeContainer();
    renderFilterChips({
      container: c,
      state: { tab: 'matched', vr: 'vr' },
      defaults: DEFAULTS, labels: LABELS,
      iconFactory: fakeIconFactory(), onRemove: () => {},
      order: ['vr', 'tab'],
    });
    expect(c.children[0].textContent).toContain('VR only');
    expect(c.children[1].textContent).toContain('Matched');
  });

  it('falls back to the raw value when no label is provided', () => {
    const c = makeContainer();
    renderFilterChips({
      container: c,
      state: { tab: 'unknownValue', vr: 'all' },
      defaults: DEFAULTS, labels: LABELS,
      iconFactory: fakeIconFactory(), onRemove: () => {},
    });
    expect(c.children[0].textContent).toContain('unknownValue');
  });

  it('clears prior chips before rendering new ones (no stale chips left)', () => {
    const c = makeContainer();
    // First render: 2 active filters
    renderFilterChips({
      container: c, state: { tab: 'matched', vr: 'vr' },
      defaults: DEFAULTS, labels: LABELS,
      iconFactory: fakeIconFactory(), onRemove: () => {},
    });
    expect(c.children.length).toBe(2);
    // Second render: one filter cleared
    renderFilterChips({
      container: c, state: { tab: 'matched', vr: 'all' },
      defaults: DEFAULTS, labels: LABELS,
      iconFactory: fakeIconFactory(), onRemove: () => {},
    });
    expect(c.children.length).toBe(1);
    expect(c.children[0].textContent).toContain('Matched');
  });
});
