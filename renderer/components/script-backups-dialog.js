// "Restore an earlier version…" (editor work list 3.1, 2026-11-24): the
// versions main kept of one script before FunSync overwrote it
// (electron/script-backups.js), newest first, each with a Restore button.
//
// Restore writes nothing. It reads that version and hands its text to
// onRestore, and the editor loads it as ONE undoable edit, so Undo takes it
// back and the file changes only when the user saves (Shneiderman #6, easy
// reversal; which is also why there is no "are you sure?" here). Built on
// Modal.open for the dialog contract (DESIGN.md §2.5, §2.13); the empty state
// follows §2.11 (icon, heading, hint). Every node is built with textContent:
// the file name and nothing else from disk ever reaches innerHTML.
import { Modal } from './modal.js';
import { t, getCurrentLocale } from '../js/i18n.js';
import { formatFileSize } from '../js/format-file-size.js';
import { icon, History } from '../js/icons.js';

const sameDay = (a, b) => a.getFullYear() === b.getFullYear()
  && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/**
 * When a version was kept, in the app's language: "Today 2:02 PM",
 * "Yesterday 09:15", "21 Nov 14:02", with the year when it is not this year.
 * `seconds` adds them, for two versions kept in the same minute.
 * @param {number} at ms
 * @param {{now?: number, locale?: string, seconds?: boolean}} [opts]
 */
export function formatBackupWhen(at, { now = Date.now(), locale = getCurrentLocale(), seconds = false } = {}) {
  const d = new Date(at);
  if (!Number.isFinite(d.getTime())) return '';
  const today = new Date(now);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const fmt = (opts) => {
    try { return new Intl.DateTimeFormat(locale || 'en', opts).format(d); }
    catch { return new Intl.DateTimeFormat('en', opts).format(d); }
  };
  const time = fmt(seconds
    ? { hour: 'numeric', minute: '2-digit', second: '2-digit' }
    : { hour: 'numeric', minute: '2-digit' });
  if (sameDay(d, today)) return t('editor.backups.today', { time });
  if (sameDay(d, yesterday)) return t('editor.backups.yesterday', { time });
  const date = fmt(d.getFullYear() === today.getFullYear()
    ? { day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: 'numeric' });
  return t('editor.backups.dateTime', { date, time });
}

/**
 * The rows' text, "Today 2:02 PM · 412 points · 18 kB", one per entry in the
 * order given. Two rows that would read the same time get their seconds.
 * @param {Array<{id: string, at: number, size: number, points: number|null}>} entries
 * @param {{now?: number, locale?: string}} [opts]
 * @returns {Array<{when: string, label: string}>}
 */
export function backupRowLabels(entries, { now = Date.now(), locale = getCurrentLocale() } = {}) {
  const plain = entries.map((e) => formatBackupWhen(e.at, { now, locale }));
  const counts = new Map();
  for (const w of plain) counts.set(w, (counts.get(w) || 0) + 1);
  return entries.map((e, i) => {
    const when = counts.get(plain[i]) > 1 ? formatBackupWhen(e.at, { now, locale, seconds: true }) : plain[i];
    const parts = [when];
    if (Number.isInteger(e.points)) parts.push(t('editor.backups.points', { count: e.points }));
    const size = formatFileSize(e.size, locale);
    if (size) parts.push(size);
    return { when, label: parts.join(' · ') };
  });
}

const baseName = (p) => String(p || '').split(/[\\/]/).pop();

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * Open the list of kept versions of `path`.
 * @param {object} opts
 * @param {string} opts.path the script file on disk (not a `#embedded=`
 *   axis key, not a `stream:` key)
 * @param {(content: string, entry: object) => (void|Promise<void>)} opts.onRestore
 *   gets the chosen version's text after the dialog has closed
 * @returns {Promise<boolean>} true when a version was handed to onRestore
 */
export async function openScriptBackupsDialog({ path, onRestore } = {}) {
  const api = (typeof window !== 'undefined' && window.funsync) || {};
  const picked = await Modal.open({
    title: t('editor.backups.title'),
    panelClass: 'script-backups',
    onRender(body, close) {
      const name = baseName(path);
      if (name) body.appendChild(el('p', 'script-backups__file', name));
      const status = el('p', 'script-backups__status', t('common.loading'));
      status.setAttribute('aria-live', 'polite');
      body.appendChild(status);
      const content = el('div', 'script-backups__content');
      body.appendChild(content);
      const error = el('p', 'script-backups__error');
      error.setAttribute('role', 'alert');
      error.hidden = true;
      body.appendChild(error);

      const actions = el('div', 'modal-actions');
      const closeBtn = el('button', 'modal-btn modal-btn--secondary', t('common.close'));
      closeBtn.type = 'button';
      closeBtn.addEventListener('click', () => close(null));
      actions.appendChild(closeBtn);
      body.appendChild(actions);

      const showEmpty = () => {
        const empty = el('div', 'script-backups__empty');
        const ico = icon(History, { width: 32, height: 32, 'aria-hidden': 'true' });
        ico.classList.add('script-backups__empty-icon');
        empty.appendChild(ico);
        empty.appendChild(el('p', 'script-backups__empty-title', t('editor.backups.emptyTitle')));
        empty.appendChild(el('p', 'script-backups__empty-hint', t('editor.backups.emptyHint')));
        content.appendChild(empty);
      };

      const showList = (entries) => {
        content.appendChild(el('p', 'script-backups__intro', t('editor.backups.intro')));
        const list = el('ul', 'script-backups__list');
        const buttons = [];
        const labels = backupRowLabels(entries);
        entries.forEach((entry, i) => {
          const row = el('li', 'script-backups__row');
          row.dataset.id = entry.id;
          row.appendChild(el('span', 'script-backups__label', labels[i].label));
          const btn = el('button', 'modal-btn modal-btn--secondary script-backups__restore', t('editor.backups.restore'));
          btn.type = 'button';
          btn.setAttribute('aria-label', t('editor.backups.restoreAria', { when: labels[i].when }));
          btn.addEventListener('click', async () => {
            for (const b of buttons) b.disabled = true;
            error.hidden = true;
            let text = null;
            try { text = await api.readScriptBackup?.(path, entry.id); }
            catch (err) { console.warn('[ScriptBackups] read failed', err); }
            // Escape or the X during the read: the dialog has gone, nothing to do.
            if (!body.isConnected) return;
            if (typeof text === 'string') {
              close({ content: text, entry });
              return;
            }
            error.textContent = t('editor.backups.readFailed');
            error.hidden = false;
            for (const b of buttons) b.disabled = false;
            btn.focus({ preventScroll: true });
          });
          buttons.push(btn);
          row.appendChild(btn);
          list.appendChild(row);
        });
        content.appendChild(list);
        // The dialog opened on Close while the list loaded; the newest
        // version's Restore is the likely next step. Only when the user has
        // not moved the focus themselves.
        const active = document.activeElement;
        if (buttons[0] && (active === closeBtn || active === document.body || !active)) {
          buttons[0].focus({ preventScroll: true });
        }
      };

      (async () => {
        let entries = null;
        try { entries = await api.listScriptBackups?.(path); }
        catch (err) { console.warn('[ScriptBackups] list failed', err); }
        if (!body.isConnected) return;
        status.remove();
        if (!Array.isArray(entries)) {
          error.textContent = t('editor.backups.listFailed');
          error.hidden = false;
          return;
        }
        const valid = entries.filter((e) => e && typeof e.id === 'string');
        if (valid.length === 0) showEmpty();
        else showList(valid);
      })();
    },
  });
  if (!picked || typeof picked.content !== 'string') return false;
  if (typeof onRestore !== 'function') return false;
  try {
    await onRestore(picked.content, picked.entry);
    return true;
  } catch (err) {
    console.error('[ScriptBackups] onRestore failed', err);
    return false;
  }
}
