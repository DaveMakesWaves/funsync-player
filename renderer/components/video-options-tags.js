/**
 * The Tags section of the video options dialog (notes/features/DESIGN-video-options.md (c)).
 *
 * Built 2026-11-18 (stage 2b). What it shows and does:
 *   - one merged chip list of the video's tags (video-tags.js effectiveTags),
 *     grouped by facet, each chip naming its sources ("pov · you, EroScripts");
 *     past 24 chips a find box and "Show all (n)";
 *   - Add a tag (with suggestions from the library's tags), the × on a chip,
 *     "Hidden on this video" with Show again, and the chip menu ("Make a
 *     category from this tag…", "Remove from this video", and "Show videos
 *     with this tag" once the tag filter exists). The writers are
 *     video-tag-edits.js: adding a tag hidden on this video shows it again
 *     (Dave, 2026-11-17), removing one another source still gives hides it
 *     on this video, and the Undo puts both lists back exactly;
 *   - "Where they came from": the EroScripts post of the video's CURRENT
 *     script, with Get tags from EroScripts (eroscripts-tag-fetch.js: one
 *     request at a time for the whole app, 1 s apart, a 429 cooldown that
 *     disables every Get tags button), View post, and, when no post is known
 *     (or the record is about another script), Paste a post link… and Find
 *     the post on EroScripts… (the inline search in its link-only mode).
 *     Get tags needs the EroScripts login (Dave, answer 6): logged out, the
 *     button logs in first (the EroScripts panel's own login) and then runs
 *     once. A dead session is dropped the way the panel's search drops it.
 *   - "Change post…" (Dave, 2026-11-18) for a video whose post is known:
 *     Paste a post link or Find the post picks a different post; the video's
 *     record then names the new post with no tags yet (script-tags.js
 *     linkScriptPost), so the old post's tags stop showing at once, and the
 *     new post's come in on the next Get tags. Nothing is fetched until Get
 *     tags. Undo puts the exact old record back (undoLinkScriptPost).
 *   - A link you make is written at once, the first one as Change post…
 *     does, with the same exact Undo; Find the post only links the post and
 *     never runs Get tags (Claude's call, fixup-data 2026-11-18, design doc's
 *     last section). While this video's Get tags request is pending, Change
 *     post…, Paste a post link… and Find the post… are disabled, and an
 *     answer that lands after the record changed anyway is dropped with a
 *     quiet line (review-b RB-1).
 *   - The session check (Dave, 2026-11-18): as the section opens it asks
 *     whether the saved EroScripts login is still good (the panel's
 *     checkSession: a kept answer, so usually no request). A timed-out login
 *     is dropped there and the button reads "Log in to get tags…".
 *
 * Rules kept here: untrusted text (tag names, post titles, creators, file
 * names) goes in with textContent only, never innerHTML; mounting writes
 * nothing and sends nothing but the session check; every other request comes
 * from one press.
 *
 * The contract with the dialog (video-options-dialog.js, stage 2a):
 *
 *   mountTagsSection(host, ctx) -> { dispose(), handleEscape(event) -> boolean }
 *
 * host: an empty element owned by the dialog (the Tags panel). The section
 *       renders only inside it and never touches the rest of the dialog.
 * ctx:  {
 *   video,            // the library video object (path, funscriptPath, ...)
 *   dataService,      // the renderer DataService (cache-first reads, writes)
 *   getLibraryVideos, // () -> the library's current video list (for Make a category)
 *   onDataChanged,    // (what: string) -> void: the dialog re-renders its header /
 *                     //   other sections and the library refreshes the card
 *   announce,         // (message: string) -> void: the dialog's live line
 *                     //   (role="status"); Undo links are added by the section itself
 *   modalBody,        // the dialog's body element (to stack a Modal.confirm over it)
 *
 *   Optional (stage 2b; each has a working fallback, so a dialog that does
 *   not pass them still works):
 *   announceUndo,     // (message, {run: () => ({message?}), focusKey}) -> void: the
 *                     //   dialog's live line WITH its Undo button (it focuses that
 *                     //   button). Without it the section shows its own Undo button
 *                     //   under the list, and a toast carries it on dispose.
 *   eroscripts,       // {isLoggedIn?(), login?() -> Promise<boolean>, sessionExpired?(),
 *                     //   checkSession?({force}) -> Promise<state>}
 *                     //   Without it: main's session (eroscriptsStatus, what the
 *                     //   inline search relies on), the EroScripts panel's own login,
 *                     //   handleSessionExpired and checkSession (window.app.eroscriptsPanel).
 *                     //   sessionExpired may answer the session check's state: 'valid'
 *                     //   or 'unknown' means the login was kept (a 403 for another
 *                     //   reason), and the section says the refusal instead; with no
 *                     //   answer, isLoggedIn() afterwards tells.
 *   getScriptMeta,    // (scriptPath) -> funscriptMetaRecord | null | Promise: the
 *                     //   script file's own metadata (P1 harvest, Round 3). Without
 *                     //   it the file source and its topic link are not shown.
 *   showVideosWithTag,// (key, tag) -> void: the P1 tag filter (Round 3). Without it
 *                     //   the chip menu leaves that item out.
 *   getTagIndex,      // () -> {index: Map(path -> tags), suggestions: [{key, facet,
 *                     //   label, count}]}: the library's one memoised tag index
 *                     //   (Round 3, library-tag-filter.js), for the suggestions and
 *                     //   Make a category. Without it the section builds its own.
 *   tagQueue,         // a TagFetchQueue (tests). Without it: the app's one queue.
 *   stash,            // Stash S1 (stage s1-2c, 2026-11-18), only while the Stash link
 *                     //   is on: {view() -> stash-tags.js stashVideoView | null,
 *                     //   openScene(sceneId)}. The "Where they came from" Stash row
 *                     //   reads it. The chips' Stash source and the bare-name join
 *                     //   come from getTagIndex() (`stash`, `nameIds`), so a chip
 *                     //   reads as the library filter and the cards read it.
 * }
 * handleEscape: the dialog's onEscape asks the open section first; returns
 *       exactly true when the section consumed the press (it closed its own
 *       chip menu or suggestion list), so the dialog stays open.
 * refresh: the dialog calls it when the Stash data changed (main reported a
 *       write): the chips and the source rows are drawn again.
 * dispose: called when the section is switched away from or the dialog closes;
 *       drops listeners and cancels nothing that is already in flight
 *       (a running Get tags request finishes and saves its result).
 */

import { Modal } from './modal.js';
import { t, getCurrentLocale } from '../js/i18n.js';
import { showToast } from '../js/toast.js';
import {
  FACETS, NAME_FACETS, classifyTag, compileTagRules, effectiveTags, foldForMatch, tagIndex, tagDisplayLabel,
  withNameIds,
} from '../js/video-tags.js';
import {
  USER_TAGS_KEY, HIDDEN_TAGS_KEY, MAX_TAG_TEXT,
  planAddTag, planRemoveTag, planShowAgain, planUndo, applyWrites, hiddenOnVideo,
  planMakeCategory, applyMakeCategory, undoMakeCategory,
} from '../js/video-tag-edits.js';
import {
  FETCH_KEYS, resolveTopic, topicIdFromLink, topicUrlFor, getTagsForVideo, tagFetchQueue,
  buttonState, outcomeText,
} from '../js/eroscripts-tag-fetch.js';
import {
  SCRIPT_TAGS_KEY, TAG_MATCH, getScriptTags, linkScriptPost, undoLinkScriptPost, recordWithScriptPath,
} from '../js/script-tags.js';
import { eroscriptsRecordForTags } from '../js/video-options-model.js';

const TAG_SETTINGS_KEY = 'library.tagSettings';

/** Past this many chips the list gets a find box and "Show all (n)" (design (c)). */
export const CHIP_LIMIT = 24;
/** How many suggestions the add box lists at most. */
const SUGGESTION_LIMIT = 8;
/** How long a toast carries an Undo (the dialog's and the playlists' pattern). */
const UNDO_TOAST_MS = 8000;

/** `tags.facet.*` key names (a dash is not used in locale keys). */
const FACET_KEY = Object.freeze({ 'script-type': 'scriptType' });
const NAME_FACET_SET = new Set(NAME_FACETS);

const LIVE = Object.freeze({
  added: 'videoOptions.tags.live.added',
  addedShown: 'videoOptions.tags.live.addedShown',
  already: 'videoOptions.tags.live.already',
  removed: 'videoOptions.tags.live.removed',
  shownAgain: 'videoOptions.tags.live.shownAgain',
  undone: 'videoOptions.tags.live.undone',
  undoPartial: 'videoOptions.tags.live.undoPartial',
  linked: 'videoOptions.tags.live.linked',
  postChanged: 'videoOptions.tags.live.postChanged',
  samePost: 'videoOptions.tags.live.samePost',
  undoChangedSince: 'videoOptions.tags.live.undoChangedSince',
  getTagsUndone: 'videoOptions.tags.live.getTagsUndone',
  getTagsUndoChanged: 'videoOptions.tags.live.getTagsUndoChanged',
  categoryMade: 'videoOptions.tags.live.categoryMade',
  categoryAdded: 'videoOptions.tags.live.categoryAdded',
  categoryNothing: 'videoOptions.tags.live.categoryNothing',
  categoryFailed: 'videoOptions.tags.live.categoryFailed',
  categoryRemoved: 'videoOptions.tags.live.categoryRemoved',
  categoryUnassigned: 'videoOptions.tags.live.categoryUnassigned',
});

/** The words for a writer's refusal (video-tag-edits.js `reason`). */
const REASON_KEY = Object.freeze({
  empty: 'videoOptions.tags.live.reason.empty',
  'too-long': 'videoOptions.tags.live.reason.tooLong',
  'bad-store': 'videoOptions.tags.live.reason.badStore',
  'no-path': 'videoOptions.tags.live.reason.noPath',
});

// A post you link (Paste a post link, Find the post) is written to the
// video's record at once, as Change post… does (linkScriptPost: the post,
// no tags yet, `unread: true`), with an exact Undo. Until 2026-11-18
// (fixup-data) a first link was kept in memory only and Find the post ran
// Get tags by itself.

/** For tests: forget the memoised tag index and rules. */
export function _resetTagsSectionForTests() {
  indexMemo = null;
  rulesMemo = null;
}

// ---------------------------------------------------------------------------
// Small helpers
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

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function fileName(p) {
  return String(p || '').split(/[\\/]/).pop();
}

function facetName(facet) {
  return t(`tags.facet.${FACET_KEY[facet] || facet}`);
}

/** A tag as shown: a length gets its unit ("10-25 min"), anything else as the source wrote it. */
function shownLabel(tag) {
  if (tag?.facet === 'length') return t('tags.lengthMinutes', { range: tag.label });
  return String(tag?.label ?? '');
}

function listText(items) {
  try {
    // narrow conjunction: "you, EroScripts" in English, "you、EroScripts" in Chinese.
    return new Intl.ListFormat(getCurrentLocale(), { style: 'narrow', type: 'conjunction' }).format(items);
  } catch {
    return items.join(', ');
  }
}

function sourcesText(sources) {
  return listText((sources || []).map((id) => t(`tags.source.${id}`)));
}

function shortDate(ms) {
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

let rulesMemo = null;
function rulesFor(tagSettings) {
  if (rulesMemo && rulesMemo.settings === tagSettings) return rulesMemo.rules;
  const rules = compileTagRules(isPlainObject(tagSettings) ? tagSettings : {});
  rulesMemo = { settings: tagSettings, rules };
  return rules;
}

// The library's tag index (design (e): one index, memoised per settings
// version and per library list), for the suggestions and Make a category.
// The stored maps are replaced whole on every write, so their identity is
// the version.
let indexMemo = null;
function libraryTagIndex(videos, ds, rules) {
  const user = ds?.get?.(USER_TAGS_KEY);
  const records = ds?.get?.(SCRIPT_TAGS_KEY);
  const hidden = ds?.get?.(HIDDEN_TAGS_KEY);
  const tagSettings = ds?.get?.(TAG_SETTINGS_KEY);
  const m = indexMemo;
  if (m && m.videos === videos && m.user === user && m.records === records && m.hidden === hidden
    && m.tagSettings === tagSettings && m.rules === rules) return m;
  // The same per-video rule as the chip list: a record about another script,
  // or one naming a script on a video left with none, does not count (one
  // without `scriptPath` is about the video's same-name script, RB-2).
  const eroscripts = {};
  if (isPlainObject(records)) {
    for (const v of videos) {
      const p = v?.path;
      if (typeof p !== 'string' || !Object.prototype.hasOwnProperty.call(records, p)) continue;
      const rec = eroscriptsRecordForTags(recordWithScriptPath(records[p], p), v.funscriptPath || null);
      if (rec) eroscripts[p] = rec;
    }
  }
  const index = tagIndex(videos, { user: isPlainObject(user) ? user : {}, eroscripts }, {
    rules,
    hidden: isPlainObject(hidden) ? hidden : {},
    hiddenEverywhere: Array.isArray(tagSettings?.hidden) ? tagSettings.hidden : [],
  });
  const byKey = new Map();
  for (const tags of index.values()) {
    for (const tag of tags) {
      const known = byKey.get(tag.key);
      if (known) known.count += 1;
      else byKey.set(tag.key, { key: tag.key, facet: tag.facet, label: tag.label, count: 1 });
    }
  }
  indexMemo = { videos, user, records, hidden, tagSettings, rules, index, suggestions: [...byKey.values()] };
  return indexMemo;
}

async function defaultIsLoggedIn() {
  try {
    const status = await globalThis.window?.funsync?.eroscriptsStatus?.();
    return status?.loggedIn === true;
  } catch {
    return false;
  }
}

function appPanel() {
  const panel = typeof window !== 'undefined' ? window.app?.eroscriptsPanel : null;
  return panel && typeof panel === 'object' ? panel : null;
}

/**
 * How the section reaches the EroScripts login. The dialog may hand its own
 * (`ctx.eroscripts`); otherwise main's session decides "logged in" (the
 * inline search relies on the same session), and the login and the expiry
 * are the EroScripts panel's own, so the saved session and the panel's
 * state stay in step with every other EroScripts path.
 */
function eroscriptsAccess(ctx) {
  const given = isPlainObject(ctx?.eroscripts) ? ctx.eroscripts : {};
  return {
    isLoggedIn: typeof given.isLoggedIn === 'function' ? given.isLoggedIn : defaultIsLoggedIn,
    login() {
      if (typeof given.login === 'function') return given.login;
      const panel = appPanel();
      if (panel && typeof panel._loginViaWindow === 'function') {
        return async () => {
          await panel._loginViaWindow();
          return panel.isLoggedIn === true;
        };
      }
      return null;
    },
    sessionExpired() {
      if (typeof given.sessionExpired === 'function') return given.sessionExpired;
      const panel = appPanel();
      if (panel && typeof panel.handleSessionExpired === 'function') return () => panel.handleSessionExpired();
      return null;
    },
    checkSession() {
      if (typeof given.checkSession === 'function') return given.checkSession;
      const panel = appPanel();
      if (panel && typeof panel.checkSession === 'function') return (opts) => panel.checkSession(opts);
      return null;
    },
  };
}

/** Did a sessionExpired() answer say the login was kept (the session check found it good, or could not check)? */
function sessionKept(state) {
  return state === 'valid' || state === 'unknown';
}

// ---------------------------------------------------------------------------
// Stacked questions
// ---------------------------------------------------------------------------

/**
 * "Paste a post link…": a stacked dialog with one text box. Only a
 * discuss.eroscripts.com/t/…/<id> link is accepted (topicIdFromLink, the
 * reader funscript metadata uses); nothing is sent. Resolves the topic id,
 * or null on Cancel / Escape.
 */
function promptPostLink() {
  return Modal.open({
    title: t('videoOptions.tags.paste.title'),
    onRender(body, close) {
      const label = el('label', 'video-options-tags__field');
      label.appendChild(el('span', 'video-options-tags__field-label', t('videoOptions.tags.paste.label')));
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'modal-input video-options-tags__paste-input';
      input.setAttribute('autocomplete', 'off');
      input.spellcheck = false;
      label.appendChild(input);
      body.appendChild(label);

      const hint = el('p', 'video-options__note', t('videoOptions.tags.paste.hint'));
      hint.id = nextId('vo-paste-hint');
      const error = el('p', 'video-options__note video-options-tags__error');
      error.id = nextId('vo-paste-error');
      error.setAttribute('aria-live', 'polite');
      error.hidden = true;
      input.setAttribute('aria-describedby', `${hint.id} ${error.id}`);
      body.append(hint, error);

      const row = el('div', 'modal-actions');
      const cancel = button(t('common.cancel'), { className: 'modal-btn modal-btn--secondary' });
      cancel.addEventListener('click', () => close(null));
      const ok = button(t('videoOptions.tags.paste.ok'), { className: 'modal-btn modal-btn--primary' });
      const submit = () => {
        const id = topicIdFromLink(input.value);
        if (id == null) {
          error.textContent = t('videoOptions.tags.paste.invalid');
          error.hidden = false;
          input.setAttribute('aria-invalid', 'true');
          input.focus();
          return;
        }
        close(id);
      };
      ok.addEventListener('click', submit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          submit();
        }
      });
      input.addEventListener('input', () => {
        if (!error.hidden) {
          error.hidden = true;
          input.removeAttribute('aria-invalid');
        }
      });
      row.append(cancel, ok);
      body.appendChild(row);
    },
  });
}

/**
 * "Change post…": what the change does, then how to pick the new post.
 * Resolves 'paste', 'find', or null on Cancel / Escape. Nothing is written
 * or sent here.
 * @param {string} postText the current post as the post line names it (text only)
 */
function promptChangePost(postText) {
  return Modal.open({
    title: t('videoOptions.tags.change.title'),
    initialFocus: (body) => body.querySelector('.video-options-tags__change-find'),
    onRender(body, close) {
      body.appendChild(el('p', 'video-options__note video-options-tags__change-message',
        t('videoOptions.tags.change.message', { post: postText })));
      const row = el('div', 'modal-actions');
      const cancel = button(t('common.cancel'), { className: 'modal-btn modal-btn--secondary' });
      cancel.addEventListener('click', () => close(null));
      const paste = button(t('videoOptions.tags.pasteLink'), { className: 'modal-btn modal-btn--secondary video-options-tags__change-paste' });
      paste.addEventListener('click', () => close('paste'));
      const find = button(t('videoOptions.tags.findPost'), { className: 'modal-btn modal-btn--primary video-options-tags__change-find' });
      find.addEventListener('click', () => close('find'));
      row.append(cancel, paste, find);
      body.appendChild(row);
    },
  });
}

/**
 * "Make a category from this tag…": a stacked dialog asking for the name
 * (prefilled with the tag's label) and saying how many videos have the tag.
 * A name an existing category has turns it into "add the videos to it".
 * Resolves the plan to carry out, or null.
 * @param {string} label
 * @param {(name: string) => object} planFor planMakeCategory for a name
 */
function promptMakeCategory(label, planFor) {
  return Modal.open({
    title: t('videoOptions.tags.category.title'),
    onRender(body, close) {
      const field = el('label', 'video-options-tags__field');
      field.appendChild(el('span', 'video-options-tags__field-label', t('videoOptions.tags.category.nameLabel')));
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'modal-input video-options-tags__category-input';
      input.value = label;
      field.appendChild(input);
      body.appendChild(field);

      const count = el('p', 'video-options__note video-options-tags__category-count');
      const exists = el('p', 'video-options__note video-options-tags__category-exists');
      count.id = nextId('vo-cat-count');
      exists.id = nextId('vo-cat-exists');
      input.setAttribute('aria-describedby', `${count.id} ${exists.id}`);
      body.append(count, exists);

      const row = el('div', 'modal-actions');
      const cancel = button(t('common.cancel'), { className: 'modal-btn modal-btn--secondary' });
      cancel.addEventListener('click', () => close(null));
      const ok = button('', { className: 'modal-btn modal-btn--primary' });
      row.append(cancel, ok);
      body.appendChild(row);

      let plan = null;
      const update = () => {
        plan = planFor(input.value);
        if (!plan?.ok) {
          count.textContent = plan?.reason === 'empty-name' ? t('videoOptions.tags.category.emptyName') : '';
          exists.hidden = true;
          ok.textContent = t('videoOptions.tags.category.create');
          ok.disabled = true;
          return;
        }
        count.textContent = t('videoOptions.tags.category.count', { count: plan.count });
        if (plan.mode === 'existing') {
          exists.textContent = t('videoOptions.tags.category.exists', { name: plan.category.name });
          exists.hidden = false;
          ok.textContent = t('videoOptions.tags.category.addTo', { name: plan.category.name });
        } else {
          exists.hidden = true;
          ok.textContent = t('videoOptions.tags.category.create');
        }
        ok.disabled = plan.count === 0;
      };
      const submit = () => {
        update();
        if (plan?.ok && plan.count > 0) close(plan);
      };
      ok.addEventListener('click', submit);
      input.addEventListener('input', update);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          submit();
        }
      });
      update();
    },
  });
}

// ---------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------

class TagsSection {
  constructor(host, ctx) {
    this.host = host;
    this.ctx = isPlainObject(ctx) ? ctx : {};
    this.video = this.ctx.video || {};
    this.path = typeof this.video.path === 'string' ? this.video.path : '';
    this.ds = this.ctx.dataService || null;
    this.queue = this.ctx.tagQueue || tagFetchQueue();
    this.access = eroscriptsAccess(this.ctx);
    this.disposed = false;
    this.loggedIn = null; // unknown until asked
    this.loginEpoch = 0; // bumped when the session check finds the login dead
    this.needsLogin = false; // a 401 / 403 said the session is dead
    this.scriptMeta = null;
    this.showAll = false;
    this.menu = null; // {el, key, labelBtn}
    this.suggest = { open: false, items: [], active: -1 };
    this.pendingUndo = null; // fallback Undo (no ctx.announceUndo)
    this.cooldownTimer = null;
    this.cleanups = [];
  }

  // ---- reads ----

  get scriptPath() {
    const p = this.video.funscriptPath;
    return typeof p === 'string' && p ? p : null;
  }

  get tagSettings() {
    const s = this.ds?.get?.(TAG_SETTINGS_KEY);
    return isPlainObject(s) ? s : {};
  }

  get rules() {
    const result = this.indexResult();
    // sn-tags (2026-11-19): the library index's own rules, which carry
    // Stash's tag aliases while that opt-in is on, so a chip's key is the
    // index's; without an index, this section's own.
    const rules = result?.rules?.slugAliases instanceof Map ? result.rules : rulesFor(this.ds?.get?.(TAG_SETTINGS_KEY));
    // Stash S1: a bare name (yours, a script's) joins the one Stash identity
    // the library has for it, in the chips and in the writers alike, so
    // removing a joined chip removes your copy too.
    const nameIds = result?.nameIds;
    return nameIds ? withNameIds(rules, nameIds) : rules;
  }

  /** The library's one tag index (ctx.getTagIndex), or null. */
  indexResult() {
    if (typeof this.ctx.getTagIndex !== 'function') return null;
    try {
      const r = this.ctx.getTagIndex();
      return isPlainObject(r) ? r : null;
    } catch {
      return null;
    }
  }

  /** This video's Stash record from the library's index (trust-checked there), or null. */
  stashRecord() {
    const stash = this.indexResult()?.stash;
    if (!isPlainObject(stash) || !Object.prototype.hasOwnProperty.call(stash, this.path)) return null;
    const rec = stash[this.path];
    return isPlainObject(rec) ? rec : null;
  }

  /** The video's Stash view (the dialog's), or null while Stash is off. */
  stashView() {
    if (typeof this.ctx.stash?.view !== 'function') return null;
    try {
      const v = this.ctx.stash.view();
      return isPlainObject(v) ? v : null;
    } catch {
      return null;
    }
  }

  /** The video's EroScripts record as stored (null when none). */
  get record() {
    const rec = getScriptTags(this.ds, this.path);
    return isPlainObject(rec) ? rec : null;
  }

  /**
   * The sources for the merge. The EroScripts record goes through the
   * model's rule (eroscriptsRecordForTags): a record naming another script,
   * or naming one on a video left with none (after Unpair), shows nothing,
   * and comes back with no write when the script does (Undo). A record
   * without `scriptPath` (older builds) shows only while the video uses its
   * same-name script, the file that download saved (effectiveTags, RB-2).
   */
  sources() {
    const user = this.ds?.get?.(USER_TAGS_KEY);
    const out = {
      user: isPlainObject(user) ? user : {},
      eroscripts: { [this.path]: eroscriptsRecordForTags(recordWithScriptPath(this.record, this.path), this.scriptPath) },
    };
    if (this.scriptMeta && this.scriptPath) out.funscript = { [this.scriptPath]: this.scriptMeta };
    // Stash S1: the scene's tags, performers and studio (empty while off).
    const stash = this.stashRecord();
    if (stash) out.stash = { [this.path]: stash };
    return out;
  }

  tags() {
    const hidden = this.ds?.get?.(HIDDEN_TAGS_KEY);
    const list = effectiveTags(this.path, this.sources(), {
      scriptPath: this.scriptPath || undefined,
      hidden: isPlainObject(hidden) ? hidden : {},
      hiddenEverywhere: Array.isArray(this.tagSettings.hidden) ? this.tagSettings.hidden : [],
      rules: this.rules,
    });
    // One display form per tag (r3-fixup): the label the library's index
    // shows for this key (the picker, the chips, the cards), else the same
    // display rule on this video's own label. effectiveTags' objects are new
    // on every call, so this changes nothing stored.
    const shown = this.libraryLabels();
    for (const tag of list) tag.label = shown?.get(tag.key)?.label ?? tagDisplayLabel(tag);
    return list;
  }

  /** The library index's one label per key (ctx.getTagIndex counts), or null. */
  libraryLabels() {
    if (typeof this.ctx.getTagIndex !== 'function') return null;
    try {
      const counts = this.ctx.getTagIndex()?.counts;
      return counts instanceof Map ? counts : null;
    } catch {
      return null;
    }
  }

  /** The two maps the writers plan against, as stored (absent, damaged and all). */
  editState() {
    return { userTags: this.ds?.get?.(USER_TAGS_KEY), hiddenTags: this.ds?.get?.(HIDDEN_TAGS_KEY) };
  }

  editCtx() {
    return { sources: this.sources(), scriptPath: this.scriptPath || undefined, rules: this.rules };
  }

  resolution() {
    return resolveTopic({
      record: this.record,
      scriptPath: this.scriptPath,
      scriptMeta: this.scriptMeta,
      videoPath: this.path,
    });
  }

  // ---- mount / dispose ----

  mount() {
    const root = el('div', 'video-options-tags');
    this.root = root;

    // Tags on this video
    this.listBlock = el('section', 'video-options__block video-options-tags__list');
    this.listTitle = el('h3', 'video-options__block-title');
    this.listTitle.id = nextId('vo-tags-h');
    this.listBlock.setAttribute('aria-labelledby', this.listTitle.id);
    this.findRow = el('div', 'video-options-tags__find');
    this.findInput = document.createElement('input');
    this.findInput.type = 'search';
    this.findInput.className = 'modal-input video-options-tags__find-input';
    this.findInput.placeholder = t('videoOptions.tags.filter.placeholder');
    this.findInput.setAttribute('aria-label', t('videoOptions.tags.filter.label'));
    this.findInput.dataset.voFocus = 'tags:find';
    this.findInput.addEventListener('input', () => this.renderChips());
    this.findRow.appendChild(this.findInput);
    this.chipsHost = el('div', 'video-options-tags__facets');
    this.listBlock.append(this.listTitle, this.findRow, this.chipsHost, this.buildAddRow());

    // Where they came from
    this.sourcesBlock = el('section', 'video-options__block video-options-tags__sources');
    const sourcesTitle = el('h3', 'video-options__block-title', t('videoOptions.tags.sourcesHeading'));
    sourcesTitle.id = nextId('vo-tags-src');
    this.sourcesBlock.setAttribute('aria-labelledby', sourcesTitle.id);
    this.sourcesHost = el('div', 'video-options-tags__source-rows');
    this.sourcesBlock.append(sourcesTitle, this.sourcesHost);

    // Hidden on this video
    this.hiddenBlock = el('section', 'video-options__block video-options-tags__hidden');
    this.hiddenTitle = el('h3', 'video-options__block-title');
    this.hiddenTitle.id = nextId('vo-tags-hid');
    this.hiddenBlock.setAttribute('aria-labelledby', this.hiddenTitle.id);
    this.hiddenHost = el('ul', 'video-options-tags__hidden-list');
    this.hiddenBlock.append(this.hiddenTitle, this.hiddenHost);

    // The fallback Undo, only when the host gives no ctx.announceUndo: in
    // the dialog it was a second, always hidden .video-options__undo button
    // (verify-2), never used there.
    this.undoRow = null;
    this.undoBtn = null;
    if (typeof this.ctx.announceUndo !== 'function') {
      this.undoRow = el('div', 'video-options-tags__undo-row');
      this.undoRow.hidden = true;
      this.undoBtn = button(t('toast.undo'), { className: 'video-options__undo video-options-tags__undo', focusKey: 'tags:undo' });
      this.undoBtn.addEventListener('click', () => this.runFallbackUndo());
      this.undoRow.appendChild(this.undoBtn);
    }

    root.append(...[this.listBlock, this.sourcesBlock, this.hiddenBlock, this.undoRow].filter(Boolean));
    this.host.appendChild(root);

    // Every Get tags button redraws on the queue's changes (busy, cooldown).
    const off = this.queue.onChange(() => {
      if (!this.disposed) this.renderSources();
    });
    this.cleanups.push(off);

    this.render();
    this.loadScriptMeta();
    this.checkSessionOnOpen();
  }

  /**
   * Is the saved EroScripts login still good? (Dave, 2026-11-18.) Asked as
   * the section opens, when the video has a script (else there is nothing
   * EroScripts here). The panel's checkSession: a kept answer, so opening
   * again sends nothing; logged out, nothing is asked. A timed-out login is
   * dropped there (the top bar stops saying connected) and the button reads
   * "Log in to get tags…". Could not check: nothing changes.
   */
  checkSessionOnOpen() {
    const check = this.access.checkSession();
    if (!check || !this.scriptPath) return;
    Promise.resolve()
      .then(() => check())
      .then((state) => {
        if (this.disposed || state !== 'expired') return;
        this.loginEpoch += 1;
        this.loggedIn = false;
        this.renderSources();
      }, () => { /* could not check: changes nothing */ });
  }

  dispose() {
    if (this.disposed) return;
    this.closeMenu({ focus: false });
    this.closeSuggestions();
    this.disposed = true;
    for (const fn of this.cleanups.splice(0)) {
      try { fn(); } catch { /* one cleanup must not stop the others */ }
    }
    if (this.cooldownTimer) {
      clearInterval(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    this.root?.remove();
    // An Undo of ours still pending goes on in a toast (the dialog's rule).
    const undo = this.pendingUndo;
    this.pendingUndo = null;
    if (undo && !undo.done) this.offerUndoToast(undo);
  }

  handleEscape() {
    if (this.menu) {
      this.closeMenu({ focus: true });
      return true;
    }
    if (this.suggest.open) {
      this.closeSuggestions();
      return true;
    }
    return false;
  }

  /** The script file's own metadata, read once (a local read; Round 3 supplies it). */
  loadScriptMeta() {
    const read = this.ctx.getScriptMeta;
    const scriptPath = this.scriptPath;
    if (typeof read !== 'function' || !scriptPath) return;
    let answer;
    try { answer = read(scriptPath); } catch { return; }
    Promise.resolve(answer).then((meta) => {
      if (this.disposed || !isPlainObject(meta)) return;
      this.scriptMeta = meta;
      this.render();
    }, () => { /* unknown: nothing shown */ });
  }

  // ---- rendering ----

  render() {
    if (this.disposed) return;
    this.renderChips();
    this.renderSources();
    this.renderHidden();
    this.renderUndo();
  }

  /** Rebuild one part, keeping the focus on the same control (by its focus key). */
  rebuild(part, build) {
    const active = document.activeElement;
    const key = active && part.contains(active) ? active.dataset?.voFocus : null;
    part.replaceChildren();
    build();
    // The control that had the focus is gone: the first one left in this
    // part, else the add box, never the page behind the dialog.
    if (key && !this.focusKey(key)) {
      const first = part.querySelector('button:not([disabled]), input:not([disabled])');
      (first || this.addInput)?.focus();
    }
  }

  focusKey(key) {
    if (!key || !this.root) return false;
    for (const node of this.root.querySelectorAll('[data-vo-focus]')) {
      if (node.dataset.voFocus === key && !node.disabled && !node.closest('[hidden]')) {
        try { node.focus({ preventScroll: false }); } catch { return false; }
        return document.activeElement === node;
      }
    }
    return false;
  }

  renderChips() {
    if (this.disposed) return;
    this.closeMenu({ focus: false });
    const all = this.tags();
    this.listTitle.textContent = t('videoOptions.tags.heading', { count: all.length });
    this.findRow.hidden = all.length <= CHIP_LIMIT;
    const query = this.findRow.hidden ? '' : foldForMatch(this.findInput.value);

    this.rebuild(this.chipsHost, () => {
      if (all.length === 0) {
        this.chipsHost.appendChild(el('p', 'video-options__note video-options-tags__empty', t('videoOptions.tags.empty')));
        return;
      }
      const matching = query
        ? all.filter((tag) => foldForMatch(shownLabel(tag)).includes(query) || tag.key.includes(query))
        : all;
      if (matching.length === 0) {
        this.chipsHost.appendChild(el('p', 'video-options__note', t('videoOptions.tags.noMatch', { query: this.findInput.value.trim() })));
        return;
      }
      const shown = this.showAll || matching.length <= CHIP_LIMIT ? matching : matching.slice(0, CHIP_LIMIT);

      for (const facet of FACETS) {
        const inFacet = shown.filter((tag) => tag.facet === facet);
        if (inFacet.length === 0) continue;
        const group = el('div', 'video-options-tags__facet');
        group.dataset.facet = facet;
        const name = el('span', 'video-options-tags__facet-name', facetName(facet));
        name.id = nextId('vo-facet');
        const list = el('ul', 'video-options-tags__chips');
        list.setAttribute('aria-labelledby', name.id);
        const labelCount = new Map();
        for (const tag of inFacet) {
          const k = foldForMatch(shownLabel(tag));
          labelCount.set(k, (labelCount.get(k) || 0) + 1);
        }
        for (const tag of inFacet) list.appendChild(this.chip(tag, labelCount.get(foldForMatch(shownLabel(tag))) > 1));
        group.append(name, list);
        this.chipsHost.appendChild(group);
      }

      if (matching.length > CHIP_LIMIT) {
        const more = button(this.showAll
          ? t('videoOptions.tags.showFewer')
          : t('videoOptions.tags.showAll', { count: matching.length }), {
          className: 'video-options__link-btn video-options-tags__show-all',
          focusKey: 'tags:showAll',
          onClick: () => {
            this.showAll = !this.showAll;
            this.renderChips();
            this.focusKey('tags:showAll');
          },
        });
        this.chipsHost.appendChild(more);
      }
    });
  }

  /** One chip: its label (opens the chip menu), its sources, its ×. */
  chip(tag, sameLabel) {
    const li = el('li', 'video-options-tags__chip');
    li.dataset.tagKey = tag.key;
    let text = shownLabel(tag);
    if (sameLabel) {
      // Two chips with the same label (two performers of one name, P4) each
      // show a short tail of their id.
      const ref = (tag.refs || []).find((r) => r.id != null);
      const tail = ref ? String(ref.id) : (tag.key.split('#')[1] || tag.key);
      text = `${text} #${tail.slice(-4)}`;
    }
    const label = button(text, {
      className: 'video-options-tags__chip-label',
      focusKey: `tags:chip:${tag.key}`,
      onClick: (e) => this.openMenu(tag, e.currentTarget),
    });
    label.setAttribute('aria-haspopup', 'menu');
    label.setAttribute('aria-expanded', 'false');
    const sources = el('span', 'video-options-tags__chip-sources', sourcesText(tag.sources));
    sources.id = nextId('vo-chip-src');
    label.setAttribute('aria-describedby', sources.id);
    const remove = button('×', {
      className: 'video-options-tags__chip-remove',
      focusKey: `tags:remove:${tag.key}`,
      onClick: () => this.removeTag(tag),
    });
    const removeAria = t('videoOptions.tags.removeAria', { name: shownLabel(tag) });
    remove.setAttribute('aria-label', removeAria);
    remove.title = removeAria;
    li.append(label, sources, remove);
    return li;
  }

  buildAddRow() {
    const row = el('div', 'video-options-tags__add');
    const listId = nextId('vo-tag-suggest');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'modal-input video-options-tags__add-input';
    input.placeholder = t('videoOptions.tags.add.placeholder');
    input.setAttribute('aria-label', t('videoOptions.tags.add.label'));
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', listId);
    input.setAttribute('autocomplete', 'off');
    input.maxLength = MAX_TAG_TEXT * 2; // the writer refuses past MAX_TAG_TEXT and says so
    input.dataset.voFocus = 'tags:add';
    const hint = el('p', 'video-options__note video-options-tags__add-hint', t('videoOptions.tags.add.hint'));
    hint.id = nextId('vo-tag-hint');
    input.setAttribute('aria-describedby', hint.id);

    const add = button(t('videoOptions.tags.add.button'), { focusKey: 'tags:addButton' });
    add.addEventListener('click', () => this.addTag(input.value));

    const list = el('ul', 'video-options-tags__suggestions');
    list.id = listId;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', t('videoOptions.tags.add.suggestionsAria'));
    list.hidden = true;

    input.addEventListener('input', () => this.updateSuggestions());
    input.addEventListener('keydown', (e) => this.onAddKeydown(e));
    input.addEventListener('blur', () => this.closeSuggestions());

    this.addInput = input;
    this.suggestList = list;
    const line = el('div', 'video-options-tags__add-line');
    line.append(input, add);
    row.append(line, list, hint);
    return row;
  }

  renderSources() {
    if (this.disposed) return;
    const res = this.resolution();
    const pending = this.queue.isPending(this.path);
    this.root.setAttribute('aria-busy', pending ? 'true' : 'false');
    const cooldown = this.queue.cooldownSeconds();
    this.tickCooldown(cooldown > 0);

    this.rebuild(this.sourcesHost, () => {
      const row = el('div', 'video-options-tags__source video-options-tags__source--eroscripts');
      row.appendChild(el('span', 'video-options-tags__source-name', t('tags.source.eroscripts')));
      const body = el('div', 'video-options-tags__source-body');

      if (res.state === 'known') {
        body.appendChild(this.postLine(res));
        if (this.loggedIn === null) this.checkLogin();
        // Logged out (asked, not assumed: unknown reads as logged in) the
        // button reads "Log in to get tags…" and logs in first.
        const state = buttonState({
          resolution: res, loggedIn: this.loggedIn !== false, pending, cooldownSeconds: cooldown,
        });
        const labelKey = state.labelKey;
        // aria-disabled, not disabled: the button keeps the focus while its
        // request runs or the cooldown counts down (a disabled button drops
        // it to the page, where Space would reach the player).
        const get = button('', {
          focusKey: 'tags:get',
          onClick: () => {
            if (get.getAttribute('aria-disabled') !== 'true') this.getTags();
          },
        });
        get.classList.add('video-options-tags__get');
        get.setAttribute('aria-disabled', state.disabled ? 'true' : 'false');
        get.classList.toggle('video-options-tags__get--disabled', state.disabled);
        if (state.busy) {
          const spin = el('span', 'video-options-tags__spinner');
          spin.setAttribute('aria-hidden', 'true');
          get.appendChild(spin);
        }
        get.appendChild(document.createTextNode(t(labelKey, state.params)));
        get.dataset.state = state.busy ? 'busy' : (cooldown > 0 ? 'cooldown' : (labelKey === FETCH_KEYS.loginButton ? 'login' : 'ready'));
        const buttons = [get];
        // After a refused session, one login button: the Get tags button
        // already reads "Log in to get tags…" while logged out (verify-1).
        if (this.needsLogin && !pending && labelKey !== FETCH_KEYS.loginButton) {
          buttons.push(button(t(FETCH_KEYS.loginAction), { focusKey: 'tags:login', onClick: () => this.loginAndGet() }));
        }
        buttons.push(button(t('videoOptions.tags.viewPost'), { focusKey: 'tags:view', onClick: () => this.viewPost(res) }));
        buttons.push(this.whilePending(
          button(t('videoOptions.tags.changePost'), { focusKey: 'tags:changePost', onClick: () => this.changePost(res) }),
          pending,
        ));
        body.appendChild(actions(buttons));
      } else if (res.state === 'otherScript') {
        body.appendChild(el('p', 'video-options__note video-options-tags__other-script',
          t(FETCH_KEYS.otherScript, { name: res.scriptName })));
        body.appendChild(actions(this.linkButtons(pending)));
      } else if (res.state === 'noScript') {
        body.appendChild(el('p', 'video-options__note', t(FETCH_KEYS.noScript)));
      } else {
        // The script's own link (or the saved record) is its creator's index
        // / hub post (Dave, 2026-11-19): passed over, and the note says why.
        const noteKey = res.hub ? FETCH_KEYS.hubNote : FETCH_KEYS.noPost;
        body.appendChild(el('p', `video-options__note${res.hub ? ' video-options-tags__hub-note' : ''}`, t(noteKey)));
        body.appendChild(actions(this.linkButtons(pending)));
      }
      row.appendChild(body);
      this.sourcesHost.appendChild(row);

      // The script file (shown once its metadata is read; Round 3)
      if (this.scriptMeta && this.scriptPath) {
        const fileRow = el('div', 'video-options-tags__source video-options-tags__source--file');
        fileRow.appendChild(el('span', 'video-options-tags__source-name', t('videoOptions.tags.source.fileRow')));
        const count = this.tags().filter((tag) => tag.sources.includes('funscript')).length;
        fileRow.appendChild(el('span', 'video-options-tags__source-body',
          `${fileName(this.scriptPath)} · ${t('videoOptions.tags.source.tagCount', { count })}`));
        this.sourcesHost.appendChild(fileRow);
      }

      const stashRow = this.stashRow();
      if (stashRow) this.sourcesHost.appendChild(stashRow);
    });
  }

  /**
   * Stash S1: the Stash row, while the video has a Stash link: “Scene” ·
   * 2 tags, 2 performers, 1 studio · synced 18 Nov [Open in Stash]. A
   * scene gone from Stash says so (its tags still count); a file that
   * changed says its Stash tags are hidden until the next sync. Text only.
   * Drawn from the link itself, whatever else the view's state says: a
   * link a sync kept while it opened a check (two scenes now have this
   * file) still gives the chips their Stash tags (s1-review-a RA-S1-4).
   */
  stashRow() {
    const view = this.stashView();
    const link = view?.link;
    if (!link) return null;
    let state;
    if (view.hidden) state = 'changed';
    else state = link.state === 'gone' ? 'gone' : 'linked';
    const row = el('div', 'video-options-tags__source video-options-tags__source--stash');
    row.appendChild(el('span', 'video-options-tags__source-name', t('tags.source.stash')));
    const body = el('div', 'video-options-tags__source-body');
    const scene = view.scene;
    const name = scene?.title
      ? t('videoOptions.stash.sceneTitle', { title: scene.title })
      : t('videoOptions.stash.untitled', { id: String(link.sceneId ?? '?').split('@')[0] || '?' });
    const bits = [name];
    if (state === 'changed') {
      // The Stash scene with this id no longer has this file (a Stash reset or
      // rescan reused the id), or this file changed: said as File > Stash says
      // it (s1-fixup-renderer, 2026-11-19; fixed 2026-11-22).
      bits.push(t(link.sceneChanged ? 'videoOptions.tags.source.stashSceneChanged' : 'videoOptions.tags.source.stashHidden'));
    } else {
      const c = view.counts || {};
      bits.push(t('videoOptions.tags.source.stashRow', {
        tags: c.tags || 0, performers: c.performers || 0, studios: c.studio || 0,
      }));
      const when = Number.isFinite(scene?.fetchedAt) ? scene.fetchedAt : Date.parse(scene?.fetchedAt ?? '');
      if (Number.isFinite(when)) bits.push(t('videoOptions.stash.synced', { date: shortDate(when) }));
      if (state === 'gone') bits.push(t('videoOptions.tags.source.stashGone'));
    }
    body.appendChild(el('p', 'video-options-tags__post video-options-tags__stash-line', bits.join(' · ')));
    if (state === 'linked' && !view.sceneFromOtherServer && typeof this.ctx.stash?.openScene === 'function' && link.sceneId != null) {
      const open = button(t('videoOptions.stash.open'), {
        focusKey: 'tags:stashOpen',
        onClick: () => this.ctx.stash.openScene(link.sceneId),
      });
      open.setAttribute('aria-label', t('videoOptions.stash.openAria'));
      body.appendChild(actions([open]));
    }
    row.appendChild(body);
    return row;
  }

  /** The post line: "Post title" by creator · got 17 Nov (text only). */
  postLine(res) {
    const line = el('p', 'video-options-tags__post');
    const rec = res.from === 'record' ? this.record : null;
    const meta = res.from === 'metadata' ? this.scriptMeta : null;
    const title = rec?.title || meta?.title || null;
    const creator = rec?.creator || meta?.creator || null;
    let text;
    if (title && creator) text = t('videoOptions.tags.source.post', { title, creator });
    else if (title) text = t('videoOptions.tags.source.postNoCreator', { title });
    else text = t('videoOptions.tags.source.postId', { id: res.topicId });
    const bits = [text];
    const when = rec ? (Number.isFinite(rec.fetchedAt) ? rec.fetchedAt : rec.savedAt) : null;
    // A post linked by Change post… whose tags Get tags has not read yet.
    if (rec?.unread === true) bits.push(t('videoOptions.tags.source.notRead'));
    else if (Number.isFinite(when)) bits.push(t('videoOptions.tags.source.got', { date: shortDate(when) }));
    if (rec?.stale === true) bits.push(t('videoOptions.tags.source.stale'));
    line.textContent = bits.join(' · ');
    return line;
  }

  linkButtons(pending = false) {
    return [
      button(t('videoOptions.tags.pasteLink'), { focusKey: 'tags:paste', onClick: () => this.pasteLink() }),
      button(t('videoOptions.tags.findPost'), { focusKey: 'tags:findPost', onClick: () => this.findPost() }),
    ].map((b) => this.whilePending(b, pending));
  }

  /**
   * A button that changes the video's post (Change post…, Paste a post
   * link…, Find the post…) is disabled while this video's Get tags request
   * is queued or running (review-b RB-1): its answer is about the post the
   * press resolved. It comes back when the request ends (the queue's change
   * redraws the section).
   */
  whilePending(btn, pending) {
    if (pending) btn.disabled = true;
    return btn;
  }

  tickCooldown(on) {
    if (on && !this.cooldownTimer) {
      // The label counts down; the queue says when the cooldown is over.
      this.cooldownTimer = setInterval(() => {
        if (this.disposed) return;
        if (this.queue.cooldownSeconds() <= 0) {
          clearInterval(this.cooldownTimer);
          this.cooldownTimer = null;
        }
        this.renderSources();
      }, 1000);
    } else if (!on && this.cooldownTimer) {
      clearInterval(this.cooldownTimer);
      this.cooldownTimer = null;
    }
  }

  /**
   * "Hidden on this video", each row labelled as the chips, the filter and
   * the cards label its key (the library index's one label, which tells two
   * people of one name apart), else as hiddenOnVideo words it: a name, never
   * a raw identity key (s1-review-a RA-S1-5). Rows that would still read the
   * same keep hiddenOnVideo's words, which tell them apart.
   */
  hiddenItems() {
    const items = hiddenOnVideo(this.ds?.get?.(HIDDEN_TAGS_KEY), this.path, {
      sources: this.sources(), scriptPath: this.scriptPath || undefined, rules: this.rules,
    });
    const shown = this.libraryLabels();
    const picked = items.map((item) => ({ ...item, label: shown?.get(item.key)?.label ?? item.label }));
    const seen = new Map();
    for (const item of picked) {
      const mark = `${item.facet}\u0000${foldForMatch(item.label)}`;
      seen.set(mark, (seen.get(mark) || 0) + 1);
    }
    return picked.map((item, i) => (seen.get(`${item.facet}\u0000${foldForMatch(item.label)}`) > 1 ? items[i] : item));
  }

  renderHidden() {
    if (this.disposed) return;
    const items = this.hiddenItems();
    this.hiddenBlock.hidden = items.length === 0;
    this.hiddenTitle.textContent = t('videoOptions.tags.hiddenHeading', { count: items.length });
    this.rebuild(this.hiddenHost, () => {
      for (const item of items) {
        const li = el('li', 'video-options-tags__hidden-item');
        li.dataset.tagKey = item.key;
        li.appendChild(el('span', 'video-options-tags__hidden-label', shownLabel(item)));
        const again = button(t('videoOptions.tags.showAgain'), {
          className: 'video-options__link-btn video-options-tags__show-again',
          focusKey: `tags:showAgain:${item.key}`,
          onClick: () => this.showAgain(item),
        });
        again.setAttribute('aria-label', t('videoOptions.tags.showAgainAria', { name: shownLabel(item) }));
        li.appendChild(again);
        this.hiddenHost.appendChild(li);
      }
    });
  }

  renderUndo() {
    if (this.disposed || !this.undoRow) return;
    const undo = this.pendingUndo;
    this.undoRow.hidden = !undo || undo.done;
    if (undo && !undo.done) this.undoBtn.setAttribute('aria-label', t('videoOptions.tags.undoAria', { message: undo.message }));
  }

  // ---- saying things ----

  /** The dialog's live line; a toast once the dialog has gone (a request that ended after it closed). */
  say(message) {
    if (!message) return;
    const gone = this.ctx.modalBody && typeof this.ctx.modalBody === 'object' && this.ctx.modalBody.isConnected === false;
    if (!gone && typeof this.ctx.announce === 'function') {
      try { this.ctx.announce(message); return; } catch { /* fall back to a toast */ }
    }
    showToast(message, 'info', 5000);
  }

  changed(what = 'tags') {
    if (!this.disposed) this.render();
    try { this.ctx.onDataChanged?.(what); } catch (err) { console.warn('[VideoOptions/Tags] onDataChanged threw', err); }
  }

  /**
   * A removal: say it with an Undo (the dialog's, else our own), focus on
   * the Undo. `{ focus: false }` keeps the focus where it is: the control
   * that acted is still there (Get tags).
   */
  offerUndo(message, undo, { focus = true } = {}) {
    const entry = { ...undo, message, done: false };
    if (typeof this.ctx.announceUndo === 'function') {
      this.pendingUndo = null;
      this.renderUndo();
      try {
        this.ctx.announceUndo(message, entry, { focus });
      } catch (err) {
        console.warn('[VideoOptions/Tags] announceUndo threw', err);
      }
      // The dialog moves the focus to its Undo; never leave it on a removed chip.
      if (focus && !this.root.contains(document.activeElement) && !(this.ctx.modalBody?.contains?.(document.activeElement))) {
        this.focusKey('tags:add');
      }
      return;
    }
    // A covered Undo waits and comes back once this one is used (as the
    // dialog's line does).
    if (this.pendingUndo && !this.pendingUndo.done) (this.undoStack ||= []).push(this.pendingUndo);
    this.pendingUndo = entry;
    this.say(message);
    this.renderUndo();
    if (focus) this.undoBtn?.focus();
  }

  runFallbackUndo() {
    const undo = this.pendingUndo;
    if (!undo || undo.done) return;
    undo.done = true;
    this.pendingUndo = null;
    let result = {};
    try { result = undo.run() || {}; } catch (err) {
      console.warn('[VideoOptions/Tags] undo failed', err);
    }
    while (!this.pendingUndo && this.undoStack?.length) {
      const prev = this.undoStack.pop();
      if (prev && !prev.done) this.pendingUndo = prev;
    }
    this.renderUndo();
    this.say(result.message || t(LIVE.undone));
    if (!(undo.focusKey && this.focusKey(undo.focusKey))) this.focusKey('tags:add');
  }

  offerUndoToast(undo) {
    const body = el('div', 'update-toast');
    body.appendChild(el('span', null, undo.message || ''));
    const b = button(t('toast.undo'), { className: 'update-toast__btn video-options__toast-undo' });
    b.addEventListener('click', () => {
      if (undo.done) return;
      undo.done = true;
      let result = {};
      try { result = undo.run() || {}; } catch (err) { console.warn('[VideoOptions/Tags] undo failed', err); }
      if (result.message) showToast(result.message, 'info', 2500);
    });
    body.appendChild(b);
    showToast(body, 'info', UNDO_TOAST_MS);
  }

  // ---- edits ----

  reasonText(reason) {
    return t(REASON_KEY[reason] || REASON_KEY.empty, { max: MAX_TAG_TEXT });
  }

  labelOf(key, fallback) {
    const tag = this.tags().find((x) => x.key === key);
    return tag ? shownLabel(tag) : String(fallback ?? '');
  }

  addTag(text) {
    this.closeSuggestions();
    const plan = planAddTag(this.editState(), this.path, text, { rules: this.rules });
    if (!plan.ok) {
      this.say(this.reasonText(plan.reason));
      this.addInput.focus();
      return plan;
    }
    if (!plan.changed) {
      this.say(t(LIVE.already, { name: this.labelOf(plan.key, plan.text) }));
      this.addInput.value = '';
      this.addInput.focus();
      return plan;
    }
    applyWrites(this.ds, plan);
    const unhid = plan.writes.some((w) => w.key === HIDDEN_TAGS_KEY);
    this.addInput.value = '';
    this.changed('tags');
    const name = this.labelOf(plan.key, plan.text);
    this.say(t(unhid ? LIVE.addedShown : LIVE.added, { name }));
    this.addInput.focus();
    return plan;
  }

  removeTag(tag) {
    const plan = planRemoveTag(this.editState(), this.path, tag.key, this.editCtx());
    if (!plan.ok) {
      this.say(this.reasonText(plan.reason));
      return plan;
    }
    if (!plan.changed) return plan;
    applyWrites(this.ds, plan);
    this.changed('tags');
    const name = shownLabel(tag);
    this.offerUndo(t(LIVE.removed, { name }), {
      focusKey: `tags:remove:${tag.key}`,
      run: () => this.undoEdit(plan.undo),
    });
    return plan;
  }

  /** Undo of an add / remove / show again: both lists of this video back (planUndo). */
  undoEdit(undo) {
    const back = planUndo(this.editState(), undo);
    if (back.ok) applyWrites(this.ds, back);
    this.changed('tags');
    return { message: t(back.exact ? LIVE.undone : LIVE.undoPartial) };
  }

  showAgain(item) {
    // The sources too: the row may stand for two stored keys (RA-S1-2).
    const plan = planShowAgain(this.editState(), this.path, item.key, this.editCtx());
    if (!plan.ok) {
      this.say(this.reasonText(plan.reason));
      return plan;
    }
    if (plan.changed) {
      applyWrites(this.ds, plan);
      this.changed('tags');
    }
    this.say(t(LIVE.shownAgain, { name: shownLabel(item) }));
    if (!this.focusKey(`tags:chip:${item.key}`)) this.focusKey('tags:add');
    return plan;
  }

  // ---- the chip menu ----

  openMenu(tag, labelBtn) {
    const wasOpen = this.menu?.key === tag.key;
    this.closeMenu({ focus: false });
    if (wasOpen) {
      labelBtn.focus();
      return;
    }
    const menu = el('ul', 'video-options-tags__menu');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', t('videoOptions.tags.menu.aria', { name: shownLabel(tag) }));
    const items = [];
    const item = (text, run) => {
      const li = el('li');
      li.setAttribute('role', 'none');
      const b = el('button', 'video-options-tags__menu-item', text);
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.tabIndex = -1;
      b.addEventListener('click', () => {
        // Back on the chip first: a question stacked by the item (Make a
        // category) gives the focus back there, never to the page.
        this.closeMenu({ focus: true });
        run();
      });
      li.appendChild(b);
      menu.appendChild(li);
      items.push(b);
    };
    if (typeof this.ctx.showVideosWithTag === 'function') {
      item(t('videoOptions.tags.menu.showVideos'), () => this.ctx.showVideosWithTag(tag.key, tag));
    }
    item(t('videoOptions.tags.menu.makeCategory'), () => this.makeCategory(tag));
    item(t('videoOptions.tags.menu.remove'), () => this.removeTag(tag));

    menu.addEventListener('keydown', (e) => {
      const at = items.indexOf(document.activeElement);
      let next = -1;
      if (e.key === 'ArrowDown') next = (at + 1) % items.length;
      else if (e.key === 'ArrowUp') next = (at - 1 + items.length) % items.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = items.length - 1;
      else if (e.key === 'Tab') {
        this.closeMenu({ focus: false });
        return;
      }
      if (next >= 0) {
        e.preventDefault();
        items[next].focus();
      }
    });
    menu.addEventListener('focusout', (e) => {
      if (this.menu?.el === menu && !menu.contains(e.relatedTarget) && e.relatedTarget !== labelBtn) {
        this.closeMenu({ focus: false });
      }
    });
    const onDown = (e) => {
      if (this.menu?.el === menu && !menu.contains(e.target) && e.target !== labelBtn) this.closeMenu({ focus: false });
    };
    document.addEventListener('mousedown', onDown, true);

    labelBtn.setAttribute('aria-expanded', 'true');
    labelBtn.closest('li')?.appendChild(menu);
    this.menu = { el: menu, key: tag.key, labelBtn, off: () => document.removeEventListener('mousedown', onDown, true) };
    items[0]?.focus();
  }

  closeMenu({ focus = false } = {}) {
    const menu = this.menu;
    if (!menu) return;
    this.menu = null;
    menu.off();
    menu.el.remove();
    menu.labelBtn.setAttribute('aria-expanded', 'false');
    if (focus && menu.labelBtn.isConnected) menu.labelBtn.focus();
  }

  // ---- suggestions ----

  /** The library's one tag index (ctx.getTagIndex, Round 3), else this section's own. */
  libraryIndex(videos) {
    if (typeof this.ctx.getTagIndex === 'function') {
      try {
        const given = this.ctx.getTagIndex();
        if (given && given.index instanceof Map && Array.isArray(given.suggestions)) return given;
      } catch { /* the section's own below */ }
    }
    return libraryTagIndex(videos, this.ds, this.rules);
  }

  suggestionsFor(query) {
    const q = foldForMatch(query);
    if (!q) return [];
    const videos = typeof this.ctx.getLibraryVideos === 'function' ? (this.ctx.getLibraryVideos() || []) : [];
    const memo = this.libraryIndex(Array.isArray(videos) ? videos : []);
    const own = new Set(this.tags().map((tag) => tag.key));
    const hits = [];
    for (const s of memo.suggestions) {
      // A performer, creator or studio is only yours to type (design (c)).
      if (own.has(s.key) || NAME_FACET_SET.has(s.facet)) continue;
      const label = foldForMatch(shownLabel(s));
      const at = label.indexOf(q);
      if (at < 0) continue;
      hits.push({ ...s, rank: at === 0 ? 0 : 1 });
    }
    hits.sort((a, b) => a.rank - b.rank || b.count - a.count || a.label.localeCompare(b.label));
    return hits.slice(0, SUGGESTION_LIMIT);
  }

  updateSuggestions() {
    if (this.disposed) return;
    const items = this.suggestionsFor(this.addInput.value);
    this.suggest = { open: items.length > 0, items, active: -1 };
    const list = this.suggestList;
    list.replaceChildren();
    items.forEach((s, i) => {
      const li = el('li', 'video-options-tags__suggestion');
      li.id = `${list.id}-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      li.dataset.tagKey = s.key;
      li.appendChild(el('span', 'video-options-tags__suggestion-label', shownLabel(s)));
      li.appendChild(el('span', 'video-options-tags__suggestion-facet', facetName(s.facet)));
      // mousedown, not click: the box keeps the focus (its blur closes the list).
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.addTag(this.suggestionText(s));
      });
      list.appendChild(li);
    });
    list.hidden = !this.suggest.open;
    this.addInput.setAttribute('aria-expanded', this.suggest.open ? 'true' : 'false');
    this.addInput.removeAttribute('aria-activedescendant');
  }

  /** What to add for a suggestion: its label, with its facet when the label alone would land elsewhere. */
  suggestionText(s) {
    return classifyTag(s.label, this.rules)?.key === s.key ? s.label : `${s.facet}:${s.label}`;
  }

  closeSuggestions() {
    if (!this.suggestList) return;
    this.suggest = { open: false, items: [], active: -1 };
    this.suggestList.hidden = true;
    this.suggestList.replaceChildren();
    this.addInput.setAttribute('aria-expanded', 'false');
    this.addInput.removeAttribute('aria-activedescendant');
  }

  setActiveSuggestion(index) {
    const nodes = [...this.suggestList.children];
    this.suggest.active = index;
    nodes.forEach((n, i) => {
      n.setAttribute('aria-selected', i === index ? 'true' : 'false');
      n.classList.toggle('video-options-tags__suggestion--active', i === index);
    });
    if (index >= 0 && nodes[index]) this.addInput.setAttribute('aria-activedescendant', nodes[index].id);
    else this.addInput.removeAttribute('aria-activedescendant');
  }

  onAddKeydown(e) {
    const { open, items, active } = this.suggest;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        this.updateSuggestions();
        return;
      }
      const n = items.length;
      const next = e.key === 'ArrowDown' ? (active + 1) % n : (active <= 0 ? n - 1 : active - 1);
      this.setActiveSuggestion(next);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (open && active >= 0 && items[active]) this.addTag(this.suggestionText(items[active]));
      else this.addTag(this.addInput.value);
    }
  }

  // ---- EroScripts ----

  checkLogin() {
    if (this.loginCheck) return;
    const epoch = this.loginEpoch;
    this.loginCheck = Promise.resolve()
      .then(() => this.access.isLoggedIn())
      .then((v) => v === true, () => false)
      .then((v) => {
        this.loginCheck = null;
        // The session check answered meanwhile (a dead login): it decides.
        if (epoch !== this.loginEpoch) return;
        this.loggedIn = v;
        if (!this.disposed) this.renderSources();
      });
  }

  /** Get tags from EroScripts: one press, one request (eroscripts-tag-fetch.js). */
  async getTags() {
    if (!this.path) return null;
    this.needsLogin = false;
    const sessionExpired = this.access.sessionExpired();
    // The record as it is before the fetch, for Get tags' own Undo.
    const map0 = this.ds.get('library.scriptTags');
    const had = !!map0 && typeof map0 === 'object' && Object.prototype.hasOwnProperty.call(map0, this.path);
    const snapshot = { path: this.path, had, before: had ? JSON.parse(JSON.stringify(map0[this.path])) : undefined };
    const run = getTagsForVideo({
      videoPath: this.path,
      scriptPath: this.scriptPath,
      settings: this.ds,
      scriptMeta: this.scriptMeta,
      isLoggedIn: this.access.isLoggedIn,
      login: this.access.login() || undefined,
      checkSession: this.access.checkSession() || undefined,
      queue: this.queue,
    });
    if (!this.disposed) this.renderSources();
    let outcome;
    try {
      outcome = await run;
    } catch (err) {
      outcome = { kind: 'error', answer: { errorCode: 'network', error: String(err?.message || err) } };
    }
    await this.onOutcome(outcome, { sessionExpired, snapshot });
    return outcome;
  }

  /**
   * Get tags' own Undo (verify-2: the Undo beside "Got N tags" was the older
   * "Post linked" one): the video's record back exactly as before the fetch
   * (or none), only while it is still as the fetch left it. null when the
   * fetch changed nothing.
   */
  getTagsUndo(snapshot) {
    const KEY = 'library.scriptTags';
    const map1 = this.ds.get(KEY);
    if (!snapshot || !map1 || typeof map1 !== 'object') return null;
    const afterJson = JSON.stringify(map1[snapshot.path]);
    if (afterJson === JSON.stringify(snapshot.before)) return null;
    return {
      focusKey: 'tags:get',
      run: () => {
        const now = this.ds.get(KEY);
        if (!now || typeof now !== 'object' || JSON.stringify(now[snapshot.path]) !== afterJson) {
          return { message: t(LIVE.getTagsUndoChanged) };
        }
        const next = { ...now };
        if (snapshot.had) next[snapshot.path] = JSON.parse(JSON.stringify(snapshot.before));
        else delete next[snapshot.path];
        this.ds.set(KEY, next);
        this.changed('tags');
        return { message: t(LIVE.getTagsUndone) };
      },
    };
  }

  async onOutcome(outcome, { sessionExpired, snapshot = null }) {
    const kind = outcome?.kind;
    if (kind === 'success') {
      this.loggedIn = true;
      this.changed('tags');
    } else if (kind === 'gone') {
      if (outcome.marked) this.changed('tags');
    } else if (kind === 'loginAgain') {
      // The forum refused the session: the session check decides, as for the
      // panel's search (the saved session goes, the panel says logged out).
      // A login it found good, or could not check, is kept, and the refusal
      // is said instead (a 403 can be Cloudflare or a post you may not see).
      // getTagsForVideo asks it itself when it has the check (sessionChecked);
      // else the hook is asked here, in the queue's line too (RB-4).
      const kept = !outcome.sessionChecked && (await this.loginKeptAfterRefusal(sessionExpired, { queued: true }));
      if (kept) {
        outcome = { kind: 'error', answer: { errorCode: 'accessDenied', error: 'Access denied' } };
      } else {
        this.needsLogin = true;
        this.loggedIn = false;
      }
    } else if (kind === 'loginRequired') {
      this.loggedIn = false;
    }
    // 'superseded': the record changed while the request ran (RB-1): nothing
    // was written, and the line says so; the section shows the record as it is.
    // A fetch that wrote (tags in, or the post marked gone) has its own Undo.
    const wrote = outcome?.kind === 'success' || (outcome?.kind === 'gone' && outcome.marked);
    const undo = wrote ? this.getTagsUndo(snapshot) : null;
    if (undo) this.offerUndo(outcomeText(outcome), undo, { focus: false });
    else this.say(outcomeText(outcome));
    if (!this.disposed) {
      // 'hub': the post turned out to be its creator's index (Dave,
      // 2026-11-19): nothing was written, the post now counts as not linked
      // (a record about it gives no tags), so the chips are drawn again too,
      // and the focus that sat on Get tags moves to Find the post.
      if (outcome?.kind === 'hub') {
        const inSection = this.root?.contains(document.activeElement);
        this.render();
        if (inSection) this.focusKey('tags:findPost');
        return;
      }
      this.renderSources();
      // One login button: [Log in…] when shown, else Get tags, which reads
      // "Log in to get tags…" now.
      if (outcome?.kind === 'loginAgain' && !this.focusKey('tags:login')) this.focusKey('tags:get');
    }
  }

  /**
   * The forum refused the session (401 / 403): `sessionExpired` asks the
   * session check, which drops a dead login. Was the login kept? Its answer
   * when it gives one ('valid' / 'unknown': kept; 'expired' / 'loggedOut':
   * gone); a hook that answers nothing: whether the login is still there.
   * After a Get tags refusal (`queued`) the hook waits its turn in the
   * queue's line, so it is never sent beside another forum request (RB-4).
   */
  async loginKeptAfterRefusal(sessionExpired, { queued = false } = {}) {
    let state;
    if (typeof sessionExpired === 'function') {
      try {
        state = queued ? await this.queue.run(() => sessionExpired(), undefined) : await sessionExpired();
      } catch {
        state = undefined;
      }
    }
    if (state === 'expired' || state === 'loggedOut') return false;
    if (sessionKept(state)) return true;
    try { return (await this.access.isLoggedIn()) === true; } catch { return false; }
  }

  /** [Log in…] after a 401 / 403: the login, then Get tags once. */
  async loginAndGet() {
    const login = this.access.login();
    let ok = false;
    if (login) {
      try { ok = (await login()) === true; } catch { ok = false; }
    }
    if (!ok) {
      this.say(t(FETCH_KEYS.loginRequired));
      return;
    }
    this.loggedIn = true;
    this.needsLogin = false;
    await this.getTags();
  }

  viewPost(res) {
    // Only a link to a topic on the forum's own host; else the canonical one.
    const url = topicIdFromLink(res.topicUrl) === res.topicId ? res.topicUrl : topicUrlFor(res.topicId);
    try { window.funsync?.openExternal?.(url); } catch { /* nothing to do */ }
  }

  /** A busy video: its Get tags request is queued or running (RB-1). */
  pending() {
    return !!this.path && this.queue.isPending(this.path);
  }

  /** Paste a post link…: links it at once, with Undo; nothing is sent until Get tags. */
  async pasteLink() {
    if (!this.scriptPath || this.pending()) return;
    const topicId = await promptPostLink();
    if (this.disposed) return;
    if (topicId == null) {
      this.focusKey('tags:paste');
      return;
    }
    this.linkPost(
      { topicId, url: topicUrlFor(topicId), title: null, creator: null, match: TAG_MATCH.MANUAL },
      { message: t(LIVE.linked), focusKey: 'tags:paste' },
    );
  }

  /**
   * Find the post on EroScripts…: the inline search in link-only mode. The
   * login comes first (the search needs it; no anonymous requests). Picking
   * links the post at once, with Undo, and nothing else: Get tags runs only
   * when you press it (Dave: Find the post only links the post).
   */
  async findPost() {
    if (!this.scriptPath || this.pending()) return;
    const picked = await this.searchForPost();
    if (this.disposed) return;
    if (!picked) {
      this.renderSources();
      this.focusKey('tags:findPost');
      return;
    }
    this.linkPost(this.pickedTopic(picked), { message: t(LIVE.linked), focusKey: 'tags:findPost' });
  }

  /** A post picked in Find the post, as linkScriptPost takes it (its link only on the forum's host). */
  pickedTopic(picked) {
    return {
      topicId: picked.id,
      url: typeof picked.url === 'string' && topicIdFromLink(picked.url) === picked.id ? picked.url : topicUrlFor(picked.id),
      title: picked.title,
      creator: picked.creator,
      match: TAG_MATCH.SEARCH,
    };
  }

  /**
   * Write the link (the first one, or Change post…): the record names the
   * post with no tags yet, so any old post's tags go at once; Undo puts the
   * exact old record back (none, when there was none). A Get tags request
   * pending for this video meanwhile writes nothing (RB-1).
   */
  linkPost(topic, { message, focusKey }) {
    const change = linkScriptPost(this.ds, this.path, topic, { scriptPath: this.scriptPath, match: topic.match });
    if (!change.written) {
      this.say(this.reasonText(change.reason === 'bad-store' ? 'bad-store' : 'no-path'));
      return change;
    }
    this.changed('tags');
    this.offerUndo(message, {
      focusKey,
      run: () => {
        const back = undoLinkScriptPost(this.ds, this.path, change);
        if (back.restored) this.changed('tags');
        return { message: t(back.restored ? LIVE.undone : LIVE.undoChangedSince) };
      },
    });
    return change;
  }

  /**
   * The login first (no login, no search), then the inline search in its
   * link-only mode with this section's login. Resolves the post picked
   * ({id, title, url, creator}), or null (no login, Cancel). Sends nothing
   * but the searches the user starts.
   */
  async searchForPost() {
    let ok = false;
    try { ok = (await this.access.isLoggedIn()) === true; } catch { ok = false; }
    if (!ok) {
      const login = this.access.login();
      if (login) {
        try { ok = (await login()) === true; } catch { ok = false; }
      }
    }
    if (!ok) {
      this.loggedIn = false;
      this.say(t(FETCH_KEYS.loginRequired));
      if (!this.disposed) this.renderSources();
      return null;
    }
    this.loggedIn = true;
    const sessionExpired = this.access.sessionExpired();
    const { showEroScriptsSearchModal } = await import('./eroscripts-inline-search.js');
    // The script's creator (its metadata, else the hub post passed over):
    // that creator's posts come first in the results, hub posts last (Dave,
    // 2026-11-19).
    const creator = this.resolution().hub?.creator || this.scriptMeta?.creator;
    const picked = await showEroScriptsSearchModal(this.video, {
      mode: 'link',
      preferCreator: typeof creator === 'string' && creator.trim() ? creator.trim() : null,
      eroscripts: {
        isLoggedIn: this.access.isLoggedIn,
        login: this.access.login() || undefined,
        checkSession: this.access.checkSession() || undefined,
      },
      onAuthExpired: async () => {
        if (!(await this.loginKeptAfterRefusal(sessionExpired))) this.loggedIn = false;
      },
    });
    const id = picked?.topic?.id;
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    return picked.topic;
  }

  /** The current post as the post line names it (the change question; text only). */
  postText(res) {
    const rec = res.from === 'record' ? this.record : null;
    const meta = res.from === 'metadata' ? this.scriptMeta : null;
    const title = rec?.title || meta?.title || null;
    return title
      ? t('videoOptions.tags.source.postNoCreator', { title })
      : t('videoOptions.tags.source.postId', { id: res.topicId });
  }

  /**
   * "Change post…" (Dave, 2026-11-18) for a video whose post is known: Paste
   * a post link or Find the post picks a different one. Nothing is fetched
   * until Get tags (Find the post searches only when you press Search).
   */
  async changePost(res) {
    if (!this.scriptPath || res?.state !== 'known' || this.pending()) return;
    const how = await promptChangePost(this.postText(res));
    if (this.disposed) return;
    let topic = null;
    if (how === 'paste') {
      const topicId = await promptPostLink();
      if (topicId != null) topic = { topicId, url: topicUrlFor(topicId), title: null, creator: null, match: TAG_MATCH.MANUAL };
    } else if (how === 'find') {
      const picked = await this.searchForPost();
      if (picked) topic = this.pickedTopic(picked);
    }
    if (this.disposed) return;
    if (!topic) {
      this.renderSources();
      this.focusKey('tags:changePost');
      return;
    }
    this.applyChangePost(topic, res);
  }

  /**
   * Link the new post: the record names it with no tags yet, so the old
   * post's tags go at once; Undo puts the exact old record back.
   */
  applyChangePost(topic, res) {
    if (topic.topicId === res.topicId) {
      this.say(t(LIVE.samePost));
      this.focusKey('tags:changePost');
      return null;
    }
    return this.linkPost(topic, { message: t(LIVE.postChanged), focusKey: 'tags:changePost' });
  }

  // ---- Make a category ----

  async makeCategory(tag) {
    const videos = typeof this.ctx.getLibraryVideos === 'function' ? (this.ctx.getLibraryVideos() || []) : [];
    const list = Array.isArray(videos) ? videos : [];
    const rules = this.rules;
    const memo = this.libraryIndex(list);
    const planFor = (name) => planMakeCategory({
      key: tag.key,
      name,
      videos: list,
      tagsByPath: memo.index,
      categories: this.ds?.getCategories?.() || [],
      videoCategories: this.ds?.getAllVideoCategories?.() || {},
      rules,
    });
    const plan = await promptMakeCategory(shownLabel(tag), planFor);
    if (!plan) {
      if (!this.disposed) this.focusKey(`tags:chip:${tag.key}`);
      return null;
    }
    const takeSnapshot = typeof window !== 'undefined' && typeof window.funsync?.backupPreAction === 'function'
      ? (label) => window.funsync.backupPreAction(label)
      : undefined;
    let result;
    try {
      result = await applyMakeCategory(plan, { settings: this.ds, takeSnapshot });
    } catch (err) {
      console.warn('[VideoOptions/Tags] make category failed', err);
      result = { ok: false };
    }
    if (!result?.ok) {
      this.say(t(LIVE.categoryFailed));
      return result;
    }
    this.changed('categories');
    const name = plan.mode === 'existing' ? plan.category.name : plan.name;
    let message;
    if (plan.mode === 'create') message = t(LIVE.categoryMade, { name, count: result.assigned.length });
    else if (result.assigned.length > 0) message = t(LIVE.categoryAdded, { name, count: result.assigned.length });
    else message = t(LIVE.categoryNothing, { name });
    this.say(message);
    // Undo in a toast, 8 s (design (c)): the category it made, or only the
    // assignments it added to an existing one.
    if (result.undo && (plan.mode === 'create' || result.assigned.length > 0)) {
      this.offerUndoToast({
        message,
        done: false,
        run: () => {
          undoMakeCategory(result.undo, { settings: this.ds });
          this.changed('categories');
          const text = t(plan.mode === 'create' ? LIVE.categoryRemoved : LIVE.categoryUnassigned, { name });
          this.say(text);
          return { message: text };
        },
      });
    }
    if (!this.disposed) this.focusKey(`tags:chip:${tag.key}`);
    return result;
  }
}

function actions(buttons) {
  const row = el('div', 'video-options__actions');
  for (const b of buttons) if (b) row.appendChild(b);
  return row;
}

export function mountTagsSection(host, ctx) {
  const section = new TagsSection(host, ctx);
  section.mount();
  return {
    dispose() { section.dispose(); },
    handleEscape(event) { return section.handleEscape(event); },
    refresh() { if (!section.disposed) section.render(); },
  };
}
