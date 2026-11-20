/**
 * @vitest-environment jsdom
 * jsdom: renderFilterChips builds real buttons (notes/CLAUDE.md "Test
 * environments").
 */
// filter-chips.js held one value per key; the library's Tags filter needs
// one chip per selected tag (keyed `tag:<key>`, Round 3, 2026-11-18). The
// extension is an optional `extra` list. Pinned: the old chips come out
// exactly as before (with or without an empty `extra`), the extra chips
// follow them one each, a repeated key draws once, the × names the chip's
// key, the badge count agrees with the strip, and a label is text only.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderFilterChips, countActiveFilters } from '../../renderer/js/filter-chips.js';

const DEFAULTS = { tab: 'all', vr: 'all' };
const LABELS = {
  tab: { matched: 'Matched', unmatched: 'Unmatched' },
  vr: { vr: 'VR only', flat: 'Non-VR' },
};
const icons = () => (name, size) => {
  const el = document.createElement('span');
  el.dataset.icon = name;
  el.dataset.size = String(size);
  return el;
};

let container;
beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
});

function render(extra, state = { tab: 'matched', vr: 'vr' }, onRemove = vi.fn()) {
  const opts = { container, state, defaults: DEFAULTS, labels: LABELS, iconFactory: icons(), onRemove };
  if (extra !== undefined) opts.extra = extra;
  return renderFilterChips(opts);
}

describe('the old chips are unchanged', () => {
  it('no extra and an empty extra draw byte-identical strips', () => {
    expect(render(undefined)).toBe(2);
    const before = container.innerHTML;
    expect(render([])).toBe(2);
    expect(container.innerHTML).toBe(before);
    expect(render(null)).toBe(2);
    expect(container.innerHTML).toBe(before);
    expect([...container.children].map((c) => c.dataset.filterKey)).toEqual(['tab', 'vr']);
  });

  it('countActiveFilters without extra counts as before', () => {
    expect(countActiveFilters({ tab: 'matched', vr: 'all' }, DEFAULTS)).toBe(1);
    expect(countActiveFilters({ tab: 'all', vr: 'all' }, DEFAULTS, [])).toBe(0);
  });
});

describe('extra chips: one per selected value', () => {
  const EXTRA = [
    { key: 'tag:device:the-handy', label: 'Device: the handy' },
    { key: 'tag:content:pov', label: 'Content: pov' },
    { key: 'category:c1', label: 'Category: Faves' },
  ];

  it('follow the keyed chips, in the order given, each with its own key and aria-label', () => {
    expect(render(EXTRA)).toBe(5);
    expect([...container.children].map((c) => c.dataset.filterKey))
      .toEqual(['tab', 'vr', 'tag:device:the-handy', 'tag:content:pov', 'category:c1']);
    expect(container.children[2].getAttribute('aria-label')).toBe('Remove filter: Device: the handy');
    expect(container.children[2].querySelector('[data-icon="x"]')).toBeTruthy();
    expect(container.hidden).toBe(false);
  });

  it('show on their own when no keyed filter is on', () => {
    expect(render(EXTRA.slice(0, 1), { tab: 'all', vr: 'all' })).toBe(1);
    expect(container.hidden).toBe(false);
    expect(container.children[0].dataset.filterKey).toBe('tag:device:the-handy');
  });

  it('the × of an extra chip calls onRemove with that chip\'s key', () => {
    const onRemove = vi.fn();
    render(EXTRA, undefined, onRemove);
    container.children[3].click();
    expect(onRemove).toHaveBeenCalledWith('tag:content:pov');
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('a repeated key, a keyed chip\'s key, an empty or non-string key draw nothing', () => {
    const n = render([
      { key: 'tag:content:pov', label: 'Content: pov' },
      { key: 'tag:content:pov', label: 'again' },
      { key: 'tab', label: 'clash' },
      { key: '', label: 'empty' },
      { key: 7, label: 'number' },
      null,
    ]);
    expect(n).toBe(3);
    expect([...container.children].map((c) => c.dataset.filterKey)).toEqual(['tab', 'vr', 'tag:content:pov']);
  });

  it('the badge count agrees with the strip, one per chip', () => {
    const extra = [...EXTRA, { key: 'tag:content:pov', label: 'dup' }];
    const drawn = render(extra);
    expect(countActiveFilters({ tab: 'matched', vr: 'vr' }, DEFAULTS, extra)).toBe(drawn);
    expect(countActiveFilters({ tab: 'all', vr: 'all' }, DEFAULTS, EXTRA)).toBe(3);
  });

  it('a label is text: a tag named like markup stays text', () => {
    render([{ key: 'tag:content:x', label: '<img src=x onerror=alert(1)>' }], { tab: 'all', vr: 'all' });
    expect(container.querySelector('img')).toBeNull();
    expect(container.children[0].textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('a chip without a label shows its key', () => {
    render([{ key: 'source:user' }], { tab: 'all', vr: 'all' });
    expect(container.children[0].textContent).toContain('source:user');
  });
});
