// Undo history menu (editor work list 4.5, 2026-11-24): the steps
// EditableScript.undoHistory() names, as a short menu at the pointer. Choosing
// a row goes back to just before that edit ("undo to here"): the newest row
// undoes 1 step, the third row 3. Redo rows sit under a divider, next redo
// first, and redo up to and including the chosen one. OFS has the same list
// (its Undo / Redo history window); FunSync's lives in the timeline's own
// menu module (editor-context-menu.js), so the keys, focus return and
// fullscreen placement are the ones the right-click menu already has, in the
// docked editor and the pop-out alike.

import { openContextMenu } from '../js/editor-context-menu.js';
import { t } from '../js/i18n.js';

/** Rows shown per side; older steps stay one Ctrl+Z away. */
export const MAX_UNDO_ROWS = 20;
export const MAX_REDO_ROWS = 10;

/**
 * A step's name in the active language. The modifier keys are the Modify
 * menu's own items ("Remap Range…"): their trailing ellipsis, which promises
 * a dialog, is dropped here. An unlabelled step (made before labels) or a
 * key missing from every bundle (t returns the key) reads "Edit".
 * @param {{label: string|null, params?: object}} entry
 * @returns {string}
 */
export function historyLabelText(entry) {
  const key = entry?.label;
  const params = entry?.params && typeof entry.params === 'object' ? entry.params : {};
  let text = key ? t(key, Object.keys(params).length ? params : undefined) : '';
  if (!text || text === key) text = t('editor.history.edit');
  return text.replace(/\s*(?:…|\.\.\.)\s*$/u, '');
}

/**
 * The menu's rows, pure (the tests read it): undo rows newest first, then
 * redo rows next first, each with how many steps choosing it takes.
 * @param {{undo?: Array, redo?: Array}} history — EditableScript.undoHistory()
 * @param {{maxUndo?: number, maxRedo?: number}} [o]
 * @returns {Array<{kind: 'undo'|'redo', steps: number, text: string}>}
 */
export function historyRows(history, { maxUndo = MAX_UNDO_ROWS, maxRedo = MAX_REDO_ROWS } = {}) {
  const undo = Array.isArray(history?.undo) ? history.undo.slice(0, maxUndo) : [];
  const redo = Array.isArray(history?.redo) ? history.redo.slice(0, maxRedo) : [];
  return [
    ...undo.map((e, i) => ({ kind: 'undo', steps: i + 1, text: historyLabelText(e) })),
    ...redo.map((e, i) => ({ kind: 'redo', steps: i + 1, text: historyLabelText(e) })),
  ];
}

/**
 * Open the undo history menu at (x, y), viewport pixels.
 *
 * @param {object} o
 * @param {number} o.x
 * @param {number} o.y
 * @param {{undo: Array, redo: Array}} o.history — EditableScript.undoHistory()
 * @param {(kind: 'undo'|'redo', steps: number) => void} o.onPick — call
 *   editableScript.undoSteps(steps) / redoSteps(steps)
 * @param {HTMLElement|null} [o.returnFocus] — focused again on Esc / Tab / a click away
 * @param {Document} [o.doc]
 * @returns {{ el: HTMLElement, close: () => void }}
 */
export function openUndoHistoryMenu({ x, y, history, onPick, returnFocus = null, doc = document, extra = [] }) {
  const rows = historyRows(history);
  const items = rows.length
    ? rows.map((r) => ({ label: r.text, onSelect: () => onPick?.(r.kind, r.steps) }))
    : [{ label: t('editor.history.nothing'), disabled: true }];
  // Under the undo steps, the script's saved versions (Restore an earlier
  // version: it sat in the Export menu, which it is not; 2026-11-25).
  if (extra.length) items.push({ heading: t('editor.history.versionsGroup') }, ...extra);

  const menu = openContextMenu({
    x, y, items, ariaLabel: t('editor.history.menuAria'), returnFocus, doc,
  });
  const el = menu.el;
  el.classList.add('undo-history-menu');

  // Each row says what choosing it does (it may be several steps), and redo
  // rows sit under a divider. Added here, after the shared menu built its
  // buttons: the divider is no button, so its arrow keys skip it.
  const buttons = [...el.querySelectorAll('.editor-context-menu__item')];
  rows.forEach((r, i) => {
    const btn = buttons[i];
    if (!btn) return;
    btn.classList.add(`undo-history-menu__item--${r.kind}`);
    const what = r.kind === 'undo'
      ? t('editor.history.undoSteps', { count: r.steps })
      : t('editor.history.redoSteps', { count: r.steps });
    btn.title = what;
    btn.setAttribute('aria-description', what);
  });
  const firstRedo = rows.findIndex((r) => r.kind === 'redo');
  if (firstRedo >= 0 && buttons[firstRedo]) {
    const divider = doc.createElement('div');
    divider.className = 'undo-history-menu__divider';
    divider.setAttribute('role', 'separator');
    divider.setAttribute('aria-label', t('editor.history.redoGroup'));
    divider.textContent = t('editor.history.redoGroup');
    el.insertBefore(divider, buttons[firstRedo]);
  }

  // The divider made the menu taller than when it was placed: keep it in the window.
  const win = doc.defaultView;
  const vh = win?.innerHeight || 0;
  const rect = el.getBoundingClientRect();
  if (vh && rect.height && rect.top + rect.height > vh - 4) {
    el.style.top = `${Math.max(4, vh - rect.height - 4)}px`;
  }
  return menu;
}
