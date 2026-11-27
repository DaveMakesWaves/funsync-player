// EroScriptsPanel — Search and download funscripts from discuss.eroscripts.com

import { icon, Search, X } from '../js/icons.js';
import { showToast } from '../js/toast.js';
import { t } from '../js/i18n.js';
import { recordDownloadTags, topicMetaOf } from '../js/script-tags.js';
import { createResultThumb } from './result-thumb.js';
import { joinPath, dirOfPath } from '../js/path-utils.js';
import { eventBus } from '../js/event-bus.js';
import { askReplaceFiles, forgetFetched } from './replace-question.js';
import { safeAttachmentName } from '../js/safe-file-name.js';
import { binOs } from '../js/recycle-bin.js';
import { eroscriptsErrorText } from '../js/eroscripts-error-text.js';
import { fewerWordsQuery } from '../js/search-name-clean.js';

// What main's session check can answer (EroScriptsAPI.checkSession).
const SESSION_STATES = new Set(['loggedOut', 'valid', 'expired', 'unknown']);

export class EroScriptsPanel {
  constructor({ settings }) {
    this._settings = settings;
    this._panel = null;
    this._visible = false;
    this._searching = false;
    this._loggedIn = false;
    // One expiry toast per dead session, not one per failed request.
    this._expiredNotified = false;
    this._username = '';
    // The signed-in user's picture (an https address, or ''), from the login
    // window or the login check (Dave, 2026-11-25: the tab's account button).
    this._avatar = '';
    // The login window is open (the auth button reads "Waiting for login").
    this._loginPending = false;
    // The expired session being dropped (forgetExpiredSession), shared.
    this._forgetting = null;
    // What the results area shows, so a language switch can paint it again:
    // { kind: 'placeholder' | 'searching' | 'noResults' | 'loginNeeded' |
    //   'error' | 'results', query?, results? }.
    this._resultsView = { kind: 'placeholder' };

    // Callbacks
    this.onScriptDownloaded = null;
    // Asked before a download writes anything: `true`, or a Promise<boolean>
    // (the app's unsaved-changes question). False/Cancel writes nothing.
    this.confirmBeforeDownload = null;
    // () => the open video's path, or null when no video is open (C-05). The
    // app answers: after the mini player's × or Back with the mini player
    // off, the video stays loaded and #player-container still names it, but
    // it is closed, so a download takes the Save dialog route, not
    // `<that video>.funscript` beside it. Unset: the container answers.
    this.getOpenVideoPath = null;
    this.onLoginStatusChanged = null; // (loggedIn, username) => {}
    // () => {}: the name, the picture or the login window's waiting changed
    // (the tab's account button repaints). One listener: the tab's.
    this.onProfileChanged = null;
    // (topic) => {}: a result's "Videos…" (the EroScripts tab, 2026-11-22). Unset: no button.
    this.onOpenPost = null;
    // Docked in the tab (2026-11-22): results go to the tab's cards instead
    // of this list ((results | null) => {}; null = a message took their
    // place), and the query sent may be decorated (the Free / Paid filter).
    this.onResults = null;
    this.onQueryCleared = null;
    this.queryDecorator = null;
    this._searchExtras = null;
    this._docked = false;

    this._createPanel();
    // Kept so a search right after launch waits for the saved login's
    // start-up check instead of asking to log in (2026-11-18).
    this._restoring = this._restoreSession().catch(() => { /* stays logged out */ });
  }

  get isLoggedIn() { return this._loggedIn; }

  _createPanel() {
    this._panel = document.createElement('div');
    this._panel.className = 'eroscripts-panel';
    this._panel.hidden = true;
    this._panel.setAttribute('role', 'dialog');
    this._panel.setAttribute('aria-modal', 'true');
    this._panel.setAttribute('aria-labelledby', 'eroscripts-panel__title');

    this._panel.innerHTML = `
      <div class="eroscripts-panel__header">
        <h2 id="eroscripts-panel__title" class="eroscripts-panel__title">${t('eroscripts.title')}</h2>
        <span class="eroscripts-panel__status" id="es-status"></span>
        <button class="eroscripts-panel__close" aria-label="${t('eroscripts.closeAria')}"></button>
      </div>

      <div class="eroscripts-panel__auth-bar" id="es-auth-bar">
        <span id="es-auth-label" class="eroscripts-panel__auth-label">${t('eroscripts.notLoggedIn')}</span>
        <button id="es-auth-btn" class="eroscripts-panel__btn eroscripts-panel__btn--secondary">${t('eroscripts.logIn')}</button>
      </div>

      <div class="eroscripts-panel__search">
        <div class="eroscripts-panel__input-row">
          <input type="text" id="es-search-input" class="eroscripts-panel__input eroscripts-panel__search-input" placeholder="${t('eroscripts.searchPlaceholder')}">
          <button id="es-search-btn" class="eroscripts-panel__btn">${t('eroscripts.search')}</button>
        </div>
      </div>

      <div class="eroscripts-panel__results" id="es-results">
        <div class="eroscripts-panel__placeholder">${t('eroscripts.placeholder')}</div>
      </div>
    `;

    document.getElementById('app').appendChild(this._panel);

    const closeBtn = this._panel.querySelector('.eroscripts-panel__close');
    closeBtn.appendChild(icon(X, { width: 16, height: 16 }));
    closeBtn.addEventListener('click', () => this.hide());

    // Auth button — opens the eroscripts login page in a child window
    // (real browser context, supports TOTP / backup codes / hardware keys).
    // ONE handler, swapped by _setLoggedIn / _setLoggedOut: a permanent login
    // listener here ran beside the Log Out one, so Log Out also opened the
    // login window, and Log In after it opened two (live, 2026-11-25; also in
    // v0.10.0). The leftover window held FunSync's quit for 30 s.
    this._panel.querySelector('#es-auth-btn').onclick = () => this._loginViaWindow();

    // Search
    this._panel.querySelector('#es-search-btn').addEventListener('click', () => this._search());
    // Emptied in the tab: its newest-scripts list comes back (2026-11-22).
    this._panel.querySelector('#es-search-input').addEventListener('input', (e) => {
      if (this._docked && !e.target.value.trim() && typeof this.onQueryCleared === 'function') {
        this._resultsView = { kind: 'placeholder' };
        this._panel.querySelector('#es-results')?.replaceChildren();
        this.onQueryCleared();
      }
    });
    this._panel.querySelector('#es-search-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._search();
    });

    // Every string here was drawn with t() once and never again, so a live
    // language switch left the whole panel in the old language until a
    // restart (app test V50). Same approach as NavBar._retranslate: redraw
    // in place from state, without rebuilding the panel.
    if (eventBus?.on) eventBus.on('language:changed', () => this._retranslate());
  }

  /**
   * Redraw every string in the active language from the panel's state: the
   * header, the search row, the auth bar (logged in, logged out, or waiting
   * on the login window), the results message, and each result card's
   * counts and buttons. Keeps the search text, the results and any open
   * attachment list. A failed search's message is painted again from its
   * error code (eroscripts-error-text.js); one with no known code keeps
   * main's own text.
   */
  _retranslate() {
    if (!this._panel) return;
    const title = this._panel.querySelector('#eroscripts-panel__title');
    if (title) title.textContent = t('eroscripts.title');
    this._panel.querySelector('.eroscripts-panel__close')?.setAttribute('aria-label', t('eroscripts.closeAria'));
    const input = this._panel.querySelector('#es-search-input');
    if (input) input.placeholder = t('eroscripts.searchPlaceholder');
    this._searchClear?.setAttribute('aria-label', t('library.clearSearchAria'));
    const searchBtn = this._panel.querySelector('#es-search-btn');
    if (searchBtn) searchBtn.textContent = t('eroscripts.search');

    const label = this._panel.querySelector('#es-auth-label');
    if (label && !this._loggedIn) label.textContent = t('eroscripts.notLoggedIn');
    const authBtn = this._panel.querySelector('#es-auth-btn');
    if (authBtn) {
      authBtn.textContent = this._loginPending ? t('eroscripts.waitingLogin')
        : this._loggedIn ? t('eroscripts.logOut') : t('eroscripts.logIn');
    }
    const status = this._panel.querySelector('#es-status');
    if (status && this._loggedIn) status.textContent = t('eroscripts.connected');

    const view = this._resultsView;
    if (view.kind === 'results') {
      const metas = this._panel.querySelectorAll('.eroscripts-panel__result-meta');
      metas.forEach((el, i) => { if (view.results[i]) el.textContent = this._metaText(view.results[i]); });
      for (const el of this._panel.querySelectorAll('#es-results [data-i18n-key]')) {
        el.textContent = t(el.dataset.i18nKey);
      }
    } else if (view.kind === 'error') {
      const el = this._panel.querySelector('#es-results .eroscripts-panel__placeholder--error');
      if (el && view.answer) el.textContent = eroscriptsErrorText(view.answer);
    } else {
      this._renderResultsMessage(view.kind, view.query);
    }
  }

  /**
   * Paint a message into the results area and remember which one, so
   * `_retranslate` can paint it again in a new language.
   * @param {'placeholder'|'searching'|'noResults'|'loginNeeded'} kind
   * @param {string} [query] — for noResults
   */
  _renderResultsMessage(kind, query = '') {
    const resultsEl = this._panel.querySelector('#es-results');
    if (!resultsEl) return;
    this._resultsView = { kind, query };
    if (this._docked && typeof this.onResults === 'function') {
      this.onResults(null, kind);
      // Docked, "search for a video name" is not shown: the tab lists the
      // newest scripts there instead.
      if (kind === 'placeholder') { resultsEl.replaceChildren(); return; }
    }
    if (kind === 'loginNeeded') {
      // Logged out, a search sends nothing and says so, with the login right
      // here (Dave, 2026-11-18: never a silent empty list).
      const box = document.createElement('div');
      box.className = 'eroscripts-panel__placeholder eroscripts-panel__login-needed';
      const text = document.createElement('div');
      text.textContent = t('eroscripts.loginToSearch');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'eroscripts-panel__btn eroscripts-panel__login-needed-btn';
      btn.textContent = this._loginPending ? t('eroscripts.waitingLogin') : t('eroscripts.logIn');
      btn.disabled = this._loginPending;
      btn.addEventListener('click', () => this._loginThenSearch());
      box.append(text, btn);
      resultsEl.replaceChildren(box);
    } else if (kind === 'searching') {
      resultsEl.innerHTML = `<div class="eroscripts-panel__placeholder">${t('eroscripts.searching')}</div>`;
    } else if (kind === 'noResults') {
      // No-results state with a "what to do next" hint (Nielsen #9 +
      // #10) — was a single line of text with no suggestion. The
      // placeholder--hint modifier styles the secondary line a touch
      // smaller / dimmer, mirroring the library / playlists pattern.
      resultsEl.innerHTML = `
        <div class="eroscripts-panel__placeholder">
          <div>${this._esc(t('eroscripts.noResultsTitle', { query }))}</div>
          <div class="eroscripts-panel__placeholder--hint">${t('eroscripts.noResultsHint')}</div>
        </div>`;
      // ONE "Search with fewer words" (Dave, 2026-11-18): the first few
      // meaningful words, searched once per press, never on its own.
      const fewer = fewerWordsQuery(query);
      if (fewer) {
        const box = resultsEl.querySelector('.eroscripts-panel__placeholder');
        box.classList.add('eroscripts-panel__no-results');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'eroscripts-panel__btn eroscripts-panel__btn--secondary eroscripts-panel__fewer-words';
        btn.textContent = t('eroscripts.fewerWords');
        btn.title = t('eroscripts.fewerWordsTitle', { query: fewer });
        btn.addEventListener('click', () => this._searchFewerWords(fewer));
        box.appendChild(btn);
      }
    } else {
      resultsEl.innerHTML = `<div class="eroscripts-panel__placeholder">${t('eroscripts.placeholder')}</div>`;
    }
  }

  /** Set a translated button label and stash its key for `_retranslate`. */
  _setLabel(el, key) {
    el.dataset.i18nKey = key;
    el.textContent = t(key);
  }

  _metaText(topic) {
    const parts = [];
    if (topic.creator) parts.push(`@${topic.creator}`);
    if (topic.likeCount > 0) parts.push(t('eroscripts.likes', { count: topic.likeCount }));
    if (topic.views > 0) parts.push(t('eroscripts.views', { count: topic.views }));
    return parts.join(' · ');
  }

  async _restoreSession() {
    const saved = this._settings.get('eroscripts.session');
    if (!saved || !saved.cookie || !saved.username) return;

    await window.funsync.eroscriptsRestoreSession(saved.cookie, saved.username);

    // Validate the session is still active
    const { valid } = await window.funsync.eroscriptsValidate();
    if (valid) {
      this._setLoggedIn(saved.username, saved.avatar);
    } else {
      // Session expired — clear it
      this._settings.set('eroscripts.session', null);
      await window.funsync.eroscriptsLogout();
      this._setLoggedOut();
      showToast(t('eroscripts.sessionExpired'), 'warn', 6000);
    }
  }

  _setLoggedIn(username, avatar = '') {
    this._loggedIn = true;
    // Fresh session — a future expiry should announce itself again.
    this._expiredNotified = false;
    // Another account keeps no picture of the last one.
    if (username !== this._username) this._avatar = '';
    if (typeof avatar === 'string' && avatar) this._avatar = avatar;
    this._username = username;

    const label = this._panel.querySelector('#es-auth-label');
    const btn = this._panel.querySelector('#es-auth-btn');
    if (label) label.textContent = username;
    if (btn) {
      btn.textContent = t('eroscripts.logOut');
      btn.onclick = () => this._logout();
    }

    const status = this._panel.querySelector('#es-status');
    if (status) {
      status.textContent = t('eroscripts.connected');
      status.className = 'eroscripts-panel__status eroscripts-panel__status--ok';
    }
    // "Searching needs your login" is no longer true.
    if (this._resultsView?.kind === 'loginNeeded') this._renderResultsMessage('placeholder');

    if (this.onLoginStatusChanged) this.onLoginStatusChanged(true, username);
    this.onProfileChanged?.();
  }

  _setLoggedOut() {
    this._loggedIn = false;
    this._username = '';
    this._avatar = '';

    const label = this._panel.querySelector('#es-auth-label');
    const btn = this._panel.querySelector('#es-auth-btn');
    if (label) label.textContent = t('eroscripts.notLoggedIn');
    if (btn) {
      btn.textContent = t('eroscripts.logIn');
      btn.onclick = () => this._loginViaWindow();
    }

    const status = this._panel.querySelector('#es-status');
    if (status) {
      status.textContent = '';
      status.className = 'eroscripts-panel__status';
    }
    // The last search's results carried live Get Script buttons that now
    // fail on the forum: show "Log in to search" over them instead, whose
    // Log In runs the same search again (found 2026-11-18, fixed 2026-11-22).
    if (this._resultsView?.kind === 'results') this._renderResultsMessage('loginNeeded');

    if (this.onLoginStatusChanged) this.onLoginStatusChanged(false, '');
    this.onProfileChanged?.();
  }

  async _logout() {
    await window.funsync.eroscriptsLogout();
    this._settings.set('eroscripts.session', null);
    this._setLoggedOut();
  }

  /**
   * A request came back 401 / 403 (any caller: this panel's search and Get
   * Script, the auto-match, the inline search, the Tags section). Since
   * 2026-11-18 that alone no longer drops the login: a 403 can be Cloudflare
   * or a post you may not see. The session check is asked again (forced, no
   * kept answer) and only its definite "not logged in" drops the session
   * (forgetExpiredSession). "Could not check" changes nothing.
   *
   * Before this existed, `_loggedIn` was a snapshot taken at app start and
   * never revisited, so an expired session left the panel reading
   * "connected" indefinitely. The auto-match path discarded the API's
   * error entirely, so the only symptom was script-found notifications
   * quietly never appearing again — which is a terrible way to learn you
   * have been logged out.
   *
   * @returns {Promise<'loggedOut'|'valid'|'expired'|'unknown'>} the check's answer
   */
  async handleSessionExpired() {
    return this.checkSession({ force: true });
  }

  /**
   * Is the saved login still good? (Dave, 2026-11-18.) Asked when the panel
   * opens, before each search, by the inline search and the Tags section when
   * they open, and (forced) after a 401 / 403. Main sends one
   * `/session/current.json` and keeps the answer for a few minutes, so
   * opening things again sends nothing (main's EroScriptsAPI.checkSession).
   * A definite 'expired' drops the session here (the saved session, main's
   * cookie, "Connected", the top bar's connected look) with one toast;
   * 'valid', 'unknown' (network, timeout, 5xx, Cloudflare) and 'loggedOut'
   * change nothing. Logged out, nothing is asked.
   * @param {{force?: boolean}} [opts]
   * @returns {Promise<'loggedOut'|'valid'|'expired'|'unknown'>}
   */
  async checkSession({ force = false } = {}) {
    if (!this._loggedIn) return 'loggedOut';
    const ask = window.funsync?.eroscriptsCheckSession;
    if (typeof ask !== 'function') return 'unknown';
    let state = 'unknown';
    try {
      const answer = await ask({ force: force === true });
      if (SESSION_STATES.has(answer?.state)) state = answer.state;
      if (state === 'valid' && typeof answer?.avatar === 'string' && answer.avatar) this._setAvatar(answer.avatar);
    } catch {
      state = 'unknown';
    }
    if (state === 'expired') await this.forgetExpiredSession();
    return state;
  }

  /**
   * The forum said the saved login is dead: drop it and say so, once.
   *
   * Idempotent: several calls can fail in quick succession, and the user
   * should get one toast, not one per request.
   */
  forgetExpiredSession() {
    if (this._forgetting) return this._forgetting;
    if (!this._loggedIn && this._expiredNotified) return Promise.resolve();
    this._expiredNotified = true;
    this._forgetting = (async () => {
      this._settings.set('eroscripts.session', null);
      try {
        await window.funsync.eroscriptsLogout();
      } catch { /* already gone in main — the local state is what matters */ }
      this._setLoggedOut();
      showToast(t('eroscripts.sessionExpired'), 'warn', 6000);
    })().finally(() => { this._forgetting = null; });
    return this._forgetting;
  }

  /**
   * Log in through the EroScripts login window, as the panel's own button
   * does, for another surface that needs the login first (the video options
   * dialog's Get tags, 2026-11-18). True when logged in afterwards; a
   * cancelled or failed login is false (the window's own error toast shows).
   */
  async login() {
    // Asked for because main says "not logged in": the window opens even if
    // this panel still thinks it is (a stale state; the window then picks the
    // session up again), as before the 2026-11-25 guard.
    await this._loginViaWindow({ force: true });
    return this._loggedIn === true;
  }

  /** The signed-in name ('' logged out). */
  get username() { return this._username; }
  /** The signed-in user's picture ('' when there is none or logged out). */
  get avatarUrl() { return this._loggedIn ? this._avatar : ''; }
  /** The login window is open. */
  get loginPending() { return this._loginPending === true; }

  /**
   * The tab empties the box itself (a post's tag clicked, 2026-11-25): no
   * "emptied" event, the tab loads its list once.
   */
  clearQuery() {
    const input = this._panel?.querySelector('#es-search-input');
    if (input) input.value = '';
    if (this._searchClear) this._searchClear.hidden = true;
  }

  /** The tab's Log In: the login window, as this panel's own button opens it. */
  openLogin() { return this._loginViaWindow(); }

  /** The tab's account menu: Log Out, as this panel's own button does. */
  logout() { return this._logout(); }

  /** A new picture from the login check: kept with the saved session too. */
  _setAvatar(url) {
    if (!this._loggedIn || url === this._avatar) return;
    this._avatar = url;
    const saved = this._settings.get('eroscripts.session');
    if (saved && saved.username === this._username) this._settings.set('eroscripts.session', { ...saved, avatar: url });
    this.onProfileChanged?.();
  }

  /**
   * The results area's own [Log In] (a search while logged out): the login
   * window, then the search you asked for, once. A cancelled login asks
   * again; the focus never drops to the page.
   */
  async _loginThenSearch() {
    if (this._loginPending) return;
    const shown = this._panel.querySelector('.eroscripts-panel__login-needed-btn');
    if (shown) {
      shown.disabled = true;
      shown.textContent = t('eroscripts.waitingLogin');
    }
    await this._loginViaWindow();
    if (this._loggedIn) {
      if (this._visible) this._focusIfLost(this._panel.querySelector('#es-search-input'));
      await this._search();
      return;
    }
    this._renderResultsMessage('loginNeeded');
    if (this._visible) this._focusIfLost(this._panel.querySelector('.eroscripts-panel__login-needed-btn'));
  }

  /** Focus `el` when the focus fell to the page (its control was redrawn). */
  _focusIfLost(el) {
    const active = document.activeElement;
    if (!el || (active && active !== document.body && active !== document.documentElement)) return;
    try { el.focus({ preventScroll: true }); } catch { /* not focusable now */ }
  }

  async _loginViaWindow({ force = false } = {}) {
    // Open the real eroscripts login page in a child Electron window.
    // The user authenticates via Discourse's own UI, so whatever 2FA
    // method they have enabled (TOTP, backup code, hardware key /
    // WebAuthn) just works. Main process captures the resulting `_t`
    // session cookie and hands it back. Replaces the prior in-app modal
    // that hard-coded a 6-digit TOTP entry and locked out everyone with
    // a hardware key or backup-code-only setup.
    // One login window at a time (a second ask waits for it); none while
    // logged in, unless a caller that knows better asks (login()).
    if (this._loggedIn && !force) return undefined;
    if (this._loginPromise) return this._loginPromise;
    this._loginPromise = this._openLoginWindow().finally(() => { this._loginPromise = null; });
    return this._loginPromise;
  }

  async _openLoginWindow() {
    const btn = this._panel.querySelector('#es-auth-btn');
    this._loginPending = true;
    this.onProfileChanged?.();
    if (btn) {
      btn.disabled = true;
      btn.textContent = t('eroscripts.waitingLogin');
    }
    try {
      const result = await window.funsync.eroscriptsLoginWindow();
      if (result.success) {
        this._settings.set('eroscripts.session', {
          cookie: result.cookie,
          username: result.username,
          ...(typeof result.avatar === 'string' && result.avatar ? { avatar: result.avatar } : {}),
        });
        this._setLoggedIn(result.username, result.avatar);
      } else if (result.error && result.error !== 'Login cancelled') {
        showToast(result.error, 'error', 5000);
      }
    } finally {
      this._loginPending = false;
      this.onProfileChanged?.();
      if (btn) {
        this._enableButton(btn);
        // From state, not the text captured before the window opened: that
        // is in the old language if the user switched in the meantime.
        if (!this._loggedIn) btn.textContent = t('eroscripts.logIn');
      }
    }
  }

  async _search() {
    const input = this._panel.querySelector('#es-search-input');
    const query = input.value.trim();
    if (!query) return;
    // Asked for while one is still loading (Enter again, Search, a tag added
    // or removed in the tab): it runs when that one ends, with what is asked
    // for THEN, and the older answer is not shown. It used to be dropped, so
    // the results never caught up: Dave, 2026-11-25, "searching by tag doesnt
    // seem to work" (live: a tag added during a search left the old results,
    // 9 of 50 kept by the tag, where the forum has far more).
    if (this._searching) { this._searchAgain = true; return; }
    this._searchAgain = false;
    try {
      await this._runSearch(query);
    } finally {
      if (this._searchAgain) {
        this._searchAgain = false;
        this._search();
      }
    }
  }

  async _runSearch(query) {
    this._lastSearchQuery = query;

    // Just after launch the saved login may still be being checked.
    if (!this._loggedIn && this._restoring) {
      this._searching = true;
      try { await this._restoring; } finally { this._searching = false; }
    }

    // Logged out, nothing is sent: the results area asks to log in, with the
    // login button (Dave, 2026-11-18, as Get tags does).
    if (!this._loggedIn) {
      this._renderResultsMessage('loginNeeded');
      return;
    }

    this._searching = true;
    const resultsEl = this._panel.querySelector('#es-results');
    this._renderResultsMessage('searching');

    // The saved login is checked first: a kept answer when it was checked in
    // the last few minutes, so this is usually no request at all. A timed-out
    // login asks to log in instead of answering "no scripts found" (the
    // forum answers a dead cookie's search as an anonymous one: 200, empty).
    await this.checkSession();
    if (!this._loggedIn) {
      this._searching = false;
      this._renderResultsMessage('loginNeeded');
      return;
    }
    // A newer search was asked for while the login was checked: no request for this one.
    if (this._searchAgain) { this._searching = false; return; }

    const sent = typeof this.queryDecorator === 'function' ? this.queryDecorator(query) : query;
    const answer = await window.funsync.eroscriptsSearch(sent);
    const { results, error, authExpired } = answer;
    this._searching = false;
    // A newer search was asked for meanwhile: this answer is old (it runs next).
    if (this._searchAgain) return;

    // Main had no login to send: nothing was sent.
    if (answer?.loginRequired) {
      this._renderResultsMessage('loginNeeded');
      return;
    }

    // A dead session self-corrects here rather than waiting for a restart,
    // which was the only thing that used to re-check it. The session check
    // decides whether it is dead (handleSessionExpired).
    if (authExpired) await this.handleSessionExpired();

    if (error) {
      // Main's `error` is English; the code picks the shown words (verify-2).
      // Kept, so a language switch paints it again in the new language.
      this._resultsView = { kind: 'error', answer };
      resultsEl.innerHTML = `<div class="eroscripts-panel__placeholder eroscripts-panel__placeholder--error">${this._esc(eroscriptsErrorText(answer))}</div>`;
      return;
    }

    if (results.length === 0) {
      this._renderResultsMessage('noResults', query);
      return;
    }

    this._renderResults(results);
  }

  /** "Search with fewer words": that query in the box, searched once. */
  _searchFewerWords(fewer) {
    const input = this._panel.querySelector('#es-search-input');
    if (!input) return;
    input.value = fewer;
    this._search();
    const active = document.activeElement;
    if (!active || active === document.body || active === document.documentElement) input.focus();
  }

  _renderResults(results) {
    const container = this._panel.querySelector('#es-results');
    container.innerHTML = '';
    this._resultsView = { kind: 'results', results };
    // In the tab the results are its cards (2026-11-22).
    if (this._docked && typeof this.onResults === 'function') {
      this.onResults(results);
      return;
    }

    for (const topic of results) {
      const card = document.createElement('div');
      card.className = 'eroscripts-panel__result';

      // Thumbnail. Shared with the Associate-modal search so the
      // listener-before-src ordering lives in exactly one place.
      const thumb = createResultThumb({
        thumbnail: topic.thumbnail,
        avatar: topic.avatar,
        className: 'eroscripts-panel__result-thumb',
      });
      card.appendChild(thumb);

      // Lazy-load actual topic image (replaces avatar)
      if (!topic.thumbnail && topic.id) {
        window.funsync.eroscriptsTopicImage(topic.id).then((imgUrl) => {
          if (imgUrl) {
            thumb.src = imgUrl;
            thumb.style.display = '';
          }
        }).catch(() => {});
      }

      const content = document.createElement('div');
      content.className = 'eroscripts-panel__result-content';

      const title = document.createElement('div');
      title.className = 'eroscripts-panel__result-title';
      title.textContent = topic.title;
      title.title = topic.title;

      const meta = document.createElement('div');
      meta.className = 'eroscripts-panel__result-meta';
      meta.textContent = this._metaText(topic);

      const tags = document.createElement('div');
      tags.className = 'eroscripts-panel__result-tags';
      for (const tag of (topic.tags || []).slice(0, 5)) {
        const badge = document.createElement('span');
        badge.className = 'eroscripts-panel__tag';
        badge.textContent = tag;
        tags.appendChild(badge);
      }

      const actions = document.createElement('div');
      actions.className = 'eroscripts-panel__result-actions';

      const dlBtn = document.createElement('button');
      dlBtn.className = 'eroscripts-panel__btn';
      this._setLabel(dlBtn, 'eroscripts.getScript');
      dlBtn.addEventListener('click', () => this._downloadFromTopic(topic, dlBtn));

      const viewBtn = document.createElement('button');
      viewBtn.className = 'eroscripts-panel__btn eroscripts-panel__btn--secondary';
      viewBtn.dataset.role = 'view';
      this._setLabel(viewBtn, 'eroscripts.view');
      viewBtn.addEventListener('click', () => {
        window.funsync.openExternal(topic.url);
      });

      actions.appendChild(dlBtn);
      // The post's videos and scripts, in the EroScripts tab (2026-11-22).
      if (typeof this.onOpenPost === 'function') {
        const vidBtn = document.createElement('button');
        vidBtn.className = 'eroscripts-panel__btn eroscripts-panel__btn--secondary';
        vidBtn.dataset.role = 'videos';
        this._setLabel(vidBtn, 'eroscripts.tab.videosBtn');
        vidBtn.addEventListener('click', () => this.onOpenPost(topic));
        actions.appendChild(vidBtn);
      }
      actions.appendChild(viewBtn);

      content.appendChild(title);
      content.appendChild(meta);
      if (topic.tags && topic.tags.length > 0) content.appendChild(tags);
      content.appendChild(actions);
      card.appendChild(content);
      container.appendChild(card);
    }
  }

  async _downloadFromTopic(topic, btn) {
    btn.disabled = true;
    this._setLabel(btn, 'eroscripts.fetching');

    const answer = await window.funsync.eroscriptsTopic(topic.id);
    const { attachments, error, authExpired } = answer;

    // Same self-correction as search: a dead session shouldn't survive
    // until the next app restart.
    if (authExpired) {
      // handleSessionExpired says so (one warn toast). Falling through gave a
      // SECOND, error toast with main's English "Access denied — try logging
      // in again" (FT-082 real-app check, verify-2; also in v0.9.2).
      this._enableButton(btn);
      this._setLabel(btn, 'eroscripts.getScript');
      // The session check decides (2026-11-18): when the login is still good
      // (or could not be checked) the session is kept, and the refusal is
      // said once, in the user's language.
      const state = await this.handleSessionExpired();
      if (state !== 'expired') showToast(eroscriptsErrorText(answer), 'error');
      return;
    }

    if (error) {
      this._enableButton(btn);
      this._setLabel(btn, 'eroscripts.getScript');
      showToast(eroscriptsErrorText(answer), 'error');
      return;
    }
    if (attachments.length === 0) {
      this._markNoScriptFile(btn);
      return;
    }

    // The topic JSON's own tags, title and creator: the download records
    // them over the search result's (RB-2).
    const topicAnswer = topicMetaOf(answer);
    if (attachments.length === 1) {
      await this._downloadAttachment(attachments[0], btn, topic, topicAnswer);
      return;
    }

    // Multiple attachments — show picker
    this._enableButton(btn);
    this._setLabel(btn, 'eroscripts.getScript');
    this._showAttachmentPicker(attachments, btn.parentElement, topic, topicAnswer);
  }

  /**
   * A post with no funscript attached (v0.10.1). It used to say so in a short
   * toast while the button went back to "Get Script", which read as nothing
   * happening ("Art of blowjob…", topic 349527: the script is linked
   * elsewhere). Now the result itself says it and keeps saying it: the button
   * reads "No script file" and stays off, a line under it says where the
   * script may be, and View (the way to it) becomes the main button.
   */
  _markNoScriptFile(btn) {
    btn.disabled = true;
    this._setLabel(btn, 'eroscripts.noScriptFile');
    btn.classList.add('eroscripts-panel__btn--secondary');
    const actions = btn.parentElement;
    actions?.querySelector('[data-role="view"]')?.classList.remove('eroscripts-panel__btn--secondary');
    const content = actions?.parentElement;
    if (content && !content.querySelector('.eroscripts-panel__result-note')) {
      const note = document.createElement('div');
      note.className = 'eroscripts-panel__result-note';
      note.setAttribute('role', 'status');
      this._setLabel(note, 'eroscripts.noScriptFileNote');
      content.appendChild(note);
    }
  }

  _showAttachmentPicker(attachments, parentEl, topic, topicAnswer = null) {
    parentEl.querySelector('.eroscripts-panel__attachment-list')?.remove();

    const list = document.createElement('div');
    list.className = 'eroscripts-panel__attachment-list';

    for (const att of attachments) {
      const item = document.createElement('button');
      item.className = 'eroscripts-panel__attachment-item';
      item.textContent = att.name;
      item.addEventListener('click', async () => {
        list.remove();
        const btn = parentEl.querySelector('.eroscripts-panel__btn');
        await this._downloadAttachment(att, btn, topic, topicAnswer);
      });
      list.appendChild(item);
    }

    parentEl.appendChild(list);
    // The whole list in view: the results box scrolls as little as it can.
    if (typeof list.scrollIntoView === 'function') list.scrollIntoView({ block: 'nearest' });
  }

  /**
   * Where a download goes, decided before anything is fetched or written.
   *
   *   - A video open (with a path; `getOpenVideoPath`, so not one that was
   *     closed, C-05): a .funscript is renamed to the video's
   *     `<videoBase>.funscript` beside it, so it pairs by name. Any other type
   *     (a .zip) keeps its own name and type beside the video and is never
   *     taken as the video's script (R3-05: it used to be saved as
   *     `<video>.funscript`, and with Replace the real script went to the bin
   *     and zip bytes took its place).
   *   - No video, exactly one enabled source: its root, under the name.
   *   - Otherwise the Save dialog, which only PICKS (R3-01): it used to be
   *     save-funscript(''), which wrote an empty file at the chosen path at
   *     once, emptying an existing script before the download started.
   * The attachment name is the post's link text: only a cleaned basename is
   * used (R3-04, `safeAttachmentName`); a name with nothing usable left is
   * refused.
   *
   * @returns {Promise<null|{refused: true}|{savePath: string, savedName: string,
   *   isScript: boolean, videoPath: string|null}>} null = the dialog was cancelled
   */
  async _chooseTarget(attachment) {
    const safeName = safeAttachmentName(attachment?.name);
    if (!safeName) return { refused: true };
    const isScript = /\.funscript$/i.test(safeName);

    const sources = (this._settings.get('library.sources') || []).filter(s => s.enabled !== false);
    // The app's answer when it is wired (C-05): a closed video is no target.
    const videoPath = typeof this.getOpenVideoPath === 'function'
      ? this.getOpenVideoPath()
      : document.getElementById('player-container')?.dataset?.videoPath;

    // No separator rewrite: this used to force every '/' to '\\', which on
    // Linux turned an absolute path into one backslash-laden filename.
    // `joinPath` uses the right separator for the platform.
    if (videoPath && (videoPath.includes('/') || videoPath.includes('\\'))) {
      const videoDir = videoPath.replace(/[\\/][^\\/]+$/, '');
      if (!isScript) {
        return { savePath: joinPath(videoDir, safeName), savedName: safeName, isScript: false, videoPath: null };
      }
      // Auto-rename to match video filename for auto-pairing
      const videoBase = videoPath.split(/[\\/]/).pop().replace(/\.[^/.]+$/, '');
      const savedName = `${videoBase}.funscript`;
      return { savePath: joinPath(videoDir, savedName), savedName, isScript: true, videoPath };
    }
    if (sources.length === 1) {
      // Exactly one source → safe to save there without asking
      return { savePath: joinPath(sources[0].path, safeName), savedName: safeName, isScript, videoPath: null };
    }
    // No open video, OR multi-source library — ask the user where to save rather
    // than arbitrarily picking sources[0]. Dialog pre-fills the attachment name.
    const picked = await window.funsync.pickDownloadSavePath(safeName);
    if (!picked) return null;
    const savedName = picked.split(/[\\/]/).pop();
    return { savePath: picked, savedName, isScript: /\.funscript$/i.test(savedName), videoPath: null };
  }

  /** What a failed look or download says, in the user's language where it can. */
  _downloadErrorText(result, name) {
    if (result?.trashFailed) return t('eroscripts.trashFailed', { name, os: binOs() });
    // Main's own `error` is English (for the log): it showed as "Download
    // failed (404)" in every language (R3 fix-up, real-app verifier 1).
    if (Number.isInteger(result?.httpStatus)) return t('eroscripts.downloadFailedStatus', { status: result.httpStatus });
    if (result?.notAFile) return t('eroscripts.saveNotAFile', { name });
    if (result?.error) console.warn('[EroScripts] download failed:', result.error);
    return t('eroscripts.downloadFailed');
  }

  /**
   * Download one attachment. Nothing is written until the bytes are here and
   * every question is answered, in this order (R3-03):
   *   1. a look (`checkOnly`): fetches, compares, writes nothing;
   *   2. a different file already there: "Replace <name>?" (Cancel: nothing);
   *   3. with a video open: the editor's unsaved-changes question
   *      (`confirmBeforeDownload`; Cancel: nothing, the edits stay);
   *   4. the write; Replace sends the old file to the Recycle Bin first.
   * Replace used to come after the unsaved question, so Don't save, then
   * Cancel at Replace, threw the edits away for a download that never came.
   */
  async _downloadAttachment(attachment, btn, topic = null, topicAnswer = null) {
    if (btn) { btn.disabled = true; this._setLabel(btn, 'eroscripts.savingScript'); }
    const giveUp = () => { if (btn) { this._enableButton(btn); this._setLabel(btn, 'eroscripts.getScript'); } };

    const target = await this._chooseTarget(attachment);
    if (!target) { giveUp(); return; }
    if (target.refused) {
      showToast(t('eroscripts.unusableName', { name: String(attachment?.name ?? '') }), 'error', 6000);
      giveUp();
      return;
    }
    const { savePath, savedName, isScript, videoPath } = target;
    const url = attachment.url;
    // Nothing will be written after a look: main need not keep the bytes it
    // fetched for a write (R4-09; they used to wait there for 5 minutes).
    const stop = () => { forgetFetched(url); giveUp(); };

    // 1 + 2. Look, and ask about a different file already there.
    const look = await window.funsync.eroscriptsDownload(url, savePath, { checkOnly: true });
    let replace = false;
    if (look?.exists) {
      if (!(await askReplaceFiles([savedName]))) { stop(); return; }
      replace = true;
    } else if (!look?.success) {
      showToast(this._downloadErrorText(look, savedName), 'error');
      stop();
      return;
    }

    // 3. A script replaces the one in the editor, and with a video open it is
    // written to the editor's own <video>.funscript: unsaved edits are asked
    // about BEFORE anything is written (round 2). Not for a .zip, which the
    // editor never loads.
    if (isScript) {
      const editorOk = this.confirmBeforeDownload ? this.confirmBeforeDownload() : true;
      if (editorOk !== true && !(await editorOk)) { stop(); return; }
    }

    // 4. Write.
    let result = await window.funsync.eroscriptsDownload(url, savePath, { replace });
    if (result?.exists) {
      // There since the look, or changed: a Save at the question above writes
      // the editor's own file. Never written over without asking.
      if (!(await askReplaceFiles([savedName]))) { stop(); return; }
      result = await window.funsync.eroscriptsDownload(url, savePath, { replace: true });
    }
    const success = !!result?.success;

    // Nothing was written when the same bytes were there: the button says so
    // too, not "Script saved" (C-10; the toast already did, R4-10).
    const doneLabel = result?.unchanged ? 'eroscripts.upToDate' : 'eroscripts.scriptSaved';
    if (btn) { this._enableButton(btn); this._setLabel(btn, success ? doneLabel : 'eroscripts.getScript'); }

    if (!success) {
      showToast(this._downloadErrorText(result, savedName), 'error');
      return;
    }
    // The same bytes were already there: nothing was written, so the toast
    // does not say "saved" (R4-10).
    const savedText = result.unchanged
      ? t('eroscripts.alreadyUpToDate', { name: savedName })
      : null;
    if (!isScript) {
      showToast(savedText || t('eroscripts.savedFileToast', { name: savedName }), 'info');
      return;
    }
    // Record the post's tags against the video this script just became
    // associated with. Only meaningful when a video is actually loaded —
    // saving into a source folder with nothing playing associates with
    // nothing, so there is no key to file the tags under. The record names
    // the script saved (the video's `<name>.funscript`), so it never stands
    // for a script paired later (RB-2), and takes the topic JSON's tags.
    if (videoPath && topic) {
      recordDownloadTags(this._settings, videoPath, { topic, answer: topicAnswer, scriptPath: savePath });
    }
    showToast(savedText || t('eroscripts.savedToast', { name: savedName }), 'info');
    if (this.onScriptDownloaded) this.onScriptDownloaded(savePath, savedName);
  }

  /**
   * Enable a button the panel disabled while it worked (Get Script). A
   * disabled button drops the focus to <body>, outside the panel, so the
   * panel's own Escape and Tab trap (listeners on the panel) stopped
   * answering after a Get Script, and the next click outside only closed
   * it (block C verifier 1; also in v0.9.2). The focus comes back to the
   * button when nothing else took it meanwhile.
   */
  _enableButton(btn) {
    if (!btn) return;
    btn.disabled = false;
    if (!this._visible || !this._panel?.contains(btn)) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement) return;
    try { btn.focus({ preventScroll: true }); } catch { /* not focusable now */ }
  }

  /**
   * Set the search query and optionally auto-search.
   * @param {string} query
   * @param {boolean} [autoSearch=false]
   */
  setSearchQuery(query, autoSearch = false) {
    const input = this._panel.querySelector('#es-search-input');
    if (input) input.value = query || '';

    // Clear stale results if query changed
    if (query !== this._lastSearchQuery) {
      this._renderResultsMessage('placeholder');
    }

    if (autoSearch && query) {
      this._search();
    }
  }

  toggle() { if (this._visible) this.hide(); else this.show(); }

  /**
   * The EroScripts tab (2026-11-22) hosts the panel in its view: no dialog,
   * no close button, no focus trap, no outside click. `undock()` puts it back
   * as the floating panel (the player view still opens it that way, so a
   * video keeps playing under it).
   */
  dock(host, { searchExtras = null } = {}) {
    if (!host) return;
    if (this._visible && !this._docked) this.hide();
    this._docked = true;
    this._panel.classList.add('eroscripts-panel--docked');
    this._panel.removeAttribute('role');
    this._panel.removeAttribute('aria-modal');
    host.appendChild(this._panel);
    this._dockSearchBox(true);
    // The tab's own controls beside the search box (the Free / Paid filter).
    if (searchExtras) {
      this._searchExtras = searchExtras;
      this._panel.querySelector('.eroscripts-panel__input-row')?.appendChild(searchExtras);
    }
    // Nothing searched: the tab lists the newest scripts in its place.
    // Nothing searched: the tab lists the newest scripts in its place. Results:
    // the tab shows them as cards, so the list the floating panel drew for them
    // (undock) goes; it showed above the cards after a trip to the player
    // (Dave, 2026-11-22: "why does the search bring up 2 result sets").
    if (this._resultsView?.kind === 'placeholder' || this._resultsView?.kind === 'results') {
      this._panel.querySelector('#es-results')?.replaceChildren();
    }
    this._panel.hidden = false;
    this._visible = true;
    if (this._loggedIn) this.checkSession().catch(() => { /* changes nothing */ });
  }

  /**
   * In the tab the search box is the Library's (Dave, 2026-11-25: "the
   * searchbar can just match the one we have in the library as theres no
   * point in being non consistant"): its magnifier, its size (180 px, 240
   * focused; it was stretched across the row) and its clear button; Enter
   * searches. The floating panel keeps its own box and Search button.
   */
  _dockSearchBox(on) {
    const input = this._panel?.querySelector('#es-search-input');
    if (!input) return;
    if (on) {
      if (!this._searchBox) {
        const box = document.createElement('div');
        box.className = 'library__search eroscripts-panel__search-box';
        const glass = document.createElement('span');
        glass.className = 'library__search-icon';
        glass.setAttribute('aria-hidden', 'true');
        glass.appendChild(icon(Search, { width: 14, height: 14 }));
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'library__search-clear';
        clear.appendChild(icon(X, { width: 14, height: 14 }));
        // Emptied: the panel's own input handler brings the newest list back.
        clear.addEventListener('click', () => {
          input.value = '';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.focus();
        });
        input.addEventListener('input', () => { clear.hidden = !input.value; });
        box.append(glass, clear);
        this._searchBox = box;
        this._searchClear = clear;
      }
      this._searchClear.setAttribute('aria-label', t('library.clearSearchAria'));
      this._searchClear.hidden = !input.value;
      if (input.parentElement !== this._searchBox) {
        input.before(this._searchBox);
        this._searchBox.insertBefore(input, this._searchClear);
      }
      input.classList.remove('eroscripts-panel__input', 'eroscripts-panel__search-input');
      input.classList.add('library__search-input');
      return;
    }
    if (this._searchBox && input.parentElement === this._searchBox) {
      this._searchBox.before(input);
      this._searchBox.remove();
    }
    input.classList.remove('library__search-input');
    input.classList.add('eroscripts-panel__input', 'eroscripts-panel__search-input');
  }

  undock() {
    if (!this._docked) return;
    this._docked = false;
    this._visible = false;
    this._panel.hidden = true;
    this._panel.classList.remove('eroscripts-panel--docked');
    this._panel.setAttribute('role', 'dialog');
    this._panel.setAttribute('aria-modal', 'true');
    this._searchExtras?.remove();
    this._searchExtras = null;
    this._dockSearchBox(false);
    document.getElementById('app')?.appendChild(this._panel);
    // The tab drew the last results as cards: the floating list draws them.
    if (this._resultsView?.kind === 'results') this._renderResults(this._resultsView.results);
    else if (this._resultsView?.kind === 'placeholder') this._renderResultsMessage('placeholder');
  }

  get docked() { return this._docked === true; }

  /** Search again with what is in the box (the tab's filter changed). */
  search() {
    const input = this._panel.querySelector('#es-search-input');
    if (input?.value.trim()) this._search();
  }

  show() {
    if (this._docked) {
      this._panel.querySelector('#es-search-input')?.focus();
      return;
    }
    this._panel.hidden = false;
    this._visible = true;

    // Modal contract per DESIGN.md §2.5 — stash previous focus, focus
    // trap on Tab, Escape closes, focus restored on close.
    this._previouslyFocused = document.activeElement;
    this._panel.querySelector('#es-search-input').focus();

    // Is the saved login still good? (Dave, 2026-11-18.) A kept answer when
    // it was checked in the last few minutes; a timed-out one is dropped
    // here, so the panel and the top bar stop saying "connected".
    if (this._loggedIn) this.checkSession().catch(() => { /* changes nothing */ });

    this._boundFocusTrap = (e) => {
      if (e.key !== 'Tab') return;
      const focusables = this._panel.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      const visible = Array.from(focusables).filter(el => el.offsetParent !== null);
      if (visible.length === 0) return;
      const first = visible[0];
      const last = visible[visible.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    this._panel.addEventListener('keydown', this._boundFocusTrap);

    this._boundEscapeKey = (e) => {
      if (e.key === 'Escape') {
        // Don't close if the login sub-modal is open — let it handle
        // its own Escape and stay inside the panel. The login modal now
        // uses Modal.open() which renders with `.modal-overlay`.
        if (document.querySelector('.modal-overlay')) return;
        e.preventDefault();
        this.hide();
      }
    };
    this._panel.addEventListener('keydown', this._boundEscapeKey);

    // Outside-click close (preserved from prior implementation).
    if (this._boundOutsideClick) {
      document.removeEventListener('click', this._boundOutsideClick, true);
    }
    this._boundOutsideClick = (e) => {
      // Don't close if clicking inside any open modal (login sub-modal
      // now uses Modal.open() which renders into `.modal-overlay`), or on
      // a toast: the X on the panel's own "Saved" toast closed the panel
      // and was swallowed, leaving the toast (V75).
      if (e.target.closest('.modal-overlay, #toast-container')) return;
      if (!this._panel.contains(e.target)) {
        e.preventDefault();
        e.stopPropagation();
        this.hide();
      }
    };
    setTimeout(() => document.addEventListener('click', this._boundOutsideClick, true), 0);
  }

  hide() {
    if (this._docked) return; // the tab's own, until it undocks
    this._panel.hidden = true;
    this._visible = false;
    if (this._boundOutsideClick) {
      document.removeEventListener('click', this._boundOutsideClick, true);
      this._boundOutsideClick = null;
    }
    if (this._boundFocusTrap) {
      this._panel.removeEventListener('keydown', this._boundFocusTrap);
      this._boundFocusTrap = null;
    }
    if (this._boundEscapeKey) {
      this._panel.removeEventListener('keydown', this._boundEscapeKey);
      this._boundEscapeKey = null;
    }
    if (this._previouslyFocused && typeof this._previouslyFocused.focus === 'function') {
      try { this._previouslyFocused.focus({ preventScroll: true }); }
      catch { /* element may be unfocusable now */ }
    }
    this._previouslyFocused = null;
  }

  _esc(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}
