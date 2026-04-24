// EroScriptsPanel — Search and download funscripts from discuss.eroscripts.com

import { icon, X } from '../js/icons.js';
import { showToast } from '../js/toast.js';

export class EroScriptsPanel {
  constructor({ settings }) {
    this._settings = settings;
    this._panel = null;
    this._visible = false;
    this._searching = false;
    this._loggedIn = false;
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

    this._panel.innerHTML = `
      <div class="eroscripts-panel__header">
        <span class="eroscripts-panel__title">EroScripts</span>
        <span class="eroscripts-panel__status" id="es-status"></span>
        <button class="eroscripts-panel__close"></button>
      </div>

      <div class="eroscripts-panel__auth-bar" id="es-auth-bar">
        <span id="es-auth-label" class="eroscripts-panel__auth-label">Not logged in</span>
        <button id="es-auth-btn" class="eroscripts-panel__btn eroscripts-panel__btn--secondary">Log In</button>
      </div>

      <div class="eroscripts-panel__search">
        <div class="eroscripts-panel__input-row">
          <input type="text" id="es-search-input" class="eroscripts-panel__input eroscripts-panel__search-input" placeholder="Search for scripts...">
          <button id="es-search-btn" class="eroscripts-panel__btn">Search</button>
        </div>
      </div>

      <div class="eroscripts-panel__results" id="es-results">
        <div class="eroscripts-panel__placeholder">Search for a video name to find community scripts</div>
      </div>
    `;

    document.getElementById('app').appendChild(this._panel);

    const closeBtn = this._panel.querySelector('.eroscripts-panel__close');
    closeBtn.appendChild(icon(X, { width: 16, height: 16 }));
    closeBtn.addEventListener('click', () => this.hide());

    // Auth button — opens login modal
    this._panel.querySelector('#es-auth-btn').addEventListener('click', () => this._showLoginModal());

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
      showToast('EroScripts session expired — log in again via the EroScripts panel', 'warn', 6000);
    }
  }

  _setLoggedIn(username) {
    this._loggedIn = true;
    this._username = username;

    const label = this._panel.querySelector('#es-auth-label');
    const btn = this._panel.querySelector('#es-auth-btn');
    if (label) label.textContent = username;
    if (btn) {
      btn.textContent = 'Log Out';
      btn.onclick = () => this._logout();
    }

    const status = this._panel.querySelector('#es-status');
    if (status) {
      status.textContent = 'Connected';
      status.className = 'eroscripts-panel__status eroscripts-panel__status--ok';
    }

    if (this.onLoginStatusChanged) this.onLoginStatusChanged(true, username);
  }

  _setLoggedOut() {
    this._loggedIn = false;
    this._username = '';

    const label = this._panel.querySelector('#es-auth-label');
    const btn = this._panel.querySelector('#es-auth-btn');
    if (label) label.textContent = 'Not logged in';
    if (btn) {
      btn.textContent = 'Log In';
      btn.onclick = () => this._showLoginModal();
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

  async _showLoginModal() {
    // Create a login modal overlay
    const overlay = document.createElement('div');
    overlay.className = 'eroscripts-login-overlay';

    const modal = document.createElement('div');
    modal.className = 'eroscripts-login-modal';
    modal.innerHTML = `
      <div class="eroscripts-login-modal__header">
        <span>Log in to EroScripts</span>
        <button class="eroscripts-login-modal__close"></button>
      </div>
      <div class="eroscripts-login-modal__body">
        <div class="eroscripts-login-modal__field">
          <label>Username</label>
          <input type="text" id="es-modal-username" class="eroscripts-panel__input" autocomplete="off">
        </div>
        <div class="eroscripts-login-modal__field">
          <label>Password</label>
          <input type="password" id="es-modal-password" class="eroscripts-panel__input" autocomplete="off">
        </div>
        <div class="eroscripts-login-modal__2fa" id="es-modal-2fa" hidden>
          <label>Authenticator Code</label>
          <div class="eroscripts-login-modal__otp-row">
            <input type="text" class="eroscripts-login-modal__otp-digit" maxlength="1" inputmode="numeric" autocomplete="off">
            <input type="text" class="eroscripts-login-modal__otp-digit" maxlength="1" inputmode="numeric" autocomplete="off">
            <input type="text" class="eroscripts-login-modal__otp-digit" maxlength="1" inputmode="numeric" autocomplete="off">
            <span class="eroscripts-login-modal__otp-sep"></span>
            <input type="text" class="eroscripts-login-modal__otp-digit" maxlength="1" inputmode="numeric" autocomplete="off">
            <input type="text" class="eroscripts-login-modal__otp-digit" maxlength="1" inputmode="numeric" autocomplete="off">
            <input type="text" class="eroscripts-login-modal__otp-digit" maxlength="1" inputmode="numeric" autocomplete="off">
          </div>
          <div class="eroscripts-login-modal__hint">Enter the code from your authenticator app</div>
        </div>
        <div class="eroscripts-login-modal__error" id="es-modal-error" hidden></div>
        <button id="es-modal-submit" class="eroscripts-panel__btn eroscripts-login-modal__submit">Log In</button>
      </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const closeBtn = modal.querySelector('.eroscripts-login-modal__close');
    closeBtn.appendChild(icon(X, { width: 16, height: 16 }));

    const close = () => overlay.remove();
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    const usernameInput = modal.querySelector('#es-modal-username');
    const passwordInput = modal.querySelector('#es-modal-password');
    const otpDigits = modal.querySelectorAll('.eroscripts-login-modal__otp-digit');
    const tfaSection = modal.querySelector('#es-modal-2fa');

    // Wire OTP digit boxes — auto-advance, backspace, paste
    otpDigits.forEach((digit, i) => {
      digit.addEventListener('input', () => {
        digit.value = digit.value.replace(/\D/g, '').slice(0, 1);
        if (digit.value && i < otpDigits.length - 1) {
          otpDigits[i + 1].focus();
        }
        // Auto-submit when all 6 digits entered
        const code = [...otpDigits].map(d => d.value).join('');
        if (code.length === 6) submit();
      });
      digit.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !digit.value && i > 0) {
          otpDigits[i - 1].focus();
          otpDigits[i - 1].value = '';
        }
        if (e.key === 'Enter') submit();
      });
      digit.addEventListener('paste', (e) => {
        e.preventDefault();
        const pasted = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
        for (let j = 0; j < pasted.length && i + j < otpDigits.length; j++) {
          otpDigits[i + j].value = pasted[j];
        }
        const focusIdx = Math.min(i + pasted.length, otpDigits.length - 1);
        otpDigits[focusIdx].focus();
        if (pasted.length === 6) submit();
      });
    });

    const getOtpCode = () => [...otpDigits].map(d => d.value).join('');
    const errorEl = modal.querySelector('#es-modal-error');
    const submitBtn = modal.querySelector('#es-modal-submit');

    let pendingNonce = null;
    let awaiting2FA = false;

    const submit = async () => {
      errorEl.hidden = true;
      submitBtn.disabled = true;

      if (awaiting2FA) {
        // 2FA step
        const code = getOtpCode();
        if (code.length < 6) {
          errorEl.textContent = 'Enter all 6 digits';
          errorEl.hidden = false;
          submitBtn.disabled = false;
          return;
        }

        submitBtn.textContent = 'Verifying...';
        const result = await window.funsync.eroscriptsVerify2FA(
          pendingNonce,
          code,
          usernameInput.value.trim(),
          passwordInput.value,
        );
        submitBtn.disabled = false;
        submitBtn.textContent = 'Verify';

        if (result.success) {
          this._settings.set('eroscripts.session', { cookie: result.cookie, username: result.username });
          this._setLoggedIn(result.username);
          close();
        } else {
          errorEl.textContent = result.error || 'Verification failed';
          errorEl.hidden = false;
          otpDigits.forEach(d => { d.value = ''; });
          otpDigits[0].focus();
        }
      } else {
        // Initial login step
        const username = usernameInput.value.trim();
        const password = passwordInput.value;

        if (!username || !password) {
          errorEl.textContent = 'Enter username and password';
          errorEl.hidden = false;
          submitBtn.disabled = false;
          return;
        }

        submitBtn.textContent = 'Logging in...';
        const result = await window.funsync.eroscriptsLogin(username, password);
        submitBtn.disabled = false;

        if (result.success) {
          this._settings.set('eroscripts.session', { cookie: result.cookie, username: result.username });
          this._setLoggedIn(result.username);
          close();
        } else if (result.requires2FA) {
          // Show 2FA input
          pendingNonce = result.nonce; // may be null — verify2FA handles both cases
          awaiting2FA = true;
          tfaSection.hidden = false;
          usernameInput.disabled = true;
          passwordInput.disabled = true;
          submitBtn.textContent = 'Verify';
          otpDigits[0].focus();
        } else {
          submitBtn.textContent = 'Log In';
          errorEl.textContent = result.error || 'Login failed';
          errorEl.hidden = false;
        }
      }
    };

    submitBtn.addEventListener('click', submit);
    passwordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

    usernameInput.focus();
  }

  async _search() {
    const input = this._panel.querySelector('#es-search-input');
    const query = input.value.trim();
    if (!query || this._searching) return;
    this._lastSearchQuery = query;

    this._searching = true;
    const resultsEl = this._panel.querySelector('#es-results');
    resultsEl.innerHTML = '<div class="eroscripts-panel__placeholder">Searching...</div>';

    const { results, error } = await window.funsync.eroscriptsSearch(query);
    this._searching = false;

    if (error) {
      resultsEl.innerHTML = `<div class="eroscripts-panel__placeholder eroscripts-panel__placeholder--error">${this._esc(error)}</div>`;
      return;
    }

    if (results.length === 0) {
      resultsEl.innerHTML = '<div class="eroscripts-panel__placeholder">No scripts found</div>';
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

      // Thumbnail — show avatar immediately, lazy-load topic image
      const thumb = document.createElement('img');
      thumb.className = 'eroscripts-panel__result-thumb';
      thumb.alt = '';
      thumb.src = topic.thumbnail || topic.avatar || '';
      if (!thumb.src) thumb.style.display = 'none';
      thumb.addEventListener('error', () => { thumb.style.display = 'none'; });
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
      if (topic.likeCount > 0) parts.push(`${topic.likeCount} likes`);
      if (topic.views > 0) parts.push(`${topic.views} views`);
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
      dlBtn.textContent = 'Get Script';
      dlBtn.addEventListener('click', () => this._downloadFromTopic(topic, dlBtn));

      const viewBtn = document.createElement('button');
      viewBtn.className = 'eroscripts-panel__btn eroscripts-panel__btn--secondary';
      viewBtn.textContent = 'View';
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
    btn.textContent = 'Fetching...';

    const { attachments, error } = await window.funsync.eroscriptsTopic(topic.id);

    if (error || attachments.length === 0) {
      btn.disabled = false;
      btn.textContent = 'Get Script';
      showToast(error || 'No funscript attachments found in this topic', error ? 'error' : 'warn');
      return;
    }

    if (attachments.length === 1) {
      await this._downloadAttachment(attachments[0], btn);
      return;
    }

    // Multiple attachments — show picker
    btn.disabled = false;
    btn.textContent = 'Get Script';
    this._showAttachmentPicker(attachments, btn.parentElement);
  }

  _showAttachmentPicker(attachments, parentEl) {
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
        await this._downloadAttachment(att, btn);
      });
      list.appendChild(item);
    }

    parentEl.appendChild(list);
  }

  async _downloadAttachment(attachment, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Saving script...'; }

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
      savePath = `${videoDir}/${savedName}`;
    } else if (sources.length === 1) {
      // Exactly one source → safe to save there without asking
      savePath = `${sources[0].path}/${attachment.name}`;
    } else {
      // No open video, OR multi-source library — ask the user where to save rather
      // than arbitrarily picking sources[0]. Dialog pre-fills the attachment name.
      const result = await window.funsync.saveFunscript('', attachment.name);
      if (!result) { if (btn) { btn.disabled = false; btn.textContent = 'Get Script'; } return; }
      savePath = result;
    }

    savePath = savePath.replace(/\//g, '\\');

    const { success, error } = await window.funsync.eroscriptsDownload(attachment.url, savePath);

    if (btn) { btn.disabled = false; btn.textContent = success ? 'Script saved' : 'Get Script'; }

    if (success) {
      showToast(`Script saved: ${savedName}`, 'info');
      if (this.onScriptDownloaded) this.onScriptDownloaded(savePath, savedName);
    } else {
      showToast(error || 'Download failed', 'error');
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
        resultsEl.innerHTML = '<div class="eroscripts-panel__placeholder">Search for a video name to find community scripts</div>';
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
    this._panel.querySelector('#es-search-input').focus();

    // Clean up any existing outside click listener before adding a new one
    if (this._boundOutsideClick) {
      document.removeEventListener('click', this._boundOutsideClick, true);
    }
    this._boundOutsideClick = (e) => {
      // Don't close if clicking inside the login modal overlay
      if (e.target.closest('.eroscripts-login-overlay')) return;
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
  }

  _esc(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}
