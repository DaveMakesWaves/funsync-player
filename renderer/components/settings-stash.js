// Settings > Sources > Stash: link your own Stash server (S1, read-only).
//
// notes/features/DESIGN-stash-s1.md (a), (d), (e), (f) "Settings > Stash"
// and Dave's answers at its end, which override the text above them:
//   - a "Stash" block at the BOTTOM of Settings > Sources, not a rail item;
//   - the API key is saved in plain text on portable builds and on installed
//     builds without encryption, with a visible note next to the field (the
//     status reply says which mode: `saveStorage` / `keyStorage`);
//   - "Trust this certificate": when Test or a sync meets an https
//     certificate this PC does not trust, show its SHA-256 fingerprint and
//     subject with a button that pins it for THAT address only; the pin is
//     shown with a way to remove it; another address never shows it.
//
// Two views: set up (Address, API key, Test connection, Link Stash, the help
// line) and linked (Linked to…, the key line, Sync now with its progress and
// Cancel, Sync on start, Use Stash's tag aliases and sub-tags (the opt-in
// of the "next" lot, sn-tags 2026-11-19: `stash.useTagRules`, off by
// default), the Need-a-check list, the Re-linked list (this
// session's re-links by a full sync, Sync now's or the start-up sync's, with
// Undo each and Undo all), path rules, Turn off, Remove Stash data… with
// Undo). A linked Stash that is turned off shows Turn on.
//
// Rules kept here:
//   - The key is never shown back. The field is a password field; the
//     renderer sends a typed key to main with Test and Link and clears the
//     field once Link has saved it. No reply carries the key (main's rule).
//   - Nothing happens on its own: no request on opening Settings beyond the
//     status read (main answers it from memory), no sync on Turn on.
//   - Untrusted text (file names, certificate subjects, addresses) goes in
//     with textContent only. This module never uses innerHTML.
//   - Results go in polite role="status" lines; nothing steals focus. A
//     control that goes away hands focus to the one that replaces it.
//
// main.js / preload.js (stage s1-2a) own the IPC; STASH_IPC below is the one
// place that names it. A missing method (an older preload, a test fake) is a
// quiet no-op, so Settings always renders.

import { Modal } from './modal.js';
import { t, getCurrentLocale } from '../js/i18n.js';
import { showToast } from '../js/toast.js';
import { eventBus } from '../js/event-bus.js';
import {
  stashRelinks, noteStashRelinks, forgetStashRelinks, onStashRelinksChanged,
} from '../js/stash-store.js';

/**
 * This session's re-links by a full sync (stash-store.js), as the block
 * reads and changes them. A test passes its own.
 */
export const STASH_RELINK_STORE = Object.freeze({
  list: stashRelinks,
  note: noteStashRelinks,
  forget: forgetStashRelinks,
  onChanged: onStashRelinksChanged,
});

/** The design's address placeholder (Stash on this PC). */
export const STASH_PLACEHOLDER_ADDRESS = 'http://127.0.0.1:9999';
/** Need-a-check rows shown before "Show all (n)" (design (f)). */
export const CHECK_ROWS_SHOWN = 20;
/** How long Remove Stash data… can be undone (design (a) 10, (f)). */
export const REMOVE_UNDO_MS = 8000;
const MIN_STASH_VERSION = '0.27.0';

/**
 * The window.funsync names behind each call (electron/preload.js, stage
 * s1-2a-main's IPC contract). Every call resolves plain JSON, never throws
 * and never carries the key; a failure is `{ok: false, code}`.
 */
export const STASH_IPC = Object.freeze({
  status: 'stashStatus',
  test: 'stashTest',
  link: 'stashLink',
  setOptions: 'stashSetOptions',
  sync: 'stashSync',
  cancelSync: 'stashCancel',
  onProgress: 'onStashProgress',
  data: 'stashGetData',
  onChanged: 'onStashChanged',
  onSettingsChanged: 'onStashSettingsChanged',
  removeKey: 'stashRemoveKey',
  removeData: 'stashRemoveData',
  undo: 'stashUndo',
  trustCertificate: 'stashTrustCertificate',
  forgetCertificate: 'stashForgetCertificate',
});

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v !== '' ? v : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The calls this block makes, over `bridge` (window.funsync). Each resolves
 * to the reply, or null when the bridge lacks that method; a listener
 * method returns its unsubscribe (a no-op when missing).
 */
export function stashSettingsApi(bridge = globalThis.window?.funsync) {
  const has = (name) => typeof bridge?.[STASH_IPC[name]] === 'function';
  const call = (name) => async (...args) => {
    if (!has(name)) return null;
    return bridge[STASH_IPC[name]](...args);
  };
  const listen = (name) => (cb) => {
    if (!has(name)) return () => {};
    const off = bridge[STASH_IPC[name]](cb);
    return typeof off === 'function' ? off : () => {};
  };
  return {
    has,
    status: call('status'),
    test: call('test'),
    link: call('link'),
    setOptions: call('setOptions'),
    sync: call('sync'),
    cancelSync: call('cancelSync'),
    onProgress: listen('onProgress'),
    data: call('data'),
    onChanged: listen('onChanged'),
    onSettingsChanged: listen('onSettingsChanged'),
    removeKey: call('removeKey'),
    removeData: call('removeData'),
    undo: call('undo'),
    trustCertificate: call('trustCertificate'),
    forgetCertificate: call('forgetCertificate'),
  };
}

/** An address's origin (scheme, host, port): what a certificate pin belongs to. */
export function stashOrigin(address) {
  if (typeof address !== 'string' || !address.trim()) return '';
  try {
    const u = new URL(address.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin.toLowerCase() : '';
  } catch {
    return '';
  }
}

/** The library's videos as Sync now sends them: path, size, modified time (the scan's dateAdded). */
export function stashSyncVideoList(videos) {
  const out = [];
  for (const v of Array.isArray(videos) ? videos : []) {
    if (typeof v?.path !== 'string' || !v.path) continue;
    const item = { path: v.path };
    if (Number.isFinite(v.size)) item.size = v.size;
    const mtime = Number.isFinite(v.mtimeMs) ? v.mtimeMs : v.dateAdded;
    if (Number.isFinite(mtime) && mtime > 0) item.mtimeMs = mtime;
    if (v.offline === true) item.offline = true;
    out.push(item);
  }
  return out;
}

/** Compare two addresses the way a pin does: no case in scheme and host, no trailing slash. */
export function sameStashAddress(a, b) {
  const norm = (v) => (typeof v === 'string' ? v.trim().replace(/\/+$/, '').toLowerCase() : '');
  const x = norm(a);
  return x !== '' && x === norm(b);
}

/** A certificate's subject (an object from Node's getPeerCertificate, or a string) as text. */
export function certificateSubjectText(subject) {
  if (typeof subject === 'string') return subject;
  if (!isObj(subject)) return '';
  return Object.entries(subject)
    .filter(([, v]) => typeof v === 'string' || Array.isArray(v))
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('+') : v}`)
    .join(', ');
}

/**
 * A certificate main saw (`certificate` on a Test or sync failure) or the
 * pin it keeps (`settings.stash.trustedCert` = {origin, sha256, subject}),
 * as {fingerprint256, subject, origin, pinMismatch}.
 */
export function normalizeCertificate(c) {
  if (!isObj(c)) return null;
  const fingerprint256 = str(c.fingerprint256) || str(c.sha256);
  if (!fingerprint256) return null;
  return {
    fingerprint256,
    subject: certificateSubjectText(c.subject),
    origin: str(c.origin) ? c.origin.toLowerCase() : '',
    pinMismatch: c.pinMismatch === true,
  };
}

/** The status reply (s1-2a-main: `{ok, settings, key, keyTravelsInClear, library, sync}`) in one shape. */
export function normalizeStashStatus(raw) {
  const s = isObj(raw) && raw.ok !== false ? raw : {};
  const key = isObj(s.key) ? s.key : {};
  const lib = isObj(s.library) ? s.library : {};
  const server = isObj(lib.server) ? lib.server : null;
  const sync = isObj(s.sync) ? s.sync : null;
  const prog = sync && isObj(sync.progress) ? sync.progress : {};
  const counts = isObj(lib.counts) ? lib.counts : {};
  const settings = isObj(s.settings) ? s.settings : null;
  return {
    known: isObj(raw) && raw.ok !== false,
    settings,
    hasKey: key.hasKey === true,
    keyStorage: str(key.keyStorage),
    saveStorage: str(key.saveStorage),
    plainReason: str(key.plainReason),
    keyUnreadable: key.unreadable === true,
    // s1-fixup-main (S1RB-1): the key is bound to the address it was saved
    // for; `elsewhere` = saved for another address, so it is not sent.
    keyElsewhere: key.hasKey === true && key.elsewhere === true,
    keyAddress: str(key.address),
    serverUrl: server ? str(server.url) : null,
    version: server ? str(server.version) : null,
    lastSync: isObj(lib.lastSync) ? lib.lastSync : null,
    damaged: isObj(lib.damaged) ? lib.damaged : null,
    // s1-fixup-main (S1RB-2): the previous copy (library.json.bak) was loaded.
    recovered: isObj(lib.recovered) ? lib.recovered : null,
    linkCount: num(counts.links),
    // "Sync this video" (kind 'video') is the dialog's; Settings shows a full sync.
    syncing: sync && sync.running === true && sync.kind !== 'video'
      ? { step: str(prog.step), done: num(prog.done) ?? 0, total: num(prog.total) ?? 0 }
      : null,
    keyTravelsInClear: s.keyTravelsInClear === true,
    pin: normalizeCertificate(settings?.trustedCert),
  };
}

/** "v0.32.0" whether Stash's version came with its "v" or without. */
function versionText(v) {
  const s = str(v);
  if (!s) return null;
  return /^v/i.test(s) ? s : `v${s}`;
}

/**
 * The words for a failed Stash call (design (e)): one reason per code, from
 * the shared `stash.error.*` strings (stage s1-1a). `address` fills the
 * "Can't reach Stash at …" line.
 */
export function stashErrorText(reply, address = '') {
  const code = isObj(reply) ? (str(reply.code) || str(reply.error?.code) || str(reply.error)) : null;
  const src = isObj(reply?.error) ? reply.error : (reply || {});
  const minVersion = str(src.minVersion) || str(reply?.minVersion) || MIN_STASH_VERSION;
  const version = versionText(src.version || reply?.version);
  switch (code) {
    case 'unreachable': return t('stash.error.unreachable', { address: address || str(reply?.address) || '' });
    case 'tooOld':
      return version ? t('stash.error.tooOld', { version, minVersion }) : t('stash.error.tooOldNoVersion', { minVersion });
    case 'http': return t('stash.error.http', { status: String(num(src.status) ?? num(reply?.status) ?? '') });
    case 'unknownQuery': return t('stash.error.badInput');
    case 'busy': return t('settingsPanel.stash.errorBusy');
    case 'notLinked': return t('settingsPanel.stash.errorNotLinked');
    case 'timeout': case 'badKey': case 'needsKey': case 'forbidden': case 'notStash': case 'redirect':
    case 'certificate': case 'graphql': case 'tooLarge': case 'cancelled': case 'badAddress': case 'badInput':
    case 'invalidKey': case 'writeFailed': case 'removeFailed': case 'keyUnreadable':
      return t(`stash.error.${code}`);
    default: return t('settingsPanel.stash.errorOther', { code: code || '?' });
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(text, { className = '', focusKey, ariaLabel, onClick } = {}) {
  const b = el('button', `stash-settings__btn${className ? ` ${className}` : ''}`, text);
  b.type = 'button';
  if (focusKey) b.dataset.stashFocus = focusKey;
  if (ariaLabel) b.setAttribute('aria-label', ariaLabel);
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

const fileName = (p) => (typeof p === 'string' ? p.split(/[\\/]/).pop() || p : '');

function formatWhen(ms) {
  if (!Number.isFinite(ms)) return '';
  try {
    return new Date(ms).toLocaleString(getCurrentLocale(), { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return new Date(ms).toLocaleString();
  }
}

/** The counts of a sync as " · "-joined parts (matched, need a check, not in Stash, then the rest when above 0). */
function countParts(counts, { videos = false } = {}) {
  const c = isObj(counts) ? counts : {};
  const n = (k) => num(c[k]) ?? 0;
  const parts = [
    t(videos ? 'settingsPanel.stash.countMatchedVideos' : 'settingsPanel.stash.countMatched', { count: n('linked') }),
    t('settingsPanel.stash.countCheck', { count: n('check') }),
    t('settingsPanel.stash.countNotInStash', { count: n('notInStash') }),
  ];
  if (n('gone') > 0) parts.push(t('settingsPanel.stash.countGone', { count: n('gone') }));
  if (n('changed') > 0) parts.push(t('settingsPanel.stash.countChanged', { count: n('changed') }));
  if (n('skipped') > 0) parts.push(t('settingsPanel.stash.countSkipped', { count: n('skipped') }));
  return parts.join(' · ');
}

/** What an Undo did: the words its run() answered, else the done / failed words it was offered with. */
function undoResultText(reply, undo) {
  if (isObj(reply) && typeof reply.text === 'string' && reply.text) return reply.text;
  return reply && reply.ok === true ? undo.doneText : undo.failText;
}

/** The step line under the progress bar (design (a) 5). */
export function syncStepText(p) {
  const step = isObj(p) ? p.step : null;
  const done = num(p?.done) ?? 0;
  const total = num(p?.total) ?? 0;
  switch (step) {
    case 'hash': return t('settingsPanel.stash.stepHash', { done, total });
    case 'list': return t('settingsPanel.stash.stepList', { done, total });
    case 'match': return t('settingsPanel.stash.stepMatch');
    case 'details': return t('settingsPanel.stash.stepDetails', { done, total });
    case 'write': return t('settingsPanel.stash.stepWrite');
    default: return t('settingsPanel.stash.stepStart');
  }
}

/**
 * The Stash block. `settings` is the DataService; `api` defaults to
 * stashSettingsApi(window.funsync); `onOpenCheck(path)` opens that video's
 * dialog at File on its Stash choice (app.js), after `closeSettings()`.
 */
export class StashSettingsBlock {
  constructor({
    settings, api = stashSettingsApi(), getVideos = null, onOpenCheck = null, closeSettings = null, timers = globalThis,
    relinks = STASH_RELINK_STORE,
  } = {}) {
    this._settings = settings;
    this._api = api;
    this._relinks = relinks || STASH_RELINK_STORE;
    this._showAllRelinks = false;
    this._relinkBusy = false;
    this._getVideos = typeof getVideos === 'function' ? getVideos : () => [];
    this._onOpenCheck = typeof onOpenCheck === 'function' ? onOpenCheck : null;
    this._closeSettings = typeof closeSettings === 'function' ? closeSettings : null;
    this._timers = timers;
    this._status = normalizeStashStatus(null);
    this._data = null;
    this._mode = null;
    this._changing = false;
    this._replacingKey = false;
    this._tested = null;      // {address, key, ok, reply} of the last Test
    this._certOffer = null;   // the certificate the last Test or sync met
    this._sync = null;        // {step, done, total, cancelling} while a sync runs
    this._syncResult = null;
    this._showAllChecks = false;
    this._pendingUndo = null;
    this._destroyed = false;
    this._busy = null;        // 'test' | 'link' | 'trust' while that call runs
    this._seq = 0;            // the newest refresh() (an older answer is dropped)
    this._idSeq = 0;

    this.el = el('section', 'settings-panel__section stash-settings');
    this.el.id = 'sp-sec-stash';
    this.el.setAttribute('aria-labelledby', 'sp-stash-title');
    const title = el('h2', 'settings-panel__section-header', t('settingsPanel.stash.header'));
    title.id = 'sp-stash-title';
    this.el.appendChild(title);
    this.el.appendChild(el('p', 'settings-panel__hint stash-settings__intro', t('settingsPanel.stash.intro')));
    this._damagedEl = el('p', 'stash-settings__note stash-settings__note--warn');
    this._damagedEl.hidden = true;
    this.el.appendChild(this._damagedEl);
    this._viewEl = el('div', 'stash-settings__view');
    this.el.appendChild(this._viewEl);

    // The block's live line: what the last action did, with its Undo.
    this._liveEl = el('div', 'stash-settings__live');
    this._liveEl.setAttribute('role', 'status');
    this._liveEl.setAttribute('aria-live', 'polite');
    this._liveTextEl = el('span', 'stash-settings__live-text');
    this._undoBtn = button(t('toast.undo'), { className: 'stash-settings__undo', focusKey: 'undo', onClick: () => this._runUndo() });
    this._undoBtn.hidden = true;
    this._liveEl.append(this._liveTextEl, this._undoBtn);
    this.el.appendChild(this._liveEl);

    this._offProgress = this._api.onProgress((p) => this._onProgress(p));
    this._offChanged = this._api.onChanged(() => { this.refresh(); });
    this._offRelinks = this._listenRelinks();
    // Main is the only writer of stash.url and stash.trustedCert; it reports
    // a change with the whole block (applied once, whoever hears it first).
    this._offSettings = this._api.onSettingsChanged((block) => { this._applySavedStash(block); this._render(); });
    this._offBus = eventBus.on('settings:changed', ({ path } = {}) => {
      if (typeof path === 'string' && (path === 'stash' || path.startsWith('stash.'))) this._render();
    });

    this._render();
    this.refresh();
  }

  // ---- state ----

  /** A `settings.stash` value: the renderer's copy, else what the status reply said. */
  _stashSetting(name) {
    const v = this._settings?.get?.(`stash.${name}`);
    return v !== undefined ? v : this._status.settings?.[name];
  }

  _url() {
    const v = this._stashSetting('url');
    return typeof v === 'string' ? v : '';
  }

  _enabled() {
    return this._stashSetting('enabled') === true;
  }

  /** The pinned certificate (`settings.stash.trustedCert`), or null. */
  _pin() {
    return normalizeCertificate(this._stashSetting('trustedCert'));
  }

  /**
   * Apply a `settings.stash` block main saved (a reply's `settings`, or its
   * change report) to the renderer's copy, without sending it back: main is
   * the only writer of `url` and `trustedCert`. Once: an equal block is a no-op.
   */
  _applySavedStash(block) {
    if (!isObj(block) || typeof this._settings?.applySavedSetting !== 'function') return;
    if (JSON.stringify(this._settings.get('stash') ?? null) === JSON.stringify(block)) return;
    this._settings.applySavedSetting('stash', block);
  }

  /**
   * Turn off / on, Sync on start, the tag aliases opt-in, path rules: through main (stashSetOptions,
   * which answers with the saved block). With no such call (an older
   * preload), the plain settings write main also accepts.
   */
  async _setOptions(opts, focusKey = null) {
    let reply = null;
    const viaMain = this._api.has('setOptions');
    if (viaMain) {
      try { reply = await this._api.setOptions(opts); } catch (err) { console.warn('[Stash] options failed:', err?.message || err); }
    }
    if (this._destroyed) return false;
    if (viaMain && (!reply || reply.ok !== true)) {
      this._say(stashErrorText(reply || { code: 'badInput' }));
      return false;
    }
    // Set before the write: its settings:changed renders the new view.
    this._focusAfterSwitch = focusKey;
    if (viaMain) this._applySavedStash(reply.settings);
    else for (const [k, v] of Object.entries(opts)) this._settings.set(`stash.${k}`, v);
    this._render();
    return true;
  }

  _modeNow() {
    if (!this._url() || this._changing) return 'setup';
    return this._enabled() ? 'linked' : 'off';
  }

  /** Read the status (and the data, for the check list) and update the view. */
  async refresh() {
    const seq = ++this._seq;
    let raw = null;
    let data = null;
    try { raw = await this._api.status(); } catch (err) { console.warn('[Stash] status failed:', err?.message || err); }
    try { data = await this._api.data(); } catch (err) { console.warn('[Stash] data failed:', err?.message || err); }
    if (this._destroyed || seq !== this._seq) return;
    this._status = normalizeStashStatus(raw);
    this._data = isObj(data) ? data : null;
    if (this._status.syncing && !this._sync) this._sync = { ...this._status.syncing, cancelling: false, elsewhere: true };
    if (!this._status.syncing && this._sync?.elsewhere) this._sync = null;
    this._render();
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    for (const off of [this._offProgress, this._offChanged, this._offSettings, this._offBus, this._offRelinks]) {
      try { off?.(); } catch { /* listener gone */ }
    }
    const undo = this._pendingUndo;
    this._pendingUndo = null;
    if (undo) {
      this._timers.clearTimeout(undo.timer);
      const left = undo.expiresAt - Date.now();
      if (left > 500) this._offerUndoToast(undo, left);
    }
  }

  // ---- rendering ----

  _render() {
    if (this._destroyed) return;
    const dmg = this._status.damaged;
    const rec = this._status.recovered;
    this._damagedEl.hidden = !dmg && !rec;
    let damagedText = '';
    // With the previous copy loaded, "Sync to rebuild it" would be wrong.
    if (dmg && rec) damagedText = t('settingsPanel.stash.damagedRecovered', { name: fileName(str(dmg.as) || '') });
    else if (dmg) damagedText = t('settingsPanel.stash.damaged', { name: fileName(str(dmg.as) || '') });
    else if (rec) damagedText = t('settingsPanel.stash.recoveredMissing');
    this._damagedEl.textContent = damagedText;

    // Parts are rebuilt on an update; the control that had focus gets it
    // back (by its focus key), so a status answer never drops the user.
    const active = document.activeElement;
    const hadFocus = this._viewEl.contains(active);
    const focusKey = hadFocus ? active?.dataset?.stashFocus || null : null;
    const mode = this._modeNow();
    const switched = mode !== this._mode;
    if (switched) {
      this._mode = mode;
      this._viewEl.replaceChildren();
      if (mode === 'setup') this._buildSetup();
      else if (mode === 'linked') this._buildLinked();
      else this._buildOff();
    }
    if (mode === 'setup') this._updateSetup();
    else if (mode === 'linked') this._updateLinked();
    else this._updateOff();
    const next = switched ? this._focusAfterSwitch : focusKey;
    this._focusAfterSwitch = null;
    if (hadFocus && next && !this._viewEl.contains(document.activeElement)) this._focus(next);
  }

  _focus(key) {
    const target = this.el.querySelector(`[data-stash-focus="${key}"]`);
    if (target && !target.hidden && !target.disabled) target.focus();
  }

  _switchMode(focusKey) {
    this._focusAfterSwitch = focusKey;
    this._render();
  }

  /**
   * Say what happened (polite). `undo` = {run, ms, doneText, failText,
   * ariaLabel} keeps an Undo button for `ms`; a later message leaves it,
   * named for what it undoes.
   */
  _say(text, undo = null) {
    this._liveTextEl.textContent = text || '';
    if (undo) {
      this._clearUndo();
      const ms = num(undo.ms) ?? REMOVE_UNDO_MS;
      const timer = this._timers.setTimeout(() => this._expireUndo(), ms);
      this._pendingUndo = { ...undo, message: text, timer, expiresAt: Date.now() + ms };
      if (undo.ariaLabel) this._undoBtn.setAttribute('aria-label', undo.ariaLabel);
      else this._undoBtn.removeAttribute('aria-label');
      this._undoBtn.hidden = false;
    } else if (!this._pendingUndo) {
      this._undoBtn.hidden = true;
    }
  }

  _clearUndo() {
    if (this._pendingUndo) this._timers.clearTimeout(this._pendingUndo.timer);
    this._pendingUndo = null;
    const hadFocus = document.activeElement === this._undoBtn;
    this._undoBtn.hidden = true;
    return hadFocus;
  }

  _expireUndo() {
    const hadFocus = this._clearUndo();
    if (hadFocus) this._focusFirstAction();
  }

  _focusFirstAction() {
    for (const key of ['sync', 'link', 'test', 'turn-on', 'address']) {
      const target = this.el.querySelector(`[data-stash-focus="${key}"]`);
      if (target && !target.hidden && !target.disabled) { target.focus(); return; }
    }
  }

  async _runUndo() {
    const undo = this._pendingUndo;
    if (!undo) return;
    const hadFocus = this._clearUndo();
    let reply = null;
    try { reply = await undo.run(); } catch (err) { console.warn('[Stash] undo failed:', err?.message || err); }
    if (this._destroyed) return;
    const left = undo.expiresAt - Date.now();
    if (typeof undo.retry === 'function' && undo.retry(reply) && left > 500) {
      // The same Undo may be tried again for the rest of its window.
      this._say(undo.retryText || undoResultText(reply, undo), { ...undo, ms: left });
      await this.refresh();
      if (hadFocus && !this._undoBtn.hidden) this._undoBtn.focus();
      return;
    }
    this._say(undoResultText(reply, undo));
    await this.refresh();
    if (hadFocus) this._focusFirstAction();
  }

  _offerUndoToast(undo, ms) {
    const body = el('div', 'update-toast');
    body.appendChild(el('span', null, undo.message || ''));
    const b = el('button', 'update-toast__btn stash-settings__toast-undo', t('toast.undo'));
    b.type = 'button';
    b.addEventListener('click', async () => {
      let reply = null;
      try { reply = await undo.run(); } catch { /* reported below */ }
      showToast(undoResultText(reply, undo), 'info', 2500);
    });
    body.appendChild(b);
    showToast(body, 'info', ms);
  }

  // ---- the API key line (both views) ----

  _keyLineText() {
    const s = this._status;
    if (s.keyUnreadable) return t('stash.error.keyUnreadable');
    if (!s.hasKey) return t('settingsPanel.stash.noKey');
    // A key saved for another address is not sent here (s1-fixup-main, S1RB-1).
    if (s.keyElsewhere) {
      return s.keyAddress
        ? t('settingsPanel.stash.keyElsewhere', { address: s.keyAddress })
        : t('settingsPanel.stash.keyElsewhereNoAddress');
    }
    if (s.keyStorage === 'plain') return t('settingsPanel.stash.keySavedPlain');
    if (s.keyStorage === 'memory') return t('settingsPanel.stash.keySavedMemory');
    return t('settingsPanel.stash.keySavedEncrypted');
  }

  /**
   * The note next to the key field: where a key typed here will be kept.
   * Plain text on a portable build and on an installed build that cannot
   * encrypt (Dave's answers); `plainReason` says which.
   */
  _keyNoteText() {
    const s = this._status;
    if (s.saveStorage === 'plain') {
      if (s.plainReason === 'portable') return t('settingsPanel.stash.keyNotePortable');
      if (s.plainReason === 'noEncryption') return t('settingsPanel.stash.keyNoteNoEncryption');
      return t('settingsPanel.stash.keyNotePlain');
    }
    if (s.saveStorage === 'memory') return t('settingsPanel.stash.keyNoteMemory');
    return '';
  }

  async _removeKey() {
    const ok = await Modal.confirm(
      t('settingsPanel.stash.removeKeyTitle'),
      t('settingsPanel.stash.removeKeyBody'),
      { confirmText: t('common.remove') },
    );
    if (!ok || this._destroyed) return;
    let reply = null;
    try { reply = await this._api.removeKey(); } catch (err) { reply = { ok: false, code: 'removeFailed' }; console.warn('[Stash] remove key failed:', err?.message || err); }
    if (this._destroyed) return;
    this._say(reply && reply.ok !== false ? t('settingsPanel.stash.keyRemoved') : stashErrorText(reply?.code ? reply : { code: 'removeFailed' }));
    this._replacingKey = false;
    this._tested = null;
    await this.refresh();
    this._focus(this._mode === 'setup' ? 'key' : 'key-add');
  }

  // ---- the certificate trust step and the pin ----

  /** The trust box for a certificate Test or a sync met (`offer` = {certificate, address}). */
  _buildCertOffer(offer, { onTrusted }) {
    const box = el('div', 'stash-settings__cert');
    box.setAttribute('role', 'group');
    const titleId = `sp-stash-cert-title-${++this._idSeq}`;
    box.setAttribute('aria-labelledby', titleId);
    // A certificate that differs from the one trusted for this address says so.
    const pin = this._pin();
    const changed = offer.certificate.pinMismatch
      || (!!pin && pin.origin === stashOrigin(offer.address) && pin.fingerprint256 !== offer.certificate.fingerprint256);
    const title = el('p', 'stash-settings__cert-title', t(changed ? 'settingsPanel.stash.certChanged' : 'settingsPanel.stash.certTitle'));
    title.id = titleId;
    box.appendChild(title);
    const facts = el('dl', 'stash-settings__cert-facts');
    if (offer.certificate.subject) {
      facts.appendChild(el('dt', null, t('settingsPanel.stash.certSubject')));
      facts.appendChild(el('dd', 'stash-settings__cert-subject', offer.certificate.subject));
    }
    facts.appendChild(el('dt', null, t('settingsPanel.stash.certFingerprint')));
    const dd = el('dd');
    dd.appendChild(el('code', 'stash-settings__fingerprint', offer.certificate.fingerprint256));
    facts.appendChild(dd);
    box.appendChild(facts);
    box.appendChild(el('p', 'settings-panel__hint', t('settingsPanel.stash.certExplain', { address: stashOrigin(offer.address) || offer.address })));
    const trust = button(t('settingsPanel.stash.certTrust'), { className: 'stash-settings__btn--primary', focusKey: 'cert-trust' });
    trust.addEventListener('click', async () => {
      // aria-disabled, not disabled: a disabled button would drop the focus.
      if (this._busy) return;
      this._busy = 'trust';
      trust.setAttribute('aria-disabled', 'true');
      let reply = null;
      try {
        // Exactly this certificate, for exactly this address (Dave).
        reply = await this._api.trustCertificate({ address: offer.address, fingerprint256: offer.certificate.fingerprint256 });
      } catch (err) { console.warn('[Stash] trust failed:', err?.message || err); }
      this._busy = null;
      if (this._destroyed) return;
      if (!reply || reply.ok !== true) {
        trust.setAttribute('aria-disabled', 'false');
        this._say(t('settingsPanel.stash.certTrustFailed'));
        return;
      }
      this._certOffer = null;
      this._say(t('settingsPanel.stash.certTrusted', { address: stashOrigin(offer.address) || offer.address }));
      this._applySavedStash(reply.settings);
      this._render();
      onTrusted?.();
    });
    box.appendChild(trust);
    return box;
  }

  /** The certificate trusted for `address`'s origin, with Stop trusting; null when there is none for it. */
  _buildPinRow(address) {
    const pin = this._pin();
    const origin = stashOrigin(address);
    if (!pin || !origin || pin.origin !== origin) return null;
    const row = el('div', 'stash-settings__pin');
    const text = el('div', 'stash-settings__pin-text');
    text.appendChild(el('span', 'stash-settings__pin-label', t('settingsPanel.stash.certPinned', { address: origin })));
    text.appendChild(el('code', 'stash-settings__fingerprint', pin.fingerprint256));
    if (pin.subject) text.appendChild(el('span', 'stash-settings__pin-subject', pin.subject));
    row.appendChild(text);
    row.appendChild(button(t('settingsPanel.stash.certForget'), {
      focusKey: 'cert-forget',
      ariaLabel: t('settingsPanel.stash.certForgetAria', { address: origin }),
      onClick: async () => {
        let reply = null;
        try { reply = await this._api.forgetCertificate(); } catch (err) { console.warn('[Stash] forget failed:', err?.message || err); }
        if (this._destroyed) return;
        const ok = !!reply && reply.ok === true;
        this._say(ok ? t('settingsPanel.stash.certForgotten') : t('settingsPanel.stash.certForgetFailed'));
        if (ok) this._applySavedStash(reply.settings);
        this._render();
        this._focus(this._mode === 'setup' ? 'test' : 'sync');
      },
    }));
    return row;
  }

  // ---- set up (and Change…) ----

  _buildSetup() {
    const view = el('div', 'stash-settings__setup');

    const addrField = el('div', 'stash-settings__field');
    const addrLabel = el('label', 'settings-panel__field-label stash-settings__label', t('settingsPanel.stash.addressLabel'));
    addrLabel.htmlFor = 'sp-stash-address';
    const addr = el('input', 'settings-panel__input stash-settings__input');
    addr.id = 'sp-stash-address';
    addr.type = 'url';
    addr.inputMode = 'url';
    addr.placeholder = STASH_PLACEHOLDER_ADDRESS;
    addr.autocomplete = 'off';
    addr.spellcheck = false;
    addr.dataset.stashFocus = 'address';
    addr.value = this._url();
    addrField.append(addrLabel, addr);
    view.appendChild(addrField);
    this._addrInput = addr;

    this._setupPinEl = el('div', 'stash-settings__pin-slot');
    view.appendChild(this._setupPinEl);

    // API key: the saved-key line, or the field (masked, never filled from anything).
    const keyField = el('div', 'stash-settings__field stash-settings__field--key');
    const keyLabel = el('label', 'settings-panel__field-label stash-settings__label', t('settingsPanel.stash.keyLabel'));
    keyLabel.htmlFor = 'sp-stash-key';
    const keyBox = el('div', 'stash-settings__key-box');
    const key = el('input', 'settings-panel__input stash-settings__input');
    key.id = 'sp-stash-key';
    key.type = 'password';
    key.autocomplete = 'off';
    key.spellcheck = false;
    key.dataset.stashFocus = 'key';
    key.setAttribute('aria-describedby', 'sp-stash-key-hint sp-stash-key-note');
    this._keyInput = key;
    const saved = el('div', 'stash-settings__key-saved');
    this._setupKeyText = el('span', 'stash-settings__key-text');
    const replace = button(t('settingsPanel.stash.replaceKey'), {
      focusKey: 'key-replace',
      onClick: () => { this._replacingKey = true; this._updateSetup(); this._focus('key'); },
    });
    const remove = button(t('settingsPanel.stash.removeKey'), { focusKey: 'key-remove', onClick: () => this._removeKey() });
    saved.append(this._setupKeyText, replace, remove);
    this._setupKeySaved = saved;
    keyBox.append(key, saved);
    keyField.append(keyLabel, keyBox);
    view.appendChild(keyField);
    const keyHint = el('p', 'settings-panel__hint stash-settings__key-hint', t('settingsPanel.stash.keyHint'));
    keyHint.id = 'sp-stash-key-hint';
    view.appendChild(keyHint);
    this._keyNoteEl = el('p', 'stash-settings__note');
    this._keyNoteEl.id = 'sp-stash-key-note';
    view.appendChild(this._keyNoteEl);

    // Test connection, its result (polite) and the trust step.
    const testRow = el('div', 'stash-settings__actions');
    const test = button(t('settingsPanel.stash.test'), { focusKey: 'test', onClick: () => this._runTest() });
    this._testBtn = test;
    testRow.appendChild(test);
    view.appendChild(testRow);
    this._testResultEl = el('p', 'stash-settings__result');
    this._testResultEl.setAttribute('role', 'status');
    this._testResultEl.setAttribute('aria-live', 'polite');
    view.appendChild(this._testResultEl);
    this._setupCertEl = el('div', 'stash-settings__cert-slot');
    view.appendChild(this._setupCertEl);
    this._clearWarnEl = el('p', 'stash-settings__note stash-settings__note--warn');
    this._clearWarnEl.hidden = true;
    view.appendChild(this._clearWarnEl);

    // Dave's help line: keep Stash on this PC, or set a password.
    const help = el('p', 'stash-settings__help', t('settingsPanel.stash.help'));
    help.id = 'sp-stash-help';
    view.appendChild(help);

    const linkRow = el('div', 'stash-settings__actions');
    const link = button(t('settingsPanel.stash.link'), { className: 'stash-settings__btn--primary', focusKey: 'link', onClick: () => this._runLink() });
    this._linkBtn = link;
    linkRow.appendChild(link);
    if (this._changing) {
      linkRow.appendChild(button(t('common.cancel'), {
        focusKey: 'change-cancel',
        onClick: () => { this._leaveChange(); this._switchMode('change'); },
      }));
    }
    view.appendChild(linkRow);
    const linkHint = el('p', 'settings-panel__hint stash-settings__link-hint', t('settingsPanel.stash.linkNeedsTest'));
    linkHint.id = 'sp-stash-link-hint';
    this._linkHintEl = linkHint;
    view.appendChild(linkHint);

    const onEdit = () => {
      // A Test answers for the address and key it was given; anything typed
      // since needs a new one.
      if (this._tested && !this._testedMatches()) {
        this._tested = null;
        this._certOffer = null;
        this._testResultEl.textContent = '';
        this._clearWarnEl.hidden = true;
      }
      this._updateSetup();
    };
    addr.addEventListener('input', onEdit);
    key.addEventListener('input', onEdit);
    addr.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this._runTest(); } });
    key.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this._runTest(); } });

    this._viewEl.appendChild(view);
  }

  _leaveChange() {
    this._changing = false;
    this._replacingKey = false;
    this._tested = null;
    this._certOffer = null;
  }

  _typed() {
    return {
      address: (this._addrInput?.value || '').trim(),
      key: this._keyInputShown() ? (this._keyInput?.value || '') : '',
    };
  }

  _keyInputShown() {
    const s = this._status;
    return this._replacingKey || !s.hasKey || s.keyUnreadable;
  }

  _testedMatches() {
    const now = this._typed();
    return !!this._tested && this._tested.address === now.address && this._tested.key === now.key;
  }

  _updateSetup() {
    const s = this._status;
    const showInput = this._keyInputShown();
    this._keyInput.hidden = !showInput;
    this._setupKeySaved.hidden = showInput;
    this._setupKeyText.textContent = this._keyLineText();
    const note = this._keyNoteText();
    this._keyNoteEl.textContent = showInput ? note : '';
    this._keyNoteEl.hidden = !showInput || !note;
    if (showInput && s.keyUnreadable) {
      this._keyNoteEl.textContent = [t('stash.error.keyUnreadable'), note].filter(Boolean).join(' ');
      this._keyNoteEl.hidden = false;
    }

    const { address } = this._typed();
    this._setupPinEl.replaceChildren();
    const pinRow = this._buildPinRow(address);
    if (pinRow) this._setupPinEl.appendChild(pinRow);

    this._setupCertEl.replaceChildren();
    if (this._certOffer && stashOrigin(this._certOffer.address) === stashOrigin(address)) {
      // Trusted: Test again at once, from the Test button (the box goes).
      this._setupCertEl.appendChild(this._buildCertOffer(this._certOffer, {
        onTrusted: () => { this._focus('test'); this._runTest(); },
      }));
    }

    // Link needs a good Test of exactly what is typed now. While a call runs
    // the buttons say so with aria-disabled (a disabled button drops focus).
    const ready = !!this._tested?.ok && this._testedMatches();
    this._linkBtn.disabled = !ready;
    if (ready) this._linkBtn.removeAttribute('aria-describedby');
    else this._linkBtn.setAttribute('aria-describedby', 'sp-stash-link-hint');
    this._linkHintEl.hidden = ready;
    this._linkBtn.setAttribute('aria-disabled', this._busy ? 'true' : 'false');
    this._testBtn.setAttribute('aria-disabled', this._busy ? 'true' : 'false');
  }

  async _runTest() {
    if (this._busy || this._mode !== 'setup') return;
    const typed = this._typed();
    if (!typed.address) {
      this._testResultEl.textContent = t('stash.error.badAddress');
      return;
    }
    this._busy = 'test';
    this._certOffer = null;
    this._clearWarnEl.hidden = true;
    this._testResultEl.textContent = t('settingsPanel.stash.testing');
    this._updateSetup();
    let reply = null;
    try {
      reply = await this._api.test({ address: typed.address, ...(typed.key ? { apiKey: typed.key } : {}) });
    } catch (err) {
      console.warn('[Stash] test failed:', err?.message || err);
      reply = { ok: false, code: 'unreachable' };
    }
    this._busy = null;
    if (this._destroyed) return;
    if (!reply) reply = { ok: false, code: 'badInput' };
    const ok = reply.ok === true;
    this._tested = { ...typed, ok, reply };
    if (ok) {
      const count = num(reply.sceneCount) ?? num(reply.scenes) ?? 0;
      const version = versionText(reply.version) || '?';
      this._testResultEl.textContent = t('settingsPanel.stash.connected', { version, count });
      this._testResultEl.classList.remove('stash-settings__result--error');
      this._testResultEl.classList.add('stash-settings__result--ok');
    } else {
      this._testResultEl.textContent = stashErrorText(reply, typed.address);
      this._testResultEl.classList.remove('stash-settings__result--ok');
      this._testResultEl.classList.add('stash-settings__result--error');
      const cert = (reply.code === 'certificate' || reply.error?.code === 'certificate')
        ? normalizeCertificate(reply.certificate || reply.error?.certificate) : null;
      if (cert) this._certOffer = { certificate: cert, address: typed.address };
    }
    if (reply.keyTravelsInClear === true) {
      this._clearWarnEl.textContent = t('settingsPanel.stash.keyInClear', { host: hostOf(typed.address) });
      this._clearWarnEl.hidden = false;
    }
    this._updateSetup();
  }

  async _runLink() {
    if (this._busy || !this._tested?.ok || !this._testedMatches()) return;
    const typed = this._typed();
    this._busy = 'link';
    this._updateSetup();
    let reply = null;
    try {
      reply = await this._api.link({ address: typed.address, ...(typed.key ? { apiKey: typed.key } : {}) });
    } catch (err) {
      console.warn('[Stash] link failed:', err?.message || err);
      reply = { ok: false, code: 'badInput' };
    }
    this._busy = null;
    if (this._destroyed) return;
    if (!reply || reply.ok !== true) {
      this._testResultEl.textContent = stashErrorText(reply || { code: 'badInput' }, typed.address);
      this._testResultEl.classList.add('stash-settings__result--error');
      this._updateSetup();
      return;
    }
    // Main saved the address, the on switch and the key (never sent back):
    // clear what was typed and show the linked view, on Sync now.
    if (this._keyInput) this._keyInput.value = '';
    this._leaveChange();
    this._linkedVersion = {
      url: str(reply.settings?.url) || str(reply.address) || typed.address,
      version: str(reply.version),
    };
    this._say(t('settingsPanel.stash.linkedDone'));
    this._focusAfterSwitch = 'sync';
    if (isObj(reply.settings)) this._applySavedStash(reply.settings);
    else {
      // A reply without the saved block: the plain writes main also accepts.
      this._settings.set('stash.url', str(reply.address) || typed.address);
      this._settings.set('stash.enabled', true);
    }
    this._render();
    await this.refresh();
  }

  // ---- linked ----

  _buildLinked() {
    const view = el('div', 'stash-settings__linked');

    const head = el('div', 'stash-settings__row');
    this._linkedTextEl = el('span', 'stash-settings__linked-text');
    const change = button(t('settingsPanel.stash.change'), {
      focusKey: 'change',
      onClick: () => { this._changing = true; this._replacingKey = false; this._switchMode('address'); },
    });
    const off = button(t('settingsPanel.stash.turnOff'), {
      focusKey: 'turn-off',
      // Off hides everything Stash and keeps the data (design (a) 10).
      onClick: async () => {
        if (await this._setOptions({ enabled: false }, 'turn-on')) this._say(t('settingsPanel.stash.turnedOff'));
      },
    });
    this._changeBtn = change;
    this._turnOffBtn = off;
    head.append(this._linkedTextEl, el('span', 'stash-settings__spacer'), change, off);
    view.appendChild(head);

    const keyRow = el('div', 'stash-settings__row');
    this._linkedKeyText = el('span', 'stash-settings__key-text');
    const replace = button(t('settingsPanel.stash.replaceKey'), {
      focusKey: 'key-replace',
      onClick: () => { this._changing = true; this._replacingKey = true; this._switchMode('key'); },
    });
    const remove = button(t('settingsPanel.stash.removeKey'), { focusKey: 'key-remove', onClick: () => this._removeKey() });
    const add = button(t('settingsPanel.stash.addKey'), {
      focusKey: 'key-add',
      onClick: () => { this._changing = true; this._replacingKey = true; this._switchMode('key'); },
    });
    this._linkedKeyBtns = { replace, remove, add };
    keyRow.append(this._linkedKeyText, el('span', 'stash-settings__spacer'), replace, remove, add);
    view.appendChild(keyRow);

    this._linkedPinEl = el('div', 'stash-settings__pin-slot');
    view.appendChild(this._linkedPinEl);
    this._linkedWarnEl = el('p', 'stash-settings__note stash-settings__note--warn');
    view.appendChild(this._linkedWarnEl);

    this._lastSyncEl = el('p', 'stash-settings__last');
    view.appendChild(this._lastSyncEl);

    // Sync now, or (while a sync runs) the progress, its step and Cancel.
    const syncArea = el('div', 'stash-settings__sync');
    const syncBtn = button(t('settingsPanel.stash.syncNow'), { className: 'stash-settings__btn--primary', focusKey: 'sync', onClick: () => this._runSync() });
    const progressBox = el('div', 'stash-settings__progress');
    const progLabel = el('label', 'stash-settings__progress-label', t('settingsPanel.stash.progressLabel'));
    progLabel.id = 'sp-stash-progress-label';
    const progress = el('progress', 'stash-settings__progress-bar');
    progress.id = 'sp-stash-progress';
    progLabel.htmlFor = progress.id;
    progress.setAttribute('aria-labelledby', progLabel.id);
    progress.setAttribute('aria-describedby', 'sp-stash-step');
    const step = el('p', 'stash-settings__step');
    step.id = 'sp-stash-step';
    const cancel = button(t('common.cancel'), { focusKey: 'sync-cancel', onClick: () => this._cancelSync() });
    progressBox.append(progLabel, progress, step, cancel);
    syncArea.append(syncBtn, progressBox);
    this._syncBtn = syncBtn;
    this._progressBox = progressBox;
    this._progressEl = progress;
    this._stepEl = step;
    this._cancelBtn = cancel;
    view.appendChild(syncArea);
    this._syncCertEl = el('div', 'stash-settings__cert-slot');
    view.appendChild(this._syncCertEl);

    // Sync with Stash when FunSync starts (off by default).
    const startField = el('div', 'settings-panel__field stash-settings__start');
    const startLabel = el('label', 'settings-panel__field-label', t('settingsPanel.stash.syncOnStart'));
    startLabel.htmlFor = 'sp-stash-sync-on-start';
    const start = el('input', 'settings-panel__input settings-panel__input--checkbox');
    start.type = 'checkbox';
    start.id = 'sp-stash-sync-on-start';
    start.dataset.stashFocus = 'sync-on-start';
    start.checked = this._settings.get('stash.syncOnStart') === true;
    start.setAttribute('aria-describedby', 'sp-stash-sync-on-start-hint');
    start.addEventListener('change', async () => {
      const want = !!start.checked;
      if (!(await this._setOptions({ syncOnStart: want })) && !this._destroyed) start.checked = !want;
    });
    startField.append(startLabel, start);
    view.appendChild(startField);
    const startHint = el('p', 'settings-panel__hint', t('settingsPanel.stash.syncOnStartHint'));
    startHint.id = 'sp-stash-sync-on-start-hint';
    view.appendChild(startHint);

    // Use Stash's tag aliases and sub-tags (Stash "next" lot, sn-tags; Dave:
    // an opt-in, off by default). Until it is ticked nothing about tags
    // changes; unticked again, every tag shows as it did before.
    const rulesField = el('div', 'settings-panel__field stash-settings__tag-rules');
    const rulesLabel = el('label', 'settings-panel__field-label', t('settingsPanel.stash.useTagRules'));
    rulesLabel.htmlFor = 'sp-stash-use-tag-rules';
    const rules = el('input', 'settings-panel__input settings-panel__input--checkbox');
    rules.type = 'checkbox';
    rules.id = 'sp-stash-use-tag-rules';
    rules.dataset.stashFocus = 'use-tag-rules';
    rules.checked = this._stashSetting('useTagRules') === true;
    rules.setAttribute('aria-describedby', 'sp-stash-use-tag-rules-hint');
    rules.addEventListener('change', async () => {
      const want = !!rules.checked;
      this._tagRulesBusy = true;
      let ok = false;
      try { ok = await this._setOptions({ useTagRules: want }); } finally { this._tagRulesBusy = false; }
      if (!this._destroyed) rules.checked = ok ? want : !want;
    });
    this._tagRulesBox = rules;
    rulesField.append(rulesLabel, rules);
    view.appendChild(rulesField);
    const rulesHint = el('p', 'settings-panel__hint', t('settingsPanel.stash.useTagRulesHint'));
    rulesHint.id = 'sp-stash-use-tag-rules-hint';
    view.appendChild(rulesHint);

    // Need a check: one row per video, with Choose….
    this._checksEl = el('div', 'stash-settings__checks');
    view.appendChild(this._checksEl);
    // Re-linked: this session's re-links by a full sync, with Undo each.
    this._relinksEl = el('div', 'stash-settings__checks stash-settings__relinks');
    view.appendChild(this._relinksEl);

    view.appendChild(this._buildPathRules());

    const removeRow = el('div', 'stash-settings__actions');
    this._removeBtn = button(t('settingsPanel.stash.remove'), { className: 'stash-settings__btn--danger', focusKey: 'remove', onClick: () => this._runRemove() });
    removeRow.appendChild(this._removeBtn);
    view.appendChild(removeRow);

    this._viewEl.appendChild(view);
  }

  _updateLinked() {
    const s = this._status;
    const url = this._url();
    // The version the last sync saw, or (before one) the one Link just met.
    const lv = this._linkedVersion;
    const version = (s.serverUrl && sameStashAddress(s.serverUrl, url) ? versionText(s.version) : null)
      || (lv && sameStashAddress(lv.url, url) ? versionText(lv.version) : null);
    this._linkedTextEl.textContent = version
      ? t('settingsPanel.stash.linkedVersion', { address: url, version })
      : t('settingsPanel.stash.linked', { address: url });

    this._linkedKeyText.textContent = this._keyLineText();
    const { replace, remove, add } = this._linkedKeyBtns;
    replace.hidden = !s.hasKey && !s.keyUnreadable;
    remove.hidden = !s.hasKey && !s.keyUnreadable;
    add.hidden = s.hasKey || s.keyUnreadable;

    this._linkedPinEl.replaceChildren();
    const pinRow = this._buildPinRow(url);
    if (pinRow) this._linkedPinEl.appendChild(pinRow);

    this._linkedWarnEl.hidden = !s.keyTravelsInClear;
    this._linkedWarnEl.textContent = s.keyTravelsInClear ? t('settingsPanel.stash.keyInClear', { host: hostOf(url) }) : '';

    this._lastSyncEl.textContent = this._lastSyncText();

    // The saved opt-in (main may report a change), unless a write is on its way.
    if (this._tagRulesBox && !this._tagRulesBusy) this._tagRulesBox.checked = this._stashSetting('useTagRules') === true;

    this._updateSyncArea();

    this._syncCertEl.replaceChildren();
    if (this._certOffer && stashOrigin(this._certOffer.address) === stashOrigin(url)) {
      this._syncCertEl.appendChild(this._buildCertOffer(this._certOffer, { onTrusted: () => this._focus('sync') }));
    }

    this._renderChecks();
    this._renderRelinks();
  }

  _lastSyncText() {
    const ls = this._status.lastSync;
    if (!ls || !Number.isFinite(ls.at)) return t('settingsPanel.stash.neverSynced');
    const line = t('settingsPanel.stash.lastSync', { date: formatWhen(ls.at), counts: countParts(ls.counts) });
    return ls.partial ? `${line} ${t('settingsPanel.stash.lastSyncPartial')}` : line;
  }

  _updateSyncArea() {
    const running = !!this._sync;
    const hadFocus = document.activeElement;
    this._syncBtn.hidden = running;
    this._progressBox.hidden = !running;
    if (running) {
      const total = num(this._sync.total) ?? 0;
      if (total > 0) {
        this._progressEl.max = total;
        this._progressEl.value = Math.min(num(this._sync.done) ?? 0, total);
      } else {
        this._progressEl.removeAttribute('value');
      }
      this._stepEl.textContent = this._sync.cancelling ? t('settingsPanel.stash.cancelling') : syncStepText(this._sync);
    }
    for (const b of [this._changeBtn, this._turnOffBtn, this._removeBtn]) if (b) b.disabled = running;
    // A control that went away hands focus to the one that took its place.
    if (running && hadFocus === this._syncBtn) this._cancelBtn.focus();
    if (!running && hadFocus === this._cancelBtn) this._syncBtn.focus();
  }

  /**
   * Main's progress reports (throttled): {kind, step, done, total}, and at
   * the end {kind, step: 'finished', result}. A sync this block started
   * reports its result when its call resolves; one started elsewhere (Sync
   * with Stash when FunSync starts) reports it here.
   */
  _onProgress(p) {
    if (this._destroyed || !isObj(p)) return;
    if (p.kind === 'video') return; // "Sync this video" belongs to the dialog
    if (p.step === 'finished') {
      if (this._sync?.elsewhere) {
        this._sync = null;
        this._finishSync(p.result);
        this.refresh();
      }
      return;
    }
    const cancelling = !!this._sync?.cancelling;
    this._sync = { ...(this._sync || { elsewhere: true }), step: str(p.step), done: num(p.done) ?? 0, total: num(p.total) ?? 0, cancelling };
    if (this._mode === 'linked') this._updateSyncArea();
  }

  async _runSync() {
    if (this._sync || this._mode !== 'linked') return;
    this._sync = { step: null, done: 0, total: 0, cancelling: false };
    this._certOffer = null;
    this._say(t('settingsPanel.stash.syncing'));
    this._updateLinked();
    let result = null;
    try {
      let videos = [];
      try { videos = stashSyncVideoList(this._getVideos()); } catch { videos = []; }
      result = await this._api.sync({ videos });
    } catch (err) {
      console.warn('[Stash] sync failed:', err?.message || err);
      result = { ok: false, error: { code: 'badInput' } };
    }
    // Its re-links are kept for this session even when Settings closed
    // meanwhile: the next Settings lists them with their Undo (RA-S1-1).
    const relinked = this._noteRelinks(result);
    if (this._destroyed) return;
    this._sync = null;
    this._finishSync(result, relinked);
    await this.refresh();
  }

  /**
   * A finished sync: its result line, and the trust step when it met an
   * untrusted certificate. A full sync that re-linked videos to a new unique
   * match (scenes merged in Stash, a changed file; design (b) "Gone",
   * "Changed") says so, with one Undo for them all here and one per video
   * in the Re-linked list (s1-review-a RA-S1-1).
   */
  _finishSync(result, relinked = this._noteRelinks(result)) {
    this._syncResult = result;
    const moved = Array.isArray(relinked) ? relinked : [];
    let text = this._syncResultText(result);
    if (moved.length > 0) text = `${text} ${t('settingsPanel.stash.syncRelinked', { count: moved.length })}`;
    this._say(text, moved.length > 0 && this._api.has('undo') ? {
      run: () => this._undoRelinks(moved),
      ms: REMOVE_UNDO_MS,
      ariaLabel: t('settingsPanel.stash.undoRelinksAria', { count: moved.length }),
      doneText: t('settingsPanel.stash.relinksUndone', { count: moved.length }),
      failText: t('settingsPanel.stash.relinksUndonePartial', { done: 0, total: moved.length }),
      relinkIds: moved.map((e) => e.undoId),
    } : null);
    const err = isObj(result?.error) ? result.error : null;
    const cert = (err?.code === 'certificate' || result?.code === 'certificate')
      ? normalizeCertificate(err?.certificate || result?.certificate) : null;
    if (cert) this._certOffer = { certificate: cert, address: this._url() };
    if (this._mode === 'linked') this._updateLinked();
  }

  _syncResultText(result) {
    if (!isObj(result)) return t('settingsPanel.stash.syncFailed', { reason: t('stash.error.badInput') });
    const code = str(result.error?.code) || str(result.code);
    if (result.cancelled === true || code === 'cancelled') return t('settingsPanel.stash.syncCancelled');
    if (result.ok === true) return t('settingsPanel.stash.syncDone', { counts: countParts(result.counts, { videos: true }) });
    const reason = stashErrorText(result.error || result, this._url());
    if (result.written === true && result.partial === true) {
      const d = isObj(result.details) ? result.details : {};
      return t('settingsPanel.stash.syncPartial', { done: num(d.done) ?? 0, total: num(d.total) ?? 0, reason });
    }
    return t('settingsPanel.stash.syncFailed', { reason });
  }

  async _cancelSync() {
    if (!this._sync || this._sync.cancelling) return;
    this._sync.cancelling = true;
    this._updateSyncArea();
    try { await this._api.cancelSync(); } catch (err) { console.warn('[Stash] cancel failed:', err?.message || err); }
  }

  // ---- Need a check ----

  _checkEntries() {
    const check = isObj(this._data?.check) ? this._data.check : {};
    return Object.entries(check)
      .filter(([, c]) => isObj(c))
      .map(([path, c]) => ({ path, name: fileName(path), kind: c.kind, count: Array.isArray(c.sceneIds) ? c.sceneIds.length : 0 }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  }

  _renderChecks() {
    const box = this._checksEl;
    const focusKey = box.contains(document.activeElement) ? document.activeElement.dataset.stashFocus : null;
    box.replaceChildren();
    const rows = this._checkEntries();
    box.hidden = rows.length === 0;
    if (rows.length === 0) return;
    const head = el('h3', 'stash-settings__subhead', t('settingsPanel.stash.checkHeader', { count: rows.length }));
    head.id = 'sp-stash-checks-title';
    box.appendChild(head);
    const list = el('ul', 'stash-settings__check-list');
    list.setAttribute('aria-labelledby', head.id);
    const shown = this._showAllChecks ? rows : rows.slice(0, CHECK_ROWS_SHOWN);
    shown.forEach((r, i) => {
      const li = el('li', 'stash-settings__check-row');
      const name = el('span', 'stash-settings__check-name', r.name);
      name.title = r.path;
      const reason = el('span', 'stash-settings__check-reason', r.kind === 'pathChanged'
        ? t('settingsPanel.stash.checkPathChanged')
        : t('settingsPanel.stash.checkSeveral', { count: Math.max(2, r.count) }));
      li.append(name, reason);
      if (this._onOpenCheck) {
        li.appendChild(button(t('settingsPanel.stash.choose'), {
          focusKey: `check-${i}`,
          ariaLabel: t('settingsPanel.stash.chooseAria', { name: r.name }),
          onClick: () => {
            this._closeSettings?.();
            this._onOpenCheck(r.path);
          },
        }));
      }
      list.appendChild(li);
    });
    box.appendChild(list);
    if (!this._showAllChecks && rows.length > CHECK_ROWS_SHOWN) {
      box.appendChild(button(t('settingsPanel.stash.showAll', { count: rows.length }), {
        focusKey: 'checks-all',
        onClick: () => {
          this._showAllChecks = true;
          this._renderChecks();
          this._focus(`check-${CHECK_ROWS_SHOWN}`);
        },
      }));
    }
    if (focusKey) this._focus(focusKey);
  }

  // ---- Re-linked (s1-review-a RA-S1-1) ----
  //
  // A full sync's re-links (Sync now, or the start-up sync, which runs with
  // Settings closed) wait here for the session, with main's Undo token each:
  // the same place as Need a check, the list of what a sync wants you to
  // look at. A toast would be gone before anyone saw the start-up sync's.

  _listenRelinks() {
    let off = null;
    try { off = this._relinks.onChanged?.(() => this._onRelinksChanged()); } catch { off = null; }
    return typeof off === 'function' ? off : () => {};
  }

  _onRelinksChanged() {
    if (this._destroyed) return;
    // The live line's Undo for a sync's re-links goes once none of them is left.
    const ids = this._pendingUndo?.relinkIds;
    if (Array.isArray(ids)) {
      const live = new Set(this._relinkList().map((e) => e.undoId));
      if (!ids.some((id) => live.has(id))) this._clearUndo();
    }
    if (this._mode === 'linked') this._renderRelinks();
  }

  /** Keep a sync reply's re-links (the session's list); the ones of this reply, each with its Undo token. */
  _noteRelinks(result) {
    try {
      const out = this._relinks.note?.(result);
      return Array.isArray(out) ? out : [];
    } catch {
      return [];
    }
  }

  _relinkList() {
    try {
      const out = this._relinks.list?.();
      return Array.isArray(out) ? out : [];
    } catch {
      return [];
    }
  }

  /**
   * The rows: only while the video is still linked to the scene the sync
   * chose, so an Undo puts back exactly what that sync replaced and never
   * undoes a later change (a link you made since, another sync).
   */
  _relinkRows() {
    const links = isObj(this._data?.links) ? this._data.links : null;
    return this._relinkList()
      .filter((e) => {
        if (!links) return true;
        const link = links[e.path];
        return isObj(link) && (e.to == null || String(link.sceneId) === e.to);
      })
      .map((e) => ({ ...e, name: fileName(e.path) }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  }

  _renderRelinks() {
    const box = this._relinksEl;
    if (!box) return;
    const focusKey = box.contains(document.activeElement) ? document.activeElement.dataset.stashFocus : null;
    box.replaceChildren();
    const rows = this._relinkRows();
    box.hidden = rows.length === 0;
    if (rows.length === 0) return;
    const head = el('h3', 'stash-settings__subhead', t('settingsPanel.stash.relinkHeader', { count: rows.length }));
    head.id = 'sp-stash-relinks-title';
    box.appendChild(head);
    box.appendChild(el('p', 'settings-panel__hint', t('settingsPanel.stash.relinkHint')));
    const list = el('ul', 'stash-settings__check-list');
    list.setAttribute('aria-labelledby', head.id);
    const scenes = isObj(this._data?.scenes) ? this._data.scenes : {};
    const shown = this._showAllRelinks ? rows : rows.slice(0, CHECK_ROWS_SHOWN);
    shown.forEach((r, i) => {
      const li = el('li', 'stash-settings__check-row stash-settings__relink-row');
      const name = el('span', 'stash-settings__check-name', r.name);
      name.title = r.path;
      const scene = r.to != null && Object.prototype.hasOwnProperty.call(scenes, r.to) ? scenes[r.to] : null;
      const title = isObj(scene) ? str(scene.title) : null;
      const reason = el('span', 'stash-settings__check-reason', title
        ? t('settingsPanel.stash.relinkTo', { name: t('videoOptions.stash.sceneTitle', { title }) })
        : t('settingsPanel.stash.relinkToUntitled'));
      const undo = button(t('toast.undo'), {
        focusKey: `relink-${i}`,
        ariaLabel: t('settingsPanel.stash.relinkUndoAria', { name: r.name }),
        onClick: () => this._undoRelinkRows([r], `relink-${i}`),
      });
      undo.disabled = this._relinkBusy;
      li.append(name, reason, undo);
      list.appendChild(li);
    });
    box.appendChild(list);
    const tail = el('div', 'stash-settings__actions');
    if (!this._showAllRelinks && rows.length > CHECK_ROWS_SHOWN) {
      tail.appendChild(button(t('settingsPanel.stash.showAll', { count: rows.length }), {
        focusKey: 'relinks-show-all',
        onClick: () => {
          this._showAllRelinks = true;
          this._renderRelinks();
          this._focus(`relink-${CHECK_ROWS_SHOWN}`);
        },
      }));
    }
    if (rows.length > 1) {
      const all = button(t('settingsPanel.stash.relinkUndoAll'), {
        focusKey: 'relinks-undo-all',
        ariaLabel: t('settingsPanel.stash.relinkUndoAllAria', { count: rows.length }),
        onClick: () => this._undoRelinkRows(rows, 'relinks-undo-all'),
      });
      all.disabled = this._relinkBusy;
      tail.appendChild(all);
    }
    if (tail.childElementCount > 0) box.appendChild(tail);
    if (focusKey) this._focus(focusKey);
  }

  /**
   * Send each re-link's Undo token to main, one after the other. Undone
   * and expired ones leave the list. Answers `{ok, text}` (the live line's
   * words; `_runUndo` and its toast read them).
   */
  async _undoRelinks(entries) {
    const live = new Set(this._relinkList().map((e) => e.undoId));
    const todo = (Array.isArray(entries) ? entries : []).filter((e) => live.has(e.undoId));
    let done = 0;
    const forget = [];
    for (const e of todo) {
      let reply = null;
      try { reply = await this._api.undo(e.undoId); } catch (err) { console.warn('[Stash] undo failed:', err?.message || err); }
      if (reply && reply.ok === true) {
        done += 1;
        forget.push(e.undoId);
      } else if (reply && reply.code === 'expired') {
        forget.push(e.undoId); // main no longer has it: it can never be undone
      }
    }
    if (forget.length > 0) {
      try { this._relinks.forget?.(forget); } catch { /* the rows go with the next status */ }
    }
    const total = todo.length;
    if (total === 1) {
      const name = fileName(todo[0].path);
      return done === 1
        ? { ok: true, text: t('settingsPanel.stash.relinkUndone', { name }) }
        : { ok: false, text: t('settingsPanel.stash.relinkUndoFailed', { name }) };
    }
    if (done === total) return { ok: true, text: t('settingsPanel.stash.relinksUndone', { count: done }) };
    return { ok: false, text: t('settingsPanel.stash.relinksUndonePartial', { done, total }) };
  }

  /** A row's Undo, or Undo all: then the row that took its place (or Sync now) gets focus. */
  async _undoRelinkRows(entries, focusKey) {
    if (this._relinkBusy || !this._api.has('undo')) return;
    this._relinkBusy = true;
    this._renderRelinks();
    let res = null;
    try { res = await this._undoRelinks(entries); } finally { this._relinkBusy = false; }
    if (this._destroyed) return;
    this._say(res?.text || '');
    await this.refresh();
    if (this._destroyed) return;
    const target = this.el.querySelector(`[data-stash-focus="${focusKey}"]`);
    if (target && !target.hidden && !target.disabled) target.focus();
    else this._focus('relink-0');
    if (!this._relinksEl?.contains(document.activeElement)) this._focusFirstAction();
  }

  // ---- path rules (advanced, collapsed) ----

  _buildPathRules() {
    const details = el('details', 'stash-settings__rules');
    const summary = el('summary', 'stash-settings__rules-summary', t('settingsPanel.stash.pathRules'));
    summary.dataset.stashFocus = 'rules';
    details.appendChild(summary);
    details.appendChild(el('p', 'settings-panel__hint', t('settingsPanel.stash.pathRulesHint')));
    const list = el('div', 'stash-settings__rule-list');
    details.appendChild(list);
    const incomplete = el('p', 'stash-settings__note stash-settings__note--warn', t('settingsPanel.stash.ruleIncomplete'));
    incomplete.hidden = true;
    details.appendChild(incomplete);

    const save = () => {
      const rules = [];
      let partial = false;
      for (const row of list.children) {
        const local = row.querySelector('[data-rule="local"]').value.trim();
        const stash = row.querySelector('[data-rule="stash"]').value.trim();
        if (local && stash) rules.push({ local, stash });
        else if (local || stash) partial = true;
      }
      incomplete.hidden = !partial;
      const before = JSON.stringify(this._settings.get('stash.pathRules') || []);
      if (JSON.stringify(rules) !== before) this._setOptions({ pathRules: rules });
    };

    let seq = 0;
    const addRow = (rule = { local: '', stash: '' }) => {
      const n = ++seq;
      const row = el('div', 'stash-settings__rule');
      const mk = (which, value) => {
        const id = `sp-stash-rule-${which}-${n}`;
        const wrap = el('div', 'stash-settings__rule-field');
        const label = el('label', 'stash-settings__rule-label', t(which === 'local' ? 'settingsPanel.stash.ruleLocal' : 'settingsPanel.stash.ruleStash'));
        label.htmlFor = id;
        const input = el('input', 'settings-panel__input stash-settings__input');
        input.id = id;
        input.type = 'text';
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.dataset.rule = which;
        input.placeholder = which === 'local' ? '\\\\NAS\\videos' : '/data/videos';
        input.value = typeof value === 'string' ? value : '';
        input.addEventListener('change', save);
        wrap.append(label, input);
        return wrap;
      };
      row.append(mk('local', rule.local), el('span', 'stash-settings__rule-arrow', '⇄'), mk('stash', rule.stash));
      row.querySelector('.stash-settings__rule-arrow').setAttribute('aria-hidden', 'true');
      const localInput = row.querySelector('[data-rule="local"]');
      const rmName = () => t('settingsPanel.stash.removeRuleAria', { folder: localInput.value.trim() || t('settingsPanel.stash.ruleLocal') });
      const rm = button(t('settingsPanel.stash.removeRule'), {
        className: 'stash-settings__rule-remove',
        ariaLabel: rmName(),
        onClick: () => {
          const next = row.nextElementSibling || row.previousElementSibling;
          row.remove();
          save();
          (next?.querySelector('.stash-settings__rule-remove') || addBtn).focus();
        },
      });
      localInput.addEventListener('input', () => rm.setAttribute('aria-label', rmName()));
      row.appendChild(rm);
      list.appendChild(row);
      return row;
    };

    const addBtn = button(t('settingsPanel.stash.addRule'), {
      focusKey: 'rule-add',
      onClick: () => { addRow().querySelector('input').focus(); },
    });
    details.appendChild(addBtn);

    const stored = this._settings.get('stash.pathRules');
    for (const r of Array.isArray(stored) ? stored : []) if (isObj(r)) addRow(r);
    return details;
  }

  // ---- off ----

  _buildOff() {
    const view = el('div', 'stash-settings__off');
    this._offTextEl = el('p', 'stash-settings__off-text');
    view.appendChild(this._offTextEl);
    const row = el('div', 'stash-settings__actions');
    row.appendChild(button(t('settingsPanel.stash.turnOn'), {
      className: 'stash-settings__btn--primary',
      focusKey: 'turn-on',
      onClick: async () => {
        // On shows the kept data again at once. No sync (design (a) 10).
        if (await this._setOptions({ enabled: true }, 'turn-off')) this._say(t('settingsPanel.stash.turnedOn'));
      },
    }));
    this._removeBtn = button(t('settingsPanel.stash.remove'), { className: 'stash-settings__btn--danger', focusKey: 'remove', onClick: () => this._runRemove() });
    row.appendChild(this._removeBtn);
    view.appendChild(row);
    this._viewEl.appendChild(view);
  }

  _updateOff() {
    this._offTextEl.textContent = t('settingsPanel.stash.offText', { address: this._url() });
  }

  // ---- Remove Stash data… (confirm, then Undo for 8 s) ----

  _linkCount() {
    const links = isObj(this._data?.links) ? Object.keys(this._data.links).length : null;
    return links ?? this._status.linkCount ?? 0;
  }

  async _runRemove() {
    if (this._sync) return;
    const hasKey = this._status.hasKey;
    const ok = await Modal.confirm(
      t('settingsPanel.stash.removeTitle'),
      t(hasKey ? 'settingsPanel.stash.removeConfirm' : 'settingsPanel.stash.removeConfirmNoKey', { count: this._linkCount() }),
      { confirmText: t('common.remove') },
    );
    if (!ok || this._destroyed) return;
    let reply = null;
    try { reply = await this._api.removeData(); } catch (err) { console.warn('[Stash] remove failed:', err?.message || err); }
    if (this._destroyed) return;
    if (!reply || reply.ok !== true) {
      this._say(t('settingsPanel.stash.removeFailed'));
      return;
    }
    // Main set the data file aside and removed the key; stashUndo(undoId)
    // within its window puts both back, exactly that token, once.
    const undoId = reply.undoId;
    const canUndo = (typeof undoId === 'string' || typeof undoId === 'number') && this._api.has('undo');
    const ms = num(reply.undoMs) && reply.undoMs > 0 ? Math.min(reply.undoMs, REMOVE_UNDO_MS) : REMOVE_UNDO_MS;
    this._say(t('settingsPanel.stash.removed'), canUndo ? {
      run: async () => {
        const r = await this._api.undo(undoId);
        // s1-fixup-main: data synced since the removal is kept with it.
        if (isObj(r) && r.ok === true && r.merged === true) return { ...r, text: t('settingsPanel.stash.removeUndoneMerged') };
        return r;
      },
      ms,
      ariaLabel: t('settingsPanel.stash.undoRemoveAria'),
      doneText: t('settingsPanel.stash.removeUndone'),
      failText: t('settingsPanel.stash.undoFailed'),
      // s1-fixup-main: a put-back that failed keeps the data aside, and the
      // same token may be tried again while its window lasts.
      retry: (reply) => isObj(reply) && reply.ok === false && reply.code !== 'expired',
      retryText: t('settingsPanel.stash.undoFailedKept'),
    } : null);
    await this.refresh();
    if (canUndo && !this._undoBtn.hidden) this._undoBtn.focus();
  }
}

function hostOf(address) {
  try { return new URL(address).hostname || address; } catch { return address; }
}
