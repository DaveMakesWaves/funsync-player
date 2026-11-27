// The delete dialog (2026-11-23, EroScripts #434; DESIGN.md §2.18).
//
// Built to the destructive-action rules (Shneiderman #5 prevent errors, #6
// easy reversal; Nielsen #5, #9; Norman's forcing function):
//   - it says exactly what goes: every file, its kind, its size, a total;
//   - the video is always listed and locked; a file another video also uses
//     is locked, unticked and says who uses it;
//   - the Recycle Bin is the default (it can be undone); "Delete permanently"
//     is a separate choice that shows a red warning with the count and size
//     and a tick box ("I understand they cannot be recovered") that must be
//     ticked before its button works;
//   - Cancel has the focus first, Enter never confirms, Escape cancels;
//   - files on a network drive (no Recycle Bin on Windows) can only be
//     deleted permanently, and the dialog says why.
//
// Returns { paths, permanent } or null (cancelled). Nothing is deleted here.

import { Modal } from './modal.js';
import { t } from '../js/i18n.js';
import { binOs } from '../js/recycle-bin.js';
import { chosenPaths, totalSize } from '../js/delete-plan.js';
import { formatFileSize } from '../js/format-file-size.js';

const isNetworkPath = (p) => /^(\\\\|\/\/)[^\\/]/.test(String(p || ''));

function kindText(row) {
  switch (row.kind) {
    case 'video': return t('library.deleteFiles.kindVideo');
    case 'script': return t('library.deleteFiles.kindScript');
    case 'axis': return t('library.deleteFiles.kindAxis', { label: row.label || '' });
    case 'variant': return row.label ? t('library.deleteFiles.kindVariant', { label: row.label }) : t('library.deleteFiles.kindVariantPlain');
    case 'subtitle': return t('library.deleteFiles.kindSubtitle');
    default: return '';
  }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/**
 * @param {{ title: string, intro?: string, rows: object[], platform?: string }} o
 * @returns {Promise<{ paths: string[], permanent: boolean }|null>}
 */
export function openDeleteDialog({ title, intro, rows, platform, forget = null }) {
  const os = binOs(platform);
  const state = rows.map((r) => ({ ...r }));
  return Modal.open({
    title,
    panelClass: 'delete-files',
    // Cancel first (§2.18): a destructive button is never where the focus starts.
    initialFocus: (body) => body.querySelector('.delete-files__cancel'),
    onRender(body, close) {
      if (intro) body.appendChild(el('p', 'delete-files__intro', intro));

      const list = el('ul', 'delete-files__list');
      list.setAttribute('aria-label', t('library.deleteFiles.listAria'));
      state.forEach((row, i) => {
        const li = el('li', 'delete-files__row');
        if (row.locked && row.kind !== 'video') li.classList.add('delete-files__row--kept');
        const id = `delete-files-row-${i}`;
        const cb = el('input', 'delete-files__check');
        cb.type = 'checkbox';
        cb.id = id;
        cb.checked = row.checked;
        cb.disabled = row.locked;
        cb.addEventListener('change', () => { row.checked = cb.checked; refresh(); });
        const label = el('label', 'delete-files__label');
        label.htmlFor = id;
        label.appendChild(el('span', 'delete-files__name', row.name));
        const meta = [kindText(row), row.size != null ? formatFileSize(row.size) : t('library.deleteFiles.sizeUnknown')];
        label.appendChild(el('span', 'delete-files__meta', meta.join(' · ')));
        if (row.sharedWith?.length) {
          label.appendChild(el('span', 'delete-files__shared', t('library.deleteFiles.shared', { names: row.sharedWith.map((n) => `“${n}”`).join(', ') })));
        } else if (row.outside) {
          label.appendChild(el('span', 'delete-files__meta', t('library.deleteFiles.outside', { folder: row.path.slice(0, Math.max(row.path.lastIndexOf('\\'), row.path.lastIndexOf('/'))) })));
        }
        li.appendChild(cb);
        li.appendChild(label);
        list.appendChild(li);
      });
      body.appendChild(list);

      const total = el('p', 'delete-files__total');
      total.setAttribute('aria-live', 'polite');
      body.appendChild(total);

      // A record FunSync keeps beyond the files (Dave, 2026-11-25: the
      // EroScripts tab's "downloaded" for the post they came from): offered
      // to forget too, ticked, so the post shows as never downloaded again.
      let forgetCheck = null;
      if (forget && forget.label) {
        const wrap = el('label', 'delete-files__forget');
        forgetCheck = el('input', 'delete-files__forget-check');
        forgetCheck.type = 'checkbox';
        forgetCheck.checked = forget.checked !== false;
        wrap.appendChild(forgetCheck);
        const txt = el('span', 'delete-files__option-text');
        txt.appendChild(el('span', 'delete-files__option-label', forget.label));
        if (forget.hint) txt.appendChild(el('span', 'delete-files__option-hint', forget.hint));
        wrap.appendChild(txt);
        body.appendChild(wrap);
      }

      // How: the Recycle Bin (default) or permanently.
      const how = el('fieldset', 'delete-files__how');
      how.appendChild(el('legend', 'delete-files__legend', t('library.deleteFiles.how')));
      const option = (value, labelText, hintText) => {
        const wrap = el('label', 'delete-files__option');
        const radio = el('input');
        radio.type = 'radio';
        radio.name = 'delete-files-how';
        radio.value = value;
        wrap.appendChild(radio);
        const txt = el('span', 'delete-files__option-text');
        txt.appendChild(el('span', 'delete-files__option-label', labelText));
        txt.appendChild(el('span', 'delete-files__option-hint', hintText));
        wrap.appendChild(txt);
        how.appendChild(wrap);
        return radio;
      };
      const toBin = option('bin', t('library.deleteFiles.toBin', { os }), t('library.deleteFiles.toBinHint', { os }));
      const forever = option('permanent', t('library.deleteFiles.permanent'), t('library.deleteFiles.permanentHint'));
      const noBinNote = el('p', 'delete-files__note', t('library.deleteFiles.noBin', { os }));
      noBinNote.hidden = true;
      how.appendChild(noBinNote);
      body.appendChild(how);

      // The permanent warning and its forcing function.
      const warn = el('div', 'delete-files__warning');
      warn.hidden = true;
      warn.setAttribute('role', 'group');
      const warnText = el('p', 'delete-files__warning-text');
      warnText.setAttribute('aria-live', 'polite');
      warn.appendChild(warnText);
      const understandWrap = el('label', 'delete-files__understand');
      const understand = el('input', 'delete-files__understand-check');
      understand.type = 'checkbox';
      understandWrap.appendChild(understand);
      // Its words follow the count ("it" / "they"): set in refresh().
      const understandText = el('span', null, t('library.deleteFiles.understand', { count: 2 }));
      understandWrap.appendChild(understandText);
      warn.appendChild(understandWrap);
      body.appendChild(warn);

      const actions = el('div', 'modal-actions');
      const cancel = el('button', 'modal-btn modal-btn--secondary delete-files__cancel', t('common.cancel'));
      cancel.type = 'button';
      cancel.addEventListener('click', () => close(null));
      const go = el('button', 'modal-btn delete-files__go');
      go.type = 'button';
      actions.appendChild(cancel);
      actions.appendChild(go);
      body.appendChild(actions);

      const chosen = () => state.filter((r) => chosenPaths([r]).length);
      function refresh() {
        const picked = chosen();
        const size = formatFileSize(totalSize(picked));
        total.textContent = t('library.deleteFiles.total', { count: picked.length, size });
        const networkOnly = picked.some((r) => isNetworkPath(r.path));
        toBin.disabled = networkOnly;
        noBinNote.hidden = !networkOnly;
        if (networkOnly && toBin.checked) toBin.checked = false;
        const permanent = forever.checked;
        warn.hidden = !permanent;
        if (permanent) {
          warnText.textContent = t('library.deleteFiles.warning', { count: picked.length, size, os });
          // One file read "This file ... They will not go ..." and "I
          // understand they cannot be recovered" (test day 2026-11-24, B019).
          understandText.textContent = t('library.deleteFiles.understand', { count: picked.length });
        }
        go.classList.toggle('modal-btn--danger', permanent);
        go.classList.toggle('modal-btn--primary', !permanent);
        go.textContent = permanent ? t('library.deleteFiles.btnPermanent') : t('library.deleteFiles.btnBin', { os });
        go.disabled = picked.length === 0 || (!toBin.checked && !permanent) || (permanent && !understand.checked);
      }
      for (const r of [toBin, forever]) r.addEventListener('change', () => { understand.checked = false; refresh(); });
      understand.addEventListener('change', refresh);
      go.addEventListener('click', () => {
        if (go.disabled) return;
        const permanent = forever.checked;
        if (permanent && !understand.checked) return;
        close({ paths: chosenPaths(state), permanent, ...(forgetCheck ? { forget: forgetCheck.checked === true } : {}) });
      });
      // The default: the Recycle Bin, unless a chosen file cannot go there.
      toBin.checked = !state.some((r) => r.checked && isNetworkPath(r.path));
      refresh();
    },
  });
}
