// AudiencePanel — slim Audience tab content for the connection panel.
//
// Per SCOPE-audience-broadcast.md §3.2: this tab is intentionally lean.
// It shows the experimental info block + aggregate status + room
// lifecycle buttons (Create Room / Bring to front / End Room). All
// per-viewer management lives in the pop-out window so even if the
// streamer's screen-share leaks this panel, no keys are visible.

import { t } from '../js/i18n.js';
import { icon, Users, TriangleAlert } from '../js/icons.js';
import { eventBus } from '../js/event-bus.js';

function _esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export class AudiencePanel {
  /**
   * @param {Object} opts
   * @param {HTMLElement} opts.element — mount point (replaced)
   * @param {Object} opts.bridge — AudienceBridge instance
   * @param {Function} opts.onOpenPopout — async () => void
   * @param {Function} opts.onClosePopout — async () => void
   * @param {Function} opts.isPopoutOpen — () => boolean
   */
  constructor({ element, bridge, onOpenPopout, onClosePopout, isPopoutOpen }) {
    this._mount = element;
    this._bridge = bridge;
    this._onOpenPopout = onOpenPopout || (() => {});
    this._onClosePopout = onClosePopout || (() => {});
    this._isPopoutOpen = isPopoutOpen || (() => false);
    if (!this._mount) return;
    this._build();
    this._subscribe();
  }

  destroy() {
    this._unsubscribers?.forEach((u) => u?.());
    if (this._root && this._root.parentNode) {
      this._root.parentNode.removeChild(this._root);
    }
  }

  _subscribe() {
    this._unsubscribers = [];
    const refresh = () => this._render();
    for (const evt of [
      'audience:room-opened',
      'audience:room-ended',
      'audience:viewer-added',
      'audience:viewer-removed',
      'audience:viewer-status',
      'audience-popout:opened',
      'audience-popout:closed',
    ]) {
      const off = eventBus.on(evt, refresh);
      this._unsubscribers.push(off);
    }
  }

  _build() {
    this._root = document.createElement('div');
    this._root.className = 'audience-panel';
    this._mount.replaceWith(this._root);
    this._render();
  }

  _render() {
    if (!this._root) return;
    this._root.innerHTML = '';

    // --- Info block (always visible) ---
    const info = document.createElement('section');
    info.className = 'audience-panel__info';
    const infoHeader = document.createElement('div');
    infoHeader.className = 'audience-panel__info-header';
    const warnIcon = icon(TriangleAlert, { width: 14, height: 14 });
    warnIcon.classList.add('audience-panel__info-warn-icon');
    infoHeader.appendChild(warnIcon);
    const infoTitle = document.createElement('span');
    infoTitle.className = 'audience-panel__info-title';
    infoTitle.textContent = t('audience.tab.experimental');
    infoHeader.appendChild(infoTitle);
    info.appendChild(infoHeader);

    const intro = document.createElement('p');
    intro.className = 'audience-panel__info-intro';
    intro.textContent = t('audience.tab.intro');
    info.appendChild(intro);

    const bullets = document.createElement('ul');
    bullets.className = 'audience-panel__info-bullets';
    for (const key of ['handyOnly', 'keysArePasswords', 'popoutPurpose']) {
      const li = document.createElement('li');
      li.textContent = t(`audience.tab.bullet.${key}`);
      bullets.appendChild(li);
    }
    info.appendChild(bullets);
    this._root.appendChild(info);

    // --- Divider ---
    const divider = document.createElement('div');
    divider.className = 'audience-panel__divider';
    this._root.appendChild(divider);

    // --- Status summary + action buttons ---
    const actions = document.createElement('section');
    actions.className = 'audience-panel__actions';

    const status = document.createElement('div');
    status.className = 'audience-panel__status';
    const dot = document.createElement('span');
    dot.className = `audience-panel__status-dot audience-panel__status-dot--${this._bridge.aggregateStatus}`;
    status.appendChild(dot);
    const statusText = document.createElement('span');
    statusText.textContent = this._statusText();
    status.appendChild(statusText);
    actions.appendChild(status);

    const buttons = document.createElement('div');
    buttons.className = 'audience-panel__buttons';

    if (!this._bridge.roomActive) {
      const createBtn = document.createElement('button');
      createBtn.type = 'button';
      createBtn.className = 'audience-panel__btn audience-panel__btn--primary';
      createBtn.appendChild(icon(Users, { width: 16, height: 16 }));
      const label = document.createElement('span');
      label.textContent = t('audience.tab.createRoom');
      createBtn.appendChild(label);
      createBtn.addEventListener('click', () => {
        this._bridge.openRoom();
        this._onOpenPopout();
      });
      buttons.appendChild(createBtn);
    } else {
      const bringBtn = document.createElement('button');
      bringBtn.type = 'button';
      bringBtn.className = 'audience-panel__btn audience-panel__btn--primary';
      bringBtn.textContent = t('audience.tab.bringToFront');
      bringBtn.addEventListener('click', () => this._onOpenPopout());
      buttons.appendChild(bringBtn);

      const endBtn = document.createElement('button');
      endBtn.type = 'button';
      endBtn.className = 'audience-panel__btn audience-panel__btn--danger';
      endBtn.textContent = t('audience.tab.endRoom');
      // Closing the pop-out is now the canonical end-room action
      // (SCOPE-audience-broadcast.md §2 decision #12, revised 2026-06-02).
      // The pop-out's `closed` event handler in app.js calls
      // bridge.endRoom(). So this button just closes the window — no
      // duplicate confirm, no race between two end paths.
      endBtn.addEventListener('click', async () => {
        await this._onClosePopout();
      });
      buttons.appendChild(endBtn);
    }

    actions.appendChild(buttons);
    this._root.appendChild(actions);
  }

  _statusText() {
    if (!this._bridge.roomActive) return t('audience.tab.statusNoRoom');
    const viewers = this._bridge.viewers;
    if (viewers.length === 0) return t('audience.tab.statusRoomEmpty');
    const connected = viewers.filter((v) => v.status === 'synced' || v.status === 'playing' || v.status === 'paused').length;
    const calibrating = viewers.filter((v) => v.status === 'connecting' || v.status === 'uploading' || v.status === 'calibrating').length;
    const errored = viewers.filter((v) => v.status === 'error' || v.status === 'disconnected').length;
    const parts = [];
    if (connected > 0) parts.push(t('audience.tab.statusConnectedN', { count: connected }));
    if (calibrating > 0) parts.push(t('audience.tab.statusCalibratingN', { count: calibrating }));
    if (errored > 0) parts.push(t('audience.tab.statusErroredN', { count: errored }));
    return parts.join(' · ');
  }
}
