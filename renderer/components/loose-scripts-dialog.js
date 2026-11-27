// "Scripts without a video" (v0.10.1, Library menu): the library's funscripts
// that no video uses (renderer/js/loose-scripts.js), each with Play (the
// script player: renderer/js/script-player.js) and Pair… (pick a video for it;
// the library writes the pairing as Associate Funscript does).
//
// A list, not a grid: a script has no picture.

import { Modal } from './modal.js';
import { t } from '../js/i18n.js';
import { icon, Play, Link, Trash2 } from '../js/icons.js';

/**
 * Videos whose name has every typed word, at most `limit`. Pure.
 * @param {{ name: string, path: string }[]} videos
 * @param {string} query
 * @param {number} [limit]
 */
export function matchVideos(videos, query, limit = 8) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out = [];
  for (const v of videos || []) {
    const name = String(v?.name || '').toLowerCase();
    if (words.every((w) => name.includes(w))) {
      out.push(v);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** The folder a path sits in, for the row's second line. Pure. */
export function folderOf(path) {
  const parts = String(path || '').split(/[\\/]/);
  parts.pop();
  return parts.join(path.includes('\\') ? '\\' : '/');
}

/**
 * @param {object} opts
 * @param {{ name: string, path: string }[]} opts.scripts
 * @param {{ name: string, path: string }[]} opts.videos
 * @param {(script: { name: string, path: string }) => void} opts.onPlay
 * @param {(videoPath: string, script: { name: string, path: string }) => boolean} opts.onPair
 * @returns {Promise<unknown>}
 */
export function showLooseScriptsDialog({ scripts, videos, onPlay, onPair, onDelete, closeWhenEmpty = false }) {
  let remaining = [...(scripts || [])];
  return Modal.open({
    title: t('scriptPlayer.looseTitle'),
    panelClass: 'loose-scripts-panel',
    onRender(body, close) {
      const count = document.createElement('div');
      count.className = 'loose-scripts__count';
      const list = document.createElement('div');
      list.className = 'loose-scripts__list';
      list.setAttribute('role', 'list');
      body.appendChild(count);
      body.appendChild(list);

      const paintCount = () => {
        count.textContent = remaining.length
          ? t('scriptPlayer.looseCount', { count: remaining.length })
          : t('scriptPlayer.looseEmpty');
      };

      const row = (s) => {
        const el = document.createElement('div');
        el.className = 'loose-scripts__row';
        el.setAttribute('role', 'listitem');

        const play = document.createElement('button');
        play.type = 'button';
        play.className = 'loose-scripts__play';
        play.appendChild(icon(Play, { width: 16, height: 16 }));
        play.title = t('scriptPlayer.playAria', { name: s.name });
        play.setAttribute('aria-label', t('scriptPlayer.playAria', { name: s.name }));
        play.addEventListener('click', () => { close(null); onPlay?.(s); });

        const text = document.createElement('div');
        text.className = 'loose-scripts__text';
        const name = document.createElement('div');
        name.className = 'loose-scripts__name';
        name.textContent = s.name;
        name.title = s.path;
        const folder = document.createElement('div');
        folder.className = 'loose-scripts__folder';
        folder.textContent = folderOf(s.path);
        text.append(name, folder);

        const pair = document.createElement('button');
        pair.type = 'button';
        pair.className = 'modal-btn modal-btn--secondary loose-scripts__pair';
        pair.append(icon(Link, { width: 14, height: 14 }), document.createTextNode(` ${t('scriptPlayer.pair')}`));

        const finder = document.createElement('div');
        finder.className = 'loose-scripts__finder';
        finder.hidden = true;
        const input = document.createElement('input');
        input.type = 'search';
        input.className = 'loose-scripts__find';
        input.placeholder = t('scriptPlayer.pairPlaceholder');
        input.setAttribute('aria-label', t('scriptPlayer.pairPlaceholder'));
        const matches = document.createElement('div');
        matches.className = 'loose-scripts__matches';
        finder.append(input, matches);

        const paintMatches = () => {
          matches.replaceChildren();
          const found = matchVideos(videos, input.value);
          if (input.value.trim() && !found.length) {
            const none = document.createElement('div');
            none.className = 'loose-scripts__none';
            none.textContent = t('scriptPlayer.noVideoMatches');
            matches.appendChild(none);
            return;
          }
          for (const v of found) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'loose-scripts__match';
            b.textContent = v.name;
            b.title = v.path;
            b.addEventListener('click', () => {
              if (onPair?.(v.path, s) === false) return;
              remaining = remaining.filter((x) => x.path !== s.path);
              el.remove();
              paintCount();
              // Opened for one script (a card's Pair with a video…): done (T310).
              if (closeWhenEmpty && !remaining.length) close(null);
            });
            matches.appendChild(b);
          }
        };
        input.addEventListener('input', paintMatches);
        pair.addEventListener('click', () => {
          finder.hidden = !finder.hidden;
          if (!finder.hidden) input.focus();
        });

        // Delete (2026-11-23, DESIGN.md §2.18): the delete dialog on top of
        // this list, which says what goes and how; the row leaves once the
        // file has.
        const del = onDelete ? document.createElement('button') : null;
        if (del) {
          del.type = 'button';
          del.className = 'loose-scripts__delete';
          del.appendChild(icon(Trash2, { width: 15, height: 15 }));
          del.title = t('scriptPlayer.deleteAria', { name: s.name });
          del.setAttribute('aria-label', t('scriptPlayer.deleteAria', { name: s.name }));
          del.addEventListener('click', async () => {
            if (!(await onDelete(s))) return;
            remaining = remaining.filter((x) => x.path !== s.path);
            el.remove();
            paintCount();
            if (closeWhenEmpty && !remaining.length) close(null);
          });
        }

        const top = document.createElement('div');
        top.className = 'loose-scripts__top';
        top.append(play, text, pair);
        if (del) top.append(del);
        el.append(top, finder);
        return el;
      };

      for (const s of remaining) list.appendChild(row(s));
      paintCount();
    },
  });
}
