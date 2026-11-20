// Bulk add variations (N-04, Dave 2026-11-08: "we need to add a bulk add when
// adding variations from file browser, one at a time is annoying").
//
// Browse... in the player's + Add variation and in the Associate dialog's
// variation picker takes several files at once. Every file gets a suggested
// name from the rules the one-file naming dialog has always used, and all of
// them are named in ONE step, each name editable. A file already in the
// video's variation list, or picked twice, is skipped and the dialog says so.
// The caller stores what comes back (`library.manualVariants`), nothing here
// writes. Pure planning plus the dialog; app.js `_addManualVariants` and
// library.js `_addVariantsWithNaming` use it.

import { Modal } from '../components/modal.js';
import { t } from './i18n.js';
import { canonicalPath } from './path-utils.js';

/**
 * The names the naming step suggests for a script file, best first: each
 * (parenthesised part), the last `.dot` part, then the file name itself.
 * The same rules as the one-file naming dialog (app.js `_addManualVariant`,
 * library.js `_addVariantWithNaming`).
 */
export function suggestVariantLabels(fsName) {
  const nameNoExt = String(fsName || '').replace(/\.funscript$/i, '');
  const parenMatches = [...nameNoExt.matchAll(/\(([^)]+)\)/g)].map((m) => m[1].trim()).filter(Boolean);
  const dotParts = nameNoExt.split('.');
  const dotSuffix = dotParts.length > 1 ? dotParts[dotParts.length - 1].trim() : null;
  const suggestions = [];
  const seen = new Set();
  for (const s of parenMatches) {
    const lower = s.toLowerCase();
    if (!seen.has(lower)) { seen.add(lower); suggestions.push(s); }
  }
  if (dotSuffix && !seen.has(dotSuffix.toLowerCase())) {
    seen.add(dotSuffix.toLowerCase());
    suggestions.push(dotSuffix);
  }
  if (nameNoExt && !seen.has(nameNoExt.toLowerCase())) suggestions.push(nameNoExt);
  return suggestions;
}

/**
 * Which picked files to add to a video's variations, and the name each one
 * starts with. `listedPaths` / `listedLabels`: what the video's variation
 * list already holds. A file already listed, or picked twice, is skipped. A
 * label picks the variant (the pin, the phone's switch, the pop-out), so the
 * starting names are unique: the first suggestion not taken yet, else the
 * file name with " (2)", " (3)"...
 *
 * @param {{path: string, name?: string}[]} files
 * @returns {{add: {path, name, suggestions: string[], label: string}[], skipped: {path, name}[]}}
 */
export function planVariantAdds(files, { listedPaths = [], listedLabels = [] } = {}) {
  const seen = new Set(listedPaths.filter(Boolean).map(canonicalPath));
  const labels = new Set(listedLabels.filter(Boolean).map((l) => String(l).trim().toLowerCase()));
  const add = [];
  const skipped = [];
  for (const file of Array.isArray(files) ? files : []) {
    if (!file?.path) continue;
    const name = file.name || String(file.path).split(/[\\/]/).pop();
    const key = canonicalPath(file.path);
    if (seen.has(key)) {
      skipped.push({ path: file.path, name });
      continue;
    }
    seen.add(key);
    const suggestions = suggestVariantLabels(name);
    let label = suggestions.find((s) => !labels.has(s.toLowerCase()));
    if (!label) {
      const stem = suggestions[suggestions.length - 1] || name;
      for (let n = 2; !label; n++) {
        const candidate = `${stem} (${n})`;
        if (!labels.has(candidate.toLowerCase())) label = candidate;
      }
    }
    labels.add(label.toLowerCase());
    add.push({ path: file.path, name, suggestions, label });
  }
  return { add, skipped };
}

/** What a file picker answered, as a list: null, one `{path, name}` or several. */
export function pickedFiles(result) {
  if (!result) return [];
  return (Array.isArray(result) ? result : [result]).filter((f) => f && f.path);
}

/**
 * The one naming step for several files. Resolves with the variations to add,
 * `[{label, path, name}]` in the order picked, or null when cancelled. A name
 * left empty takes the suggestion it started with.
 *
 * @param {{add: object[], skipped: object[]}} plan  from planVariantAdds
 * @param {{title?: string}} [opts]
 * @returns {Promise<{label: string, path: string, name: string}[]|null>}
 */
export function showBulkVariantNaming(plan, { title } = {}) {
  const add = plan?.add || [];
  const skipped = plan?.skipped || [];
  return Modal.open({
    title: title || t('variants.bulkNamingTitle', { count: add.length }),
    panelClass: 'variant-bulk',
    onRender: (body, close) => {
      const hint = document.createElement('p');
      hint.className = 'variant-bulk__hint';
      hint.textContent = t('variants.bulkNamingHint');
      body.appendChild(hint);

      if (skipped.length > 0) {
        const note = document.createElement('p');
        note.className = 'variant-bulk__skipped';
        note.setAttribute('role', 'note');
        note.textContent = t('variants.bulkSkipped', {
          count: skipped.length,
          names: skipped.map((s) => s.name).join(', '),
        });
        body.appendChild(note);
      }

      const list = document.createElement('div');
      list.className = 'variant-bulk__list';
      const inputs = [];
      const idBase = `variant-bulk-${Math.random().toString(36).slice(2, 8)}`;
      add.forEach((entry, i) => {
        const row = document.createElement('div');
        row.className = 'variant-bulk__row';

        const file = document.createElement('label');
        file.className = 'variant-bulk__file';
        file.htmlFor = `${idBase}-${i}`;
        file.textContent = entry.name;
        file.title = entry.path;
        row.appendChild(file);

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'modal-input variant-bulk__input';
        input.id = `${idBase}-${i}`;
        input.value = entry.label;
        input.placeholder = entry.label;
        input.spellcheck = false;
        row.appendChild(input);
        inputs.push(input);

        if (entry.suggestions.length > 1) {
          const chips = document.createElement('div');
          chips.className = 'variant-bulk__chips';
          for (const sug of entry.suggestions) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'variant-bulk__chip';
            chip.textContent = sug;
            chip.addEventListener('click', () => { input.value = sug; input.focus(); });
            chips.appendChild(chip);
          }
          row.appendChild(chips);
        }
        list.appendChild(row);
      });
      body.appendChild(list);

      const submit = () => close(add.map((entry, i) => ({
        label: inputs[i].value.trim() || entry.label,
        path: entry.path,
        name: entry.name,
      })));

      const actions = document.createElement('div');
      actions.className = 'modal-actions';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'modal-btn modal-btn--secondary';
      cancelBtn.textContent = t('common.cancel');
      cancelBtn.addEventListener('click', () => close(null));
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'modal-btn modal-btn--primary variant-bulk__add';
      addBtn.textContent = t('variants.bulkAddButton', { count: add.length });
      addBtn.addEventListener('click', submit);
      actions.appendChild(cancelBtn);
      actions.appendChild(addBtn);
      body.appendChild(actions);

      for (const input of inputs) {
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); submit(); }
        });
      }
      inputs[0]?.focus();
      inputs[0]?.select?.();
    },
  });
}
