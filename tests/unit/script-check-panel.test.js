/**
 * @vitest-environment jsdom
 * jsdom: a real dialog (Modal.open) in a real document, clicked like a user
 * would (notes/CLAUDE.md "Test environments").
 */
// The Check script dialog (editor work list 4.2, 2026-11-24): a summary per
// kind with counts, "All good" when there is nothing, rows that jump (and
// select that finding's points), "Select all N" per kind, and no action on
// stale indices when the script changed while it was open.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// lucide does not resolve in vitest (same mock as modal.test.js).
vi.mock('../../renderer/js/icons.js', () => ({
  icon: () => document.createElement('span'),
  X: [],
}));

import { openScriptCheck, findingText, ROW_LIMIT } from '../../renderer/components/script-check-panel.js';
import { _setBundlesForTests, _resetForTests } from '../../renderer/js/i18n.js';
import { withEditorToolsStrings } from './helpers/editor-tools-strings.js';

const EN = withEditorToolsStrings(JSON.parse(readFileSync('renderer/locales/en.json', 'utf8')));
const pts = (...pairs) => pairs.map(([at, pos]) => ({ at, pos }));
const dialog = () => document.querySelector('.modal-overlay .script-check');
const groupEl = (kind) => dialog().querySelector(`.script-check__group[data-kind="${kind}"]`);

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  document.body.innerHTML = '<div id="app"></div><div id="toast-container"></div>';
});
afterEach(() => {
  document.querySelectorAll('.modal-overlay').forEach((el) => el.remove());
  _resetForTests();
});

describe('openScriptCheck', () => {
  it('says "All good" with the number of points checked when there is nothing to fix', async () => {
    const done = openScriptCheck({ actions: pts([0, 0], [500, 100], [1000, 0]) });
    expect(dialog().querySelector('.script-check__empty-title').textContent).toBe('All good');
    expect(dialog().querySelector('.script-check__empty-hint').textContent).toBe('Checked 3 points, nothing to fix.');
    expect(dialog().querySelectorAll('.script-check__group')).toHaveLength(0);
    dialog().querySelector('.script-check__done').click();
    await expect(done).resolves.toBeNull();
    expect(document.querySelector('.modal-overlay')).toBeNull();
  });

  it('an empty script says there is nothing to check', () => {
    openScriptCheck({ actions: [] });
    expect(dialog().querySelector('.script-check__empty-title').textContent).toBe('No points to check');
  });

  it('a summary, then one section per kind with its count, its limit and its rows', () => {
    // 0→100 in 200 ms twice = 500 units/s; a moving 0→20 over 1 s = 20 units/s.
    openScriptCheck({
      actions: pts([0, 0], [200, 100], [400, 0], [1400, 20]),
      limits: { max: 400, min: 33 },
    });
    expect(dialog().querySelector('.script-check__summary').textContent).toBe('3 problems found');
    const fast = groupEl('tooFast');
    expect(fast.querySelector('.script-check__group-name').textContent).toBe('Faster than 400 units/s');
    expect(fast.querySelector('.script-check__count').textContent).toBe('2');
    const rows = [...fast.querySelectorAll('.script-check__row')].map((r) => r.textContent);
    expect(rows).toEqual(['00:00.000500 units/s', '00:00.200500 units/s']);
    expect(fast.querySelector('.script-check__select-all').textContent).toBe('Select all 3 points');
    expect(groupEl('tooSlow').querySelector('.script-check__group-name').textContent).toBe('Slower than 33 units/s');
    expect(groupEl('tooSlow').querySelector('.script-check__select-all').textContent).toBe('Select all 2 points');
  });

  it('the limits it is given are the ones it checks against', () => {
    openScriptCheck({ actions: pts([0, 0], [200, 100]), limits: { max: 600, min: 0 } });
    expect(dialog().querySelector('.script-check__empty-title').textContent).toBe('All good');
  });

  it('a row jumps to its time and selects that finding\'s points, then closes', async () => {
    const onJump = vi.fn();
    const onSelect = vi.fn();
    const done = openScriptCheck({ actions: pts([0, 0], [500, 100], [700, 0]), onJump, onSelect });
    groupEl('tooFast').querySelector('.script-check__row').click();
    await expect(done).resolves.toEqual({ action: 'jump', at: 500, indices: [1, 2], kind: 'tooFast' });
    expect(onJump).toHaveBeenCalledWith(500);
    expect(onSelect).toHaveBeenCalledWith([1, 2]);
    expect(document.querySelector('.modal-overlay')).toBeNull();
  });

  it('"Select all" selects every point of that kind once and does not jump', async () => {
    const onJump = vi.fn();
    const onSelect = vi.fn();
    const done = openScriptCheck({ actions: pts([0, 0], [200, 100], [400, 0], [600, 100]), onJump, onSelect });
    groupEl('tooFast').querySelector('.script-check__select-all').click();
    await done;
    expect(onSelect).toHaveBeenCalledWith([0, 1, 2, 3]);
    expect(onJump).not.toHaveBeenCalled();
  });

  it('a long list shows the first rows and says how many more Select all takes', async () => {
    const many = [];
    for (let i = 0; i <= ROW_LIMIT + 5; i++) many.push({ at: i * 100, pos: i % 2 ? 100 : 0 }); // 1000 units/s each
    const onSelect = vi.fn();
    const done = openScriptCheck({ actions: many, onSelect });
    const g = groupEl('tooFast');
    expect(g.querySelectorAll('.script-check__row')).toHaveLength(ROW_LIMIT);
    expect(g.querySelector('.script-check__more').textContent).toBe('…and 5 more, included in the selection above.');
    g.querySelector('.script-check__select-all').click();
    await done;
    expect(onSelect.mock.calls[0][0]).toHaveLength(many.length);
  });

  it('when the script changed while it was open, a click checks again instead of acting on old indices', async () => {
    let live = pts([0, 0], [500, 100], [700, 0]);
    const onJump = vi.fn();
    const onSelect = vi.fn();
    const done = openScriptCheck({ actions: live, getActions: () => live, onJump, onSelect });
    live = pts([0, 0], [500, 100], [900, 0]);       // the pop-out slowed it: now 500 units/s → 250
    groupEl('tooFast').querySelector('.script-check__row').click();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onJump).not.toHaveBeenCalled();
    expect(document.querySelector('.modal-overlay')).not.toBeNull();
    expect(dialog().querySelector('.script-check__status').textContent).toBe('The script changed while this was open, so it was checked again.');
    expect(dialog().querySelector('.script-check__empty-title').textContent).toBe('All good');
    dialog().querySelector('.script-check__done').click();
    await expect(done).resolves.toBeNull();
  });

  it('text from the file never becomes markup', () => {
    openScriptCheck({ actions: [{ at: 0, pos: '<img src=x onerror=alert(1)>' }, { at: 100, pos: 50 }] });
    expect(dialog().querySelector('img')).toBeNull();
  });
});

describe('findingText', () => {
  it('words each kind\'s detail', () => {
    expect(findingText({ kind: 'tooFast', detail: { speed: 523 } })).toBe('523 units/s');
    expect(findingText({ kind: 'sameTime', detail: { count: 2 } })).toBe('2 points');
    expect(findingText({ kind: 'outOfRange', detail: { pos: 120 } })).toBe('Position 120');
    expect(findingText({ kind: 'outOfRange', detail: { at: -40 } })).toBe('Time -40 ms');
    expect(findingText({ kind: 'outOfRange', detail: { invalid: true } })).toBe('Not a valid point');
    expect(findingText({ kind: 'notWhole', detail: { at: 500.4, pos: 100 } })).toBe('Time 500.4, position 100');
    expect(findingText({ kind: 'longGap', detail: { gapMs: 15000 } })).toBe('15 s without a point');
    expect(findingText({ kind: 'shortStroke', detail: { ms: 10, frameMs: 16.7 } })).toBe('10 ms apart (a frame is 16.7 ms)');
  });
});
