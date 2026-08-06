// EroScriptsPanel — Search and download funscripts from discuss.eroscripts.com

import { icon, X } from '../js/icons.js';
import { showToast } from '../js/toast.js';
import { t } from '../js/i18n.js';
import { recordScriptTags } from '../js/script-tags.js';
import { createResultThumb } from './result-thumb.js';
import { joinPath, dirOfPath } from '../js/path-utils.js';

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

    // Callbacks
    this.onScriptDownloaded = null;
    this.onLoginStatusChanged = null; // (loggedIn, username) => {}

    this._createPanel();
    this._restoreSession();
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
    this._panel.querySelector('#es-auth-btn').addEventListener('click', () => this._loginViaWindow());

    // Search
    this._panel.querySelector('#es-search-btn').addEventListener('click', () => this._search());
    this._panel.querySelector('#es-search-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._search();
    });
  }

  async _restoreSession() {
    const saved = this._settings.get('eroscripts.session');
    if (!saved || !saved.cookie || !saved.username) return;

    await window.funsync.eroscriptsRestoreSession(saved.cookie, saved.username);

    // Validate the session is still active
    const { valid } = await window.funsync.eroscriptsValidate();
    if (valid) {
      this._setLoggedIn(saved.username);
    } else {
      // Session expired — clear it
      this._settings.set('eroscripts.session', null);
      await window.funsync.eroscriptsLogout();
      this._setLoggedOut();
      showToast(t('eroscripts.sessionExpired'), 'warn', 6000);
    }
  }

  _setLoggedIn(username) {
    this._loggedIn = true;
    // Fresh session — a future expiry should announce itself again.
    this._expiredNotified = false;
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

    if (this.onLoginStatusChanged) this.onLoginStatusChanged(true, username);
  }

  _setLoggedOut() {
    this._loggedIn = false;
    this._username = '';

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

    if (this.onLoginStatusChanged) this.onLoginStatusChanged(false, '');
  }

  async _logout() {
    await window.funsync.eroscriptsLogout();
    this._settings.set('eroscripts.session', null);
    this._setLoggedOut();
  }

  /**
   * The server has told us the stored session is dead (401/403 on any
   * call). Drop it and say so, once.
   *
   * Before this existed, `_loggedIn` was a snapshot taken at app start and
   * never revisited, so an expired session left the panel reading
   * "connected" indefinitely. The auto-match path discarded the API's
   * error entirely, so the only symptom was script-found notifications
   * quietly never appearing again — which is a terrible way to learn you
   * have been logged out.
   *
   * Idempotent: several calls can fail in quick succession, and the user
   * should get one toast, not one per request.
   */
  async handleSessionExpired() {
    if (!this._loggedIn && this._expiredNotified) return;
    this._expiredNotified = true;
    this._settings.set('eroscripts.session', null);
    try {
      await window.funsync.eroscriptsLogout();
    } catch { /* already gone in main — the local state is what matters */ }
    this._setLoggedOut();
    showToast(t('eroscripts.sessionExpired'), 'warn', 6000);
  }

  async _loginViaWindow() {
    // Open the real eroscripts login page in a child Electron window.
    // The user authenticates via Discourse's own UI, so whatever 2FA
    // method they have enabled (TOTP, backup code, hardware key /
    // WebAuthn) just works. Main process captures the resulting `_t`
    // session cookie and hands it back. Replaces the prior in-app modal
    // that hard-coded a 6-digit TOTP entry and locked out everyone with
    // a hardware key or backup-code-only setup.
    const btn = this._panel.querySelector('#es-auth-btn');
    const prevText = btn?.textContent;
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
        });
        this._setLoggedIn(result.username);
      } else if (result.error && result.error !== 'Login cancelled') {
        showToast(result.error, 'error', 5000);
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        if (!this._loggedIn) btn.textContent = prevText || t('eroscripts.logIn');
      }
    }
  }

  async _search() {
    const input = this._panel.querySelector('#es-search-input');
    const query = input.value.trim();
    if (!query || this._searching) return;
    this._lastSearchQuery = query;

    this._searching = true;
    const resultsEl = this._panel.querySelector('#es-results');
    resultsEl.innerHTML = `<div class="eroscripts-panel__placeholder">${t('eroscripts.searching')}</div>`;

    const { results, error, authExpired } = await window.funsync.eroscriptsSearch(query);
    this._searching = false;

    // A dead session self-corrects here rather than waiting for a restart,
    // which was the only thing that used to re-check it.
    if (authExpired) await this.handleSessionExpired();

    if (error) {
      resultsEl.innerHTML = `<div class="eroscripts-panel__placeholder eroscripts-panel__placeholder--error">${this._esc(error)}</div>`;
      return;
    }

    if (results.length === 0) {
      // No-results state with a "what to do next" hint (Nielsen #9 +
      // #10) — was a single line of text with no suggestion. The
      // placeholder--hint modifier styles the secondary line a touch
      // smaller / dimmer, mirroring the library / playlists pattern.
      resultsEl.innerHTML = `
        <div class="eroscripts-panel__placeholder">
          <div>${this._esc(t('eroscripts.noResultsTitle', { query }))}</div>
          <div class="eroscripts-panel__placeholder--hint">${t('eroscripts.noResultsHint')}</div>
        </div>`;
      return;
    }

    this._renderResults(results);
  }

  _renderResults(results) {
    const container = this._panel.querySelector('#es-results');
    container.innerHTML = '';

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
      const parts = [];
      if (topic.creator) parts.push(`@${topic.creator}`);
      if (topic.likeCount > 0) parts.push(t('eroscripts.likes', { count: topic.likeCount }));
      if (topic.views > 0) parts.push(t('eroscripts.views', { count: topic.views }));
      meta.textContent = parts.join(' · ');

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
      dlBtn.textContent = t('eroscripts.getScript');
      dlBtn.addEventListener('click', () => this._downloadFromTopic(topic, dlBtn));

      const viewBtn = document.createElement('button');
      viewBtn.className = 'eroscripts-panel__btn eroscripts-panel__btn--secondary';
      viewBtn.textContent = t('eroscripts.view');
      viewBtn.addEventListener('click', () => {
        window.funsync.openExternal(topic.url);
      });

      actions.appendChild(dlBtn);
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
    btn.textContent = t('eroscripts.fetching');

    const { attachments, error, authExpired } = await window.funsync.eroscriptsTopic(topic.id);

    // Same self-correction as search: a dead session shouldn't survive
    // until the next app restart.
    if (authExpired) await this.handleSessionExpired();

    if (error || attachments.length === 0) {
      btn.disabled = false;
      btn.textContent = t('eroscripts.getScript');
      showToast(error || t('eroscripts.noAttachments'), error ? 'error' : 'warn');
      return;
    }

    if (attachments.length === 1) {
      await this._downloadAttachment(attachments[0], btn, topic);
      return;
    }

    // Multiple attachments — show picker
    btn.disabled = false;
    btn.textContent = t('eroscripts.getScript');
    this._showAttachmentPicker(attachments, btn.parentElement, topic);
  }

  _showAttachmentPicker(attachments, parentEl, topic) {
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
        await this._downloadAttachment(att, btn, topic);
      });
      list.appendChild(item);
    }

    parentEl.appendChild(list);
  }

  async _downloadAttachment(attachment, btn, topic = null) {
    if (btn) { btn.disabled = true; btn.textContent = t('eroscripts.savingScript'); }

    const sources = (this._settings.get('library.sources') || []).filter(s => s.enabled !== false);
    const playerContainer = document.getElementById('player-container');
    const videoPath = playerContainer?.dataset?.videoPath;

    let savePath;
    let savedName = attachment.name;
    if (videoPath && (videoPath.includes('/') || videoPath.includes('\\'))) {
      // Auto-rename to match video filename for auto-pairing
      const videoDir = videoPath.replace(/[\\/][^\\/]+$/, '');
      const videoBase = videoPath.split(/[\\/]/).pop().replace(/\.[^/.]+$/, '');
      savedName = `${videoBase}.funscript`;
      savePath = joinPath(videoDir, savedName);
    } else if (sources.length === 1) {
      // Exactly one source → safe to save there without asking
      savePath = joinPath(sources[0].path, attachment.name);
    } else {
      // No open video, OR multi-source library — ask the user where to save rather
      // than arbitrarily picking sources[0]. Dialog pre-fills the attachment name.
      const result = await window.funsync.saveFunscript('', attachment.name);
      if (!result) { if (btn) { btn.disabled = false; btn.textContent = t('eroscripts.getScript'); } return; }
      savePath = result;
    }

    // No separator rewrite: this used to force every '/' to '\\', which on
    // Linux turned an absolute path into one backslash-laden filename.
    // `joinPath` above already used the right separator for the platform.

    const { success, error } = await window.funsync.eroscriptsDownload(attachment.url, savePath);

    if (btn) { btn.disabled = false; btn.textContent = success ? t('eroscripts.scriptSaved') : t('eroscripts.getScript'); }

    if (success) {
      // Record the post's tags against the video this script just became
      // associated with. Only meaningful when a video is actually loaded —
      // saving into a source folder with nothing playing associates with
      // nothing, so there is no key to file the tags under.
      if (videoPath && topic) recordScriptTags(this._settings, videoPath, topic);
      showToast(t('eroscripts.savedToast', { name: savedName }), 'info');
      if (this.onScriptDownloaded) this.onScriptDownloaded(savePath, savedName);
    } else {
      showToast(error || t('eroscripts.downloadFailed'), 'error');
    }
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
      const resultsEl = this._panel.querySelector('#es-results');
      if (resultsEl) {
        resultsEl.innerHTML = `<div class="eroscripts-panel__placeholder">${t('eroscripts.placeholder')}</div>`;
      }
    }

    if (autoSearch && query) {
      this._search();
    }
  }

  toggle() { if (this._visible) this.hide(); else this.show(); }

  show() {
    this._panel.hidden = false;
    this._visible = true;

    // Modal contract per DESIGN.md §2.5 — stash previous focus, focus
    // trap on Tab, Escape closes, focus restored on close.
    this._previouslyFocused = document.activeElement;
    this._panel.querySelector('#es-search-input').focus();

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
      // now uses Modal.open() which renders into `.modal-overlay`).
      if (e.target.closest('.modal-overlay')) return;
      if (!this._panel.contains(e.target)) {
        e.preventDefault();
        e.stopPropagation();
        this.hide();
      }
    };
    setTimeout(() => document.addEventListener('click', this._boundOutsideClick, true), 0);
  }

  hide() {
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
