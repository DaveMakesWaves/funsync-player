// Video options — the per-video dialog the ⋮ opens (notes/features/
// DESIGN-video-options.md (b), (d); build stage 2a). Laid out like Settings:
// a rail of sections on the left, the active section on the right, and a
// header with the video's facts and its play buttons above both.
//
// What it knows of the library comes through `host` (library.js
// `_videoOptionsHost()`, a fake in the tests): the store (DataService), the
// big actions it reuses (Associate, the EroScripts search, the frame picker,
// VR format…) and the in-memory updates a write needs (the card, the
// filters). The data and every change come from video-options-model.js:
// each write is a plan's ops run through `runOps`, and each removal keeps
// the plan for its Undo. The Tags section is its own module
// (video-options-tags.js, stage 2b), hosted here.
//
// Rules from the design, all kept here:
//   - opening writes nothing (no re-home, no cache write, no fetch);
//   - ticks, radios and adds save at once; a polite live line says what
//     changed, with Undo on every removal, and a toast carries an Undo still
//     pending when the dialog closes;
//   - big actions (Change…, Find on EroScripts…, Add variation…, Extract
//     embedded axes…, Set thumbnail frame…, VR Format…) close the dialog,
//     run, and reopen it on the same section and control; small questions
//     (the Unpair and Remove-a-set confirms, New playlist, New category,
//     Change subtitle) stack on top (FT-048);
//   - untrusted text (file, playlist, category and post names) goes in with
//     textContent only.
//
// Stash S1 (Round 2 stage 2c, 2026-11-18; DESIGN-stash-s1.md (f) "The video
// options dialog"): while the Stash link is on (`settings.stash.enabled`
// and the library's `host.stash`), File gets a Stash block under the file
// facts (every state of stash-tags.js stashVideoView: linked, needs a check,
// changed, gone, refused, not in Stash, not synced, from another Stash) and
// the Tags section gets a Stash row. Every Stash change is one request the
// user starts (Sync this video, Find in Stash…, Use this scene, Not this
// scene…, Unlink); main does the writing and hands back an Undo token that
// the live line's Undo gives back to main as it is (restore). Opening the
// dialog sends nothing to Stash. Stash off: no Stash anywhere here.

import { Modal } from './modal.js';
import { t, getCurrentLocale } from '../js/i18n.js';
import * as M from '../js/video-options-model.js';
import { mountTagsSection } from './video-options-tags.js';
import { createVideoSyncOffsetRow } from './video-sync-offset-row.js';
import { videoSyncOffsetOf, withVideoSyncOffset } from '../js/video-sync-offset.js';
import { createCategoryMark } from '../js/category-icon.js';
import { effectiveTags, tagDisplayLabel } from '../js/video-tags.js';
import { stashVideoView, stashTagRecords } from '../js/stash-tags.js';
import { stashSceneFields, stashActivity } from '../js/stash-scene-fields.js';
import { openStashScenePicker, stashSceneName } from './stash-scene-picker.js';
import { recordWithScriptPath } from '../js/script-tags.js';
import { icon, Play, Clapperboard } from '../js/icons.js';

/** Rail order (model). */
export const SECTIONS = M.SECTIONS;

/**
 * Keys that stop at the dialog's body: inside the dialog they move the
 * focus, scroll the section, tick or press, and never reach the player
 * behind (keyboard.js listens on document, after the body). Not a
 * `data-owns-keys="navigation"` mark on the body: keyboard.js reads that
 * mark before its input rules, so a text box or a checkbox inside would
 * then own only these keys and let F, K and M through to the player.
 */
export const DIALOG_NAV_KEYS = Object.freeze(new Set([
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', ' ', 'Enter',
]));

/** How long a toast carries an Undo after the dialog closed (the playlists pattern). */
const UNDO_TOAST_MS = 8000;

// The last section opened this session (design (b): memory only, no key).
let lastSection = 'organise';

/** For tests: forget the session's last section. */
export function _resetVideoOptionsSessionForTests() {
  lastSection = 'organise';
}

/** The section the dialog opens on when no other is asked for. */
export function lastVideoOptionsSection() {
  return lastSection;
}

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(text, { className = 'modal-btn modal-btn--secondary video-options__btn', focusKey, onClick } = {}) {
  const b = el('button', className, text);
  b.type = 'button';
  if (focusKey) b.dataset.voFocus = focusKey;
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

let idSeq = 0;
const nextId = (prefix) => `${prefix}-${++idSeq}`;

/** `<section aria-labelledby>` with its h3 (design (g)). */
function block(heading) {
  const sec = el('section', 'video-options__block');
  const h = el('h3', 'video-options__block-title', heading);
  h.id = nextId('vo-h');
  sec.setAttribute('aria-labelledby', h.id);
  sec.appendChild(h);
  return sec;
}

function note(text, className = 'video-options__note') {
  return el('p', className, text);
}

function actions(...buttons) {
  const row = el('div', 'video-options__actions');
  for (const b of buttons) if (b) row.appendChild(b);
  return row;
}

function checkRow(text, { checked, focusKey, onChange, mark = null, hint = null }) {
  const label = el('label', 'video-options__check');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = !!checked;
  if (focusKey) input.dataset.voFocus = focusKey;
  input.addEventListener('change', () => onChange(input.checked));
  label.appendChild(input);
  if (mark) label.appendChild(mark);
  label.appendChild(el('span', 'video-options__check-text', text));
  if (hint) label.appendChild(el('span', 'video-options__check-hint', hint));
  return label;
}

/** A radio in its label; `tags` go inside the label, `after` (buttons) beside it. */
function radioRow(name, text, { value, checked, focusKey, onChange, tags = [], after = [] }) {
  const row = el('div', 'video-options__radio-row');
  const label = el('label', 'video-options__radio');
  const input = document.createElement('input');
  input.type = 'radio';
  input.name = name;
  input.value = value;
  input.checked = !!checked;
  if (focusKey) input.dataset.voFocus = focusKey;
  input.addEventListener('change', () => { if (input.checked) onChange(value); });
  label.append(input, el('span', 'video-options__radio-text', text));
  for (const x of tags) if (x) label.appendChild(x);
  row.appendChild(label);
  for (const x of after) if (x) row.appendChild(x);
  return row;
}

/** Bytes in the active language ("1.2 GB", "1,2 Go"). */
export function formatFileSize(bytes, locale = getCurrentLocale()) {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'];
  let value = bytes;
  let u = 0;
  while (value >= 1024 && u < units.length - 1) { value /= 1024; u++; }
  try {
    return new Intl.NumberFormat(locale || 'en', {
      style: 'unit', unit: units[u], unitDisplay: 'short', maximumFractionDigits: u === 0 ? 0 : 1,
    }).format(value);
  } catch {
    return `${Math.round(value * 10) / 10} ${['B', 'KB', 'MB', 'GB', 'TB'][u]}`;
  }
}

/** Resolves once no dialog is on the page (an Associate run can reopen itself). */
function whenNoDialogs() {
  const open = () => !!document.querySelector('.modal-overlay');
  if (!open()) return Promise.resolve();
  return new Promise((resolve) => {
    const mo = new MutationObserver(() => {
      if (open()) return;
      mo.disconnect();
      resolve();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  });
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

/**
 * Open the dialog for `video`. Resolves when the user is done with it: the
 * dialog closed (✕, Escape, the backdrop) or Play was pressed. A big action
 * closes it, runs, and opens it again on the same section and control, all
 * inside this one call.
 *
 * @param {object} host see library.js `_videoOptionsHost()`
 * @param {object} video the library's video object
 * @param {{section?: string, focusKey?: string}} [opts]
 * @returns {Promise<{kind: 'closed'|'play'|'tag', key?: string, tag?: object}>}
 *   'tag': "Show videos with this tag" closed the dialog (the host applies it)
 */
export async function openVideoOptionsDialog(host, video, opts = {}) {
  let section = SECTIONS.includes(opts.section) ? opts.section : lastSection;
  let focusKey = opts.focusKey || null;
  let current = video;
  for (;;) {
    const result = await openOnce(host, current, { section, focusKey });
    if (result?.kind === 'tag' && typeof result.key === 'string') return { kind: 'tag', key: result.key, tag: result.tag || null };
    if (result?.kind !== 'action') return result?.kind === 'play' ? { kind: 'play' } : { kind: 'closed' };
    try {
      await result.run();
    } catch (err) {
      console.warn('[VideoOptions] action failed:', err?.message || err);
    }
    // An Associate run may stack further dialogs of its own (its search,
    // its own reopen); the options come back once they are all closed.
    await whenNoDialogs();
    if (typeof host.canReopen === 'function' && !host.canReopen()) return { kind: 'closed' };
    current = host.getVideo?.(current.path) || current;
    section = result.section;
    focusKey = result.focusKey;
  }
}

function openOnce(host, video, { section, focusKey }) {
  const ui = new VideoOptionsUI(host, video, section, focusKey);
  return ui.open();
}

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

class VideoOptionsUI {
  constructor(host, video, section, focusKey) {
    this.host = host;
    this.settings = host.settings;
    this.path = video.path;
    this._video = video;
    this.activeId = SECTIONS.includes(section) ? section : 'organise';
    this.startFocusKey = focusKey || null;
    this.panels = {};
    this.rendered = new Set();
    this.tags = null;
    this.pendingUndo = null;
    // Older Undos a newer one covered: each comes back, newest first, once
    // the one above it is used (so a Remove then an Unpair can both be
    // undone, in turn). Each still checks the store when it runs.
    this.undoStack = [];
    this.statusByPath = new Map();
    this.sizeLoaded = false;
    this.size = undefined;
    this.close = null;
    this.body = null;
    // Stash (S1): the request running from this dialog ('sync', 'link',
    // 'search'…; one at a time), the last failure's code (the block says it
    // and keeps every stored fact), the scene picked in a check, and the
    // unsubscribe of host.stash.onChanged.
    this.stashBusy = null;
    this.stashError = null;
    this.stashPick = null;
    this.stashOff = null;
  }

  /** The video as the library holds it now (writes replace fields on it). */
  get video() {
    return this.host.getVideo?.(this.path) || this._video;
  }

  open() {
    const name = this._video.name || M.fileName(this.path);
    return Modal.open({
      title: name,
      panelClass: 'modal-panel--settings modal-panel--video-options',
      onRender: (body, close) => this._render(body, close, name),
      initialFocus: (body) => this._initialFocus(body),
      onEscape: (e) => this._onEscape(e),
    }).then((value) => {
      this._teardown();
      return value;
    });
  }

  // ---- shell ----

  _render(body, close, name) {
    this.body = body;
    this.close = close;
    body.classList.add('video-options');
    // Toasts sit below the dialog while it is open (video-options.css), not
    // over its lower edge.
    document.body.classList.add('video-options-open');
    // Navigation keys stop here (see DIALOG_NAV_KEYS), with Alt held too:
    // keyboard.js's arrow cases do not look at Alt, so an Alt+Arrow that got
    // through seeked or changed the volume of the player behind (review-a
    // RA-4). Alt+1/2/3 are not navigation keys and still go on.
    body.addEventListener('keydown', (e) => {
      if (DIALOG_NAV_KEYS.has(e.key)) e.stopPropagation();
    });

    const panel = body.closest('.modal-panel');
    const titleEl = panel?.querySelector('.modal-title');
    if (titleEl) {
      titleEl.title = name; // the full name; the title itself is cut with an ellipsis
      titleEl.classList.add('video-options__title');
    }

    this.headerEl = el('div', 'video-options__header');
    body.appendChild(this.headerEl);
    this._renderHeader();
    if (panel && this.factsId) panel.setAttribute('aria-describedby', this.factsId);

    const layout = el('div', 'video-options__layout');
    const rail = el('div', 'video-options__rail');
    rail.setAttribute('role', 'tablist');
    rail.setAttribute('aria-orientation', 'vertical');
    rail.setAttribute('aria-label', t('videoOptions.railAria'));
    const content = el('div', 'video-options__content');
    this.railEl = rail;
    this.contentEl = content;

    const uid = nextId('vo');
    for (const id of SECTIONS) {
      const item = el('button', 'video-options__rail-item');
      item.type = 'button';
      item.dataset.section = id;
      item.id = `${uid}-tab-${id}`;
      item.setAttribute('role', 'tab');
      item.setAttribute('aria-selected', 'false');
      item.setAttribute('aria-controls', `${uid}-panel-${id}`);
      item.tabIndex = -1;
      item.appendChild(el('span', 'video-options__rail-label', t(`videoOptions.rail.${id}`)));
      if (id === 'tags') {
        this.tagsCountEl = el('span', 'video-options__rail-count');
        item.appendChild(this.tagsCountEl);
      }
      item.addEventListener('click', () => this.activate(id));
      rail.appendChild(item);

      const p = el('div', 'video-options__panel');
      p.id = `${uid}-panel-${id}`;
      p.dataset.section = id;
      p.setAttribute('role', 'tabpanel');
      p.setAttribute('aria-labelledby', item.id);
      p.hidden = true;
      content.appendChild(p);
      this.panels[id] = p;
    }
    this._updateTagsCount();

    // The vertical tablist keys, as Settings' rail (Nielsen #4): Up/Down
    // wrap, Home/End jump, selection follows focus. preventDefault, so
    // keyboard.js (and the browser's own scroll) leave the press alone.
    rail.addEventListener('keydown', (e) => {
      const items = [...rail.querySelectorAll('.video-options__rail-item')];
      const idx = items.indexOf(document.activeElement);
      if (idx < 0) return;
      let next = -1;
      if (e.key === 'ArrowDown') next = (idx + 1) % items.length;
      else if (e.key === 'ArrowUp') next = (idx - 1 + items.length) % items.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = items.length - 1;
      if (next >= 0) {
        e.preventDefault();
        items[next].click();
      }
    });

    // The live line: what the last change did, with its Undo (polite).
    this.liveEl = el('div', 'video-options__live video-options__live--empty');
    this.liveEl.setAttribute('role', 'status');
    this.liveTextEl = el('span', 'video-options__live-text');
    // What the pending Undo undoes, once a newer message took the line.
    this.undoTextEl = el('span', 'video-options__live-undo-text');
    this.undoTextEl.hidden = true;
    this.undoBtn = button(t('toast.undo'), { className: 'video-options__undo', focusKey: 'live:undo' });
    this.undoBtn.hidden = true;
    this.undoBtn.addEventListener('click', () => this._runUndo());
    this.liveEl.append(this.liveTextEl, this.undoTextEl, this.undoBtn);

    const column = el('div', 'video-options__column');
    column.append(content, this.liveEl);
    layout.append(rail, column);
    body.appendChild(layout);

    // A Stash change made anywhere (this dialog, a sync from Settings)
    // redraws the Stash block, the Tags section and the count. Listening
    // sends nothing.
    if (typeof this.host.stash?.onChanged === 'function') {
      try {
        const off = this.host.stash.onChanged(() => this._stashChanged());
        this.stashOff = typeof off === 'function' ? off : null;
      } catch (err) {
        console.warn('[VideoOptions] Stash onChanged threw', err);
      }
    }

    this.activate(this.activeId, { focus: false });
  }

  _initialFocus(body) {
    if (this.startFocusKey) {
      const target = this._findFocusKey(this.startFocusKey, body);
      if (target) return target;
      // Not there yet: the Locate control appears once the script's status
      // read answers (`askStatus`), which then focuses it.
      this.pendingFocusKey = this.startFocusKey;
    }
    return this.railEl?.querySelector(`[data-section="${this.activeId}"]`) || null;
  }

  _onEscape(e) {
    // The open section's own popup closes first (a chip menu, a suggestion
    // list); exactly true keeps the dialog open. Never async (modal.js).
    if (this.activeId !== 'tags' || !this.tags || typeof this.tags.handleEscape !== 'function') return false;
    try { return this.tags.handleEscape(e) === true; } catch (err) {
      console.warn('[VideoOptions] tags handleEscape threw', err);
      return false;
    }
  }

  _teardown() {
    this._disposeTags();
    if (this.stashOff) {
      try { this.stashOff(); } catch { /* the store's own listener list */ }
      this.stashOff = null;
    }
    document.body.classList.remove('video-options-open');
    // An Undo still pending when the dialog closes goes on in a toast.
    const undo = this.pendingUndo;
    this.pendingUndo = null;
    if (undo && !undo.done) offerUndoToast(undo);
  }

  _disposeTags() {
    if (!this.tags) return;
    try { this.tags.dispose?.(); } catch (err) { console.warn('[VideoOptions] tags dispose threw', err); }
    this.tags = null;
  }

  activate(id, { focus = true } = {}) {
    if (!SECTIONS.includes(id)) return;
    if (this.activeId === 'tags' && id !== 'tags') this._disposeTags();
    this.activeId = id;
    lastSection = id;
    for (const s of SECTIONS) {
      const active = s === id;
      const item = this.railEl.querySelector(`[data-section="${s}"]`);
      item.classList.toggle('video-options__rail-item--active', active);
      item.setAttribute('aria-selected', active ? 'true' : 'false');
      item.tabIndex = active ? 0 : -1;
      this.panels[s].hidden = !active;
    }
    if (id === 'tags') this._mountTags();
    else if (!this.rendered.has(id)) this.refresh(id);
    this.contentEl.scrollTop = 0;
    if (focus) this.railEl.querySelector(`[data-section="${id}"]`)?.focus();
  }

  _mountTags() {
    if (this.tags) return;
    const p = this.panels.tags;
    p.replaceChildren();
    const ctx = {
      video: this.video,
      dataService: this.settings,
      getLibraryVideos: () => this.host.libraryVideos?.() || [],
      onDataChanged: (what) => this._dataChanged(what),
      announce: (message) => this.announce(message),
      // The dialog's one Undo: the live line with its Undo button, focused
      // (the section's own fallback button then stays away).
      announceUndo: (message, undo, opts) => {
        this.announce(message, undo && typeof undo.run === 'function' ? undo : null);
        // `{ focus: false }`: the control that acted is still there (Get tags).
        if (opts?.focus !== false) this.focusUndo();
      },
      modalBody: this.body,
    };
    // The EroScripts login and expiry through the library's hooks (the
    // panel's public login / handleSessionExpired), not the panel's private
    // methods. getScriptMeta and showVideosWithTag are Round 3's.
    if (this.host.eroscripts && typeof this.host.eroscripts === 'object') ctx.eroscripts = this.host.eroscripts;
    // Round 3 (library.js): the script file's own metadata, the library's
    // one tag index (suggestions, Make a category), and "Show videos with
    // this tag", which closes the dialog for the host to filter by it.
    if (typeof this.host.getScriptMeta === 'function') ctx.getScriptMeta = (scriptPath) => this.host.getScriptMeta(scriptPath);
    if (typeof this.host.tagIndex === 'function') ctx.getTagIndex = () => this.host.tagIndex();
    if (this.host.canShowVideosWithTag === true) {
      ctx.showVideosWithTag = (key, tag) => this.close?.({ kind: 'tag', key, tag: tag ? { facet: tag.facet, label: tag.label } : null });
    }
    // Stash S1: the row under "Where they came from" (the same view as the
    // File block; null while Stash is off) and Open in Stash. The chips'
    // Stash source comes from the library's tag index (getTagIndex).
    if (this.stashEnabled()) {
      ctx.stash = {
        view: () => this.stashView(),
        openScene: (sceneId) => this.openStashScene(sceneId),
      };
    }
    try {
      this.tags = mountTagsSection(p, ctx) || null;
    } catch (err) {
      console.warn('[VideoOptions] the Tags section failed to mount', err);
      this.tags = null;
    }
    this.rendered.add('tags');
  }

  // ---- Stash (S1) ----

  /** Is the Stash link on? `settings.stash.enabled` exactly true, and the library gives `host.stash`. */
  stashEnabled() {
    const s = this.host.stash;
    if (!s || typeof s !== 'object' || typeof s.data !== 'function') return false;
    try {
      if (typeof s.enabled === 'function') return s.enabled() === true;
      return this.settings.get('stash.enabled') === true;
    } catch {
      return false;
    }
  }

  /** The Stash data as the renderer holds it (main's projection), or null. */
  stashData() {
    if (!this.stashEnabled()) return null;
    try {
      const d = this.host.stash.data();
      return d && typeof d === 'object' ? d : null;
    } catch {
      return null;
    }
  }

  /**
   * This video's Stash view (stash-tags.js stashVideoView), or null while
   * Stash is off. The trust check reads the size the library scan saw
   * (`video.size`), as the tag index does, so the block and the chips agree.
   */
  stashView() {
    const data = this.stashData();
    if (!data) return null;
    const v = this.video;
    try {
      const view = stashVideoView(data, this.path, {
        size: Number.isFinite(v.size) ? v.size : undefined,
        duration: Number.isFinite(v.duration) ? v.duration : undefined,
        enabled: true,
      });
      return view ? withServerCheck(view, data) : null;
    } catch (err) {
      console.warn('[VideoOptions] Stash view failed', err);
      return null;
    }
  }

  /**
   * Open in Stash: main builds `<address>/scenes/<id>` (the link's own
   * server) and hands it to the browser; the id goes back as given (an
   * opaque string, never parsed).
   */
  openStashScene(sceneId) {
    const openFn = stashOpener(this.host);
    if (sceneId == null || !openFn) return;
    try {
      Promise.resolve(openFn(String(sceneId), this.path)).catch((err) => {
        console.warn('[VideoOptions] Open in Stash failed', err?.message || err);
      });
    } catch (err) {
      console.warn('[VideoOptions] Open in Stash failed', err?.message || err);
    }
  }

  /** The Stash data changed (main reported a write): redraw what shows it. */
  _stashChanged() {
    if (!this.body?.isConnected) return;
    this._updateTagsCount();
    if (this.rendered.has('file')) this.refresh('file');
    try { this.tags?.refresh?.(); } catch (err) { console.warn('[VideoOptions] tags refresh threw', err); }
  }

  /** Something in the Tags section changed: the count, the header, the card. */
  _dataChanged(what) {
    this._updateTagsCount();
    this._renderHeader();
    this.host.dataChanged?.(what);
    if (what === 'categories') {
      this.host.categoriesChanged?.(null);
      if (this.rendered.has('organise')) this.refresh('organise');
    }
  }

  /** Rebuild one section's panel, keeping the focus on the same control. */
  refresh(id) {
    if (id === 'tags') return;
    const p = this.panels[id];
    if (!p) return;
    const focused = p.contains(document.activeElement) ? document.activeElement?.dataset?.voFocus : null;
    p.replaceChildren();
    const render = SECTION_RENDERERS[id];
    if (render) render(this, p);
    this.rendered.add(id);
    if (focused) this.focusKey(focused);
  }

  /**
   * Ask once whether `scriptPath` is there (a read, no write; tri-state:
   * false only when provably gone, as the card says it). The answer redraws
   * the header and the Script section.
   */
  askStatus(scriptPath) {
    if (!scriptPath || this.statusByPath.has(scriptPath) || typeof this.host.pathStatus !== 'function') return;
    this.statusByPath.set(scriptPath, undefined);
    const done = (answer) => {
      this.statusByPath.set(scriptPath, answer === true || answer === false ? answer : null);
      if (!this.body?.isConnected) return;
      this._renderHeader();
      if (this.rendered.has('script')) this.refresh('script');
      // A focus asked for at open, while nobody has moved it since.
      if (this.pendingFocusKey) {
        const a = document.activeElement;
        const atStart = !a || a === document.body || a === this.railEl?.querySelector(`[data-section="${this.activeId}"]`);
        if (!atStart) this.pendingFocusKey = null;
        else if (this.focusKey(this.pendingFocusKey)) this.pendingFocusKey = null;
      }
    };
    Promise.resolve(this.host.pathStatus(scriptPath)).then(done, () => done(null));
  }

  /** Re-render whatever shows the video's data after a change. */
  refreshAll() {
    this._renderHeader();
    this._updateTagsCount();
    for (const id of this.rendered) if (id !== 'tags') this.refresh(id);
  }

  _findFocusKey(key, root = this.body) {
    if (!key || !root) return null;
    for (const node of root.querySelectorAll('[data-vo-focus]')) {
      if (node.dataset.voFocus === key && !node.disabled && !node.closest('[hidden]')) return node;
    }
    return null;
  }

  focusKey(key) {
    const target = this._findFocusKey(key);
    if (target) {
      try { target.focus({ preventScroll: false }); } catch { /* not focusable */ }
    }
    return !!target;
  }

  /** A big action: close, run, reopen here on `focusKey`. */
  runBig(focusKey, run) {
    this.close?.({ kind: 'action', section: this.activeId, focusKey, run });
  }

  // ---- live line and Undo ----

  /**
   * Say what changed. `undo` = { run: () => ({message?}), focusKey } keeps
   * an Undo button next to it. Only a newer Undo takes a pending one's
   * place (design (d): "a second Unpair replaces it"), and the covered one
   * waits under it (`undoStack`) until the newer one is used. A message
   * with no Undo of its own (Copy path, a tick, a VR pick, a Get tags
   * result) takes the line but leaves the pending Undo and its button, with
   * the Undo's own words beside the button. On close a toast carries the
   * one pending (review-a RA-1).
   */
  announce(message, undo = null) {
    if (undo) {
      if (this.pendingUndo && !this.pendingUndo.done) {
        this.undoStack.push(this.pendingUndo);
        if (this.undoStack.length > 10) this.undoStack.shift();
      }
      this.pendingUndo = { ...undo, message, done: false };
    } else if (this.pendingUndo?.done) this.pendingUndo = null;
    if (!this.liveTextEl) return;
    this.liveTextEl.textContent = message || '';
    this._showUndo();
  }

  /** The Undo button, and what it undoes when the line says something newer. */
  _showUndo() {
    const undo = this.pendingUndo && !this.pendingUndo.done ? this.pendingUndo : null;
    this.undoBtn.hidden = !undo;
    const words = undo && undo.message && undo.message !== this.liveTextEl.textContent ? undo.message : '';
    this.undoTextEl.textContent = words;
    this.undoTextEl.hidden = !words;
    // Nothing said yet: a narrow dialog folds the line away (CSS).
    this.liveEl.classList.toggle('video-options__live--empty', !undo && !this.liveTextEl.textContent);
  }

  _runUndo() {
    const undo = this.pendingUndo;
    if (!undo || undo.done) return;
    undo.done = true;
    this.pendingUndo = null;
    let result = {};
    try { result = undo.run() || {}; } catch (err) {
      console.warn('[VideoOptions] undo failed', err);
      result = { message: t('videoOptions.live.undoChanged') };
    }
    // An Undo main carries out (Stash): the line says what happened once
    // main has answered, not before.
    if (typeof result.then === 'function') {
      Promise.resolve(result).then((r) => r || {}, (err) => {
        console.warn('[VideoOptions] undo failed', err);
        return { message: t('videoOptions.live.undoChanged') };
      }).then((r) => {
        if (this.body?.isConnected) this._afterUndo(undo, r);
      });
      return;
    }
    this._afterUndo(undo, result);
  }

  _afterUndo(undo, result) {
    this.liveTextEl.textContent = result.message || t('videoOptions.live.undone');
    // The Undo this one covered is offered again, with its own words.
    while (this.undoStack.length && !this.pendingUndo) {
      const prev = this.undoStack.pop();
      if (prev && !prev.done) this.pendingUndo = prev;
    }
    this._showUndo();
    this.refreshAll();
    // After Undo, back to the control that removed (design (g)).
    if (!(undo.focusKey && this.focusKey(undo.focusKey))) {
      this.railEl.querySelector(`[data-section="${this.activeId}"]`)?.focus();
    }
  }

  /** After a removal whose control went away, the focus goes to Undo. */
  focusUndo() {
    if (!this.undoBtn.hidden) this.undoBtn.focus();
  }

  // ---- header ----

  _tagCount() {
    try {
      const s = this.settings;
      const v = this.video;
      // As the Tags section reads it (fixup-data's TODO): a record from
      // before `scriptPath` describes the video's same-name script, so on a
      // video with NO script it does not count (it did here, not there).
      const record = recordWithScriptPath((s.get('library.scriptTags') || {})[this.path], this.path);
      const tagSettings = s.get('library.tagSettings') || {};
      const scriptPath = v.funscriptPath || null;
      // Stash S1: the video's Stash record and the bare-name join, from the
      // library's one tag index (empty while Stash is off), as the chips.
      const index = this.stashEnabled() ? this.tagIndexResult() : null;
      const stashRecord = index ? ownValue(index.stash, this.path) : undefined;
      const list = effectiveTags(this.path, {
        user: s.get('library.userTags') || {},
        eroscripts: { [this.path]: M.eroscriptsRecordForTags(record, scriptPath) },
        // The script file's own tags, as the Tags section lists them (Round 3).
        funscript: (typeof this.host.scriptMetaMap === 'function' && this.host.scriptMetaMap()) || {},
        ...(stashRecord ? { stash: { [this.path]: stashRecord } } : {}),
      }, {
        scriptPath,
        hidden: s.get('library.hiddenTags') || {},
        hiddenEverywhere: tagSettings.hidden || [],
        aliases: tagSettings.aliases || {},
        facetOverrides: tagSettings.facetOverrides || {},
        ...(index?.nameIds ? { nameIds: index.nameIds } : {}),
      });
      return list.length;
    } catch {
      return 0;
    }
  }

  /** The library's one tag index (library-tag-filter.js), or null. */
  tagIndexResult() {
    if (typeof this.host.tagIndex !== 'function') return null;
    try {
      const r = this.host.tagIndex();
      return r && typeof r === 'object' ? r : null;
    } catch {
      return null;
    }
  }

  _updateTagsCount() {
    if (!this.tagsCountEl) return;
    const n = this._tagCount();
    this.tagsCountEl.textContent = n > 0 ? String(n) : '';
    this.tagsCountEl.hidden = n === 0;
  }

  _renderHeader() {
    const h = this.headerEl;
    if (!h) return;
    const v = this.video;
    const focused = h.contains(document.activeElement) ? document.activeElement?.dataset?.voFocus : null;
    h.replaceChildren();

    const thumb = el('div', 'video-options__thumb');
    const url = this.host.thumbnailUrl?.(this.path);
    if (url) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      thumb.appendChild(img);
    } else {
      thumb.appendChild(icon(Clapperboard, { width: 28, height: 28 }));
    }
    thumb.setAttribute('aria-hidden', 'true');

    const summary = el('div', 'video-options__summary');
    const facts = el('div', 'video-options__facts');
    this.factsId = this.factsId || nextId('vo-facts');
    facts.id = this.factsId;

    const line1 = [];
    if (v.duration > 0) line1.push(this.host.formatDuration ? this.host.formatDuration(v.duration) : String(Math.round(v.duration)));
    const vr = M.vrView({
      videoPath: this.path,
      manualVRType: this.settings.get('library.manualVRType') || {},
      vrFormat: this.settings.get('library.vrFormat') || {},
    });
    if (vr.mode === 'auto' && vr.detected) line1.push(t('videoOptions.header.vrAuto'));
    else if (vr.mode === 'vr') line1.push(t('videoOptions.header.vrYours'));
    else if (vr.mode === 'flat') line1.push(t('videoOptions.header.flatYours'));
    const sv = M.scriptView(this.scriptInput());
    // A script that is not there says so here too (verify-2: the header
    // still said "Script: Chosen by you · Avg …" from the old read).
    if (sv.status === 'missing') line1.push(t('videoOptions.script.status.missing'));
    else {
      line1.push(sv.pairing.kind === 'none'
        ? t(sv.pairing.labelKey)
        : t('videoOptions.header.script', { how: t(sv.pairing.labelKey) }));
      if (v.avgSpeed > 0) line1.push(t('library.speedBadgeTitle', { avg: Math.round(v.avgSpeed), max: Math.round(v.maxSpeed || 0) }));
    }
    facts.appendChild(el('p', 'video-options__facts-line', line1.join(' · ')));
    // The header asks too, so it is right before the Script section opens.
    if (sv.main) this.askStatus(sv.main.path);

    const line2 = el('p', 'video-options__facts-line video-options__facts-line--second');
    const cats = this.settings.getCategories?.() || [];
    const ids = this.settings.getVideoCategories?.(this.path) || [];
    for (const id of ids) {
      const cat = cats.find((c) => c.id === id);
      if (!cat) continue;
      const chip = el('span', 'video-options__cat');
      chip.appendChild(createCategoryMark(cat, { className: 'video-options__cat-mark', size: 10 }));
      chip.appendChild(el('span', null, cat.name));
      line2.appendChild(chip);
    }
    const progress = progressText(M.progressView({
      entry: (this.settings.get('library.resumePositions') || {})[this.path],
      duration: v.duration,
    }));
    if (progress) line2.appendChild(el('span', 'video-options__progress', progress));
    if (line2.childNodes.length) facts.appendChild(line2);

    const buttons = el('div', 'video-options__header-actions');
    const play = button('', { className: 'modal-btn modal-btn--primary video-options__btn video-options__play', focusKey: 'header:play' });
    play.appendChild(icon(Play, { width: 14, height: 14 }));
    play.appendChild(el('span', null, t('player.play')));
    play.addEventListener('click', () => this.close?.({ kind: 'play' }));
    buttons.appendChild(play);
    if (this.host.canQueue) {
      buttons.appendChild(button(t('queuePanel.contextAddToQueueNext'), {
        focusKey: 'header:next', onClick: () => this.host.addToQueue(this.path, 'next'),
      }));
      buttons.appendChild(button(t('queuePanel.contextAddToQueue'), {
        focusKey: 'header:end', onClick: () => this.host.addToQueue(this.path, 'end'),
      }));
    }

    summary.append(facts, buttons);
    h.append(thumb, summary);
    if (focused) this._findFocusKey(focused, h)?.focus();
  }

  // ---- inputs the model takes ----

  scriptInput() {
    const v = this.video;
    const s = this.settings;
    const input = {
      videoPath: this.path,
      association: (s.get('library.associations') || {})[this.path],
      ownScriptPath: v._ownScriptKnown ? (v._ownFunscriptPath || null) : undefined,
      funscriptPath: v.funscriptPath || null,
      folderVariantMain: !!v._folderVariantMain,
      fallbackFrom: v._assocFallbackFrom || null,
      scriptTagRecord: recordWithScriptPath((s.get('library.scriptTags') || {})[this.path], this.path),
    };
    // The status belongs to the script the section names (the model's
    // main), which `renderScript` asks about. While the video falls back to
    // its own script (R4-06) that is YOUR script, not the one playing, so a
    // lookup under `funscriptPath` never found the answer (review-a RA-7).
    const main = M.scriptView(input).main?.path || null;
    input.mainStatus = main && this.statusByPath.has(main) ? this.statusByPath.get(main) : undefined;
    return input;
  }
}

function progressText(pv) {
  if (!pv) return '';
  if (pv.state === 'in-progress') {
    return t('videoOptions.playback.watchedTo', { position: pv.positionText, duration: pv.durationText, percent: pv.percent });
  }
  if (pv.state === 'watched') return t('playlists.watched');
  return '';
}

/** The toast that carries an Undo after the dialog closed (8 s). */
async function offerUndoToast(undo) {
  const { showToast } = await import('../js/toast.js');
  if (undo.done) return;
  const body = el('div', 'update-toast');
  body.appendChild(el('span', null, undo.message || ''));
  const undoBtn = button(t('toast.undo'), { className: 'update-toast__btn video-options__toast-undo' });
  // The click goes on to the toast body, which dismisses the toast.
  undoBtn.addEventListener('click', () => {
    if (undo.done) return;
    undo.done = true;
    let result = {};
    try { result = undo.run() || {}; } catch (err) { console.warn('[VideoOptions] undo failed', err); }
    // A Stash Undo answers later (main writes it).
    if (typeof result.then === 'function') {
      Promise.resolve(result).then((r) => { if (r?.message) showToast(r.message, 'info', 2500); }, (err) => {
        console.warn('[VideoOptions] undo failed', err);
      });
      return;
    }
    if (result.message) showToast(result.message, 'info', 2500);
  });
  body.appendChild(undoBtn);
  showToast(body, 'info', UNDO_TOAST_MS);
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

const SECTION_RENDERERS = {
  organise: renderOrganise,
  script: renderScript,
  subtitles: renderSubtitles,
  playback: renderPlayback,
  thumbnail: renderThumbnail,
  vr: renderVR,
  file: renderFile,
};

// ---- Organise: playlists, categories, libraries ----

function renderOrganise(ui, p) {
  const { settings, host, path } = ui;
  const ctx = host.collectionContext?.() || {};
  const view = M.organiseView({
    videoPath: path,
    playlists: settings.getPlaylists?.() || [],
    categories: settings.getCategories?.() || [],
    categoryIds: settings.getVideoCategories?.(path) || [],
    collections: settings.get('library.collections') || [],
    sources: ctx.sources,
    folderIndex: ctx.folderIndex,
    descendantsOf: ctx.descendantsOf,
  });

  // Playlists
  const pls = block(t('playlists.title'));
  const plList = el('div', 'video-options__checks');
  for (const pl of view.playlists) {
    plList.appendChild(checkRow(pl.name, {
      checked: pl.checked,
      focusKey: `playlist:${pl.id}`,
      onChange: (checked) => togglePlaylist(ui, pl.id, checked),
    }));
  }
  if (view.playlists.length === 0) plList.appendChild(note(t('videoOptions.organise.noPlaylists')));
  pls.appendChild(plList);
  pls.appendChild(actions(button(t('videoOptions.organise.newPlaylist'), {
    focusKey: 'organise:newPlaylist', onClick: () => newPlaylist(ui),
  })));
  p.appendChild(pls);

  // Categories
  const cats = block(t('categories.title'));
  const catList = el('div', 'video-options__checks');
  for (const cat of view.categories) {
    catList.appendChild(checkRow(cat.name, {
      checked: cat.checked,
      focusKey: `category:${cat.id}`,
      mark: createCategoryMark(cat, { className: 'video-options__cat-mark', size: 10 }),
      onChange: (checked) => toggleCategory(ui, cat.id, checked),
    }));
  }
  if (view.categories.length === 0) catList.appendChild(note(t('videoOptions.organise.noCategories')));
  cats.appendChild(catList);
  cats.appendChild(actions(button(t('videoOptions.organise.newCategory'), {
    focusKey: 'organise:newCategory', onClick: () => newCategory(ui),
  })));
  p.appendChild(cats);

  // Libraries (collections), only when there are any
  if (view.collections.length > 0) {
    const cols = block(t('videoOptions.organise.libraries'));
    const colList = el('div', 'video-options__checks');
    for (const col of view.collections) {
      colList.appendChild(checkRow(col.name, {
        checked: col.checked,
        focusKey: `collection:${col.id}`,
        hint: col.synced ? t('videoOptions.organise.synced') : null,
        onChange: (checked) => toggleCollection(ui, col.id, checked),
      }));
    }
    cols.appendChild(colList);
    p.appendChild(cols);
  }
}

function undoMessage(result) {
  if (result?.ok) return null;
  return t(result?.reason === 'gone' ? 'videoOptions.live.undoGone' : 'videoOptions.live.undoChanged');
}

function togglePlaylist(ui, id, checked) {
  const { settings, path } = ui;
  const playlist = settings.getPlaylist?.(id);
  const plan = M.planPlaylistToggle({ playlist, videoPath: path, checked });
  if (!plan.changed) { ui.refresh('organise'); return; }
  M.runOps(plan.ops, settings);
  if (checked) {
    ui.announce(t('videoOptions.live.addedTo', { name: plan.name }));
    return;
  }
  ui.announce(t('videoOptions.live.removedFrom', { name: plan.name }), {
    focusKey: `playlist:${id}`,
    run: () => {
      // Back at its old place in the list, not at the end (model).
      const undo = M.planPlaylistUndo(plan, settings.getPlaylist?.(id));
      if (!undo.ok) return { message: undoMessage(undo) };
      M.runOps(undo.ops, settings);
      return {};
    },
  });
}

async function newPlaylist(ui) {
  const { settings, path } = ui;
  const name = await Modal.prompt(t('playlists.newPlaylist'), t('library.createPlaylistFirstLabel'));
  if (!name || !String(name).trim()) { ui.focusKey('organise:newPlaylist'); return; }
  const playlist = await settings.addPlaylist(String(name).trim());
  if (playlist?.id) {
    const plan = M.planPlaylistToggle({ playlist: settings.getPlaylist?.(playlist.id) || playlist, videoPath: path, checked: true });
    M.runOps(plan.ops, settings);
    ui.announce(t('videoOptions.live.addedTo', { name: playlist.name }));
  }
  ui.refresh('organise');
  if (!(playlist?.id && ui.focusKey(`playlist:${playlist.id}`))) ui.focusKey('organise:newPlaylist');
}

function toggleCategory(ui, catId, checked) {
  const { settings, path, host } = ui;
  const category = (settings.getCategories?.() || []).find((c) => c.id === catId);
  const plan = M.planCategoryToggle({ videoPath: path, categoryIds: settings.getVideoCategories?.(path) || [], category, checked });
  if (!plan.changed) { ui.refresh('organise'); return; }
  M.runOps(plan.ops, settings);
  // The card's dot, found by path (the card the ⋮ was on may be gone).
  host.categoriesChanged?.(path);
  host.dataChanged?.('categories');
  ui._renderHeader();
  if (checked) {
    ui.announce(t('videoOptions.live.addedTo', { name: plan.name }));
    return;
  }
  ui.announce(t('videoOptions.live.removedFrom', { name: plan.name }), {
    focusKey: `category:${catId}`,
    run: () => {
      const undo = M.planCategoryUndo(plan, settings.getVideoCategories?.(path) || []);
      if (!undo.ok) return { message: undoMessage(undo) };
      M.runOps(undo.ops, settings);
      host.categoriesChanged?.(path);
      return {};
    },
  });
}

async function newCategory(ui) {
  const { settings, path, host } = ui;
  const id = await host.createCategory?.();
  if (id) {
    const category = (settings.getCategories?.() || []).find((c) => c.id === id);
    const plan = M.planCategoryToggle({ videoPath: path, categoryIds: settings.getVideoCategories?.(path) || [], category, checked: true });
    M.runOps(plan.ops, settings);
    host.categoriesChanged?.(path);
    host.dataChanged?.('categories');
    ui._renderHeader();
    if (category) ui.announce(t('videoOptions.live.addedTo', { name: category.name }));
  }
  ui.refresh('organise');
  if (!(id && ui.focusKey(`category:${id}`))) ui.focusKey('organise:newCategory');
}

function toggleCollection(ui, colId, checked) {
  const { settings, path, host } = ui;
  const ctx = host.collectionContext?.() || {};
  const collection = (settings.get('library.collections') || []).find((c) => c?.id === colId);
  const plan = M.planCollectionToggle({ collection, videoPath: path, checked, ...ctx });
  if (!plan.changed) { ui.refresh('organise'); return; }
  M.runOps(plan.ops, settings);
  host.dataChanged?.('collections');
  if (checked) {
    ui.announce(t('videoOptions.live.addedTo', { name: plan.name }));
    return;
  }
  ui.announce(t('videoOptions.live.removedFrom', { name: plan.name }), {
    focusKey: `collection:${colId}`,
    run: () => {
      const now = (settings.get('library.collections') || []).find((c) => c?.id === colId);
      const undo = M.planCollectionUndo(plan, now);
      if (!undo.ok) return { message: undoMessage(undo) };
      M.runOps(undo.ops, settings);
      host.dataChanged?.('collections');
      return {};
    },
  });
}

// ---- Script ----

function slotText(slot) {
  if (slot.slot === 'single') return t('videoOptions.script.slot.single', { name: M.fileName(slot.main) });
  if (slot.slot === 'multi') return t('videoOptions.script.slot.multi', { count: slot.axisCount });
  return t('videoOptions.script.modeCustom', { count: slot.routeCount });
}

function renderScript(ui, p) {
  const { host, settings, path } = ui;
  const v = ui.video;
  const input = ui.scriptInput();
  const view = M.scriptView(input);

  // The pairing
  const main = block(t('videoOptions.script.heading'));
  if (view.main) {
    const line = el('div', 'video-options__row');
    line.appendChild(el('span', 'video-options__name', view.main.name));
    line.appendChild(el('span', 'video-options__tag', t(view.pairing.labelKey)));
    if (view.status === 'missing' && M.canLocateMain(input)) {
      line.appendChild(locateButton(view.main.name, 'script:locate', () => locateMain(ui)));
    } else if (view.statusKey) {
      line.appendChild(el('span', `video-options__status video-options__status--${view.status}`, t(view.statusKey)));
    }
    main.appendChild(line);
    main.appendChild(el('p', 'video-options__path', view.main.path));
  } else {
    main.appendChild(note(t('videoOptions.script.none')));
  }
  if (view.fallback) {
    main.appendChild(note(t('videoOptions.script.fallback', { name: M.fileName(view.fallback.from) }), 'video-options__note video-options__note--warn'));
  }
  main.appendChild(actions(
    button(view.main ? t('videoOptions.script.change') : t('library.associateFunscriptBtn'), {
      focusKey: 'script:change', onClick: () => ui.runBig('script:change', () => host.changeScript(ui.video)),
    }),
    host.findOnEroScripts ? button(t('videoOptions.script.findOnEroScripts'), {
      focusKey: 'script:find', onClick: () => ui.runBig('script:find', () => host.findOnEroScripts(ui.video)),
    }) : null,
  ));
  p.appendChild(main);

  // The proven-absence status, asked once per script (a read, no write).
  if (view.main) ui.askStatus(view.main.path);

  // Mode
  if (view.mode.kind) {
    const mode = block(t('videoOptions.script.modeHeading'));
    let text = t('videoOptions.script.modeSingle');
    if (view.mode.kind === 'multi') text = t('videoOptions.script.modeMulti', { count: view.mode.axisCount });
    else if (view.mode.kind === 'custom') text = t('videoOptions.script.modeCustom', { count: view.mode.routeCount });
    mode.appendChild(el('p', 'video-options__row', text));
    mode.appendChild(note(t('videoOptions.script.modeHint')));
    p.appendChild(mode);
  }

  // The slots that hold a pairing you made, and what Unpair does to each
  // (Dave, 2026-11-17, answer 1: never silent about a custom route or a
  // multi-axis set). A single slot that only repeats a set's main script is
  // that set's carry-over (a library refresh back-fills it, library.js
  // `_applyManualAssociations`): not listed as a pairing you saved (verify-1
  // "Phantom saved single script"); the store keeps it as it is.
  const plan = M.planUnpair(input);
  const handSlots = (plan.slots || []).filter((s) => s.held && s.hand && !s.carryOver);
  if (handSlots.length > 0) {
    const slots = block(t('videoOptions.script.slotsHeading'));
    const list = el('ul', 'video-options__slots');
    for (const s of handSlots) {
      const li = el('li', 'video-options__slot');
      li.appendChild(el('span', 'video-options__slot-name', slotText(s)));
      li.appendChild(el('span', 'video-options__tag', t(s.active ? 'videoOptions.script.slot.plays' : 'videoOptions.script.slot.saved')));
      if (plan.offered && s.change === 'remove') li.appendChild(el('span', 'video-options__tag video-options__tag--warn', t('videoOptions.script.slot.unpairRemoves')));
      else if (plan.offered && s.change === 'keep') li.appendChild(el('span', 'video-options__tag', t('videoOptions.script.slot.unpairKeeps')));
      // What you made can always be removed here (the pair dialog's ✕ that
      // did it, with no confirm and no Undo, is gone: Dave, 2026-11-18): a
      // single script you saved that does not play ("Yes, add Remove"), a
      // saved set, or the playing set when Unpair is not offered (its main
      // script is the video's own). The model says which (`planRemoveSet`).
      if (M.planRemoveSet(input, s.slot).offered) {
        const remove = button(t('common.remove'), {
          className: 'video-options__link-btn', focusKey: `script:removeSet:${s.slot}`,
          onClick: () => removeSet(ui, s.slot),
        });
        remove.setAttribute('aria-label', t(`videoOptions.script.removeSet.${s.slot}Title`));
        li.appendChild(remove);
      }
      list.appendChild(li);
    }
    slots.appendChild(list);
    p.appendChild(slots);
  }

  // Variations and the one that plays first
  const vv = M.variationsView({
    video: v,
    manual: (settings.get('library.manualVariants') || {})[path] || [],
    preferredLabel: (settings.get('library.preferredVariants') || {})[path] || null,
    randomOn: !!host.randomVariantOn?.(),
  });
  const vars = block(t('library.assoc.variations'));
  if (vv.items.length > 0) {
    const fs = el('fieldset', 'video-options__fieldset');
    fs.appendChild(el('legend', 'video-options__legend', t('videoOptions.script.playFirst')));
    const group = nextId('vo-var');
    vv.items.forEach((item, i) => {
      // Never removed because its file is missing (Dave, "Yes, stop those
      // too"): it says so, with Locate when you added it, and it is not
      // offered as the one to play first while it is missing.
      ui.askStatus(item.path);
      const answer = ui.statusByPath.get(item.path);
      const status = answer === false ? 'missing' : answer === null ? 'unknown' : null;
      const tag = el('span', 'video-options__tag', t(item.source === 'added' ? 'videoOptions.script.variation.added' : 'videoOptions.script.variation.folder'));
      let state = null;
      if (status === 'missing' && item.source === 'added') {
        state = locateButton(item.text || item.name, `variation-locate:${item.path}`, () => locateVariation(ui, item));
      } else if (status) {
        state = el('span', `video-options__status video-options__status--${status}`, t(`videoOptions.script.status.${status}`));
      }
      let remove = null;
      if (item.removable) {
        remove = button(t('common.remove'), {
          className: 'video-options__link-btn', focusKey: `variation-remove:${item.path}`,
          onClick: () => removeVariation(ui, item),
        });
        remove.setAttribute('aria-label', t('videoOptions.script.variation.removeAria', { name: item.text || item.name }));
      }
      const row = radioRow(group, item.text || item.name, {
        value: String(i),
        checked: item.playFirst,
        focusKey: `variation:${item.path}`,
        onChange: () => setPlayFirst(ui, vv, i),
        tags: [tag],
        after: [state, remove],
      });
      if (status === 'missing') {
        const radio = row.querySelector('input[type="radio"]');
        radio.disabled = true;
        row.classList.add('video-options__radio-row--missing');
      }
      fs.appendChild(row);
    });
    vars.appendChild(fs);
    if (vv.randomOverridesPin) vars.appendChild(note(t('videoOptions.script.randomHint')));
  }
  vars.appendChild(actions(host.addVariation ? button(t('videoOptions.script.addVariation'), {
    focusKey: 'script:addVariation', onClick: () => ui.runBig('script:addVariation', () => host.addVariation(ui.video)),
  }) : null));
  p.appendChild(vars);

  // Embedded axes, only when found (as the ⋮ menu had it)
  const embedded = host.embeddedAxes?.(v);
  if (embedded?.suffixes?.length > 0 && host.extractAxes) {
    const emb = block(t('videoOptions.script.embeddedHeading'));
    const b = button(t('library.kebabExtractAxes', { count: embedded.suffixes.length }), {
      focusKey: 'script:extract', onClick: () => ui.runBig('script:extract', () => host.extractAxes(ui.video)),
    });
    b.title = t('library.kebabExtractAxesTitle', { axes: embedded.suffixes.join(', ') });
    emb.appendChild(actions(b));
    p.appendChild(emb);
  }

  // Unpair
  if (view.unpair.offered || view.unpair.explanationKey) {
    const un = block(t('videoOptions.script.unpairHeading'));
    if (view.unpair.offered) {
      un.appendChild(actions(button(t('library.kebabRemoveFunscript'), {
        className: 'modal-btn modal-btn--secondary video-options__btn video-options__btn--danger',
        focusKey: 'script:unpair', onClick: () => unpairScript(ui),
      })));
    } else {
      un.appendChild(note(t(view.unpair.explanationKey)));
    }
    p.appendChild(un);
  }
}

function setPlayFirst(ui, vv, index) {
  const { settings, path } = ui;
  const item = vv.items[index];
  if (!item) return;
  // The first one plays first without a pin; any other is pinned by label,
  // as the player's star pins it.
  const plan = M.planPlayFirst({
    videoPath: path,
    preferredVariants: settings.get('library.preferredVariants') || {},
    label: index === 0 ? null : item.label,
  });
  M.runOps(plan.ops, settings);
  ui.announce(t('videoOptions.script.playFirstSet', { name: item.text || item.name }));
  ui.refresh('script');
}

function removeVariation(ui, item) {
  const { settings, path } = ui;
  const plan = M.planRemoveVariation({ videoPath: path, manualVariants: settings.get('library.manualVariants') || {}, path: item.path });
  if (!plan.changed) return;
  M.runOps(plan.ops, settings);
  ui.announce(t('videoOptions.script.variation.removed', { name: item.text || item.name }), {
    focusKey: `variation-remove:${item.path}`,
    run: () => {
      const undo = M.planEntryUndo(plan, settings.get('library.manualVariants') || {});
      if (!undo.ok) return { message: undoMessage(undo) };
      M.runOps(undo.ops, settings);
      return {};
    },
  });
  ui.refresh('script');
  ui.focusUndo();
}

/**
 * Unpair funscript: a stacked confirm (Cancel and Escape change nothing),
 * then the plan's ops, which keep a set you saved in another slot. Undo
 * writes the entry back JSON-equal and re-applies it (model).
 */
async function unpairScript(ui) {
  const { settings, host } = ui;
  const plan = M.planUnpair(ui.scriptInput());
  const words = M.unpairConfirmMessages(plan);
  if (!plan.offered || !words) return;
  const ok = await confirmDialog(
    t(words.titleKey),
    words.lines.map((l) => t(l.key, l.params)).join('\n'),
    t(words.confirmKey),
  );
  if (ok !== true) { ui.focusKey('script:unpair'); return; }
  M.runOps(plan.ops, settings);
  host.unpairApplied?.(ui.video, plan);
  ui.announce(t(words.doneMessage.key, words.doneMessage.params), {
    focusKey: 'script:unpair',
    run: () => {
      const undo = M.planUnpairUndo(plan, settings.get('library.associations') || {});
      if (!undo.ok) return { message: undo.message ? t(undo.message.key, undo.message.params) : undoMessage(undo) };
      M.runOps(undo.ops, settings);
      // The script that could not be read before the Unpair goes back to
      // falling back to the video's own (R4-06), as it did (review-a RA-8).
      host.unpairUndone?.(ui.video, undo.reapply, { fallbackFrom: plan.fallbackFrom || null });
      return { message: t(undo.message.key, undo.message.params) };
    },
  });
  ui.refreshAll();
  ui.focusUndo();
}

/**
 * Remove a Multi Axis set or Custom Routing you made, from the Saved
 * pairings list: a stacked confirm that names it (and what plays next when
 * it is the one playing), then the plan's ops; Undo writes the entry back
 * JSON-equal, unless a pairing you made since is there (it wins).
 */
async function removeSet(ui, slotName) {
  const { settings, host } = ui;
  const focusKey = `script:removeSet:${slotName}`;
  const plan = M.planRemoveSet(ui.scriptInput(), slotName);
  const words = M.removeSetConfirmMessages(plan);
  if (!plan.offered || !words) return;
  const ok = await confirmDialog(
    t(words.titleKey),
    words.lines.map((l) => t(l.key, l.params)).join('\n'),
    t(words.confirmKey),
  );
  if (ok !== true) { ui.focusKey(focusKey); return; }
  M.runOps(plan.ops, settings);
  // A saved set does not play: nothing on the video changes. The playing
  // one goes as an Unpair goes (the video plays its own script).
  if (plan.playing) host.unpairApplied?.(ui.video, plan);
  ui.announce(t(words.doneMessage.key, words.doneMessage.params), {
    focusKey,
    run: () => {
      const undo = M.planRemoveSetUndo(plan, settings.get('library.associations') || {});
      if (!undo.ok) return { message: undo.message ? t(undo.message.key, undo.message.params) : undoMessage(undo) };
      M.runOps(undo.ops, settings);
      if (plan.playing) host.unpairUndone?.(ui.video, undo.reapply, { fallbackFrom: plan.fallbackFrom || null });
      return { message: t(undo.message.key, undo.message.params) };
    },
  });
  ui.refreshAll();
  ui.focusUndo();
}

/** "Script not found" as a control: it opens the file picker (Locate). */
function locateButton(name, focusKey, onClick) {
  const b = button(t('videoOptions.script.status.missing'), {
    className: 'video-options__status video-options__status--missing video-options__locate', focusKey, onClick,
  });
  const words = t('videoOptions.script.locate.aria', { name });
  b.setAttribute('aria-label', words);
  b.title = words;
  return b;
}

/**
 * Locate (Dave, 2026-11-18): the native picker at the folder the stored
 * path points to (or its nearest folder that exists; nothing is created),
 * funscripts only. The file picked replaces only that path; Cancel changes
 * nothing; Undo puts the old path back exactly.
 */
async function locateMain(ui) {
  const { settings, host } = ui;
  const from = M.scriptView(ui.scriptInput()).main?.path;
  if (!from || typeof host.locateScript !== 'function') return;
  let picked = null;
  try { picked = await host.locateScript(from); } catch (err) { console.warn('[VideoOptions] locate failed', err); }
  if (!ui.body?.isConnected) return;
  const plan = picked ? M.planLocateMain(ui.scriptInput(), picked) : null;
  if (!plan?.offered) { ui.focusKey('script:locate'); return; }
  M.runOps(plan.ops, settings);
  host.pairingChanged?.(ui.video, plan.reapply);
  ui.statusByPath.delete(picked);
  ui.announce(t('videoOptions.script.locate.done', { name: plan.name, newName: plan.newName }), {
    focusKey: 'script:locate',
    run: () => {
      const undo = M.planLocateUndo(plan, settings.get('library.associations') || {});
      if (!undo.ok) return { message: undo.message ? t(undo.message.key, undo.message.params) : undoMessage(undo) };
      M.runOps(undo.ops, settings);
      host.pairingChanged?.(ui.video, undo.reapply);
      return { message: t(undo.message.key, undo.message.params) };
    },
  });
  ui.refreshAll();
  ui.focusUndo();
}

async function locateVariation(ui, item) {
  const { settings, host, path } = ui;
  const focusKey = `variation-locate:${item.path}`;
  if (typeof host.locateScript !== 'function') return;
  let picked = null;
  try { picked = await host.locateScript(item.path); } catch (err) { console.warn('[VideoOptions] locate failed', err); }
  if (!ui.body?.isConnected) return;
  const plan = picked ? M.planLocateVariation({
    videoPath: path, manualVariants: settings.get('library.manualVariants') || {}, from: item.path, to: picked,
  }) : null;
  if (!plan?.offered) { ui.focusKey(focusKey); return; }
  M.runOps(plan.ops, settings);
  ui.statusByPath.delete(picked);
  ui.announce(t('videoOptions.script.locate.done', { name: plan.name, newName: plan.newName }), {
    focusKey: `variation:${picked}`,
    run: () => {
      const undo = M.planLocateUndo(plan, settings.get('library.manualVariants') || {});
      if (!undo.ok) return { message: undo.message ? t(undo.message.key, undo.message.params) : undoMessage(undo) };
      M.runOps(undo.ops, settings);
      return { message: t(undo.message.key, undo.message.params) };
    },
  });
  ui.refreshAll();
  ui.focusUndo();
}

/** Every confirm the dialog asks (one Modal.confirm call site). */
function confirmDialog(title, message, confirmText) {
  return Modal.confirm(title, message, { confirmText });
}

// ---- Subtitles ----

function renderSubtitles(ui, p) {
  const { host, settings, path } = ui;
  const v = ui.video;
  const map = settings.get('library.subtitleAssociations') || {};
  const chosen = Object.prototype.hasOwnProperty.call(map, path);
  const sub = block(t('videoOptions.subtitles.heading'));
  if (v.hasSubtitle && v.subtitlePath) {
    const line = el('div', 'video-options__row');
    line.appendChild(el('span', 'video-options__name', M.fileName(v.subtitlePath)));
    line.appendChild(el('span', 'video-options__tag', t(v._manualSubtitle ? 'videoOptions.script.pairing.single' : 'videoOptions.script.pairing.byName')));
    sub.appendChild(line);
    sub.appendChild(el('p', 'video-options__path', v.subtitlePath));
  } else {
    sub.appendChild(note(t('videoOptions.subtitles.none')));
  }
  sub.appendChild(actions(button(v.hasSubtitle ? t('videoOptions.script.change') : t('library.kebabAssociateSubtitle'), {
    focusKey: 'subtitles:change',
    onClick: async () => {
      // Small: it stacks on top, then this section shows the result.
      await host.changeSubtitle?.(ui.video);
      if (!ui.body?.isConnected) return;
      ui.refreshAll();
      ui.focusKey('subtitles:change');
    },
  })));
  if (v._manualSubtitle && chosen) {
    sub.appendChild(actions(button(t('library.kebabRemoveSubtitle'), {
      className: 'modal-btn modal-btn--secondary video-options__btn video-options__btn--danger',
      focusKey: 'subtitles:unpair', onClick: () => unpairSubtitle(ui),
    })));
  } else if (v.hasSubtitle) {
    sub.appendChild(note(t('videoOptions.subtitles.byName')));
  }
  p.appendChild(sub);
}

async function unpairSubtitle(ui) {
  const { settings, host, path } = ui;
  const plan = M.planUnpairSubtitle({ videoPath: path, subtitleAssociations: settings.get('library.subtitleAssociations') || {} });
  if (!plan.offered) return;
  const ok = await confirmDialog(
    t('library.kebabRemoveSubtitle'),
    t('videoOptions.script.unpair.confirmQuestion', { name: plan.name }),
    t('videoOptions.script.unpair.confirmButton'),
  );
  if (ok !== true) { ui.focusKey('subtitles:unpair'); return; }
  M.runOps(plan.ops, settings);
  host.subtitleChanged?.(ui.video, null);
  ui.announce(t('videoOptions.script.unpair.done', { name: plan.name }), {
    focusKey: 'subtitles:unpair',
    run: () => {
      const undo = M.planEntryUndo(plan, settings.get('library.subtitleAssociations') || {});
      if (!undo.ok) return { message: undoMessage(undo) };
      M.runOps(undo.ops, settings);
      host.subtitleChanged?.(ui.video, typeof plan.before === 'string' ? plan.before : null);
      return { message: t('videoOptions.script.unpair.undone', { name: plan.name }) };
    },
  });
  ui.refreshAll();
  ui.focusUndo();
}

// ---- Playback ----

function renderPlayback(ui, p) {
  const { host, settings, path } = ui;
  const sync = block(t('connection.handy.syncOffset'));
  // This video's delta, read from the map as stored (no re-home on open).
  const row = createVideoSyncOffsetRow({
    getState: () => ({ path, ms: videoSyncOffsetOf(settings.get('library.syncOffsets') || {}, path) }),
    onChange: (ms) => {
      settings.set('library.syncOffsets', withVideoSyncOffset(settings.get('library.syncOffsets') || {}, path, ms));
      host.syncOffsetChanged?.(path);
    },
  });
  sync.appendChild(row.el);
  p.appendChild(sync);

  const prog = block(t('videoOptions.playback.progressHeading'));
  const pv = M.progressView({ entry: (settings.get('library.resumePositions') || {})[path], duration: ui.video.duration });
  prog.appendChild(el('p', 'video-options__row', progressText(pv) || t('videoOptions.playback.notStarted')));
  if (pv.canReset) {
    prog.appendChild(actions(button(t('playlists.resetProgress'), {
      focusKey: 'playback:reset', onClick: () => resetProgress(ui),
    })));
  }
  p.appendChild(prog);
}

function resetProgress(ui) {
  const { settings, host, path } = ui;
  const plan = M.planResetProgress({ videoPath: path, resumePositions: settings.get('library.resumePositions') || {} });
  if (!plan.changed) return;
  M.runOps(plan.ops, settings);
  host.dataChanged?.('progress');
  ui.announce(t('videoOptions.playback.progressReset'), {
    focusKey: 'playback:reset',
    run: () => {
      const undo = M.planEntryUndo(plan, settings.get('library.resumePositions') || {});
      if (!undo.ok) return { message: undoMessage(undo) };
      M.runOps(undo.ops, settings);
      host.dataChanged?.('progress');
      return {};
    },
  });
  ui.refreshAll();
  ui.focusUndo();
}

// ---- Thumbnail ----

function renderThumbnail(ui, p) {
  const { host, settings, path } = ui;
  const entry = (settings.get('library.customThumbnails') || {})[path];
  const sec = block(t('videoOptions.rail.thumbnail'));
  const tile = el('div', 'video-options__tile');
  const url = host.thumbnailUrl?.(path);
  if (url) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    tile.appendChild(img);
  } else {
    tile.appendChild(icon(Clapperboard, { width: 32, height: 32 }));
  }
  tile.setAttribute('aria-hidden', 'true');
  sec.appendChild(tile);
  let kind = 'auto';
  if (entry && typeof entry === 'object') kind = entry.type === 'image' ? 'image' : 'frame';
  sec.appendChild(note(t(`videoOptions.thumbnail.${kind}`)));
  sec.appendChild(actions(
    host.pickFrame ? button(t('library.customThumbSet'), {
      focusKey: 'thumbnail:pick', onClick: () => ui.runBig('thumbnail:pick', () => host.pickFrame(ui.video)),
    }) : null,
    host.uploadImage ? button(t('library.customThumbUpload'), {
      focusKey: 'thumbnail:upload',
      onClick: async () => {
        await host.uploadImage(ui.video);
        if (!ui.body?.isConnected) return;
        ui.refreshAll();
        ui.focusKey('thumbnail:upload');
      },
    }) : null,
    entry ? button(t('library.customThumbReset'), {
      focusKey: 'thumbnail:reset', onClick: () => resetThumbnail(ui),
    }) : null,
  ));
  p.appendChild(sec);
}

function resetThumbnail(ui) {
  const { settings, host, path } = ui;
  // Drops the map entry only: the imported image stays in custom-thumbs,
  // so Undo can put the entry back.
  const plan = M.planResetThumbnail({ videoPath: path, customThumbnails: settings.get('library.customThumbnails') || {} });
  if (!plan.changed) return;
  M.runOps(plan.ops, settings);
  host.thumbnailChanged?.(ui.video);
  ui.announce(t('library.customThumbResetDone'), {
    focusKey: 'thumbnail:reset',
    run: () => {
      const undo = M.planEntryUndo(plan, settings.get('library.customThumbnails') || {});
      if (!undo.ok) return { message: undoMessage(undo) };
      M.runOps(undo.ops, settings);
      host.thumbnailChanged?.(ui.video);
      return {};
    },
  });
  ui.refreshAll();
  ui.focusUndo();
}

// ---- VR ----

function formatSummary(format) {
  if (!format) return t('videoOptions.vr.formatAuto');
  const parts = [t(`vrFormat.projection.${format.projection}`)];
  if (format.eye) parts.push(t(`vrFormat.eye.${format.eye}`));
  if (format.zoom && format.zoom !== 1) parts.push(t('vrFormat.zoomLabel', { value: format.zoom }));
  return parts.join(' · ');
}

function renderVR(ui, p) {
  const { host, settings, path } = ui;
  const vr = M.vrView({
    videoPath: path,
    manualVRType: settings.get('library.manualVRType') || {},
    vrFormat: settings.get('library.vrFormat') || {},
  });
  const sec = block(t('videoOptions.rail.vr'));
  const fs = el('fieldset', 'video-options__fieldset');
  fs.appendChild(el('legend', 'video-options__legend', t('videoOptions.vr.legend')));
  const group = nextId('vo-vr');
  const choices = [
    ['auto', t('videoOptions.vr.auto', { detected: vr.detected ? 'vr' : 'flat' })],
    ['vr', t('videoOptions.vr.vr')],
    ['flat', t('videoOptions.vr.flat')],
  ];
  for (const [value, text] of choices) {
    fs.appendChild(radioRow(group, text, {
      value, checked: vr.mode === value, focusKey: `vr:${value}`,
      onChange: (mode) => setVRMode(ui, mode),
    }));
  }
  sec.appendChild(fs);
  p.appendChild(sec);

  const fmt = block(t('vrFormat.title'));
  fmt.appendChild(el('p', 'video-options__row', formatSummary(vr.format)));
  if (host.openVRFormat) {
    fmt.appendChild(actions(button(t('library.kebabVRFormat'), {
      focusKey: 'vr:format', onClick: () => ui.runBig('vr:format', () => host.openVRFormat(path)),
    })));
  }
  p.appendChild(fmt);
}

function setVRMode(ui, mode) {
  const { settings, host, path } = ui;
  const plan = M.planSetVRMode({ videoPath: path, manualVRType: settings.get('library.manualVRType') || {}, mode });
  if (!plan.changed) return;
  M.runOps(plan.ops, settings);
  host.vrChanged?.(ui.video);
  const word = plan.mode === 'vr' ? 'library.markedAsVR' : plan.mode === 'flat' ? 'library.markedAsFlat' : 'library.vrReset';
  ui.announce(t(word));
  ui._renderHeader();
}

// ---- File ----

function fact(dl, label, value) {
  dl.appendChild(el('dt', 'video-options__fact-label', label));
  const dd = el('dd', 'video-options__fact-value', value);
  dl.appendChild(dd);
  return dd;
}

function renderFile(ui, p) {
  const { host, path } = ui;
  const v = ui.video;
  const fv = M.fileView({ path, size: ui.size, source: v.sourceName });
  const sec = block(t('videoOptions.rail.file'));
  const dl = el('dl', 'video-options__facts-list');
  fact(dl, t('videoOptions.file.path'), fv.path).classList.add('video-options__path');
  fact(dl, t('videoOptions.file.folder'), fv.folder || '—');
  fact(dl, t('videoOptions.file.size'), fv.size == null ? t('videoOptions.file.unknown') : formatFileSize(fv.size));
  fact(dl, t('videoOptions.file.source'), fv.source || '—');
  sec.appendChild(dl);
  sec.appendChild(actions(
    host.showInFolder ? button(t('library.openFileLocation'), {
      focusKey: 'file:open', onClick: () => host.showInFolder(path),
    }) : null,
    button(t('videoOptions.file.copyPath'), {
      focusKey: 'file:copy',
      onClick: async () => {
        let ok = false;
        try { ok = (await host.copyText?.(path)) !== false; } catch { ok = false; }
        ui.announce(t(ok ? 'videoOptions.file.copied' : 'videoOptions.file.copyFailed'));
      },
    }),
  ));
  p.appendChild(sec);

  // Stash S1: the block under the file facts (nothing while Stash is off).
  const stash = renderStash(ui);
  if (stash) p.appendChild(stash);

  // The size is read when this section is first shown (a stat, read-only).
  if (!ui.sizeLoaded && typeof host.statFile === 'function') {
    ui.sizeLoaded = true;
    Promise.resolve(host.statFile(path)).then((size) => {
      ui.size = Number.isFinite(size) ? size : null;
      if (ui.body?.isConnected) ui.refresh('file');
    }, () => {});
  }
}

// ---- File > Stash (Stash S1) ----
//
// DESIGN-stash-s1.md (b) "Ambiguity and how you resolve it", (e), (f). The
// block reads the view (stashVideoView) and nothing else; every change is
// one request through host.stash (main writes, and hands back the Undo
// token its restore takes as it is). A failed request keeps every stored
// fact on screen and says why, in Stash's own words where it has them.

/** Library-file answers that mean the video's Stash data moved on meanwhile. */
const STASH_STALE_CODES = new Set(['not-a-candidate', 'not-linked', 'nothing-to-refuse', 'no-fingerprint', 'changed-since']);
/** The oldest Stash FunSync reads (electron/stash-client.js MIN_STASH_VERSION). */
const STASH_MIN_VERSION = '0.27.0';
/** Library-file answers that mean FunSync could not save the change. */
const STASH_SAVE_CODES = new Set(['damaged', 'write-failed', 'too-large', 'not-loaded', 'restore-failed']);

/** Two Stash addresses name the same server (no trailing slash, any case). */
function sameStashServer(a, b) {
  const canon = (u) => String(u ?? '').trim().replace(/\/+$/, '').toLowerCase();
  return canon(a) === canon(b);
}

function ownValue(map, key) {
  return map && typeof map === 'object' && typeof key === 'string' && Object.prototype.hasOwnProperty.call(map, key)
    ? map[key] : undefined;
}

/**
 * Stash scene ids are unique only per server (Dave's answers after Round 1,
 * item 3): a stored scene that came from another server than the link's is
 * not this link's scene, so none of its facts show here.
 */
function withServerCheck(view, data) {
  if (!view?.link || !view.scene) return view;
  const raw = ownValue(data?.scenes, String(view.link.sceneId ?? ''));
  const sceneServer = typeof raw?.server === 'string' && raw.server ? raw.server : null;
  if (!sceneServer || !view.link.server || sameStashServer(sceneServer, view.link.server)) return view;
  return { ...view, scene: null, counts: { tags: 0, performers: 0, studio: 0 }, sceneFromOtherServer: true };
}

/** host.stash's Open in Stash (`openInStash(path, sceneId)`: main opens the link's own server), or null. */
function stashOpener(host) {
  const s = host?.stash;
  return typeof s?.openInStash === 'function' ? (id, path) => s.openInStash(path, id) : null;
}

/** The Undo token in main's answer (`undoId`, or the `undo` it hands back), passed back as it is. */
function stashUndoToken(res) {
  const token = res?.undoId ?? res?.undo;
  if (typeof token === 'string' && token) return token;
  return token && typeof token === 'object' ? token : null;
}

/** The failure code in a host.stash answer, or null when it went through. */
function stashFailure(res) {
  if (!res || typeof res !== 'object') return 'failed';
  if (res.ok !== false) return null;
  if (typeof res.code === 'string' && res.code) return res.code;
  if (res.error && typeof res.error === 'object' && typeof res.error.code === 'string' && res.error.code) return res.error.code;
  if (typeof res.error === 'string' && res.error) return res.error;
  return 'failed';
}

/**
 * The words for a Stash failure (DESIGN-stash-s1.md (e)): Stash's reasons
 * (`stash.error.<code>`, shared with Settings), else this dialog's own.
 *
 * @param {string} code
 * @param {{address?: string, version?: string, minVersion?: string}} [facts]
 */
export function stashErrorText(code, facts = {}) {
  if (code === 'skipped') return t('videoOptions.stash.error.fileOffline');
  if (code === 'busy') return t('videoOptions.stash.error.busy');
  if (code === 'cancelled') return t('videoOptions.stash.error.cancelled');
  if (STASH_STALE_CODES.has(code)) return t('videoOptions.stash.error.changedMeanwhile');
  if (STASH_SAVE_CODES.has(code)) return t('videoOptions.stash.error.saveFailed');
  // The reasons stage s1-1a words (Settings shows the same ones).
  let key = null;
  let params;
  if (code === 'unreachable') {
    key = 'stash.error.unreachable';
    params = { address: facts.address || '' };
  } else if (code === 'tooOld') {
    const min = String(facts.minVersion || STASH_MIN_VERSION).replace(/^v/i, '');
    key = facts.version ? 'stash.error.tooOld' : 'stash.error.tooOldNoVersion';
    params = { version: facts.version ? (/^v/i.test(facts.version) ? facts.version : `v${facts.version}`) : '', minVersion: min };
  } else if (code === 'http') {
    key = 'stash.error.http';
    params = { status: facts.status != null ? String(facts.status) : '' };
  } else if (code === 'unknownQuery') {
    key = 'stash.error.badInput';
  } else if (code === 'notLinked') {
    key = 'settingsPanel.stash.errorNotLinked';
  } else if (typeof code === 'string' && /^[A-Za-z]{1,40}$/.test(code)) {
    key = `stash.error.${code}`;
  }
  if (key) {
    const words = params ? t(key, params) : t(key);
    if (typeof words === 'string' && words && words !== key) return words;
  }
  return t('videoOptions.stash.error.generic');
}

/** What the error words may name: the address FunSync asked, the version Stash gave. */
function stashFacts(ui, res) {
  const data = ui.stashData();
  const address = typeof data?.server?.url === 'string' ? data.server.url : '';
  const src = res?.error && typeof res.error === 'object' ? res.error : (res || {});
  const pick = (k) => (typeof src[k] === 'string' ? src[k] : (typeof res?.[k] === 'string' ? res[k] : ''));
  const status = Number.isFinite(src.status) ? src.status : (Number.isFinite(res?.status) ? res.status : null);
  return { address, version: pick('version'), minVersion: pick('minVersion'), status };
}

function stashShortDate(value) {
  const ms = typeof value === 'number' ? value : (typeof value === 'string' ? Date.parse(value) : NaN);
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  try {
    return new Intl.DateTimeFormat(getCurrentLocale(), sameYear
      ? { day: 'numeric', month: 'short' }
      : { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** A count as the locale writes it ("1,234"). */
function stashCount(n) {
  try {
    return new Intl.NumberFormat(getCurrentLocale()).format(n);
  } catch {
    return String(n);
  }
}

function stashClock(ui, seconds) {
  try { if (typeof ui.host.formatDuration === 'function') return ui.host.formatDuration(seconds); } catch { /* own below */ }
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** The scene's name for words: “Title”, else "Scene <id>". */
function stashNameOf(view) {
  return stashSceneName(view?.scene || { id: view?.link?.sceneId ?? null });
}

/**
 * The labels the chips, the Tags filter and the cards show for this
 * scene's performers and studio (the index's one-label pass: "Jane Doe
 * (blonde)", "Jane Doe · 3f2a"); a name the index does not have shows
 * as Stash gave it.
 */
function stashPeopleLabels(ui, view, data) {
  const out = { performers: new Map(), studio: null };
  if (!view.scene || view.hidden) return out;
  let record = null;
  try {
    record = ownValue(stashTagRecords(data, { videos: [{ path: ui.path, size: ui.video.size }], enabled: true }), ui.path);
  } catch {
    record = null;
  }
  if (!record) return out;
  const index = ui.tagIndexResult();
  const counts = index?.counts instanceof Map ? index.counts : null;
  const tagSettings = ui.settings.get('library.tagSettings') || {};
  let tags = [];
  try {
    tags = effectiveTags(ui.path, { stash: { [ui.path]: record } }, {
      aliases: tagSettings.aliases || {},
      facetOverrides: tagSettings.facetOverrides || {},
      ...(index?.nameIds ? { nameIds: index.nameIds } : {}),
    });
  } catch {
    tags = [];
  }
  const performerIds = new Set(view.scene.performers.map((p) => String(p.id)));
  const studioId = view.scene.studio ? String(view.scene.studio.id) : null;
  for (const tag of tags) {
    const label = counts?.get(tag.key)?.label ?? tagDisplayLabel(tag);
    for (const ref of tag.refs || []) {
      if (ref.source !== 'stash' || ref.id == null) continue;
      const id = String(ref.id);
      if (tag.facet === 'performer' && performerIds.has(id) && !out.performers.has(id)) out.performers.set(id, label);
      else if (tag.facet === 'studio' && id === studioId && !out.studio) out.studio = label;
    }
  }
  return out;
}

function stashPersonName(p) {
  return p.disambiguation ? `${p.name} (${p.disambiguation})` : p.name;
}

/** A Stash button: aria-disabled while a Stash request runs (it keeps the focus). */
function stashButton(ui, text, focusKey, onClick, { aria = null, danger = false } = {}) {
  const b = button(text, {
    className: `modal-btn modal-btn--secondary video-options__btn${danger ? ' video-options__btn--danger' : ''}`,
    focusKey,
    onClick: () => {
      if (ui.stashBusy || b.getAttribute('aria-disabled') === 'true') return;
      onClick();
    },
  });
  if (aria) b.setAttribute('aria-label', aria);
  if (ui.stashBusy) b.setAttribute('aria-disabled', 'true');
  return b;
}

/** The Stash block for File, or null while Stash is off. */
function renderStash(ui) {
  const view = ui.stashView();
  if (!view) return null;
  const data = ui.stashData();
  const sec = block(t('videoOptions.stash.heading'));
  sec.classList.add('video-options-stash');
  sec.dataset.stashState = view.state;
  if (ui.stashBusy) sec.setAttribute('aria-busy', 'true');
  const link = view.link;
  const otherServer = !!(link?.otherServer || view.sceneFromOtherServer);

  // A link made with another Stash: its data is kept (design (e)).
  if (link?.otherServer && link.server) {
    sec.appendChild(note(t('videoOptions.stash.otherServer', { address: link.server }), 'video-options__note video-options-stash__other'));
  }

  const buttons = [];
  const sync = () => stashButton(ui, ui.stashBusy === 'sync' ? t('videoOptions.stash.syncing') : t('videoOptions.stash.syncVideo'),
    'stash:sync', () => syncStashVideo(ui));
  const find = () => stashButton(ui, t('videoOptions.stash.find'), 'stash:find', () => findInStash(ui));
  const unlink = () => stashButton(ui, t('videoOptions.stash.unlink'), 'stash:unlink', () => unlinkStash(ui, view), { danger: true });
  const open = () => (view.sceneFromOtherServer || !stashOpener(ui.host) ? null
    : stashButton(ui, t('videoOptions.stash.open'), 'stash:open', () => ui.openStashScene(link.sceneId), { aria: t('videoOptions.stash.openAria') }));

  switch (view.state) {
    case 'linked':
      renderStashScene(ui, sec, view, data);
      buttons.push(open(), sync());
      if (otherServer) buttons.push(unlink());
      else buttons.push(stashButton(ui, t('videoOptions.stash.notThis'), 'stash:notThis', () => refuseStashLink(ui, view)));
      break;
    case 'gone':
      renderStashScene(ui, sec, view, data);
      sec.appendChild(note(t('videoOptions.stash.gone'), 'video-options__note video-options__note--warn'));
      buttons.push(unlink(), sync());
      break;
    case 'changed':
      sec.appendChild(el('p', 'video-options__row video-options-stash__title', stashNameOf(view)));
      // The Stash scene with that id no longer has this file (a Stash reset
      // or rescan; s1-fixup-main S1RB-4), or this file changed.
      sec.appendChild(note(t(view.link?.sceneChanged ? 'videoOptions.stash.sceneChanged' : 'videoOptions.stash.changed'),
        'video-options__note video-options__note--warn'));
      buttons.push(sync(), unlink());
      break;
    case 'check':
      renderStashCheck(ui, sec, view);
      if (!link) buttons.push(find());
      buttons.push(sync());
      break;
    case 'refused': {
      const scenes = view.refused?.scenes || [];
      sec.appendChild(note(scenes.length === 1
        ? t('videoOptions.stash.refused', { name: stashSceneName(scenes[0]) })
        : t('videoOptions.stash.refusedSome', { count: scenes.length })));
      buttons.push(find(), sync());
      break;
    }
    case 'notInStash':
      sec.appendChild(note(t('videoOptions.stash.notFound')));
      buttons.push(find(), sync());
      break;
    default:
      sec.appendChild(note(t('videoOptions.stash.notSynced')));
      buttons.push(find(), sync());
      break;
  }

  // The last request from here failed: why, in words; nothing was changed.
  if (ui.stashError) {
    sec.appendChild(note(stashErrorText(ui.stashError.code, ui.stashError.facts),
      'video-options__note video-options__note--warn video-options-stash__error'));
  }
  sec.appendChild(actions(...buttons));
  return sec;
}

/** A linked scene's facts (linked, gone): title line, details, people, markers, links. */
function renderStashScene(ui, sec, view, data) {
  const scene = view.scene;
  const link = view.link;
  const people = stashPeopleLabels(ui, view, data);

  const head = el('p', 'video-options__row video-options-stash__title');
  head.appendChild(el('span', 'video-options__name', stashNameOf(view)));
  const headBits = [];
  if (scene?.date) headBits.push(scene.date);
  if (scene?.studio) {
    const studio = people.studio || scene.studio.name;
    headBits.push(scene.studio.parent ? t('videoOptions.stash.studioOf', { studio, parent: scene.studio.parent }) : studio);
  }
  if (headBits.length) head.appendChild(el('span', 'video-options-stash__facts', headBits.join(' · ')));
  sec.appendChild(head);

  if (scene) {
    const bits = [];
    if (scene.code) bits.push(t('videoOptions.stash.code', { code: scene.code }));
    if (scene.rating100 != null) bits.push(t('videoOptions.stash.rated', { rating: scene.rating100 }));
    if (scene.organized) bits.push(t('videoOptions.stash.organised'));
    if (scene.director) bits.push(t('videoOptions.stash.director', { name: scene.director }));
    if (scene.markers.length) bits.push(t('videoOptions.stash.markerCount', { count: scene.markers.length }));
    if (bits.length) sec.appendChild(el('p', 'video-options__note video-options-stash__line', bits.join(' · ')));
  }

  const how = [];
  if (link?.by === 'oshash' || link?.by === 'chosen' || link?.by === 'manual') how.push(t(`videoOptions.stash.by.${link.by}`));
  const synced = stashShortDate(scene?.fetchedAt);
  if (synced) how.push(t('videoOptions.stash.synced', { date: synced }));
  if (link?.verify) how.push(t('videoOptions.stash.verify'));
  if (how.length) sec.appendChild(el('p', 'video-options__note video-options-stash__line', how.join(' · ')));

  if (!scene) return;
  const dl = el('dl', 'video-options__facts-list video-options-stash__facts-list');
  // Stash's plays, last played and O-count (the "next" lot, DESIGN-stash-s1.md
  // (j) #10): read-only, from the data already synced; a line Stash gave no
  // value for is left out, and "never" only when Stash counts no plays.
  const activity = view.hidden ? null : stashActivity(stashSceneFields(data, ui.path, {
    size: Number.isFinite(ui.video?.size) ? ui.video.size : undefined, enabled: true,
  }));
  if (activity) {
    if (activity.plays != null) fact(dl, t('videoOptions.stash.plays'), stashCount(activity.plays)).dataset.stashFact = 'plays';
    if (activity.lastPlayed === 'never') fact(dl, t('videoOptions.stash.lastPlayed'), t('videoOptions.stash.lastPlayedNever')).dataset.stashFact = 'lastPlayed';
    else if (activity.lastPlayed) {
      const when = stashShortDate(activity.lastPlayed.ms);
      if (when) fact(dl, t('videoOptions.stash.lastPlayed'), when).dataset.stashFact = 'lastPlayed';
    }
    if (activity.oCount != null) fact(dl, t('videoOptions.stash.oCount'), stashCount(activity.oCount)).dataset.stashFact = 'oCount';
  }
  if (scene.performers.length) {
    const names = scene.performers.map((p) => people.performers.get(String(p.id)) || stashPersonName(p));
    fact(dl, t('videoOptions.stash.performers'), names.join(', '));
  }
  if (scene.markers.length) {
    const shown = scene.markers.slice(0, 50).map((m) => {
      const name = m.title || m.tag || '';
      return name ? `${stashClock(ui, m.seconds)} ${name}` : stashClock(ui, m.seconds);
    });
    if (scene.markers.length > shown.length) shown.push(t('videoOptions.stash.moreMarkers', { count: scene.markers.length - shown.length }));
    fact(dl, t('videoOptions.stash.markers'), shown.join(' · '));
  }
  if (scene.urls.length) {
    const dd = fact(dl, t('videoOptions.stash.urls'), null);
    const list = el('ul', 'video-options-stash__urls');
    scene.urls.forEach((url, i) => {
      const li = el('li', 'video-options-stash__url');
      li.appendChild(el('span', 'video-options-stash__url-text', url));
      const copy = button(t('videoOptions.stash.copyUrl'), {
        className: 'video-options__link-btn video-options-stash__copy',
        focusKey: `stash:copyUrl:${i}`,
        onClick: async () => {
          let ok = false;
          try { ok = typeof ui.host.copyText === 'function' && (await ui.host.copyText(url)) !== false; } catch { ok = false; }
          ui.announce(t(ok ? 'videoOptions.stash.urlCopied' : 'videoOptions.stash.urlCopyFailed'));
        },
      });
      copy.setAttribute('aria-label', t('videoOptions.stash.copyUrlAria', { url }));
      li.appendChild(copy);
      list.appendChild(li);
    });
    dd.appendChild(list);
  }
  if (dl.childNodes.length) sec.appendChild(dl);

  if (scene.details) {
    const details = document.createElement('details');
    details.className = 'video-options-stash__details';
    const summary = el('summary', 'video-options-stash__summary', t('videoOptions.stash.showDescription'));
    summary.dataset.voFocus = 'stash:details';
    details.append(summary, el('p', 'video-options-stash__description', scene.details));
    sec.appendChild(details);
  }

  for (const copyPath of view.copies || []) {
    sec.appendChild(note(t('videoOptions.stash.copy', { path: copyPath }), 'video-options__note video-options-stash__copy-note'));
  }
}

/** Needs a check: the candidates (a radio list) and the buttons from design (b). */
function renderStashCheck(ui, sec, view) {
  const check = view.check;
  const candidates = check?.candidates || [];
  const several = check?.kind !== 'pathChanged';
  sec.appendChild(note(several
    ? t('videoOptions.stash.check.several', { count: candidates.length })
    : t('videoOptions.stash.check.pathChanged'), 'video-options__note video-options-stash__question'));
  if (view.link?.sceneId != null) {
    sec.appendChild(note(t('videoOptions.stash.check.keptLink', { name: stashNameOf(view) })));
  }
  if (!candidates.some((c) => c.sceneId === ui.stashPick)) ui.stashPick = null;
  // One candidate (a file changed at its path) needs no choice to make.
  if (candidates.length === 1) ui.stashPick = candidates[0].sceneId;

  const fs = el('fieldset', 'video-options__fieldset video-options-stash__choices');
  fs.appendChild(el('legend', 'video-options__legend', t('videoOptions.stash.check.legend')));
  const group = nextId('vo-stash');
  let use = null;
  candidates.forEach((c, i) => {
    const words = [stashSceneName({ id: c.sceneId, title: c.title }), c.date, c.studio, c.fileName].filter(Boolean).join(' · ');
    const flag = c.durationFlag && c.durationDiff != null
      ? el('span', 'video-options__tag video-options__tag--warn', t('videoOptions.stash.check.durationDiff', { seconds: Math.round(c.durationDiff) }))
      : null;
    fs.appendChild(radioRow(group, words, {
      value: c.sceneId,
      checked: ui.stashPick === c.sceneId,
      focusKey: i === 0 ? 'stash:choice' : `stash:choice:${c.sceneId}`,
      tags: [flag],
      onChange: (id) => {
        ui.stashPick = id;
        if (use) use.disabled = false;
      },
    }));
  });
  sec.appendChild(fs);

  use = stashButton(ui, several ? t('videoOptions.stash.check.use') : t('videoOptions.stash.check.useAnyway'), 'stash:use', () => {
    const picked = candidates.find((c) => c.sceneId === ui.stashPick);
    if (picked) chooseStashScene(ui, picked);
  });
  use.disabled = !ui.stashPick;
  const none = stashButton(ui, several ? t('videoOptions.stash.check.none') : t('videoOptions.stash.check.ignore'),
    'stash:none', () => refuseStashCheck(ui, view));
  sec.appendChild(actions(use, none));
}

/**
 * Run one Stash request from the block: one at a time, the block busy
 * meanwhile. A failure changes nothing on screen but the reason. `done(res)`
 * says what to tell: `{message, undo?, focusKey}`; an `undo` token goes to
 * the live line's Undo, which gives it back to main (restore) as it is.
 */
async function stashRun(ui, busy, focusKey, call, done) {
  if (ui.stashBusy) return;
  ui.stashBusy = busy;
  ui.stashError = null;
  if (ui.rendered.has('file')) ui.refresh('file');
  let res;
  try {
    res = await call();
  } catch (err) {
    res = { ok: false, code: typeof err?.code === 'string' ? err.code : 'failed' };
  }
  ui.stashBusy = null;
  const code = stashFailure(res);
  const open = !!ui.body?.isConnected;
  if (code) {
    if (!open) return;
    ui.stashError = { code, facts: stashFacts(ui, res) };
    if (ui.rendered.has('file')) ui.refresh('file');
    ui.announce(stashErrorText(code, ui.stashError.facts));
    ui.focusKey(focusKey);
    return;
  }
  ui.host.dataChanged?.('stash');
  let said = null;
  try { said = done(res) || null; } catch (err) { console.warn('[VideoOptions] Stash result', err); }
  const token = said?.undo ?? null;
  const undo = token ? { focusKey: said.focusKey || focusKey, run: () => restoreStash(ui.host, ui.path, token) } : null;
  if (!open) {
    // Closed meanwhile: what main changed keeps its Undo, in a toast.
    if (undo) offerUndoToast({ ...undo, message: said?.message || '', done: false });
    return;
  }
  ui.announce(said?.message || '', undo);
  ui.refreshAll();
  try { ui.tags?.refresh?.(); } catch { /* the section redraws on its next change */ }
  if (undo) ui.focusUndo();
  else ui.focusKey(said?.focusKey || focusKey);
}

/** The live line's Undo for a Stash change: main puts the video's link, check and refusal back exactly. */
async function restoreStash(host, path, token) {
  let res;
  try {
    res = typeof host.stash?.undo === 'function' ? await host.stash.undo(path, token) : { ok: false, code: 'failed' };
  } catch {
    res = { ok: false, code: 'failed' };
  }
  if (stashFailure(res)) return { message: t('videoOptions.stash.live.undoFailed') };
  host.dataChanged?.('stash');
  return { message: t('videoOptions.live.undone') };
}

/** Sync this video: one fingerprint lookup and its scene, for this file only (main). */
function syncStashVideo(ui) {
  if (typeof ui.host.stash?.syncVideo !== 'function') return;
  ui.announce(t('videoOptions.stash.live.syncing'));
  stashRun(ui, 'sync', 'stash:sync', () => ui.host.stash.syncVideo(ui.path), (res) => {
    const view = ui.stashView();
    const moved = Array.isArray(res?.relinked)
      ? res.relinked.find((r) => r && r.path === ui.path && stashUndoToken(r)) : null;
    if (moved) return { message: t('videoOptions.stash.live.relinked', { name: stashNameOf(view) }), undo: stashUndoToken(moved), focusKey: 'stash:sync' };
    let key = 'videoOptions.stash.live.synced';
    if (view?.state === 'linked') key = 'videoOptions.stash.live.syncedLinked';
    else if (view?.state === 'check') key = 'videoOptions.stash.live.syncedCheck';
    else if (view?.state === 'notInStash') key = 'videoOptions.stash.live.syncedNotFound';
    else if (view?.state === 'gone') key = 'videoOptions.stash.live.syncedGone';
    else if (view?.state === 'changed') key = 'videoOptions.stash.live.syncedChanged';
    return { message: t(key, { name: stashNameOf(view) }), focusKey: view?.state === 'check' ? 'stash:choice' : 'stash:sync' };
  });
}

/** Find in Stash…: the picker (a search per press), then a link of the scene picked; nothing else. */
async function findInStash(ui) {
  if (ui.stashBusy || typeof ui.host.stash?.search !== 'function' || typeof ui.host.stash?.link !== 'function') return;
  ui.stashBusy = 'search';
  let picked = null;
  try {
    picked = await openStashScenePicker({
      video: ui.video,
      search: (query) => ui.host.stash.search(query),
      errorText: (code) => stashErrorText(code, stashFacts(ui, null)),
      formatDuration: typeof ui.host.formatDuration === 'function' ? (s) => ui.host.formatDuration(s) : null,
    });
  } catch (err) {
    console.warn('[VideoOptions] Find in Stash failed', err?.message || err);
    picked = null;
  }
  ui.stashBusy = null;
  if (!ui.body?.isConnected) return;
  if (!picked) {
    ui.focusKey('stash:find');
    return;
  }
  stashRun(ui, 'link', 'stash:find', () => ui.host.stash.link(ui.path, picked.id), (res) => ({
    message: t('videoOptions.stash.live.linked', { name: stashSceneName(picked) }),
    undo: stashUndoToken(res),
    focusKey: 'stash:find',
  }));
}

/** Use this scene / Use it anyway: one of the check's candidates (`by: 'chosen'`). */
function chooseStashScene(ui, candidate) {
  if (typeof ui.host.stash?.choose !== 'function') return;
  stashRun(ui, 'choose', 'stash:use', () => ui.host.stash.choose(ui.path, candidate.sceneId), (res) => {
    ui.stashPick = null;
    return {
      message: t('videoOptions.stash.live.linked', { name: stashSceneName({ id: candidate.sceneId, title: candidate.title }) }),
      undo: stashUndoToken(res),
      focusKey: 'stash:use',
    };
  });
}

/** None of these / Ignore: every candidate refused for this file's content. */
function refuseStashCheck(ui, view) {
  if (typeof ui.host.stash?.refuse !== 'function') return;
  const several = view.check?.kind !== 'pathChanged';
  stashRun(ui, 'refuse', 'stash:none', () => ui.host.stash.refuse(ui.path, 'check'), (res) => ({
    message: t(several ? 'videoOptions.stash.live.noneOfThese' : 'videoOptions.stash.live.ignored'),
    undo: stashUndoToken(res),
    focusKey: 'stash:none',
  }));
}

/** Not this scene…: a stacked confirm, then the link goes and that scene is refused for this file. */
async function refuseStashLink(ui, view) {
  if (ui.stashBusy || typeof ui.host.stash?.refuse !== 'function') return;
  const name = stashNameOf(view);
  const ok = await confirmDialog(
    t('videoOptions.stash.notThisConfirm.title'),
    t('videoOptions.stash.notThisConfirm.message', { name }),
    t('videoOptions.stash.notThisConfirm.button'),
  );
  if (!ui.body?.isConnected) return;
  if (ok !== true) { ui.focusKey('stash:notThis'); return; }
  // The scene the confirm named goes with the request (s1-review-a RA-S1-3):
  // a sync that re-linked the file while the confirm was open never makes
  // this refuse a scene the user did not see. Main then refuses only the
  // named scene and keeps the new link (`linkChanged`), or answers
  // 'changed-since' when the file has no link any more.
  const sceneId = view?.link?.sceneId ?? undefined;
  stashRun(ui, 'refuse', 'stash:notThis', () => ui.host.stash.refuse(ui.path, 'link', sceneId), (res) => {
    let message = t('videoOptions.stash.refused', { name });
    if (res?.linkChanged === true) {
      message = `${message} ${t('videoOptions.stash.live.refusedLinkChanged', { name: stashNameOf(ui.stashView()) })}`;
    }
    return { message, undo: stashUndoToken(res), focusKey: 'stash:notThis' };
  });
}

/** Unlink (a gone scene, a changed file, a link from another Stash): the link goes, with Undo. */
function unlinkStash(ui, view) {
  if (typeof ui.host.stash?.unlink !== 'function') return;
  const name = stashNameOf(view);
  // The link the block showed: main answers 'changed-since' if it is another one now.
  const sceneId = view?.link?.sceneId ?? undefined;
  stashRun(ui, 'unlink', 'stash:unlink', () => ui.host.stash.unlink(ui.path, sceneId), (res) => ({
    message: t('videoOptions.stash.live.unlinked', { name }),
    undo: stashUndoToken(res),
    focusKey: 'stash:unlink',
  }));
}
