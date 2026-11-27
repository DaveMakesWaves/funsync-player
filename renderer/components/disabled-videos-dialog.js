// Library ▾ "Disabled videos" (zaikechi #381: "it would be nice to have an
// option to review and manage these in a list. Maybe even options to
// outright delete and remove them from the system to clean them out").
//
// Every disabled video, newest first: Play it (a hand pick, which a disabled
// video allows), Enable it, or Delete… it (the delete dialog of DESIGN.md
// §2.18 on top of this list, with its Recycle Bin default and its warning).
// Enable all at the bottom, with an Undo. A video the library does not hold
// now (an offline drive, a moved file) stays listed, says so, and can still
// be enabled; it cannot be played or deleted from here.
// The model is renderer/js/disabled-videos.js; this is only the list.

import { Modal } from './modal.js';
import { t } from '../js/i18n.js';
import { icon, Play, Trash2, Ban } from '../js/icons.js';
import { disabledRows, setDisabled, enableVideos } from '../js/disabled-videos.js';
import { showUndoToast } from '../js/toast.js';

const nameOf = (p) => String(p || '').split(/[\\/]/).pop();
const folderOf = (p) => {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i > 0 ? s.slice(0, i) : '';
};

/**
 * @param {{ settings: object, videos: object[], onPlay?: (video) => void,
 *   onDelete?: (video) => Promise<boolean>, onChanged?: (paths: string[]) => void }} opts
 */
export function showDisabledVideosDialog({ settings, videos, onPlay, onDelete, onChanged }) {
  return Modal.open({
    title: t('library.disabled.listTitle'),
    panelClass: 'disabled-videos-panel',
    onRender(body, close) {
      const intro = document.createElement('p');
      intro.className = 'disabled-videos__intro';
      intro.textContent = t('library.disabled.listIntro');
      const count = document.createElement('div');
      count.className = 'disabled-videos__count';
      count.setAttribute('aria-live', 'polite');
      const list = document.createElement('div');
      list.className = 'disabled-videos__list';
      list.setAttribute('role', 'list');
      const footer = document.createElement('div');
      footer.className = 'disabled-videos__footer';
      const enableAll = document.createElement('button');
      enableAll.type = 'button';
      enableAll.className = 'modal-btn modal-btn--secondary disabled-videos__enable-all';
      enableAll.textContent = t('library.disabled.enableAll');
      footer.appendChild(enableAll);
      body.append(intro, count, list, footer);

      const paint = () => {
        const rows = disabledRows(settings, videos);
        list.replaceChildren(...rows.map(rowEl));
        count.textContent = rows.length ? t('library.disabled.listCount', { count: rows.length }) : t('library.disabled.listEmpty');
        enableAll.hidden = rows.length < 2;
      };

      const rowEl = ({ path, video }) => {
        const el = document.createElement('div');
        el.className = 'disabled-videos__row';
        el.setAttribute('role', 'listitem');
        const name = video?.name || nameOf(path);

        const mark = document.createElement('span');
        mark.className = 'disabled-videos__mark';
        mark.setAttribute('aria-hidden', 'true');
        mark.appendChild(icon(Ban, { width: 16, height: 16 }));

        const text = document.createElement('div');
        text.className = 'disabled-videos__text';
        const nameEl = document.createElement('div');
        nameEl.className = 'disabled-videos__name';
        nameEl.textContent = name;
        nameEl.title = path;
        const sub = document.createElement('div');
        sub.className = 'disabled-videos__folder';
        sub.textContent = video ? folderOf(path) : t('library.disabled.notInLibrary');
        text.append(nameEl, sub);

        const play = document.createElement('button');
        play.type = 'button';
        play.className = 'disabled-videos__icon-btn';
        play.appendChild(icon(Play, { width: 16, height: 16 }));
        play.title = t('library.disabled.playAria', { name });
        play.setAttribute('aria-label', t('library.disabled.playAria', { name }));
        play.disabled = !video;
        play.addEventListener('click', () => { close(null); onPlay?.(video); });

        const enable = document.createElement('button');
        enable.type = 'button';
        enable.className = 'modal-btn modal-btn--secondary disabled-videos__enable';
        enable.textContent = t('library.disabled.enable');
        enable.setAttribute('aria-label', t('library.disabled.enableAria', { name }));
        enable.addEventListener('click', () => {
          setDisabled(settings, path, false);
          onChanged?.([path]);
          paint();
          showUndoToast(t('library.disabled.enabledNamed', { name }), () => {
            setDisabled(settings, path, true);
            onChanged?.([path]);
            if (document.body.contains(list)) paint();
          }, 'success', 5000);
        });

        el.append(mark, text, play, enable);
        if (onDelete && video && !video._stream) {
          const del = document.createElement('button');
          del.type = 'button';
          del.className = 'disabled-videos__icon-btn disabled-videos__delete';
          del.appendChild(icon(Trash2, { width: 15, height: 15 }));
          del.title = t('library.disabled.deleteAria', { name });
          del.setAttribute('aria-label', t('library.disabled.deleteAria', { name }));
          del.addEventListener('click', async () => {
            if (await onDelete(video)) paint();
          });
          el.appendChild(del);
        }
        return el;
      };

      enableAll.addEventListener('click', () => {
        const paths = disabledRows(settings, videos).map((r) => r.path);
        const before = { ...(settings.get('library.disabledVideos') || {}) };
        const n = enableVideos(settings, paths);
        onChanged?.(paths);
        paint();
        showUndoToast(t('library.disabled.enabledAll', { count: n }), () => {
          settings.set('library.disabledVideos', { ...(settings.get('library.disabledVideos') || {}), ...before });
          onChanged?.(paths);
          if (document.body.contains(list)) paint();
        }, 'success', 6000);
      });

      paint();
    },
  });
}
