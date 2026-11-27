// Adding a library source: the ONE place that checks the new folder against
// the sources already there and asks about an overlap (test day 2026-11-24,
// B024). Settings > Sources and app.js `_addSource` (Library ▾ "Add Source
// Folder…", the first-launch button) both call it, BEFORE the name prompt.
// The Library menu path used to ask the name first, compare raw strings and
// take a folder inside a source (or one holding sources) without a word, so
// every video in it was scanned twice.
//
//   exact  (canonicalPath: slashes, trailing slash, drive letter) ->
//          "Already added as {name}", nothing added
//   child  -> "Folder already covered ... Add anyway?"
//   parent -> "Overlapping source": on yes, the sources inside are replaced
//
// Modal, t and showToast are passed in, so the caller's (and a test's) are
// the ones used.

import { classifyOverlap } from './path-utils.js';

/**
 * @param {string} dirPath  the folder the user picked
 * @param {Array<{id: string, name: string, path: string}>} sources  the sources now
 * @param {{ Modal: object, t: Function, showToast: Function }} ui
 * @returns {Promise<{ proceed: boolean, removeIds: Set<string>|null }>}
 *   proceed false = add nothing; removeIds = sources to drop for this one
 */
export async function askSourceOverlap(dirPath, sources, { Modal, t, showToast }) {
  const overlap = classifyOverlap(dirPath, sources || []);
  if (overlap.kind === 'exact') {
    showToast(t('settingsPanel.sources.alreadyAdded', { name: overlap.source.name }), 'warn');
    return { proceed: false, removeIds: null };
  }
  if (overlap.kind === 'child') {
    const ok = await Modal.confirm(
      t('settingsPanel.sources.childOverlapTitle'),
      t('settingsPanel.sources.childOverlapBody', { path: dirPath, parentName: overlap.parent.name, parentPath: overlap.parent.path }),
      { confirmText: t('settingsPanel.sources.addAnyway') },
    );
    return { proceed: !!ok, removeIds: null };
  }
  if (overlap.kind === 'parent') {
    const childNames = overlap.children.map((c) => `"${c.name}"`).join(', ');
    const ok = await Modal.confirm(
      t('settingsPanel.sources.parentOverlapTitle'),
      t('settingsPanel.sources.parentOverlapBody', { path: dirPath, count: overlap.children.length, names: childNames }),
      { confirmText: t('settingsPanel.sources.parentOverlapConfirm') },
    );
    return { proceed: !!ok, removeIds: ok ? new Set(overlap.children.map((c) => c.id)) : null };
  }
  return { proceed: true, removeIds: null };
}
