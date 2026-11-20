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
//
// Link-only mode (`mode: 'link'`, 2026-11-18, video options design (c)):
// "Find the post on EroScripts…" in a video's Tags section. The same search,
// but it never searches on its own (one search per press of Search or
// Enter), never opens a post, never downloads and never re-pairs: picking a
// result only hands that post back, and the Tags section links it and gets
// its tags. Every other mode is unchanged.
//
// The login (Dave, 2026-11-18, both modes): logged out, nothing is sent; the
// results say "Log in to EroScripts to search." with a [Log In] button (the
// EroScripts panel's own login), never a silent empty list. Logged in, the
// saved login is checked when the dialog opens and before each search (the
// panel's checkSession: a kept answer, so this is usually no request), and a
// 401 / 403 asks the session check whether the login is really gone.
//
// The query (Dave, 2026-11-18, both modes): it starts as the video's CLEANED
// file name (renderer/js/search-name-clean.js: underscores, dots and + as
// spaces; resolutions, host names, "mp4", "subbed", dates and a trailing
// "(1)" left out), and a search that finds nothing offers ONE button,
// "Search with fewer words", that searches the first few meaningful words
// once per press. Nothing searches again on its own.
//
// Link mode's order (Dave, 2026-11-19): the posts of `preferCreator` (the
// script's creator) first, then the rest, and a creator's index / hub post
// last (renderer/js/eroscripts-hub.js orderLinkResults). Nothing is left out:
// a hub can still be picked on purpose. The download mode's order is the
// forum's, as before.

import { Modal } from './modal.js';
import { showToast } from '../js/toast.js';
import { t } from '../js/i18n.js';
import { joinPath, dirOfPath } from '../js/path-utils.js';
import { groupAttachments, axisLabels, buildMultiAssociation } from '../js/eroscripts-groups.js';
import { createResultThumb } from './result-thumb.js';
import { askReplaceFiles, forgetFetched } from './replace-question.js';
import { binOs } from '../js/recycle-bin.js';
import { eroscriptsErrorText } from '../js/eroscripts-error-text.js';
import { topicMetaOf } from '../js/script-tags.js';
import { cleanSearchName, fewerWordsQuery } from '../js/search-name-clean.js';
import { orderLinkResults } from '../js/eroscripts-hub.js';

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
 * Download one group (its main, plus its axis files unless `mainOnly`).
 *
 * Every target is LOOKED at first (`checkOnly`: fetched and compared, nothing
 * written), and every one that already holds a different file is asked about
 * in ONE "Replace?" question (R3-02). Round 2 made the download refuse to
 * write over a different file, but this route never asked, so with the video
 * already scripted it showed "Download failed", and a different axis file was
 * skipped silently while the new main was written, leaving the OLD axis to
 * pair with the NEW main by name. Now:
 *   - Replace: each existing different file goes to the Recycle Bin / Trash
 *     first (the download IPC does that), then the download is written;
 *   - Cancel: nothing is written, not even the files that were not there;
 *   - the same bytes already there: left alone, no question.
 *
 * With the files decided, `confirmBeforeWrite(savePaths)` (the app's editor
 * hook, R4-07) asks the editor's unsaved-changes question when the editor
 * holds one of these files or the video this is for; Cancel there writes
 * nothing either. A Save at that question can write one of these files, so
 * they are looked at again and one that is there and different now is asked
 * about before anything is written.
 *
 * A Cancel anywhere lets main drop the bytes the look fetched (R4-09).
 *
 * @returns {Promise<{payload: object, written: string[]}|{cancelled: true}|{failed: true, result?: object, name?: string}>}
 *   `payload` is the association for the modal, `written` the paths this
 *   wrote; a set whose main could not be looked at or written fails, since a
 *   multi set with no main is unusable.
 */
async function downloadGroup(group, videoPath, { mainOnly = false, confirmBeforeWrite = null } = {}) {
  if (!group.main) return { failed: true };
  const dir = dirOfPath(videoPath);
  const single = !!mainOnly || !group.canAssociateMulti;

  const items = [{ attachment: group.main, suffix: null }];
  if (!single) for (const entry of group.axes) items.push({ attachment: entry, suffix: entry.axis.suffix });
  for (const it of items) {
    it.name = targetFileName(videoPath, it.suffix);
    it.savePath = joinPath(dir, it.name);
  }
  const lookAt = (it) => window.funsync.eroscriptsDownload(it.attachment.url, it.savePath, { checkOnly: true });
  // Nothing will be written: the bytes the looks fetched need not wait in
  // main for a write (R4-09).
  const forgetAll = () => { for (const it of items) forgetFetched(it.attachment.url); };

  // 1. Look at every file first. Sequential rather than parallel: a courtesy
  // to the forum, and a handful of small files either way. The bytes fetched
  // here are reused by the write.
  for (const it of items) it.look = await lookAt(it);
  const main = items[0];
  if (!main.look?.exists && !main.look?.success) {
    forgetAll();
    return { failed: true, result: main.look, name: main.name };
  }
  // An axis that could not even be fetched is left out, and said so (R4-08):
  // an older file under its name stays beside the new main and would pair
  // with it by name. One that is there and different is asked about with the
  // rest.
  const usable = items.filter((it) => it.look?.exists || it.look?.success);
  const notFetched = items.filter((it) => !usable.includes(it));
  const clashing = usable.filter((it) => it.look?.exists);

  // 2. One question for the whole set.
  if (clashing.length > 0 && !(await askReplaceFiles(clashing.map((it) => it.name)))) {
    forgetAll();
    return { cancelled: true };
  }

  // 3. Unsaved editor edits that these files would replace (R4-07). After an
  // answer that goes on, look again: a Save may have written one of them.
  const editorOk = confirmBeforeWrite ? confirmBeforeWrite(usable.map((it) => it.savePath)) : true;
  if (editorOk !== true) {
    if (!(await editorOk)) {
      forgetAll();
      return { cancelled: true };
    }
    const appeared = [];
    for (const it of usable) {
      if (it.look?.exists) continue;
      const again = await lookAt(it);
      if (again?.exists) { it.look = again; appeared.push(it); }
    }
    if (appeared.length > 0 && !(await askReplaceFiles(appeared.map((it) => it.name)))) {
      forgetAll();
      return { cancelled: true };
    }
  }

  // 4. Write: the main first; without it nothing else is written.
  const saved = new Map(); // attachment name → on-disk path
  const written = [];
  const unchanged = [];
  const notWritten = [];
  for (const it of usable) {
    const result = await window.funsync.eroscriptsDownload(it.attachment.url, it.savePath, { replace: !!it.look?.exists });
    if (result?.success) {
      saved.set(it.attachment.name, it.savePath);
      if (result.unchanged) unchanged.push(it.name);
      else written.push(it.savePath);
      continue;
    }
    console.warn('[EroInline] download failed:', it.attachment.name, result?.error || (result?.exists ? 'exists' : ''));
    if (it === main) {
      forgetAll();
      return { failed: true, result, name: it.name };
    }
    notWritten.push({ result, name: it.name });
    forgetFetched(it.attachment.url);
  }
  // An axis that could not be written: say so, never silently (its old file,
  // if any, is still there and was not replaced).
  for (const { result, name } of notWritten) showToast(failureText(result, name), 'warn', 6000);
  for (const it of notFetched) showToast(t('eroscripts.notDownloaded', { name: it.name }), 'warn', 6000);
  // Every file was already there with the same bytes: nothing was written,
  // and nothing else would say so (R4-10).
  if (written.length === 0 && notWritten.length === 0 && notFetched.length === 0 && unchanged.length > 0) {
    showToast(t('eroscripts.alreadyUpToDate', { name: unchanged.join(', ') }), 'info');
  }

  if (single) return { payload: { mode: 'single', path: main.savePath, name: main.name }, written };
  const multi = buildMultiAssociation(group, (name) => saved.get(name) || '');
  if (!multi) return { payload: { mode: 'single', path: main.savePath, name: main.name }, written };
  return { payload: { mode: 'multi', main: multi.main, axes: multi.axes, buttplugVib: false }, written };
}

/** What a failed download says: the bin failure in the user's language. */
function failureText(result, name) {
  if (result?.trashFailed) return t('eroscripts.trashFailed', { name, os: binOs() });
  if (result?.exists) return t('eroscripts.notReplaced', { name });
  return t('eroscripts.downloadFailed');
}

/**
 * How the search reaches the EroScripts login: the caller's (`given`, the
 * Tags section passes its own), else the EroScripts panel's (window.app, the
 * same login, session check and expiry as the panel's own search), else
 * main's session for "logged in" only.
 * @param {{isLoggedIn?: Function, login?: Function, checkSession?: Function,
 *   sessionExpired?: Function}|null} given
 */
function loginAccess(given) {
  const g = given && typeof given === 'object' ? given : {};
  const app = typeof window !== 'undefined' ? window.app : null;
  const panel = app?.eroscriptsPanel && typeof app.eroscriptsPanel === 'object' ? app.eroscriptsPanel : null;
  const fn = (name, panelFn) => {
    if (typeof g[name] === 'function') return g[name];
    return panel && typeof panel[panelFn] === 'function' ? (...args) => panel[panelFn](...args) : null;
  };
  return {
    /** true / false; null when nothing can tell (main decides then, and sends nothing logged out). */
    async isLoggedIn() {
      try {
        if (typeof g.isLoggedIn === 'function') return (await g.isLoggedIn()) === true;
        if (panel && typeof panel.isLoggedIn === 'boolean') return panel.isLoggedIn;
        const ask = typeof window !== 'undefined' ? window.funsync?.eroscriptsStatus : null;
        if (typeof ask === 'function') return (await ask())?.loggedIn === true;
      } catch {
        return null;
      }
      return null;
    },
    login: fn('login', 'login'),
    checkSession: fn('checkSession', 'checkSession'),
    sessionExpired: fn('sessionExpired', 'handleSessionExpired'),
  };
}

/**
 * Open the search dialog for a video.
 *
 * @param {{path: string, name: string}} video
 * @param {{confirmBeforeWrite?: (savePaths: string[]) => true|Promise<boolean>,
 *   mode?: 'download'|'link', onAuthExpired?: () => unknown,
 *   eroscripts?: {isLoggedIn?: Function, login?: Function, checkSession?: Function,
 *   sessionExpired?: Function}}} [opts]
 *   `confirmBeforeWrite`: the app's unsaved-editor-edits hook (R4-07), asked
 *   after "Replace?" and before anything is written.
 *   `mode: 'link'`: link only (see the header): no search until a press, no
 *   post opened, nothing downloaded. `onAuthExpired` (link mode): called
 *   when the forum refuses the session (401 / 403), in place of the panel's
 *   handleSessionExpired (which asks the session check), so both paths agree.
 *   `eroscripts`: the login to use (see loginAccess); default the panel's.
 *   `preferCreator` (link mode): that creator's posts first, hub posts last
 *   (orderLinkResults, 2026-11-19).
 * @returns {Promise<object|null>} an association payload for the Associate
 *   modal's consumer (`{mode:'single'|'multi', ..., topic, topicAnswer,
 *   written}`: `written` are the paths the download wrote, `topic` the search
 *   result, `topicAnswer` the topic JSON's tags / title / creator,
 *   script-tags.js topicMetaOf), or null if cancelled. Link mode:
 *   `{mode: 'link', topic: {id, title, url, creator}}` or null.
 */
export function showEroScriptsSearchModal(video, { confirmBeforeWrite = null, mode = 'download', onAuthExpired = null, eroscripts = null, preferCreator = null } = {}) {
  const linkOnly = mode === 'link';
  const access = loginAccess(eroscripts);
  return Modal.open({
    title: linkOnly ? t('videoOptions.tags.find.title') : t('eroscripts.inline.title'),
    onRender: (body, close) => {
      const searchRow = document.createElement('div');
      searchRow.className = 'eroscripts-panel__input-row';

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'eroscripts-panel__input eroscripts-panel__search-input';
      input.placeholder = t('eroscripts.searchPlaceholder');
      // Seeded from the filename, cleaned (Dave, 2026-11-18): a post title
      // has no "1080p", "bunkr" or underscores, and extra words in the query
      // make the forum's search miss it.
      input.value = cleanSearchName(video?.name || video?.path || '') || stemOf(video?.name || video?.path || '');

      const searchBtn = document.createElement('button');
      searchBtn.type = 'button';
      searchBtn.className = 'eroscripts-panel__btn';
      searchBtn.textContent = t('eroscripts.search');

      searchRow.append(input, searchBtn);
      body.appendChild(searchRow);

      if (linkOnly) {
        const hint = document.createElement('p');
        hint.className = 'eroscripts-inline__note';
        hint.textContent = t('videoOptions.tags.find.hint');
        body.appendChild(hint);
      }

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

      // ---- the login (Dave, 2026-11-18) ----

      /**
       * Logged in, with the saved login still good? Logged out: false, and
       * nothing is asked. Logged in: the session check (a kept answer, so
       * usually no request); a timed-out login is dropped there and reads as
       * logged out. Nothing can tell (no panel, no status): true, and main
       * sends nothing logged out anyway.
       */
      const ready = async () => {
        const loggedIn = await access.isLoggedIn();
        if (loggedIn === false) return false;
        if (loggedIn === true && access.checkSession) {
          try { await access.checkSession(); } catch { /* could not check: changes nothing */ }
          return (await access.isLoggedIn()) !== false;
        }
        return true;
      };

      /**
       * The forum refused the session (401 / 403): the session check decides
       * (link mode: the caller's onAuthExpired; else the panel's
       * handleSessionExpired). True when the login is gone now.
       */
      const sessionRefused = async () => {
        const check = linkOnly && typeof onAuthExpired === 'function' ? onAuthExpired : access.sessionExpired;
        if (typeof check === 'function') {
          try { await check(); } catch { /* the words below still show */ }
        }
        return (await access.isLoggedIn()) === false;
      };

      // A search the login stopped runs once after the login (in link mode
      // too: the user pressed Search for it).
      let searchWaitsForLogin = false;
      let loginBusy = false;
      const focusIfLost = (node) => {
        const active = document.activeElement;
        if (node && (!active || active === document.body || active === document.documentElement)) node.focus();
      };

      /** "Log in to EroScripts to search." with [Log In]; nothing was sent. */
      const showLoginNeeded = () => {
        results.innerHTML = '';
        const box = document.createElement('div');
        box.className = 'eroscripts-panel__placeholder eroscripts-panel__login-needed';
        const text = document.createElement('div');
        text.textContent = t('eroscripts.loginToSearch');
        box.appendChild(text);
        if (typeof access.login === 'function') {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'eroscripts-panel__btn eroscripts-panel__login-needed-btn';
          btn.textContent = t('eroscripts.logIn');
          btn.addEventListener('click', async () => {
            if (loginBusy) return;
            loginBusy = true;
            btn.disabled = true;
            btn.textContent = t('eroscripts.waitingLogin');
            let ok = false;
            try { ok = (await access.login()) === true; } catch { ok = false; }
            loginBusy = false;
            if (!body.isConnected) return; // closed meanwhile
            if (!ok) {
              showLoginNeeded();
              focusIfLost(results.querySelector('.eroscripts-panel__login-needed-btn'));
              return;
            }
            focusIfLost(input);
            const again = searchWaitsForLogin || !linkOnly;
            searchWaitsForLogin = false;
            if (again && input.value.trim()) doSearch();
            else setMessage(linkOnly ? t('videoOptions.tags.find.prompt') : t('eroscripts.placeholder'));
          });
          box.appendChild(btn);
        }
        results.appendChild(box);
      };

      /**
       * Render the groups for one topic, under its row. `topicMeta` is what
       * the topic JSON said about the post (getTopicAttachments: its tags
       * with ids, title, creator), handed out with the pick so the download's
       * record uses it over the search result's (RB-2).
       */
      const renderGroups = (host, topic, groups, unsupported, topicMeta = null) => {
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
              const outcome = await downloadGroup(group, video.path, { ...opts, confirmBeforeWrite });
              if (outcome.payload) {
                // The topic rides along so the caller can record its tags
                // next to where it applies the association — this modal has
                // no business touching the store. `topicAnswer` is the topic
                // JSON's own tags, title and creator (script-tags.js
                // recordDownloadTags).
                close({ ...outcome.payload, topic, topicAnswer: topicMeta, written: outcome.written || [] });
                return;
              }
              for (const b of actions.querySelectorAll('button')) b.disabled = false;
              btn.textContent = original;
              // Cancel at "Replace?" is the user's answer, not a failure.
              if (!outcome.cancelled) showToast(failureText(outcome.result, outcome.name), 'error');
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

        const topicAnswer = await window.funsync.eroscriptsTopic(topic.id);
        const { attachments = [], error, authExpired } = topicAnswer;
        toggleBtn.disabled = false;

        if (authExpired) {
          // The session check decides: gone, or refused for another reason.
          const gone = await sessionRefused();
          host.textContent = gone ? t('eroscripts.sessionExpired') : eroscriptsErrorText(topicAnswer);
          return;
        }
        if (error) {
          host.textContent = eroscriptsErrorText(topicAnswer);
          return;
        }

        const { groups, unsupported } = groupAttachments(attachments);
        host.dataset.loaded = '1';
        renderGroups(host, topic, groups, unsupported, topicMetaOf(topicAnswer));
      };

      /**
       * Link mode: one result as a row with a "Link this post" button. The
       * post is never opened here (that would be a request for its files);
       * the pick only hands it back. Title and creator are the forum's
       * text: textContent only.
       */
      const renderLinkResult = (topic) => {
        const card = document.createElement('div');
        card.className = 'eroscripts-inline__result eroscripts-inline__result--link';

        const head = document.createElement('div');
        head.className = 'eroscripts-inline__result-head';
        head.appendChild(createResultThumb({
          thumbnail: topic.thumbnail,
          avatar: topic.avatar,
          className: 'eroscripts-inline__result-thumb',
        }));

        const info = document.createElement('div');
        info.className = 'eroscripts-inline__result-info';
        const title = document.createElement('div');
        title.className = 'eroscripts-panel__result-title';
        title.textContent = topic.title || '';
        title.title = topic.title || '';
        info.appendChild(title);
        const meta = document.createElement('div');
        meta.className = 'eroscripts-panel__result-meta';
        const bits = [];
        if (topic.creator) bits.push(`@${topic.creator}`);
        if (topic.likeCount > 0) bits.push(t('eroscripts.likes', { count: topic.likeCount }));
        meta.textContent = bits.join(' · ');
        info.appendChild(meta);
        head.appendChild(info);

        const pick = document.createElement('button');
        pick.type = 'button';
        pick.className = 'eroscripts-panel__btn eroscripts-inline__link-btn';
        pick.textContent = t('videoOptions.tags.find.pick');
        pick.setAttribute('aria-label', t('videoOptions.tags.find.pickAria', { title: topic.title || String(topic.id) }));
        pick.addEventListener('click', () => {
          close({
            mode: 'link',
            topic: {
              id: topic.id,
              title: typeof topic.title === 'string' ? topic.title : null,
              url: typeof topic.url === 'string' ? topic.url : null,
              creator: typeof topic.creator === 'string' ? topic.creator : null,
            },
          });
        });
        head.appendChild(pick);
        card.appendChild(head);
        results.appendChild(card);
      };

      const renderResults = (found) => {
        results.innerHTML = '';
        const list = linkOnly ? orderLinkResults(found, preferCreator) : found;
        for (const topic of list) {
          if (linkOnly) {
            renderLinkResult(topic);
            continue;
          }
          const card = document.createElement('div');
          card.className = 'eroscripts-inline__result';

          const head = document.createElement('button');
          head.type = 'button';
          head.className = 'eroscripts-inline__result-head';

          // Visual reference matters most here: a filename-seeded query can
          // return 50 similarly-titled posts, and the preview frame is the
          // fastest way to tell which one is the right video.
          head.appendChild(createResultThumb({
            thumbnail: topic.thumbnail,
            avatar: topic.avatar,
            className: 'eroscripts-inline__result-thumb',
          }));

          const info = document.createElement('div');
          info.className = 'eroscripts-inline__result-info';

          const title = document.createElement('div');
          title.className = 'eroscripts-panel__result-title';
          title.textContent = topic.title;
          title.title = topic.title;
          info.appendChild(title);

          const meta = document.createElement('div');
          meta.className = 'eroscripts-panel__result-meta';
          const bits = [];
          if (topic.creator) bits.push(`@${topic.creator}`);
          if (topic.likeCount > 0) bits.push(t('eroscripts.likes', { count: topic.likeCount }));
          meta.textContent = bits.join(' · ');
          info.appendChild(meta);

          // The multi-axis tag is worth surfacing before the post is opened
          // — it's the single most useful thing about a result here.
          if ((topic.tags || []).includes('multi-axis')) {
            const badge = document.createElement('span');
            badge.className = 'eroscripts-inline__badge';
            badge.textContent = t('eroscripts.inline.multiBadge');
            info.appendChild(badge);
          }
          head.appendChild(info);

          const host = document.createElement('div');
          host.className = 'eroscripts-inline__groups';
          host.hidden = true;

          head.addEventListener('click', () => openTopic(topic, host, head));
          card.append(head, host);
          results.appendChild(card);
        }
      };

      /**
       * Nothing found for `query`: say so, and offer ONE "Search with fewer
       * words" when the query has a shorter form (its first few meaningful
       * words). A press searches that once; it never runs on its own.
       */
      const showNoResults = (query) => {
        results.innerHTML = '';
        const box = document.createElement('div');
        box.className = 'eroscripts-panel__placeholder eroscripts-panel__no-results';
        const text = document.createElement('div');
        text.textContent = t('eroscripts.noResultsTitle', { query });
        box.appendChild(text);
        const fewer = fewerWordsQuery(query);
        if (fewer) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'eroscripts-panel__btn eroscripts-panel__btn--secondary eroscripts-panel__fewer-words';
          btn.textContent = t('eroscripts.fewerWords');
          btn.title = t('eroscripts.fewerWordsTitle', { query: fewer });
          btn.addEventListener('click', () => {
            if (searching) return;
            input.value = fewer;
            doSearch();
            focusIfLost(input);
          });
          box.appendChild(btn);
        }
        results.appendChild(box);
      };

      let searching = false;
      const doSearch = async () => {
        const query = input.value.trim();
        if (!query || searching) return;
        searching = true;
        setMessage(t('eroscripts.searching'));

        // Logged out (or the saved login just found dead): nothing is sent.
        if (!(await ready())) {
          searching = false;
          searchWaitsForLogin = true;
          return showLoginNeeded();
        }

        const searchAnswer = await window.funsync.eroscriptsSearch(query);
        const { results: list = [], error, authExpired } = searchAnswer;
        searching = false;

        // Main had no login to send: nothing was sent.
        if (searchAnswer?.loginRequired) {
          searchWaitsForLogin = true;
          return showLoginNeeded();
        }
        if (authExpired) {
          // The session check decides (link mode: the caller's onAuthExpired,
          // which drops a dead session as the panel's search does).
          if (await sessionRefused()) return showLoginNeeded();
          return setMessage(eroscriptsErrorText(searchAnswer), ' eroscripts-panel__placeholder--error');
        }
        if (error) return setMessage(eroscriptsErrorText(searchAnswer), ' eroscripts-panel__placeholder--error');
        if (list.length === 0) return showNoResults(query);
        renderResults(list);
      };

      searchBtn.addEventListener('click', doSearch);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doSearch();
      });

      // Link mode never searches on its own (Dave, 2026-11-17, answer 2: a
      // search the user starts, once per press). Its login is checked as it
      // opens; logged out it asks to log in at once.
      if (linkOnly) {
        setMessage(t('videoOptions.tags.find.prompt'));
        ready().then((ok) => {
          if (!ok && body.isConnected && !searching) showLoginNeeded();
        }, () => { /* changes nothing */ });
        return;
      }

      // Search straight away — the seeded query is right often enough that
      // making the user press a button first is a wasted step. (Logged out,
      // it asks to log in instead and sends nothing.)
      if (input.value.trim()) doSearch();
      else ready().then((ok) => {
        if (!ok && body.isConnected && !searching) showLoginNeeded();
      }, () => { /* changes nothing */ });
    },
  });
}
