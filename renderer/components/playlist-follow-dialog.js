// "Follow…" on a playlist (zaikechi #381: "sync a playlist with a
// library/Category/Folder instead of needing to manually add things to it").
// One choice: nothing (you add the videos), a category, a library folder, or
// any folder. The rule lives on the playlist (store.js setPlaylistFollow) and
// renderer/js/playlist-follow.js keeps the playlist in step. The dialog says
// the two promises plainly: new matches are added, and nothing you removed
// comes back (nor is anything removed because a drive is offline).
//
// Resolves to `{ follow }` (the rule chosen; `null` = follow nothing) on
// Save, or null when cancelled (Cancel, Escape, the X): a cancel never
// reads as 'follow nothing'.

import { Modal } from './modal.js';
import { t } from '../js/i18n.js';

/**
 * @param {{ playlist: object, categories: object[], sources: object[],
 *   pickFolder?: () => Promise<string|null> }} opts
 */
export function openPlaylistFollowDialog({ playlist, categories, sources, pickFolder }) {
  const current = playlist?.follow || null;
  const cats = (Array.isArray(categories) ? categories : []).filter((c) => c?.id);
  const srcs = (Array.isArray(sources) ? sources : []).filter((s) => s?.id && s?.path);
  return Modal.open({
    title: t('playlists.follow.title', { name: playlist?.name || '' }),
    panelClass: 'playlist-follow',
    initialFocus: (body) => body.querySelector('input[name="pf-kind"]:checked'),
    onRender(body, close) {
      const intro = document.createElement('p');
      intro.className = 'playlist-follow__intro';
      intro.textContent = t('playlists.follow.intro');
      body.appendChild(intro);

      const set = document.createElement('fieldset');
      set.className = 'playlist-follow__choices';
      const legend = document.createElement('legend');
      legend.className = 'playlist-follow__legend';
      legend.textContent = t('playlists.follow.legend');
      set.appendChild(legend);

      const controls = {};
      const option = (kind, label, control) => {
        const row = document.createElement('div');
        row.className = 'playlist-follow__row';
        const lab = document.createElement('label');
        lab.className = 'playlist-follow__option';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'pf-kind';
        radio.value = kind;
        radio.checked = (current?.kind || 'none') === kind;
        const text = document.createElement('span');
        text.textContent = label;
        lab.append(radio, text);
        row.appendChild(lab);
        if (control) row.appendChild(control);
        set.appendChild(row);
        controls[kind] = { radio, control };
        return radio;
      };

      option('none', t('playlists.follow.none'));

      const catSelect = document.createElement('select');
      catSelect.className = 'settings-panel__input settings-panel__input--select playlist-follow__select';
      catSelect.setAttribute('aria-label', t('playlists.follow.category'));
      for (const c of cats) {
        const o = document.createElement('option');
        o.value = c.id;
        o.textContent = c.name;
        catSelect.appendChild(o);
      }
      if (current?.kind === 'category') catSelect.value = current.categoryId;
      const catRadio = option('category', t('playlists.follow.category'), catSelect);
      if (!cats.length) { catRadio.disabled = true; catSelect.disabled = true; }

      const srcSelect = document.createElement('select');
      srcSelect.className = 'settings-panel__input settings-panel__input--select playlist-follow__select';
      srcSelect.setAttribute('aria-label', t('playlists.follow.source'));
      for (const s of srcs) {
        const o = document.createElement('option');
        o.value = s.id;
        o.textContent = s.name || s.path;
        srcSelect.appendChild(o);
      }
      if (current?.kind === 'source') srcSelect.value = current.sourceId;
      const srcRadio = option('source', t('playlists.follow.source'), srcSelect);
      if (!srcs.length) { srcRadio.disabled = true; srcSelect.disabled = true; }

      const folderBox = document.createElement('div');
      folderBox.className = 'playlist-follow__folder';
      const folderText = document.createElement('span');
      folderText.className = 'playlist-follow__folder-path';
      let folderPath = current?.kind === 'folder' ? current.folderPath : '';
      const paintFolder = () => { folderText.textContent = folderPath || t('playlists.follow.noFolder'); };
      paintFolder();
      const browse = document.createElement('button');
      browse.type = 'button';
      browse.className = 'modal-btn modal-btn--secondary playlist-follow__browse';
      browse.textContent = t('playlists.follow.browse');
      folderBox.append(folderText, browse);
      const folderRadio = option('folder', t('playlists.follow.folder'), folderBox);

      body.appendChild(set);

      const note = document.createElement('p');
      note.className = 'playlist-follow__note';
      note.textContent = t('playlists.follow.note');
      body.appendChild(note);

      const actions = document.createElement('div');
      actions.className = 'modal-actions';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'modal-btn modal-btn--secondary';
      cancel.textContent = t('common.cancel');
      cancel.addEventListener('click', () => close(null));
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'modal-btn modal-btn--primary playlist-follow__save';
      save.textContent = t('common.save');
      actions.append(cancel, save);
      body.appendChild(actions);

      const kind = () => set.querySelector('input[name="pf-kind"]:checked')?.value || 'none';
      const valid = () => kind() !== 'folder' || !!folderPath;
      const paint = () => { save.disabled = !valid(); };
      set.addEventListener('change', paint);
      // Choosing in a control picks its option too.
      catSelect.addEventListener('change', () => { catRadio.checked = true; paint(); });
      srcSelect.addEventListener('change', () => { srcRadio.checked = true; paint(); });
      browse.addEventListener('click', async () => {
        const picked = await pickFolder?.();
        if (typeof picked === 'string' && picked) {
          folderPath = picked;
          folderRadio.checked = true;
          paintFolder();
          paint();
        }
      });
      paint();

      save.addEventListener('click', () => {
        if (!valid()) return;
        const k = kind();
        if (k === 'category') close({ follow: { kind: 'category', categoryId: catSelect.value } });
        else if (k === 'source') close({ follow: { kind: 'source', sourceId: srcSelect.value } });
        else if (k === 'folder') close({ follow: { kind: 'folder', folderPath } });
        else close({ follow: null });
      });
    },
  });
}
