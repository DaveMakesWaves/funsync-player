// Find in Stash… (Stash S1, Round 2 stage 2c, 2026-11-18;
// notes/features/DESIGN-stash-s1.md (b) "Ambiguity and how you resolve it",
// (f) "The video options dialog").
//
// A search box stacked on the video options dialog, for one video with no
// Stash link (a re-encode whose fingerprint Stash does not know, a file
// Stash never scanned). You type and press Search (or Enter): exactly ONE
// search goes to Stash per press (main's findScenes(filter: {q, per_page:
// 20}) behind `search`), never as you type, never on open, and never while
// the last one is still running. Each result has its own Link button; the
// picker then closes with that scene and the caller links it (`by:
// 'manual'`). Link only: nothing is fetched, synced or changed here, and
// nothing in Stash ever changes.
//
// Untrusted text (titles, codes, studios and file names from Stash) goes in
// with textContent only, never innerHTML.

import { Modal } from './modal.js';
import { t } from '../js/i18n.js';

/** Stash's client refuses longer search text (stash-client.js MAX_SEARCH_LENGTH). */
export const MAX_QUERY = 200;
const MAX_TEXT = 500;
const MAX_RESULTS = 50;

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1f\x7f]/;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

// Text from Stash the picker may show: a well-formed string, trimmed, not
// too long (a lone surrogate or an oversized value shows nothing).
function text(value, max = MAX_TEXT) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s || s.length > max) return null;
  if (typeof s.isWellFormed === 'function' && !s.isWellFormed()) return null;
  return s;
}

// Scene ids are opaque strings ('12', or '12@<server>' for another
// server's): kept exactly as given and handed back so, never parsed.
function idOf(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value !== 'string' || !value || value.length > 300 || CONTROL_RE.test(value)) return null;
  return typeof value.isWellFormed !== 'function' || value.isWellFormed() ? value : null;
}

function baseName(path) {
  return typeof path === 'string' ? path.split(/[\\/]/).pop() || '' : '';
}

/** What the search box starts with: the video's file name without its extension. */
export function stashSearchSeed(video) {
  const name = baseName(video?.name || video?.path || '');
  const stem = name.replace(/\.[^.]{1,8}$/, '').trim();
  return stem.length <= MAX_QUERY && !CONTROL_RE.test(stem) ? stem : stem.slice(0, MAX_QUERY).replace(CONTROL_RE, ' ');
}

/** Is `query` something one press may send? (trimmed, 1-200 characters, no control characters) */
export function isSendableQuery(query) {
  const q = typeof query === 'string' ? query.trim() : '';
  return !!q && q.length <= MAX_QUERY && !CONTROL_RE.test(q);
}

/**
 * The search answer as the picker shows it. Accepts what main hands back
 * (`{ok, count, scenes}`, the client's `{count, scenes}`, or a list) and a
 * failure (`{ok: false, code}` / `{ok: false, error: {code}}`).
 *
 * @returns {{ok: true, count: number, scenes: object[]} | {ok: false, code: string}}
 */
export function normalizeStashResults(answer) {
  if (isPlainObject(answer) && answer.ok === false) {
    const code = typeof answer.code === 'string' ? answer.code
      : (isPlainObject(answer.error) && typeof answer.error.code === 'string' ? answer.error.code
        : (typeof answer.error === 'string' ? answer.error : 'failed'));
    return { ok: false, code };
  }
  const list = Array.isArray(answer) ? answer : (isPlainObject(answer) && Array.isArray(answer.scenes) ? answer.scenes : null);
  if (!list) return { ok: false, code: 'notStash' };
  const scenes = [];
  const seen = new Set();
  for (const raw of list) {
    if (scenes.length >= MAX_RESULTS) break;
    if (!isPlainObject(raw)) continue;
    const id = idOf(raw.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const file = Array.isArray(raw.files) ? raw.files.find(isPlainObject) : null;
    const duration = typeof file?.duration === 'number' && Number.isFinite(file.duration) && file.duration >= 0 ? file.duration : null;
    scenes.push({
      id,
      title: text(raw.title),
      code: text(raw.code, 200),
      date: text(raw.date, 40),
      studio: text(isPlainObject(raw.studio) ? raw.studio.name : raw.studio, 200),
      fileName: text(baseName(file?.name ?? file?.path), 1024),
      duration,
    });
  }
  const count = isPlainObject(answer) && Number.isSafeInteger(answer.count) && answer.count >= scenes.length ? answer.count : scenes.length;
  return { ok: true, count, scenes };
}

function clock(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** A scene's name as the picker and the dialog show it (its title, else "Scene <id>"). */
export function stashSceneName(scene) {
  if (scene?.title) return t('videoOptions.stash.sceneTitle', { title: scene.title });
  // Another server's scene carries '@<server>' after its id: the number is enough to show.
  const id = scene?.id == null ? '?' : String(scene.id).split('@')[0] || '?';
  return t('videoOptions.stash.untitled', { id });
}

/**
 * Open Find in Stash… over the dialog.
 *
 * @param {object} opts
 * @param {object} [opts.video] the library video (its name seeds the box)
 * @param {(query: string) => Promise<object>} opts.search one Stash search (main)
 * @param {(code: string) => string} [opts.errorText] the words for a failure code
 * @param {(seconds: number) => string} [opts.formatDuration]
 * @returns {Promise<{id: string, title: string|null, date: string|null, studio: string|null}|null>}
 *   the scene picked, or null (closed, Escape, Cancel)
 */
export function openStashScenePicker({ video = null, search, errorText = null, formatDuration = null } = {}) {
  const words = (code) => {
    let s = null;
    try { s = typeof errorText === 'function' ? errorText(code) : null; } catch { s = null; }
    return typeof s === 'string' && s ? s : t('videoOptions.stash.error.generic');
  };
  const length = (sec) => {
    try { if (typeof formatDuration === 'function') return formatDuration(sec); } catch { /* own format below */ }
    return clock(sec);
  };
  let input = null;
  return Modal.open({
    title: t('stash.picker.title'),
    panelClass: 'modal-panel--stash-picker',
    initialFocus: () => input,
    onRender: (body, close) => {
      body.classList.add('stash-picker');
      const row = el('div', 'stash-picker__search');
      const label = el('label', 'stash-picker__label', t('stash.picker.label'));
      input = document.createElement('input');
      input.type = 'search';
      input.className = 'modal-input stash-picker__input';
      input.id = `stash-picker-q-${Math.random().toString(36).slice(2, 9)}`;
      label.htmlFor = input.id;
      input.placeholder = t('stash.picker.placeholder');
      input.maxLength = MAX_QUERY;
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.value = stashSearchSeed(video);
      const go = el('button', 'modal-btn modal-btn--primary stash-picker__go', t('stash.picker.search'));
      go.type = 'button';
      const line = el('div', 'stash-picker__line');
      line.append(input, go);
      row.append(label, line);

      const hint = el('p', 'video-options__note stash-picker__hint', t('stash.picker.hint'));
      const status = el('p', 'video-options__note stash-picker__status', t('stash.picker.prompt'));
      status.setAttribute('role', 'status');
      const list = el('ul', 'stash-picker__results');
      list.setAttribute('aria-label', t('stash.picker.resultsAria'));
      list.hidden = true;
      body.append(row, hint, status, list);

      let running = false;

      const show = (answer, query) => {
        list.replaceChildren();
        if (!answer.ok) {
          status.textContent = words(answer.code);
          status.classList.add('stash-picker__status--error');
          list.hidden = true;
          return;
        }
        status.classList.remove('stash-picker__status--error');
        if (answer.scenes.length === 0) {
          status.textContent = t('stash.picker.none', { query });
          list.hidden = true;
          return;
        }
        status.textContent = answer.count > answer.scenes.length
          ? t('stash.picker.someOf', { shown: answer.scenes.length, count: answer.count })
          : t('stash.picker.found', { count: answer.scenes.length });
        for (const scene of answer.scenes) {
          const li = el('li', 'stash-picker__result');
          const info = el('div', 'stash-picker__info');
          info.appendChild(el('span', 'stash-picker__title', stashSceneName(scene)));
          const bits = [scene.code, scene.date, scene.studio, scene.fileName,
            scene.duration != null ? length(scene.duration) : null].filter(Boolean);
          if (bits.length) info.appendChild(el('span', 'stash-picker__meta', bits.join(' · ')));
          const pick = el('button', 'modal-btn modal-btn--secondary stash-picker__link', t('stash.picker.link'));
          pick.type = 'button';
          pick.setAttribute('aria-label', t('stash.picker.linkAria', { name: stashSceneName(scene) }));
          pick.addEventListener('click', () => close({
            id: scene.id, title: scene.title, date: scene.date, studio: scene.studio,
          }));
          li.append(info, pick);
          list.appendChild(li);
        }
        list.hidden = false;
      };

      // One search per press; a press while one runs sends nothing.
      const doSearch = async () => {
        if (running) return;
        const query = input.value.trim();
        if (!isSendableQuery(query)) {
          status.textContent = t('stash.picker.prompt');
          input.focus();
          return;
        }
        running = true;
        go.setAttribute('aria-disabled', 'true');
        body.setAttribute('aria-busy', 'true');
        status.classList.remove('stash-picker__status--error');
        status.textContent = t('stash.picker.searching');
        let answer;
        try {
          answer = normalizeStashResults(typeof search === 'function' ? await search(query) : { ok: false, code: 'failed' });
        } catch (err) {
          answer = { ok: false, code: typeof err?.code === 'string' ? err.code : 'failed' };
        }
        running = false;
        if (!body.isConnected) return; // closed meanwhile: the answer is dropped
        go.removeAttribute('aria-disabled');
        body.setAttribute('aria-busy', 'false');
        show(answer, query);
      };

      go.addEventListener('click', () => { doSearch(); });
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.isComposing) return;
        e.preventDefault();
        doSearch();
      });
    },
  }).then((value) => (isPlainObject(value) && idOf(value.id) ? value : null));
}
