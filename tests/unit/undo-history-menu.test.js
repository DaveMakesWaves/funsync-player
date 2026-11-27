/**
 * @vitest-environment jsdom
 * jsdom: the menu is real buttons in a real document, chosen by click and by
 * key (notes/CLAUDE.md "Test environments").
 */
// The undo history menu (editor work list 4.5, 2026-11-24): newest first,
// "undo to here" (the nth row undoes n steps), redo rows under a divider,
// names in the active language, and the chosen row driving a real
// EditableScript to the state the user picked.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { openUndoHistoryMenu, historyRows, historyLabelText, MAX_UNDO_ROWS } from '../../renderer/components/undo-history-menu.js';
import { closeContextMenu } from '../../renderer/js/editor-context-menu.js';
import { EditableScript, HISTORY_LABELS } from '../../renderer/js/editable-script.js';
import { offsetTime, remapRange } from '../../renderer/js/script-modifiers.js';
import { _setBundlesForTests, _resetForTests } from '../../renderer/js/i18n.js';
import { withEditorToolsStrings } from './helpers/editor-tools-strings.js';

const EN = withEditorToolsStrings(JSON.parse(readFileSync('renderer/locales/en.json', 'utf8')));
const items = () => [...document.querySelectorAll('.undo-history-menu .editor-context-menu__item')];
const texts = () => items().map((b) => b.textContent);

function edited() {
  const es = new EditableScript();
  es.loadFromData({ actions: [{ at: 0, pos: 0 }, { at: 500, pos: 100 }, { at: 1000, pos: 0 }] });
  es.insertAction(1500, 100);                       // Add point
  es.selectAll();
  es.applyModifier(remapRange, 10, 90);             // Remap Range (… dropped)
  es.applyModifier(offsetTime, 250);                // Offset Time
  es.selectAll();
  es.deleteActions(es.selectedIndices);             // Delete 4 points
  return es;
}

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  document.body.innerHTML = '<canvas id="c" tabindex="0"></canvas>';
});
afterEach(() => {
  closeContextMenu();
  _resetForTests();
});

describe('historyLabelText', () => {
  it('translates the key with its params, drops a Modify item\'s ellipsis, and falls back to "Edit"', () => {
    expect(historyLabelText({ label: HISTORY_LABELS.delete, params: { count: 1 } })).toBe('Delete 1 point');
    expect(historyLabelText({ label: HISTORY_LABELS.delete, params: { count: 4 } })).toBe('Delete 4 points');
    expect(historyLabelText({ label: 'editor.modify.remapRange', params: {} })).toBe('Remap Range');
    expect(historyLabelText({ label: 'editor.modify.halfSpeed', params: {} })).toBe('Half Speed');
    expect(historyLabelText({ label: null, params: {} })).toBe('Edit');
    expect(historyLabelText({ label: 'editor.history.noSuchKey', params: {} })).toBe('Edit');
  });

  it('every label EditableScript can write has words (en)', () => {
    for (const key of Object.values(HISTORY_LABELS)) {
      const text = historyLabelText({ label: key, params: { count: 2 } });
      expect(text, key).not.toBe(key);
      expect(text.includes('{'), key).toBe(false);
    }
  });
});

describe('historyRows', () => {
  it('undo rows newest first then redo rows next first, each with its step count; capped', () => {
    const rows = historyRows({
      undo: [{ label: HISTORY_LABELS.insert }, { label: HISTORY_LABELS.invert, params: { count: 3 } }],
      redo: [{ label: HISTORY_LABELS.paste, params: { count: 1 } }],
    });
    expect(rows).toEqual([
      { kind: 'undo', steps: 1, text: 'Add point' },
      { kind: 'undo', steps: 2, text: 'Invert 3 points' },
      { kind: 'redo', steps: 1, text: 'Paste 1 point' },
    ]);
    const long = { undo: Array.from({ length: 50 }, () => ({ label: HISTORY_LABELS.insert })), redo: [] };
    expect(historyRows(long)).toHaveLength(MAX_UNDO_ROWS);
    expect(historyRows(null)).toEqual([]);
  });
});

describe('openUndoHistoryMenu', () => {
  it('lists the steps newest first, by name', () => {
    const es = edited();
    openUndoHistoryMenu({ x: 10, y: 10, history: es.undoHistory(), onPick: () => {} });
    expect(texts()).toEqual(['Delete 4 points', 'Offset Time', 'Remap Range', 'Add point']);
    expect(document.querySelector('.undo-history-menu').getAttribute('aria-label')).toBe('Undo history');
    expect(items()[2].title).toBe('Undo 3 steps');
  });

  it('"undo to here": choosing the third row undoes three steps on the script', () => {
    const es = edited();
    const onPick = vi.fn((kind, steps) => (kind === 'undo' ? es.undoSteps(steps) : es.redoSteps(steps)));
    openUndoHistoryMenu({ x: 10, y: 10, history: es.undoHistory(), onPick });
    items()[2].click();                                // Remap Range
    expect(onPick).toHaveBeenCalledWith('undo', 3);
    // Back to just before the remap: the four points as inserted.
    expect(es.actions.map((a) => `${a.at}:${a.pos}`)).toEqual(['0:0', '500:100', '1000:0', '1500:100']);
    expect(document.querySelector('.undo-history-menu')).toBeNull();
  });

  it('redo rows sit under a divider, next redo first, and redo up to the one chosen', () => {
    const es = edited();
    es.undoSteps(3);
    const onPick = vi.fn((kind, steps) => (kind === 'undo' ? es.undoSteps(steps) : es.redoSteps(steps)));
    openUndoHistoryMenu({ x: 10, y: 10, history: es.undoHistory(), onPick });
    expect(texts()).toEqual(['Add point', 'Remap Range', 'Offset Time', 'Delete 4 points']);
    const menu = document.querySelector('.undo-history-menu');
    const divider = menu.querySelector('.undo-history-menu__divider');
    expect(divider.getAttribute('role')).toBe('separator');
    expect(divider.nextElementSibling).toBe(items()[1]);
    expect(items()[1].classList.contains('undo-history-menu__item--redo')).toBe(true);
    expect(items()[2].title).toBe('Redo 2 steps');
    items()[2].click();                                // Offset Time
    expect(onPick).toHaveBeenCalledWith('redo', 2);
    expect(es.undoHistory().redo.map((e) => e.label)).toEqual([HISTORY_LABELS.delete]);
  });

  it('the arrow keys move over the rows, never onto the divider; Enter chooses', () => {
    const es = edited();
    es.undoSteps(1);
    const onPick = vi.fn();
    openUndoHistoryMenu({ x: 10, y: 10, history: es.undoHistory(), onPick });
    const menu = document.querySelector('.undo-history-menu');
    expect(document.activeElement).toBe(items()[0]);
    const key = (k) => menu.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    key('ArrowDown'); key('ArrowDown'); key('ArrowDown');
    expect(document.activeElement).toBe(items()[3]);   // the first redo row
    key('Enter');
    expect(onPick).toHaveBeenCalledWith('redo', 1);
  });

  it('nothing to undo or redo: one row that says so and does nothing', () => {
    const es = new EditableScript();
    es.loadEmpty();
    const onPick = vi.fn();
    openUndoHistoryMenu({ x: 10, y: 10, history: es.undoHistory(), onPick });
    expect(texts()).toEqual(['Nothing to undo or redo']);
    items()[0].click();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('Escape closes it and hands the focus back', () => {
    const canvas = document.getElementById('c');
    openUndoHistoryMenu({ x: 10, y: 10, history: edited().undoHistory(), onPick: () => {}, returnFocus: canvas });
    document.querySelector('.undo-history-menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.undo-history-menu')).toBeNull();
    expect(document.activeElement).toBe(canvas);
  });
});
