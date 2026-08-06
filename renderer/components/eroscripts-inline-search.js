// Find a script on EroScripts for ONE specific video, from inside the
// Associate Funscript flow.
//
// The standalone EroScripts panel always targets the currently-LOADED video,
// so attaching a script to something in the library meant opening it first,
// downloading, then backing out again. This targets the video you opened the
// association modal on, and handles multi-axis posts as sets rather than as
// a flat list of files.
//
// Community request, 2026-08-06.

import { Modal } from './modal.js';
import { showToast } from '../js/toast.js';
import { t } from '../js/i18n.js';
import { joinPath, dirOfPath } from '../js/path-utils.js';
import { groupAttachments, axisLabels, buildMultiAssociation } from '../js/eroscripts-groups.js';

/** `D:/v/Some Video.mp4` → `Some Video` */
function stemOf(p) {
  return String(p || '').split(/[\\/]/).pop().replace(/\.[^/.]+$/, '');
}

/**
 * Target filename for a downloaded script.
 *
 * Renamed to the VIDEO's base name, keeping any axis suffix. That's what
 * makes both auto-pairing (funscript matched to video by filename) and
 * companion detection (axes matched to their main by base name) find these
 * later — the EroScripts base name would satisfy neither.
 */
export function targetFileName(videoPath, axisSuffix) {
  const base = stemOf(videoPath);
  return axisSuffix ? `${base}.${axisSuffix}.funscript` : `${base}.funscript`;
}

/**
 * Download one group and return an association payload for the modal.
 * Returns null if the main failed — a multi set with no main is unusable.
 */
async function downloadGroup(group, videoPath, { mainOnly = false } = {}) {
  const dir = dirOfPath(videoPath);
  const saved = new Map(); // attachment name → on-disk path

  const fetchOne = async (attachment, suffix) => {
    const name = targetFileName(videoPath, suffix);
    const savePath = joinPath(dir, name);
    const { success, error } = await window.funsync.eroscriptsDownload(attachment.url, savePath);
    if (success) saved.set(attachment.name, savePath);
    else if (error) console.warn('[EroInline] download failed:', attachment.name, error);
    return success ? savePath : '';
  };

  const mainPath = group.main ? await fetchOne(group.main, null) : '';
  if (!mainPath) return null;

  if (mainOnly || !group.canAssociateMulti) {
    return { mode: 'single', path: mainPath, name: targetFileName(videoPath, null) };
  }

  // Axes are fetched sequentially rather than in parallel: this is a
  // courtesy to the forum, and a handful of small files either way.
  for (const entry of group.axes) await fetchOne(entry, entry.axis.suffix);

  const multi = buildMultiAssociation(group, (name) => saved.get(name) || '');
  if (!multi) return { mode: 'single', path: mainPath, name: targetFileName(videoPath, null) };
  return { mode: 'multi', main: multi.main, axes: multi.axes, buttplugVib: false };
}

/**
 * Open the search dialog for a video.
 *
 * @param {{path: string, name: string}} video
 * @returns {Promise<object|null>} an association payload for the Associate
 *   modal's consumer (`{mode:'single'|'multi', ...}`), or null if cancelled.
 */
export function showEroScriptsSearchModal(video) {
  return Modal.open({
    title: t('eroscripts.inline.title'),
    onRender: (body, close) => {
      const searchRow = document.createElement('div');
      searchRow.className = 'eroscripts-panel__input-row';

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'eroscripts-panel__input eroscripts-panel__search-input';
      input.placeholder = t('eroscripts.searchPlaceholder');
      // Seeded from the filename — the same query the auto-match toast uses,
      // so the first search is usually the right one.
      input.value = stemOf(video?.name || video?.path || '');

      const searchBtn = document.createElement('button');
      searchBtn.type = 'button';
      searchBtn.className = 'eroscripts-panel__btn';
      searchBtn.textContent = t('eroscripts.search');

      searchRow.append(input, searchBtn);
      body.appendChild(searchRow);

      const results = document.createElement('div');
      results.className = 'eroscripts-panel__results eroscripts-inline__results';
      body.appendChild(results);

      const setMessage = (text, modifier = '') => {
        results.innerHTML = '';
        const el = document.createElement('div');
        el.className = `eroscripts-panel__placeholder${modifier}`;
        el.textContent = text;
        results.appendChild(el);
      };

      /** Render the groups for one topic, under its row. */
      const renderGroups = (host, topic, groups, unsupported) => {
        host.innerHTML = '';

        if (groups.length === 0) {
          const none = document.createElement('div');
          none.className = 'eroscripts-inline__note';
          none.textContent = t('eroscripts.inline.noAttachments');
          host.appendChild(none);
        }

        for (const group of groups) {
          const row = document.createElement('div');
          row.className = 'eroscripts-inline__group';

          const label = document.createElement('div');
          label.className = 'eroscripts-inline__group-name';
          label.textContent = group.base;
          label.title = group.main?.name || group.base;
          row.appendChild(label);

          if (group.isMultiAxis) {
            const axes = document.createElement('div');
            axes.className = 'eroscripts-inline__group-axes';
            axes.textContent = t('eroscripts.inline.axesLine', {
              count: group.axes.length,
              list: axisLabels(group).join(', '),
            });
            row.appendChild(axes);
          }

          const actions = document.createElement('div');
          actions.className = 'eroscripts-inline__group-actions';

          // An axis set with no main can't be associated — say so instead of
          // offering a button that would fail.
          if (!group.main) {
            const note = document.createElement('div');
            note.className = 'eroscripts-inline__note';
            note.textContent = t('eroscripts.inline.noMain');
            actions.appendChild(note);
          } else {
            const run = async (btn, opts) => {
              const original = btn.textContent;
              for (const b of actions.querySelectorAll('button')) b.disabled = true;
              btn.textContent = t('eroscripts.inline.downloading');
              const payload = await downloadGroup(group, video.path, opts);
              if (payload) {
                // The topic rides along so the caller can record its tags
                // next to where it applies the association — this modal has
                // no business touching the store.
                close({ ...payload, topic });
              } else {
                for (const b of actions.querySelectorAll('button')) b.disabled = false;
                btn.textContent = original;
                showToast(t('eroscripts.downloadFailed'), 'error');
              }
            };

            if (group.canAssociateMulti) {
              const allBtn = document.createElement('button');
              allBtn.type = 'button';
              allBtn.className = 'eroscripts-panel__btn';
              allBtn.textContent = t('eroscripts.inline.downloadAll', { count: group.axes.length });
              allBtn.addEventListener('click', () => run(allBtn, {}));

              const mainBtn = document.createElement('button');
              mainBtn.type = 'button';
              mainBtn.className = 'eroscripts-panel__btn eroscripts-panel__btn--secondary';
              mainBtn.textContent = t('eroscripts.inline.downloadMainOnly');
              mainBtn.addEventListener('click', () => run(mainBtn, { mainOnly: true }));

              actions.append(allBtn, mainBtn);
            } else {
              const btn = document.createElement('button');
              btn.type = 'button';
              btn.className = 'eroscripts-panel__btn';
              btn.textContent = t('eroscripts.inline.download');
              btn.addEventListener('click', () => run(btn, {}));
              actions.appendChild(btn);
            }
          }

          row.appendChild(actions);
          host.appendChild(row);
        }

        if (unsupported.length > 0) {
          const zip = document.createElement('div');
          zip.className = 'eroscripts-inline__note';
          zip.textContent = t('eroscripts.inline.zipNote', { count: unsupported.length });
          host.appendChild(zip);
        }
      };

      const openTopic = async (topic, host, toggleBtn) => {
        if (host.dataset.loaded === '1') {
          host.hidden = !host.hidden;
          return;
        }
        host.hidden = false;
        host.textContent = t('eroscripts.inline.loadingPost');
        toggleBtn.disabled = true;

        const { attachments = [], error, authExpired } =
          await window.funsync.eroscriptsTopic(topic.id);
        toggleBtn.disabled = false;

        if (authExpired) {
          host.textContent = t('eroscripts.sessionExpired');
          return;
        }
        if (error) {
          host.textContent = error;
          return;
        }

        const { groups, unsupported } = groupAttachments(attachments);
        host.dataset.loaded = '1';
        renderGroups(host, topic, groups, unsupported);
      };

      const renderResults = (list) => {
        results.innerHTML = '';
        for (const topic of list) {
          const card = document.createElement('div');
          card.className = 'eroscripts-inline__result';

          const head = document.createElement('button');
          head.type = 'button';
          head.className = 'eroscripts-inline__result-head';

          const title = document.createElement('div');
          title.className = 'eroscripts-panel__result-title';
          title.textContent = topic.title;
          title.title = topic.title;
          head.appendChild(title);

          const meta = document.createElement('div');
          meta.className = 'eroscripts-panel__result-meta';
          const bits = [];
          if (topic.creator) bits.push(`@${topic.creator}`);
          if (topic.likeCount > 0) bits.push(t('eroscripts.likes', { count: topic.likeCount }));
          meta.textContent = bits.join(' · ');
          head.appendChild(meta);

          // The multi-axis tag is worth surfacing before the post is opened
          // — it's the single most useful thing about a result here.
          if ((topic.tags || []).includes('multi-axis')) {
            const badge = document.createElement('span');
            badge.className = 'eroscripts-inline__badge';
            badge.textContent = t('eroscripts.inline.multiBadge');
            head.appendChild(badge);
          }

          const host = document.createElement('div');
          host.className = 'eroscripts-inline__groups';
          host.hidden = true;

          head.addEventListener('click', () => openTopic(topic, host, head));
          card.append(head, host);
          results.appendChild(card);
        }
      };

      let searching = false;
      const doSearch = async () => {
        const query = input.value.trim();
        if (!query || searching) return;
        searching = true;
        setMessage(t('eroscripts.searching'));

        const { results: list = [], error, authExpired } =
          await window.funsync.eroscriptsSearch(query);
        searching = false;

        if (authExpired) return setMessage(t('eroscripts.sessionExpired'), ' eroscripts-panel__placeholder--error');
        if (error) return setMessage(error, ' eroscripts-panel__placeholder--error');
        if (list.length === 0) return setMessage(t('eroscripts.noResultsTitle', { query }));
        renderResults(list);
      };

      searchBtn.addEventListener('click', doSearch);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doSearch();
      });

      // Search straight away — the seeded query is right often enough that
      // making the user press a button first is a wasted step.
      doSearch();
    },
  });
}
